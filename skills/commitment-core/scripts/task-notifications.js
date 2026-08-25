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

function audienceForTask(task) {
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

export function createTaskAudienceModule({ taskStore }) {
  return Object.freeze({
    resolve(rawQuery) {
      const query = normalizeAudienceQuery(rawQuery);
      const task = taskStore.get(query.taskId);
      if (!task) throw domainError('TASK_NOT_FOUND', `task not found: ${query.taskId}`);
      return audienceForTask(task);
    },
  });
}

export function createNotificationPolicyModule({ taskStore }) {
  return Object.freeze({
    decide(rawInput) {
      const input = normalizeDecision(rawInput);
      const task = taskStore.get(input.taskId);
      if (!task) throw domainError('TASK_NOT_FOUND', `task not found: ${input.taskId}`);
      if (input.kind === 'progress') {
        return { eventId: input.eventId, taskId: input.taskId, kind: input.kind, deliveries: [] };
      }
      const audience = audienceForTask(task);
      const audienceIds = new Set(audience.map(({ recipientId }) => recipientId));
      let recipients;
      if (input.kind === 'review') {
        recipients = [task.acceptorId];
      } else if (input.kind === 'blocked' || input.kind === 'failed' || input.kind === 'overdue') {
        recipients = [task.ownerId, task.assigneeId].filter(Boolean);
      } else {
        const invalidTarget = input.targetIds.find((targetId) => !audienceIds.has(targetId));
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
      return {
        eventId: input.eventId,
        taskId: input.taskId,
        kind: input.kind,
        deliveries,
      };
    },
  });
}
