import { createHash } from 'node:crypto';

const MAX_LEASE_MS = 86_400_000;
const MAX_CLAIM_LIMIT = 100;

function domainError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function requireRecord(value, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${field} must be an object`);
  }
  return value;
}

function rejectUnknownFields(value, allowed, field) {
  const unknown = Object.keys(value).find((key) => !allowed.has(key));
  if (unknown) throw new TypeError(`unsupported ${field} field: ${unknown}`);
}

function requireText(value, field, maxLength = 4096) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`${field} must be a non-empty string`);
  }
  const normalized = value.trim();
  if ([...normalized].length > maxLength) {
    throw new TypeError(`${field} must be at most ${maxLength} characters`);
  }
  return normalized;
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]),
  );
}

function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

function fingerprint(value) {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function currentInstant(clock) {
  const timestamp = requireText(clock(), 'clock result');
  const milliseconds = Date.parse(timestamp);
  if (!Number.isFinite(milliseconds)) throw new TypeError('clock result must be a timestamp');
  return { timestamp: new Date(milliseconds).toISOString(), milliseconds };
}

function normalizeClaim(rawRequest) {
  const request = requireRecord(rawRequest, 'TaskEffect claim request');
  rejectUnknownFields(
    request,
    new Set(['workerId', 'leaseMs', 'limit']),
    'TaskEffect claim request',
  );
  if (!Number.isInteger(request.leaseMs) || request.leaseMs < 1
      || request.leaseMs > MAX_LEASE_MS) {
    throw new TypeError(`leaseMs must be an integer between 1 and ${MAX_LEASE_MS}`);
  }
  const limit = request.limit ?? 50;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_CLAIM_LIMIT) {
    throw new TypeError(`limit must be an integer between 1 and ${MAX_CLAIM_LIMIT}`);
  }
  return {
    workerId: requireText(request.workerId, 'claim.workerId', 256),
    leaseMs: request.leaseMs,
    limit,
  };
}

function normalizeAcknowledgement(rawRequest) {
  const request = requireRecord(rawRequest, 'TaskEffect acknowledgement');
  rejectUnknownFields(
    request,
    new Set(['effectId', 'workerId', 'leaseEpoch', 'receipt']),
    'TaskEffect acknowledgement',
  );
  if (!Number.isSafeInteger(request.leaseEpoch) || request.leaseEpoch < 1) {
    throw new TypeError('acknowledgement.leaseEpoch must be a positive integer');
  }
  return {
    effectId: requireText(request.effectId, 'acknowledgement.effectId'),
    workerId: requireText(request.workerId, 'acknowledgement.workerId', 256),
    leaseEpoch: request.leaseEpoch,
    receipt: structuredClone(requireRecord(request.receipt, 'acknowledgement.receipt')),
  };
}

function normalizeFailure(rawRequest) {
  const request = requireRecord(rawRequest, 'TaskEffect failure');
  rejectUnknownFields(
    request,
    new Set(['effectId', 'workerId', 'leaseEpoch', 'classification', 'error', 'retryAfterMs']),
    'TaskEffect failure',
  );
  if (!Number.isSafeInteger(request.leaseEpoch) || request.leaseEpoch < 1) {
    throw new TypeError('failure.leaseEpoch must be a positive integer');
  }
  const classification = requireText(request.classification, 'failure.classification', 32);
  if (!['retryable', 'unknown', 'permanent'].includes(classification)) {
    throw new TypeError('failure.classification must be retryable, unknown, or permanent');
  }
  const retryAfterMs = request.retryAfterMs ?? 0;
  if (!Number.isInteger(retryAfterMs) || retryAfterMs < 0 || retryAfterMs > 604_800_000) {
    throw new TypeError('failure.retryAfterMs must be between 0 and 604800000');
  }
  return {
    effectId: requireText(request.effectId, 'failure.effectId'),
    workerId: requireText(request.workerId, 'failure.workerId', 256),
    leaseEpoch: request.leaseEpoch,
    classification,
    error: requireText(request.error, 'failure.error'),
    retryAfterMs,
  };
}

function normalizeReconciliation(rawRequest) {
  const request = requireRecord(rawRequest, 'TaskEffect reconciliation');
  rejectUnknownFields(
    request,
    new Set(['effectId', 'actorId', 'outcome', 'receipt']),
    'TaskEffect reconciliation',
  );
  const outcome = requireText(request.outcome, 'reconciliation.outcome', 32);
  if (!['delivered', 'not_delivered'].includes(outcome)) {
    throw new TypeError('reconciliation.outcome must be delivered or not_delivered');
  }
  return {
    effectId: requireText(request.effectId, 'reconciliation.effectId'),
    actorId: requireText(request.actorId, 'reconciliation.actorId', 256),
    outcome,
    receipt: structuredClone(requireRecord(request.receipt, 'reconciliation.receipt')),
  };
}

function normalizeRedrive(rawRequest) {
  const request = requireRecord(rawRequest, 'TaskEffect redrive');
  rejectUnknownFields(
    request,
    new Set(['effectId', 'actorId', 'idempotencyKey']),
    'TaskEffect redrive',
  );
  return {
    effectId: requireText(request.effectId, 'redrive.effectId'),
    actorId: requireText(request.actorId, 'redrive.actorId', 256),
    idempotencyKey: requireText(request.idempotencyKey, 'redrive.idempotencyKey', 512),
  };
}

function parsePersistedJson(raw, field) {
  try {
    return JSON.parse(raw);
  } catch {
    throw domainError('PERSISTED_DATA_CORRUPT', `${field} is not valid JSON`);
  }
}

function deliveryView(row, effect) {
  return {
    effect,
    status: row.status,
    attempt: row.attempt_count,
    leaseEpoch: row.lease_epoch,
    workerId: row.lease_owner,
    leaseExpiresAt: row.lease_expires_at,
    generation: row.generation,
    nextAttemptAt: row.next_attempt_at,
    lastError: row.last_error,
    receiptId: row.receipt_id,
  };
}

export function initializeTaskEffectRelaySchema(database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS commitment_task_effect_delivery_receipts (
      receipt_id TEXT PRIMARY KEY,
      effect_id TEXT NOT NULL,
      generation INTEGER NOT NULL,
      receipt_kind TEXT NOT NULL,
      body_json TEXT NOT NULL,
      receipt_hash TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE (effect_id, generation, receipt_kind),
      FOREIGN KEY (effect_id) REFERENCES commitment_task_effects(effect_id) ON DELETE RESTRICT
    );

    CREATE TABLE IF NOT EXISTS commitment_task_effect_redrive_receipts (
      idempotency_key TEXT PRIMARY KEY,
      effect_id TEXT NOT NULL,
      request_fingerprint TEXT NOT NULL,
      result_json TEXT NOT NULL,
      receipt_hash TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (effect_id) REFERENCES commitment_task_effects(effect_id) ON DELETE RESTRICT
    );

    CREATE TABLE IF NOT EXISTS commitment_task_effect_deliveries (
      effect_id TEXT PRIMARY KEY,
      status TEXT NOT NULL CHECK (
        status IN ('pending', 'leased', 'retry_wait', 'unknown', 'acknowledged', 'dead_letter')
      ),
      attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
      lease_owner TEXT,
      lease_epoch INTEGER NOT NULL DEFAULT 0 CHECK (lease_epoch >= 0),
      lease_expires_at TEXT,
      next_attempt_at TEXT,
      last_error TEXT,
      generation INTEGER NOT NULL DEFAULT 0 CHECK (generation >= 0),
      receipt_id TEXT,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (effect_id) REFERENCES commitment_task_effects(effect_id) ON DELETE RESTRICT,
      FOREIGN KEY (receipt_id) REFERENCES commitment_task_effect_delivery_receipts(receipt_id)
        ON DELETE RESTRICT
    );

    CREATE TRIGGER IF NOT EXISTS commitment_task_effect_delivery_receipt_no_update
    BEFORE UPDATE ON commitment_task_effect_delivery_receipts
    BEGIN
      SELECT RAISE(ABORT, 'commitment TaskEffect delivery receipt is immutable');
    END;

    CREATE TRIGGER IF NOT EXISTS commitment_task_effect_delivery_receipt_no_delete
    BEFORE DELETE ON commitment_task_effect_delivery_receipts
    BEGIN
      SELECT RAISE(ABORT, 'commitment TaskEffect delivery receipt is immutable');
    END;

    CREATE TRIGGER IF NOT EXISTS commitment_task_effect_redrive_receipt_no_update
    BEFORE UPDATE ON commitment_task_effect_redrive_receipts
    BEGIN
      SELECT RAISE(ABORT, 'commitment TaskEffect redrive receipt is immutable');
    END;

    CREATE TRIGGER IF NOT EXISTS commitment_task_effect_redrive_receipt_no_delete
    BEFORE DELETE ON commitment_task_effect_redrive_receipts
    BEGIN
      SELECT RAISE(ABORT, 'commitment TaskEffect redrive receipt is immutable');
    END;

    INSERT OR IGNORE INTO commitment_task_effect_deliveries (
      effect_id, status, attempt_count, lease_epoch, generation, updated_at
    )
    SELECT effect_id, 'pending', 0, 0, 0, created_at
    FROM commitment_task_effects;
  `);
}

