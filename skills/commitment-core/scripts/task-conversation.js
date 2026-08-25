import { createHash, randomUUID } from 'node:crypto';

const COMMAND_TYPES = Object.freeze({
  AddComment: 'CommentAdded',
  ReviseComment: 'CommentRevised',
  DeleteComment: 'CommentDeleted',
});
const DEFAULT_QUERY_LIMIT = 50;
const MAX_QUERY_LIMIT = 100;
const MAX_ID_LENGTH = 512;
const MAX_BODY_LENGTH = 20_000;

function requireRecord(value, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${field} must be an object`);
  }
  return value;
}

function rejectUnknownFields(value, allowed, field) {
  const unknown = Object.keys(value).find((key) => !allowed.has(key));
  if (unknown) throw new TypeError(`${field} contains unsupported field: ${unknown}`);
}

function requireText(value, field, maxLength = MAX_ID_LENGTH) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`${field} must be a non-empty string`);
  }
  if (Array.from(value).length > maxLength) {
    throw new TypeError(`${field} exceeds ${maxLength} characters`);
  }
  return value;
}

function optionalText(value, field, maxLength = MAX_ID_LENGTH) {
  if (value === undefined || value === null) return null;
  return requireText(value, field, maxLength);
}

function requireInstant(value, field) {
  const text = requireText(value, field, 64);
  const parsed = new Date(text);
  if (!Number.isFinite(parsed.valueOf()) || parsed.toISOString() !== text) {
    throw new TypeError(`${field} must be a canonical ISO-8601 instant`);
  }
  return text;
}

function domainError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function fingerprint(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function normalizeCommand(rawCommand) {
  const command = requireRecord(rawCommand, 'conversation command');
  const type = requireText(command.type, 'conversation command.type', 64);
  if (!COMMAND_TYPES[type]) {
    throw domainError('INVALID_COMMENT_COMMAND', `unsupported comment command: ${type}`);
  }
  const allowed = new Set([
    'type',
    'taskId',
    'commentId',
    'actorId',
    'replyToCommentId',
    'occurredAt',
    'idempotencyKey',
  ]);
  if (type !== 'DeleteComment') allowed.add('body');
  rejectUnknownFields(command, allowed, 'conversation command');
  const normalized = {
    type,
    taskId: requireText(command.taskId, 'conversation command.taskId'),
    commentId: requireText(command.commentId, 'conversation command.commentId'),
    actorId: requireText(command.actorId, 'conversation command.actorId'),
    replyToCommentId: optionalText(
      command.replyToCommentId,
      'conversation command.replyToCommentId',
    ),
    body: type === 'DeleteComment'
      ? null
      : requireText(command.body, 'conversation command.body', MAX_BODY_LENGTH),
    occurredAt: requireInstant(command.occurredAt, 'conversation command.occurredAt'),
    idempotencyKey: requireText(
      command.idempotencyKey,
      'conversation command.idempotencyKey',
    ),
  };
  if (normalized.replyToCommentId === normalized.commentId) {
    throw new TypeError('a comment cannot reply to itself');
  }
  return normalized;
}

function normalizeQuery(rawQuery) {
  const query = requireRecord(rawQuery, 'conversation query');
  rejectUnknownFields(
    query,
    new Set(['taskId', 'commentId', 'includeHistory', 'limit']),
    'conversation query',
  );
  if (query.includeHistory !== undefined && typeof query.includeHistory !== 'boolean') {
    throw new TypeError('conversation query.includeHistory must be a boolean');
  }
  const limit = query.limit ?? DEFAULT_QUERY_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_QUERY_LIMIT) {
    throw new TypeError(`conversation query.limit must be between 1 and ${MAX_QUERY_LIMIT}`);
  }
  return {
    taskId: requireText(query.taskId, 'conversation query.taskId'),
    commentId: optionalText(query.commentId, 'conversation query.commentId'),
    includeHistory: query.includeHistory ?? false,
    limit,
  };
}

function toEventView(row) {
  if (!row) return null;
  return {
    id: row.id,
    type: row.event_type,
    taskId: row.task_id,
    commentId: row.comment_id,
    actorId: row.actor_id,
    body: row.body,
    replyToCommentId: row.reply_to_comment_id,
    occurredAt: row.occurred_at,
    recordedAt: row.recorded_at,
  };
}

function toCommentView(row) {
  if (!row) return null;
  return {
    id: row.comment_id,
    taskId: row.task_id,
    actorId: row.actor_id,
    body: row.body,
    replyToCommentId: row.reply_to_comment_id,
    deleted: row.event_type === 'CommentDeleted',
    lastEventId: row.id,
    occurredAt: row.occurred_at,
  };
}

export function initializeTaskConversationSchema(database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS commitment_conversation_events (
      id TEXT PRIMARY KEY,
      event_type TEXT NOT NULL CHECK (
        event_type IN ('CommentAdded', 'CommentRevised', 'CommentDeleted')
      ),
      task_id TEXT NOT NULL,
      comment_id TEXT NOT NULL,
      actor_id TEXT NOT NULL,
      body TEXT,
      reply_to_comment_id TEXT,
      occurred_at TEXT NOT NULL,
      recorded_at TEXT NOT NULL,
      FOREIGN KEY (task_id) REFERENCES commitment_tasks(id) ON DELETE RESTRICT,
      CHECK (
        (event_type = 'CommentDeleted' AND body IS NULL)
        OR (event_type != 'CommentDeleted' AND body IS NOT NULL)
      )
    );

    CREATE INDEX IF NOT EXISTS idx_commitment_conversation_task_comment
      ON commitment_conversation_events(task_id, comment_id, occurred_at, recorded_at);

    CREATE TABLE IF NOT EXISTS commitment_conversation_receipts (
      idempotency_key TEXT PRIMARY KEY,
      request_fingerprint TEXT NOT NULL,
      event_id TEXT NOT NULL,
      result_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (event_id) REFERENCES commitment_conversation_events(id)
        ON DELETE RESTRICT
    );

    CREATE TRIGGER IF NOT EXISTS commitment_conversation_events_no_update
      BEFORE UPDATE ON commitment_conversation_events
      BEGIN
        SELECT RAISE(ABORT, 'conversation events are immutable');
      END;

    CREATE TRIGGER IF NOT EXISTS commitment_conversation_events_no_delete
      BEFORE DELETE ON commitment_conversation_events
      BEGIN
        SELECT RAISE(ABORT, 'conversation events are immutable');
      END;
  `);
}

