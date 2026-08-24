import { createHash } from 'node:crypto';

const MAX_LEASE_MS = 86_400_000;
const DEFAULT_QUERY_LIMIT = 50;
const MAX_QUERY_LIMIT = 100;
const MAX_RETRY_AFTER_MS = 604_800_000;
const MAX_ATTEMPTS = 100;
const IDENTIFIER_PATTERN = /^[a-z][a-z0-9._-]{0,63}$/;
const DELIVERY_STATUSES = new Set([
  'pending',
  'leased',
  'retry_wait',
  'acknowledged',
  'dead_letter',
]);
const BOOTSTRAP_POLICIES = new Set(['from_beginning', 'from_now']);

function requireObject(value, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${field} must be an object`);
  }
  return value;
}

function rejectUnknownFields(value, allowedFields, field) {
  const unknown = Object.keys(value).find((key) => !allowedFields.has(key));
  if (unknown) throw new TypeError(`unsupported ${field} field: ${unknown}`);
}

function requireText(value, field, maxLength = 256) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`${field} must be a non-empty string`);
  }
  const normalized = value.trim();
  if ([...normalized].length > maxLength) {
    throw new TypeError(`${field} must be at most ${maxLength} characters`);
  }
  return normalized;
}

function requireProjection(value) {
  const projection = requireText(value, 'projection', 64).toLowerCase();
  if (!IDENTIFIER_PATTERN.test(projection)) {
    throw new TypeError('projection must be a lowercase identifier');
  }
  return projection;
}

function normalizeLeaseMs(value) {
  if (!Number.isInteger(value) || value < 1 || value > MAX_LEASE_MS) {
    throw new TypeError(`leaseMs must be an integer between 1 and ${MAX_LEASE_MS}`);
  }
  return value;
}

function normalizeLimit(value) {
  const limit = value ?? DEFAULT_QUERY_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_QUERY_LIMIT) {
    throw new TypeError(`limit must be an integer between 1 and ${MAX_QUERY_LIMIT}`);
  }
  return limit;
}

function normalizeClaim(rawRequest) {
  const request = requireObject(rawRequest, 'outbox claim request');
  rejectUnknownFields(
    request,
    new Set(['projection', 'workerId', 'idempotencyKey', 'leaseMs', 'limit']),
    'outbox claim request',
  );
  return {
    projection: requireProjection(request.projection),
    workerId: requireText(request.workerId, 'claim.workerId'),
    idempotencyKey: requireText(request.idempotencyKey, 'claim.idempotencyKey'),
    leaseMs: normalizeLeaseMs(request.leaseMs),
    limit: normalizeLimit(request.limit),
  };
}

function normalizeRegistration(rawRequest) {
  const request = requireObject(rawRequest, 'outbox registration request');
  rejectUnknownFields(
    request,
    new Set(['projection', 'bootstrapPolicy', 'actorId', 'idempotencyKey']),
    'outbox registration request',
  );
  const bootstrapPolicy = requireText(
    request.bootstrapPolicy,
    'registration.bootstrapPolicy',
    32,
  );
  if (!BOOTSTRAP_POLICIES.has(bootstrapPolicy)) {
    throw new TypeError('bootstrapPolicy must be from_beginning or from_now');
  }
  return {
    projection: requireProjection(request.projection),
    bootstrapPolicy,
    actorId: request.actorId === undefined
      ? null
      : requireText(request.actorId, 'registration.actorId'),
    idempotencyKey: requireText(
      request.idempotencyKey,
      'registration.idempotencyKey',
    ),
  };
}

function normalizeAck(rawRequest) {
  const request = requireObject(rawRequest, 'outbox ack request');
  rejectUnknownFields(
    request,
    new Set(['projection', 'eventId', 'workerId', 'idempotencyKey']),
    'outbox ack request',
  );
  return {
    projection: requireProjection(request.projection),
    eventId: requireText(request.eventId, 'ack.eventId'),
    workerId: requireText(request.workerId, 'ack.workerId'),
    idempotencyKey: requireText(request.idempotencyKey, 'ack.idempotencyKey'),
  };
}

function normalizeFail(rawRequest) {
  const request = requireObject(rawRequest, 'outbox fail request');
  rejectUnknownFields(
    request,
    new Set([
      'projection',
      'eventId',
      'workerId',
      'error',
      'retryAfterMs',
      'maxAttempts',
      'idempotencyKey',
    ]),
    'outbox fail request',
  );
  let retryAfterMs = null;
  if (request.retryAfterMs !== undefined && request.retryAfterMs !== null) {
    if (!Number.isInteger(request.retryAfterMs)
        || request.retryAfterMs < 0
        || request.retryAfterMs > MAX_RETRY_AFTER_MS) {
      throw new TypeError(
        `retryAfterMs must be an integer between 0 and ${MAX_RETRY_AFTER_MS}`,
      );
    }
    retryAfterMs = request.retryAfterMs;
  }
  const maxAttempts = request.maxAttempts ?? 5;
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > MAX_ATTEMPTS) {
    throw new TypeError(`maxAttempts must be an integer between 1 and ${MAX_ATTEMPTS}`);
  }
  return {
    projection: requireProjection(request.projection),
    eventId: requireText(request.eventId, 'fail.eventId'),
    workerId: requireText(request.workerId, 'fail.workerId'),
    error: requireText(request.error, 'fail.error', 4096),
    retryAfterMs,
    maxAttempts,
    idempotencyKey: requireText(request.idempotencyKey, 'fail.idempotencyKey'),
  };
}

function normalizeVersion(value) {
  if (!Number.isInteger(value) || value < 1) {
    throw new TypeError('expectedVersion must be a positive integer');
  }
  return value;
}

function normalizeQuery(rawQuery) {
  const query = requireObject(rawQuery, 'outbox query');
  const projection = requireProjection(query.projection);
  if (Object.hasOwn(query, 'eventId')) {
    rejectUnknownFields(query, new Set(['projection', 'eventId']), 'outbox query');
    return {
      mode: 'event',
      projection,
      eventId: requireText(query.eventId, 'query.eventId'),
    };
  }

  rejectUnknownFields(query, new Set(['projection', 'statuses', 'limit']), 'outbox query');
  let statuses = null;
  if (query.statuses !== undefined) {
    if (!Array.isArray(query.statuses) || query.statuses.length === 0) {
      throw new TypeError('statuses must be a non-empty array');
    }
    statuses = [...new Set(query.statuses.map((status) => requireText(status, 'status', 32)))];
    const invalidStatus = statuses.find((status) => !DELIVERY_STATUSES.has(status));
    if (invalidStatus) throw new TypeError(`invalid delivery status: ${invalidStatus}`);
  }
  return { mode: 'list', projection, statuses, limit: normalizeLimit(query.limit) };
}

function fingerprint(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function domainError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function currentInstant(clock) {
  const rawTimestamp = requireText(clock(), 'clock result');
  const milliseconds = Date.parse(rawTimestamp);
  if (!Number.isFinite(milliseconds)) throw new TypeError('clock result must be a valid timestamp');
  return { timestamp: new Date(milliseconds).toISOString(), milliseconds };
}

function toEventView(row) {
  return {
    id: row.event_id,
    type: row.event_type,
    taskId: row.task_id,
    actorId: row.actor_id,
    fromState: row.from_state,
    toState: row.to_state,
    version: row.task_version,
    occurredAt: row.occurred_at,
  };
}

function toDeliveryView(row) {
  return {
    projection: row.projection ?? row.requested_projection,
    eventId: row.event_id,
    status: row.delivery_status ?? 'pending',
    attempt: row.attempt_count ?? 0,
    version: row.delivery_version ?? 0,
    workerId: row.worker_id ?? null,
    leaseExpiresAt: row.lease_expires_at ?? null,
    nextAttemptAt: row.next_attempt_at ?? null,
    lastError: row.last_error ?? null,
    acknowledgedAt: row.acknowledged_at ?? null,
    deadLetteredAt: row.dead_lettered_at ?? null,
    event: toEventView(row),
  };
}

function toRegistrationView(row) {
  return {
    projection: row.projection,
    bootstrapPolicy: row.bootstrap_policy,
    enabled: row.enabled === 1,
    baselineOutboxRowId: row.baseline_outbox_rowid,
    createdAt: row.created_at,
    createdBy: row.created_by,
  };
}

export function initializeProjectionOutboxSchema(database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS commitment_projection_outbox (
      event_id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      task_version INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (event_id) REFERENCES commitment_events(id) ON DELETE RESTRICT,
      FOREIGN KEY (task_id) REFERENCES commitment_tasks(id) ON DELETE RESTRICT
    );

    CREATE UNIQUE INDEX IF NOT EXISTS uq_commitment_projection_outbox_task_version
      ON commitment_projection_outbox(task_id, task_version);

    CREATE TABLE IF NOT EXISTS commitment_projection_deliveries (
      event_id TEXT NOT NULL,
      projection TEXT NOT NULL,
      status TEXT NOT NULL CHECK (
        status IN ('leased', 'retry_wait', 'acknowledged', 'dead_letter')
      ),
      attempt_count INTEGER NOT NULL,
      version INTEGER NOT NULL,
      worker_id TEXT,
      lease_expires_at TEXT,
      next_attempt_at TEXT,
      last_error TEXT,
      acknowledged_at TEXT,
      dead_lettered_at TEXT,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (event_id, projection),
      FOREIGN KEY (event_id) REFERENCES commitment_projection_outbox(event_id)
        ON DELETE RESTRICT
    );

    CREATE INDEX IF NOT EXISTS idx_commitment_projection_deliveries_claim
      ON commitment_projection_deliveries(projection, status, next_attempt_at, lease_expires_at);

    CREATE TABLE IF NOT EXISTS commitment_projection_receipts (
      idempotency_key TEXT PRIMARY KEY,
      operation TEXT NOT NULL,
      projection TEXT NOT NULL,
      request_fingerprint TEXT NOT NULL,
      result_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS commitment_projection_registry (
      projection TEXT PRIMARY KEY,
      bootstrap_policy TEXT NOT NULL CHECK (
        bootstrap_policy IN ('from_beginning', 'from_now')
      ),
      enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
      baseline_outbox_rowid INTEGER NOT NULL CHECK (baseline_outbox_rowid >= 0),
      created_at TEXT NOT NULL,
      created_by TEXT
    );
  `);

  database.prepare(`
    INSERT OR IGNORE INTO commitment_projection_outbox (
      event_id, task_id, task_version, created_at
    )
    SELECT id, task_id, task_version, occurred_at
    FROM commitment_events
  `).run();

  database.exec(`
    INSERT OR IGNORE INTO commitment_projection_registry (
      projection, bootstrap_policy, enabled, baseline_outbox_rowid,
      created_at, created_by
    )
    SELECT projection, 'from_beginning', 1, 0, MIN(updated_at), NULL
    FROM commitment_projection_deliveries
    GROUP BY projection;

    INSERT OR IGNORE INTO commitment_projection_registry (
      projection, bootstrap_policy, enabled, baseline_outbox_rowid,
      created_at, created_by
    )
    SELECT projection, 'from_beginning', 1, 0, MIN(created_at), NULL
    FROM commitment_projection_receipts
    GROUP BY projection;
  `);
}

