import { createHash } from 'node:crypto';

const CONTEXT_ITEM_KINDS = new Set([
  'source_message',
  'control_intent',
  'task_intent',
  'root_message',
  'quoted_message',
  'attachment_summary',
  'channel_history',
  'memory',
]);

const CONTEXT_HINT_FIELDS = new Set([
  'threadRef',
  'rootRef',
  'parentRef',
  'quoteRefs',
  'mentionRefs',
  'attachmentRefs',
]);

const AUTHORIZATION_SCOPE_FIELDS = Object.freeze([
  'tenantRef',
  'routeRef',
  'conversationLaneKey',
]);

const ASSEMBLY_REQUEST_FIELDS = Object.freeze([
  'snapshotId',
  'requestId',
  'turnId',
  'traceId',
  'conversationLaneKey',
  'asOfLaneSequence',
  'authorizationScope',
  'contextHints',
]);

const CONTEXT_SNAPSHOT_FIELDS = Object.freeze([
  'schemaVersion',
  'type',
  'snapshotId',
  'requestId',
  'turnId',
  'traceId',
  'conversationLaneKey',
  'asOfLaneSequence',
  'authorizationScope',
  'items',
  'truncation',
  'contentHash',
  'retryPolicy',
]);

const CONTEXT_ITEM_FIELDS = Object.freeze([
  'kind',
  'ref',
  'content',
  'provenance',
  'laneSequence',
]);

const TRUNCATION_FIELDS = Object.freeze([
  'strategy',
  'inputTokens',
  'keptTokens',
  'droppedItemRefs',
]);

const KIND_PRIORITY = Object.freeze({
  source_message: 0,
  control_intent: 1,
  task_intent: 1,
  root_message: 2,
  quoted_message: 2,
  attachment_summary: 2,
  channel_history: 3,
  memory: 4,
});

const DEFAULT_BUDGET_POLICY = Object.freeze({
  maxTokens: 8_192,
  maxItemTokens: 2_048,
  maxAttachmentSummaryTokens: 512,
});

const DEFAULT_READ_TIMEOUT_MS = 5_000;

function domainError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function requireRecord(value, field) {
  if (!isRecord(value)) throw new TypeError(`${field} must be an object`);
  return value;
}

function requireText(value, field, maxLength = 8_192) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`${field} must be non-empty text`);
  }
  const normalized = value.normalize('NFC');
  if (Array.from(normalized).length > maxLength) {
    throw new TypeError(`${field} exceeds ${maxLength} characters`);
  }
  return normalized;
}

function compareText(left, right) {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function normalizeCanonicalValue(value, path = 'value') {
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'string') return value.normalize('NFC');
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError(`${path} must contain finite numbers`);
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item, index) => normalizeCanonicalValue(item, `${path}[${index}]`));
  }
  if (!isRecord(value)) throw new TypeError(`${path} is not canonical JSON data`);
  const normalized = {};
  for (const key of Object.keys(value).sort(compareText)) {
    if (value[key] === undefined) throw new TypeError(`${path}.${key} must not be undefined`);
    normalized[key.normalize('NFC')] = normalizeCanonicalValue(value[key], `${path}.${key}`);
  }
  return normalized;
}

export function canonicalJson(value) {
  return JSON.stringify(normalizeCanonicalValue(value));
}

export function deepFreezeContextValue(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreezeContextValue(child);
  return Object.freeze(value);
}

export function estimateContextTokens(value) {
  if (typeof value !== 'string') throw new TypeError('context token input must be text');
  if (value.length === 0) return 0;
  return Math.ceil(Buffer.byteLength(value.normalize('NFC'), 'utf8') / 4);
}

function truncateToTokenBudget(value, maxTokens) {
  const normalized = value.normalize('NFC');
  if (estimateContextTokens(normalized) <= maxTokens) return normalized;
  const codePoints = Array.from(normalized);
  let low = 0;
  let high = codePoints.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (estimateContextTokens(codePoints.slice(0, middle).join('')) <= maxTokens) low = middle;
    else high = middle - 1;
  }
  return codePoints.slice(0, low).join('');
}

