import { createHash } from 'node:crypto';

import { getDb } from './c4-db.js';
import { workIntakeSourceKey } from '../../work-intake/scripts/inbound-envelope.js';

const RESOLUTION_ACTIONS = new Set(['create_task', 'chat_only', 'edit']);
const RESOLUTION_FIELDS = new Set(['sourceKey', 'action', 'actorId']);
const CONFIRMATION_REQUEST_FIELDS = new Set(['sourceKey', 'action', 'actorId', 'capability']);
const EFFECT_REQUEST_FIELDS = new Set([
  'sourceKey',
  'action',
  'actorId',
  'effectKey',
  'capability',
]);
const DECISIONS = new Set(['create_task', 'chat_only', 'confirm']);

function fingerprint(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function conflict(sourceKey) {
  const error = new Error(`WorkIntake source key belongs to different content: ${sourceKey}`);
  error.code = 'IDEMPOTENCY_CONFLICT';
  return error;
}

function codedError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function requireText(value, field, maxLength = 512) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`${field} must be a non-empty string`);
  }
  if (Array.from(value).length > maxLength) {
    throw new TypeError(`${field} exceeds ${maxLength} characters`);
  }
  return value.trim();
}

function normalizeResolution(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('WorkIntake confirmation resolution must be an object');
  }
  const keys = Object.keys(input);
  if (keys.length !== RESOLUTION_FIELDS.size || keys.some((key) => !RESOLUTION_FIELDS.has(key))) {
    throw new TypeError('WorkIntake confirmation resolution contains unsupported or missing fields');
  }
  const action = requireText(input.action, 'WorkIntake confirmation action', 32);
  if (!RESOLUTION_ACTIONS.has(action)) {
    throw new TypeError('WorkIntake confirmation action is unsupported');
  }
  return {
    sourceKey: requireText(input.sourceKey, 'WorkIntake confirmation sourceKey'),
    action,
    actorId: requireText(input.actorId, 'WorkIntake confirmation actorId', 256),
  };
}

