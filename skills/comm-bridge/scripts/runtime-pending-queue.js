import fs from 'node:fs';
import path from 'node:path';

import Database from 'better-sqlite3';

import { DB_PATH } from './c4-config.js';
import { ensureAssistantRunLedgerSchema } from './c4-db.js';
import { RUNTIME_LANE_ID } from './run-ledger.js';

function requireText(value, field, maxLength = 8_192) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`${field} must be a non-empty string`);
  }
  if (Array.from(value).length > maxLength) {
    throw new TypeError(`${field} exceeds ${maxLength} characters`);
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
  const selectRun = database.prepare(`${runProjection} WHERE l.request_id = ?`);
  const selectActive = database.prepare(`
    ${runProjection}
    JOIN runtime_turn_admissions AS a ON a.request_id = l.request_id
      AND a.turn_id = l.turn_id
      AND a.generation = l.generation
    WHERE a.status IN ('submitted', 'started')
      AND a.runtime_lane_id = ?
    ORDER BY a.id DESC
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
  const selectStaleActive = database.prepare(`
    SELECT l.*, r.conversation_id, r.route_channel,
           a.id AS admission_id, a.updated_at AS admission_updated_at
    FROM assistant_run_ledger AS l
    JOIN assistant_requests AS r ON r.request_id = l.request_id
    JOIN runtime_turn_admissions AS a ON a.request_id = l.request_id
      AND a.turn_id = l.turn_id
      AND a.generation = l.generation
    WHERE a.status IN ('submitted', 'started')
      AND a.runtime_lane_id = ?
      AND a.updated_at <= ?
    ORDER BY a.id DESC
    LIMIT 1
  `);

  const claimTransaction = database.transaction(({ runtimeIdle }) => {
    if (selectActive.get(RUNTIME_LANE_ID)) return null;
    const candidate = selectCandidate.get(runtimeIdle ? 1 : 0);
    if (!candidate) return null;
    const current = safeClock();
    const sequence = database.prepare(`
      SELECT next_sequence FROM assistant_requests WHERE request_id = ?
    `).get(candidate.request_id).next_sequence;
    const previousEvent = database.prepare(`
      SELECT event_id
      FROM assistant_response_events
      WHERE request_id = ?
      ORDER BY sequence DESC
      LIMIT 1
    `).get(candidate.request_id);

    database.prepare(`
      INSERT INTO runtime_turn_admissions (
        singleton_key, conversation_id, request_id, route_channel, status,
        runtime_session_id, acquired_at, started_at, terminal_at, updated_at,
        lifecycle_version, lifecycle_observed_at_ms, binding_mode,
        turn_id, generation, runtime_lane_id
      ) VALUES (
        1, ?, ?, ?, 'started', ?, ?, ?, NULL, ?,
        1, ?, 'bound', ?, ?, ?
      )
    `).run(
      candidate.conversation_id,
      candidate.request_id,
      candidate.route_channel,
      RUNTIME_LANE_ID,
      current,
      current,
      current,
      current * 1_000,
      candidate.turn_id,
      candidate.generation,
      RUNTIME_LANE_ID,
    );
    database.prepare(`
      UPDATE assistant_run_ledger
      SET status = 'active', updated_at = ?
      WHERE request_id = ? AND status = 'queued'
    `).run(current, candidate.request_id);
    database.prepare(`
      UPDATE assistant_requests
      SET status = 'started', runtime_session_id = ?,
          next_sequence = next_sequence + 1, updated_at = ?
      WHERE request_id = ? AND status = 'queued'
    `).run(RUNTIME_LANE_ID, current, candidate.request_id);
    database.prepare(`
      UPDATE conversations
      SET status = 'delivered', delivery_action = 'runtime-started'
      WHERE id = ?
    `).run(candidate.conversation_id);
    database.prepare(`
      INSERT INTO assistant_response_events (
        request_id, sequence, event_type, payload_json, idempotency_key,
        delivery_status, available_at, created_at, event_id, turn_id,
        generation, trace_id, causation_id, producer
      ) VALUES (?, ?, 'RunStarted', ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      candidate.request_id,
      sequence,
      JSON.stringify({ runtimeLaneId: RUNTIME_LANE_ID }),
      `run:${candidate.request_id}:started:g${candidate.generation}`,
      current,
      current,
      `evt:${candidate.request_id}:${sequence}`,
      candidate.turn_id,
      candidate.generation,
      candidate.trace_id,
      previousEvent.event_id,
      'core:runtime-lane',
    );
    return toRun(selectRun.get(candidate.request_id));
  });

  const recoverStaleTransaction = database.transaction(({ staleBefore }) => {
    const stale = selectStaleActive.get(RUNTIME_LANE_ID, staleBefore);
    if (!stale) return { recovered: false, request: null };
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
          binding_mode = 'closed', terminal_reason = 'stale_recovery_generation_fence'
      WHERE id = ? AND status IN ('submitted', 'started')
    `).run(current, current, stale.admission_id);
    database.prepare(`
      UPDATE assistant_run_ledger
      SET status = 'queued', turn_id = ?, generation = ?, updated_at = ?
      WHERE request_id = ? AND turn_id = ? AND generation = ?
        AND status IN ('active', 'cancel_requested')
    `).run(
      nextTurnId,
      nextGeneration,
      current,
      stale.request_id,
      stale.turn_id,
      stale.generation,
    );
    database.prepare(`
      UPDATE assistant_requests
      SET status = 'queued', runtime_session_id = NULL,
          next_sequence = next_sequence + 1, updated_at = ?
      WHERE request_id = ? AND status = 'started'
    `).run(current, stale.request_id);
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
      JSON.stringify({ runtimeLaneId: RUNTIME_LANE_ID, recoveredFromTurnId: stale.turn_id }),
      `run:${stale.request_id}:recovered:g${nextGeneration}`,
      current,
      current,
      `evt:${stale.request_id}:${sequence}`,
      nextTurnId,
      nextGeneration,
      stale.trace_id,
      previousEvent.event_id,
      'core:runtime-recovery',
    );
    return { recovered: true, request: toRun(selectRun.get(stale.request_id)) };
  });

  return Object.freeze({
    claimNext({ runtimeIdle = false } = {}) {
      if (typeof runtimeIdle !== 'boolean') throw new TypeError('runtimeIdle must be a boolean');
      return claimTransaction.immediate({ runtimeIdle });
    },
    getActive() {
      return toRun(selectActive.get(RUNTIME_LANE_ID));
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