function normalizePositiveInteger(value, field) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${field} must be a positive safe integer`);
  }
  return value;
}

function normalizeBudgetPolicy(policy = DEFAULT_BUDGET_POLICY) {
  const input = requireRecord(policy, 'budgetPolicy');
  assertExactFields(input, Object.keys(DEFAULT_BUDGET_POLICY), 'budgetPolicy');
  const normalized = {
    maxTokens: normalizePositiveInteger(input.maxTokens, 'budgetPolicy.maxTokens'),
    maxItemTokens: normalizePositiveInteger(input.maxItemTokens, 'budgetPolicy.maxItemTokens'),
    maxAttachmentSummaryTokens: normalizePositiveInteger(
      input.maxAttachmentSummaryTokens,
      'budgetPolicy.maxAttachmentSummaryTokens',
    ),
  };
  if (normalized.maxAttachmentSummaryTokens > normalized.maxItemTokens) {
    throw new TypeError('attachment summary budget must not exceed the per-item budget');
  }
  return Object.freeze(normalized);
}

function normalizeOptionalRef(value, field) {
  if (value === null || value === undefined) return null;
  return requireText(value, field);
}

function normalizeRefList(value, field) {
  if (value === undefined) return Object.freeze([]);
  if (!Array.isArray(value)) throw domainError('INVALID_CONTEXT_HINTS', `${field} must be a list`);
  return Object.freeze(value.map((ref, index) => requireText(ref, `${field}[${index}]`)));
}

function normalizeContextHints(value = {}) {
  const hints = requireRecord(value, 'contextHints');
  for (const key of Object.keys(hints)) {
    if (!CONTEXT_HINT_FIELDS.has(key)) {
      throw domainError('INVALID_CONTEXT_HINTS', `unsupported ContextHints field: ${key}`);
    }
  }
  return Object.freeze({
    threadRef: normalizeOptionalRef(hints.threadRef, 'contextHints.threadRef'),
    rootRef: normalizeOptionalRef(hints.rootRef, 'contextHints.rootRef'),
    parentRef: normalizeOptionalRef(hints.parentRef, 'contextHints.parentRef'),
    quoteRefs: normalizeRefList(hints.quoteRefs, 'contextHints.quoteRefs'),
    mentionRefs: normalizeRefList(hints.mentionRefs, 'contextHints.mentionRefs'),
    attachmentRefs: normalizeRefList(hints.attachmentRefs, 'contextHints.attachmentRefs'),
  });
}

function normalizeAuthorizationScope(value, expectedLaneKey) {
  if (!isRecord(value)) {
    throw domainError('INVALID_AUTHORIZATION_SCOPE', 'authorizationScope must be an object');
  }
  const keys = Object.keys(value).sort(compareText);
  if (
    keys.length !== AUTHORIZATION_SCOPE_FIELDS.length
    || keys.some((key, index) => key !== [...AUTHORIZATION_SCOPE_FIELDS].sort(compareText)[index])
  ) {
    throw domainError('INVALID_AUTHORIZATION_SCOPE', 'authorizationScope fields are invalid');
  }
  const normalized = Object.freeze({
    tenantRef: requireText(value.tenantRef, 'authorizationScope.tenantRef'),
    routeRef: requireText(value.routeRef, 'authorizationScope.routeRef'),
    conversationLaneKey: requireText(
      value.conversationLaneKey,
      'authorizationScope.conversationLaneKey',
    ),
  });
  if (expectedLaneKey !== undefined && normalized.conversationLaneKey !== expectedLaneKey) {
    throw domainError('INVALID_AUTHORIZATION_SCOPE', 'authorizationScope lane does not match request lane');
  }
  return normalized;
}

function sameAuthorizationScope(left, right) {
  return AUTHORIZATION_SCOPE_FIELDS.every(field => left[field] === right[field]);
}

function normalizeIdentity(value) {
  const input = requireRecord(value, 'context assembly request');
  assertExactFields(input, ASSEMBLY_REQUEST_FIELDS, 'context assembly request');
  if (!Number.isSafeInteger(input.asOfLaneSequence) || input.asOfLaneSequence < 0) {
    throw new TypeError('asOfLaneSequence must be a non-negative safe integer');
  }
  const conversationLaneKey = requireText(input.conversationLaneKey, 'conversationLaneKey');
  return Object.freeze({
    snapshotId: requireText(input.snapshotId, 'snapshotId'),
    requestId: requireText(input.requestId, 'requestId'),
    turnId: requireText(input.turnId, 'turnId'),
    traceId: requireText(input.traceId, 'traceId'),
    conversationLaneKey,
    asOfLaneSequence: input.asOfLaneSequence,
    authorizationScope: normalizeAuthorizationScope(input.authorizationScope, conversationLaneKey),
    contextHints: normalizeContextHints(input.contextHints),
  });
}

function normalizeProvenance(value, expectedSource, field) {
  const provenance = requireRecord(value, field);
  for (const key of Object.keys(provenance)) {
    if (!['source', 'opaqueRef', 'authority'].includes(key)) {
      throw new TypeError(`${field} contains an unsupported field`);
    }
  }
  const normalized = {
    source: requireText(provenance.source, `${field}.source`, 128),
    opaqueRef: requireText(provenance.opaqueRef, `${field}.opaqueRef`),
    authority: requireText(provenance.authority, `${field}.authority`, 256),
  };
  if (normalized.source !== expectedSource) {
    throw domainError('INVALID_CONTEXT_PROVENANCE', `${field}.source is not authorized for this port`);
  }
  return normalized;
}

function normalizeItem(rawItem, source, index, { watermark, authorizationScope } = {}) {
  const item = requireRecord(rawItem, `${source} item ${index}`);
  const kind = requireText(item.kind, `${source} item ${index}.kind`, 64);
  if (!CONTEXT_ITEM_KINDS.has(kind)) {
    throw new TypeError(`${source} item ${index}.kind is unsupported`);
  }
  if (source === 'channel_context' && kind === 'memory') {
    throw domainError('INVALID_CONTEXT_PROVENANCE', 'channel context cannot provide memory items');
  }
  if (source === 'unified_memory' && kind !== 'memory') {
    throw domainError('INVALID_CONTEXT_PROVENANCE', 'MemoryPort can only provide memory items');
  }
  const normalized = {
    kind,
    ref: requireText(item.ref, `${source} item ${index}.ref`),
    content: requireText(item.content, `${source} item ${index}.content`, 1_000_000),
    provenance: normalizeProvenance(
      item.provenance,
      source,
      `${source} item ${index}.provenance`,
    ),
  };
  if (item.laneSequence !== undefined) {
    if (!Number.isSafeInteger(item.laneSequence) || item.laneSequence < 0) {
      throw new TypeError(`${source} item ${index}.laneSequence must be non-negative`);
    }
    normalized.laneSequence = item.laneSequence;
  }
  if (source === 'channel_context') {
    if (kind === 'channel_history' && normalized.laneSequence === undefined) {
      throw domainError('INVALID_CONTEXT_ITEM', 'channel history requires a durable laneSequence');
    }
    if (normalized.laneSequence !== undefined && normalized.laneSequence > watermark) {
      throw domainError(
        'CONTEXT_WATERMARK_VIOLATION',
        'channel context exceeds the request lane watermark',
      );
    }
  } else {
    if (normalized.laneSequence !== undefined) {
      throw domainError('INVALID_CONTEXT_ITEM', 'memory items cannot define laneSequence');
    }
    normalized.provenance.authorizationScope = authorizationScope;
  }
  return normalized;
}

function normalizeAuthorizedItems(rawItems, source, options) {
  if (!Array.isArray(rawItems)) throw new TypeError(`${source} result must be a list`);
  return rawItems
    .filter(item => isRecord(item) && item.authorized === true)
    .map((item, index) => normalizeItem(item, source, index, options));
}

function normalizeMemoryResult(rawResult, expectedScope) {
  if (!isRecord(rawResult)) {
    throw domainError('MEMORY_SCOPE_MISMATCH', 'MemoryPort result must include authorization scope');
  }
  const keys = Object.keys(rawResult).sort(compareText);
  if (keys.length !== 2 || keys[0] !== 'authorizationScope' || keys[1] !== 'items') {
    throw domainError('MEMORY_SCOPE_MISMATCH', 'MemoryPort result envelope is invalid');
  }
  let resultScope;
  try {
    resultScope = normalizeAuthorizationScope(
      rawResult.authorizationScope,
      expectedScope.conversationLaneKey,
    );
  } catch {
    throw domainError('MEMORY_SCOPE_MISMATCH', 'MemoryPort authorization scope is invalid');
  }
  if (!sameAuthorizationScope(resultScope, expectedScope)) {
    throw domainError('MEMORY_SCOPE_MISMATCH', 'MemoryPort authorization scope does not match request');
  }
  return {
    authorizationScope: resultScope,
    items: rawResult.items,
  };
}

function itemIdentity(item) {
  return `${item.kind}\u0000${item.ref}`;
}

function deduplicateItems(items) {
  const byIdentity = new Map();
  for (const item of items) {
    const identity = itemIdentity(item);
    const existing = byIdentity.get(identity);
    if (!existing) {
      byIdentity.set(identity, item);
      continue;
    }
    if (canonicalJson(existing) !== canonicalJson(item)) {
      throw domainError('CONTEXT_ITEM_CONFLICT', 'context item identity conflict');
    }
  }
  return [...byIdentity.values()];
}

function compareItems(left, right) {
  const rank = KIND_PRIORITY[left.kind] - KIND_PRIORITY[right.kind];
  if (rank !== 0) return rank;
  const leftSequence = left.laneSequence ?? -1;
  const rightSequence = right.laneSequence ?? -1;
  if (leftSequence !== rightSequence) return leftSequence > rightSequence ? -1 : 1;
  const ref = compareText(left.ref, right.ref);
  if (ref !== 0) return ref;
  return compareText(canonicalJson(left), canonicalJson(right));
}

function applyBudget(items, policy) {
  const inputTokens = items.reduce((total, item) => total + estimateContextTokens(item.content), 0);
  const selected = [];
  const droppedItemRefs = [];
  let remaining = policy.maxTokens;

  for (const item of items) {
    const itemLimit = item.kind === 'attachment_summary'
      ? policy.maxAttachmentSummaryTokens
      : policy.maxItemTokens;
    const cappedContent = truncateToTokenBudget(item.content, itemLimit);
    const cappedTokens = estimateContextTokens(cappedContent);
    if (remaining <= 0 || cappedTokens === 0) {
      droppedItemRefs.push(itemIdentity(item));
      continue;
    }
    const content = cappedTokens <= remaining
      ? cappedContent
      : truncateToTokenBudget(cappedContent, remaining);
    const keptTokens = estimateContextTokens(content);
    if (keptTokens === 0) {
      droppedItemRefs.push(itemIdentity(item));
      continue;
    }
    selected.push({ ...item, content });
    remaining -= keptTokens;
  }

  return {
    items: selected,
    truncation: {
      strategy: 'deterministic_budget_v1',
      inputTokens,
      keptTokens: selected.reduce(
        (total, item) => total + estimateContextTokens(item.content),
        0,
      ),
      droppedItemRefs,
    },
  };
}

function assertExactFields(value, fields, label) {
  if (!isRecord(value)) throw new TypeError(`${label} must be an object`);
  const expected = [...fields].sort(compareText);
  const actual = Object.keys(value).sort(compareText);
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new TypeError(`${label} fields are invalid`);
  }
}

function requireNonNegativeSafeInteger(value, field) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${field} must be a non-negative safe integer`);
  }
  return value;
}

