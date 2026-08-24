const COMMAND_TYPE_BY_EVENT = Object.freeze({
  work_started: 'StartTask',
  deliverable_submitted: 'SubmitForReview',
  completed: 'SubmitForReview',
  done: 'SubmitForReview',
  succeeded: 'SubmitForReview',
});
const EVENT_FIELDS = Object.freeze([
  'backend',
  'eventId',
  'eventType',
  'taskId',
  'actorId',
  'expectedVersion',
]);
const BACKEND_ID = /^[a-z0-9][a-z0-9._-]*$/;

function requireExecutionEvent(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('external execution event must be an object');
  }
  const keys = Object.keys(value);
  if (
    keys.length !== EVENT_FIELDS.length
    || !EVENT_FIELDS.every((field) => Object.hasOwn(value, field))
  ) {
    throw new TypeError('external execution event has unsupported fields');
  }
  return value;
}

function requireText(value, field) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`${field} must be a non-empty string`);
  }
  return value;
}

function requireBackend(value) {
  const backend = requireText(value, 'backend');
  if (!BACKEND_ID.test(backend)) {
    throw new TypeError('backend must be a canonical lowercase identifier');
  }
  return backend;
}

function requireExpectedVersion(value) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError('expectedVersion must be a positive integer');
  }
  return value;
}

/**
 * Map a normalized external execution event to the Commitment Core command
 * Interface. Platform-specific payload parsing stays outside this Adapter.
 */
export function mapExternalExecutionEvent(event) {
  const normalizedEvent = requireExecutionEvent(event);
  const backend = requireBackend(normalizedEvent.backend);
  const eventId = requireText(normalizedEvent.eventId, 'eventId');
  const eventType = requireText(normalizedEvent.eventType, 'eventType');
  if (!Object.hasOwn(COMMAND_TYPE_BY_EVENT, eventType)) {
    throw new TypeError(`eventType is not supported: ${eventType}`);
  }
  const taskId = requireText(normalizedEvent.taskId, 'taskId');
  const actorId = requireText(normalizedEvent.actorId, 'actorId');
  const expectedVersion = requireExpectedVersion(normalizedEvent.expectedVersion);

  return {
    command: {
      type: COMMAND_TYPE_BY_EVENT[eventType],
      taskId,
      actorId,
      idempotencyKey: `${backend}:${eventId}:task-command`,
    },
    expectedVersion,
  };
}
