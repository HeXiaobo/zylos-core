import { createHash } from 'node:crypto';

const MAX_LEASE_MS = 86_400_000;
const DEFAULT_QUERY_LIMIT = 50;
const MAX_QUERY_LIMIT = 100;
const RUN_STATUSES = new Set(['active', 'completed', 'released', 'expired']);

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

function requireText(value, field) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`${field} must be a non-empty string`);
  }
  return value;
}

function normalizeVersion(value, field) {
  if (!Number.isInteger(value) || value < 1) {
    throw new TypeError(`${field} must be a positive integer`);
  }
  return value;
}

function normalizeLeaseMs(value) {
  if (!Number.isInteger(value) || value < 1 || value > MAX_LEASE_MS) {
    throw new TypeError(`leaseMs must be an integer between 1 and ${MAX_LEASE_MS}`);
  }
  return value;
}

function normalizeClaim(rawRequest) {
  const request = requireObject(rawRequest, 'claim request');
  rejectUnknownFields(
    request,
    new Set(['taskId', 'actorId', 'workerId', 'idempotencyKey', 'leaseMs']),
    'claim request',
  );
  return {
    taskId: requireText(request.taskId, 'claim.taskId'),
    actorId: requireText(request.actorId, 'claim.actorId'),
    workerId: requireText(request.workerId, 'claim.workerId'),
    idempotencyKey: requireText(request.idempotencyKey, 'claim.idempotencyKey'),
    leaseMs: normalizeLeaseMs(request.leaseMs),
  };
}

function normalizeHeartbeat(rawRequest) {
  const request = requireObject(rawRequest, 'heartbeat request');
  rejectUnknownFields(
    request,
    new Set(['taskId', 'runId', 'workerId', 'idempotencyKey', 'leaseMs']),
    'heartbeat request',
  );
  return {
    taskId: requireText(request.taskId, 'heartbeat.taskId'),
    runId: requireText(request.runId, 'heartbeat.runId'),
    workerId: requireText(request.workerId, 'heartbeat.workerId'),
    idempotencyKey: requireText(request.idempotencyKey, 'heartbeat.idempotencyKey'),
    leaseMs: normalizeLeaseMs(request.leaseMs),
  };
}

function normalizeFinish(rawRequest, operation) {
  const request = requireObject(rawRequest, `${operation} request`);
  rejectUnknownFields(
    request,
    new Set(['taskId', 'runId', 'workerId', 'idempotencyKey']),
    `${operation} request`,
  );
  return {
    taskId: requireText(request.taskId, `${operation}.taskId`),
    runId: requireText(request.runId, `${operation}.runId`),
    workerId: requireText(request.workerId, `${operation}.workerId`),
    idempotencyKey: requireText(request.idempotencyKey, `${operation}.idempotencyKey`),
  };
}

function normalizeFinishVersions(rawVersions) {
  const versions = requireObject(rawVersions, 'versions');
  rejectUnknownFields(versions, new Set(['runVersion', 'taskVersion']), 'versions');
  return {
    runVersion: normalizeVersion(versions.runVersion, 'runVersion'),
    taskVersion: normalizeVersion(versions.taskVersion, 'taskVersion'),
  };
}

function normalizeRunQuery(rawQuery) {
  const query = requireObject(rawQuery, 'run query');
  if (Object.hasOwn(query, 'runId')) {
    rejectUnknownFields(query, new Set(['runId', 'includeEvents']), 'run query');
    if (query.includeEvents !== undefined && typeof query.includeEvents !== 'boolean') {
      throw new TypeError('includeEvents must be a boolean');
    }
    return {
      mode: 'run',
      runId: requireText(query.runId, 'runId'),
      includeEvents: query.includeEvents ?? false,
    };
  }

  rejectUnknownFields(query, new Set(['taskId', 'statuses', 'limit']), 'run query');
  const taskId = requireText(query.taskId, 'taskId');
  let statuses = null;
  if (query.statuses !== undefined) {
    if (!Array.isArray(query.statuses) || query.statuses.length === 0) {
      throw new TypeError('statuses must be a non-empty array');
    }
    statuses = [...new Set(query.statuses.map((status) => requireText(status, 'status')))];
    const invalidStatus = statuses.find((status) => !RUN_STATUSES.has(status));
    if (invalidStatus) throw new TypeError(`invalid run status: ${invalidStatus}`);
  }
  const limit = query.limit ?? DEFAULT_QUERY_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_QUERY_LIMIT) {
    throw new TypeError(`limit must be an integer between 1 and ${MAX_QUERY_LIMIT}`);
  }
  return { mode: 'task', taskId, statuses, limit };
}

