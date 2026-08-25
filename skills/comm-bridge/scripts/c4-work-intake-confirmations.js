import { createHash } from 'node:crypto';

import { getDb } from './c4-db.js';

const RESOLUTION_ACTIONS = new Set(['create_task', 'chat_only', 'edit']);
const RESOLUTION_FIELDS = new Set(['sourceKey', 'action', 'actorId']);

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
    CREATE TABLE IF NOT EXISTS work_intake_confirmations (
      source_key TEXT PRIMARY KEY,
      request_fingerprint TEXT NOT NULL,
      conversation_id INTEGER NOT NULL UNIQUE,
      envelope_json TEXT NOT NULL,
      decision_json TEXT NOT NULL,
      resolved_action TEXT,
      resolved_by TEXT,
      resolved_at INTEGER,
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
}

export function parseWorkIntakeConfirmationJson(rawJson) {
  if (typeof rawJson !== 'string' || rawJson === '') {
    throw new TypeError('WorkIntake confirmation JSON must be a non-empty string');
  }
  try {
    return normalizeResolution(JSON.parse(rawJson));
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new TypeError(`WorkIntake confirmation JSON is invalid: ${error.message}`);
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
        action: row.resolved_action,
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
      SET resolved_action = ?, resolved_by = ?, resolved_at = ?
      WHERE source_key = ? AND resolved_action IS NULL
    `).run(
      resolution.action,
      resolution.actorId,
      Math.floor(Date.now() / 1000),
      resolution.sourceKey,
    );
    return {
      created: true,
      action: resolution.action,
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
