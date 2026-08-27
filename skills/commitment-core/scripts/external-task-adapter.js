const EVENT_FIELDS = Object.freeze([
  'backend',
  'eventId',
  'eventType',
  'taskId',
  'actorId',
  'expectedVersion',
]);
const BACKEND_ID = /^[a-z0-9][a-z0-9._-]*$/;

function requireEvent(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('external task event must be an object');
  }
  const keys = Object.keys(value);
  if (
    keys.length !== EVENT_FIELDS.length
    || !EVENT_FIELDS.every((field) => Object.hasOwn(value, field))
  ) {
    throw new TypeError('external task event has unsupported fields');
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
 * Map an authenticated native task event to a Core command. A platform's
 * completion affordance submits work for human review; acceptance remains an
 * explicit Acceptor-only Core command and is intentionally not representable
 * through this Interface.
 */
export function mapExternalTaskEvent(rawEvent) {
  const event = requireEvent(rawEvent);
  const backend = requireBackend(event.backend);
  const eventId = requireText(event.eventId, 'eventId');
  const eventType = requireText(event.eventType, 'eventType');
  if (eventType !== 'completed') {
    throw new TypeError(`eventType is not supported: ${eventType}`);
  }
  const taskId = requireText(event.taskId, 'taskId');
  const actorId = requireText(event.actorId, 'actorId');
  const expectedVersion = requireExpectedVersion(event.expectedVersion);

  return {
    command: {
      type: 'SubmitForReview',
      taskId,
      actorId,
      idempotencyKey: `${backend}:${eventId}:task-command`,
    },
    expectedVersion,
  };
}
