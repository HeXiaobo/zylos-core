const TOP_LEVEL_FIELDS = new Set([
  'source',
  'sender',
  'text',
  'intentRevision',
  'receivedAt',
  'timeZone',
  'people',
]);
const SOURCE_FIELDS = new Set([
  'channel',
  'messageId',
  'conversationId',
  'conversationType',
  'threadId',
]);
const SENDER_FIELDS = new Set(['id', 'kind']);
const PERSON_FIELDS = new Set(['name', 'id', 'candidateIds', 'kind']);
const CONVERSATION_TYPES = new Set(['direct', 'group']);
const SENDER_KINDS = new Set(['human']);
const PERSON_KINDS = new Set(['human', 'agent']);

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

function requireText(value, field, maxLength = 4_000) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`${field} must be a non-empty string`);
  }
  const normalized = value.trim();
  if (Array.from(normalized).length > maxLength) {
    throw new TypeError(`${field} exceeds ${maxLength} characters`);
  }
  return normalized;
}

function optionalText(value, field, maxLength) {
  if (value === undefined || value === null) return null;
  return requireText(value, field, maxLength);
}

function normalizePerson(input, index) {
  const person = requireRecord(input, `people[${index}]`);
  rejectUnknownFields(person, PERSON_FIELDS, `people[${index}]`);
  const kind = person.kind ?? 'human';
  if (!PERSON_KINDS.has(kind)) {
    throw new TypeError(`people[${index}].kind is unsupported`);
  }
  let candidateIds = [];
  if (person.candidateIds !== undefined) {
    if (!Array.isArray(person.candidateIds)) {
      throw new TypeError(`people[${index}].candidateIds must be an array`);
    }
    candidateIds = [...new Set(person.candidateIds.map((id, candidateIndex) => (
      requireText(id, `people[${index}].candidateIds[${candidateIndex}]`, 256)
    )))];
  }
  const id = optionalText(person.id, `people[${index}].id`, 256);
  if (id && candidateIds.length > 0 && !candidateIds.includes(id)) {
    throw new TypeError(`people[${index}].id must be present in candidateIds`);
  }
  return {
    name: requireText(person.name, `people[${index}].name`, 100),
    id,
    candidateIds,
    kind,
  };
}

export function validateInboundEnvelope(input) {
  const envelope = requireRecord(input, 'InboundEnvelope');
  rejectUnknownFields(envelope, TOP_LEVEL_FIELDS, 'InboundEnvelope');

  const source = requireRecord(envelope.source, 'InboundEnvelope.source');
  rejectUnknownFields(source, SOURCE_FIELDS, 'InboundEnvelope.source');
  const conversationType = requireText(
    source.conversationType,
    'InboundEnvelope.source.conversationType',
    16,
  );
  if (!CONVERSATION_TYPES.has(conversationType)) {
    throw new TypeError('InboundEnvelope.source.conversationType is unsupported');
  }

  const sender = requireRecord(envelope.sender, 'InboundEnvelope.sender');
  rejectUnknownFields(sender, SENDER_FIELDS, 'InboundEnvelope.sender');
  const senderKind = requireText(sender.kind, 'InboundEnvelope.sender.kind', 16);
  if (!SENDER_KINDS.has(senderKind)) {
    throw new TypeError('InboundEnvelope.sender.kind must be human');
  }

  if (!Number.isSafeInteger(envelope.intentRevision) || envelope.intentRevision < 1) {
    throw new TypeError('InboundEnvelope.intentRevision must be a positive integer');
  }

  const receivedAt = optionalText(envelope.receivedAt, 'InboundEnvelope.receivedAt', 40);
  if (receivedAt !== null && Number.isNaN(Date.parse(receivedAt))) {
    throw new TypeError('InboundEnvelope.receivedAt must be an ISO timestamp');
  }
  const timeZone = optionalText(envelope.timeZone, 'InboundEnvelope.timeZone', 100)
    ?? 'Asia/Shanghai';
  try {
    new Intl.DateTimeFormat('en', { timeZone }).format(new Date(0));
  } catch {
    throw new TypeError('InboundEnvelope.timeZone must be an IANA time zone');
  }

  const people = envelope.people ?? [];
  if (!Array.isArray(people) || people.length > 50) {
    throw new TypeError('InboundEnvelope.people must be an array of at most 50 items');
  }

  return {
    source: {
      channel: requireText(source.channel, 'InboundEnvelope.source.channel', 64),
      messageId: requireText(source.messageId, 'InboundEnvelope.source.messageId', 256),
      conversationId: requireText(
        source.conversationId,
        'InboundEnvelope.source.conversationId',
        256,
      ),
      conversationType,
      threadId: optionalText(source.threadId, 'InboundEnvelope.source.threadId', 256),
    },
    sender: {
      id: requireText(sender.id, 'InboundEnvelope.sender.id', 256),
      kind: senderKind,
    },
    text: requireText(envelope.text, 'InboundEnvelope.text', 8_000),
    intentRevision: envelope.intentRevision,
    receivedAt,
    timeZone,
    people: people.map(normalizePerson),
  };
}

export function workIntakeSourceKey(envelope) {
  const normalized = validateInboundEnvelope(envelope);
  return `${normalized.source.channel}:${normalized.source.messageId}:work-intake:r${normalized.intentRevision}`;
}

export function parseInboundEnvelopeJson(rawJson) {
  if (typeof rawJson !== 'string' || rawJson === '') {
    throw new TypeError('InboundEnvelope JSON must be a non-empty string');
  }
  let parsed;
  try {
    parsed = JSON.parse(rawJson);
  } catch (error) {
    throw new TypeError(`InboundEnvelope JSON is invalid: ${error.message}`);
  }
  return validateInboundEnvelope(parsed);
}
