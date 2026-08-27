import { createHash } from 'node:crypto';

const MAX_ID_LENGTH = 512;

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

function requireText(value, field) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`${field} must be a non-empty string`);
  }
  if (Array.from(value).length > MAX_ID_LENGTH) {
    throw new TypeError(`${field} exceeds ${MAX_ID_LENGTH} characters`);
  }
  return value;
}

function normalizeCommand(rawCommand) {
  const command = requireRecord(rawCommand, 'subscription command');
  rejectUnknownFields(
    command,
    new Set(['taskId', 'subscriberId', 'actorId', 'idempotencyKey']),
    'subscription command',
  );
  return {
    taskId: requireText(command.taskId, 'subscription command.taskId'),
    subscriberId: requireText(command.subscriberId, 'subscription command.subscriberId'),
    actorId: requireText(command.actorId, 'subscription command.actorId'),
    idempotencyKey: requireText(
      command.idempotencyKey,
      'subscription command.idempotencyKey',
    ),
  };
}

function normalizeQuery(rawQuery) {
  const query = requireRecord(rawQuery, 'subscription query');
  rejectUnknownFields(query, new Set(['taskId']), 'subscription query');
  return { taskId: requireText(query.taskId, 'subscription query.taskId') };
}

function fingerprint(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function domainError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function toSubscription(row) {
  return {
    subscriberId: row.subscriber_id,
    subscribedAt: row.subscribed_at,
    subscribedBy: row.subscribed_by,
  };
}

export function initializeTaskSubscriptionSchema(database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS commitment_task_subscriptions (
      task_id TEXT NOT NULL,
      subscriber_id TEXT NOT NULL,
      subscribed_at TEXT NOT NULL,
      subscribed_by TEXT NOT NULL,
      PRIMARY KEY (task_id, subscriber_id),
      FOREIGN KEY (task_id) REFERENCES commitment_tasks(id) ON DELETE RESTRICT
    );

    CREATE TABLE IF NOT EXISTS commitment_task_subscription_receipts (
      idempotency_key TEXT PRIMARY KEY,
      request_fingerprint TEXT NOT NULL,
      task_id TEXT NOT NULL,
      result_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (task_id) REFERENCES commitment_tasks(id) ON DELETE RESTRICT
    );

    CREATE INDEX IF NOT EXISTS idx_commitment_task_subscriptions_task
      ON commitment_task_subscriptions(task_id, subscriber_id);
  `);
}

export function createTaskSubscriptionModule({ database, clock, taskStore }) {
  const selectReceipt = database.prepare(`
    SELECT request_fingerprint, result_json
    FROM commitment_task_subscription_receipts
    WHERE idempotency_key = ?
  `);
  const insertReceipt = database.prepare(`
    INSERT INTO commitment_task_subscription_receipts (
      idempotency_key, request_fingerprint, task_id, result_json, created_at
    ) VALUES (?, ?, ?, ?, ?)
  `);
  const selectSubscription = database.prepare(`
    SELECT subscriber_id, subscribed_at, subscribed_by
    FROM commitment_task_subscriptions
    WHERE task_id = ? AND subscriber_id = ?
  `);
  const selectSubscriptions = database.prepare(`
    SELECT subscriber_id, subscribed_at, subscribed_by
    FROM commitment_task_subscriptions
    WHERE task_id = ?
    ORDER BY subscriber_id
  `);
  const insertSubscription = database.prepare(`
    INSERT INTO commitment_task_subscriptions (
      task_id, subscriber_id, subscribed_at, subscribed_by
    ) VALUES (?, ?, ?, ?)
  `);
  const deleteSubscription = database.prepare(`
    DELETE FROM commitment_task_subscriptions
    WHERE task_id = ? AND subscriber_id = ?
  `);

  function replayReceipt(command, requestFingerprint) {
    const receipt = selectReceipt.get(command.idempotencyKey);
    if (!receipt) return null;
    if (receipt.request_fingerprint !== requestFingerprint) {
      throw domainError(
        'IDEMPOTENCY_CONFLICT',
        `subscription key already belongs to different content: ${command.idempotencyKey}`,
      );
    }
    return JSON.parse(receipt.result_json);
  }

  function authorize(command) {
    const task = taskStore.get(command.taskId);
    if (!task) throw domainError('TASK_NOT_FOUND', `task not found: ${command.taskId}`);
    if (
      command.actorId !== command.subscriberId
      && command.actorId !== task.ownerId
      && command.actorId !== task.acceptorId
    ) {
      throw domainError('FORBIDDEN', `${command.actorId} cannot manage Task subscribers`);
    }
  }

  function recordReceipt(command, requestFingerprint, result, timestamp) {
    insertReceipt.run(
      command.idempotencyKey,
      requestFingerprint,
      command.taskId,
      JSON.stringify(result),
      timestamp,
    );
  }

  const addTransaction = database.transaction((rawCommand) => {
    const command = normalizeCommand(rawCommand);
    const requestFingerprint = fingerprint({ operation: 'add', ...command });
    const replay = replayReceipt(command, requestFingerprint);
    if (replay) return replay;
    authorize(command);
    const timestamp = requireText(clock(), 'clock result');
    let subscription = selectSubscription.get(command.taskId, command.subscriberId);
    const created = !subscription;
    if (created) {
      insertSubscription.run(
        command.taskId,
        command.subscriberId,
        timestamp,
        command.actorId,
      );
      subscription = selectSubscription.get(command.taskId, command.subscriberId);
    }
    const result = { created, subscription: toSubscription(subscription) };
    recordReceipt(command, requestFingerprint, result, timestamp);
    return result;
  });

  const removeTransaction = database.transaction((rawCommand) => {
    const command = normalizeCommand(rawCommand);
    const requestFingerprint = fingerprint({ operation: 'remove', ...command });
    const replay = replayReceipt(command, requestFingerprint);
    if (replay) return replay;
    authorize(command);
    const timestamp = requireText(clock(), 'clock result');
    const removed = deleteSubscription.run(command.taskId, command.subscriberId).changes === 1;
    const result = { removed, subscriberId: command.subscriberId };
    recordReceipt(command, requestFingerprint, result, timestamp);
    return result;
  });

  return Object.freeze({
    add(command) {
      return addTransaction.immediate(command);
    },
    remove(command) {
      return removeTransaction.immediate(command);
    },
    resolve(rawQuery) {
      const query = normalizeQuery(rawQuery);
      if (!taskStore.get(query.taskId)) {
        throw domainError('TASK_NOT_FOUND', `task not found: ${query.taskId}`);
      }
      return selectSubscriptions.all(query.taskId).map(toSubscription);
    },
  });
}