/**
 * Owns one logical record per immutable Task Event plus independently leased
 * per-projection deliveries. append() is intentionally internal so only Core's
 * Task/Event transactions can create projection work.
 */
export function createProjectionOutboxModule({ database, clock }) {
  const appendRecord = database.prepare(`
    INSERT INTO commitment_projection_outbox (
      event_id, task_id, task_version, created_at
    ) VALUES (?, ?, ?, ?)
  `);
  const selectReceipt = database.prepare(`
    SELECT request_fingerprint, result_json
    FROM commitment_projection_receipts
    WHERE idempotency_key = ?
  `);
  const insertReceipt = database.prepare(`
    INSERT INTO commitment_projection_receipts (
      idempotency_key, operation, projection, request_fingerprint,
      result_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?)
  `);
  const insertLease = database.prepare(`
    INSERT INTO commitment_projection_deliveries (
      event_id, projection, status, attempt_count, version, worker_id,
      lease_expires_at, next_attempt_at, last_error, acknowledged_at,
      dead_lettered_at, updated_at
    ) VALUES (?, ?, 'leased', 1, 1, ?, ?, NULL, NULL, NULL, NULL, ?)
  `);
  const renewLease = database.prepare(`
    UPDATE commitment_projection_deliveries
    SET status = 'leased', attempt_count = attempt_count + 1,
        version = version + 1, worker_id = ?, lease_expires_at = ?,
        next_attempt_at = NULL, acknowledged_at = NULL,
        dead_lettered_at = NULL, updated_at = ?
    WHERE event_id = ? AND projection = ? AND version = ?
  `);
  const selectDelivery = database.prepare(`
    SELECT o.event_id, o.task_id, o.task_version, o.created_at,
           e.event_type, e.actor_id, e.from_state, e.to_state, e.occurred_at,
           d.projection, d.status AS delivery_status,
           d.attempt_count, d.version AS delivery_version, d.worker_id,
           d.lease_expires_at, d.next_attempt_at, d.last_error,
           d.acknowledged_at, d.dead_lettered_at
    FROM commitment_projection_outbox o
    JOIN commitment_events e ON e.id = o.event_id
    JOIN commitment_projection_deliveries d ON d.event_id = o.event_id
    WHERE o.event_id = ? AND d.projection = ?
  `);
  const updateAcknowledged = database.prepare(`
    UPDATE commitment_projection_deliveries
    SET status = 'acknowledged', version = version + 1, worker_id = NULL,
        lease_expires_at = NULL, next_attempt_at = NULL,
        acknowledged_at = ?, dead_lettered_at = NULL, updated_at = ?
    WHERE event_id = ? AND projection = ? AND version = ?
  `);
  const updateFailed = database.prepare(`
    UPDATE commitment_projection_deliveries
    SET status = ?, version = version + 1, worker_id = NULL,
        lease_expires_at = NULL, next_attempt_at = ?, last_error = ?,
        acknowledged_at = NULL, dead_lettered_at = ?, updated_at = ?
    WHERE event_id = ? AND projection = ? AND version = ?
  `);
  const selectRegistration = database.prepare(`
    SELECT projection, bootstrap_policy, enabled, baseline_outbox_rowid,
           created_at, created_by
    FROM commitment_projection_registry
    WHERE projection = ?
  `);
  const insertRegistration = database.prepare(`
    INSERT INTO commitment_projection_registry (
      projection, bootstrap_policy, enabled, baseline_outbox_rowid,
      created_at, created_by
    ) VALUES (?, ?, 1, ?, ?, ?)
  `);
  const selectLastOutboxRowId = database.prepare(`
    SELECT COALESCE(MAX(rowid), 0) AS row_id
    FROM commitment_projection_outbox
  `);

  function receiptReplay(idempotencyKey, requestFingerprint) {
    const receipt = selectReceipt.get(idempotencyKey);
    if (!receipt) return null;
    if (receipt.request_fingerprint !== requestFingerprint) {
      throw domainError(
        'IDEMPOTENCY_CONFLICT',
        `idempotency key already belongs to different content: ${idempotencyKey}`,
      );
    }
    return JSON.parse(receipt.result_json);
  }

  function saveReceipt(operation, request, requestFingerprint, result, timestamp) {
    insertReceipt.run(
      request.idempotencyKey,
      operation,
      request.projection,
      requestFingerprint,
      JSON.stringify(result),
      timestamp,
    );
  }

  function assertOwnedActiveLease(delivery, request, expectedVersion, nowMilliseconds) {
    if (!delivery) {
      throw domainError(
        'DELIVERY_NOT_FOUND',
        `delivery not found: ${request.projection}/${request.eventId}`,
      );
    }
    if (delivery.version !== expectedVersion) {
      throw domainError(
        'DELIVERY_VERSION_CONFLICT',
        `expected delivery version ${expectedVersion}, found ${delivery.version}`,
      );
    }
    if (delivery.status !== 'leased') {
      throw domainError('DELIVERY_NOT_LEASED', `delivery is ${delivery.status}`);
    }
    if (Date.parse(delivery.leaseExpiresAt) <= nowMilliseconds) {
      throw domainError('DELIVERY_LEASE_EXPIRED', 'delivery lease has expired');
    }
    if (delivery.workerId !== request.workerId) {
      throw domainError(
        'DELIVERY_FORBIDDEN',
        `${request.workerId} does not own the delivery lease`,
      );
    }
  }

  function requireEnabledRegistration(projection) {
    const row = selectRegistration.get(projection);
    if (!row || row.enabled !== 1) {
      throw domainError(
        'UNKNOWN_PROJECTION',
        `projection is not registered and enabled: ${projection}`,
      );
    }
    return toRegistrationView(row);
  }

  const registerTransaction = database.transaction((rawRequest) => {
    const request = normalizeRegistration(rawRequest);
    const requestFingerprint = fingerprint({ operation: 'register', request });
    const replay = receiptReplay(request.idempotencyKey, requestFingerprint);
    if (replay) return replay;

    const existingRow = selectRegistration.get(request.projection);
    if (existingRow) {
      const registration = toRegistrationView(existingRow);
      if (registration.bootstrapPolicy !== request.bootstrapPolicy) {
        throw domainError(
          'PROJECTION_REGISTRATION_CONFLICT',
          `${request.projection} is already registered with ${registration.bootstrapPolicy}`,
        );
      }
      const now = currentInstant(clock);
      const result = { created: false, registration };
      saveReceipt('register', request, requestFingerprint, result, now.timestamp);
      return result;
    }

    const now = currentInstant(clock);
    const baselineOutboxRowId = request.bootstrapPolicy === 'from_now'
      ? selectLastOutboxRowId.get().row_id
      : 0;
    insertRegistration.run(
      request.projection,
      request.bootstrapPolicy,
      baselineOutboxRowId,
      now.timestamp,
      request.actorId,
    );
    const result = {
      created: true,
      registration: toRegistrationView(selectRegistration.get(request.projection)),
    };
    saveReceipt('register', request, requestFingerprint, result, now.timestamp);
    return result;
  });

  const claimTransaction = database.transaction((rawRequest) => {
    const request = normalizeClaim(rawRequest);
    const registration = requireEnabledRegistration(request.projection);
    const requestFingerprint = fingerprint({ operation: 'claim', request });
    const replay = receiptReplay(request.idempotencyKey, requestFingerprint);
    if (replay) return replay;

    const now = currentInstant(clock);
    const candidates = database.prepare(`
      SELECT o.event_id, d.version AS delivery_version
      FROM commitment_projection_outbox o
      LEFT JOIN commitment_projection_deliveries d
        ON d.event_id = o.event_id AND d.projection = ?
      WHERE o.rowid > ?
        AND (
          d.event_id IS NULL
          OR (d.status = 'retry_wait' AND d.next_attempt_at <= ?)
          OR (d.status = 'leased' AND d.lease_expires_at <= ?)
        )
      ORDER BY o.created_at, o.task_id, o.task_version, o.event_id
      LIMIT ?
    `).all(
      request.projection,
      registration.baselineOutboxRowId,
      now.timestamp,
      now.timestamp,
      request.limit,
    );
    const leaseExpiresAt = new Date(now.milliseconds + request.leaseMs).toISOString();
    const results = [];
    for (const candidate of candidates) {
      if (candidate.delivery_version === null) {
        insertLease.run(
          candidate.event_id,
          request.projection,
          request.workerId,
          leaseExpiresAt,
          now.timestamp,
        );
      } else {
        const renewed = renewLease.run(
          request.workerId,
          leaseExpiresAt,
          now.timestamp,
          candidate.event_id,
          request.projection,
          candidate.delivery_version,
        );
        if (renewed.changes !== 1) {
          throw domainError(
            'DELIVERY_VERSION_CONFLICT',
            `delivery changed while claiming: ${request.projection}/${candidate.event_id}`,
          );
        }
      }
      results.push(toDeliveryView(selectDelivery.get(candidate.event_id, request.projection)));
    }
    saveReceipt('claim', request, requestFingerprint, results, now.timestamp);
    return results;
  });

  const ackTransaction = database.transaction((rawRequest, rawExpectedVersion) => {
    const request = normalizeAck(rawRequest);
    requireEnabledRegistration(request.projection);
    const expectedVersion = normalizeVersion(rawExpectedVersion);
    const requestFingerprint = fingerprint({ operation: 'ack', request, expectedVersion });
    const replay = receiptReplay(request.idempotencyKey, requestFingerprint);
    if (replay) return replay;

    const now = currentInstant(clock);
    const deliveryRow = selectDelivery.get(request.eventId, request.projection);
    const delivery = deliveryRow ? toDeliveryView(deliveryRow) : null;
    assertOwnedActiveLease(delivery, request, expectedVersion, now.milliseconds);
    const updated = updateAcknowledged.run(
      now.timestamp,
      now.timestamp,
      request.eventId,
      request.projection,
      expectedVersion,
    );
    if (updated.changes !== 1) {
      throw domainError(
        'DELIVERY_VERSION_CONFLICT',
        `delivery changed while acknowledging: ${request.projection}/${request.eventId}`,
      );
    }
    const result = toDeliveryView(selectDelivery.get(request.eventId, request.projection));
    saveReceipt('ack', request, requestFingerprint, result, now.timestamp);
    return result;
  });

  const failTransaction = database.transaction((rawRequest, rawExpectedVersion) => {
    const request = normalizeFail(rawRequest);
    requireEnabledRegistration(request.projection);
    const expectedVersion = normalizeVersion(rawExpectedVersion);
    const requestFingerprint = fingerprint({ operation: 'fail', request, expectedVersion });
    const replay = receiptReplay(request.idempotencyKey, requestFingerprint);
    if (replay) return replay;

    const now = currentInstant(clock);
    const deliveryRow = selectDelivery.get(request.eventId, request.projection);
    const delivery = deliveryRow ? toDeliveryView(deliveryRow) : null;
    assertOwnedActiveLease(delivery, request, expectedVersion, now.milliseconds);
    const shouldDeadLetter = request.retryAfterMs === null
      || delivery.attempt >= request.maxAttempts;
    const status = shouldDeadLetter ? 'dead_letter' : 'retry_wait';
    const nextAttemptAt = shouldDeadLetter
      ? null
      : new Date(now.milliseconds + request.retryAfterMs).toISOString();
    const deadLetteredAt = shouldDeadLetter ? now.timestamp : null;
    const updated = updateFailed.run(
      status,
      nextAttemptAt,
      request.error,
      deadLetteredAt,
      now.timestamp,
      request.eventId,
      request.projection,
      expectedVersion,
    );
    if (updated.changes !== 1) {
      throw domainError(
        'DELIVERY_VERSION_CONFLICT',
        `delivery changed while failing: ${request.projection}/${request.eventId}`,
      );
    }
    const result = toDeliveryView(selectDelivery.get(request.eventId, request.projection));
    saveReceipt('fail', request, requestFingerprint, result, now.timestamp);
    return result;
  });

  return Object.freeze({
    append(event) {
      appendRecord.run(event.id, event.taskId, event.version, event.occurredAt);
    },
    publicInterface: Object.freeze({
      register(request) {
        return registerTransaction.immediate(request);
      },
      claim(request) {
        return claimTransaction.immediate(request);
      },
      ack(request, expectedVersion) {
        return ackTransaction.immediate(request, expectedVersion);
      },
      fail(request, expectedVersion) {
        return failTransaction.immediate(request, expectedVersion);
      },
      query(query) {
        const normalized = normalizeQuery(query);
        const registration = requireEnabledRegistration(normalized.projection);
        if (normalized.mode === 'event') {
          const row = database.prepare(`
            SELECT o.event_id, o.task_id, o.task_version, o.created_at,
                   e.event_type, e.actor_id, e.from_state, e.to_state, e.occurred_at,
                   ? AS requested_projection, d.projection,
                   d.status AS delivery_status, d.attempt_count,
                   d.version AS delivery_version, d.worker_id,
                   d.lease_expires_at, d.next_attempt_at, d.last_error,
                   d.acknowledged_at, d.dead_lettered_at
            FROM commitment_projection_outbox o
            JOIN commitment_events e ON e.id = o.event_id
            LEFT JOIN commitment_projection_deliveries d
              ON d.event_id = o.event_id AND d.projection = ?
            WHERE o.event_id = ?
              AND o.rowid > ?
          `).get(
            normalized.projection,
            normalized.projection,
            normalized.eventId,
            registration.baselineOutboxRowId,
          );
          return row ? toDeliveryView(row) : null;
        }

        const values = [
          normalized.projection,
          normalized.projection,
          registration.baselineOutboxRowId,
        ];
        let stateClause = '';
        if (normalized.statuses) {
          stateClause = `AND COALESCE(d.status, 'pending') IN (${normalized.statuses
            .map(() => '?').join(', ')})`;
          values.push(...normalized.statuses);
        }
        values.push(normalized.limit);
        return database.prepare(`
          SELECT o.event_id, o.task_id, o.task_version, o.created_at,
                 e.event_type, e.actor_id, e.from_state, e.to_state, e.occurred_at,
                 ? AS requested_projection, d.projection,
                 d.status AS delivery_status, d.attempt_count,
                 d.version AS delivery_version, d.worker_id,
                 d.lease_expires_at, d.next_attempt_at, d.last_error,
                 d.acknowledged_at, d.dead_lettered_at
          FROM commitment_projection_outbox o
          JOIN commitment_events e ON e.id = o.event_id
          LEFT JOIN commitment_projection_deliveries d
            ON d.event_id = o.event_id AND d.projection = ?
          WHERE o.rowid > ? ${stateClause}
          ORDER BY o.created_at, o.task_id, o.task_version, o.event_id
          LIMIT ?
        `).all(...values).map(toDeliveryView);
      },
    }),
  });
}