export function createTaskConversationModule({
  database,
  clock,
  eventIdGenerator = () => `comment-event-${randomUUID()}`,
  taskStore,
}) {
  const insertEvent = database.prepare(`
    INSERT INTO commitment_conversation_events (
      id, event_type, task_id, comment_id, actor_id, body,
      reply_to_comment_id, occurred_at, recorded_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const selectReceipt = database.prepare(`
    SELECT request_fingerprint, result_json
    FROM commitment_conversation_receipts
    WHERE idempotency_key = ?
  `);
  const insertReceipt = database.prepare(`
    INSERT INTO commitment_conversation_receipts (
      idempotency_key, request_fingerprint, event_id, result_json, created_at
    ) VALUES (?, ?, ?, ?, ?)
  `);
  const selectCurrentComment = database.prepare(`
    SELECT id, event_type, task_id, comment_id, actor_id, body,
           reply_to_comment_id, occurred_at, recorded_at
    FROM commitment_conversation_events
    WHERE task_id = ? AND comment_id = ?
    ORDER BY occurred_at DESC, recorded_at DESC, id DESC
    LIMIT 1
  `);
  const selectCurrentComments = database.prepare(`
    WITH ranked AS (
      SELECT id, event_type, task_id, comment_id, actor_id, body,
             reply_to_comment_id, occurred_at, recorded_at,
             ROW_NUMBER() OVER (
               PARTITION BY comment_id
               ORDER BY occurred_at DESC, recorded_at DESC, id DESC
             ) AS position
      FROM commitment_conversation_events
      WHERE task_id = ?
    )
    SELECT id, event_type, task_id, comment_id, actor_id, body,
           reply_to_comment_id, occurred_at, recorded_at
    FROM ranked
    WHERE position = 1
    ORDER BY occurred_at, comment_id
    LIMIT ?
  `);
  const selectCommentEvents = database.prepare(`
    SELECT id, event_type, task_id, comment_id, actor_id, body,
           reply_to_comment_id, occurred_at, recorded_at
    FROM (
      SELECT id, event_type, task_id, comment_id, actor_id, body,
             reply_to_comment_id, occurred_at, recorded_at
      FROM commitment_conversation_events
      WHERE task_id = ? AND comment_id = ?
      ORDER BY occurred_at DESC, recorded_at DESC, id DESC
      LIMIT ?
    )
    ORDER BY occurred_at, recorded_at, id
  `);
  const selectTaskEvents = database.prepare(`
    SELECT id, event_type, task_id, comment_id, actor_id, body,
           reply_to_comment_id, occurred_at, recorded_at
    FROM (
      SELECT id, event_type, task_id, comment_id, actor_id, body,
             reply_to_comment_id, occurred_at, recorded_at
      FROM commitment_conversation_events
      WHERE task_id = ?
      ORDER BY occurred_at DESC, recorded_at DESC, id DESC
      LIMIT ?
    )
    ORDER BY occurred_at, recorded_at, id
  `);

  const recordTransaction = database.transaction((rawCommand) => {
    const command = normalizeCommand(rawCommand);
    const requestFingerprint = fingerprint(command);
    const receipt = selectReceipt.get(command.idempotencyKey);
    if (receipt) {
      if (receipt.request_fingerprint !== requestFingerprint) {
        throw domainError(
          'IDEMPOTENCY_CONFLICT',
          `idempotency key already belongs to different content: ${command.idempotencyKey}`,
        );
      }
      return JSON.parse(receipt.result_json);
    }
    if (!taskStore.get(command.taskId)) {
      throw domainError('TASK_NOT_FOUND', `task not found: ${command.taskId}`);
    }
    const event = {
      id: requireText(eventIdGenerator(), 'generated conversation event id'),
      type: COMMAND_TYPES[command.type],
      taskId: command.taskId,
      commentId: command.commentId,
      actorId: command.actorId,
      body: command.body,
      replyToCommentId: command.replyToCommentId,
      occurredAt: command.occurredAt,
      recordedAt: requireInstant(clock(), 'clock result'),
    };
    insertEvent.run(
      event.id,
      event.type,
      event.taskId,
      event.commentId,
      event.actorId,
      event.body,
      event.replyToCommentId,
      event.occurredAt,
      event.recordedAt,
    );
    const comment = toCommentView(selectCurrentComment.get(command.taskId, command.commentId));
    const result = { event, comment };
    insertReceipt.run(
      command.idempotencyKey,
      requestFingerprint,
      event.id,
      JSON.stringify(result),
      event.recordedAt,
    );
    return result;
  });

  return Object.freeze({
    record(command) {
      return recordTransaction.immediate(command);
    },
    query(rawQuery) {
      const query = normalizeQuery(rawQuery);
      if (!taskStore.get(query.taskId)) {
        throw domainError('TASK_NOT_FOUND', `task not found: ${query.taskId}`);
      }
      if (query.commentId) {
        const comment = toCommentView(selectCurrentComment.get(query.taskId, query.commentId));
        if (!query.includeHistory) return comment;
        return {
          comment,
          events: selectCommentEvents
            .all(query.taskId, query.commentId, query.limit)
            .map(toEventView),
        };
      }
      const comments = selectCurrentComments.all(query.taskId, query.limit).map(toCommentView);
      if (!query.includeHistory) return comments;
      return {
        comments,
        events: selectTaskEvents.all(query.taskId, query.limit).map(toEventView),
      };
    },
  });
}
