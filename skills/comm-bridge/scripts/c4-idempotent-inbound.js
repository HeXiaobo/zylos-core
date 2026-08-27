import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import Database from 'better-sqlite3';

import { DB_PATH } from './c4-config.js';

const MAX_TEXT_LENGTH = 100_000;

function requireText(value, field, maxLength = 4_096) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`${field} must be a non-empty string`);
  }
  if (Array.from(value).length > maxLength) {
    throw new TypeError(`${field} exceeds ${maxLength} characters`);
  }
  return value;
}

function normalizeRequest(rawRequest) {
  if (!rawRequest || typeof rawRequest !== 'object' || Array.isArray(rawRequest)) {
    throw new TypeError('idempotent inbound request must be an object');
  }
  const priority = rawRequest.priority ?? 2;
  if (!Number.isInteger(priority) || priority < 1 || priority > 3) {
    throw new TypeError('idempotent inbound priority must be 1, 2, or 3');
  }
  if (rawRequest.requireIdle !== undefined && typeof rawRequest.requireIdle !== 'boolean') {
    throw new TypeError('idempotent inbound requireIdle must be a boolean');
  }
  return {
    idempotencyKey: requireText(rawRequest.idempotencyKey, 'idempotencyKey'),
    channel: requireText(rawRequest.channel, 'channel', 128),
    endpointId: rawRequest.endpointId === null || rawRequest.endpointId === undefined
      ? null
      : requireText(rawRequest.endpointId, 'endpointId', 4_096),
    content: requireText(rawRequest.content, 'content', MAX_TEXT_LENGTH),
    priority,
    requireIdle: rawRequest.requireIdle ?? false,
  };
}

function fingerprint(request) {
  return createHash('sha256').update(JSON.stringify(request)).digest('hex');
}

function domainError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function toConversation(row) {
  if (!row) return null;
  return {
    id: row.id,
    direction: row.direction,
    channel: row.channel,
    endpointId: row.endpoint_id,
    content: row.content,
    status: row.status,
    priority: row.priority,
    requireIdle: row.require_idle === 1,
  };
}

/**
 * Durable, exactly-once enqueue seam for trusted internal Agent wake-ups.
 * The receipt and C4 conversation row are committed in one SQLite transaction.
 */
export function openIdempotentInboundQueue({ dbPath = DB_PATH } = {}) {
  const normalizedPath = requireText(dbPath, 'dbPath', 8_192);
  if (normalizedPath !== ':memory:') fs.mkdirSync(path.dirname(normalizedPath), { recursive: true });
  const database = new Database(normalizedPath);
  database.pragma('journal_mode = WAL');
  database.pragma('busy_timeout = 5000');
  database.pragma('foreign_keys = ON');
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
    CREATE TABLE IF NOT EXISTS c4_idempotent_inbound_receipts (
      idempotency_key TEXT PRIMARY KEY,
      request_fingerprint TEXT NOT NULL,
      conversation_id INTEGER NOT NULL UNIQUE,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE RESTRICT
    );
  `);
  const selectReceipt = database.prepare(`
    SELECT r.request_fingerprint, c.*
    FROM c4_idempotent_inbound_receipts r
    JOIN conversations c ON c.id = r.conversation_id
    WHERE r.idempotency_key = ?
  `);
  const insertConversation = database.prepare(`
    INSERT INTO conversations (
      direction, channel, endpoint_id, content, status,
      delivery_action, priority, require_idle
    ) VALUES ('in', ?, ?, ?, 'pending', 'queued', ?, ?)
  `);
  const insertReceipt = database.prepare(`
    INSERT INTO c4_idempotent_inbound_receipts (
      idempotency_key, request_fingerprint, conversation_id, created_at
    ) VALUES (?, ?, ?, ?)
  `);

  const enqueue = database.transaction((rawRequest) => {
    const request = normalizeRequest(rawRequest);
    const requestFingerprint = fingerprint(request);
    const existing = selectReceipt.get(request.idempotencyKey);
    if (existing) {
      if (existing.request_fingerprint !== requestFingerprint) {
        throw domainError(
          'IDEMPOTENCY_CONFLICT',
          `idempotency key already belongs to another inbound wake: ${request.idempotencyKey}`,
        );
      }
      return { created: false, conversation: toConversation(existing) };
    }
    const inserted = insertConversation.run(
      request.channel,
      request.endpointId,
      request.content,
      request.priority,
      request.requireIdle ? 1 : 0,
    );
    insertReceipt.run(
      request.idempotencyKey,
      requestFingerprint,
      inserted.lastInsertRowid,
      Math.floor(Date.now() / 1_000),
    );
    return {
      created: true,
      conversation: toConversation(selectReceipt.get(request.idempotencyKey)),
    };
  });

  return Object.freeze({
    enqueue(request) {
      return enqueue.immediate(request);
    },
    query({ idempotencyKey }) {
      const row = selectReceipt.get(requireText(idempotencyKey, 'idempotencyKey'));
      return row ? { created: false, conversation: toConversation(row) } : null;
    },
    close() {
      database.close();
    },
  });
}