function normalizeItemIdentity(value, field) {
  const normalized = requireText(value, field);
  const separator = normalized.indexOf('\u0000');
  const kind = normalized.slice(0, separator);
  const ref = normalized.slice(separator + 1);
  if (separator <= 0 || !CONTEXT_ITEM_KINDS.has(kind) || ref.trim() === '') {
    throw new TypeError(`${field} must be a kind and ref identity`);
  }
  return normalized;
}

function validateSnapshotItem(item, index, snapshot, snapshotAuthorizationScope) {
  const label = `ContextSnapshot.items[${index}]`;
  if (!isRecord(item)) throw new TypeError(`${label} must be an object`);
  const requiredFields = CONTEXT_ITEM_FIELDS.filter(field => field !== 'laneSequence');
  const allowedFields = item.laneSequence === undefined ? requiredFields : CONTEXT_ITEM_FIELDS;
  assertExactFields(item, allowedFields, label);
  const kind = requireText(item.kind, `${label}.kind`, 64);
  if (!CONTEXT_ITEM_KINDS.has(kind)) throw new TypeError(`${label}.kind is unsupported`);
  const ref = requireText(item.ref, `${label}.ref`);
  requireText(item.content, `${label}.content`, 1_000_000);
  const memory = kind === 'memory';
  const provenanceFields = memory
    ? ['source', 'opaqueRef', 'authority', 'authorizationScope']
    : ['source', 'opaqueRef', 'authority'];
  assertExactFields(item.provenance, provenanceFields, `${label}.provenance`);
  const expectedSource = memory ? 'unified_memory' : 'channel_context';
  const expectedAuthority = memory ? 'authorized_memory' : 'authorized_channel_context';
  if (item.provenance.source !== expectedSource || item.provenance.authority !== expectedAuthority) {
    throw new TypeError(`${label}.provenance is invalid`);
  }
  if (requireText(item.provenance.opaqueRef, `${label}.provenance.opaqueRef`) !== ref) {
    throw new TypeError(`${label}.provenance does not match item ref`);
  }
  if (memory) {
    const itemAuthorizationScope = normalizeAuthorizationScope(
      item.provenance.authorizationScope,
      snapshot.conversationLaneKey,
    );
    if (!sameAuthorizationScope(itemAuthorizationScope, snapshotAuthorizationScope)) {
      throw new TypeError(`${label}.authorizationScope does not match snapshot`);
    }
    if (item.laneSequence !== undefined) throw new TypeError(`${label}.laneSequence is invalid`);
  } else if (item.laneSequence !== undefined) {
    requireNonNegativeSafeInteger(item.laneSequence, `${label}.laneSequence`);
    if (item.laneSequence > snapshot.asOfLaneSequence) {
      throw new TypeError(`${label}.laneSequence exceeds snapshot watermark`);
    }
  }
  if (kind === 'channel_history' && item.laneSequence === undefined) {
    throw new TypeError(`${label}.laneSequence is required`);
  }
}

