import { validateInboundEnvelope } from './inbound-envelope.js';
import { resolveDueAt } from './deadline.js';
import { hasExplicitAgentAssignment } from './work-intake.js';

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
  'reminderMinutesBeforeDue',
  'riskLevel',
]);
const LEGACY_TASK_DRAFT_FIELDS = new Set(
  [...TASK_DRAFT_FIELDS].filter(field => field !== 'reminderMinutesBeforeDue'),
);

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

function normalizeTaskDraft(value) {
  const task = requireRecord(value, 'WorkIntake TaskDraft');
  const keys = Object.keys(task);
  const fields = Object.hasOwn(task, 'reminderMinutesBeforeDue')
    ? TASK_DRAFT_FIELDS
    : LEGACY_TASK_DRAFT_FIELDS;
  if (keys.length !== fields.size || keys.some(key => !fields.has(key))) {
    throw new TypeError('WorkIntake TaskDraft contains unsupported or missing fields');
  }
  return fields === TASK_DRAFT_FIELDS
    ? task
    : { ...task, reminderMinutesBeforeDue: null };
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

function optionalNonNegativeInteger(value, field) {
  if (value === null) return null;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${field} must be a non-negative safe integer or null`);
  }
  return value;
}

/**
 * Internal C4 Adapter. WorkIntake itself never invokes this function and never
 * writes Commitment Core. The adapter accepts either an automatic create or a
 * user-confirmed draft and produces the existing durable SourceEnvelope.
 */
export function toCommitmentEnvelope(input, options = {}) {
  const adapterOptions = requireRecord(options, 'WorkIntake commitment options');
  const supportedOptions = new Set([
    'confirmed',
    'defaultAssigneeId',
    'agentId',
    'agentAliases',
  ]);
  const unknownOption = Object.keys(adapterOptions).find(key => !supportedOptions.has(key));
  if (unknownOption) {
    throw new TypeError(`WorkIntake commitment options contain unsupported field: ${unknownOption}`);
  }
  const confirmed = adapterOptions.confirmed ?? false;
  if (typeof confirmed !== 'boolean') throw new TypeError('confirmed must be a boolean');
  const defaultAssigneeId = adapterOptions.defaultAssigneeId ?? null;
  const agentId = adapterOptions.agentId ?? null;
  const agentAliases = adapterOptions.agentAliases ?? [];
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
  const task = normalizeTaskDraft(decision.taskDraft);
  const sourceKey = requireText(decision.sourceKey, 'WorkIntake decision.sourceKey');
  const expectedSourceKey = `${envelope.source.channel}:${envelope.source.messageId}:work-intake:r${envelope.intentRevision}`;
  if (sourceKey !== expectedSourceKey) {
    throw new TypeError('WorkIntake decision.sourceKey does not match message_id + intent_revision');
  }
  if (task.ownerId !== envelope.sender.id || task.acceptorId !== envelope.sender.id) {
    throw new TypeError('WorkIntake owner and acceptor must be the human sender');
  }
  if (typeof task.assigneeId === 'string' && task.assigneeId.startsWith('agent:')) {
    const explicitConfiguredAgent = task.assigneeId === agentId
      && hasExplicitAgentAssignment(envelope.text, { agentId, agentAliases });
    if (!explicitConfiguredAgent && task.assigneeId !== defaultAssigneeId) {
      throw new TypeError(`${task.assigneeId} requires an explicit assignment or trusted default`);
    }
  }
  const dueAt = resolveDueAt({
    dueText: task.dueText,
    receivedAt: envelope.receivedAt,
    timeZone: envelope.timeZone,
  });
  const reminderMinutesBeforeDue = optionalNonNegativeInteger(
    task.reminderMinutesBeforeDue,
    'WorkIntake TaskDraft.reminderMinutesBeforeDue',
  );
  if (reminderMinutesBeforeDue !== null && dueAt === null) {
    throw new TypeError('WorkIntake reminder requires a resolved deadline');
  }

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
      ...(reminderMinutesBeforeDue === null ? {} : { reminderMinutesBeforeDue }),
    },
  };
}
