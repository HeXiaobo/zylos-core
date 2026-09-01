import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import Database from 'better-sqlite3';

import { DB_PATH } from './c4-config.js';
import { ensureAssistantReplyReliabilitySchema } from './c4-db.js';

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

function requireText(value, field, maxLength = 100_000) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`${field} must be a non-empty string`);
  }
  if (Array.from(value).length > maxLength) {
    throw new TypeError(`${field} exceeds ${maxLength} characters`);
  }
  return value;
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

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function requireGeneration(value) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError('generation must be a positive safe integer');
  }
  return value;
}

function normalizeContent(raw, field) {
  const content = requireRecord(raw, field);
  const format = requireText(content.format, `${field}.format`, 32);
  if (format === 'text') {
    if (typeof content.text !== 'string' || content.text.trim() === '') {
      throw domainError('MISSING_OUTPUT', `${field}.text must contain visible output`);
    }
    return { format: 'text', text: content.text };
  }
  if (format === 'media') {
    if (typeof content.ref !== 'string' || content.ref.trim() === '') {
      throw domainError('MISSING_OUTPUT', `${field} media requires a durable content reference`);
    }
    throw domainError(
      'REPLY_CONTRACT_UNDEFINED',
      'Reply Contract v1 does not freeze the public media content-reference field',
    );
  }
  throw new TypeError(`${field}.format must be text or media`);
}

function normalizeOutcome(raw, { requestId, turnId, traceId }) {
  const input = requireRecord(raw, 'outcome');
  const kind = requireText(input.kind, 'outcome.kind', 32);
  const common = {
    schemaVersion: 1,
    type: 'ReplyOutcome',
    outcomeId: `outcome:${requestId}`,
    requestId,
    turnId,
    traceId,
    kind,
  };
  if (input.outcomeId !== undefined && input.outcomeId !== common.outcomeId) {
    throw domainError('OUTCOME_ID_MISMATCH', 'outcomeId is not the canonical request identity');
  }
  if (kind === 'answer') {
    return { ...common, content: normalizeContent(input.content, 'outcome.content') };
  }
  if (kind === 'silent') {
    if (input.explicit !== true) {
      throw domainError('SILENT_NOT_EXPLICIT', 'silent outcome requires explicit=true');
    }
    return { ...common, explicit: true, reason: requireText(input.reason, 'outcome.reason') };
  }
  if (kind === 'failure') {
    if (typeof input.retryable !== 'boolean') {
      throw new TypeError('outcome.retryable must be a boolean');
    }
    return {
      ...common,
      code: requireText(input.code, 'outcome.code', 128),
      retryable: input.retryable,
    };
  }
  throw new TypeError('outcome.kind must be answer, silent, or failure');
}

function normalizeRoute(raw, field = 'reply.route') {
  const route = requireRecord(raw, field);
  return {
    adapterId: requireText(route.adapterId, `${field}.adapterId`),
    targetRef: requireText(route.targetRef, `${field}.targetRef`),
  };
}