function validateContextSnapshotV1(snapshot) {
  assertExactFields(snapshot, CONTEXT_SNAPSHOT_FIELDS, 'ContextSnapshot');
  if (snapshot.schemaVersion !== 1) throw new TypeError('ContextSnapshot.schemaVersion must be 1');
  if (snapshot.type !== 'ContextSnapshot') throw new TypeError('ContextSnapshot.type is invalid');
  for (const field of [
    'snapshotId',
    'requestId',
    'turnId',
    'traceId',
    'conversationLaneKey',
  ]) requireText(snapshot[field], `ContextSnapshot.${field}`);
  requireNonNegativeSafeInteger(snapshot.asOfLaneSequence, 'ContextSnapshot.asOfLaneSequence');
  const snapshotAuthorizationScope = normalizeAuthorizationScope(
    snapshot.authorizationScope,
    snapshot.conversationLaneKey,
  );
  if (!Array.isArray(snapshot.items)) throw new TypeError('ContextSnapshot.items must be a list');
  const identities = new Set();
  let sourceMessageCount = 0;
  let memoryAuthorizationScope = null;
  for (const [index, item] of snapshot.items.entries()) {
    validateSnapshotItem(item, index, snapshot, snapshotAuthorizationScope);
    const identity = itemIdentity(item);
    if (identities.has(identity)) throw new TypeError('ContextSnapshot contains duplicate items');
    identities.add(identity);
    if (item.kind === 'source_message') sourceMessageCount += 1;
    if (item.kind === 'memory') {
      if (
        memoryAuthorizationScope
        && !sameAuthorizationScope(memoryAuthorizationScope, item.provenance.authorizationScope)
      ) {
        throw new TypeError('ContextSnapshot memory authorization scopes do not match');
      }
      memoryAuthorizationScope = item.provenance.authorizationScope;
    }
  }
  if (sourceMessageCount !== 1) {
    throw new TypeError('ContextSnapshot must contain exactly one source_message');
  }
  const sortedItems = [...snapshot.items].sort(compareItems);
  if (sortedItems.some((item, index) => canonicalJson(item) !== canonicalJson(snapshot.items[index]))) {
    throw new TypeError('ContextSnapshot.items are not in deterministic order');
  }
  assertExactFields(snapshot.truncation, TRUNCATION_FIELDS, 'ContextSnapshot.truncation');
  if (snapshot.truncation.strategy !== 'deterministic_budget_v1') {
    throw new TypeError('ContextSnapshot.truncation.strategy is invalid');
  }
  requireNonNegativeSafeInteger(
    snapshot.truncation.inputTokens,
    'ContextSnapshot.truncation.inputTokens',
  );
  requireNonNegativeSafeInteger(
    snapshot.truncation.keptTokens,
    'ContextSnapshot.truncation.keptTokens',
  );
  if (snapshot.truncation.keptTokens > snapshot.truncation.inputTokens) {
    throw new TypeError('ContextSnapshot.truncation token totals are invalid');
  }
  const actualKeptTokens = snapshot.items.reduce(
    (total, item) => total + estimateContextTokens(item.content),
    0,
  );
  if (snapshot.truncation.keptTokens !== actualKeptTokens) {
    throw new TypeError('ContextSnapshot.truncation keptTokens does not match items');
  }
  if (!Array.isArray(snapshot.truncation.droppedItemRefs)) {
    throw new TypeError('ContextSnapshot.truncation.droppedItemRefs must be a list');
  }
  const droppedIdentities = new Set();
  const keptIdentities = new Set(snapshot.items.map(itemIdentity));
  for (const [index, identity] of snapshot.truncation.droppedItemRefs.entries()) {
    const normalized = normalizeItemIdentity(
      identity,
      `ContextSnapshot.truncation.droppedItemRefs[${index}]`,
    );
    if (droppedIdentities.has(normalized)) {
      throw new TypeError('ContextSnapshot.truncation contains duplicate dropped refs');
    }
    if (keptIdentities.has(normalized)) {
      throw new TypeError('ContextSnapshot.truncation marks a kept item as dropped');
    }
    droppedIdentities.add(normalized);
  }
  if (snapshot.retryPolicy !== 'reuse_same_snapshot') {
    throw new TypeError('ContextSnapshot.retryPolicy is invalid');
  }
  if (typeof snapshot.contentHash !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(snapshot.contentHash)) {
    throw new TypeError('ContextSnapshot.contentHash is invalid');
  }
  if (snapshot.contentHash !== contextSnapshotContentHash(snapshot)) {
    throw domainError(
      'CONTEXT_SNAPSHOT_HASH_MISMATCH',
      `ContextSnapshot hash mismatch for ${snapshot.snapshotId}`,
    );
  }
  return snapshot;
}

