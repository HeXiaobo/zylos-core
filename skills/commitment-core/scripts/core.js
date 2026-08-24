import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';

function defaultDbPath() {
  const zylosDir = process.env.ZYLOS_DIR || path.join(os.homedir(), 'zylos');
  return path.join(zylosDir, 'commitments', 'commitments.db');
}

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

function toEventView(row) {
  return {
    id: row.id,
    type: row.event_type,
    taskId: row.task_id,
    actorId: row.actor_id,
    fromState: row.from_state,
    toState: row.to_state,
    version: row.task_version,
    occurredAt: row.occurred_at,
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

function domainError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

const COMMAND_DEFINITIONS = Object.freeze({
  StartTask: {
    fromStates: ['ready'],
    toState: 'in_progress',
    eventType: 'TaskStarted',
    authorize(task, actorId) {
      return actorId === (task.assigneeId ?? task.ownerId);
    },
  },
  SubmitForReview: {
    fromStates: ['in_progress'],
    toState: 'review',
    eventType: 'TaskSubmittedForReview',
    authorize(task, actorId) {
      return actorId === (task.assigneeId ?? task.ownerId);
    },
  },
  AcceptTask: {
    fromStates: ['review'],
    toState: 'done',
    eventType: 'TaskAccepted',
    authorize(task, actorId) {
      return actorId === task.acceptorId;
    },
  },
  RequestChanges: {
    fromStates: ['review'],
    toState: 'ready',
    eventType: 'TaskChangesRequested',
    authorize(task, actorId) {
      return actorId === task.acceptorId;
    },
  },
  CancelTask: {
    fromStates: ['ready', 'in_progress', 'review'],
    toState: 'cancelled',
    eventType: 'TaskCancelled',
    authorize(task, actorId) {
      return actorId === task.ownerId || actorId === task.acceptorId;
    },
  },
  ReopenTask: {
    fromStates: ['done'],
    toState: 'ready',
    eventType: 'TaskReopened',
    authorize(task, actorId) {
      return actorId === task.ownerId || actorId === task.acceptorId;
    },
  },
});

const TASK_STATES = new Set(['ready', 'in_progress', 'review', 'done', 'cancelled']);
const DEFAULT_QUERY_LIMIT = 50;
const MAX_QUERY_LIMIT = 100;

function normalizeCommand(command) {
  if (!command || typeof command !== 'object') {
    throw new TypeError('command must be an object');
  }
  const type = requireText(command.type, 'command.type');
  if (!COMMAND_DEFINITIONS[type]) {
    throw domainError('INVALID_COMMAND', `unsupported command type: ${type}`);
  }
  return {
    type,
    taskId: requireText(command.taskId, 'command.taskId'),
    actorId: requireText(command.actorId, 'command.actorId'),
    idempotencyKey: requireText(command.idempotencyKey, 'command.idempotencyKey'),
  };
}

function normalizeExpectedVersion(expectedVersion) {
  if (!Number.isInteger(expectedVersion) || expectedVersion < 1) {
    throw new TypeError('expectedVersion must be a positive integer');
  }
  return expectedVersion;
}

function rejectUnknownQueryFields(query, allowedFields) {
  const unknown = Object.keys(query).filter((field) => !allowedFields.has(field));
  if (unknown.length > 0) {
    throw new TypeError(`unsupported query field: ${unknown[0]}`);
  }
}

function normalizeQuery(query) {
  if (!query || typeof query !== 'object' || Array.isArray(query)) {
    throw new TypeError('query must be an object');
  }

  if (Object.hasOwn(query, 'taskId')) {
    rejectUnknownQueryFields(query, new Set(['taskId', 'includeEvents']));
    if (query.includeEvents !== undefined && typeof query.includeEvents !== 'boolean') {
      throw new TypeError('includeEvents must be a boolean');
    }
    return {
      mode: 'task',
      taskId: requireText(query.taskId, 'taskId'),
      includeEvents: query.includeEvents ?? false,
    };
  }

  rejectUnknownQueryFields(query, new Set(['states', 'ownerId', 'assigneeId', 'limit']));
  let states = null;
  if (query.states !== undefined) {
    if (!Array.isArray(query.states) || query.states.length === 0) {
      throw new TypeError('states must be a non-empty array');
    }
    states = [...new Set(query.states.map((state) => requireText(state, 'states item')))];
    const invalidState = states.find((state) => !TASK_STATES.has(state));
    if (invalidState) throw new TypeError(`invalid task state: ${invalidState}`);
  }

  const limit = query.limit ?? DEFAULT_QUERY_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_QUERY_LIMIT) {
    throw new TypeError(`limit must be an integer between 1 and ${MAX_QUERY_LIMIT}`);
  }

  return {
    mode: 'list',
    states,
    ownerId: query.ownerId === undefined ? null : requireText(query.ownerId, 'ownerId'),
    assigneeId: query.assigneeId === undefined
      ? null
      : requireText(query.assigneeId, 'assigneeId'),
    limit,
  };
}

const TASK_TABLE_COLUMNS = `
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT,
  state TEXT NOT NULL CHECK (
    state IN ('ready', 'in_progress', 'review', 'done', 'cancelled')
  ),
  owner_id TEXT NOT NULL,
  acceptor_id TEXT NOT NULL,
  assignee_id TEXT,
  version INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
`;

const EVENT_TABLE_COLUMNS = `
  id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  task_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  from_state TEXT,
  to_state TEXT NOT NULL,
  task_version INTEGER NOT NULL,
  occurred_at TEXT NOT NULL,
  FOREIGN KEY (task_id) REFERENCES commitment_tasks(id) ON DELETE RESTRICT
`;

function createTaskTableSql(tableName, { ifNotExists = false } = {}) {
  const existenceClause = ifNotExists ? 'IF NOT EXISTS ' : '';
  return `CREATE TABLE ${existenceClause}${tableName} (${TASK_TABLE_COLUMNS})`;
}

function createEventTableSql(tableName, { ifNotExists = false } = {}) {
  const existenceClause = ifNotExists ? 'IF NOT EXISTS ' : '';
  return `CREATE TABLE ${existenceClause}${tableName} (${EVENT_TABLE_COLUMNS})`;
}

function migrateLegacyTaskStateSchema(database) {
  const taskTable = database.prepare(`
    SELECT sql
    FROM sqlite_master
    WHERE type = 'table' AND name = 'commitment_tasks'
  `).get();
  if (!taskTable || taskTable.sql.includes("'in_progress'")) return;

  const migrate = database.transaction(() => {
    database.exec(`
      ${createTaskTableSql('commitment_tasks_migrated')};
      INSERT INTO commitment_tasks_migrated (
        id, title, description, state, owner_id, acceptor_id, assignee_id,
        version, created_at, updated_at
      )
      SELECT id, title, description, state, owner_id, acceptor_id, assignee_id,
             version, created_at, updated_at
      FROM commitment_tasks;
      DROP TABLE commitment_tasks;
      ALTER TABLE commitment_tasks_migrated RENAME TO commitment_tasks;
    `);

    const violations = database.pragma('foreign_key_check');
    if (violations.length > 0) {
      throw new Error('commitment schema migration violated foreign keys');
    }
  });

  database.pragma('foreign_keys = OFF');
  try {
    migrate.immediate();
  } finally {
    database.pragma('foreign_keys = ON');
  }
}

function migrateLegacyEventSchema(database) {
  const fromState = database.pragma('table_info(commitment_events)')
    .find((column) => column.name === 'from_state');
  if (!fromState || fromState.notnull === 0) return;

  const migrate = database.transaction(() => {
    database.exec(`
      ${createEventTableSql('commitment_events_migrated')};
      INSERT INTO commitment_events_migrated (
        id, event_type, task_id, actor_id, from_state, to_state,
        task_version, occurred_at
      )
      SELECT id, event_type, task_id, actor_id, from_state, to_state,
             task_version, occurred_at
      FROM commitment_events;
      DROP TABLE commitment_events;
      ALTER TABLE commitment_events_migrated RENAME TO commitment_events;
    `);

    const violations = database.pragma('foreign_key_check');
    if (violations.length > 0) {
      throw new Error('commitment event migration violated foreign keys');
    }
  });

  database.pragma('foreign_keys = OFF');
  try {
    migrate.immediate();
  } finally {
    database.pragma('foreign_keys = ON');
  }
}

function backfillCreationEvents(database, eventIdGenerator) {
  const legacyTasks = database.prepare(`
    SELECT t.id, t.owner_id, t.created_at,
           COALESCE(
             (
               SELECT COALESCE(s.sender_id, t.owner_id)
               FROM commitment_sources s
               WHERE s.task_id = t.id
               ORDER BY s.created_at, s.idempotency_key
               LIMIT 1
             ),
             t.owner_id
           ) AS actor_id
    FROM commitment_tasks t
    WHERE NOT EXISTS (
      SELECT 1
      FROM commitment_events e
      WHERE e.task_id = t.id AND e.task_version = 1
    )
    ORDER BY t.created_at, t.id
  `).all();
  if (legacyTasks.length === 0) return;

  const insertCreationEvent = database.prepare(`
    INSERT INTO commitment_events (
      id, event_type, task_id, actor_id, from_state, to_state,
      task_version, occurred_at
    ) VALUES (?, 'TaskCreated', ?, ?, NULL, 'ready', 1, ?)
  `);
  const backfill = database.transaction(() => {
    for (const task of legacyTasks) {
      insertCreationEvent.run(
        requireText(eventIdGenerator(), 'generated event id'),
        task.id,
        task.actor_id,
        task.created_at,
      );
    }
  });
  backfill.immediate();
}

function initializeSchema(database) {
  database.exec(`
    ${createTaskTableSql('commitment_tasks', { ifNotExists: true })};

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

    ${createEventTableSql('commitment_events', { ifNotExists: true })};

    CREATE INDEX IF NOT EXISTS idx_commitment_events_task_version
      ON commitment_events(task_id, task_version);

    CREATE UNIQUE INDEX IF NOT EXISTS uq_commitment_events_task_version
      ON commitment_events(task_id, task_version);

    CREATE TABLE IF NOT EXISTS commitment_commands (
      idempotency_key TEXT PRIMARY KEY,
      request_fingerprint TEXT NOT NULL,
      task_id TEXT NOT NULL,
      result_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (task_id) REFERENCES commitment_tasks(id) ON DELETE RESTRICT
    );
  `);
}

/**
 * Open the durable Commitment Core Module.
 *
 * Callers interact only through ingest/command/query. SQLite transactions,
 * schema migration, deduplication, events, and persistence remain inside the
 * Module.
 */
export function openCommitmentCore({
  dbPath = defaultDbPath(),
  clock = () => new Date().toISOString(),
  idGenerator = () => `task-${randomUUID()}`,
  eventIdGenerator = () => `event-${randomUUID()}`,
} = {}) {
  if (dbPath !== ':memory:') mkdirSync(path.dirname(dbPath), { recursive: true });

  const database = new Database(dbPath);
  database.pragma('busy_timeout = 5000');
  if (dbPath !== ':memory:') database.pragma('journal_mode = WAL');
  migrateLegacyTaskStateSchema(database);
  migrateLegacyEventSchema(database);
  database.pragma('foreign_keys = ON');
  initializeSchema(database);
  backfillCreationEvents(database, eventIdGenerator);

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
  const selectEvents = database.prepare(`
    SELECT id, event_type, task_id, actor_id, from_state, to_state,
           task_version, occurred_at
    FROM commitment_events
    WHERE task_id = ?
    ORDER BY task_version, id
  `);
  const selectCommand = database.prepare(`
    SELECT request_fingerprint, result_json
    FROM commitment_commands
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
  const updateTaskState = database.prepare(`
    UPDATE commitment_tasks
    SET state = ?, version = version + 1, updated_at = ?
    WHERE id = ? AND version = ?
  `);
  const insertEvent = database.prepare(`
    INSERT INTO commitment_events (
      id, event_type, task_id, actor_id, from_state, to_state,
      task_version, occurred_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertCommand = database.prepare(`
    INSERT INTO commitment_commands (
      idempotency_key, request_fingerprint, task_id, result_json, created_at
    ) VALUES (?, ?, ?, ?, ?)
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
    const task = toTaskView(selectTask.get(taskId));
    insertEvent.run(
      requireText(eventIdGenerator(), 'generated event id'),
      'TaskCreated',
      task.id,
      envelope.source.senderId ?? task.ownerId,
      null,
      task.state,
      task.version,
      timestamp,
    );

    return { created: true, task };
  });

  const commandTransaction = database.transaction((rawCommand, rawExpectedVersion) => {
    const command = normalizeCommand(rawCommand);
    const expectedVersion = normalizeExpectedVersion(rawExpectedVersion);
    const fingerprint = fingerprintEnvelope({ command, expectedVersion });
    const receipt = selectCommand.get(command.idempotencyKey);
    if (receipt) {
      if (receipt.request_fingerprint !== fingerprint) {
        throw idempotencyConflict(command.idempotencyKey);
      }
      return JSON.parse(receipt.result_json);
    }

    const task = toTaskView(selectTask.get(command.taskId));
    if (!task) {
      throw domainError('TASK_NOT_FOUND', `task not found: ${command.taskId}`);
    }
    if (task.version !== expectedVersion) {
      throw domainError(
        'VERSION_CONFLICT',
        `expected task version ${expectedVersion}, found ${task.version}`,
      );
    }

    const definition = COMMAND_DEFINITIONS[command.type];
    if (!definition.fromStates.includes(task.state)) {
      throw domainError(
        'INVALID_TRANSITION',
        `${command.type} cannot be applied from ${task.state}`,
      );
    }
    if (!definition.authorize(task, command.actorId)) {
      throw domainError('FORBIDDEN', `${command.actorId} cannot apply ${command.type}`);
    }

    const timestamp = requireText(clock(), 'clock result');
    updateTaskState.run(definition.toState, timestamp, task.id, expectedVersion);
    const updatedTask = toTaskView(selectTask.get(task.id));
    const event = {
      id: requireText(eventIdGenerator(), 'generated event id'),
      type: definition.eventType,
      taskId: task.id,
      actorId: command.actorId,
      fromState: task.state,
      toState: updatedTask.state,
      version: updatedTask.version,
      occurredAt: timestamp,
    };
    insertEvent.run(
      event.id,
      event.type,
      event.taskId,
      event.actorId,
      event.fromState,
      event.toState,
      event.version,
      event.occurredAt,
    );
    const result = { task: updatedTask, event };
    insertCommand.run(
      command.idempotencyKey,
      fingerprint,
      task.id,
      JSON.stringify(result),
      timestamp,
    );
    return result;
  });

  return Object.freeze({
    ingest(envelope) {
      return ingestTransaction.immediate(envelope);
    },
    command(command, expectedVersion) {
      return commandTransaction.immediate(command, expectedVersion);
    },
    query(query = {}) {
      const normalized = normalizeQuery(query);
      if (normalized.mode === 'list') {
        const clauses = [];
        const values = [];
        if (normalized.states) {
          clauses.push(`state IN (${normalized.states.map(() => '?').join(', ')})`);
          values.push(...normalized.states);
        }
        if (normalized.ownerId) {
          clauses.push('owner_id = ?');
          values.push(normalized.ownerId);
        }
        if (normalized.assigneeId) {
          clauses.push('assignee_id = ?');
          values.push(normalized.assigneeId);
        }
        const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
        return database.prepare(`
          SELECT id, title, description, state, owner_id, acceptor_id, assignee_id,
                 version, created_at, updated_at
          FROM commitment_tasks
          ${where}
          ORDER BY updated_at DESC, id ASC
          LIMIT ?
        `).all(...values, normalized.limit).map(toTaskView);
      }

      const task = toTaskView(selectTask.get(normalized.taskId));
      if (!normalized.includeEvents) return task;
      return {
        task,
        events: selectEvents.all(normalized.taskId).map(toEventView),
      };
    },
    close() {
      database.close();
    },
  });
}
