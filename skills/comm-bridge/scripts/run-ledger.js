import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import Database from 'better-sqlite3';

import {
  canonicalRunEventFailure,
  canonicalRunEventLinkFailure,
  canonicalRunPersistenceFailure,
} from './canonical-run-event.js';
import { DB_PATH } from './c4-config.js';
import { ensureAssistantRunLedgerSchema } from './c4-db.js';

export const RUNTIME_LANE_ID = 'runtime:shared';
export const RUNTIME_LANE_CAPACITY = 1;

const TERMINAL_TYPES = new Set(['RunCompleted', 'RunFailed', 'RunCancelled']);
const RUN_EVENT_TYPES = new Set([
  'RunAccepted',
  'RunQueued',
  'RunStarted',
  'ProgressUpdated',
  'OutputDelta',
  'RunCompleted',
  'RunFailed',
  'RunCancelled',
]);
const REQUEST_CLASSES = new Set(['ordinary', 'maintenance', 'control']);
const REPLY_MODES = new Set(['required', 'optional', 'none']);
const PAYLOAD_HASH_PATTERN = /^sha256:[a-f0-9]{64}$/;

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

function assertAllowedKeys(value, allowed, field) {
  const unknown = Object.keys(value).filter(key => !allowed.includes(key));
  if (unknown.length > 0) {
    throw domainError(
      'NONCANONICAL_V1_SHAPE',
      `${field} contains unknown v1 fields: ${unknown.sort().join(', ')}`,
    );
  }
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

function requireClock(clock) {
  if (typeof clock !== 'function') throw new TypeError('clock must be a function');
  const current = clock();
  if (!Number.isSafeInteger(current) || current < 0) {
    throw new TypeError('clock must return a non-negative safe integer');
  }
  return clock;
}

function requirePayloadHash(value) {
  const payloadHash = requireText(value, 'source.payloadHash', 80);
  if (!PAYLOAD_HASH_PATTERN.test(payloadHash)) {
    throw new TypeError('source.payloadHash must be a lowercase sha256 digest');
  }
  return payloadHash;
}

function identityKey(parts) {
  return JSON.stringify(parts.map((part, index) => requireText(part, `source identity ${index}`)));
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => (
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`
    )).join(',')}}`;
  }
  return JSON.stringify(value);
}

function normalizeEvent(raw) {
  const event = requireRecord(raw, 'run event');
  assertAllowedKeys(event, [
    'type', 'requestId', 'turnId', 'generation', 'traceId', 'causationId',
    'producer', 'idempotencyKey', 'payload',
  ], 'run event');
  const type = requireText(event.type, 'event.type');
  if (!RUN_EVENT_TYPES.has(type)) throw new TypeError(`unsupported run event type: ${type}`);
  const generation = event.generation;
  if (!Number.isInteger(generation) || generation < 1) {
    throw new TypeError('event.generation must be a positive integer');
  }
  const payload = requireRecord(event.payload ?? {}, 'event.payload');
  const payloadKeys = {
    RunAccepted: [],
    RunQueued: event.producer === 'core:runtime-recovery'
      ? ['runtimeLaneId', 'recoveredFromTurnId', 'recoveredAdmissionStatus']
      : ['runtimeLaneId'],
    RunStarted: ['runtimeLaneId', 'runtimeSessionId', 'contextSnapshotId', 'contextSnapshotHash'],
    ProgressUpdated: ['stage'],
    OutputDelta: ['deltaIndex', 'text'],
    RunCompleted: ['outcomeId'],
    RunFailed: ['outcomeId', 'code', 'retryable'],
    RunCancelled: ['mode'],
  }[type];
  const allowedPayloadKeys = type === 'RunStarted'
    ? payloadKeys.filter(key => Object.hasOwn(payload, key) || !key.startsWith('contextSnapshot'))
    : payloadKeys;
  assertAllowedKeys(payload, allowedPayloadKeys, `${type}.payload`);
  if (type === 'RunCompleted' || type === 'RunFailed') {
    requireText(payload.outcomeId, 'event.payload.outcomeId');
    for (const visibleField of ['text', 'content', 'output', 'outputText']) {
      if (Object.hasOwn(payload, visibleField)) {
        throw domainError(
          'INVALID_TERMINAL_PAYLOAD',
          `${type} may reference an outcomeId but may not embed ${visibleField}`,
        );
      }
    }
  }
  if (type === 'RunCancelled' && (Object.hasOwn(payload, 'outcomeId') || Object.hasOwn(payload, 'outcome'))) {
    throw domainError(
      'INVALID_TERMINAL_PAYLOAD',
      'RunCancelled must not create or reference a ReplyOutcome',
    );
  }
  return {
    type,
    requestId: requireText(event.requestId, 'event.requestId'),
    turnId: requireText(event.turnId, 'event.turnId'),
    generation,
    traceId: requireText(event.traceId, 'event.traceId'),
    causationId: requireText(event.causationId, 'event.causationId'),
    producer: requireText(event.producer, 'event.producer'),
    idempotencyKey: requireText(event.idempotencyKey, 'event.idempotencyKey'),
    payload,
    payloadJson: canonicalJson(payload),
  };
}

function normalizeCancelRequest(raw) {
  const command = requireRecord(raw, 'CancelRequest');
  assertAllowedKeys(command, [
    'schemaVersion', 'type', 'commandId', 'idempotencyKey', 'requestId', 'turnId',
    'generation', 'traceId', 'causationId', 'issuedAt', 'source', 'actor', 'mode', 'reason',
  ], 'CancelRequest');
  if (command.schemaVersion !== 1 || command.type !== 'CancelRequest') {
    throw new TypeError('RunLedger.cancel requires a CancelRequest v1 command');
  }
  if (command.mode !== 'cooperative') {
    throw new TypeError('CancelRequest.mode must be cooperative');
  }
  requireText(command.issuedAt, 'CancelRequest.issuedAt');
  const source = requireRecord(command.source, 'CancelRequest.source');
  assertAllowedKeys(
    source,
    ['adapterId', 'accountRef', 'eventType', 'eventId', 'messageId'],
    'CancelRequest.source',
  );
  for (const field of ['adapterId', 'accountRef', 'eventType', 'eventId', 'messageId']) {
    requireText(source[field], `CancelRequest.source.${field}`);
  }
  const actor = requireRecord(command.actor, 'CancelRequest.actor');
  assertAllowedKeys(
    actor,
    ['provider', 'tenantRef', 'externalId', 'provenance'],
    'CancelRequest.actor',
  );
  for (const field of ['provider', 'tenantRef', 'externalId', 'provenance']) {
    requireText(actor[field], `CancelRequest.actor.${field}`);
  }
  const generation = command.generation;
  if (!Number.isInteger(generation) || generation < 1) {
    throw new TypeError('CancelRequest.generation must be a positive integer');
  }
  const normalized = {
    commandId: requireText(command.commandId, 'CancelRequest.commandId'),
    idempotencyKey: requireText(command.idempotencyKey, 'CancelRequest.idempotencyKey'),
    requestId: requireText(command.requestId, 'CancelRequest.requestId'),
    turnId: requireText(command.turnId, 'CancelRequest.turnId'),
    generation,
    traceId: requireText(command.traceId, 'CancelRequest.traceId'),
    causationId: requireText(command.causationId, 'CancelRequest.causationId'),
    reason: requireText(command.reason, 'CancelRequest.reason'),
  };
  normalized.payloadHash = createHash('sha256')
    .update(canonicalJson(command))
    .digest('hex');
  return normalized;
}

function normalizeCancellationConfirmation(raw) {
  const confirmation = requireRecord(raw, 'cancellation confirmation');
  assertAllowedKeys(confirmation, [
    'requestId', 'turnId', 'generation', 'traceId', 'causationId', 'producer',
  ], 'cancellation confirmation');
  const generation = confirmation.generation;
  if (!Number.isInteger(generation) || generation < 1) {
    throw new TypeError('cancellation confirmation generation must be a positive integer');
  }
  return {
    requestId: requireText(confirmation.requestId, 'confirmation.requestId'),
    turnId: requireText(confirmation.turnId, 'confirmation.turnId'),
    generation,
    traceId: requireText(confirmation.traceId, 'confirmation.traceId'),
    causationId: requireText(confirmation.causationId, 'confirmation.causationId'),
    producer: requireText(confirmation.producer, 'confirmation.producer'),
  };
}

function normalizeAcceptMessage(raw) {
  const command = requireRecord(raw, 'AcceptMessage');
  assertAllowedKeys(command, [
    'schemaVersion', 'type', 'commandId', 'idempotencyKey', 'traceId', 'causationId',
    'issuedAt', 'source', 'actor', 'content', 'contextHints', 'reply', 'policy',
    'requestClass', 'conversationLaneKey',
  ], 'AcceptMessage');
  if (command.schemaVersion !== 1 || command.type !== 'AcceptMessage') {
    throw new TypeError('RunLedger.accept requires an AcceptMessage v1 command');
  }
  const source = requireRecord(command.source, 'source');
  const policy = requireRecord(command.policy, 'policy');
  const reply = requireRecord(command.reply, 'reply');
  const content = requireRecord(command.content, 'content');
  const actor = requireRecord(command.actor, 'actor');
  const contextHints = requireRecord(command.contextHints, 'contextHints');
  assertAllowedKeys(source, [
    'adapterId', 'accountRef', 'targetRef', 'conversationKey', 'messageId',
    'eventId', 'eventType', 'payloadHash',
  ], 'source');
  assertAllowedKeys(actor, ['provider', 'tenantRef', 'externalId'], 'actor');
  assertAllowedKeys(content, ['kind', 'text'], 'content');
  assertAllowedKeys(contextHints, [
    'threadRef', 'rootRef', 'parentRef', 'quoteRefs', 'mentionRefs', 'attachmentRefs',
  ], 'contextHints');
  assertAllowedKeys(reply, ['mode', 'targetRef'], 'reply');
  assertAllowedKeys(policy, ['priority', 'requireIdle'], 'policy');
  requireText(command.commandId, 'commandId');
  requireText(command.issuedAt, 'issuedAt');
  for (const field of ['provider', 'tenantRef', 'externalId']) requireText(actor[field], `actor.${field}`);
  if (content.kind !== 'text') throw new TypeError('content.kind must be text');
  for (const field of ['quoteRefs', 'mentionRefs', 'attachmentRefs']) {
    if (!Array.isArray(contextHints[field])) throw new TypeError(`contextHints.${field} must be an array`);
  }
  const requestClass = command.requestClass ?? 'ordinary';
  if (!REQUEST_CLASSES.has(requestClass)) {
    throw new TypeError('requestClass must be ordinary, maintenance, or control');
  }
  const priority = policy.priority ?? 2;
  if (!Number.isInteger(priority) || priority < 1 || priority > 3) {
    throw new TypeError('policy.priority must be 1, 2, or 3');
  }
  if (policy.requireIdle !== undefined && typeof policy.requireIdle !== 'boolean') {
    throw new TypeError('policy.requireIdle must be a boolean');
  }
  const requireIdle = requestClass === 'ordinary' ? false : (policy.requireIdle ?? true);
  if (requestClass !== 'ordinary' && !requireIdle) {
    throw domainError(
      'INVALID_REQUIRE_IDLE_POLICY',
      `${requestClass} requests must explicitly retain the runtime-idle gate`,
    );
  }
  const adapterId = requireText(source.adapterId, 'source.adapterId');
  const accountRef = requireText(source.accountRef, 'source.accountRef');
  const eventType = requireText(source.eventType, 'source.eventType');
  const eventId = requireText(source.eventId, 'source.eventId');
  const messageId = requireText(source.messageId, 'source.messageId');
  const payloadHash = requirePayloadHash(source.payloadHash);
  const conversationLaneKey = requireText(
    command.conversationLaneKey ?? source.conversationKey,
    'source.conversationKey',
  );
  const replyMode = requireText(reply.mode, 'reply.mode', 32);
  if (!REPLY_MODES.has(replyMode)) {
    throw new TypeError('reply.mode must be required, optional, or none');
  }
  const targetRef = requireText(reply.targetRef ?? source.targetRef, 'reply.targetRef');
  const replyRoute = { adapterId, targetRef };
  const renderedContent = requireText(content.text, 'content.text', 100_000);
  return {
    idempotencyKey: requireText(command.idempotencyKey, 'idempotencyKey'),
    transportKey: identityKey([adapterId, accountRef, eventType, eventId]),
    logicalKey: identityKey([adapterId, accountRef, eventType, messageId]),
    payloadHash,
    adapterId,
    targetRef,
    replyMode,
    replyRouteJson: canonicalJson(replyRoute),
    sourceId: messageId,
    conversationLaneKey,
    renderedContent,
    traceId: requireText(command.traceId, 'traceId'),
    causationId: requireText(command.causationId, 'causationId'),
    requestClass,
    priority,
    requireIdle,
  };
}

function toAccepted(row) {
  if (!row) return null;
  return {
    schemaVersion: 1,
    type: 'MessageAccepted',
    requestId: row.request_id,
    traceId: row.trace_id,
    conversationLaneKey: row.conversation_lane_key,
    laneSequence: row.lane_sequence,
    orderingMode: 'acceptance',
    sourceOrder: null,
  };
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
    replyPolicy: {
      mode: row.reply_mode,
      route: JSON.parse(row.reply_route_json),
    },
    runtimeLaneId: row.runtime_lane_id,
    turnId: row.turn_id,
    generation: row.generation,
    status: row.status,
    acceptedAt: row.accepted_at,
    updatedAt: row.updated_at,
    terminalAt: row.terminal_at,
  };
}