export function assertContextSnapshotV1(snapshot) {
  try {
    return validateContextSnapshotV1(snapshot);
  } catch (error) {
    if (
      error?.code === 'CONTEXT_SNAPSHOT_HASH_MISMATCH'
      || error?.code === 'INVALID_CONTEXT_SNAPSHOT'
    ) throw error;
    throw domainError('INVALID_CONTEXT_SNAPSHOT', 'ContextSnapshot v1 envelope is invalid');
  }
}

function retryIdentityConflict() {
  return domainError('IDEMPOTENCY_CONFLICT', 'context snapshot retry identity conflict');
}

function assertSnapshotIdentity(snapshot, identity) {
  if (
    snapshot.snapshotId !== identity.snapshotId
    || snapshot.requestId !== identity.requestId
    || snapshot.turnId !== identity.turnId
    || snapshot.traceId !== identity.traceId
    || snapshot.conversationLaneKey !== identity.conversationLaneKey
    || snapshot.asOfLaneSequence !== identity.asOfLaneSequence
    || !sameAuthorizationScope(snapshot.authorizationScope, identity.authorizationScope)
  ) {
    throw retryIdentityConflict();
  }
}

function isDeepFrozenContextValue(value) {
  if (!value || typeof value !== 'object') return true;
  if (!Object.isFrozen(value)) return false;
  return Object.values(value).every(isDeepFrozenContextValue);
}