function fingerprint(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function domainError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function idempotencyConflict(key) {
  return domainError(
    'IDEMPOTENCY_CONFLICT',
    `idempotency key already belongs to different content: ${key}`,
  );
}

function toRunView(row) {
  if (!row) return null;
  return {
    id: row.id,
    taskId: row.task_id,
    actorId: row.actor_id,
    workerId: row.worker_id,
    status: row.status,
    version: row.version,
    leaseExpiresAt: row.lease_expires_at,
    lastHeartbeatAt: row.last_heartbeat_at,
    startedAt: row.started_at,
    endedAt: row.ended_at,
  };
}

function toRunEventView(row) {
  return {
    id: row.id,
    type: row.event_type,
    runId: row.run_id,
    taskId: row.task_id,
    workerId: row.worker_id,
    version: row.run_version,
    taskVersion: row.task_version,
    leaseExpiresAt: row.lease_expires_at,
    occurredAt: row.occurred_at,
  };
}

function currentInstant(clock) {
  const rawTimestamp = requireText(clock(), 'clock result');
  const milliseconds = Date.parse(rawTimestamp);
  if (!Number.isFinite(milliseconds)) throw new TypeError('clock result must be a valid timestamp');
  return { timestamp: new Date(milliseconds).toISOString(), milliseconds };
}

function leaseExpiration(milliseconds, leaseMs) {
  return new Date(milliseconds + leaseMs).toISOString();
}

export function initializeTaskRunSchema(database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS commitment_task_runs (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      actor_id TEXT NOT NULL,
      worker_id TEXT NOT NULL,
      status TEXT NOT NULL CHECK (
        status IN ('active', 'completed', 'released', 'expired')
      ),
      version INTEGER NOT NULL,
      lease_expires_at TEXT NOT NULL,
      last_heartbeat_at TEXT NOT NULL,
      started_at TEXT NOT NULL,
      ended_at TEXT,
      FOREIGN KEY (task_id) REFERENCES commitment_tasks(id) ON DELETE RESTRICT
    );

    CREATE UNIQUE INDEX IF NOT EXISTS uq_commitment_task_runs_active_task
      ON commitment_task_runs(task_id)
      WHERE status = 'active';

    CREATE INDEX IF NOT EXISTS idx_commitment_task_runs_task_started
      ON commitment_task_runs(task_id, started_at DESC, id DESC);

    CREATE TABLE IF NOT EXISTS commitment_run_events (
      id TEXT PRIMARY KEY,
      event_type TEXT NOT NULL,
      run_id TEXT NOT NULL,
      task_id TEXT NOT NULL,
      worker_id TEXT NOT NULL,
      run_version INTEGER NOT NULL,
      task_version INTEGER NOT NULL,
      lease_expires_at TEXT NOT NULL,
      occurred_at TEXT NOT NULL,
      FOREIGN KEY (run_id) REFERENCES commitment_task_runs(id) ON DELETE RESTRICT,
      FOREIGN KEY (task_id) REFERENCES commitment_tasks(id) ON DELETE RESTRICT
    );

    CREATE UNIQUE INDEX IF NOT EXISTS uq_commitment_run_events_version
      ON commitment_run_events(run_id, run_version);

    CREATE TABLE IF NOT EXISTS commitment_run_commands (
      idempotency_key TEXT PRIMARY KEY,
      operation TEXT NOT NULL,
      request_fingerprint TEXT NOT NULL,
      task_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      result_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (task_id) REFERENCES commitment_tasks(id) ON DELETE RESTRICT,
      FOREIGN KEY (run_id) REFERENCES commitment_task_runs(id) ON DELETE RESTRICT
    );
  `);
}

/**
 * Owns Task Run leases, receipts, and Run Events. Task state mutation is
 * delegated through taskStore so the caller can keep Task and Run writes in
 * the same SQLite transaction without exposing tables to Adapters.
 */
export function createTaskRunModule({
  database,
  clock,
  runIdGenerator,
  runEventIdGenerator,
  taskStore,
}) {
  const selectRun = database.prepare(`
    SELECT id, task_id, actor_id, worker_id, status, version, lease_expires_at,
           last_heartbeat_at, started_at, ended_at
    FROM commitment_task_runs
    WHERE id = ?
  `);
  const selectActiveRun = database.prepare(`
    SELECT id, task_id, actor_id, worker_id, status, version, lease_expires_at,
           last_heartbeat_at, started_at, ended_at
    FROM commitment_task_runs
    WHERE task_id = ? AND status = 'active'
  `);
  const selectRunEvents = database.prepare(`
    SELECT id, event_type, run_id, task_id, worker_id, run_version,
           task_version, lease_expires_at, occurred_at
    FROM commitment_run_events
    WHERE run_id = ?
    ORDER BY run_version, id
  `);
  const selectReceipt = database.prepare(`
    SELECT request_fingerprint, result_json
    FROM commitment_run_commands
    WHERE idempotency_key = ?
  `);
  const insertRun = database.prepare(`
    INSERT INTO commitment_task_runs (
      id, task_id, actor_id, worker_id, status, version, lease_expires_at,
      last_heartbeat_at, started_at, ended_at
    ) VALUES (?, ?, ?, ?, 'active', 1, ?, ?, ?, NULL)
  `);
  const expireRun = database.prepare(`
    UPDATE commitment_task_runs
    SET status = 'expired', version = version + 1, ended_at = ?
    WHERE id = ? AND status = 'active' AND version = ?
  `);
  const heartbeatRun = database.prepare(`
    UPDATE commitment_task_runs
    SET version = version + 1, lease_expires_at = ?, last_heartbeat_at = ?
    WHERE id = ? AND status = 'active' AND version = ?
  `);
  const finishRun = database.prepare(`
    UPDATE commitment_task_runs
    SET status = ?, version = version + 1, ended_at = ?
    WHERE id = ? AND status = 'active' AND version = ?
  `);
  const insertRunEvent = database.prepare(`
    INSERT INTO commitment_run_events (
      id, event_type, run_id, task_id, worker_id, run_version,
      task_version, lease_expires_at, occurred_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertReceipt = database.prepare(`
    INSERT INTO commitment_run_commands (
      idempotency_key, operation, request_fingerprint, task_id, run_id,
      result_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  function receiptReplay(idempotencyKey, requestFingerprint) {
    const receipt = selectReceipt.get(idempotencyKey);
    if (!receipt) return null;
    if (receipt.request_fingerprint !== requestFingerprint) {
      throw idempotencyConflict(idempotencyKey);
    }
    return JSON.parse(receipt.result_json);
  }

  function saveReceipt(operation, request, requestFingerprint, result, timestamp) {
    insertReceipt.run(
      request.idempotencyKey,
      operation,
      requestFingerprint,
      request.taskId,
      result.run.id,
      JSON.stringify(result),
      timestamp,
    );
  }

  function recordRunEvent({ type, run, taskVersion, timestamp }) {
    const event = {
      id: requireText(runEventIdGenerator(), 'generated run event id'),
      type,
      runId: run.id,
      taskId: run.taskId,
      workerId: run.workerId,
      version: run.version,
      taskVersion,
      leaseExpiresAt: run.leaseExpiresAt,
      occurredAt: timestamp,
    };
    insertRunEvent.run(
      event.id,
      event.type,
      event.runId,
      event.taskId,
      event.workerId,
      event.version,
      event.taskVersion,
      event.leaseExpiresAt,
      event.occurredAt,
    );
    return event;
  }

  function assertTaskVersion(task, expectedVersion) {
    if (task.version !== expectedVersion) {
      throw domainError(
        'VERSION_CONFLICT',
        `expected task version ${expectedVersion}, found ${task.version}`,
      );
    }
  }

  function assertActiveLease(run, request, nowMilliseconds) {
    if (!run) throw domainError('RUN_NOT_FOUND', `run not found: ${request.runId}`);
    if (run.taskId !== request.taskId) {
      throw domainError(
        'RUN_TASK_MISMATCH',
        `run ${run.id} belongs to ${run.taskId}, not ${request.taskId}`,
      );
    }
    if (run.status !== 'active') {
      throw domainError('LEASE_NOT_ACTIVE', `run ${run.id} is ${run.status}`);
    }
    if (Date.parse(run.leaseExpiresAt) <= nowMilliseconds) {
      throw domainError('LEASE_EXPIRED', `lease expired for run ${run.id}`);
    }
    if (run.workerId !== request.workerId) {
      throw domainError('LEASE_FORBIDDEN', `${request.workerId} does not own run ${run.id}`);
    }
  }

  const claimTransaction = database.transaction((rawRequest, rawExpectedTaskVersion) => {
    const request = normalizeClaim(rawRequest);
    const expectedTaskVersion = normalizeVersion(rawExpectedTaskVersion, 'expectedTaskVersion');
    const requestFingerprint = fingerprint({ operation: 'claim', request, expectedTaskVersion });
    const replay = receiptReplay(request.idempotencyKey, requestFingerprint);
    if (replay) return replay;

    const task = taskStore.get(request.taskId);
    if (!task) throw domainError('TASK_NOT_FOUND', `task not found: ${request.taskId}`);
    assertTaskVersion(task, expectedTaskVersion);
    if (!['ready', 'in_progress'].includes(task.state)) {
      throw domainError('INVALID_TRANSITION', `Task Run cannot be claimed from ${task.state}`);
    }
    if (request.actorId !== (task.assigneeId ?? task.ownerId)) {
      throw domainError('FORBIDDEN', `${request.actorId} cannot claim Task ${task.id}`);
    }

    const now = currentInstant(clock);
    const activeRun = toRunView(selectActiveRun.get(task.id));
    let recoveredRun = null;
    if (activeRun) {
      if (Date.parse(activeRun.leaseExpiresAt) > now.milliseconds) {
        throw domainError(
          'LEASE_CONFLICT',
          `Task ${task.id} already has active run ${activeRun.id}`,
        );
      }
      const expired = expireRun.run(now.timestamp, activeRun.id, activeRun.version);
      if (expired.changes !== 1) {
        throw domainError('RUN_VERSION_CONFLICT', `run changed while expiring: ${activeRun.id}`);
      }
      recoveredRun = toRunView(selectRun.get(activeRun.id));
      recordRunEvent({
        type: 'TaskRunExpired',
        run: recoveredRun,
        taskVersion: task.version,
        timestamp: now.timestamp,
      });
    }

    const runId = requireText(runIdGenerator(), 'generated run id');
    const expiresAt = leaseExpiration(now.milliseconds, request.leaseMs);
    insertRun.run(
      runId,
      task.id,
      request.actorId,
      request.workerId,
      expiresAt,
      now.timestamp,
      now.timestamp,
    );
    const run = toRunView(selectRun.get(runId));
    const transition = task.state === 'ready'
      ? taskStore.transition({
        task,
        toState: 'in_progress',
        eventType: 'TaskStarted',
        actorId: request.actorId,
        timestamp: now.timestamp,
      })
      : { task, event: null };
    const event = recordRunEvent({
      type: 'TaskRunClaimed',
      run,
      taskVersion: transition.task.version,
      timestamp: now.timestamp,
    });
    const result = {
      run,
      task: transition.task,
      event,
      taskEvent: transition.event,
      recoveredRun,
    };
    saveReceipt('claim', request, requestFingerprint, result, now.timestamp);
    return result;
  });

  const heartbeatTransaction = database.transaction((rawRequest, rawExpectedRunVersion) => {
    const request = normalizeHeartbeat(rawRequest);
    const expectedRunVersion = normalizeVersion(rawExpectedRunVersion, 'expectedRunVersion');
    const requestFingerprint = fingerprint({ operation: 'heartbeat', request, expectedRunVersion });
    const replay = receiptReplay(request.idempotencyKey, requestFingerprint);
    if (replay) return replay;

    const now = currentInstant(clock);
    const run = toRunView(selectRun.get(request.runId));
    assertActiveLease(run, request, now.milliseconds);
    if (run.version !== expectedRunVersion) {
      throw domainError(
        'RUN_VERSION_CONFLICT',
        `expected run version ${expectedRunVersion}, found ${run.version}`,
      );
    }
    const task = taskStore.get(request.taskId);
    if (!task) throw domainError('TASK_NOT_FOUND', `task not found: ${request.taskId}`);
    if (task.state !== 'in_progress') {
      throw domainError(
        'INVALID_TRANSITION',
        `heartbeat cannot be applied while Task is ${task.state}`,
      );
    }

    const candidateExpiration = leaseExpiration(now.milliseconds, request.leaseMs);
    const expiresAt = candidateExpiration > run.leaseExpiresAt
      ? candidateExpiration
      : run.leaseExpiresAt;
    const renewed = heartbeatRun.run(expiresAt, now.timestamp, run.id, run.version);
    if (renewed.changes !== 1) {
      throw domainError('RUN_VERSION_CONFLICT', `run changed while renewing: ${run.id}`);
    }
    const updatedRun = toRunView(selectRun.get(run.id));
    const event = recordRunEvent({
      type: 'TaskRunHeartbeat',
      run: updatedRun,
      taskVersion: task.version,
      timestamp: now.timestamp,
    });
    const result = { run: updatedRun, event };
    saveReceipt('heartbeat', request, requestFingerprint, result, now.timestamp);
    return result;
  });

  function createFinishTransaction(operation, { runStatus, taskState, runEventType, taskEventType }) {
    return database.transaction((rawRequest, rawVersions) => {
      const request = normalizeFinish(rawRequest, operation);
      const versions = normalizeFinishVersions(rawVersions);
      const requestFingerprint = fingerprint({ operation, request, versions });
      const replay = receiptReplay(request.idempotencyKey, requestFingerprint);
      if (replay) return replay;

      const now = currentInstant(clock);
      const run = toRunView(selectRun.get(request.runId));
      assertActiveLease(run, request, now.milliseconds);
      if (run.version !== versions.runVersion) {
        throw domainError(
          'RUN_VERSION_CONFLICT',
          `expected run version ${versions.runVersion}, found ${run.version}`,
        );
      }
      const task = taskStore.get(request.taskId);
      if (!task) throw domainError('TASK_NOT_FOUND', `task not found: ${request.taskId}`);
      assertTaskVersion(task, versions.taskVersion);
      if (task.state !== 'in_progress') {
        throw domainError(
          'INVALID_TRANSITION',
          `${operation} cannot be applied while Task is ${task.state}`,
        );
      }

      const finished = finishRun.run(runStatus, now.timestamp, run.id, run.version);
      if (finished.changes !== 1) {
        throw domainError('RUN_VERSION_CONFLICT', `run changed while finishing: ${run.id}`);
      }
      const updatedRun = toRunView(selectRun.get(run.id));
      const transition = taskStore.transition({
        task,
        toState: taskState,
        eventType: taskEventType,
        actorId: run.actorId,
        timestamp: now.timestamp,
      });
      const event = recordRunEvent({
        type: runEventType,
        run: updatedRun,
        taskVersion: transition.task.version,
        timestamp: now.timestamp,
      });
      const result = {
        run: updatedRun,
        task: transition.task,
        event,
        taskEvent: transition.event,
      };
      saveReceipt(operation, request, requestFingerprint, result, now.timestamp);
      return result;
    });
  }

  const completeTransaction = createFinishTransaction('complete', {
    runStatus: 'completed',
    taskState: 'review',
    runEventType: 'TaskRunCompleted',
    taskEventType: 'TaskSubmittedForReview',
  });
  const releaseTransaction = createFinishTransaction('release', {
    runStatus: 'released',
    taskState: 'ready',
    runEventType: 'TaskRunReleased',
    taskEventType: 'TaskRunReleased',
  });

  return Object.freeze({
    claim(request, expectedTaskVersion) {
      return claimTransaction.immediate(request, expectedTaskVersion);
    },
    heartbeat(request, expectedRunVersion) {
      return heartbeatTransaction.immediate(request, expectedRunVersion);
    },
    complete(request, versions) {
      return completeTransaction.immediate(request, versions);
    },
    release(request, versions) {
      return releaseTransaction.immediate(request, versions);
    },
    query(query) {
      const normalized = normalizeRunQuery(query);
      if (normalized.mode === 'run') {
        const run = toRunView(selectRun.get(normalized.runId));
        if (!normalized.includeEvents) return run;
        return {
          run,
          events: selectRunEvents.all(normalized.runId).map(toRunEventView),
        };
      }

      const clauses = ['task_id = ?'];
      const values = [normalized.taskId];
      if (normalized.statuses) {
        clauses.push(`status IN (${normalized.statuses.map(() => '?').join(', ')})`);
        values.push(...normalized.statuses);
      }
      return database.prepare(`
        SELECT id, task_id, actor_id, worker_id, status, version, lease_expires_at,
               last_heartbeat_at, started_at, ended_at
        FROM commitment_task_runs
        WHERE ${clauses.join(' AND ')}
        ORDER BY started_at DESC, id DESC
        LIMIT ?
      `).all(...values, normalized.limit).map(toRunView);
    },
  });
}