function ensureSchema(database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS work_intake_decisions (
      source_key TEXT PRIMARY KEY,
      request_fingerprint TEXT NOT NULL,
      envelope_json TEXT NOT NULL,
      decision_json TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS work_intake_confirmations (
      source_key TEXT PRIMARY KEY,
      request_fingerprint TEXT NOT NULL,
      conversation_id INTEGER NOT NULL UNIQUE,
      envelope_json TEXT NOT NULL,
      decision_json TEXT NOT NULL,
      resolved_action TEXT,
      resolved_by TEXT,
      resolved_at INTEGER,
      effect_status TEXT CHECK (effect_status IN ('pending', 'applied')),
      effect_applied_at INTEGER,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE RESTRICT
    )
  `);
  const columns = new Set(database.prepare('PRAGMA table_info(work_intake_confirmations)')
    .all()
    .map((column) => column.name));
  if (!columns.has('resolved_action')) {
    database.exec('ALTER TABLE work_intake_confirmations ADD COLUMN resolved_action TEXT');
  }
  if (!columns.has('resolved_by')) {
    database.exec('ALTER TABLE work_intake_confirmations ADD COLUMN resolved_by TEXT');
  }
  if (!columns.has('resolved_at')) {
    database.exec('ALTER TABLE work_intake_confirmations ADD COLUMN resolved_at INTEGER');
  }
  if (!columns.has('effect_status')) {
    database.exec(`
      ALTER TABLE work_intake_confirmations
      ADD COLUMN effect_status TEXT CHECK (effect_status IN ('pending', 'applied'))
    `);
  }
  database.exec(`
    UPDATE work_intake_confirmations
    SET effect_status = 'pending'
    WHERE resolved_action IS NOT NULL AND effect_status IS NULL
  `);
  if (!columns.has('effect_applied_at')) {
    database.exec('ALTER TABLE work_intake_confirmations ADD COLUMN effect_applied_at INTEGER');
  }
}

function normalizeDecision(decision, envelope, sourceKey) {
  if (!decision || typeof decision !== 'object' || Array.isArray(decision)) {
    throw new TypeError('WorkIntake classifier must return a decision object');
  }
  if (!DECISIONS.has(decision.decision)) {
    throw new TypeError('WorkIntake classifier returned an unsupported decision');
  }
  if (decision.sourceKey !== sourceKey || decision.intentRevision !== envelope.intentRevision) {
    throw new TypeError('WorkIntake classifier decision identity does not match its envelope');
  }
  return JSON.parse(JSON.stringify(decision));
}

/**
 * Persist the first classifier result for one immutable inbound intent. Replays
 * return that receipt without invoking the current classifier implementation,
 * so a software upgrade cannot reinterpret an already-observed message.
 */
export function recordWorkIntakeDecision({ envelope, classify }) {
  if (typeof classify !== 'function') throw new TypeError('WorkIntake classifier must be a function');
  const database = getDb();
  ensureSchema(database);
  const sourceKey = workIntakeSourceKey(envelope);
  const requestFingerprint = fingerprint(envelope);
  const select = database.prepare(`
    SELECT request_fingerprint, decision_json
    FROM work_intake_decisions
    WHERE source_key = ?
  `);
  return database.transaction(() => {
    const existing = select.get(sourceKey);
    if (existing) {
      if (existing.request_fingerprint !== requestFingerprint) throw conflict(sourceKey);
      return { decision: JSON.parse(existing.decision_json), replayed: true };
    }
    const decision = normalizeDecision(classify(envelope), envelope, sourceKey);
    database.prepare(`
      INSERT INTO work_intake_decisions (
        source_key, request_fingerprint, envelope_json, decision_json, created_at
      ) VALUES (?, ?, ?, ?, ?)
    `).run(
      sourceKey,
      requestFingerprint,
      JSON.stringify(envelope),
      JSON.stringify(decision),
      Math.floor(Date.now() / 1000),
    );
    return { decision, replayed: false };
  }).immediate();
}

export function parseWorkIntakeConfirmationJson(rawJson) {
  if (typeof rawJson !== 'string' || rawJson === '') {
    throw new TypeError('WorkIntake confirmation JSON must be a non-empty string');
  }
  try {
    const parsed = JSON.parse(rawJson);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new TypeError('WorkIntake confirmation request must be an object');
    }
    const keys = Object.keys(parsed);
    if (keys.length !== CONFIRMATION_REQUEST_FIELDS.size
      || keys.some(key => !CONFIRMATION_REQUEST_FIELDS.has(key))) {
      throw new TypeError('WorkIntake confirmation request contains unsupported or missing fields');
    }
    return {
      ...normalizeResolution({
        sourceKey: parsed.sourceKey,
        action: parsed.action,
        actorId: parsed.actorId,
      }),
      capability: requireText(parsed.capability, 'WorkIntake confirmation capability', 8_192),
    };
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new TypeError(`WorkIntake confirmation JSON is invalid: ${error.message}`);
    }
    throw error;
  }
}

export function parseWorkIntakeConfirmationEffectJson(rawJson) {
  if (typeof rawJson !== 'string' || rawJson === '') {
    throw new TypeError('WorkIntake confirmation effect JSON must be a non-empty string');
  }
  try {
    const parsed = JSON.parse(rawJson);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new TypeError('WorkIntake confirmation effect request must be an object');
    }
    const keys = Object.keys(parsed);
    if (keys.length !== EFFECT_REQUEST_FIELDS.size
      || keys.some(key => !EFFECT_REQUEST_FIELDS.has(key))) {
      throw new TypeError('WorkIntake confirmation effect request contains unsupported or missing fields');
    }
    const resolution = normalizeResolution({
      sourceKey: parsed.sourceKey,
      action: parsed.action,
      actorId: parsed.actorId,
    });
    if (resolution.action !== 'edit') {
      throw new TypeError('only externally delivered edit effects may be acknowledged');
    }
    const expectedEffectKey = `${resolution.sourceKey}:edit-guidance`;
    if (parsed.effectKey !== expectedEffectKey) {
      throw new TypeError('WorkIntake confirmation effectKey does not match its source');
    }
    return {
      ...resolution,
      effectKey: expectedEffectKey,
      capability: requireText(parsed.capability, 'WorkIntake confirmation capability', 8_192),
    };
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new TypeError(`WorkIntake confirmation effect JSON is invalid: ${error.message}`);
    }
    throw error;
  }
}

/**
 * Persist a channel-neutral confirmation decision and its inbound conversation
 * in one C4 transaction. No task exists until a signed user callback promotes
 * the draft through the existing Commitment intake queue.
 */
export function recordWorkIntakeConfirmation({ conversation, envelope, decision }) {
  if (decision?.decision !== 'confirm' || typeof decision.sourceKey !== 'string') {
    throw new TypeError('a confirm WorkIntake decision is required');
  }
  const database = getDb();
  ensureSchema(database);
  // Replay identity belongs to the original inbound envelope. Persist and
  // return the first decision so a later classifier release cannot rewrite an
  // already-presented confirmation card or turn replay into a false conflict.
  const requestFingerprint = fingerprint(envelope);
  const selectReceipt = database.prepare(`
    SELECT source_key, request_fingerprint, conversation_id, envelope_json,
           decision_json, created_at
    FROM work_intake_confirmations
    WHERE source_key = ?
  `);
  const selectConversation = database.prepare(`
    SELECT id, direction, channel, endpoint_id, content, status,
           delivery_action, priority, require_idle, retry_count
    FROM conversations
    WHERE id = ?
  `);

  return database.transaction(() => {
    const existing = selectReceipt.get(decision.sourceKey);
    if (existing) {
      if (existing.request_fingerprint !== requestFingerprint) {
        throw conflict(decision.sourceKey);
      }
      return {
        created: false,
        conversation: selectConversation.get(existing.conversation_id),
        decision: JSON.parse(existing.decision_json),
      };
    }

    const inserted = database.prepare(`
      INSERT INTO conversations (
        direction, channel, endpoint_id, content, status, delivery_action,
        priority, require_idle
      ) VALUES ('in', ?, ?, ?, 'delivered', 'work-intake-confirmation-required', ?, ?)
    `).run(
      conversation.channel,
      conversation.endpointId ?? null,
      conversation.content,
      conversation.priority ?? 3,
      conversation.requireIdle ? 1 : 0,
    );
    const conversationId = Number(inserted.lastInsertRowid);
    database.prepare(`
      INSERT INTO work_intake_confirmations (
        source_key, request_fingerprint, conversation_id, envelope_json,
        decision_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      decision.sourceKey,
      requestFingerprint,
      conversationId,
      JSON.stringify(envelope),
      JSON.stringify(decision),
      Math.floor(Date.now() / 1000),
    );
    return {
      created: true,
      conversation: selectConversation.get(conversationId),
      decision,
    };
  }).immediate();
}