function materializeStoreSnapshot(rawSnapshot, identity, expectedSnapshot = null) {
  assertContextSnapshotV1(rawSnapshot);
  const bytes = canonicalContextSnapshotBytes(rawSnapshot);
  const canonicalSnapshot = JSON.parse(bytes.toString('utf8'));
  assertContextSnapshotV1(canonicalSnapshot);
  assertSnapshotIdentity(canonicalSnapshot, identity);
  if (
    expectedSnapshot
    && !bytes.equals(canonicalContextSnapshotBytes(expectedSnapshot))
  ) {
    throw domainError(
      'CONTEXT_SNAPSHOT_CONFLICT',
      'snapshot store returned a different immutable context snapshot',
    );
  }
  if (
    isDeepFrozenContextValue(rawSnapshot)
    && JSON.stringify(rawSnapshot) === bytes.toString('utf8')
  ) return rawSnapshot;
  return deepFreezeContextValue(canonicalSnapshot);
}

function snapshotHashInput(snapshot) {
  const { contentHash: _contentHash, ...hashInput } = snapshot;
  return hashInput;
}

export function contextSnapshotContentHash(snapshot) {
  requireRecord(snapshot, 'ContextSnapshot');
  return `sha256:${createHash('sha256').update(canonicalJson(snapshotHashInput(snapshot))).digest('hex')}`;
}