export function createTaskEffectRelay({ database, clock, loadEffect }) {
  const insertDelivery = database.prepare(`
    INSERT INTO commitment_task_effect_deliveries (
      effect_id, status, attempt_count, lease_epoch, generation, updated_at
    ) VALUES (?, 'pending', 0, 0, 0, ?)
  `);
  const selectClaimable = database.prepare(`
    SELECT *
    FROM commitment_task_effect_deliveries
    WHERE (
      status IN ('pending', 'retry_wait')
      AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
    ) OR (
      status = 'leased' AND lease_expires_at <= ?
    )
    ORDER BY updated_at, effect_id
    LIMIT ?
  `);
  const leaseDelivery = database.prepare(`
    UPDATE commitment_task_effect_deliveries
    SET status = 'leased', attempt_count = attempt_count + 1,
        lease_owner = ?, lease_epoch = lease_epoch + 1,
        lease_expires_at = ?, next_attempt_at = NULL, updated_at = ?
    WHERE effect_id = ? AND lease_epoch = ? AND (
      (
        status IN ('pending', 'retry_wait')
        AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
      ) OR (
        status = 'leased' AND lease_expires_at <= ?
      )
    )
  `);
  const selectDelivery = database.prepare(`
    SELECT * FROM commitment_task_effect_deliveries WHERE effect_id = ?
  `);
  const insertDeliveryReceipt = database.prepare(`
    INSERT INTO commitment_task_effect_delivery_receipts (
      receipt_id, effect_id, generation, receipt_kind, body_json, receipt_hash, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const acknowledgeDelivery = database.prepare(`
    UPDATE commitment_task_effect_deliveries
    SET status = 'acknowledged', lease_owner = NULL, lease_expires_at = NULL,
        next_attempt_at = NULL, last_error = NULL, receipt_id = ?, updated_at = ?
    WHERE effect_id = ? AND status = 'leased' AND lease_owner = ? AND lease_epoch = ?
  `);
  const failDelivery = database.prepare(`
    UPDATE commitment_task_effect_deliveries
    SET status = ?, lease_owner = NULL, lease_expires_at = NULL,
        next_attempt_at = ?, last_error = ?, updated_at = ?
    WHERE effect_id = ? AND status = 'leased' AND lease_owner = ? AND lease_epoch = ?
  `);
  const reconcileDelivery = database.prepare(`
    UPDATE commitment_task_effect_deliveries
    SET status = ?, lease_owner = NULL, lease_expires_at = NULL,
        next_attempt_at = NULL, last_error = NULL, receipt_id = ?, updated_at = ?
    WHERE effect_id = ? AND status = 'unknown'
  `);
  const redriveDelivery = database.prepare(`
    UPDATE commitment_task_effect_deliveries
    SET status = 'pending', lease_owner = NULL, lease_expires_at = NULL,
        next_attempt_at = NULL, last_error = NULL, receipt_id = NULL,
        generation = generation + 1, updated_at = ?
    WHERE effect_id = ? AND status = 'dead_letter'
  `);
  const selectRedriveReceipt = database.prepare(`
    SELECT effect_id, request_fingerprint, result_json, receipt_hash
    FROM commitment_task_effect_redrive_receipts
    WHERE idempotency_key = ?
  `);
  const insertRedriveReceipt = database.prepare(`
    INSERT INTO commitment_task_effect_redrive_receipts (
      idempotency_key, effect_id, request_fingerprint, result_json,
      receipt_hash, created_at
    ) VALUES (?, ?, ?, ?, ?, ?)
  `);

  function persistDeliveryReceipt({ effectId, generation, kind, body, timestamp }) {
    const receiptId = `task-effect-receipt:${fingerprint({
      effectId,
      generation,
      kind,
      body,
    }).slice(0, 32)}`;
    const receiptHash = fingerprint({ receiptId, effectId, generation, kind, body });
    insertDeliveryReceipt.run(
      receiptId,
      effectId,
      generation,
      kind,
      canonicalJson(body),
      receiptHash,
      timestamp,
    );
    return receiptId;
  }

  function requireHeldLease(delivery, request, now) {
    if (
      delivery.status !== 'leased'
      || delivery.lease_owner !== request.workerId
      || delivery.lease_epoch !== request.leaseEpoch
    ) {
      throw domainError('EFFECT_LEASE_LOST', `TaskEffect lease was lost: ${request.effectId}`);
    }
    if (delivery.lease_expires_at <= now.timestamp) {
      throw domainError('EFFECT_LEASE_EXPIRED', `TaskEffect lease expired: ${request.effectId}`);
    }
  }

  const claimTransaction = database.transaction((rawRequest) => {
    const request = normalizeClaim(rawRequest);
    const now = currentInstant(clock);
    const leaseExpiresAt = new Date(now.milliseconds + request.leaseMs).toISOString();
    const claimed = [];
    for (const row of selectClaimable.all(now.timestamp, now.timestamp, request.limit)) {
      const effect = loadEffect(row.effect_id);
      if (!effect) {
        throw domainError('PERSISTED_DATA_CORRUPT', `TaskEffect missing: ${row.effect_id}`);
      }
      const updated = leaseDelivery.run(
        request.workerId,
        leaseExpiresAt,
        now.timestamp,
        row.effect_id,
        row.lease_epoch,
        now.timestamp,
        now.timestamp,
      );
      if (updated.changes !== 1) continue;
      claimed.push(deliveryView(selectDelivery.get(row.effect_id), effect));
    }
    return claimed;
  });

  const acknowledgeTransaction = database.transaction((rawRequest) => {
    const request = normalizeAcknowledgement(rawRequest);
    const now = currentInstant(clock);
    const delivery = selectDelivery.get(request.effectId);
    if (!delivery) throw domainError('EFFECT_NOT_FOUND', `TaskEffect not found: ${request.effectId}`);
    const effect = loadEffect(request.effectId);
    if (!effect) throw domainError('PERSISTED_DATA_CORRUPT', `TaskEffect missing: ${request.effectId}`);
    requireHeldLease(delivery, request, now);
    const receiptId = persistDeliveryReceipt({
      effectId: request.effectId,
      generation: delivery.generation,
      kind: 'acknowledged',
      body: request.receipt,
      timestamp: now.timestamp,
    });
    const updated = acknowledgeDelivery.run(
      receiptId,
      now.timestamp,
      request.effectId,
      request.workerId,
      request.leaseEpoch,
    );
    if (updated.changes !== 1) {
      throw domainError('EFFECT_LEASE_LOST', `TaskEffect lease was lost: ${request.effectId}`);
    }
    return deliveryView(selectDelivery.get(request.effectId), effect);
  });

  const failTransaction = database.transaction((rawRequest) => {
    const request = normalizeFailure(rawRequest);
    const now = currentInstant(clock);
    const delivery = selectDelivery.get(request.effectId);
    if (!delivery) throw domainError('EFFECT_NOT_FOUND', `TaskEffect not found: ${request.effectId}`);
    const effect = loadEffect(request.effectId);
    if (!effect) throw domainError('PERSISTED_DATA_CORRUPT', `TaskEffect missing: ${request.effectId}`);
    requireHeldLease(delivery, request, now);
    const status = {
      retryable: 'retry_wait',
      unknown: 'unknown',
      permanent: 'dead_letter',
    }[request.classification];
    const nextAttemptAt = request.classification === 'retryable'
      ? new Date(now.milliseconds + request.retryAfterMs).toISOString()
      : null;
    const updated = failDelivery.run(
      status,
      nextAttemptAt,
      request.error,
      now.timestamp,
      request.effectId,
      request.workerId,
      request.leaseEpoch,
    );
    if (updated.changes !== 1) {
      throw domainError('EFFECT_LEASE_LOST', `TaskEffect lease was lost: ${request.effectId}`);
    }
    return deliveryView(selectDelivery.get(request.effectId), effect);
  });

  const reconcileTransaction = database.transaction((rawRequest) => {
    const request = normalizeReconciliation(rawRequest);
    const now = currentInstant(clock);
    const delivery = selectDelivery.get(request.effectId);
    if (!delivery) throw domainError('EFFECT_NOT_FOUND', `TaskEffect not found: ${request.effectId}`);
    const effect = loadEffect(request.effectId);
    if (!effect) throw domainError('PERSISTED_DATA_CORRUPT', `TaskEffect missing: ${request.effectId}`);
    if (delivery.status !== 'unknown') {
      throw domainError(
        'EFFECT_RECONCILIATION_REQUIRED_STATE',
        `TaskEffect is not unknown: ${request.effectId}`,
      );
    }
    const kind = request.outcome === 'delivered'
      ? 'reconciled_delivered'
      : 'reconciled_not_delivered';
    const receiptId = persistDeliveryReceipt({
      effectId: request.effectId,
      generation: delivery.generation,
      kind,
      body: { actorId: request.actorId, outcome: request.outcome, receipt: request.receipt },
      timestamp: now.timestamp,
    });
    const status = request.outcome === 'delivered' ? 'acknowledged' : 'pending';
    const updated = reconcileDelivery.run(
      status,
      request.outcome === 'delivered' ? receiptId : null,
      now.timestamp,
      request.effectId,
    );
    if (updated.changes !== 1) {
      throw domainError('EFFECT_RECONCILIATION_RACE', `TaskEffect changed: ${request.effectId}`);
    }
    return deliveryView(selectDelivery.get(request.effectId), effect);
  });

  const redriveTransaction = database.transaction((rawRequest) => {
    const request = normalizeRedrive(rawRequest);
    const requestFingerprint = fingerprint(request);
    const existing = selectRedriveReceipt.get(request.idempotencyKey);
    if (existing) {
      const result = parsePersistedJson(existing.result_json, 'TaskEffect redrive receipt result');
      const expectedHash = fingerprint({
        idempotencyKey: request.idempotencyKey,
        effectId: existing.effect_id,
        requestFingerprint: existing.request_fingerprint,
        result,
      });
      if (existing.receipt_hash !== expectedHash) {
        throw domainError(
          'PERSISTED_DATA_CORRUPT',
          `TaskEffect redrive receipt hash mismatch: ${request.idempotencyKey}`,
        );
      }
      if (existing.request_fingerprint !== requestFingerprint) {
        throw domainError(
          'IDEMPOTENCY_CONFLICT',
          `redrive key belongs to different content: ${request.idempotencyKey}`,
        );
      }
      const effect = loadEffect(existing.effect_id);
      if (!effect || fingerprint(effect) !== fingerprint(result.effect)) {
        throw domainError(
          'PERSISTED_DATA_CORRUPT',
          `TaskEffect redrive linkage mismatch: ${request.idempotencyKey}`,
        );
      }
      return { ...result, replayed: true };
    }
    const now = currentInstant(clock);
    const delivery = selectDelivery.get(request.effectId);
    if (!delivery) throw domainError('EFFECT_NOT_FOUND', `TaskEffect not found: ${request.effectId}`);
    const effect = loadEffect(request.effectId);
    if (!effect) throw domainError('PERSISTED_DATA_CORRUPT', `TaskEffect missing: ${request.effectId}`);
    if (delivery.status !== 'dead_letter') {
      throw domainError('EFFECT_NOT_DEAD_LETTER', `TaskEffect is not dead-lettered: ${request.effectId}`);
    }
    const updated = redriveDelivery.run(now.timestamp, request.effectId);
    if (updated.changes !== 1) {
      throw domainError('EFFECT_REDRIVE_RACE', `TaskEffect changed: ${request.effectId}`);
    }
    const result = {
      ...deliveryView(selectDelivery.get(request.effectId), effect),
      replayed: false,
      redrivenBy: request.actorId,
    };
    const resultJson = canonicalJson(result);
    const receiptHash = fingerprint({
      idempotencyKey: request.idempotencyKey,
      effectId: request.effectId,
      requestFingerprint,
      result,
    });
    insertRedriveReceipt.run(
      request.idempotencyKey,
      request.effectId,
      requestFingerprint,
      resultJson,
      receiptHash,
      now.timestamp,
    );
    return result;
  });

  return Object.freeze({
    append(effectId, timestamp) {
      insertDelivery.run(effectId, timestamp);
    },
    publicInterface: Object.freeze({
      claim(request) {
        return claimTransaction.immediate(request);
      },
      acknowledge(request) {
        return acknowledgeTransaction.immediate(request);
      },
      fail(request) {
        return failTransaction.immediate(request);
      },
      reconcile(request) {
        return reconcileTransaction.immediate(request);
      },
      redrive(request) {
        return redriveTransaction.immediate(request);
      },
    }),
  });
}
