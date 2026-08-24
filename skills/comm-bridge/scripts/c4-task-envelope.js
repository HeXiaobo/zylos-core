function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requireText(value, field) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`task envelope ${field} must be a non-empty string`);
  }
  return value;
}

function optionalText(value, field) {
  if (value === undefined || value === null) return null;
  return requireText(value, field);
}

export function validateTaskEnvelope(envelope) {
  if (!isRecord(envelope)) {
    throw new TypeError('task envelope must be an object');
  }
  if (!isRecord(envelope.source)) {
    throw new TypeError('task envelope source must be an object');
  }
  if (!isRecord(envelope.task)) {
    throw new TypeError('task envelope task must be an object');
  }

  const ownerId = requireText(envelope.task.ownerId, 'task.ownerId');
  return {
    idempotencyKey: requireText(envelope.idempotencyKey, 'idempotencyKey'),
    source: {
      channel: requireText(envelope.source.channel, 'source.channel'),
      externalId: requireText(envelope.source.externalId, 'source.externalId'),
      senderId: optionalText(envelope.source.senderId, 'source.senderId'),
    },
    task: {
      title: requireText(envelope.task.title, 'task.title'),
      description: optionalText(envelope.task.description, 'task.description'),
      ownerId,
      acceptorId: optionalText(envelope.task.acceptorId, 'task.acceptorId') ?? ownerId,
      assigneeId: optionalText(envelope.task.assigneeId, 'task.assigneeId'),
    },
  };
}

export function parseTaskEnvelopeJson(rawJson) {
  if (typeof rawJson !== 'string' || rawJson === '') {
    throw new TypeError('task envelope JSON must be a non-empty string');
  }

  let parsed;
  try {
    parsed = JSON.parse(rawJson);
  } catch (error) {
    throw new TypeError(`task envelope JSON is invalid: ${error.message}`);
  }
  return validateTaskEnvelope(parsed);
}

export function serializeTaskEnvelope(envelope) {
  return JSON.stringify(validateTaskEnvelope(envelope));
}