/**
 * Resolve a persisted confirmation through one Core-owned Interface. The first
 * choice wins; exact retries return the durable receipt, while a different
 * choice or actor fails closed. Callers may safely continue the chosen action
 * after a crash because exact replay remains observable.
 */
export function resolveWorkIntakeConfirmation(input) {
  const resolution = normalizeResolution(input);
  const database = getDb();
  ensureSchema(database);
  const select = database.prepare(`
    SELECT w.source_key, w.conversation_id, w.envelope_json, w.decision_json,
           w.resolved_action, w.resolved_by, w.resolved_at,
           w.effect_status, w.effect_applied_at,
           c.channel, c.endpoint_id, c.content, c.priority, c.require_idle
    FROM work_intake_confirmations w
    JOIN conversations c ON c.id = w.conversation_id
    WHERE w.source_key = ?
  `);

  return database.transaction(() => {
    const row = select.get(resolution.sourceKey);
    if (!row) {
      throw codedError('CONFIRMATION_NOT_FOUND', 'WorkIntake confirmation does not exist');
    }
    const envelope = JSON.parse(row.envelope_json);
    const decision = JSON.parse(row.decision_json);
    if (envelope.sender?.id !== resolution.actorId) {
      throw codedError('FORBIDDEN', 'only the original human sender may resolve this WorkIntake');
    }
    if (row.resolved_action !== null) {
      if (row.resolved_action !== resolution.action || row.resolved_by !== resolution.actorId) {
        throw codedError(
          'CONFIRMATION_ALREADY_RESOLVED',
          `WorkIntake confirmation was already resolved as ${row.resolved_action}`,
        );
      }
      return {
        created: false,
        sourceKey: resolution.sourceKey,
        actorId: resolution.actorId,
        action: row.resolved_action,
        effectStatus: row.effect_status || 'pending',
        envelope,
        decision,
        conversation: {
          id: row.conversation_id,
          channel: row.channel,
          endpointId: row.endpoint_id,
          content: row.content,
          priority: row.priority,
          requireIdle: Boolean(row.require_idle),
        },
      };
    }

    database.prepare(`
      UPDATE work_intake_confirmations
      SET resolved_action = ?, resolved_by = ?, resolved_at = ?,
          effect_status = 'pending', effect_applied_at = NULL
      WHERE source_key = ? AND resolved_action IS NULL
    `).run(
      resolution.action,
      resolution.actorId,
      Math.floor(Date.now() / 1000),
      resolution.sourceKey,
    );
    return {
      created: true,
      sourceKey: resolution.sourceKey,
      actorId: resolution.actorId,
      action: resolution.action,
      effectStatus: 'pending',
      envelope,
      decision,
      conversation: {
        id: row.conversation_id,
        channel: row.channel,
        endpointId: row.endpoint_id,
        content: row.content,
        priority: row.priority,
        requireIdle: Boolean(row.require_idle),
      },
    };
  }).immediate();
}