function toEvent(row) {
  if (!row) return null;
  return {
    schemaVersion: 1,
    type: row.event_type,
    eventId: row.event_id,
    idempotencyKey: row.idempotency_key,
    requestId: row.request_id,
    turnId: row.turn_id,
    generation: row.generation,
    sequence: row.sequence,
    traceId: row.trace_id,
    causationId: row.causation_id,
    producer: row.producer,
    payload: JSON.parse(row.payload_json),
    createdAt: row.created_at,
  };
}

export function openRunLedger({
  dbPath = DB_PATH,
  clock = () => Math.floor(Date.now() / 1_000),
  requestIdFactory = () => `req:${randomUUID()}`,
} = {}) {
  const normalizedPath = requireText(dbPath, 'dbPath');
  const safeClock = requireClock(clock);
  if (typeof requestIdFactory !== 'function') {
    throw new TypeError('requestIdFactory must be a function');
  }
  if (normalizedPath !== ':memory:') {
    fs.mkdirSync(path.dirname(normalizedPath), { recursive: true });
  }
  const database = new Database(normalizedPath);
  database.pragma('journal_mode = WAL');
  database.pragma('busy_timeout = 5000');
  database.pragma('foreign_keys = ON');
  ensureAssistantRunLedgerSchema(database);

  const selectReceipt = database.prepare(`
    SELECT identity_kind, identity_key, request_id, payload_hash
    FROM assistant_source_receipts
    WHERE identity_kind = ? AND identity_key = ?
  `);
  const insertReceipt = database.prepare(`
    INSERT INTO assistant_source_receipts (
      identity_kind, identity_key, request_id, payload_hash, created_at
    ) VALUES (?, ?, ?, ?, ?)
  `);
  const selectRun = database.prepare(`
    SELECT l.*, r.conversation_id
    FROM assistant_run_ledger AS l
    JOIN assistant_requests AS r ON r.request_id = l.request_id
    WHERE l.request_id = ?
  `);
  const selectEvents = database.prepare(`
    SELECT request_id, sequence, event_type, payload_json, idempotency_key,
           event_id, turn_id, generation, trace_id, causation_id, producer, created_at
    FROM assistant_response_events
    WHERE request_id = ?
    ORDER BY sequence ASC
  `);
  const insertEvent = database.prepare(`
    INSERT INTO assistant_response_events (
      request_id, sequence, event_type, payload_json, idempotency_key,
      delivery_status, available_at, created_at, event_id, turn_id,
      generation, trace_id, causation_id, producer
    ) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const selectEventByIdempotency = database.prepare(`
    SELECT request_id, sequence, event_type, payload_json, idempotency_key,
           event_id, turn_id, generation, trace_id, causation_id, producer, created_at
    FROM assistant_response_events
    WHERE request_id = ? AND idempotency_key = ?
  `);
  const selectTerminalEvent = database.prepare(`
    SELECT request_id, sequence, event_type, payload_json, idempotency_key,
           event_id, turn_id, generation, trace_id, causation_id, producer, created_at
    FROM assistant_response_events
    WHERE request_id = ?
      AND event_type IN ('RunCompleted', 'RunFailed', 'RunCancelled')
    ORDER BY sequence ASC
    LIMIT 1
  `);
  const selectRequestFacts = database.prepare(`
    SELECT request_id, status, runtime_session_id, next_sequence
    FROM assistant_requests WHERE request_id = ?
  `);
  const selectAdmissionFacts = database.prepare(`
    SELECT request_id, turn_id, generation, runtime_lane_id, runtime_session_id, status,
           terminal_reason
    FROM runtime_turn_admissions
    WHERE request_id = ? AND turn_id = ? AND generation = ?
    ORDER BY id DESC LIMIT 1
  `);
  const selectAllAdmissionFacts = database.prepare(`
    SELECT request_id, turn_id, generation, runtime_lane_id, runtime_session_id, status,
           terminal_reason
    FROM runtime_turn_admissions WHERE request_id = ? ORDER BY id ASC
  `);

  function loadCanonicalRun(requestId) {
    const run = selectRun.get(requestId);
    if (!run) return null;
    const failure = canonicalRunPersistenceFailure({
      rows: selectEvents.all(requestId),
      run,
      request: selectRequestFacts.get(requestId),
      admission: selectAdmissionFacts.get(requestId, run.turn_id, run.generation),
      admissions: selectAllAdmissionFacts.all(requestId),
    });
    if (failure) {
      throw domainError(
        'CANONICAL_RUN_LEDGER_CORRUPT',
        `RunLedger failed canonical persistence validation: ${failure}`,
      );
    }
    return toRun(run);
  }

  function acceptedResult(requestId, replayed) {
    const row = selectRun.get(requestId);
    return {
      replayed,
      accepted: toAccepted(row),
      request: toRun(row),
      events: selectEvents.all(requestId).map(toEvent),
    };
  }

  const acceptTransaction = database.transaction((rawCommand) => {
    const command = normalizeAcceptMessage(rawCommand);
    const identities = [
      ['idempotency', command.idempotencyKey],
      ['transport', command.transportKey],
      ['logical', command.logicalKey],
    ];
    const receipts = identities
      .map(([kind, key]) => selectReceipt.get(kind, key))
      .filter(Boolean);
    for (const receipt of receipts) {
      if (receipt.payload_hash !== command.payloadHash) {
        throw domainError(
          'IDEMPOTENCY_CONFLICT',
          `${receipt.identity_kind} identity was reused with another payload`,
        );
      }
    }
    const requestIds = new Set(receipts.map(receipt => receipt.request_id));
    if (requestIds.size > 1) {
      throw domainError('IDENTITY_CONFLICT', 'source identities resolve to different requests');
    }
    if (requestIds.size === 1) {
      const [requestId] = requestIds;
      const existingRun = selectRun.get(requestId);
      if (
        existingRun.reply_mode !== command.replyMode
        || canonicalJson(JSON.parse(existingRun.reply_route_json)) !== command.replyRouteJson
      ) {
        throw domainError(
          'IDEMPOTENCY_CONFLICT',
          'source identity replay changes the durable reply policy',
        );
      }
      const current = safeClock();
      for (const [kind, key] of identities) {
        if (!selectReceipt.get(kind, key)) {
          insertReceipt.run(kind, key, requestId, command.payloadHash, current);
        }
      }
      return acceptedResult(requestId, true);
    }

    const requestId = requireText(requestIdFactory(command), 'generated requestId');
    const current = safeClock();
    const priorLane = database.prepare(`
      SELECT COALESCE(MAX(lane_sequence), 0) AS value
      FROM assistant_run_ledger
      WHERE conversation_lane_key = ?
    `).get(command.conversationLaneKey).value;
    const laneSequence = priorLane + 1;
    const conversation = database.prepare(`
      INSERT INTO conversations (
        direction, channel, endpoint_id, content, status,
        delivery_action, priority, require_idle
      ) VALUES ('in', ?, ?, ?, 'pending', 'queued', ?, ?)
    `).run(
      command.adapterId,
      command.targetRef,
      command.renderedContent,
      command.priority,
      command.requireIdle ? 1 : 0,
    );
    database.prepare(`
      INSERT INTO assistant_requests (
        request_id, conversation_id, route_channel, route_endpoint, source_id,
        status, runtime_session_id, next_sequence, output_text,
        accepted_at, updated_at, terminal_at
      ) VALUES (?, ?, ?, ?, ?, 'queued', NULL, 3, '', ?, ?, NULL)
    `).run(
      requestId,
      conversation.lastInsertRowid,
      command.adapterId,
      command.targetRef,
      command.sourceId,
      current,
      current,
    );
    const turnId = `turn:${requestId}:1`;
    database.prepare(`
      INSERT INTO assistant_run_ledger (
        request_id, conversation_lane_key, lane_sequence, payload_hash,
        trace_id, causation_id, request_class, priority, require_idle,
        reply_mode, reply_route_json, runtime_lane_id, turn_id, generation, status,
        accepted_at, updated_at, terminal_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 'queued', ?, ?, NULL)
    `).run(
      requestId,
      command.conversationLaneKey,
      laneSequence,
      command.payloadHash,
      command.traceId,
      command.causationId,
      command.requestClass,
      command.priority,
      command.requireIdle ? 1 : 0,
      command.replyMode,
      command.replyRouteJson,
      RUNTIME_LANE_ID,
      turnId,
      current,
      current,
    );
    for (const [kind, key] of identities) {
      insertReceipt.run(kind, key, requestId, command.payloadHash, current);
    }
    insertEvent.run(
      requestId, 1, 'RunAccepted', '{}', `run:${requestId}:accepted`,
      current, current, `evt:${requestId}:1`, turnId, 1,
      command.traceId, command.causationId, 'core:message-intake',
    );
    insertEvent.run(
      requestId, 2, 'RunQueued', JSON.stringify({ runtimeLaneId: RUNTIME_LANE_ID }),
      `run:${requestId}:queued`, current, current, `evt:${requestId}:2`,
      turnId, 1, command.traceId, `evt:${requestId}:1`, 'core:runtime-pending-queue',
    );
    return acceptedResult(requestId, false);
  });

  function sameEvent(existing, event) {
    return existing.event_type === event.type
      && existing.turn_id === event.turnId
      && existing.generation === event.generation
      && existing.trace_id === event.traceId
      && existing.causation_id === event.causationId
      && existing.producer === event.producer
      && canonicalJson(JSON.parse(existing.payload_json)) === event.payloadJson;
  }

  function appendEventCore(rawEvent, { allowCancellationTerminal = false } = {}) {
    const event = normalizeEvent(rawEvent);
    const run = selectRun.get(event.requestId);
    if (!run) throw domainError('RUN_NOT_FOUND', `unknown Assistant Request: ${event.requestId}`);

    const existing = selectEventByIdempotency.get(event.requestId, event.idempotencyKey);
    if (existing) {
      if (!sameEvent(existing, event)) {
        throw domainError(
          'IDEMPOTENCY_CONFLICT',
          `run event idempotency key was reused: ${event.idempotencyKey}`,
        );
      }
      return { replayed: true, event: toEvent(existing), request: toRun(run) };
    }

    if (
      run.turn_id !== event.turnId
      || run.generation !== event.generation
      || run.trace_id !== event.traceId
    ) {
      throw domainError(
        'RUN_EVENT_FENCED',
        `event does not match the current turn/generation for ${event.requestId}`,
      );
    }

    const terminal = selectTerminalEvent.get(event.requestId);
    if (terminal) {
      if (TERMINAL_TYPES.has(event.type) && sameEvent(terminal, event)) {
        return { replayed: true, event: toEvent(terminal), request: toRun(run) };
      }
      throw domainError(
        TERMINAL_TYPES.has(event.type) ? 'TERMINAL_CONFLICT' : 'RUN_TERMINAL',
        `Assistant Request already ended with ${terminal.event_type}`,
      );
    }
    if (['RunAccepted', 'RunQueued', 'RunStarted'].includes(event.type)) {
      throw domainError(
        'INVALID_RUN_TRANSITION',
        `${event.type} is owned by acceptance or the Runtime Pending Queue`,
      );
    }
    if (event.type === 'RunCancelled' && !allowCancellationTerminal) {
      throw domainError(
        'INVALID_CANCEL_STATE',
        'RunCancelled is owned by queued cancellation or cooperative confirmation',
      );
    }
    if (
      ['RunCompleted', 'RunFailed'].includes(event.type)
      && run.status !== 'active'
    ) {
      throw domainError('INVALID_RUN_TRANSITION', `${event.type} requires an active run`);
    }
    if (
      event.type === 'RunCancelled'
      && !['queued', 'cancel_requested'].includes(run.status)
    ) {
      throw domainError('INVALID_CANCEL_STATE', `cannot cancel while run is ${run.status}`);
    }
    if (!TERMINAL_TYPES.has(event.type) && run.status !== 'active') {
      throw domainError('RUN_NOT_ACTIVE', `cannot append ${event.type} while run is ${run.status}`);
    }

    const current = safeClock();
    const sequence = database.prepare(`
      SELECT next_sequence FROM assistant_requests WHERE request_id = ?
    `).get(event.requestId).next_sequence;
    const eventId = `evt:${event.requestId}:${sequence}`;
    const canonicalEvent = {
      request_id: event.requestId,
      sequence,
      event_type: event.type,
      payload_json: event.payloadJson,
      idempotency_key: event.idempotencyKey,
      event_id: eventId,
      turn_id: event.turnId,
      generation: event.generation,
      trace_id: event.traceId,
      causation_id: event.causationId,
      producer: event.producer,
      created_at: current,
    };
    const structuralFailure = canonicalRunEventFailure(canonicalEvent);
    if (structuralFailure) {
      throw domainError(
        'NONCANONICAL_RUN_EVENT',
        `${event.type} failed canonical validation: ${structuralFailure}`,
      );
    }
    const predecessor = selectEvents.all(event.requestId).at(-1);
    const linkFailure = canonicalRunEventLinkFailure(canonicalEvent, predecessor);
    if (linkFailure) {
      throw domainError(
        'NONCANONICAL_RUN_EVENT_CHAIN',
        `${event.type} cannot extend the canonical head: ${linkFailure}`,
      );
    }
    insertEvent.run(
      event.requestId,
      sequence,
      event.type,
      event.payloadJson,
      event.idempotencyKey,
      current,
      current,
      eventId,
      event.turnId,
      event.generation,
      event.traceId,
      event.causationId,
      event.producer,
    );
    database.prepare(`
      UPDATE assistant_requests
      SET next_sequence = next_sequence + 1, updated_at = ?
      WHERE request_id = ?
    `).run(current, event.requestId);

    if (TERMINAL_TYPES.has(event.type)) {
      const nextStatus = event.type === 'RunCompleted'
        ? 'completed'
        : event.type === 'RunFailed' ? 'failed' : 'cancelled';
      database.prepare(`
        UPDATE assistant_run_ledger
        SET status = ?, updated_at = ?, terminal_at = ?
        WHERE request_id = ?
      `).run(nextStatus, current, current, event.requestId);
      database.prepare(`
        UPDATE assistant_requests
        SET status = ?, updated_at = ?, terminal_at = ?
        WHERE request_id = ?
      `).run(nextStatus, current, current, event.requestId);
      database.prepare(`
        UPDATE runtime_turn_admissions
        SET status = 'completed', terminal_at = ?, updated_at = ?,
            binding_mode = 'closed', terminal_reason = ?
        WHERE request_id = ? AND turn_id = ? AND generation = ?
          AND status IN ('submitted', 'started')
      `).run(current, current, event.type, event.requestId, event.turnId, event.generation);
      if (event.type === 'RunCancelled') {
        database.prepare(`
          UPDATE conversations
          SET status = CASE WHEN status = 'pending' THEN 'failed' ELSE status END,
              delivery_action = 'cancelled'
          WHERE id = ?
        `).run(run.conversation_id);
      }
    }

    const inserted = selectEventByIdempotency.get(event.requestId, event.idempotencyKey);
    return { replayed: false, event: toEvent(inserted), request: toRun(selectRun.get(event.requestId)) };
  }
  const appendEventTransaction = database.transaction(appendEventCore);

  const selectCancelRequest = database.prepare(`
    SELECT idempotency_key, request_id, turn_id, generation, payload_hash,
           trace_id, causation_id, status, requested_at, confirmed_at
    FROM assistant_cancel_requests
    WHERE idempotency_key = ?
  `);
  const selectPendingCancelForRun = database.prepare(`
    SELECT idempotency_key, command_id
    FROM assistant_cancel_requests
    WHERE request_id = ? AND turn_id = ? AND generation = ? AND status = 'requested'
    ORDER BY requested_at ASC, idempotency_key ASC
    LIMIT 1
  `);

  const cancelTransaction = database.transaction((rawCommand) => {
    const command = normalizeCancelRequest(rawCommand);
    const run = selectRun.get(command.requestId);
    if (!run) throw domainError('RUN_NOT_FOUND', `unknown Assistant Request: ${command.requestId}`);
    const existing = selectCancelRequest.get(command.idempotencyKey);
    if (existing) {
      if (existing.payload_hash !== command.payloadHash) {
        throw domainError(
          'IDEMPOTENCY_CONFLICT',
          `CancelRequest idempotency key was reused: ${command.idempotencyKey}`,
        );
      }
      return {
        replayed: true,
        status: existing.status === 'confirmed' ? 'cancelled' : 'cancel_requested',
        request: toRun(run),
      };
    }
    if (
      run.turn_id !== command.turnId
      || run.generation !== command.generation
      || run.trace_id !== command.traceId
    ) {
      throw domainError('RUN_EVENT_FENCED', 'CancelRequest targets a stale turn/generation');
    }
    if (['completed', 'failed'].includes(run.status)) {
      throw domainError('RUN_TERMINAL', `cannot cancel a ${run.status} run`);
    }
    if (run.status === 'cancelled') {
      throw domainError('RUN_TERMINAL', 'Assistant Request is already cancelled');
    }
    const current = safeClock();
    database.prepare(`
      INSERT INTO assistant_cancel_requests (
        idempotency_key, command_id, request_id, turn_id, generation, payload_hash,
        trace_id, causation_id, status, requested_at, confirmed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'requested', ?, NULL)
    `).run(
      command.idempotencyKey,
      command.commandId,
      command.requestId,
      command.turnId,
      command.generation,
      command.payloadHash,
      command.traceId,
      command.causationId,
      current,
    );

    if (run.status === 'queued') {
      const result = appendEventCore({
        type: 'RunCancelled',
        requestId: command.requestId,
        turnId: command.turnId,
        generation: command.generation,
        traceId: command.traceId,
        causationId: command.commandId,
        producer: 'core:runtime-lane',
        idempotencyKey: `run:${command.requestId}:cancelled:g${command.generation}`,
        payload: { mode: 'queued' },
      }, { allowCancellationTerminal: true });
      database.prepare(`
        UPDATE assistant_cancel_requests
        SET status = 'confirmed', confirmed_at = ?
        WHERE idempotency_key = ?
      `).run(current, command.idempotencyKey);
      return { replayed: false, status: 'cancelled', request: result.request };
    }

    if (run.status === 'active') {
      database.prepare(`
        UPDATE assistant_run_ledger
        SET status = 'cancel_requested', updated_at = ?
        WHERE request_id = ? AND status = 'active'
      `).run(current, command.requestId);
    }
    return {
      replayed: false,
      status: 'cancel_requested',
      request: toRun(selectRun.get(command.requestId)),
    };
  });

  const confirmCancellationTransaction = database.transaction((rawConfirmation) => {
    const confirmation = normalizeCancellationConfirmation(rawConfirmation);
    const run = selectRun.get(confirmation.requestId);
    if (!run) {
      throw domainError('RUN_NOT_FOUND', `unknown Assistant Request: ${confirmation.requestId}`);
    }
    if (
      run.turn_id !== confirmation.turnId
      || run.generation !== confirmation.generation
      || run.trace_id !== confirmation.traceId
    ) {
      throw domainError('RUN_EVENT_FENCED', 'cancellation confirmation targets a stale turn/generation');
    }
    if (run.status === 'cancelled') {
      return { replayed: true, status: 'cancelled', request: toRun(run) };
    }
    if (run.status !== 'cancel_requested') {
      throw domainError(
        'INVALID_CANCEL_STATE',
        `cannot confirm cancellation while run is ${run.status}`,
      );
    }
    const pending = selectPendingCancelForRun.get(
      confirmation.requestId,
      confirmation.turnId,
      confirmation.generation,
    );
    if (!pending) throw domainError('CANCEL_REQUEST_NOT_FOUND', 'no cancellation awaits confirmation');
    const result = appendEventCore({
      type: 'RunCancelled',
      requestId: confirmation.requestId,
      turnId: confirmation.turnId,
      generation: confirmation.generation,
      traceId: confirmation.traceId,
      causationId: confirmation.causationId,
      producer: confirmation.producer,
      idempotencyKey: `run:${confirmation.requestId}:cancelled:g${confirmation.generation}`,
      payload: { mode: 'active' },
    }, { allowCancellationTerminal: true });
    const current = safeClock();
    database.prepare(`
      UPDATE assistant_cancel_requests
      SET status = 'confirmed', confirmed_at = ?, confirmation_causation_id = ?
      WHERE request_id = ? AND turn_id = ? AND generation = ?
        AND status = 'requested'
    `).run(
      current,
      confirmation.causationId,
      confirmation.requestId,
      confirmation.turnId,
      confirmation.generation,
    );
    return { replayed: result.replayed, status: 'cancelled', request: result.request };
  });

  return Object.freeze({
    accept(command) {
      return acceptTransaction.immediate(command);
    },
    get(requestId) {
      return loadCanonicalRun(requireText(requestId, 'requestId'));
    },
    listEvents(requestId) {
      return selectEvents.all(requireText(requestId, 'requestId')).map(toEvent);
    },
    appendEvent(event) {
      return appendEventTransaction.immediate(event);
    },
    cancel(command) {
      return cancelTransaction.immediate(command);
    },
    confirmCancellation(confirmation) {
      return confirmCancellationTransaction.immediate(confirmation);
    },
    close() {
      database.close();
    },
  });
}
