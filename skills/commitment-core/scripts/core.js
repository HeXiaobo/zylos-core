import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';

const DEFAULT_DB_PATH = path.join(os.homedir(), 'zylos', 'commitments', 'commitments.db');

function requireText(value, field) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`${field} must be a non-empty string`);
  }
  return value;
}

function optionalText(value, field) {
  if (value === undefined || value === null) return null;
  return requireText(value, field);
}

function toTaskView(row) {
  if (!row) return null;
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    state: row.state,
    ownerId: row.owner_id,
    acceptorId: row.acceptor_id,
    assigneeId: row.assignee_id,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function normalizeEnvelope(envelope) {
  if (!envelope || typeof envelope !== 'object') {
    throw new TypeError('envelope must be an object');
  }

  const source = envelope.source;
  const task = envelope.task;
  if (!source || typeof source !== 'object') throw new TypeError('source must be an object');
  if (!task || typeof task !== 'object') throw new TypeError('task must be an object');

  const ownerId = requireText(task.ownerId, 'task.ownerId');
  return {
    idempotencyKey: requireText(envelope.idempotencyKey, 'idempotencyKey'),
    source: {
      channel: requireText(source.channel, 'source.channel'),
      externalId: requireText(source.externalId, 'source.externalId'),
      senderId: optionalText(source.senderId, 'source.senderId'),
    },
    task: {
      title: requireText(task.title, 'task.title'),
      description: optionalText(task.description, 'task.description'),
      ownerId,
      acceptorId: optionalText(task.acceptorId, 'task.acceptorId') ?? ownerId,
      assigneeId: optionalText(task.assigneeId, 'task.assigneeId'),
    },
  };
}

function fingerprintEnvelope(envelope) {
  return createHash('sha256').update(JSON.stringify(envelope)).digest('hex');
}

function idempotencyConflict(key) {
  const error = new Error(`idempotency key already belongs to different content: ${key}`);
  error.code = 'IDEMPOTENCY_CONFLICT';
  return error;
}

function initializeSchema(database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS commitment_tasks (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT,
      state TEXT NOT NULL CHECK (state IN ('ready')),
      owner_id TEXT NOT NULL,
      acceptor_id TEXT NOT NULL,
      assignee_id TEXT,
      version INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS commitment_sources (
      idempotency_key TEXT PRIMARY KEY,
      channel TEXT NOT NULL,
      external_id TEXT NOT NULL,
      sender_id TEXT,
      request_fingerprint TEXT NOT NULL,
      task_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (task_id) REFERENCES commitment_tasks(id) ON DELETE RESTRICT
    );

    CREATE INDEX IF NOT EXISTS idx_commitment_sources_task
      ON commitment_sources(task_id);
  `);
}

/**
 * Open the durable Commitment Core Module.
 *
 * Callers interact only through ingest/query. SQLite transactions, schema,
 * source deduplication, and persistence remain inside the Module.
 */
export function openCommitmentCore({
  dbPath = DEFAULT_DB_PATH,
  clock = () => new Date().toISOString(),
  idGenerator = () => `task-${randomUUID()}`,
} = {}) {
  if (dbPath !== ':memory:') mkdirSync(path.dirname(dbPath), { recursive: true });

  const database = new Database(dbPath);
  database.pragma('foreign_keys = ON');
  database.pragma('busy_timeout = 5000');
  if (dbPath !== ':memory:') database.pragma('journal_mode = WAL');
  initializeSchema(database);

  const selectTask = database.prepare(`
    SELECT id, title, description, state, owner_id, acceptor_id, assignee_id,
           version, created_at, updated_at
    FROM commitment_tasks
    WHERE id = ?
  `);
  const selectTaskForSource = database.prepare(`
    SELECT task_id, request_fingerprint
    FROM commitment_sources
    WHERE idempotency_key = ?
  `);
  const insertTask = database.prepare(`
    INSERT INTO commitment_tasks (
      id, title, description, state, owner_id, acceptor_id, assignee_id,
      version, created_at, updated_at
    ) VALUES (?, ?, ?, 'ready', ?, ?, ?, 1, ?, ?)
  `);
  const insertSource = database.prepare(`
    INSERT INTO commitment_sources (
      idempotency_key, channel, external_id, sender_id, request_fingerprint,
      task_id, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  const ingestTransaction = database.transaction((rawEnvelope) => {
    const envelope = normalizeEnvelope(rawEnvelope);
    const fingerprint = fingerprintEnvelope(envelope);
    const existing = selectTaskForSource.get(envelope.idempotencyKey);
    if (existing) {
      if (existing.request_fingerprint !== fingerprint) {
        throw idempotencyConflict(envelope.idempotencyKey);
      }
      return { created: false, task: toTaskView(selectTask.get(existing.task_id)) };
    }

    const taskId = requireText(idGenerator(), 'generated task id');
    const timestamp = requireText(clock(), 'clock result');
    insertTask.run(
      taskId,
      envelope.task.title,
      envelope.task.description,
      envelope.task.ownerId,
      envelope.task.acceptorId,
      envelope.task.assigneeId,
      timestamp,
      timestamp,
    );
    insertSource.run(
      envelope.idempotencyKey,
      envelope.source.channel,
      envelope.source.externalId,
      envelope.source.senderId,
      fingerprint,
      taskId,
      timestamp,
    );

    return { created: true, task: toTaskView(selectTask.get(taskId)) };
  });

  return Object.freeze({
    ingest(envelope) {
      return ingestTransaction.immediate(envelope);
    },
    query({ taskId } = {}) {
      return toTaskView(selectTask.get(requireText(taskId, 'taskId')));
    },
    close() {
      database.close();
    },
  });
}
