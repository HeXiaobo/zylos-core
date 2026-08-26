import { createHash } from 'node:crypto';

const NOTIFICATION_KINDS = new Set([
  'review',
  'blocked',
  'failed',
  'overdue',
  'action_required',
  'progress',
]);
const MAX_ID_LENGTH = 512;
const COALESCE_WINDOW_MS = 30_000;

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

function optionalText(value, field) {
  if (value === undefined || value === null) return null;
  return requireText(value, field);
}

function domainError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function fingerprint(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function audienceForTask(task, conversation, subscriptions) {
  const roles = new Map();
  const add = (recipientId, role) => {
    if (!recipientId) return;
    const current = roles.get(recipientId) ?? [];
    if (!current.includes(role)) current.push(role);
    roles.set(recipientId, current);
  };
  add(task.ownerId, 'owner');
  add(task.acceptorId, 'acceptor');
  add(task.assigneeId, 'assignee');
  for (const { participantId } of conversation.participants({ taskId: task.id })) {
    add(participantId, 'participant');
  }
  for (const subscription of subscriptions.resolve({ taskId: task.id })) {
    add(subscription.subscriberId, 'subscriber');
  }
  return [...roles.entries()].map(([recipientId, recipientRoles]) => ({
    recipientId,
    roles: recipientRoles,
  }));
}

function normalizeAudienceQuery(rawQuery) {
  const query = requireRecord(rawQuery, 'audience query');
  rejectUnknownFields(query, new Set(['taskId']), 'audience query');
  return { taskId: requireText(query.taskId, 'audience query.taskId') };
}

function normalizeAudienceMembershipQuery(rawQuery) {
  const query = requireRecord(rawQuery, 'audience membership query');
  rejectUnknownFields(
    query,
    new Set(['taskId', 'recipientId']),
    'audience membership query',
  );
  return {
    taskId: requireText(query.taskId, 'audience membership query.taskId'),
    recipientId: requireText(query.recipientId, 'audience membership query.recipientId'),
  };
}

function normalizeDecision(rawInput) {
  const input = requireRecord(rawInput, 'notification decision');
  rejectUnknownFields(
    input,
    new Set(['taskId', 'eventId', 'kind', 'actorId', 'targetIds']),
    'notification decision',
  );
  const kind = requireText(input.kind, 'notification decision.kind');
  if (!NOTIFICATION_KINDS.has(kind)) {
    throw domainError('INVALID_NOTIFICATION_KIND', `unsupported notification kind: ${kind}`);
  }
  let targetIds = null;
  if (input.targetIds !== undefined) {
    if (!Array.isArray(input.targetIds) || input.targetIds.length === 0) {
      throw new TypeError('notification decision.targetIds must be a non-empty array');
    }
    targetIds = [...new Set(input.targetIds.map((target, index) => (
      requireText(target, `notification decision.targetIds[${index}]`)
    )))];
  }
  if (kind === 'action_required' && !targetIds) {
    throw new TypeError('action_required notifications require targetIds');
  }
  if (kind !== 'action_required' && targetIds) {
    throw new TypeError('targetIds are supported only for action_required notifications');
  }
  return {
    taskId: requireText(input.taskId, 'notification decision.taskId'),
    eventId: requireText(input.eventId, 'notification decision.eventId'),
    kind,
    actorId: optionalText(input.actorId, 'notification decision.actorId'),
    targetIds,
  };
}

function normalizeDecisionQuery(rawQuery) {
  const query = requireRecord(rawQuery, 'notification query');
  rejectUnknownFields(query, new Set(['eventId']), 'notification query');
  return { eventId: requireText(query.eventId, 'notification query.eventId') };
}

function deliveryAttributes(kind) {
  if (kind === 'review') {
    return {
      reason: 'review_required',
      urgency: 'high',
      deliveryMode: 'immediate',
      coalesceWindowMs: 0,
    };
  }
  if (kind === 'action_required') {
    return {
      reason: 'action_required',
      urgency: 'high',
      deliveryMode: 'immediate',
      coalesceWindowMs: 0,
    };
  }
  return {
    reason: kind,
    urgency: kind === 'failed' || kind === 'overdue' ? 'high' : 'normal',
    deliveryMode: 'coalesce',
    coalesceWindowMs: COALESCE_WINDOW_MS,
  };
}

export function createTaskAudienceModule({ taskStore, conversation, subscriptions }) {
  return Object.freeze({
    resolve(rawQuery) {
      const query = normalizeAudienceQuery(rawQuery);
      const task = taskStore.get(query.taskId);
      if (!task) throw domainError('TASK_NOT_FOUND', `task not found: ${query.taskId}`);
      return audienceForTask(task, conversation, subscriptions);
    },
    contains(rawQuery) {
      const query = normalizeAudienceMembershipQuery(rawQuery);
      const task = taskStore.get(query.taskId);
      if (!task) throw domainError('TASK_NOT_FOUND', `task not found: ${query.taskId}`);
      if ([task.ownerId, task.acceptorId, task.assigneeId].includes(query.recipientId)) {
        return true;
      }
      if (subscriptions.resolve({ taskId: task.id })
        .some(({ subscriberId }) => subscriberId === query.recipientId)) {
        return true;
      }
      return conversation.hasParticipant({
        taskId: task.id,
        participantId: query.recipientId,
      });
    },
  });
}

export function initializeTaskNotificationSchema(database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS commitment_notification_decisions (
      event_id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      request_fingerprint TEXT NOT NULL,
      result_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (task_id) REFERENCES commitment_tasks(id) ON DELETE RESTRICT
    );

    CREATE INDEX IF NOT EXISTS idx_commitment_notification_decisions_task
      ON commitment_notification_decisions(task_id, created_at, event_id);

    CREATE TRIGGER IF NOT EXISTS commitment_notification_decisions_no_update
      BEFORE UPDATE ON commitment_notification_decisions
      BEGIN
        SELECT RAISE(ABORT, 'notification decisions are immutable');
      END;

    CREATE TRIGGER IF NOT EXISTS commitment_notification_decisions_no_delete
      BEFORE DELETE ON commitment_notification_decisions
      BEGIN
        SELECT RAISE(ABORT, 'notification decisions are immutable');
      END;
  `);
}

export function createNotificationPolicyModule({ taskStore, audience, database, clock }) {
  const selectDecision = database.prepare(`
    SELECT request_fingerprint, result_json
    FROM commitment_notification_decisions
    WHERE event_id = ?
  `);
  const insertDecision = database.prepare(`
    INSERT INTO commitment_notification_decisions (
      event_id, task_id, request_fingerprint, result_json, created_at
    ) VALUES (?, ?, ?, ?, ?)
  `);

  const decideTransaction = database.transaction((rawInput) => {
    const input = normalizeDecision(rawInput);
    const requestFingerprint = fingerprint(input);
    const receipt = selectDecision.get(input.eventId);
    if (receipt) {
      if (receipt.request_fingerprint !== requestFingerprint) {
        throw domainError(
          'IDEMPOTENCY_CONFLICT',
          `notification event already belongs to different content: ${input.eventId}`,
        );
      }
      return JSON.parse(receipt.result_json);
    }
    const task = taskStore.get(input.taskId);
    if (!task) throw domainError('TASK_NOT_FOUND', `task not found: ${input.taskId}`);
    let result;
    if (input.kind === 'progress') {
      result = { eventId: input.eventId, taskId: input.taskId, kind: input.kind, deliveries: [] };
    } else {
      let recipients;
      if (input.kind === 'review') {
        recipients = [task.acceptorId];
      } else if (input.kind === 'blocked' || input.kind === 'failed' || input.kind === 'overdue') {
        recipients = [task.ownerId, task.assigneeId].filter(Boolean);
      } else {
        const invalidTarget = input.targetIds.find((targetId) => !audience.contains({
          taskId: task.id,
          recipientId: targetId,
        }));
        if (invalidTarget) {
          throw domainError(
            'INVALID_NOTIFICATION_TARGET',
            `notification target is not in the Task audience: ${invalidTarget}`,
          );
        }
        recipients = input.targetIds;
      }
      const attributes = deliveryAttributes(input.kind);
      const deliveries = [...new Set(recipients)]
        .filter((recipientId) => recipientId !== input.actorId)
        .map((recipientId) => ({
          recipientId,
          ...attributes,
          dedupeKey: `${input.eventId}:${recipientId}`,
        }));
      result = {
        eventId: input.eventId,
        taskId: input.taskId,
        kind: input.kind,
        deliveries,
      };
    }
    insertDecision.run(
      input.eventId,
      input.taskId,
      requestFingerprint,
      JSON.stringify(result),
      requireText(clock(), 'clock result'),
    );
    return result;
  });

  return Object.freeze({
    decide(rawInput) {
      return decideTransaction.immediate(rawInput);
    },
    query(rawQuery) {
      const query = normalizeDecisionQuery(rawQuery);
      const receipt = selectDecision.get(query.eventId);
      return receipt ? JSON.parse(receipt.result_json) : null;
    },
  });
}