function buildIntent({ requestId, traceId, cause, reply, outcome, replyPolicy }) {
  if (!reply) {
    throw domainError(
      'REPLY_DECISION_REQUIRED',
      `${replyPolicy.mode} reply policy requires an explicit send or suppress decision`,
    );
  }
  const decision = requireRecord(reply, 'reply');
  const action = requireText(decision.action, 'reply.action', 32);
  if (!['send', 'suppress'].includes(action)) {
    throw new TypeError('reply.action must be send or suppress');
  }
  const route = normalizeRoute(replyPolicy.route, 'stored reply route');
  if (
    decision.route !== undefined
    && canonicalJson(normalizeRoute(decision.route)) !== canonicalJson(route)
  ) {
    throw domainError('REPLY_ROUTE_MISMATCH', 'reply route differs from the durable intake route');
  }
  if (outcome.kind === 'silent') {
    if (action !== 'suppress') {
      throw domainError('SILENT_INTENT_FORBIDDEN', 'explicit silent requires reply.action=suppress');
    }
    return null;
  }
  if (action !== 'send') {
    throw domainError(
      'REPLY_POLICY_VIOLATION',
      'only an explicit silent outcome may suppress a ReplyIntent',
    );
  }
  if (replyPolicy.mode === 'none') {
    throw domainError('REPLY_POLICY_VIOLATION', 'reply.mode=none only permits explicit silent');
  }
  const disposition = requireText(decision.disposition, 'reply.disposition', 32);
  const expectedDisposition = outcome.kind === 'answer' ? 'send' : 'failure_notice';
  if (disposition !== expectedDisposition) {
    throw domainError(
      'INVALID_REPLY_DISPOSITION',
      `${outcome.kind} requires disposition=${expectedDisposition}`,
    );
  }
  const payload = decision.payload
    ? normalizeContent(decision.payload, 'reply.payload')
    : outcome.kind === 'answer' ? outcome.content : null;
  if (!payload) {
    throw domainError('MISSING_OUTPUT', 'failure_notice requires visible reply.payload');
  }
  const routeHash = sha256(canonicalJson(route));
  const intentId = `reply:${requestId}:${routeHash}`;
  const contentHash = `sha256:${sha256(canonicalJson(payload))}`;
  for (const [field, expected] of [
    ['intentId', intentId],
    ['idempotencyKey', intentId],
    ['contentHash', contentHash],
  ]) {
    if (reply[field] !== undefined && reply[field] !== expected) {
      throw domainError('IDEMPOTENCY_CONFLICT', `${field} does not match canonical bytes`);
    }
  }
  return {
    schemaVersion: 1,
    type: 'ReplyIntent',
    intentId,
    requestId,
    traceId,
    cause,
    route,
    disposition,
    payload,
    contentHash,
    idempotencyKey: intentId,
  };
}

function buildTaskReceiptIntent(input) {
  const command = requireRecord(input, 'task receipt');
  const requestId = requireText(command.requestId, 'requestId');
  const traceId = requireText(command.traceId, 'traceId');
  const cause = requireRecord(command.cause, 'cause');
  if (cause.kind !== 'task_effect') {
    throw domainError('INVALID_REPLY_CAUSE', 'task_receipt requires a task_effect cause');
  }
  const eventId = requireText(cause.eventId, 'cause.eventId');
  if (command.disposition !== 'task_receipt') {
    throw domainError('INVALID_REPLY_DISPOSITION', 'task effect requires task_receipt');
  }
  const route = normalizeRoute(command.route);
  const payload = normalizeContent(command.payload, 'payload');
  const routeHash = sha256(canonicalJson(route));
  const intentId = `reply:${eventId}:${routeHash}`;
  const contentHash = `sha256:${sha256(canonicalJson(payload))}`;
  for (const [field, expected] of [
    ['intentId', intentId],
    ['idempotencyKey', intentId],
    ['contentHash', contentHash],
  ]) {
    if (command[field] !== undefined && command[field] !== expected) {
      throw domainError('IDEMPOTENCY_CONFLICT', `${field} does not match canonical bytes`);
    }
  }
  return {
    schemaVersion: 1,
    type: 'ReplyIntent',
    intentId,
    requestId,
    traceId,
    cause: { kind: 'task_effect', eventId },
    route,
    disposition: 'task_receipt',
    payload,
    contentHash,
    idempotencyKey: intentId,
  };
}

