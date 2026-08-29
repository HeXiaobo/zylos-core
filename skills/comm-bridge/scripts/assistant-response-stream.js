import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import Database from 'better-sqlite3';

import {
  publicProgressForRuntimeTool,
  RUNTIME_ANALYSIS_PROGRESS,
  SAFE_PROGRESS_STAGES,
  safeProgressStageForTool,
} from './assistant-public-progress.js';
import { ensureAssistantResponseSchema, getDb } from './c4-db.js';

export { SAFE_PROGRESS_STAGES, safeProgressStageForTool } from './assistant-public-progress.js';

export const ASSISTANT_RESPONSE_EVENT_TYPES = Object.freeze([
  'AssistantRequestAccepted',
  'RunQueued',
  'RunStarted',
  'ProgressUpdated',
  'PublicReasoningDelta',
  'OutputDelta',
  'RunCompleted',
  'RunFailed',
]);

const EVENT_TYPE_SET = new Set(ASSISTANT_RESPONSE_EVENT_TYPES);
const PROGRESS_STAGE_SET = new Set(SAFE_PROGRESS_STAGES);
const TERMINAL_STATUSES = new Set(['completed', 'failed']);
const MAX_IDENTIFIER_LENGTH = 512;
const MAX_DELTA_BYTES = 64 * 1024;
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const DEFAULT_RUNTIME_TURN_SUBMITTED_STALE_SECONDS = 60;

function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

function requireRecord(value, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${field} must be an object`);
  }
  return value;
}

function requireText(value, field, maxLength = MAX_IDENTIFIER_LENGTH) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`${field} must be a non-empty string`);
  }
  const text = value.trim();
  if (Array.from(text).length > maxLength) {
    throw new TypeError(`${field} exceeds ${maxLength} characters`);
  }
  return text;
}

function requireIdentifier(value, field) {
  const text = requireText(value, field);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(text)) {
    throw new TypeError(`${field} contains unsafe characters`);
  }
  return text;
}

function requireInteger(value, field, { minimum = 0 } = {}) {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new TypeError(`${field} must be an integer >= ${minimum}`);
  }
  return value;
}

function requireExactFields(value, allowed, required, field) {
  const keys = Object.keys(value);
  if (keys.some(key => !allowed.includes(key))) {
    throw new TypeError(`${field} contains unsupported fields`);
  }
  if (required.some(key => !Object.hasOwn(value, key))) {
    throw new TypeError(`${field} is missing required fields`);
  }
}

function boundedUtf8(value, field, maxBytes) {
  if (typeof value !== 'string') {
    throw new TypeError(`${field} must be a string`);
  }
  if (Buffer.byteLength(value, 'utf8') > maxBytes) {
    throw new TypeError(`${field} exceeds ${maxBytes} UTF-8 bytes`);
  }
  return value;
}

function outputHash(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function toEvent(row) {
  if (!row) return null;
  if (!EVENT_TYPE_SET.has(row.event_type)) {
    throw new Error(`unsupported persisted assistant response event: ${row.event_type}`);
  }
  return Object.freeze({
    schemaVersion: 1,
    eventId: `${row.request_id}:${row.sequence}`,
    requestId: row.request_id,
    sequence: row.sequence,
    type: row.event_type,
    occurredAt: row.created_at,
    payload: Object.freeze(JSON.parse(row.payload_json)),
  });
}

function toRequest(row) {
  if (!row) return null;
  return {
    requestId: row.request_id,
    conversationId: row.conversation_id,
    route: {
      channel: row.route_channel,
      endpointId: row.route_endpoint,
    },
    sourceId: row.source_id,
    status: row.status,
    runtimeSessionId: row.runtime_session_id,
    output: row.output_text,
    acceptedAt: row.accepted_at,
    updatedAt: row.updated_at,
    terminalAt: row.terminal_at,
  };
}

function toRuntimeTurnAdmission(row) {
  if (!row) return null;
  return {
    admissionId: row.id,
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
    lifecycleObservedAtMs: row.lifecycle_observed_at_ms,
    recoveryActivityObservedAtMs: row.recovery_activity_observed_at_ms,
    recoveryActivityId: row.recovery_activity_id,
    bindingMode: row.binding_mode,
    bindingReason: row.binding_reason,
    bindingProjectionPending: row.binding_projection_pending === 1,
    bindingProjectionObservedAtMs: row.binding_projection_observed_at_ms,
    bindingProjectedAt: row.binding_projected_at,
    terminalReason: row.terminal_reason,
  };
}

function toFinalOutputCandidate(row) {
  if (!row) return null;
  return {
    candidateId: row.id,
    requestId: row.request_id,
    admissionId: row.admission_id,
    runtimeSessionId: row.runtime_session_id,
    messageId: row.message_id,
    activityId: row.activity_id,
    outputHash: row.output_hash,
    observedAtMs: row.observed_at_ms,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    terminalReason: row.terminal_reason,
  };
}

function openDatabase(dbPath) {
  if (!dbPath) return { database: getDb(), ownsDatabase: false };
  if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const database = new Database(dbPath);
  database.pragma('busy_timeout = 5000');
  database.pragma('foreign_keys = ON');
  if (dbPath !== ':memory:') database.pragma('journal_mode = WAL');
  // Standalone tests and adapters may open this Module without c4-db first.
  database.exec(`
    CREATE TABLE IF NOT EXISTS conversations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
      direction TEXT NOT NULL,
      channel TEXT NOT NULL,
      endpoint_id TEXT,
      content TEXT NOT NULL,
      assistant_request_id TEXT,
      status TEXT DEFAULT 'pending',
      delivery_action TEXT,
      priority INTEGER DEFAULT 3,
      require_idle INTEGER DEFAULT 0,
      retry_count INTEGER DEFAULT 0
    );
  `);
  const conversationColumns = new Set(
    database.prepare('PRAGMA table_info(conversations)').all().map(column => column.name),
  );
  if (!conversationColumns.has('assistant_request_id')) {
    database.exec('ALTER TABLE conversations ADD COLUMN assistant_request_id TEXT');
  }
  database.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_conversations_assistant_request_out
      ON conversations(assistant_request_id)
      WHERE direction = 'out' AND assistant_request_id IS NOT NULL
  `);
  return { database, ownsDatabase: true };
}

function safeErrorCode(value) {
  const code = requireText(value, 'code', 64).toUpperCase();
  if (!/^[A-Z][A-Z0-9_]*$/.test(code)) {
    throw new TypeError('code must be a public uppercase error identifier');
  }
  return code;
}

/**
 * Open the durable, runtime-neutral ConversationResponseStream Module.
 *
 * Its small Interface owns lifecycle validation, monotonic event sequencing,
 * output accumulation, delivery leasing/retry, and stale-run recovery.  Route
 * metadata is kept beside the event envelope so platform types never enter the
 * event contract.
 */