export function canonicalContextSnapshotBytes(snapshot) {
  requireRecord(snapshot, 'ContextSnapshot');
  return Buffer.from(canonicalJson(snapshot), 'utf8');
}

export function contextSnapshotIdempotencyKey({ requestId, turnId }) {
  const encodedIdentity = Buffer.from(canonicalJson([
    requireText(requestId, 'requestId'),
    requireText(turnId, 'turnId'),
  ]), 'utf8').toString('base64url');
  return `context:v1:${encodedIdentity}`;
}

function validatePort(port, method, name) {
  if (!isRecord(port) || typeof port[method] !== 'function') {
    throw new TypeError(`${name}.${method} must be a function`);
  }
  return port;
}

function normalizeReadTimeout(value) {
  if (!Number.isSafeInteger(value) || value <= 0 || value > 60_000) {
    throw new TypeError('readTimeoutMs must be an integer from 1 through 60000');
  }
  return value;
}

function validateAbortSignal(signal) {
  if (signal === undefined) return null;
  if (!(signal instanceof AbortSignal)) throw new TypeError('signal must be an AbortSignal');
  return signal;
}

function createReadBoundary(parentSignal, timeoutMs) {
  const controller = new AbortController();
  let parentAbortListener;
  if (parentSignal) {
    parentAbortListener = () => controller.abort(domainError(
      'CONTEXT_ASSEMBLY_ABORTED',
      'context assembly was aborted',
    ));
    if (parentSignal.aborted) parentAbortListener();
    else parentSignal.addEventListener('abort', parentAbortListener, { once: true });
  }
  const timeout = setTimeout(() => controller.abort(domainError(
    'CONTEXT_PORT_TIMEOUT',
    'context port read timed out',
  )), timeoutMs);
  let boundaryAbortListener;
  const aborted = new Promise((resolve, reject) => {
    boundaryAbortListener = () => reject(controller.signal.reason);
    if (controller.signal.aborted) boundaryAbortListener();
    else controller.signal.addEventListener('abort', boundaryAbortListener, { once: true });
  });
  return {
    signal: controller.signal,
    aborted,
    abort(reason) {
      if (!controller.signal.aborted) controller.abort(reason);
    },
    close() {
      clearTimeout(timeout);
      if (boundaryAbortListener) {
        controller.signal.removeEventListener('abort', boundaryAbortListener);
      }
      if (parentSignal && parentAbortListener) {
        parentSignal.removeEventListener('abort', parentAbortListener);
      }
    },
  };
}

/**
 * Assemble immutable, request-scoped context without owning Runtime/session state.
 * ChannelContextPort.resolve(query, { signal }) returns authorized item candidates.
 * MemoryPort.recall(query, { signal }) returns { authorizationScope, items } and
 * must echo the exact tenant/route/lane scope from query. Both reads share one
 * bounded AbortSignal; channel platform resolution and unified Memory remain
 * injected ports. Abort is cooperative: an adapter that ignores AbortSignal may
 * keep running after assembly rejects and must isolate its own late side effects.
 */
