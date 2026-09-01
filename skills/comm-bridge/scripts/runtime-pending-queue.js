import fs from 'node:fs';
import path from 'node:path';

import Database from 'better-sqlite3';

import { DB_PATH } from './c4-config.js';
import { ensureAssistantRunLedgerSchema } from './c4-db.js';
import { RUNTIME_LANE_ID } from './run-ledger.js';

function domainError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function requireText(value, field, maxLength = 8_192) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`${field} must be a non-empty string`);
  }
  if (Array.from(value).length > maxLength) {
    throw new TypeError(`${field} exceeds ${maxLength} characters`);
  }
  return value;
}

function requireGeneration(value, field = 'generation') {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${field} must be a positive safe integer`);
  }
  return value;
}

function requireAdmissionId(value) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError('admissionId must be a positive safe integer');
  }
  return value;
}

function requireClock(clock) {
  if (typeof clock !== 'function') throw new TypeError('clock must be a function');
  const current = clock();
  if (!Number.isSafeInteger(current) || current < 0) {
    throw new TypeError('clock must return a non-negative safe integer');
  }
  return clock;
}

function toRun(row) {
  if (!row) return null;
  return {
    requestId: row.request_id,
    conversationId: row.conversation_id,
    conversationLaneKey: row.conversation_lane_key,
    laneSequence: row.lane_sequence,
    acceptanceOrder: row.acceptance_order,
    traceId: row.trace_id,
    causationId: row.causation_id,
    requestClass: row.request_class,
    priority: row.priority,
    requireIdle: row.require_idle === 1,
    runtimeLaneId: row.runtime_lane_id,
    turnId: row.turn_id,
    generation: row.generation,
    status: row.status,
    acceptedAt: row.accepted_at,
    updatedAt: row.updated_at,
    terminalAt: row.terminal_at,
  };
}

function toAdmission(row, { legacy = false } = {}) {
  if (!row) return null;
  return {
    id: row.id,
    conversationId: row.conversation_id,
    requestId: row.request_id,
    routeChannel: row.route_channel,
    status: row.status,
    runtimeSessionId: row.runtime_session_id,
    acquiredAt: row.acquired_at,
    startedAt: row.started_at,
    terminalAt: row.terminal_at,
    updatedAt: row.updated_at,
    lifecycleVersion: row.lifecycle_version,
    bindingMode: row.binding_mode,
    terminalReason: row.terminal_reason,
    turnId: row.turn_id,
    generation: row.generation,
    runtimeLaneId: row.runtime_lane_id,
    legacy,
  };
}

export function openRuntimePendingQueue({
  dbPath = DB_PATH,
  clock = () => Math.floor(Date.now() / 1_000),
} = {}) {
  const normalizedPath = requireText(dbPath, 'dbPath');
  const safeClock = requireClock(clock);
  if (normalizedPath !== ':memory:') {
    fs.mkdirSync(path.dirname(normalizedPath), { recursive: true });
  }
  const database = new Database(normalizedPath);
  database.pragma('journal_mode = WAL');
  database.pragma('busy_timeout = 5000');
  database.pragma('foreign_keys = ON');
  ensureAssistantRunLedgerSchema(database);

  const runProjection = `
    SELECT l.*, r.conversation_id, r.route_channel
    FROM assistant_run_ledger AS l
    JOIN assistant_requests AS r ON r.request_id = l.request_id
  `;
  const admissionProjection = `
    SELECT id, conversation_id, request_id, route_channel, status,
           runtime_session_id, acquired_at, started_at, terminal_at, updated_at,
           lifecycle_version, binding_mode, terminal_reason,
           turn_id, generation, runtime_lane_id
    FROM runtime_turn_admissions
  `;
  const selectRun = database.prepare(`${runProjection} WHERE l.request_id = ?`);
  const selectRunForFence = database.prepare(`
    ${runProjection}
    WHERE l.request_id = ? AND l.turn_id = ? AND l.generation = ?
  `);
  // Capacity belongs to the pre-existing global singleton admission table.
  // It must not depend on whether a row can be projected into the new ledger.
  const selectActiveAdmission = database.prepare(`
    ${admissionProjection}
    WHERE status IN ('submitted', 'started')
    ORDER BY id ASC
    LIMIT 1
  `);
  const selectAdmissionById = database.prepare(`${admissionProjection} WHERE id = ?`);
  const selectAdmissionForIdentity = database.prepare(`
    ${admissionProjection}
    WHERE id = ? AND request_id = ? AND turn_id = ? AND generation = ?
    LIMIT 1
  `);
  const selectStartedEventForFence = database.prepare(`
    SELECT payload_json
    FROM assistant_response_events
    WHERE request_id = ? AND turn_id = ? AND generation = ?
      AND event_type = 'RunStarted'
    ORDER BY sequence ASC
    LIMIT 1
  `);
  const selectCandidate = database.prepare(`
    ${runProjection}
    WHERE l.status = 'queued'
      AND (l.require_idle = 0 OR ? = 1)
      AND NOT EXISTS (
        SELECT 1
        FROM assistant_run_ledger AS predecessor
        WHERE predecessor.conversation_lane_key = l.conversation_lane_key
          AND predecessor.lane_sequence < l.lane_sequence
          AND predecessor.status IN ('queued', 'active', 'cancel_requested')
      )
    ORDER BY l.priority ASC, l.acceptance_order ASC
    LIMIT 1
  `);
  const selectStaleAdmission = database.prepare(`
    ${admissionProjection}
    WHERE status IN ('submitted', 'started') AND updated_at <= ?
    ORDER BY id ASC
    LIMIT 1
  `);

  function projectionFor(admission) {
    if (
      !admission
      || admission.turn_id === null
      || admission.generation === null
      || admission.runtime_lane_id !== RUNTIME_LANE_ID
    ) {
      return null;
    }
    return selectRunForFence.get(
      admission.request_id,
      admission.turn_id,
      admission.generation,
    ) ?? null;
  }

  function activeView(row) {
    if (!row) return null;
    const projection = projectionFor(row);
    return {
      ...toAdmission(row, { legacy: projection === null }),
      request: toRun(projection),
    };
  }

  function assertRunFence({ requestId, turnId, generation }) {
    const run = selectRun.get(requestId);
    if (!run) throw domainError('RUN_NOT_FOUND', `unknown Assistant Request: ${requestId}`);
    if (run.turn_id !== turnId || run.generation !== generation) {
      throw domainError('RUN_EVENT_FENCED', 'runtime admission targets a stale turn/generation');
    }
    return run;
  }

  const claimTransaction = database.transaction(({ runtimeIdle }) => {
    const active = selectActiveAdmission.get();
    if (active) {
      return {
        claimed: false,
        reason: 'capacity_occupied',
        admission: toAdmission(active, { legacy: projectionFor(active) === null }),
        request: null,
      };
    }
    const candidate = selectCandidate.get(runtimeIdle ? 1 : 0);
    if (!candidate) {
      return {
        claimed: false,
        reason: 'no_eligible_request',
        admission: null,
        request: null,
      };
    }
    const current = safeClock();
    const inserted = database.prepare(`
      INSERT INTO runtime_turn_admissions (
        singleton_key, conversation_id, request_id, route_channel, status,
        runtime_session_id, acquired_at, started_at, terminal_at, updated_at,
        lifecycle_version, lifecycle_observed_at_ms, binding_mode,
        turn_id, generation, runtime_lane_id
      ) VALUES (
        1, ?, ?, ?, 'submitted', NULL, ?, NULL, NULL, ?,
        0, ?, 'pending', ?, ?, ?
      )
    `).run(
      candidate.conversation_id,
      candidate.request_id,
      candidate.route_channel,
      current,
      current,
      current * 1_000,
      candidate.turn_id,
      candidate.generation,
      RUNTIME_LANE_ID,
    );
    return {
      claimed: true,
      reason: null,
      admission: toAdmission(selectAdmissionById.get(Number(inserted.lastInsertRowid))),
      request: toRun(selectRun.get(candidate.request_id)),
    };
  });

  const confirmStartedTransaction = database.transaction(({
    admissionId,
    requestId,
    turnId,
    generation,
    runtimeSessionId,
  }) => {
    const safeAdmissionId = requireAdmissionId(admissionId);
    const safeRequestId = requireText(requestId, 'requestId');
    const safeTurnId = requireText(turnId, 'turnId');
    const safeGeneration = requireGeneration(generation);
    const safeRuntimeSessionId = requireText(runtimeSessionId, 'runtimeSessionId');
    const run = assertRunFence({
      requestId: safeRequestId,
      turnId: safeTurnId,
      generation: safeGeneration,
    });
    const admission = selectAdmissionForIdentity.get(
      safeAdmissionId,
      safeRequestId,
      safeTurnId,
      safeGeneration,
    );
    if (!admission) {
      throw domainError('RUNTIME_ADMISSION_NOT_FOUND', 'no runtime admission matches the run fence');
    }
    if (admission.status === 'started' || admission.status === 'completed') {
      if (admission.runtime_session_id !== safeRuntimeSessionId) {
        throw domainError(
          'RUNTIME_SESSION_CONFLICT',
          'runtime admission is already bound to another runtime session',
        );
      }
      if (admission.status === 'completed') {
        const startedEvent = selectStartedEventForFence.get(
          safeRequestId,
          safeTurnId,
          safeGeneration,
        );
        const startedPayload = startedEvent ? JSON.parse(startedEvent.payload_json) : null;
        if (
          admission.started_at === null
          || startedPayload?.runtimeSessionId !== safeRuntimeSessionId
        ) {
          throw domainError(
            'INVALID_RUNTIME_ADMISSION_STATE',
            'completed admission has no matching confirmed start fact',
          );
        }
      }
      return {
        started: true,
        replayed: true,
        admission: toAdmission(admission),
        request: toRun(run),
      };
    }
    if (admission.status !== 'submitted') {
      throw domainError(
        'INVALID_RUNTIME_ADMISSION_STATE',
        `cannot confirm a ${admission.status} runtime admission`,
      );
    }
    if (run.status !== 'queued') {
      throw domainError('INVALID_RUN_START_STATE', `cannot start a ${run.status} run`);
    }

    const current = safeClock();
    const sequence = database.prepare(`
      SELECT next_sequence FROM assistant_requests WHERE request_id = ?
    `).get(safeRequestId).next_sequence;
    const previousEvent = database.prepare(`
      SELECT event_id
      FROM assistant_response_events
      WHERE request_id = ?
      ORDER BY sequence DESC
      LIMIT 1
    `).get(safeRequestId);
    const admissionUpdate = database.prepare(`
      UPDATE runtime_turn_admissions
      SET status = 'started', runtime_session_id = ?, started_at = ?, updated_at = ?,
          lifecycle_version = lifecycle_version + 1, binding_mode = 'bound',
          binding_reason = 'runtime_submit_confirmed'
      WHERE id = ? AND status = 'submitted'
        AND request_id = ? AND turn_id = ? AND generation = ?
    `).run(
      safeRuntimeSessionId,
      current,
      current,
      admission.id,
      safeRequestId,
      safeTurnId,
      safeGeneration,
    );
    const runUpdate = database.prepare(`
      UPDATE assistant_run_ledger
      SET status = 'active', updated_at = ?
      WHERE request_id = ? AND turn_id = ? AND generation = ? AND status = 'queued'
    `).run(current, safeRequestId, safeTurnId, safeGeneration);
    const requestUpdate = database.prepare(`
      UPDATE assistant_requests
      SET status = 'started', runtime_session_id = ?,
          next_sequence = next_sequence + 1, updated_at = ?
      WHERE request_id = ? AND status = 'queued'
    `).run(safeRuntimeSessionId, current, safeRequestId);
    if (admissionUpdate.changes !== 1 || runUpdate.changes !== 1 || requestUpdate.changes !== 1) {
      throw domainError('RUNTIME_START_CONFLICT', 'runtime start confirmation lost its fence');
    }
    database.prepare(`
      UPDATE conversations
      SET status = 'delivered', delivery_action = 'runtime-started'
      WHERE id = ?
    `).run(run.conversation_id);
    database.prepare(`
      INSERT INTO assistant_response_events (
        request_id, sequence, event_type, payload_json, idempotency_key,
        delivery_status, available_at, created_at, event_id, turn_id,
        generation, trace_id, causation_id, producer
      ) VALUES (?, ?, 'RunStarted', ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      safeRequestId,
      sequence,
      JSON.stringify({
        runtimeLaneId: RUNTIME_LANE_ID,
        runtimeSessionId: safeRuntimeSessionId,
      }),
      `run:${safeRequestId}:started:g${safeGeneration}`,
      current,
      current,
      `evt:${safeRequestId}:${sequence}`,
      safeTurnId,
      safeGeneration,
      run.trace_id,
      previousEvent.event_id,
      'core:runtime-lane',
    );
    return {
      started: true,
      replayed: false,
      admission: toAdmission(selectAdmissionById.get(admission.id)),
      request: toRun(selectRun.get(safeRequestId)),
    };
  });

  const releaseSubmittedTransaction = database.transaction(({
    admissionId,
    requestId,
    turnId,
    generation,
    reason,
  }) => {
    const safeAdmissionId = requireAdmissionId(admissionId);
    const safeRequestId = requireText(requestId, 'requestId');
    const safeTurnId = requireText(turnId, 'turnId');
    const safeGeneration = requireGeneration(generation);
    const safeReason = requireText(reason, 'reason', 64);
    const run = assertRunFence({
      requestId: safeRequestId,
      turnId: safeTurnId,
      generation: safeGeneration,
    });
    const admission = selectAdmissionForIdentity.get(
      safeAdmissionId,
      safeRequestId,
      safeTurnId,
      safeGeneration,
    );
    if (!admission) {
      throw domainError('RUNTIME_ADMISSION_NOT_FOUND', 'no runtime admission matches the run fence');
    }
    if (admission.status === 'released') {
      return {
        released: true,
        replayed: true,
        admission: toAdmission(admission),
        request: toRun(run),
      };
    }
    if (admission.status !== 'submitted') {
      throw domainError(
        'INVALID_RUNTIME_ADMISSION_STATE',
        `cannot release a ${admission.status} runtime admission as unsubmitted`,
      );
    }
    const current = safeClock();
    const releaseUpdate = database.prepare(`
      UPDATE runtime_turn_admissions
      SET status = 'released', terminal_at = ?, updated_at = ?,
          binding_mode = 'closed', terminal_reason = ?
      WHERE id = ? AND request_id = ? AND turn_id = ? AND generation = ?
        AND status = 'submitted'
    `).run(
      current,
      current,
      safeReason,
      safeAdmissionId,
      safeRequestId,
      safeTurnId,
      safeGeneration,
    );
    if (releaseUpdate.changes !== 1) {
      throw domainError('RUNTIME_RELEASE_CONFLICT', 'runtime release lost its admission fence');
    }
    return {
      released: true,
      replayed: false,
      admission: toAdmission(selectAdmissionById.get(admission.id)),
      request: toRun(selectRun.get(safeRequestId)),
    };
  });

  const recoverStaleTransaction = database.transaction(({ staleBefore }) => {
    const stale = selectStaleAdmission.get(staleBefore);
    if (!stale) {
      return {
        recovered: false,
        reason: 'no_stale_admission',
        admission: null,
        request: null,
      };
    }
    const projectedRun = projectionFor(stale);
    if (!projectedRun) {
      return {
        recovered: false,
        reason: 'legacy_admission_owned_by_assistant_response_stream',
        admission: toAdmission(stale, { legacy: true }),
        request: null,
      };
    }

    const current = safeClock();
    const nextGeneration = stale.generation + 1;
    const nextTurnId = `turn:${stale.request_id}:${nextGeneration}`;
    const sequence = database.prepare(`
      SELECT next_sequence FROM assistant_requests WHERE request_id = ?
    `).get(stale.request_id).next_sequence;
    const previousEvent = database.prepare(`
      SELECT event_id
      FROM assistant_response_events
      WHERE request_id = ?
      ORDER BY sequence DESC
      LIMIT 1
    `).get(stale.request_id);

    database.prepare(`
      UPDATE runtime_turn_admissions
      SET status = 'released', terminal_at = ?, updated_at = ?,
          binding_mode = 'closed', terminal_reason = ?
      WHERE id = ? AND status IN ('submitted', 'started')
    `).run(
      current,
      current,
      stale.status === 'submitted'
        ? 'stale_unconfirmed_submission_generation_fence'
        : 'stale_started_generation_fence',
      stale.id,
    );
    const runUpdate = database.prepare(`
      UPDATE assistant_run_ledger
      SET status = 'queued', turn_id = ?, generation = ?, updated_at = ?
      WHERE request_id = ? AND turn_id = ? AND generation = ?
        AND status IN ('queued', 'active', 'cancel_requested')
    `).run(
      nextTurnId,
      nextGeneration,
      current,
      stale.request_id,
      stale.turn_id,
      stale.generation,
    );
    const requestUpdate = database.prepare(`
      UPDATE assistant_requests
      SET status = 'queued', runtime_session_id = NULL,
          next_sequence = next_sequence + 1, updated_at = ?
      WHERE request_id = ? AND status IN ('queued', 'started')
    `).run(current, stale.request_id);
    if (runUpdate.changes !== 1 || requestUpdate.changes !== 1) {
      throw domainError('RUNTIME_RECOVERY_CONFLICT', 'stale recovery lost its run fence');
    }
    database.prepare(`
      UPDATE conversations
      SET status = 'pending', delivery_action = 'queued'
      WHERE id = ?
    `).run(stale.conversation_id);
    database.prepare(`
      INSERT INTO assistant_response_events (
        request_id, sequence, event_type, payload_json, idempotency_key,
        delivery_status, available_at, created_at, event_id, turn_id,
        generation, trace_id, causation_id, producer
      ) VALUES (?, ?, 'RunQueued', ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      stale.request_id,
      sequence,
      JSON.stringify({
        runtimeLaneId: RUNTIME_LANE_ID,
        recoveredFromTurnId: stale.turn_id,
        recoveredAdmissionStatus: stale.status,
      }),
      `run:${stale.request_id}:recovered:g${nextGeneration}`,
      current,
      current,
      `evt:${stale.request_id}:${sequence}`,
      nextTurnId,
      nextGeneration,
      projectedRun.trace_id,
      previousEvent.event_id,
      'core:runtime-recovery',
    );
    return {
      recovered: true,
      reason: stale.status === 'submitted'
        ? 'unconfirmed_submission_fenced'
        : 'started_run_fenced',
      admission: toAdmission(selectAdmissionById.get(stale.id)),
      request: toRun(selectRun.get(stale.request_id)),
    };
  });

  return Object.freeze({
    claimNext({ runtimeIdle = false } = {}) {
      if (typeof runtimeIdle !== 'boolean') throw new TypeError('runtimeIdle must be a boolean');
      return claimTransaction.immediate({ runtimeIdle });
    },
    confirmStarted(input = {}) {
      return confirmStartedTransaction.immediate(input);
    },
    releaseSubmitted({ reason = 'runtime_submit_failed', ...input } = {}) {
      return releaseSubmittedTransaction.immediate({ ...input, reason });
    },
    getActive() {
      return activeView(selectActiveAdmission.get());
    },
    recoverStale({ staleBefore } = {}) {
      if (!Number.isSafeInteger(staleBefore) || staleBefore < 0) {
        throw new TypeError('staleBefore must be a non-negative safe integer');
      }
      return recoverStaleTransaction.immediate({ staleBefore });
    },
    close() {
      database.close();
    },
  });
}
