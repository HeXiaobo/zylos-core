import { randomUUID } from 'node:crypto';
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
      status TEXT DEFAULT 'pending',
      delivery_action TEXT,
      priority INTEGER DEFAULT 3,
      require_idle INTEGER DEFAULT 0,
      retry_count INTEGER DEFAULT 0
    );
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
  leaseToken = randomUUID,
} = {}) {
  const opened = openDatabase(dbPath);
  const database = opened.database;
  let ownsDatabase = opened.ownsDatabase;
  ensureAssistantResponseSchema(database);

  const selectRequest = database.prepare(`
    SELECT request_id, conversation_id, route_channel, route_endpoint, source_id,
           status, runtime_session_id, next_sequence, output_text,
           accepted_at, updated_at, terminal_at
    FROM assistant_requests
    WHERE request_id = ?
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
          return { request: toRequest(request), events: [], replayed: true };
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

      case 'BindNextRun': {
        const runtimeSessionId = requireIdentifier(command.runtimeSessionId, 'runtimeSessionId');
        const existing = database.prepare(`
          SELECT request_id, conversation_id, route_channel, route_endpoint, source_id,
                 status, runtime_session_id, next_sequence, output_text,
                 accepted_at, updated_at, terminal_at
          FROM assistant_requests
          WHERE runtime_session_id = ? AND status IN ('queued', 'started')
          ORDER BY updated_at DESC, accepted_at DESC
          LIMIT 1
        `).get(runtimeSessionId);
        if (existing) return { request: toRequest(existing), events: [], replayed: true };
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
        const emitted = appendEvent(request, 'ProgressUpdated', progress, idempotencyKey);
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
        return {
          request: toRequest(selectRequest.get(request.request_id)),
          events: [failed.event],
          replayed: false,
        };
      }

      case 'ExpireStaleRuns': {
        const staleBefore = requireInteger(command.staleBefore, 'staleBefore');
        const stale = database.prepare(`
          SELECT request_id
          FROM assistant_requests
          WHERE status IN ('queued', 'started') AND updated_at <= ?
          ORDER BY updated_at ASC, request_id ASC
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
        BindNextRun: [['type', 'runtimeSessionId'], ['type', 'runtimeSessionId']],
        ReportProgress: [
          ['type', 'runtimeSessionId', 'stage', 'idempotencyKey'],
          ['type', 'runtimeSessionId', 'stage', 'idempotencyKey'],
        ],
        ReportToolProgress: [
          ['type', 'runtimeSessionId', 'toolName', 'status', 'idempotencyKey'],
          ['type', 'runtimeSessionId', 'toolName', 'status', 'idempotencyKey'],
        ],
        AppendPublicReasoningDelta: [
          ['type', 'requestId', 'delta', 'idempotencyKey'],
          ['type', 'requestId', 'delta', 'idempotencyKey'],
        ],
        AppendRuntimePublicReasoningDelta: [
          ['type', 'runtimeSessionId', 'delta', 'idempotencyKey'],
          ['type', 'runtimeSessionId', 'delta', 'idempotencyKey'],
        ],
        AppendOutputDelta: [
          ['type', 'requestId', 'delta', 'idempotencyKey'],
          ['type', 'requestId', 'delta', 'idempotencyKey'],
        ],
        AppendRuntimeOutputDelta: [
          ['type', 'runtimeSessionId', 'delta', 'idempotencyKey'],
          ['type', 'runtimeSessionId', 'delta', 'idempotencyKey'],
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