export function createContextAssembler({
  channelContextPort,
  memoryPort,
  snapshotStore,
  budgetPolicy = DEFAULT_BUDGET_POLICY,
  readTimeoutMs = DEFAULT_READ_TIMEOUT_MS,
} = {}) {
  const channelPort = validatePort(channelContextPort, 'resolve', 'ChannelContextPort');
  const unifiedMemory = validatePort(memoryPort, 'recall', 'MemoryPort');
  const store = validatePort(snapshotStore, 'load', 'ContextSnapshotStore');
  validatePort(snapshotStore, 'save', 'ContextSnapshotStore');
  const policy = normalizeBudgetPolicy(budgetPolicy);
  const portReadTimeout = normalizeReadTimeout(readTimeoutMs);

  return Object.freeze({
    async assemble(rawIdentity, { signal: rawSignal } = {}) {
      const parentSignal = validateAbortSignal(rawSignal);
      if (parentSignal?.aborted) {
        throw domainError('CONTEXT_ASSEMBLY_ABORTED', 'context assembly was aborted');
      }
      const identity = normalizeIdentity(rawIdentity);
      const idempotencyKey = contextSnapshotIdempotencyKey(identity);
      const existing = await store.load({
        snapshotId: identity.snapshotId,
        idempotencyKey,
      });
      if (parentSignal?.aborted) {
        throw domainError('CONTEXT_ASSEMBLY_ABORTED', 'context assembly was aborted');
      }
      if (existing !== null && existing !== undefined) {
        return materializeStoreSnapshot(existing, identity);
      }

      const channelQuery = Object.freeze({
        requestId: identity.requestId,
        turnId: identity.turnId,
        traceId: identity.traceId,
        conversationLaneKey: identity.conversationLaneKey,
        asOfLaneSequence: identity.asOfLaneSequence,
        contextHints: identity.contextHints,
      });
      const memoryQuery = Object.freeze({
        requestId: identity.requestId,
        turnId: identity.turnId,
        traceId: identity.traceId,
        authorizationScope: identity.authorizationScope,
      });
      const boundary = createReadBoundary(parentSignal, portReadTimeout);
      const readOptions = Object.freeze({ signal: boundary.signal });
      let rawChannelItems;
      let rawMemoryResult;
      try {
        const channelRead = Promise.resolve().then(
          () => channelPort.resolve(channelQuery, readOptions),
        );
        const memoryRead = Promise.resolve().then(
          () => unifiedMemory.recall(memoryQuery, readOptions),
        );
        [rawChannelItems, rawMemoryResult] = await Promise.race([
          Promise.all([channelRead, memoryRead]),
          boundary.aborted,
        ]);
      } catch (error) {
        boundary.abort(domainError(
          'CONTEXT_PORT_SIBLING_ABORTED',
          'context port sibling read was aborted',
        ));
        throw error;
      } finally {
        boundary.close();
      }
      const memoryResult = normalizeMemoryResult(rawMemoryResult, identity.authorizationScope);
      const items = deduplicateItems([
        ...normalizeAuthorizedItems(rawChannelItems, 'channel_context', {
          watermark: identity.asOfLaneSequence,
        }),
        ...normalizeAuthorizedItems(memoryResult.items, 'unified_memory', {
          authorizationScope: memoryResult.authorizationScope,
        }),
      ]);
      const sourceMessageCount = items.filter(item => item.kind === 'source_message').length;
      if (sourceMessageCount !== 1) {
        throw domainError(
          'INVALID_CURRENT_CONTEXT',
          'authorized context must contain exactly one current source message',
        );
      }
      items.sort(compareItems);
      const budgeted = applyBudget(items, policy);
      const withoutHash = {
        schemaVersion: 1,
        type: 'ContextSnapshot',
        snapshotId: identity.snapshotId,
        requestId: identity.requestId,
        turnId: identity.turnId,
        traceId: identity.traceId,
        conversationLaneKey: identity.conversationLaneKey,
        asOfLaneSequence: identity.asOfLaneSequence,
        authorizationScope: identity.authorizationScope,
        items: budgeted.items,
        truncation: budgeted.truncation,
        retryPolicy: 'reuse_same_snapshot',
      };
      const snapshot = deepFreezeContextValue({
        ...withoutHash,
        contentHash: contextSnapshotContentHash(withoutHash),
      });
      assertContextSnapshotV1(snapshot);
      const persisted = await store.save({ idempotencyKey, snapshot });
      return materializeStoreSnapshot(persisted, identity, snapshot);
    },
  });
}