function toEvent(row) {
  return row && {
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

function toDelivery(row) {
  return row && {
    intentId: row.intent_id,
    state: row.delivery_state,
    attemptCount: row.attempt_count,
    availableAt: row.available_at,
    redriveCount: row.redrive_count,
  };
}

export function openReplyOutcomeTransactions({
  dbPath = DB_PATH,
  clock = () => Math.floor(Date.now() / 1_000),
  taskEffectVerifier = null,
} = {}) {
  const normalizedPath = requireText(dbPath, 'dbPath');
  if (typeof clock !== 'function') throw new TypeError('clock must be a function');
  if (taskEffectVerifier !== null && typeof taskEffectVerifier !== 'function') {
    throw new TypeError('taskEffectVerifier must be a function or null');
  }
  if (normalizedPath !== ':memory:') fs.mkdirSync(path.dirname(normalizedPath), { recursive: true });
  const database = new Database(normalizedPath);
  database.pragma('journal_mode = WAL');
  database.pragma('busy_timeout = 5000');
  database.pragma('foreign_keys = ON');
  ensureAssistantReplyReliabilitySchema(database);

  const selectRun = database.prepare(`
    SELECT l.*, r.conversation_id
    FROM assistant_run_ledger AS l
    JOIN assistant_requests AS r ON r.request_id = l.request_id
    WHERE l.request_id = ?
  `);
  const selectOutcome = database.prepare(`
    SELECT envelope_json, canonical_hash
    FROM assistant_reply_outcomes
    WHERE request_id = ?
  `);
  const selectTerminal = database.prepare(`
    SELECT request_id, sequence, event_type, payload_json, idempotency_key,
           event_id, turn_id, generation, trace_id, causation_id, producer, created_at
    FROM assistant_response_events
    WHERE request_id = ? AND event_type IN ('RunCompleted', 'RunFailed', 'RunCancelled')
    ORDER BY sequence ASC LIMIT 1
  `);
  const selectIntentByCause = database.prepare(`
    SELECT *
    FROM assistant_reply_intents
    WHERE cause_kind = ? AND cause_event_id = ?
    ORDER BY created_at ASC, intent_id ASC LIMIT 1
  `);
  const selectIntentById = database.prepare(`
    SELECT * FROM assistant_reply_intents WHERE intent_id = ?
  `);

  function resultFor(requestId, replayed) {
    const outcomeRow = selectOutcome.get(requestId);
    const terminal = toEvent(selectTerminal.get(requestId));
    const intentRow = terminal
      ? selectIntentByCause.get('run_terminal', terminal.eventId)
      : null;
    return {
      replayed,
      outcome: outcomeRow ? JSON.parse(outcomeRow.envelope_json) : null,
      terminal,
      intent: intentRow ? JSON.parse(intentRow.canonical_hash ? intentRow.envelope_json : '{}') : null,
      delivery: toDelivery(intentRow),
    };
  }

  function replyPolicyFor(run) {
    return {
      mode: run.reply_mode,
      route: JSON.parse(run.reply_route_json),
    };
  }

  function terminalIdentityMatches(row, expected) {
    return row.event_type === expected.type
      && row.event_id === expected.eventId
      && row.idempotency_key === expected.idempotencyKey
      && row.request_id === expected.requestId
      && row.turn_id === expected.turnId
      && row.generation === expected.generation
      && row.sequence === expected.sequence
      && row.trace_id === expected.traceId
      && row.causation_id === expected.causationId
      && row.producer === expected.producer
      && canonicalJson(JSON.parse(row.payload_json)) === canonicalJson(expected.payload);
  }

  const commitTransaction = database.transaction((input) => {
    const command = requireRecord(input, 'commitRunOutcome input');
    const requestId = requireText(command.requestId, 'requestId');
    const turnId = requireText(command.turnId, 'turnId');
    const generation = requireGeneration(command.generation);
    const traceId = requireText(command.traceId, 'traceId');
    const causationId = requireText(command.causationId, 'causationId');
    const producer = requireText(command.producer, 'producer');
    const idempotencyKey = requireText(command.idempotencyKey, 'idempotencyKey');
    const run = selectRun.get(requestId);
    if (!run) throw domainError('RUN_NOT_FOUND', `unknown Assistant Request: ${requestId}`);
    if (run.turn_id !== turnId || run.generation !== generation || run.trace_id !== traceId) {
      throw domainError('RUN_EVENT_FENCED', 'outcome targets a stale request/turn/generation');
    }
    const outcome = normalizeOutcome(command.outcome, { requestId, turnId, traceId });
    const replyPolicy = replyPolicyFor(run);
    const outcomeJson = canonicalJson(outcome);
    const outcomeHash = sha256(outcomeJson);
    const existingOutcome = selectOutcome.get(requestId);
    if (existingOutcome) {
      if (existingOutcome.canonical_hash !== outcomeHash) {
        throw domainError('IDEMPOTENCY_CONFLICT', 'canonical ReplyOutcome already has another payload');
      }
      const existingTerminal = selectTerminal.get(requestId);
      if (!existingTerminal) {
        throw domainError('IDEMPOTENCY_CONFLICT', 'outcome replay does not match its terminal');
      }
      const terminalType = outcome.kind === 'failure' ? 'RunFailed' : 'RunCompleted';
      const terminalPayload = outcome.kind === 'failure'
        ? { outcomeId: outcome.outcomeId, code: outcome.code, retryable: outcome.retryable }
        : { outcomeId: outcome.outcomeId };
      const expectedTerminal = {
        type: terminalType,
        eventId: `evt:${requestId}:${existingTerminal.sequence}`,
        idempotencyKey,
        requestId,
        turnId,
        generation,
        sequence: existingTerminal.sequence,
        traceId,
        causationId,
        producer,
        payload: terminalPayload,
      };
      if (!terminalIdentityMatches(existingTerminal, expectedTerminal)) {
        throw domainError(
          'IDEMPOTENCY_CONFLICT',
          'outcome replay changes the canonical terminal envelope',
        );
      }
      const expectedIntent = buildIntent({
        requestId,
        traceId,
        cause: { kind: 'run_terminal', eventId: existingTerminal.event_id },
        reply: command.reply,
        outcome,
        replyPolicy,
      });
      const storedIntent = selectIntentByCause.get('run_terminal', existingTerminal.event_id);
      if ((expectedIntent === null) !== (storedIntent === undefined)) {
        throw domainError('IDEMPOTENCY_CONFLICT', 'outcome replay changes ReplyIntent visibility');
      }
      if (expectedIntent && storedIntent.canonical_hash !== sha256(canonicalJson(expectedIntent))) {
        throw domainError('IDEMPOTENCY_CONFLICT', 'outcome replay changes ReplyIntent payload');
      }
      return resultFor(requestId, true);
    }
    if (run.status !== 'active') {
      throw domainError('INVALID_RUN_TRANSITION', `cannot record outcome while run is ${run.status}`);
    }
    if (selectTerminal.get(requestId)) {
      throw domainError('TERMINAL_CONFLICT', 'run already has a terminal without a canonical outcome');
    }
    const current = clock();
    if (!Number.isSafeInteger(current) || current < 0) {
      throw new TypeError('clock must return a non-negative safe integer');
    }
    const request = database.prepare(`
      SELECT next_sequence FROM assistant_requests WHERE request_id = ?
    `).get(requestId);
    const sequence = request.next_sequence;
    const terminalType = outcome.kind === 'failure' ? 'RunFailed' : 'RunCompleted';
    const terminalPayload = outcome.kind === 'failure'
      ? { outcomeId: outcome.outcomeId, code: outcome.code, retryable: outcome.retryable }
      : { outcomeId: outcome.outcomeId };
    const eventId = `evt:${requestId}:${sequence}`;
    const terminal = {
      schemaVersion: 1,
      type: terminalType,
      eventId,
      idempotencyKey,
      requestId,
      turnId,
      generation,
      sequence,
      traceId,
      causationId,
      producer,
      payload: terminalPayload,
      createdAt: current,
    };
    const intent = buildIntent({
      requestId,
      traceId,
      cause: { kind: 'run_terminal', eventId },
      reply: command.reply,
      outcome,
      replyPolicy,
    });

    database.prepare(`
      INSERT INTO assistant_reply_outcomes (
        outcome_id, request_id, turn_id, generation, trace_id, kind,
        envelope_json, canonical_hash, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      outcome.outcomeId, requestId, turnId, generation, traceId, outcome.kind,
      outcomeJson, outcomeHash, current,
    );
    database.prepare(`
      INSERT INTO assistant_response_events (
        request_id, sequence, event_type, payload_json, idempotency_key,
        delivery_status, available_at, created_at, event_id, turn_id,
        generation, trace_id, causation_id, producer
      ) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      requestId, sequence, terminalType, canonicalJson(terminalPayload), idempotencyKey,
      current, current, eventId, turnId, generation, traceId, causationId, producer,
    );
    if (intent) {
      const routeHash = intent.intentId.split(':').at(-1);
      database.prepare(`
        INSERT INTO assistant_reply_intents (
          intent_id, request_id, trace_id, cause_kind, cause_event_id,
          route_json, route_hash, disposition, payload_json, envelope_json, content_hash,
          idempotency_key, canonical_hash, delivery_state, available_at,
          created_at, updated_at
        ) VALUES (?, ?, ?, 'run_terminal', ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)
      `).run(
        intent.intentId, requestId, traceId, eventId, canonicalJson(intent.route), routeHash,
        intent.disposition, canonicalJson(intent.payload), canonicalJson(intent), intent.contentHash,
        intent.idempotencyKey, sha256(canonicalJson(intent)), current, current, current,
      );
    }
    const nextStatus = terminalType === 'RunCompleted' ? 'completed' : 'failed';
    const runUpdate = database.prepare(`
      UPDATE assistant_run_ledger
      SET status = ?, updated_at = ?, terminal_at = ?
      WHERE request_id = ? AND turn_id = ? AND generation = ? AND status = 'active'
    `).run(nextStatus, current, current, requestId, turnId, generation);
    const requestUpdate = database.prepare(`
      UPDATE assistant_requests
      SET status = ?, next_sequence = next_sequence + 1, updated_at = ?, terminal_at = ?
      WHERE request_id = ? AND status = 'started'
    `).run(nextStatus, current, current, requestId);
    const admissionUpdate = database.prepare(`
      UPDATE runtime_turn_admissions
      SET status = 'completed', terminal_at = ?, updated_at = ?,
          binding_mode = 'closed', terminal_reason = ?
      WHERE request_id = ? AND turn_id = ? AND generation = ?
        AND status IN ('submitted', 'started')
    `).run(current, current, terminalType, requestId, turnId, generation);
    if (
      runUpdate.changes !== 1
      || requestUpdate.changes !== 1
      || admissionUpdate.changes !== 1
    ) {
      throw domainError('OUTCOME_COMMIT_CONFLICT', 'outcome transaction lost its run fence');
    }
    return { replayed: false, outcome, terminal, intent, delivery: intent && { intentId: intent.intentId, state: 'pending', attemptCount: 0, availableAt: current, redriveCount: 0 } };
  });

  const taskReceiptTransaction = database.transaction((input) => {
    const intent = buildTaskReceiptIntent(input);
    const run = selectRun.get(intent.requestId);
    if (!run) throw domainError('RUN_NOT_FOUND', `unknown Assistant Request: ${intent.requestId}`);
    if (run.trace_id !== intent.traceId) {
      throw domainError('TRACE_ID_MISMATCH', 'task receipt traceId does not match its request');
    }
    if (!taskEffectVerifier) {
      throw domainError(
        'TASK_EFFECT_VERIFICATION_REQUIRED',
        'task_receipt requires an injected canonical task-effect verifier',
      );
    }
    const verification = taskEffectVerifier({
      eventId: intent.cause.eventId,
      requestId: intent.requestId,
      traceId: intent.traceId,
    });
    if (verification && typeof verification.then === 'function') {
      throw new TypeError('taskEffectVerifier must be synchronous');
    }
    if (
      !verification
      || verification.canonical !== true
      || verification.applied !== true
      || verification.eventId !== intent.cause.eventId
      || verification.requestId !== intent.requestId
      || verification.traceId !== intent.traceId
    ) {
      throw domainError(
        'TASK_EFFECT_NOT_VERIFIED',
        'task effect must be canonical, applied, and match requestId/traceId',
      );
    }
    const canonicalHash = sha256(canonicalJson(intent));
    const existing = selectIntentById.get(intent.intentId);
    if (existing) {
      if (existing.canonical_hash !== canonicalHash) {
        throw domainError('IDEMPOTENCY_CONFLICT', 'ReplyIntent identity has another payload');
      }
      return {
        replayed: true,
        intent: JSON.parse(existing.envelope_json),
        delivery: toDelivery(existing),
      };
    }
    const current = clock();
    if (!Number.isSafeInteger(current) || current < 0) {
      throw new TypeError('clock must return a non-negative safe integer');
    }
    const routeHash = intent.intentId.split(':').at(-1);
    database.prepare(`
      INSERT INTO assistant_reply_intents (
        intent_id, request_id, trace_id, cause_kind, cause_event_id,
        route_json, route_hash, disposition, payload_json, envelope_json, content_hash,
        idempotency_key, canonical_hash, delivery_state, available_at,
        created_at, updated_at
      ) VALUES (?, ?, ?, 'task_effect', ?, ?, ?, 'task_receipt', ?, ?, ?, ?, ?, 'pending', ?, ?, ?)
    `).run(
      intent.intentId, intent.requestId, intent.traceId, intent.cause.eventId,
      canonicalJson(intent.route), routeHash, canonicalJson(intent.payload), canonicalJson(intent),
      intent.contentHash, intent.idempotencyKey, canonicalHash, current, current, current,
    );
    const inserted = selectIntentById.get(intent.intentId);
    return { replayed: false, intent, delivery: toDelivery(inserted) };
  });

  return Object.freeze({
    commitRunOutcome(input) {
      return commitTransaction.immediate(input);
    },
    commitTaskReceipt(input) {
      return taskReceiptTransaction.immediate(input);
    },
    close() {
      database.close();
    },
  });
}
