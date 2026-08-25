import { validateInboundEnvelope } from './inbound-envelope.js';
import { resolveDueAt } from './deadline.js';
import { hasExplicitYueranAssignment } from './work-intake.js';

const DECISION_FIELDS = new Set([
  'decision',
  'reasonCode',
  'intentRevision',
  'sourceKey',
  'taskDraft',
]);
const TASK_DRAFT_FIELDS = new Set([
  'title',
  'description',
  'ownerId',
  'acceptorId',
  'assigneeId',
  'dueText',
  'riskLevel',
]);

function requireRecord(value, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${field} must be an object`);
  }
  return value;
}

function requireExactFields(value, fields, field) {
  const keys = Object.keys(value);
  if (keys.length !== fields.size || keys.some((key) => !fields.has(key))) {
    throw new TypeError(`${field} contains unsupported or missing fields`);
  }
}

function requireText(value, field) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`${field} must be a non-empty string`);
  }
  return value;
}

function optionalText(value, field) {
  if (value === null) return null;
  return requireText(value, field);
}

/**
 * Internal C4 Adapter. WorkIntake itself never invokes this function and never
 * writes Commitment Core. The adapter accepts either an automatic create or a
 * user-confirmed draft and produces the existing durable SourceEnvelope.
 */
export function toCommitmentEnvelope(input, {
  confirmed = false,
  defaultAssigneeId = null,
} = {}) {
  const request = requireRecord(input, 'WorkIntake commitment request');
  const envelope = validateInboundEnvelope(request.envelope);
  const decision = requireRecord(request.decision, 'WorkIntake decision');
  requireExactFields(decision, DECISION_FIELDS, 'WorkIntake decision');
  if (decision.intentRevision !== envelope.intentRevision) {
    throw new TypeError('WorkIntake decision intentRevision does not match the envelope');
  }
  if (decision.decision !== 'create_task' && !(confirmed && decision.decision === 'confirm')) {
    throw new TypeError('WorkIntake decision cannot create a Commitment task');
  }
  const task = requireRecord(decision.taskDraft, 'WorkIntake TaskDraft');
  requireExactFields(task, TASK_DRAFT_FIELDS, 'WorkIntake TaskDraft');
  const sourceKey = requireText(decision.sourceKey, 'WorkIntake decision.sourceKey');
  const expectedSourceKey = `${envelope.source.channel}:${envelope.source.messageId}:work-intake:r${envelope.intentRevision}`;
  if (sourceKey !== expectedSourceKey) {
    throw new TypeError('WorkIntake decision.sourceKey does not match message_id + intent_revision');
  }
  if (task.ownerId !== envelope.sender.id || task.acceptorId !== envelope.sender.id) {
    throw new TypeError('WorkIntake owner and acceptor must be the human sender');
  }
  if (
    task.assigneeId === 'agent:yueran'
    && !hasExplicitYueranAssignment(envelope.text)
    && defaultAssigneeId !== 'agent:yueran'
  ) {
    throw new TypeError('agent:yueran requires an explicit assignment or trusted default');
  }
  const dueAt = resolveDueAt({
    dueText: task.dueText,
    receivedAt: envelope.receivedAt,
    timeZone: envelope.timeZone,
  });

  return {
    idempotencyKey: sourceKey,
    source: {
      channel: envelope.source.channel,
      externalId: envelope.source.messageId,
      senderId: envelope.sender.id,
    },
    task: {
      title: requireText(task.title, 'WorkIntake TaskDraft.title'),
      description: optionalText(task.description, 'WorkIntake TaskDraft.description'),
      ownerId: requireText(task.ownerId, 'WorkIntake TaskDraft.ownerId'),
      acceptorId: requireText(task.acceptorId, 'WorkIntake TaskDraft.acceptorId'),
      assigneeId: optionalText(task.assigneeId, 'WorkIntake TaskDraft.assigneeId'),
      ...(dueAt === null ? {} : { dueAt }),
    },
  };
}