/**
 * Promote the original held confirmation conversation onto the ordinary chat
 * queue in the same transaction that marks the chosen effect applied. Replays
 * observe the same conversation instead of inserting a duplicate.
 */
export function queueConfirmedWorkIntakeChat({ sourceKey, actorId, status }) {
  const safeSourceKey = requireText(sourceKey, 'WorkIntake confirmation sourceKey');
  const safeActorId = requireText(actorId, 'WorkIntake confirmation actorId', 256);
  if (status !== 'pending' && status !== 'delivered') {
    throw new TypeError('confirmed WorkIntake chat status is unsupported');
  }
  const database = getDb();
  ensureSchema(database);
  const select = database.prepare(`
    SELECT w.conversation_id, w.resolved_action, w.resolved_by, w.effect_status,
           c.status, c.delivery_action
    FROM work_intake_confirmations w
    JOIN conversations c ON c.id = w.conversation_id
    WHERE w.source_key = ?
  `);
  return database.transaction(() => {
    const row = select.get(safeSourceKey);
    if (!row) throw codedError('CONFIRMATION_NOT_FOUND', 'WorkIntake confirmation does not exist');
    if (row.resolved_action !== 'chat_only' || row.resolved_by !== safeActorId) {
      throw codedError('CONFIRMATION_ALREADY_RESOLVED', 'WorkIntake confirmation is not an authorized chat-only choice');
    }
    if (row.effect_status === 'applied') {
      return {
        replayed: true,
        effectStatus: 'applied',
        conversation: {
          id: row.conversation_id,
          status: row.status,
          deliveryAction: row.delivery_action,
        },
      };
    }
    const deliveryAction = 'work-intake-chat-only';
    database.prepare(`
      UPDATE conversations
      SET status = ?, delivery_action = ?, retry_count = 0
      WHERE id = ?
    `).run(status, deliveryAction, row.conversation_id);
    database.prepare(`
      UPDATE work_intake_confirmations
      SET effect_status = 'applied', effect_applied_at = ?
      WHERE source_key = ? AND effect_status = 'pending'
    `).run(Math.floor(Date.now() / 1000), safeSourceKey);
    return {
      replayed: false,
      effectStatus: 'applied',
      conversation: {
        id: row.conversation_id,
        status,
        deliveryAction,
      },
    };
  }).immediate();
}

/**
 * Acknowledge a durable non-chat confirmation effect. Task creation calls this
 * only after its idempotent intake row exists; channel adapters may use the
 * same receipt for externally delivered edit guidance.
 */
export function completeWorkIntakeConfirmationEffect({ sourceKey, action, actorId }) {
  const safeSourceKey = requireText(sourceKey, 'WorkIntake confirmation sourceKey');
  const safeActorId = requireText(actorId, 'WorkIntake confirmation actorId', 256);
  if (action !== 'create_task' && action !== 'edit') {
    throw new TypeError('confirmation effect completion action is unsupported');
  }
  const database = getDb();
  ensureSchema(database);
  return database.transaction(() => {
    const row = database.prepare(`
      SELECT conversation_id, resolved_action, resolved_by, effect_status
      FROM work_intake_confirmations
      WHERE source_key = ?
    `).get(safeSourceKey);
    if (!row) throw codedError('CONFIRMATION_NOT_FOUND', 'WorkIntake confirmation does not exist');
    if (row.resolved_action !== action || row.resolved_by !== safeActorId) {
      throw codedError('CONFIRMATION_ALREADY_RESOLVED', 'WorkIntake confirmation effect does not match its durable choice');
    }
    if (row.effect_status === 'applied') {
      return {
        replayed: true,
        effectStatus: 'applied',
        conversationId: row.conversation_id,
      };
    }
    database.prepare(`
      UPDATE work_intake_confirmations
      SET effect_status = 'applied', effect_applied_at = ?
      WHERE source_key = ? AND effect_status = 'pending'
    `).run(Math.floor(Date.now() / 1000), safeSourceKey);
    return {
      replayed: false,
      effectStatus: 'applied',
      conversationId: row.conversation_id,
    };
  }).immediate();
}