export function openAssistantResponseStream({
  dbPath = null,
  clock = nowSeconds,
  observationClock = Date.now,
  leaseToken = randomUUID,
  runtimeTurnSubmittedStaleSeconds = DEFAULT_RUNTIME_TURN_SUBMITTED_STALE_SECONDS,
} = {}) {
  requireInteger(
    runtimeTurnSubmittedStaleSeconds,
    'runtimeTurnSubmittedStaleSeconds',
    { minimum: 1 },
  );
  if (typeof observationClock !== 'function') {
    throw new TypeError('observationClock must be a function');
  }
  const opened = openDatabase(dbPath);
  const database = opened.database;
  let ownsDatabase = opened.ownsDatabase;
  ensureAssistantResponseSchema(database, { observationClock });

  const selectRequest = database.prepare(`
    SELECT request_id, conversation_id, route_channel, route_endpoint, source_id,
           status, runtime_session_id, next_sequence, output_text,
           accepted_at, updated_at, terminal_at
    FROM assistant_requests
    WHERE request_id = ?
  `);
  const selectFirstStartedRequest = database.prepare(`
    SELECT request_id, conversation_id, route_channel, route_endpoint, source_id,
           status, runtime_session_id, next_sequence, output_text,
           accepted_at, updated_at, terminal_at
    FROM assistant_requests
    WHERE status = 'started'
    ORDER BY accepted_at ASC, request_id ASC
    LIMIT 1
  `);
  const selectFirstStartedRequestExcluding = database.prepare(`
    SELECT request_id, conversation_id, route_channel, route_endpoint, source_id,
           status, runtime_session_id, next_sequence, output_text,
           accepted_at, updated_at, terminal_at
    FROM assistant_requests
    WHERE status = 'started' AND request_id <> ?
    ORDER BY accepted_at ASC, request_id ASC
    LIMIT 1
  `);
  const selectActiveRuntimeTurnAdmission = database.prepare(`
    SELECT id, conversation_id, request_id, route_channel, status,
           runtime_session_id, acquired_at, started_at, terminal_at,
           updated_at, lifecycle_version, lifecycle_observed_at_ms,
           recovery_activity_observed_at_ms, recovery_activity_id,
           binding_mode, binding_reason,
           binding_projection_pending, binding_projection_observed_at_ms,
           binding_projected_at, terminal_reason
    FROM runtime_turn_admissions
    WHERE status IN ('submitted', 'started')
    ORDER BY id ASC
    LIMIT 1
  `);
  const selectRuntimeTurnAdmissionById = database.prepare(`
    SELECT id, conversation_id, request_id, route_channel, status,
           runtime_session_id, acquired_at, started_at, terminal_at,
           updated_at, lifecycle_version, lifecycle_observed_at_ms,
           recovery_activity_observed_at_ms, recovery_activity_id,
           binding_mode, binding_reason,
           binding_projection_pending, binding_projection_observed_at_ms,
           binding_projected_at, terminal_reason
    FROM runtime_turn_admissions
    WHERE id = ?
  `);
  const selectActiveFinalOutputCandidate = database.prepare(`
    SELECT id, request_id, admission_id, runtime_session_id, message_id,
           activity_id, output_hash, observed_at_ms, status,
           created_at, updated_at, terminal_reason
    FROM assistant_final_output_candidates
    WHERE request_id = ? AND status = 'active'
    ORDER BY id DESC
    LIMIT 1
  `);
  const selectFinalOutputCandidates = database.prepare(`
    SELECT id, request_id, admission_id, runtime_session_id, message_id,
           activity_id, output_hash, observed_at_ms, status,
           created_at, updated_at, terminal_reason
    FROM assistant_final_output_candidates
    WHERE request_id = ?
    ORDER BY id DESC
  `);
  const selectExactFinalOutputCandidate = database.prepare(`
    SELECT id, request_id, admission_id, runtime_session_id, message_id,
           activity_id, output_hash, observed_at_ms, status,
           created_at, updated_at, terminal_reason
    FROM assistant_final_output_candidates
    WHERE request_id = ? AND admission_id = ? AND message_id = ?
    LIMIT 1
  `);
  const selectPendingRuntimeTurnBindingProjections = database.prepare(`
    SELECT id, conversation_id, request_id, route_channel, status,
           runtime_session_id, acquired_at, started_at, terminal_at,
           updated_at, lifecycle_version, lifecycle_observed_at_ms,
           recovery_activity_observed_at_ms, recovery_activity_id,
           binding_mode, binding_reason,
           binding_projection_pending, binding_projection_observed_at_ms,
           binding_projected_at, terminal_reason
    FROM runtime_turn_admissions
    WHERE binding_projection_pending = 1
      AND binding_mode = 'closed'
      AND runtime_session_id IS NOT NULL
      AND request_id IS NOT NULL
    ORDER BY id ASC
  `);
  const selectEvents = database.prepare(`
    SELECT id, request_id, sequence, event_type, payload_json, created_at
    FROM assistant_response_events
    WHERE request_id = ?
    ORDER BY sequence ASC
  `);
  const selectEventByKey = database.prepare(`
    SELECT id, request_id, sequence, event_type, payload_json, created_at
    FROM assistant_response_events
    WHERE request_id = ? AND idempotency_key = ?
  `);

  function appendEvent(requestRow, eventType, payload, idempotencyKey = null) {
    if (!EVENT_TYPE_SET.has(eventType)) throw new TypeError(`unsupported event type: ${eventType}`);
    if (idempotencyKey) {
      const existing = selectEventByKey.get(requestRow.request_id, idempotencyKey);
      if (existing) return { event: toEvent(existing), replayed: true };
    }
    const current = clock();
    const sequence = requestRow.next_sequence;
    database.prepare(`
      INSERT INTO assistant_response_events (
        request_id, sequence, event_type, payload_json, idempotency_key,
        delivery_status, retry_count, available_at, created_at
      ) VALUES (?, ?, ?, ?, ?, 'pending', 0, ?, ?)
    `).run(
      requestRow.request_id,
      sequence,
      eventType,
      JSON.stringify(payload),
      idempotencyKey,
      current,
      current,
    );
    database.prepare(`
      UPDATE assistant_requests
      SET next_sequence = next_sequence + 1, updated_at = ?
      WHERE request_id = ?
    `).run(current, requestRow.request_id);
    requestRow.next_sequence += 1;
    requestRow.updated_at = current;
    return {
      event: toEvent(database.prepare(`
        SELECT id, request_id, sequence, event_type, payload_json, created_at
        FROM assistant_response_events
        WHERE request_id = ? AND sequence = ?
      `).get(requestRow.request_id, sequence)),
      replayed: false,
    };
  }

  function closeActiveFinalOutputCandidate(requestId, status, terminalReason) {
    const current = clock();
    return database.prepare(`
      UPDATE assistant_final_output_candidates
      SET status = ?, updated_at = ?, terminal_reason = ?
      WHERE request_id = ? AND status = 'active'
    `).run(status, current, terminalReason, requestId).changes;
  }

  function verifyRuntimeMutationOwnership({
    requestId,
    runtimeSessionId,
    observedAtMs,
  }) {
    const active = selectActiveRuntimeTurnAdmission.get();
    if (
      !active
      || active.status !== 'started'
      || active.request_id !== requestId
      || active.runtime_session_id !== runtimeSessionId
    ) {
      return {
        verified: false,
        admission: toRuntimeTurnAdmission(active),
        reason: 'runtime_admission_conflict',
      };
    }
    if (active.binding_mode !== 'bound') {
      return {
        verified: false,
        admission: toRuntimeTurnAdmission(active),
        reason: 'runtime_binding_not_verified',
      };
    }
    if (
      active.lifecycle_observed_at_ms !== null
      && observedAtMs < active.lifecycle_observed_at_ms
    ) {
      return {
        verified: false,
        admission: toRuntimeTurnAdmission(active),
        reason: 'runtime_turn_observation_stale',
      };
    }
    return {
      verified: true,
      admission: toRuntimeTurnAdmission(active),
      row: active,
    };
  }

  function runtimeMutationScope(command, idempotencyKey) {
    const hasSession = Object.hasOwn(command, 'runtimeSessionId');
    const hasObservation = Object.hasOwn(command, 'observedAtMs');
    const hasActivity = Object.hasOwn(command, 'activityId');
    if (!hasObservation && !hasActivity) return null;
    if (!hasSession || !hasObservation) {
      throw new TypeError('scoped runtime mutation requires runtimeSessionId and observedAtMs');
    }
    return {
      runtimeSessionId: requireIdentifier(command.runtimeSessionId, 'runtimeSessionId'),
      observedAtMs: requireInteger(command.observedAtMs, 'observedAtMs', { minimum: 0 }),
      activityId: requireText(command.activityId ?? idempotencyKey, 'activityId'),
    };
  }

  function recordRecoveryActivity({
    requestId,
    runtimeSessionId,
    observedAtMs,
    activityId,
    reason,
  }) {
    const safeActivityId = requireText(activityId, 'activityId');
    const ownership = verifyRuntimeMutationOwnership({
      requestId,
      runtimeSessionId,
      observedAtMs,
    });
    if (!ownership.verified) return { recorded: false, reason: ownership.reason };
    const active = ownership.row;
    const current = clock();
    database.prepare(`
      UPDATE runtime_turn_admissions
      SET recovery_activity_observed_at_ms = CASE
            WHEN recovery_activity_observed_at_ms IS NULL
              OR recovery_activity_observed_at_ms < ? THEN ?
            ELSE recovery_activity_observed_at_ms
          END,
          recovery_activity_id = CASE
            WHEN recovery_activity_observed_at_ms IS NULL
              OR recovery_activity_observed_at_ms < ? THEN ?
            WHEN recovery_activity_observed_at_ms = ?
              AND recovery_activity_id = ? THEN recovery_activity_id
            WHEN recovery_activity_observed_at_ms = ? THEN NULL
            ELSE recovery_activity_id
          END,
          updated_at = ?, lifecycle_version = lifecycle_version + 1
      WHERE id = ? AND status = 'started'
    `).run(
      observedAtMs,
      observedAtMs,
      observedAtMs,
      safeActivityId,
      observedAtMs,
      safeActivityId,
      observedAtMs,
      current,
      active.id,
    );
    const candidate = selectActiveFinalOutputCandidate.get(requestId);
    if (
      candidate
      && (
        observedAtMs > candidate.observed_at_ms
        || (
          observedAtMs === candidate.observed_at_ms
          && safeActivityId !== candidate.activity_id
        )
      )
    ) {
      closeActiveFinalOutputCandidate(requestId, 'invalidated', reason);
    }
    return {
      recorded: true,
      admission: toRuntimeTurnAdmission(selectRuntimeTurnAdmissionById.get(active.id)),
    };
  }

  function validFinalOutputCandidate(request, admission) {
    const candidate = selectActiveFinalOutputCandidate.get(request.request_id);
    if (!candidate) return null;
    const valid = (
      candidate.admission_id === admission.id
      && candidate.runtime_session_id === admission.runtime_session_id
      && request.runtime_session_id === admission.runtime_session_id
      && request.output_text.trim()
      && candidate.output_hash === outputHash(request.output_text)
      && (
        admission.recovery_activity_observed_at_ms === null
        || candidate.observed_at_ms > admission.recovery_activity_observed_at_ms
        || (
          candidate.observed_at_ms === admission.recovery_activity_observed_at_ms
          && candidate.activity_id === admission.recovery_activity_id
        )
      )
    );
    return valid ? candidate : null;
  }

  function recordTerminalOutbound(request, {
    content,
    status,
    deliveryAction,
  }) {
    const existing = database.prepare(`
      SELECT id, direction, channel, endpoint_id, content, status,
             delivery_action, assistant_request_id
      FROM conversations
      WHERE direction = 'out' AND assistant_request_id = ?
      LIMIT 1
    `).get(request.request_id);
    if (existing) return existing;

    const inserted = database.prepare(`
      INSERT INTO conversations (
        direction, channel, endpoint_id, content, status, delivery_action,
        priority, require_idle, assistant_request_id
      ) VALUES ('out', ?, ?, ?, ?, ?, 3, 0, ?)
    `).run(
      request.route_channel,
      request.route_endpoint,
      content,
      status,
      deliveryAction,
      request.request_id,
    );
    return database.prepare(`
      SELECT id, direction, channel, endpoint_id, content, status,
             delivery_action, assistant_request_id
      FROM conversations
      WHERE id = ?
    `).get(Number(inserted.lastInsertRowid));
  }

  const acceptTransaction = database.transaction(command => {
    const requestId = requireIdentifier(command.requestId, 'requestId');
    const route = requireRecord(command.route, 'route');
    requireExactFields(route, ['channel', 'endpointId'], ['channel', 'endpointId'], 'route');
    const channel = requireText(route.channel, 'route.channel');
    const endpointId = requireText(route.endpointId, 'route.endpointId');
    const sourceId = requireText(command.sourceId, 'sourceId');
    const conversation = requireRecord(command.conversation, 'conversation');
    requireExactFields(
      conversation,
      ['content', 'status', 'priority', 'requireIdle'],
      ['content', 'status', 'priority', 'requireIdle'],
      'conversation',
    );
    const content = boundedUtf8(conversation.content, 'conversation.content', MAX_OUTPUT_BYTES);
    if (content.length === 0) throw new TypeError('conversation.content must not be empty');
    if (!['pending', 'delivered'].includes(conversation.status)) {
      throw new TypeError('conversation.status must be pending or delivered');
    }
    const priority = requireInteger(conversation.priority, 'conversation.priority', { minimum: 1 });
    if (priority > 3) throw new TypeError('conversation.priority must be <= 3');
    if (typeof conversation.requireIdle !== 'boolean') {
      throw new TypeError('conversation.requireIdle must be a boolean');
    }
    const existing = selectRequest.get(requestId);
    if (existing) {
      if (
        existing.route_channel !== channel
        || existing.route_endpoint !== endpointId
        || existing.source_id !== sourceId
      ) {
        const error = new Error(`assistant request id belongs to different input: ${requestId}`);
        error.code = 'ASSISTANT_REQUEST_CONFLICT';
        throw error;
      }
      return {
        request: toRequest(existing),
        events: selectEvents.all(requestId).map(toEvent),
        replayed: true,
      };
    }

    const current = clock();
    const conversationResult = database.prepare(`
      INSERT INTO conversations (
        direction, channel, endpoint_id, content, status, delivery_action,
        priority, require_idle
      ) VALUES ('in', ?, ?, ?, ?, NULL, ?, ?)
    `).run(
      channel,
      endpointId,
      content,
      conversation.status,
      priority,
      conversation.requireIdle ? 1 : 0,
    );
    const conversationId = Number(conversationResult.lastInsertRowid);
    database.prepare(`
      INSERT INTO assistant_requests (
        request_id, conversation_id, route_channel, route_endpoint, source_id,
        status, runtime_session_id, next_sequence, output_text,
        accepted_at, updated_at, terminal_at
      ) VALUES (?, ?, ?, ?, ?, 'queued', NULL, 1, '', ?, ?, NULL)
    `).run(requestId, conversationId, channel, endpointId, sourceId, current, current);
    const request = selectRequest.get(requestId);
    appendEvent(request, 'AssistantRequestAccepted', { sourceId });
    appendEvent(request, 'RunQueued', {});
    return {
      request: toRequest(selectRequest.get(requestId)),
      events: selectEvents.all(requestId).map(toEvent),
      replayed: false,
    };
  });

  const executeTransaction = database.transaction(command => {
    switch (command.type) {
      case 'AcceptAssistantRequest':
        return acceptTransaction(command);

      case 'StartRun': {
        const requestId = requireIdentifier(command.requestId, 'requestId');
        const request = selectRequest.get(requestId);
        if (!request) throw new Error(`assistant request not found: ${requestId}`);
        if (request.status === 'started') {
          const event = selectEvents.all(requestId).map(toEvent).find(item => item.type === 'RunStarted');
          return { request: toRequest(request), events: event ? [event] : [], replayed: true };
        }
        if (request.status !== 'queued') {
          return { request: toRequest(request), events: [], replayed: true };
        }
        const current = clock();
        database.prepare(`
          UPDATE assistant_requests
          SET status = 'started', updated_at = ?
          WHERE request_id = ? AND status = 'queued'
        `).run(current, request.request_id);
        request.status = 'started';
        const emitted = appendEvent(request, 'RunStarted', {});
        return {
          request: toRequest(selectRequest.get(request.request_id)),
          events: [emitted.event],
          replayed: false,
        };
      }

      case 'BindRun': {
        const requestId = requireIdentifier(command.requestId, 'requestId');
        const runtimeSessionId = requireIdentifier(command.runtimeSessionId, 'runtimeSessionId');
        const request = selectRequest.get(requestId);
        if (!request) throw new Error(`assistant request not found: ${requestId}`);
        if (!['queued', 'started'].includes(request.status)) {
          const error = new Error(`cannot bind a terminal assistant request (${request.status})`);
          error.code = 'ASSISTANT_RUN_BINDING_TERMINAL';
          throw error;
        }
        if (request.runtime_session_id === runtimeSessionId) {
          return { request: toRequest(request), events: [], replayed: true };
        }
        if (request.runtime_session_id !== null) {
          const error = new Error('assistant request is already bound to a different runtime session');
          error.code = 'ASSISTANT_RUN_BINDING_CONFLICT';
          throw error;
        }
        const sessionOwner = database.prepare(`
          SELECT request_id
          FROM assistant_requests
          WHERE runtime_session_id = ?
            AND status IN ('queued', 'started')
            AND request_id <> ?
          LIMIT 1
        `).get(runtimeSessionId, requestId);
        if (sessionOwner) {
          const error = new Error('runtime session is already bound to a different assistant request');
          error.code = 'ASSISTANT_RUN_BINDING_CONFLICT';
          throw error;
        }
        const current = clock();
        const events = [];
        if (request.status === 'started') {
          const progress = appendEvent(
            request,
            'ProgressUpdated',
            RUNTIME_ANALYSIS_PROGRESS,
            `runtime:${runtimeSessionId}:analyze`,
          );
          events.push(progress.event);
        }
        database.prepare(`
          UPDATE assistant_requests
          SET runtime_session_id = ?, updated_at = ?
          WHERE request_id = ?
            AND status IN ('queued', 'started')
            AND runtime_session_id IS NULL
        `).run(runtimeSessionId, current, requestId);
        return {
          request: toRequest(selectRequest.get(requestId)),
          events,
          replayed: false,
        };
      }

      case 'BindTurn': {
        const requestId = requireIdentifier(command.requestId, 'requestId');
        const runtimeSessionId = requireIdentifier(command.runtimeSessionId, 'runtimeSessionId');
        const admission = selectActiveRuntimeTurnAdmission.get();
        if (
          admission
          && (
            admission.status !== 'started'
            || admission.runtime_session_id !== runtimeSessionId
            || admission.request_id !== requestId
          )
        ) {
          const error = new Error('assistant request does not own the active runtime admission');
          error.code = 'ASSISTANT_ADMISSION_OWNERSHIP_CONFLICT';
          throw error;
        }
        if (admission?.binding_mode === 'rejected') {
          const error = new Error('active runtime admission has already rejected request binding');
          error.code = 'ASSISTANT_ADMISSION_BINDING_REJECTED';
          throw error;
        }
        const request = selectRequest.get(requestId);
        if (!request) throw new Error(`assistant request not found: ${requestId}`);
        if (!['queued', 'started'].includes(request.status)) {
          const error = new Error(`cannot bind a terminal assistant request (${request.status})`);
          error.code = 'ASSISTANT_RUN_BINDING_TERMINAL';
          throw error;
        }
        if (request.runtime_session_id === runtimeSessionId) {
          if (admission) {
            const current = clock();
            database.prepare(`
              UPDATE runtime_turn_admissions
              SET binding_mode = 'bound', binding_reason = NULL,
                  updated_at = ?, lifecycle_version = lifecycle_version + 1
              WHERE id = ? AND status = 'started'
            `).run(current, admission.id);
          }
          return { request: toRequest(request), events: [], replayed: true };
        }
        if (request.runtime_session_id !== null) {
          const error = new Error('assistant request is already bound to a different runtime session');
          error.code = 'ASSISTANT_RUN_BINDING_CONFLICT';
          throw error;
        }

        const sessionOwner = database.prepare(`
          SELECT request_id
          FROM assistant_requests
          WHERE runtime_session_id = ?
            AND status IN ('queued', 'started')
            AND request_id <> ?
          ORDER BY updated_at DESC, accepted_at DESC
          LIMIT 1
        `).get(runtimeSessionId, requestId);
        if (sessionOwner) {
          executeTransaction({
            type: 'FailRun',
            requestId: sessionOwner.request_id,
            code: 'RUN_SUPERSEDED_BY_EXPLICIT_TURN',
            retryable: true,
          });
        }

        const current = clock();
        const events = [];
        if (request.status === 'started') {
          const progress = appendEvent(
            request,
            'ProgressUpdated',
            RUNTIME_ANALYSIS_PROGRESS,
            `runtime:${runtimeSessionId}:analyze`,
          );
          events.push(progress.event);
        }
        database.prepare(`
          UPDATE assistant_requests
          SET runtime_session_id = ?, updated_at = ?
          WHERE request_id = ?
            AND status IN ('queued', 'started')
            AND runtime_session_id IS NULL
        `).run(runtimeSessionId, current, requestId);
        if (admission) {
          database.prepare(`
            UPDATE runtime_turn_admissions
            SET binding_mode = 'bound', binding_reason = NULL,
                updated_at = ?, lifecycle_version = lifecycle_version + 1
            WHERE id = ? AND status = 'started'
          `).run(current, admission.id);
        }
        return {
          request: toRequest(selectRequest.get(requestId)),
          events,
          replayed: false,
        };
      }

      case 'BeginNextRun':
      case 'BindNextRun': {
        const runtimeSessionId = requireIdentifier(command.runtimeSessionId, 'runtimeSessionId');
        const admission = selectActiveRuntimeTurnAdmission.get();
        if (admission) {
          if (
            admission.status !== 'started'
            || admission.runtime_session_id !== runtimeSessionId
          ) {
            const error = new Error('runtime session does not own the active admission');
            error.code = 'ASSISTANT_ADMISSION_OWNERSHIP_CONFLICT';
            throw error;
          }
          if (admission.request_id === null) {
            return {
              request: null,
              events: [],
              replayed: false,
              unownedAdmission: true,
            };
          }
          if (command.type === 'BeginNextRun') {
            return {
              request: null,
              events: [],
              replayed: false,
              conflict: true,
            };
          }
          return executeTransaction({
            type: 'BindTurn',
            requestId: admission.request_id,
            runtimeSessionId,
          });
        }
        const existing = database.prepare(`
          SELECT request_id, conversation_id, route_channel, route_endpoint, source_id,
                 status, runtime_session_id, next_sequence, output_text,
                 accepted_at, updated_at, terminal_at
          FROM assistant_requests
          WHERE runtime_session_id = ? AND status IN ('queued', 'started')
          ORDER BY updated_at DESC, accepted_at DESC
          LIMIT 1
        `).get(runtimeSessionId);
        if (existing) {
          if (command.type === 'BeginNextRun') {
            return {
              request: null,
              events: [],
              replayed: false,
              conflict: true,
            };
          }
          return { request: toRequest(existing), events: [], replayed: true };
        }
        const candidates = database.prepare(`
          SELECT request_id, conversation_id, route_channel, route_endpoint, source_id,
                 status, runtime_session_id, next_sequence, output_text,
                 accepted_at, updated_at, terminal_at
          FROM assistant_requests
          WHERE status = 'started' AND runtime_session_id IS NULL
          ORDER BY accepted_at ASC, request_id ASC
          LIMIT 2
        `).all();
        if (candidates.length !== 1) {
          return {
            request: null,
            events: [],
            replayed: false,
            ambiguous: candidates.length > 1,
          };
        }
        const [request] = candidates;
        const current = clock();
        const progress = appendEvent(
          request,
          'ProgressUpdated',
          RUNTIME_ANALYSIS_PROGRESS,
          `runtime:${runtimeSessionId}:analyze`,
        );
        database.prepare(`
          UPDATE assistant_requests
          SET runtime_session_id = ?, updated_at = ?
          WHERE request_id = ? AND status = 'started' AND runtime_session_id IS NULL
        `).run(runtimeSessionId, current, request.request_id);
        return {
          request: toRequest(selectRequest.get(request.request_id)),
          events: [progress.event],
          replayed: false,
        };
      }

      case 'ReportProgress': {
        const runtimeSessionId = requireIdentifier(command.runtimeSessionId, 'runtimeSessionId');
        const stage = requireText(command.stage, 'stage', 32);
        if (!PROGRESS_STAGE_SET.has(stage)) {
          throw new TypeError('stage is not a safe public progress stage');
        }
        const idempotencyKey = requireText(command.idempotencyKey, 'idempotencyKey');
        const request = database.prepare(`
          SELECT request_id, conversation_id, route_channel, route_endpoint, source_id,
                 status, runtime_session_id, next_sequence, output_text,
                 accepted_at, updated_at, terminal_at
          FROM assistant_requests
          WHERE runtime_session_id = ? AND status = 'started'
          ORDER BY updated_at DESC, accepted_at DESC
          LIMIT 1
        `).get(runtimeSessionId);
        if (!request) return { request: null, events: [], replayed: false };
        const emitted = appendEvent(request, 'ProgressUpdated', { stage }, idempotencyKey);
        return {
          request: toRequest(selectRequest.get(request.request_id)),
          events: [emitted.event],
          replayed: emitted.replayed,
        };
      }

      case 'ReportToolProgress': {
        const runtimeSessionId = requireIdentifier(command.runtimeSessionId, 'runtimeSessionId');
        const progress = publicProgressForRuntimeTool({
          toolName: command.toolName,
          status: command.status,
        });
        const idempotencyKey = requireText(command.idempotencyKey, 'idempotencyKey');
        const request = database.prepare(`
          SELECT request_id, conversation_id, route_channel, route_endpoint, source_id,
                 status, runtime_session_id, next_sequence, output_text,
                 accepted_at, updated_at, terminal_at
          FROM assistant_requests
          WHERE runtime_session_id = ? AND status = 'started'
          ORDER BY updated_at DESC, accepted_at DESC
          LIMIT 1
        `).get(runtimeSessionId);
        if (!request) return { request: null, events: [], replayed: false };
        const scope = runtimeMutationScope(command, idempotencyKey);
        if (scope) {
          const ownership = verifyRuntimeMutationOwnership({
            requestId: request.request_id,
            ...scope,
          });
          if (!ownership.verified) {
            return {
              request: toRequest(request),
              events: [],
              replayed: false,
              reason: ownership.reason,
            };
          }
        }
        const emitted = appendEvent(request, 'ProgressUpdated', progress, idempotencyKey);
        if (command.status === 'started' && !emitted.replayed) {
          if (scope) {
            recordRecoveryActivity({
              requestId: request.request_id,
              ...scope,
              reason: 'SUBSEQUENT_TOOL_ACTIVITY',
            });
          } else {
            closeActiveFinalOutputCandidate(
              request.request_id,
              'invalidated',
              'SUBSEQUENT_TOOL_ACTIVITY',
            );
          }
        }
        return {
          request: toRequest(selectRequest.get(request.request_id)),
          events: [emitted.event],
          replayed: emitted.replayed,
        };
      }

      case 'ReportRequestToolProgress': {
        const requestId = requireIdentifier(command.requestId, 'requestId');
        const progress = publicProgressForRuntimeTool({
          toolName: command.toolName,
          status: command.status,
        });
        const idempotencyKey = requireText(command.idempotencyKey, 'idempotencyKey');
        const request = selectRequest.get(requestId);
        if (!request || request.status !== 'started') {
          return { request: request ? toRequest(request) : null, events: [], replayed: false };
        }
        const scope = runtimeMutationScope(command, idempotencyKey);
        if (scope) {
          const ownership = verifyRuntimeMutationOwnership({ requestId, ...scope });
          if (!ownership.verified) {
            return {
              request: toRequest(request),
              events: [],
              replayed: false,
              reason: ownership.reason,
            };
          }
        }
        const emitted = appendEvent(request, 'ProgressUpdated', progress, idempotencyKey);
        if (command.status === 'started' && !emitted.replayed) {
          if (scope) {
            recordRecoveryActivity({
              requestId: request.request_id,
              ...scope,
              reason: 'SUBSEQUENT_TOOL_ACTIVITY',
            });
          } else {
            closeActiveFinalOutputCandidate(
              request.request_id,
              'invalidated',
              'SUBSEQUENT_TOOL_ACTIVITY',
            );
          }
        }
        return {
          request: toRequest(selectRequest.get(request.request_id)),
          events: [emitted.event],
          replayed: emitted.replayed,
        };
      }

      case 'AppendPublicReasoningDelta': {
        const requestId = requireIdentifier(command.requestId, 'requestId');
        const idempotencyKey = requireText(command.idempotencyKey, 'idempotencyKey');
        const delta = boundedUtf8(command.delta, 'delta', MAX_DELTA_BYTES);
        if (delta.length === 0) throw new TypeError('delta must not be empty');
        const request = selectRequest.get(requestId);
        if (!request) throw new Error(`assistant request not found: ${requestId}`);
        if (request.status !== 'started') {
          throw new Error(`cannot append public reasoning while assistant request is ${request.status}`);
        }
        const scope = runtimeMutationScope(command, idempotencyKey);
        if (scope) {
          const ownership = verifyRuntimeMutationOwnership({ requestId, ...scope });
          if (!ownership.verified) {
            return {
              request: toRequest(request),
              events: [],
              replayed: false,
              reason: ownership.reason,
            };
          }
        }
        const existing = selectEventByKey.get(requestId, idempotencyKey);
        if (existing) {
          const persisted = toEvent(existing);
          if (persisted.type !== 'PublicReasoningDelta' || persisted.payload.delta !== delta) {
            const error = new Error('public reasoning idempotency key belongs to different payload');
            error.code = 'ASSISTANT_EVENT_CONFLICT';
            throw error;
          }
          return { request: toRequest(request), events: [persisted], replayed: true };
        }
        const emitted = appendEvent(
          request,
          'PublicReasoningDelta',
          { delta },
          idempotencyKey,
        );
        if (scope) {
          recordRecoveryActivity({
            requestId,
            ...scope,
            reason: 'MESSAGE_DISPLAY_CONTINUED',
          });
        }
        return {
          request: toRequest(selectRequest.get(requestId)),
          events: [emitted.event],
          replayed: false,
        };
      }

      case 'AppendRuntimePublicReasoningDelta': {
        const runtimeSessionId = requireIdentifier(command.runtimeSessionId, 'runtimeSessionId');
        const request = database.prepare(`
          SELECT request_id
          FROM assistant_requests
          WHERE runtime_session_id = ? AND status = 'started'
          ORDER BY updated_at DESC, accepted_at DESC
          LIMIT 1
        `).get(runtimeSessionId);
        if (!request) return { request: null, events: [], replayed: false };
        return executeTransaction({
          type: 'AppendPublicReasoningDelta',
          requestId: request.request_id,
          delta: command.delta,
          idempotencyKey: command.idempotencyKey,
        });
      }

      case 'AppendOutputDelta': {
        const requestId = requireIdentifier(command.requestId, 'requestId');
        const idempotencyKey = requireText(command.idempotencyKey, 'idempotencyKey');
        const delta = boundedUtf8(command.delta, 'delta', MAX_DELTA_BYTES);
        if (delta.length === 0) throw new TypeError('delta must not be empty');
        let request = selectRequest.get(requestId);
        if (!request) throw new Error(`assistant request not found: ${requestId}`);
        if (request.status !== 'started') {
          throw new Error(`cannot append output while assistant request is ${request.status}`);
        }
        const scope = runtimeMutationScope(command, idempotencyKey);
        if (scope) {
          const ownership = verifyRuntimeMutationOwnership({ requestId, ...scope });
          if (!ownership.verified) {
            return {
              request: toRequest(request),
              events: [],
              replayed: false,
              reason: ownership.reason,
            };
          }
        }
        const existing = selectEventByKey.get(requestId, idempotencyKey);
        if (existing) {
          const persisted = toEvent(existing);
          if (persisted.type !== 'OutputDelta' || persisted.payload.delta !== delta) {
            const error = new Error('output delta idempotency key belongs to different payload');
            error.code = 'ASSISTANT_EVENT_CONFLICT';
            throw error;
          }
          return { request: toRequest(request), events: [persisted], replayed: true };
        }
        const output = request.output_text + delta;
        boundedUtf8(output, 'accumulated output', MAX_OUTPUT_BYTES);
        const emitted = appendEvent(request, 'OutputDelta', { delta }, idempotencyKey);
        database.prepare(`
          UPDATE assistant_requests SET output_text = ?, updated_at = ? WHERE request_id = ?
        `).run(output, clock(), requestId);
        if (scope) {
          recordRecoveryActivity({
            requestId,
            ...scope,
            reason: 'OUTPUT_EXTENDED_AFTER_FINAL',
          });
        } else {
          closeActiveFinalOutputCandidate(
            requestId,
            'invalidated',
            'OUTPUT_EXTENDED_AFTER_FINAL',
          );
        }
        return {
          request: toRequest(selectRequest.get(requestId)),
          events: [emitted.event],
          replayed: false,
        };
      }

      case 'AppendRuntimeOutputDelta': {
        const runtimeSessionId = requireIdentifier(command.runtimeSessionId, 'runtimeSessionId');
        const request = database.prepare(`
          SELECT request_id
          FROM assistant_requests
          WHERE runtime_session_id = ? AND status = 'started'
          ORDER BY updated_at DESC, accepted_at DESC
          LIMIT 1
        `).get(runtimeSessionId);
        if (!request) return { request: null, events: [], replayed: false };
        return executeTransaction({
          type: 'AppendOutputDelta',
          requestId: request.request_id,
          delta: command.delta,
          idempotencyKey: command.idempotencyKey,
        });
      }

      case 'MarkFinalOutputCandidate': {
        const requestId = requireIdentifier(command.requestId, 'requestId');
        const runtimeSessionId = requireIdentifier(command.runtimeSessionId, 'runtimeSessionId');
        const messageId = requireText(command.messageId, 'messageId');
        const observedAtMs = requireInteger(command.observedAtMs, 'observedAtMs', { minimum: 0 });
        const activityId = requireText(command.activityId ?? messageId, 'activityId');
        const request = selectRequest.get(requestId);
        if (!request) throw new Error(`assistant request not found: ${requestId}`);
        if (request.status !== 'started') {
          return { marked: false, reason: 'request_not_started', candidate: null };
        }
        if (request.runtime_session_id !== runtimeSessionId) {
          return { marked: false, reason: 'runtime_session_conflict', candidate: null };
        }
        const ownership = verifyRuntimeMutationOwnership({
          requestId,
          runtimeSessionId,
          observedAtMs,
        });
        if (!ownership.verified) {
          return { marked: false, reason: ownership.reason, candidate: null };
        }
        const admission = ownership.row;
        const hash = outputHash(request.output_text);
        const exact = selectExactFinalOutputCandidate.get(requestId, admission.id, messageId);
        if (exact) {
          const exactReplay = (
            exact.runtime_session_id === runtimeSessionId
            && exact.activity_id === activityId
            && exact.output_hash === hash
            && exact.observed_at_ms === observedAtMs
          );
          return {
            marked: exactReplay && exact.status === 'active',
            replayed: true,
            reason: exactReplay ? null : 'candidate_event_conflict',
            candidate: toFinalOutputCandidate(exact),
          };
        }
        const causallyStale = (
          admission.recovery_activity_observed_at_ms !== null
          && (
            observedAtMs < admission.recovery_activity_observed_at_ms
            || (
              observedAtMs === admission.recovery_activity_observed_at_ms
              && activityId !== admission.recovery_activity_id
            )
          )
        );
        recordRecoveryActivity({
          requestId,
          runtimeSessionId,
          observedAtMs,
          activityId,
          reason: 'MESSAGE_DISPLAY_CONTINUED',
        });
        if (!request.output_text.trim()) {
          return { marked: false, reason: 'empty_output', candidate: null };
        }
        closeActiveFinalOutputCandidate(requestId, 'invalidated', 'SUPERSEDED_FINAL_OUTPUT');
        const current = clock();
        const status = causallyStale ? 'invalidated' : 'active';
        const terminalReason = causallyStale ? 'RECOVERY_ACTIVITY_AFTER_OUTPUT' : null;
        const inserted = database.prepare(`
          INSERT INTO assistant_final_output_candidates (
            request_id, admission_id, runtime_session_id, message_id,
            activity_id, output_hash, observed_at_ms, status,
            created_at, updated_at, terminal_reason
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          requestId,
          admission.id,
          runtimeSessionId,
          messageId,
          activityId,
          hash,
          observedAtMs,
          status,
          current,
          current,
          terminalReason,
        );
        return {
          marked: status === 'active',
          replayed: false,
          reason: terminalReason,
          candidate: toFinalOutputCandidate(database.prepare(`
            SELECT id, request_id, admission_id, runtime_session_id, message_id,
                   activity_id, output_hash, observed_at_ms, status,
                   created_at, updated_at, terminal_reason
            FROM assistant_final_output_candidates
            WHERE id = ?
          `).get(Number(inserted.lastInsertRowid))),
        };
      }

      case 'InvalidateFinalOutputCandidate': {
        const requestId = requireIdentifier(command.requestId, 'requestId');
        const runtimeSessionId = requireIdentifier(command.runtimeSessionId, 'runtimeSessionId');
        const reason = safeErrorCode(command.reason);
        const existing = selectActiveFinalOutputCandidate.get(requestId);
        if (!existing) return { invalidated: false, candidate: null };
        if (existing.runtime_session_id !== runtimeSessionId) {
          return {
            invalidated: false,
            reason: 'runtime_session_conflict',
            candidate: toFinalOutputCandidate(existing),
          };
        }
        closeActiveFinalOutputCandidate(requestId, 'invalidated', reason);
        return {
          invalidated: true,
          candidate: toFinalOutputCandidate(database.prepare(`
            SELECT id, request_id, admission_id, runtime_session_id, message_id,
                   activity_id, output_hash, observed_at_ms, status,
                   created_at, updated_at, terminal_reason
            FROM assistant_final_output_candidates
            WHERE id = ?
          `).get(existing.id)),
        };
      }

      case 'CompleteRun': {
        const requestId = requireIdentifier(command.requestId, 'requestId');
        const output = boundedUtf8(command.output, 'output', MAX_OUTPUT_BYTES);
        let request = selectRequest.get(requestId);
        if (!request) throw new Error(`assistant request not found: ${requestId}`);
        if (request.status === 'completed') {
          if (request.output_text !== output) {
            const error = new Error('completed assistant request has different output');
            error.code = 'ASSISTANT_EVENT_CONFLICT';
            throw error;
          }
          const event = selectEvents.all(requestId).map(toEvent).find(item => item.type === 'RunCompleted');
          return { request: toRequest(request), events: event ? [event] : [], replayed: true };
        }
        if (request.status === 'failed') {
          throw new Error('cannot complete a failed assistant request');
        }
        const emitted = [];
        if (request.status === 'queued') {
          const started = appendEvent(request, 'RunStarted', {});
          emitted.push(started.event);
        }
        const completed = appendEvent(request, 'RunCompleted', { output });
        emitted.push(completed.event);
        const current = clock();
        database.prepare(`
          UPDATE assistant_requests
          SET status = 'completed', output_text = ?, updated_at = ?, terminal_at = ?
          WHERE request_id = ? AND status IN ('queued', 'started')
        `).run(output, current, current, requestId);
        closeActiveFinalOutputCandidate(
          requestId,
          'consumed',
          'CANONICAL_RUN_COMPLETED',
        );
        recordTerminalOutbound(request, {
          content: output,
          status: 'delivered',
          deliveryAction: 'assistant-response',
        });
        return {
          request: toRequest(selectRequest.get(requestId)),
          events: emitted,
          replayed: false,
        };
      }

      case 'CompleteRuntimeRun': {
        const runtimeSessionId = requireIdentifier(command.runtimeSessionId, 'runtimeSessionId');
        const request = database.prepare(`
          SELECT request_id
          FROM assistant_requests
          WHERE runtime_session_id = ? AND status = 'started'
          ORDER BY updated_at DESC, accepted_at DESC
          LIMIT 1
        `).get(runtimeSessionId);
        if (!request) return { request: null, events: [], replayed: false };
        return executeTransaction({
          type: 'CompleteRun',
          requestId: request.request_id,
          output: command.output,
        });
      }

      case 'FailRun': {
        const code = safeErrorCode(command.code);
        if (typeof command.retryable !== 'boolean') {
          throw new TypeError('retryable must be a boolean');
        }
        const retryable = command.retryable;
        let request = null;
        if (command.requestId) {
          request = selectRequest.get(requireIdentifier(command.requestId, 'requestId'));
        } else if (command.runtimeSessionId) {
          const runtimeSessionId = requireIdentifier(command.runtimeSessionId, 'runtimeSessionId');
          request = database.prepare(`
            SELECT request_id, conversation_id, route_channel, route_endpoint, source_id,
                   status, runtime_session_id, next_sequence, output_text,
                   accepted_at, updated_at, terminal_at
            FROM assistant_requests
            WHERE runtime_session_id = ? AND status = 'started'
            ORDER BY updated_at DESC, accepted_at DESC
            LIMIT 1
          `).get(runtimeSessionId);
        } else {
          throw new TypeError('FailRun requires requestId or runtimeSessionId');
        }
        if (!request) return { request: null, events: [], replayed: false };
        if (TERMINAL_STATUSES.has(request.status)) {
          const type = request.status === 'completed' ? 'RunCompleted' : 'RunFailed';
          const event = selectEvents.all(request.request_id).map(toEvent).find(item => item.type === type);
          return { request: toRequest(request), events: event ? [event] : [], replayed: true };
        }
        const failed = appendEvent(request, 'RunFailed', { code, retryable });
        const current = clock();
        database.prepare(`
          UPDATE assistant_requests
          SET status = 'failed', updated_at = ?, terminal_at = ?
          WHERE request_id = ? AND status IN ('queued', 'started')
        `).run(current, current, request.request_id);
        closeActiveFinalOutputCandidate(
          request.request_id,
          'invalidated',
          code,
        );
        recordTerminalOutbound(request, {
          content: '',
          status: 'failed',
          deliveryAction: `assistant-response-failed:${code}`,
        });
        return {
          request: toRequest(selectRequest.get(request.request_id)),
          events: [failed.event],
          replayed: false,
        };
      }

      case 'ExpireStaleRuns': {
        const staleBefore = requireInteger(command.staleBefore, 'staleBefore');
        // A started runtime turn has an independent heartbeat. Do not let a
        // quiet assistant request expire while its bound runtime is still
        // alive; queued work has no such heartbeat and keeps the request clock.
        const stale = database.prepare(`
          SELECT r.request_id
          FROM assistant_requests AS r
          LEFT JOIN runtime_turn_admissions AS a
            ON a.request_id = r.request_id
            AND a.runtime_session_id = r.runtime_session_id
            AND a.status = 'started'
          WHERE r.status IN ('queued', 'started')
            AND (
              CASE
                WHEN r.status = 'started' AND a.id IS NOT NULL
                  THEN MAX(r.updated_at, a.updated_at)
                ELSE r.updated_at
              END
            ) <= ?
          ORDER BY r.updated_at ASC, r.request_id ASC
        `).all(staleBefore);
        const events = [];
        for (const row of stale) {
          const result = executeTransaction({
            type: 'FailRun',
            requestId: row.request_id,
            code: 'RUN_STALE_AFTER_RESTART',
            retryable: true,
          });
          events.push(...result.events);
        }
        return { request: null, events, replayed: false };
      }

      default:
        throw new TypeError(`unsupported assistant response command: ${command.type}`);
    }
  });

  const acquireRuntimeTurnTransaction = database.transaction(({
    conversationId,
    requestId = null,
    routeChannel,
  }) => {
    const safeConversationId = requireInteger(conversationId, 'conversationId', { minimum: 1 });
    const safeRequestId = requestId === null ? null : requireIdentifier(requestId, 'requestId');
    const safeRouteChannel = requireText(routeChannel, 'routeChannel');
    const current = clock();
    const currentObservedAtMs = requireInteger(
      observationClock(),
      'observationClock result',
      { minimum: 0 },
    );
    const active = selectActiveRuntimeTurnAdmission.get();
    if (active) {
      if (
        active.status !== 'submitted'
        || active.updated_at > current - runtimeTurnSubmittedStaleSeconds
      ) {
        return { acquired: false, admission: toRuntimeTurnAdmission(active) };
      }
      database.prepare(`
        UPDATE runtime_turn_admissions
        SET status = 'released', terminal_at = ?, updated_at = ?,
            terminal_reason = 'stale_before_reacquire'
        WHERE id = ? AND status = 'submitted'
      `).run(current, current, active.id);
    }

    const inserted = database.prepare(`
      INSERT INTO runtime_turn_admissions (
        singleton_key, conversation_id, request_id, route_channel, status,
        runtime_session_id, acquired_at, started_at, terminal_at, updated_at,
        lifecycle_version, lifecycle_observed_at_ms, terminal_reason
      ) VALUES (1, ?, ?, ?, 'submitted', NULL, ?, NULL, NULL, ?, 0, ?, NULL)
    `).run(
      safeConversationId,
      safeRequestId,
      safeRouteChannel,
      current,
      current,
      currentObservedAtMs,
    );
    return {
      acquired: true,
      recoveredAdmission: active
        ? toRuntimeTurnAdmission(selectRuntimeTurnAdmissionById.get(active.id))
        : null,
      admission: toRuntimeTurnAdmission(
        selectRuntimeTurnAdmissionById.get(Number(inserted.lastInsertRowid)),
      ),
    };
  });

  const startRuntimeTurnTransaction = database.transaction(({
    runtimeSessionId,
    observedAtMs = null,
  }) => {
    const safeRuntimeSessionId = requireIdentifier(runtimeSessionId, 'runtimeSessionId');
    const safeObservedAtMs = observedAtMs === null
      ? null
      : requireInteger(observedAtMs, 'observedAtMs', { minimum: 0 });
    const active = selectActiveRuntimeTurnAdmission.get();
    if (!active) return { started: false, admission: null, reason: 'no_active_admission' };
    if (
      safeObservedAtMs !== null
      && active.lifecycle_observed_at_ms !== null
      && safeObservedAtMs < active.lifecycle_observed_at_ms
    ) {
      return {
        started: false,
        admission: toRuntimeTurnAdmission(active),
        reason: 'runtime_turn_observation_stale',
      };
    }
    if (active.status === 'started') {
      if (active.runtime_session_id === safeRuntimeSessionId) {
        const current = clock();
        // lifecycle_observed_at_ms is the immutable start fence for this
        // admission. Same-turn hook processes may persist out of timestamp
        // order, so activity must advance only the recovery generation.
        database.prepare(`
          UPDATE runtime_turn_admissions
          SET updated_at = ?, lifecycle_version = lifecycle_version + 1
          WHERE id = ? AND status = 'started' AND runtime_session_id = ?
        `).run(current, active.id, safeRuntimeSessionId);
        return {
          started: true,
          admission: toRuntimeTurnAdmission(selectRuntimeTurnAdmissionById.get(active.id)),
          replayed: true,
        };
      }
      return {
        started: false,
        admission: toRuntimeTurnAdmission(active),
        reason: 'runtime_session_conflict',
      };
    }

    const current = clock();
    database.prepare(`
      UPDATE runtime_turn_admissions
      SET status = 'started', runtime_session_id = ?, started_at = ?, updated_at = ?,
          lifecycle_version = lifecycle_version + 1,
          lifecycle_observed_at_ms = COALESCE(?, lifecycle_observed_at_ms)
      WHERE id = ? AND status = 'submitted'
    `).run(safeRuntimeSessionId, current, current, safeObservedAtMs, active.id);
    return {
      started: true,
      admission: toRuntimeTurnAdmission(selectRuntimeTurnAdmissionById.get(active.id)),
      replayed: false,
    };
  });

  const touchRuntimeTurnTransaction = database.transaction(({
    runtimeSessionId,
    observedAtMs = null,
  }) => {
    const safeRuntimeSessionId = requireIdentifier(runtimeSessionId, 'runtimeSessionId');
    const safeObservedAtMs = observedAtMs === null
      ? null
      : requireInteger(observedAtMs, 'observedAtMs', { minimum: 0 });
    const active = selectActiveRuntimeTurnAdmission.get();
    if (!active) return { touched: false, admission: null, reason: 'no_active_admission' };
    if (active.status !== 'started') {
      return {
        touched: false,
        admission: toRuntimeTurnAdmission(active),
        reason: 'runtime_turn_not_started',
      };
    }
    if (active.runtime_session_id !== safeRuntimeSessionId) {
      return {
        touched: false,
        admission: toRuntimeTurnAdmission(active),
        reason: 'runtime_session_conflict',
      };
    }
    if (
      safeObservedAtMs !== null
      && active.lifecycle_observed_at_ms !== null
      && safeObservedAtMs < active.lifecycle_observed_at_ms
    ) {
      return {
        touched: false,
        admission: toRuntimeTurnAdmission(active),
        reason: 'runtime_turn_observation_stale',
      };
    }

    const current = clock();
    // Keep the turn-start observation fence stable. A later MessageDisplay or
    // async tool hook must not make the logically terminal Stop look stale.
    database.prepare(`
      UPDATE runtime_turn_admissions
      SET updated_at = ?, lifecycle_version = lifecycle_version + 1
      WHERE id = ? AND status = 'started' AND runtime_session_id = ?
    `).run(current, active.id, safeRuntimeSessionId);
    return {
      touched: true,
      admission: toRuntimeTurnAdmission(selectRuntimeTurnAdmissionById.get(active.id)),
    };
  });

  const rejectRuntimeTurnBindingTransaction = database.transaction(({
    runtimeSessionId,
    reason,
    observedAtMs = null,
  }) => {
    const safeRuntimeSessionId = requireIdentifier(runtimeSessionId, 'runtimeSessionId');
    const safeReason = requireText(reason, 'reason', 64);
    const safeObservedAtMs = observedAtMs === null
      ? null
      : requireInteger(observedAtMs, 'observedAtMs', { minimum: 0 });
    const active = selectActiveRuntimeTurnAdmission.get();
    if (!active || active.status !== 'started') {
      return {
        rejected: false,
        admission: toRuntimeTurnAdmission(active),
        reason: 'runtime_turn_not_started',
      };
    }
    if (active.runtime_session_id !== safeRuntimeSessionId) {
      return {
        rejected: false,
        admission: toRuntimeTurnAdmission(active),
        reason: 'runtime_session_conflict',
      };
    }
    if (
      safeObservedAtMs !== null
      && active.lifecycle_observed_at_ms !== null
      && safeObservedAtMs < active.lifecycle_observed_at_ms
    ) {
      return {
        rejected: false,
        admission: toRuntimeTurnAdmission(active),
        reason: 'runtime_turn_observation_stale',
      };
    }
    if (active.binding_mode === 'bound') {
      return {
        rejected: false,
        admission: toRuntimeTurnAdmission(active),
        reason: 'runtime_turn_already_bound',
      };
    }
    if (active.binding_mode === 'rejected') {
      return {
        rejected: true,
        replayed: true,
        admission: toRuntimeTurnAdmission(active),
        reason: active.binding_reason === safeReason
          ? null
          : 'runtime_turn_binding_already_rejected',
      };
    }
    database.prepare(`
      UPDATE runtime_turn_admissions
      SET binding_mode = 'rejected', binding_reason = ?,
          updated_at = ?, lifecycle_version = lifecycle_version + 1
      WHERE id = ? AND status = 'started'
    `).run(safeReason, clock(), active.id);
    return {
      rejected: true,
      admission: toRuntimeTurnAdmission(selectRuntimeTurnAdmissionById.get(active.id)),
    };
  });

  const finishRuntimeTurnTransaction = database.transaction(({
    runtimeSessionId,
    reason = 'stop',
    observedAtMs = null,
    requestId = null,
    output = null,
    failureCode = null,
    retryable = null,
  }) => {
    const safeRuntimeSessionId = requireIdentifier(runtimeSessionId, 'runtimeSessionId');
    const safeReason = requireText(reason, 'reason', 64);
    const safeObservedAtMs = observedAtMs === null
      ? null
      : requireInteger(observedAtMs, 'observedAtMs', { minimum: 0 });
    const safeRequestId = requestId === null
      ? null
      : requireIdentifier(requestId, 'requestId');
    const hasFinalization = output !== null || failureCode !== null || retryable !== null;
    if (hasFinalization && (output === null) === (failureCode === null)) {
      throw new TypeError('runtime turn finalization requires exactly one of output or failureCode');
    }
    const safeOutput = output === null
      ? null
      : boundedUtf8(output, 'output', MAX_OUTPUT_BYTES);
    const safeFailureCode = failureCode === null ? null : safeErrorCode(failureCode);
    if (safeFailureCode !== null && typeof retryable !== 'boolean') {
      throw new TypeError('retryable must be a boolean for failed runtime finalization');
    }
    const active = selectActiveRuntimeTurnAdmission.get();
    if (!active) return { finished: false, admission: null, reason: 'no_active_admission' };
    if (active.status !== 'started') {
      return {
        finished: false,
        admission: toRuntimeTurnAdmission(active),
        reason: 'runtime_turn_not_started',
      };
    }
    if (
      active.runtime_session_id !== null
      && active.runtime_session_id !== safeRuntimeSessionId
    ) {
      return {
        finished: false,
        admission: toRuntimeTurnAdmission(active),
        reason: 'runtime_session_conflict',
      };
    }
    if (
      safeObservedAtMs !== null
      && active.lifecycle_observed_at_ms !== null
      && safeObservedAtMs < active.lifecycle_observed_at_ms
    ) {
      return {
        finished: false,
        admission: toRuntimeTurnAdmission(active),
        reason: 'runtime_turn_observation_stale',
      };
    }

    if (safeRequestId !== null && active.request_id !== safeRequestId) {
      return {
        finished: false,
        admission: toRuntimeTurnAdmission(active),
        reason: 'runtime_request_conflict',
      };
    }

    const effectiveRequestId = active.request_id;
    let finalization = { request: null, events: [] };
    let finalizationDisposition = effectiveRequestId === null
      ? 'requestless_runtime_turn'
      : 'request_not_finalized';
    if (effectiveRequestId !== null) {
      const request = selectRequest.get(effectiveRequestId);
      if (
        !request
        || (
          active.binding_mode === 'bound'
          && request.runtime_session_id !== safeRuntimeSessionId
        )
      ) {
        return {
          finished: false,
          admission: toRuntimeTurnAdmission(active),
          reason: 'runtime_request_conflict',
        };
      }
      const candidate = active.binding_mode === 'bound' && safeOutput === null
        ? validFinalOutputCandidate(request, active)
        : null;
      if (active.binding_mode === 'bound' && (safeOutput !== null || candidate)) {
        finalization = executeTransaction({
          type: 'CompleteRun',
          requestId: effectiveRequestId,
          output: safeOutput ?? request.output_text,
        });
        finalizationDisposition = candidate
          ? 'completed_from_final_output'
          : 'completed_from_stop';
      } else {
        const terminalCode = active.binding_mode !== 'bound'
          ? 'RUNTIME_TURN_BINDING_NOT_VERIFIED'
          : (hasFinalization ? safeFailureCode : 'RUNTIME_TURN_FINISHED_WITHOUT_RESPONSE');
        finalization = executeTransaction({
          type: 'FailRun',
          requestId: effectiveRequestId,
          code: terminalCode,
          retryable: hasFinalization && active.binding_mode === 'bound' ? retryable : true,
        });
        finalizationDisposition = active.binding_mode === 'bound'
          ? 'failed_from_stop'
          : 'failed_unverified_binding';
      }
    }

    const current = clock();
    const projectionObservedAtMs = safeObservedAtMs ?? requireInteger(
      observationClock(),
      'observationClock result',
      { minimum: 0 },
    );
    database.prepare(`
      UPDATE runtime_turn_admissions
      SET status = 'completed', runtime_session_id = COALESCE(runtime_session_id, ?),
          terminal_at = ?, updated_at = ?, lifecycle_version = lifecycle_version + 1,
          binding_mode = CASE WHEN request_id IS NULL THEN binding_mode ELSE 'closed' END,
          binding_reason = CASE WHEN request_id IS NULL THEN binding_reason ELSE ? END,
          binding_projection_pending = CASE WHEN request_id IS NULL THEN 0 ELSE 1 END,
          binding_projection_observed_at_ms = CASE
            WHEN request_id IS NULL THEN binding_projection_observed_at_ms ELSE ? END,
          terminal_reason = ?
      WHERE id = ? AND status = 'started'
    `).run(
      safeRuntimeSessionId,
      current,
      current,
      finalizationDisposition,
      projectionObservedAtMs,
      safeReason,
      active.id,
    );
    return {
      finished: true,
      disposition: finalizationDisposition,
      admission: toRuntimeTurnAdmission(selectRuntimeTurnAdmissionById.get(active.id)),
      request: finalization.request,
      events: finalization.events,
    };
  });

  const releaseRuntimeTurnTransaction = database.transaction(({
    conversationId,
    reason = 'delivery_not_submitted',
  }) => {
    const safeConversationId = requireInteger(conversationId, 'conversationId', { minimum: 1 });
    const safeReason = requireText(reason, 'reason', 64);
    const active = selectActiveRuntimeTurnAdmission.get();
    if (!active || active.conversation_id !== safeConversationId) {
      return { released: false, admission: toRuntimeTurnAdmission(active) };
    }
    if (active.status !== 'submitted') {
      return {
        released: false,
        admission: toRuntimeTurnAdmission(active),
        reason: 'runtime_turn_already_started',
      };
    }

    const current = clock();
    database.prepare(`
      UPDATE runtime_turn_admissions
      SET status = 'released', terminal_at = ?, updated_at = ?, terminal_reason = ?
      WHERE id = ? AND status = 'submitted'
    `).run(current, current, safeReason, active.id);
    return {
      released: true,
      admission: toRuntimeTurnAdmission(selectRuntimeTurnAdmissionById.get(active.id)),
    };
  });

  const recoverRuntimeTurnTransaction = database.transaction(({
    admissionId,
    expectedLifecycleVersion,
    reason = 'runtime_sustained_idle',
  }) => {
    const safeAdmissionId = requireInteger(admissionId, 'admissionId', { minimum: 1 });
    const safeLifecycleVersion = requireInteger(
      expectedLifecycleVersion,
      'expectedLifecycleVersion',
    );
    const safeReason = requireText(reason, 'reason', 64);
    const active = selectActiveRuntimeTurnAdmission.get();
    if (!active || active.id !== safeAdmissionId) {
      return { recovered: false, admission: toRuntimeTurnAdmission(active) };
    }
    if (active.status !== 'started') {
      return {
        recovered: false,
        admission: toRuntimeTurnAdmission(active),
        reason: 'runtime_turn_not_started',
      };
    }
    if (active.lifecycle_version !== safeLifecycleVersion) {
      return {
        recovered: false,
        admission: toRuntimeTurnAdmission(active),
        reason: 'runtime_turn_lifecycle_changed',
      };
    }

    const events = [];
    let disposition = active.request_id
      ? 'failed_without_final_output'
      : 'released_without_request';
    let admissionTerminalReason = safeReason;
    if (active.request_id) {
      const request = selectRequest.get(active.request_id);
      if (request && TERMINAL_STATUSES.has(request.status)) {
        disposition = `released_after_${request.status}_request`;
      }
      if (request && !TERMINAL_STATUSES.has(request.status)) {
        const candidate = active.binding_mode === 'bound'
          ? validFinalOutputCandidate(request, active)
          : null;
        const canCompleteFromFinalOutput = Boolean(candidate);
        if (canCompleteFromFinalOutput) {
          const completed = appendEvent(request, 'RunCompleted', {
            output: request.output_text,
          });
          const terminalAt = clock();
          database.prepare(`
            UPDATE assistant_requests
            SET status = 'completed', updated_at = ?, terminal_at = ?
            WHERE request_id = ? AND status IN ('queued', 'started')
          `).run(terminalAt, terminalAt, request.request_id);
          closeActiveFinalOutputCandidate(
            request.request_id,
            'consumed',
            'RUNTIME_IDLE_FINAL_OUTPUT_RECOVERY',
          );
          admissionTerminalReason = safeReason === 'runtime_sustained_idle'
            ? 'runtime_sustained_idle_final_output'
            : 'runtime_final_output_recovery';
          disposition = 'completed_from_final_output';
          events.push(completed.event);
        } else {
          const failed = appendEvent(request, 'RunFailed', {
            code: 'RUNTIME_TURN_RECOVERED_AFTER_IDLE',
            retryable: true,
          });
          const terminalAt = clock();
          database.prepare(`
            UPDATE assistant_requests
            SET status = 'failed', updated_at = ?, terminal_at = ?
            WHERE request_id = ? AND status IN ('queued', 'started')
          `).run(terminalAt, terminalAt, request.request_id);
          closeActiveFinalOutputCandidate(
            request.request_id,
            'invalidated',
            'RUNTIME_TURN_RECOVERED_AFTER_IDLE',
          );
          events.push(failed.event);
        }
      }
    }

    const current = clock();
    const projectionObservedAtMs = requireInteger(
      observationClock(),
      'observationClock result',
      { minimum: 0 },
    );
    database.prepare(`
      UPDATE runtime_turn_admissions
      SET status = 'released', terminal_at = ?, updated_at = ?, terminal_reason = ?,
          binding_mode = CASE WHEN request_id IS NULL THEN binding_mode ELSE 'closed' END,
          binding_reason = CASE WHEN request_id IS NULL THEN binding_reason ELSE ? END,
          binding_projection_pending = CASE WHEN request_id IS NULL THEN 0 ELSE 1 END,
          binding_projection_observed_at_ms = CASE
            WHEN request_id IS NULL THEN binding_projection_observed_at_ms ELSE ? END
      WHERE id = ? AND status = 'started'
    `).run(
      current,
      current,
      admissionTerminalReason,
      disposition,
      projectionObservedAtMs,
      active.id,
    );
    return {
      recovered: true,
      disposition,
      admission: toRuntimeTurnAdmission(selectRuntimeTurnAdmissionById.get(active.id)),
      request: active.request_id ? toRequest(selectRequest.get(active.request_id)) : null,
      events,
    };
  });

  const ackRuntimeTurnBindingProjectionTransaction = database.transaction(({
    admissionId,
  }) => {
    const safeAdmissionId = requireInteger(admissionId, 'admissionId', { minimum: 1 });
    const admission = selectRuntimeTurnAdmissionById.get(safeAdmissionId);
    if (!admission || admission.binding_projection_pending !== 1) {
      return {
        acknowledged: false,
        admission: toRuntimeTurnAdmission(admission),
      };
    }
    database.prepare(`
      UPDATE runtime_turn_admissions
      SET binding_projection_pending = 0, binding_projected_at = ?, updated_at = ?
      WHERE id = ? AND binding_projection_pending = 1 AND binding_mode = 'closed'
    `).run(clock(), clock(), safeAdmissionId);
    return {
      acknowledged: true,
      admission: toRuntimeTurnAdmission(selectRuntimeTurnAdmissionById.get(safeAdmissionId)),
    };
  });

  return Object.freeze({
    execute(input) {
      const command = requireRecord(input, 'assistant response command');
      const type = requireText(command.type, 'command.type', 64);
      const shapes = {
        AcceptAssistantRequest: [
          ['type', 'requestId', 'route', 'sourceId', 'conversation'],
          ['type', 'requestId', 'route', 'sourceId', 'conversation'],
        ],
        StartRun: [['type', 'requestId'], ['type', 'requestId']],
        BindRun: [
          ['type', 'requestId', 'runtimeSessionId'],
          ['type', 'requestId', 'runtimeSessionId'],
        ],
        BindTurn: [
          ['type', 'requestId', 'runtimeSessionId'],
          ['type', 'requestId', 'runtimeSessionId'],
        ],
        BeginNextRun: [['type', 'runtimeSessionId'], ['type', 'runtimeSessionId']],
        BindNextRun: [['type', 'runtimeSessionId'], ['type', 'runtimeSessionId']],
        ReportProgress: [
          ['type', 'runtimeSessionId', 'stage', 'idempotencyKey'],
          ['type', 'runtimeSessionId', 'stage', 'idempotencyKey'],
        ],
        ReportToolProgress: [
          [
            'type', 'runtimeSessionId', 'toolName', 'status', 'idempotencyKey',
            'observedAtMs', 'activityId',
          ],
          ['type', 'runtimeSessionId', 'toolName', 'status', 'idempotencyKey'],
        ],
        ReportRequestToolProgress: [
          [
            'type', 'requestId', 'runtimeSessionId', 'observedAtMs',
            'activityId', 'toolName', 'status', 'idempotencyKey',
          ],
          ['type', 'requestId', 'toolName', 'status', 'idempotencyKey'],
        ],
        AppendPublicReasoningDelta: [
          [
            'type', 'requestId', 'delta', 'idempotencyKey',
            'runtimeSessionId', 'observedAtMs', 'activityId',
          ],
          ['type', 'requestId', 'delta', 'idempotencyKey'],
        ],
        AppendRuntimePublicReasoningDelta: [
          ['type', 'runtimeSessionId', 'delta', 'idempotencyKey'],
          ['type', 'runtimeSessionId', 'delta', 'idempotencyKey'],
        ],
        AppendOutputDelta: [
          [
            'type', 'requestId', 'delta', 'idempotencyKey',
            'runtimeSessionId', 'observedAtMs', 'activityId',
          ],
          ['type', 'requestId', 'delta', 'idempotencyKey'],
        ],
        AppendRuntimeOutputDelta: [
          ['type', 'runtimeSessionId', 'delta', 'idempotencyKey'],
          ['type', 'runtimeSessionId', 'delta', 'idempotencyKey'],
        ],
        MarkFinalOutputCandidate: [
          [
            'type', 'requestId', 'runtimeSessionId', 'messageId',
            'observedAtMs', 'activityId',
          ],
          ['type', 'requestId', 'runtimeSessionId', 'messageId', 'observedAtMs'],
        ],
        InvalidateFinalOutputCandidate: [
          ['type', 'requestId', 'runtimeSessionId', 'reason'],
          ['type', 'requestId', 'runtimeSessionId', 'reason'],
        ],
        CompleteRun: [['type', 'requestId', 'output'], ['type', 'requestId', 'output']],
        CompleteRuntimeRun: [
          ['type', 'runtimeSessionId', 'output'],
          ['type', 'runtimeSessionId', 'output'],
        ],
        FailRun: [
          ['type', 'requestId', 'runtimeSessionId', 'code', 'retryable'],
          ['type', 'code', 'retryable'],
        ],
        ExpireStaleRuns: [['type', 'staleBefore'], ['type', 'staleBefore']],
      };
      const shape = shapes[type];
      if (!shape) throw new TypeError(`unsupported assistant response command: ${type}`);
      requireExactFields(command, shape[0], shape[1], 'assistant response command');
      return executeTransaction.immediate(command);
    },

    query({ requestId } = {}) {
      const id = requireIdentifier(requestId, 'requestId');
      const request = selectRequest.get(id);
      if (!request) return null;
      return {
        request: toRequest(request),
        events: selectEvents.all(id).map(toEvent),
      };
    },

    queryFinalOutputCandidates({ requestId } = {}) {
      const id = requireIdentifier(requestId, 'requestId');
      return selectFinalOutputCandidates.all(id).map(toFinalOutputCandidate);
    },

    queryPendingRuntimeTurnBindingProjections() {
      return selectPendingRuntimeTurnBindingProjections.all().map(toRuntimeTurnAdmission);
    },

    ackRuntimeTurnBindingProjection(input = {}) {
      return ackRuntimeTurnBindingProjectionTransaction.immediate(
        requireRecord(input, 'runtime turn binding projection acknowledgement'),
      );
    },

    findStartedRequest({ excludingRequestId = null } = {}) {
      const excluded = excludingRequestId === null
        ? null
        : requireIdentifier(excludingRequestId, 'excludingRequestId');
      const row = excluded === null
        ? selectFirstStartedRequest.get()
        : selectFirstStartedRequestExcluding.get(excluded);
      return toRequest(row);
    },

    acquireRuntimeTurn(input = {}) {
      return acquireRuntimeTurnTransaction.immediate(requireRecord(input, 'runtime turn admission'));
    },

    startRuntimeTurn(input = {}) {
      return startRuntimeTurnTransaction.immediate(requireRecord(input, 'runtime turn start'));
    },

    touchRuntimeTurn(input = {}) {
      return touchRuntimeTurnTransaction.immediate(requireRecord(input, 'runtime turn activity'));
    },

    rejectRuntimeTurnBinding(input = {}) {
      return rejectRuntimeTurnBindingTransaction.immediate(
        requireRecord(input, 'runtime turn binding rejection'),
      );
    },

    finishRuntimeTurn(input = {}) {
      return finishRuntimeTurnTransaction.immediate(requireRecord(input, 'runtime turn completion'));
    },

    releaseRuntimeTurn(input = {}) {
      return releaseRuntimeTurnTransaction.immediate(requireRecord(input, 'runtime turn release'));
    },

    recoverRuntimeTurn(input = {}) {
      return recoverRuntimeTurnTransaction.immediate(requireRecord(input, 'runtime turn recovery'));
    },

    getActiveRuntimeTurn() {
      return toRuntimeTurnAdmission(selectActiveRuntimeTurnAdmission.get());
    },

    queryDeliveries({ requestId = null, status = 'dead_letter', limit = 50 } = {}) {
      const safeRequestId = requestId === null ? null : requireIdentifier(requestId, 'requestId');
      const safeStatus = requireText(status, 'status', 32);
      if (!['pending', 'processing', 'delivered', 'dead_letter'].includes(safeStatus)) {
        throw new TypeError('status is not a supported delivery status');
      }
      requireInteger(limit, 'limit', { minimum: 1 });
      if (limit > 500) throw new TypeError('limit must be <= 500');
      const rows = safeRequestId === null
        ? database.prepare(`
            SELECT e.id, e.request_id, e.sequence, e.event_type, e.payload_json,
                   e.created_at, e.delivery_status, e.retry_count, e.redrive_count,
                   e.available_at, e.last_error, e.delivered_at,
                   r.route_channel, r.route_endpoint
            FROM assistant_response_events e
            JOIN assistant_requests r ON r.request_id = e.request_id
            WHERE e.delivery_status = ?
            ORDER BY e.id ASC
            LIMIT ?
          `).all(safeStatus, limit)
        : database.prepare(`
            SELECT e.id, e.request_id, e.sequence, e.event_type, e.payload_json,
                   e.created_at, e.delivery_status, e.retry_count, e.redrive_count,
                   e.available_at, e.last_error, e.delivered_at,
                   r.route_channel, r.route_endpoint
            FROM assistant_response_events e
            JOIN assistant_requests r ON r.request_id = e.request_id
            WHERE e.request_id = ? AND e.delivery_status = ?
            ORDER BY e.sequence ASC
            LIMIT ?
          `).all(safeRequestId, safeStatus, limit);
      return rows.map(row => ({
        deliveryId: row.id,
        route: { channel: row.route_channel, endpointId: row.route_endpoint },
        event: toEvent(row),
        status: row.delivery_status,
        retryCount: row.retry_count,
        redriveCount: row.redrive_count,
        availableAt: row.available_at,
        lastError: row.last_error,
        deliveredAt: row.delivered_at,
      }));
    },

    redriveDeadLetters({ requestId, limit = 50 } = {}) {
      const safeRequestId = requireIdentifier(requestId, 'requestId');
      requireInteger(limit, 'limit', { minimum: 1 });
      if (limit > 500) throw new TypeError('limit must be <= 500');
      return database.transaction(() => {
        const rows = database.prepare(`
          SELECT id
          FROM assistant_response_events
          WHERE request_id = ? AND delivery_status = 'dead_letter'
          ORDER BY sequence ASC
          LIMIT ?
        `).all(safeRequestId, limit);
        if (rows.length === 0) return { requestId: safeRequestId, redriven: 0 };
        const current = clock();
        const update = database.prepare(`
          UPDATE assistant_response_events
          SET delivery_status = 'pending', retry_count = 0,
              redrive_count = redrive_count + 1, available_at = ?,
              lease_token = NULL, lease_expires_at = NULL,
              last_error = CASE
                WHEN last_error IS NULL THEN 'OPERATOR_REDRIVE'
                ELSE 'OPERATOR_REDRIVE: ' || last_error
              END
          WHERE id = ? AND delivery_status = 'dead_letter'
        `);
        let redriven = 0;
        for (const row of rows) redriven += update.run(current, row.id).changes;
        return { requestId: safeRequestId, redriven };
      }).immediate();
    },

    claimDeliveries({ limit = 50, leaseSeconds = 30 } = {}) {
      requireInteger(limit, 'limit', { minimum: 1 });
      requireInteger(leaseSeconds, 'leaseSeconds', { minimum: 1 });
      return database.transaction(() => {
        const current = clock();
        database.prepare(`
          UPDATE assistant_response_events
          SET delivery_status = 'pending', lease_token = NULL, lease_expires_at = NULL,
              available_at = ?, last_error = COALESCE(last_error, 'STALE_DELIVERY_RECOVERED')
          WHERE delivery_status = 'processing' AND lease_expires_at <= ?
        `).run(current, current);
        const candidates = database.prepare(`
          SELECT candidate.id
          FROM assistant_response_events candidate
          WHERE candidate.delivery_status = 'pending'
            AND candidate.available_at <= ?
            AND NOT EXISTS (
              SELECT 1
              FROM assistant_response_events prior
              WHERE prior.request_id = candidate.request_id
                AND prior.sequence < candidate.sequence
                AND prior.delivery_status != 'delivered'
                AND (
                  prior.delivery_status != 'pending'
                  OR prior.available_at > ?
                )
            )
          ORDER BY candidate.id ASC
          LIMIT ?
        `).all(current, current, limit);
        const deliveries = [];
        for (const candidate of candidates) {
          const token = leaseToken();
          const claimed = database.prepare(`
            UPDATE assistant_response_events
            SET delivery_status = 'processing', lease_token = ?, lease_expires_at = ?
            WHERE id = ? AND delivery_status = 'pending'
          `).run(token, current + leaseSeconds, candidate.id);
          if (claimed.changes !== 1) continue;
          const row = database.prepare(`
            SELECT e.id, e.request_id, e.sequence, e.event_type, e.payload_json,
                   e.created_at, e.retry_count, e.redrive_count,
                   r.route_channel, r.route_endpoint
            FROM assistant_response_events e
            JOIN assistant_requests r ON r.request_id = e.request_id
            WHERE e.id = ?
          `).get(candidate.id);
          deliveries.push({
            deliveryId: row.id,
            leaseToken: token,
            retryCount: row.retry_count,
            redriveCount: row.redrive_count,
            route: { channel: row.route_channel, endpointId: row.route_endpoint },
            event: toEvent(row),
          });
        }
        return deliveries;
      }).immediate();
    },

    acknowledgeDeliveries(deliveries) {
      if (!Array.isArray(deliveries) || deliveries.length === 0) {
        throw new TypeError('deliveries must be a non-empty array');
      }
      const current = clock();
      return database.transaction(() => deliveries.map(item => {
        requireRecord(item, 'delivery acknowledgement');
        const deliveryId = requireInteger(item.deliveryId, 'deliveryId', { minimum: 1 });
        const token = requireText(item.leaseToken, 'leaseToken');
        const updated = database.prepare(`
          UPDATE assistant_response_events
          SET delivery_status = 'delivered', delivered_at = ?, lease_token = NULL,
              lease_expires_at = NULL, last_error = NULL
          WHERE id = ? AND delivery_status = 'processing' AND lease_token = ?
        `).run(current, deliveryId, token);
        return { deliveryId, acknowledged: updated.changes === 1 };
      }))();
    },

    retryDeliveries(deliveries, { maxAttempts = 5, delaySeconds = 2 } = {}) {
      if (!Array.isArray(deliveries) || deliveries.length === 0) {
        throw new TypeError('deliveries must be a non-empty array');
      }
      requireInteger(maxAttempts, 'maxAttempts', { minimum: 1 });
      requireInteger(delaySeconds, 'delaySeconds');
      const current = clock();
      return database.transaction(() => deliveries.map(item => {
        requireRecord(item, 'delivery retry');
        const deliveryId = requireInteger(item.deliveryId, 'deliveryId', { minimum: 1 });
        const token = requireText(item.leaseToken, 'leaseToken');
        const error = requireText(item.error, 'error', 1024);
        const row = database.prepare(`
          SELECT retry_count FROM assistant_response_events
          WHERE id = ? AND delivery_status = 'processing' AND lease_token = ?
        `).get(deliveryId, token);
        if (!row) return { deliveryId, retried: false };
        const retryCount = row.retry_count + 1;
        const status = retryCount >= maxAttempts ? 'dead_letter' : 'pending';
        database.prepare(`
          UPDATE assistant_response_events
          SET delivery_status = ?, retry_count = ?, available_at = ?,
              lease_token = NULL, lease_expires_at = NULL, last_error = ?
          WHERE id = ? AND delivery_status = 'processing' AND lease_token = ?
        `).run(status, retryCount, current + (status === 'pending' ? delaySeconds : 0), error, deliveryId, token);
        return { deliveryId, retried: true, status, retryCount };
      }))();
    },

    close() {
      if (ownsDatabase) {
        database.close();
        ownsDatabase = false;
      }
    },
  });
}
