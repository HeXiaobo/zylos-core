import { createHash } from 'node:crypto';

import {
  createTaskEffectRelay,
  initializeTaskEffectRelaySchema,
} from './task-effect-relay.js';

const AUTHORIZATION_CHECKS = Object.freeze([
  'actor_role',
  'capability',
  'task_state',
  'expected_version',
]);

const SOURCE_FIELDS = new Set([
  'adapterId',
  'accountRef',
  'eventType',
  'eventId',
  'messageId',
]);

const VERIFIED_CONTEXT_FIELDS = new Set([
  'provider',
  'tenantRef',
  'externalId',
  'provenance',
  'traceId',
  'origin',
  'capabilities',
  'source',
  'originEffectId',
]);

const CREATE_INTENT_FIELDS = new Set([
  'command',
  'title',
  'description',
  'dueAt',
  'reminderMinutesBeforeDue',
]);

const EXISTING_TASK_INTENT_FIELDS = new Set([
  'taskId',
  'command',
  'expectedVersion',
  'reminderMinutesBeforeDue',
  'dueAt',
]);

const COMMAND_CAPABILITIES = Object.freeze({
  StartTask: 'task.start',
  SubmitForReview: 'task.submit_for_review',
  AcceptTask: 'task.accept',
  RequestChanges: 'task.request_changes',
  CancelTask: 'task.cancel',
  ReopenTask: 'task.reopen',
  UpdateTaskReminder: 'task.update',
  PostponeTask: 'task.update',
});

const EVENT_COMMANDS = Object.freeze({
  TaskStarted: 'StartTask',
  TaskSubmittedForReview: 'SubmitForReview',
  TaskAccepted: 'AcceptTask',
  TaskChangesRequested: 'RequestChanges',
  TaskCancelled: 'CancelTask',
  TaskReopened: 'ReopenTask',
  TaskReminderUpdated: 'UpdateTaskReminder',
  TaskDueUpdated: 'PostponeTask',
});

const DENIAL_CODES = new Set([
  'TASK_NOT_FOUND',
  'VERSION_CONFLICT',
  'INVALID_TRANSITION',
  'FORBIDDEN',
  'ACTIVE_RUN_CONFLICT',
  'REMINDER_REQUIRES_DUE_AT',
]);

function domainError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function requireRecord(value, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${field} must be an object`);
  }
  return value;
}

function requireText(value, field) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`${field} must be a non-empty string`);
  }
  return value;
}

function optionalText(value, field) {
  if (value === undefined || value === null) return null;
  return requireText(value, field);
}

function rejectUnknownFields(value, fields, field) {
  const unknown = Object.keys(value).find((key) => !fields.has(key));
  if (unknown) throw new TypeError(`unsupported ${field} field: ${unknown}`);
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]),
  );
}

function fingerprint(value) {
  return createHash('sha256').update(JSON.stringify(canonicalize(value))).digest('hex');
}

function stableId(prefix, value) {
  return `${prefix}:${fingerprint(value).slice(0, 32)}`;
}

function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

function persistedDataCorrupt(message) {
  return domainError('PERSISTED_DATA_CORRUPT', message);
}

function parsePersistedJson(raw, field) {
  try {
    return JSON.parse(raw);
  } catch {
    throw persistedDataCorrupt(`${field} is not valid JSON`);
  }
}

function receiptHash(idempotencyKey, requestFingerprint, result) {
  return fingerprint({ idempotencyKey, requestFingerprint, result });
}

function taskEffectFromRow(row) {
  if (!row) return null;
  const effect = {
    schemaVersion: 1,
    type: 'TaskEffect',
    effectId: row.effect_id,
    requestId: row.request_id,
    traceId: row.trace_id,
    source: parsePersistedJson(row.source_json, 'TaskEffect source'),
    actor: parsePersistedJson(row.actor_json, 'TaskEffect actor'),
    taskId: row.task_id,
    coreVersion: row.core_version,
    origin: row.origin,
    eventId: row.event_id,
    task: parsePersistedJson(row.task_json, 'TaskEffect task'),
  };
  if (row.effect_hash !== fingerprint(effect)) {
    throw persistedDataCorrupt(`TaskEffect hash mismatch: ${effect.effectId}`);
  }
  if (
    effect.task?.id !== effect.taskId
    || effect.task?.version !== effect.coreVersion
  ) {
    throw persistedDataCorrupt(`TaskEffect task linkage mismatch: ${effect.effectId}`);
  }
  return effect;
}

export function createTaskActorAssertionAuthority() {
  const assertions = new WeakMap();
  return Object.freeze({
    issue(rawContext) {
      const context = requireRecord(rawContext, 'verified actor context');
      const assertion = Object.freeze(Object.create(null));
      assertions.set(assertion, structuredClone(context));
      return assertion;
    },
    verify(assertion) {
      const context = (
        assertion
        && typeof assertion === 'object'
        && !Array.isArray(assertion)
      ) ? assertions.get(assertion) : null;
      return context ? structuredClone(context) : null;
    },
  });
}

function normalizeSource(rawSource) {
  const source = requireRecord(rawSource, 'verifiedActor.source');
  rejectUnknownFields(source, SOURCE_FIELDS, 'verifiedActor.source');
  for (const field of SOURCE_FIELDS) requireText(source[field], `verifiedActor.source.${field}`);
  return {
    adapterId: source.adapterId,
    accountRef: source.accountRef,
    eventType: source.eventType,
    eventId: source.eventId,
    messageId: source.messageId,
  };
}

function normalizeVerifiedContext(rawAssertion, verifyActorAssertion) {
  if (typeof verifyActorAssertion !== 'function') {
    throw domainError('UNVERIFIED_ACTOR', 'Task Core has no actor assertion verifier');
  }
  const verified = verifyActorAssertion(rawAssertion);
  if (!verified) {
    throw domainError('UNVERIFIED_ACTOR', 'actor assertion was not issued by the trusted authority');
  }
  const context = requireRecord(verified, 'verifiedActor');
  rejectUnknownFields(context, VERIFIED_CONTEXT_FIELDS, 'verifiedActor');
  if (context.provenance !== 'verified_channel_actor') {
    throw domainError('UNVERIFIED_ACTOR', 'actor provenance is not verified_channel_actor');
  }
  if (!Array.isArray(context.capabilities)) {
    throw new TypeError('verifiedActor.capabilities must be an array');
  }
  const capabilities = [...new Set(context.capabilities.map((capability) => (
    requireText(capability, 'verifiedActor capability')
  )))].sort();
  const origin = requireText(context.origin, 'verifiedActor.origin');
  if (!['assistant_tool', 'structured_action', 'native_task_projection'].includes(origin)) {
    throw domainError('INVALID_ORIGIN', `unsupported verified origin: ${origin}`);
  }
  return {
    actor: {
      provider: requireText(context.provider, 'verifiedActor.provider'),
      tenantRef: requireText(context.tenantRef, 'verifiedActor.tenantRef'),
      externalId: requireText(context.externalId, 'verifiedActor.externalId'),
      provenance: 'verified_channel_actor',
    },
    traceId: requireText(context.traceId, 'verifiedActor.traceId'),
    origin,
    originEffectId: optionalText(context.originEffectId, 'verifiedActor.originEffectId'),
    capabilities,
    source: normalizeSource(context.source),
  };
}

function normalizeCreateIntent(rawIntent) {
  const intent = requireRecord(rawIntent, 'task intent');
  rejectUnknownFields(intent, CREATE_INTENT_FIELDS, 'task intent');
  if (intent.command !== 'CreateTask') {
    throw domainError('INVALID_COMMAND', `unsupported task intent: ${intent.command}`);
  }
  const normalized = {
    command: 'CreateTask',
    title: requireText(intent.title, 'task intent.title'),
    description: optionalText(intent.description, 'task intent.description'),
    dueAt: optionalText(intent.dueAt, 'task intent.dueAt'),
    reminderMinutesBeforeDue: intent.reminderMinutesBeforeDue ?? null,
  };
  if (
    normalized.reminderMinutesBeforeDue !== null
    && (!Number.isSafeInteger(normalized.reminderMinutesBeforeDue)
      || normalized.reminderMinutesBeforeDue < 0)
  ) {
    throw new TypeError('task intent.reminderMinutesBeforeDue must be a non-negative integer');
  }
  if (normalized.reminderMinutesBeforeDue !== null && normalized.dueAt === null) {
    throw new TypeError('task intent.reminderMinutesBeforeDue requires task intent.dueAt');
  }
  return normalized;
}

function requireTimestamp(value, field) {
  const text = requireText(value, field);
  if (!/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(text)
    || !Number.isFinite(Date.parse(text))) {
    throw new TypeError(`${field} must be an RFC 3339 timestamp`);
  }
  return new Date(Date.parse(text)).toISOString();
}

function normalizeTaskIntent(rawIntent) {
  const intent = requireRecord(rawIntent, 'task intent');
  if (intent.command === 'CreateTask') return normalizeCreateIntent(intent);
  rejectUnknownFields(intent, EXISTING_TASK_INTENT_FIELDS, 'task intent');
  const taskId = requireText(intent.taskId, 'task intent.taskId');
  const expectedVersion = normalizeExpectedVersion(intent.expectedVersion);
  let command;
  if (intent.command === 'UpdateTaskReminder') {
    command = {
      type: 'UpdateTaskReminder',
      reminderMinutesBeforeDue: intent.reminderMinutesBeforeDue,
    };
  } else if (intent.command === 'PostponeTask') {
    command = {
      type: 'PostponeTask',
      dueAt: requireTimestamp(intent.dueAt, 'task intent.dueAt'),
    };
  } else {
    command = requireText(intent.command, 'task intent.command');
  }
  return { command, taskId, expectedVersion };
}

function normalizeApplicationCommand(rawCommand) {
  if (typeof rawCommand === 'string') {
    const type = requireText(rawCommand, 'command');
    if (!COMMAND_CAPABILITIES[type]) {
      throw domainError('INVALID_COMMAND', `unsupported command type: ${type}`);
    }
    return { type };
  }
  const command = requireRecord(rawCommand, 'command');
  if (command.type === 'PostponeTask') {
    rejectUnknownFields(command, new Set(['type', 'dueAt']), 'command');
    return {
      type: 'PostponeTask',
      dueAt: requireTimestamp(command.dueAt, 'command.dueAt'),
    };
  }
  if (command.type !== 'UpdateTaskReminder') {
    rejectUnknownFields(command, new Set(['type']), 'command');
    const type = requireText(command.type, 'command.type');
    if (!COMMAND_CAPABILITIES[type]) {
      throw domainError('INVALID_COMMAND', `unsupported command type: ${type}`);
    }
    return { type };
  }
  rejectUnknownFields(command, new Set(['type', 'reminderMinutesBeforeDue']), 'command');
  if (!Number.isSafeInteger(command.reminderMinutesBeforeDue)
    || command.reminderMinutesBeforeDue < 0) {
    throw new TypeError('command.reminderMinutesBeforeDue must be a non-negative integer');
  }
  return {
    type: 'UpdateTaskReminder',
    reminderMinutesBeforeDue: command.reminderMinutesBeforeDue,
  };
}

function normalizeExpectedVersion(value) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError('expectedVersion must be a positive integer');
  }
  return value;
}

function toTaskCommand({
  commandId,
  sourceKey,
  requestId,
  turnId,
  context,
  taskId,
  command,
  capability,
  expectedVersion,
}) {
  return {
    schemaVersion: 1,
    type: 'TaskCommand',
    commandId,
    idempotencyKey: sourceKey,
    requestId,
    turnId,
    traceId: context.traceId,
    source: context.source,
    actor: context.actor,
    taskId,
    command,
    capability,
    expectedVersion,
    aiMayConstructActor: false,
    aiMayWriteDatabase: false,
  };
}

function authorizationDecision(commandId, decision) {
  return {
    schemaVersion: 1,
    type: 'AuthorizationDecision',
    decisionId: `authz:${commandId}`,
    commandId,
    enforcedBy: 'TaskCore',
    decision,
    checked: [...AUTHORIZATION_CHECKS],
  };
}

export function initializeTaskApplicationSchema(database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS commitment_task_application_receipts (
      idempotency_key TEXT PRIMARY KEY,
      request_fingerprint TEXT NOT NULL,
      result_json TEXT NOT NULL,
      receipt_hash TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS commitment_task_effects (
      effect_id TEXT PRIMARY KEY,
      request_id TEXT NOT NULL,
      trace_id TEXT NOT NULL,
      source_json TEXT NOT NULL,
      actor_json TEXT NOT NULL,
      task_id TEXT NOT NULL,
      core_version INTEGER NOT NULL,
      origin TEXT NOT NULL,
      event_id TEXT,
      task_json TEXT NOT NULL,
      effect_hash TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE (task_id, core_version),
      FOREIGN KEY (task_id) REFERENCES commitment_tasks(id) ON DELETE RESTRICT,
      FOREIGN KEY (event_id) REFERENCES commitment_events(id) ON DELETE RESTRICT
    );

    CREATE TABLE IF NOT EXISTS commitment_task_authorization_scopes (
      task_id TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      tenant_ref TEXT NOT NULL,
      adapter_id TEXT NOT NULL,
      account_ref TEXT NOT NULL,
      binding_policy TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (task_id) REFERENCES commitment_tasks(id) ON DELETE RESTRICT
    );

    CREATE TRIGGER IF NOT EXISTS commitment_task_scope_no_update
    BEFORE UPDATE ON commitment_task_authorization_scopes
    BEGIN
      SELECT RAISE(ABORT, 'commitment task authorization scope is immutable');
    END;

    CREATE TRIGGER IF NOT EXISTS commitment_task_scope_no_delete
    BEFORE DELETE ON commitment_task_authorization_scopes
    BEGIN
      SELECT RAISE(ABORT, 'commitment task authorization scope is immutable');
    END;
  `);

  const receiptColumns = new Set(
    database.pragma('table_info(commitment_task_application_receipts)')
      .map((column) => column.name),
  );
  if (!receiptColumns.has('receipt_hash')) {
    database.exec(`
      ALTER TABLE commitment_task_application_receipts
      ADD COLUMN receipt_hash TEXT
    `);
  }
  const effectColumns = new Set(
    database.pragma('table_info(commitment_task_effects)').map((column) => column.name),
  );
  if (!effectColumns.has('effect_hash')) {
    database.exec(`
      ALTER TABLE commitment_task_effects
      ADD COLUMN effect_hash TEXT
    `);
  }

  const updateReceiptHash = database.prepare(`
    UPDATE commitment_task_application_receipts
    SET receipt_hash = ?
    WHERE idempotency_key = ? AND receipt_hash IS NULL
  `);
  for (const row of database.prepare(`
    SELECT idempotency_key, request_fingerprint, result_json
    FROM commitment_task_application_receipts
    WHERE receipt_hash IS NULL
  `).all()) {
    const result = parsePersistedJson(row.result_json, 'Task application receipt result');
    updateReceiptHash.run(
      receiptHash(row.idempotency_key, row.request_fingerprint, result),
      row.idempotency_key,
    );
  }

  const updateEffectHash = database.prepare(`
    UPDATE commitment_task_effects
    SET effect_hash = ?
    WHERE effect_id = ? AND effect_hash IS NULL
  `);
  for (const row of database.prepare(`
    SELECT effect_id, request_id, trace_id, source_json, actor_json, task_id,
           core_version, origin, event_id, task_json
    FROM commitment_task_effects
    WHERE effect_hash IS NULL
  `).all()) {
    const effect = {
      schemaVersion: 1,
      type: 'TaskEffect',
      effectId: row.effect_id,
      requestId: row.request_id,
      traceId: row.trace_id,
      source: parsePersistedJson(row.source_json, 'TaskEffect source'),
      actor: parsePersistedJson(row.actor_json, 'TaskEffect actor'),
      taskId: row.task_id,
      coreVersion: row.core_version,
      origin: row.origin,
      eventId: row.event_id,
      task: parsePersistedJson(row.task_json, 'TaskEffect task'),
    };
    updateEffectHash.run(fingerprint(effect), row.effect_id);
  }

  database.exec(`
    CREATE TRIGGER IF NOT EXISTS commitment_task_application_receipt_no_update
    BEFORE UPDATE ON commitment_task_application_receipts
    BEGIN
      SELECT RAISE(ABORT, 'commitment task application receipt is immutable');
    END;

    CREATE TRIGGER IF NOT EXISTS commitment_task_application_receipt_no_delete
    BEFORE DELETE ON commitment_task_application_receipts
    BEGIN
      SELECT RAISE(ABORT, 'commitment task application receipt is immutable');
    END;

    CREATE TRIGGER IF NOT EXISTS commitment_task_effect_no_update
    BEFORE UPDATE ON commitment_task_effects
    BEGIN
      SELECT RAISE(ABORT, 'commitment TaskEffect is immutable');
    END;

    CREATE TRIGGER IF NOT EXISTS commitment_task_effect_no_delete
    BEFORE DELETE ON commitment_task_effects
    BEGIN
      SELECT RAISE(ABORT, 'commitment TaskEffect is immutable');
    END;
  `);
  initializeTaskEffectRelaySchema(database);
}

export function createTaskApplicationModule({
  database,
  clock,
  idGenerator,
  ingestWithinTransaction,
  commandWithinTransaction,
  verifyActorAssertion,
  resolveLegacyTaskScope,
  effectIdGenerator = ({ commandId, taskId, coreVersion }) => stableId(
    'task-effect',
    { commandId, taskId, coreVersion },
  ),
}) {
  const selectReceipt = database.prepare(`
    SELECT request_fingerprint, result_json, receipt_hash
    FROM commitment_task_application_receipts
    WHERE idempotency_key = ?
  `);
  const insertReceipt = database.prepare(`
    INSERT INTO commitment_task_application_receipts (
      idempotency_key, request_fingerprint, result_json, receipt_hash, created_at
    ) VALUES (?, ?, ?, ?, ?)
  `);
  const selectEvent = database.prepare(`
    SELECT id, event_type, task_id, actor_id, from_state, to_state,
           task_version, occurred_at
    FROM commitment_events
    WHERE task_id = ? AND task_version = ?
  `);
  const selectTaskVersion = database.prepare(`
    SELECT version
    FROM commitment_tasks
    WHERE id = ?
  `);
  const selectTaskScope = database.prepare(`
    SELECT task_id, provider, tenant_ref, adapter_id, account_ref
    FROM commitment_task_authorization_scopes
    WHERE task_id = ?
  `);
  const insertTaskScope = database.prepare(`
    INSERT INTO commitment_task_authorization_scopes (
      task_id, provider, tenant_ref, adapter_id, account_ref, binding_policy, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const insertEffect = database.prepare(`
    INSERT INTO commitment_task_effects (
      effect_id, request_id, trace_id, source_json, actor_json, task_id,
      core_version, origin, event_id, task_json, effect_hash, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const selectEffect = database.prepare(`
    SELECT effect_id, request_id, trace_id, source_json, actor_json, task_id,
           core_version, origin, event_id, task_json, effect_hash
    FROM commitment_task_effects
    WHERE effect_id = ?
  `);
  const taskEffectRelay = createTaskEffectRelay({
    database,
    clock,
    loadEffect: (effectId) => effectView(selectEffect.get(effectId)),
  });

  function effectView(row) {
    const effect = taskEffectFromRow(row);
    if (!effect) return null;
    const event = selectEvent.get(effect.taskId, effect.coreVersion);
    if (
      !event
      || event.id !== effect.eventId
      || event.actor_id !== effect.actor?.externalId
    ) {
      throw persistedDataCorrupt(`TaskEffect event linkage mismatch: ${effect.effectId}`);
    }
    return effect;
  }

  function createAndInsertEffect({ commandId, requestId, context, task, event, timestamp }) {
    if (!event) return null;
    const effect = {
      schemaVersion: 1,
      type: 'TaskEffect',
      effectId: requireText(effectIdGenerator({
        commandId,
        taskId: task.id,
        coreVersion: task.version,
      }), 'generated effect id'),
      requestId,
      traceId: context.traceId,
      source: context.source,
      actor: context.actor,
      taskId: task.id,
      coreVersion: task.version,
      origin: context.origin,
      eventId: event.id,
      task,
    };
    insertEffect.run(
      effect.effectId,
      effect.requestId,
      effect.traceId,
      JSON.stringify(effect.source),
      JSON.stringify(effect.actor),
      effect.taskId,
      effect.coreVersion,
      effect.origin,
      effect.eventId,
      canonicalJson(effect.task),
      fingerprint(effect),
      timestamp,
    );
    taskEffectRelay.append(effect.effectId, timestamp);
    return effect;
  }

  function saveReceipt(sourceKey, requestFingerprint, result, timestamp) {
    insertReceipt.run(
      sourceKey,
      requestFingerprint,
      canonicalJson(result),
      receiptHash(sourceKey, requestFingerprint, result),
      timestamp,
    );
  }

  function normalizeScope(rawScope) {
    const scope = requireRecord(rawScope, 'legacy task scope');
    rejectUnknownFields(
      scope,
      new Set(['provider', 'tenantRef', 'adapterId', 'accountRef', 'policyId']),
      'legacy task scope',
    );
    return {
      provider: requireText(scope.provider, 'legacy task scope.provider'),
      tenantRef: requireText(scope.tenantRef, 'legacy task scope.tenantRef'),
      adapterId: requireText(scope.adapterId, 'legacy task scope.adapterId'),
      accountRef: requireText(scope.accountRef, 'legacy task scope.accountRef'),
      policyId: requireText(scope.policyId, 'legacy task scope.policyId'),
    };
  }

  function taskScopeCode(taskId, context, timestamp) {
    let scope = selectTaskScope.get(taskId);
    if (!scope && typeof resolveLegacyTaskScope === 'function') {
      const resolved = resolveLegacyTaskScope(Object.freeze({
        taskId,
        actor: Object.freeze({ ...context.actor }),
        source: Object.freeze({ ...context.source }),
      }));
      if (resolved) {
        const normalized = normalizeScope(resolved);
        bindTaskScope(taskId, normalized, timestamp);
        scope = selectTaskScope.get(taskId);
      }
    }
    if (!scope) return 'AUTHORIZATION_SCOPE_UNKNOWN';
    return (
      scope.provider === context.actor.provider
      && scope.tenant_ref === context.actor.tenantRef
      && scope.adapter_id === context.source.adapterId
      && scope.account_ref === context.source.accountRef
    ) ? null : 'AUTHORIZATION_SCOPE_MISMATCH';
  }

  function bindTaskScope(taskId, scope, timestamp) {
    insertTaskScope.run(
      taskId,
      scope.provider,
      scope.tenantRef,
      scope.adapterId,
      scope.accountRef,
      scope.policyId,
      timestamp,
    );
  }

  function replay(sourceKey, requestFingerprint) {
    const receipt = selectReceipt.get(sourceKey);
    if (!receipt) return null;
    const result = parsePersistedJson(receipt.result_json, 'Task application receipt result');
    if (receipt.receipt_hash !== receiptHash(sourceKey, receipt.request_fingerprint, result)) {
      throw persistedDataCorrupt(`Task application receipt hash mismatch: ${sourceKey}`);
    }
    if (receipt.request_fingerprint !== requestFingerprint) {
      throw domainError(
        'IDEMPOTENCY_CONFLICT',
        `idempotency key already belongs to different content: ${sourceKey}`,
      );
    }
    if (result.taskCommand?.idempotencyKey !== sourceKey) {
      throw persistedDataCorrupt(`Task application receipt command linkage mismatch: ${sourceKey}`);
    }
    if (
      result.task
      && result.taskCommand?.taskId !== result.task.id
    ) {
      throw persistedDataCorrupt(`Task application receipt task linkage mismatch: ${sourceKey}`);
    }
    if (result.effect) {
      const storedEffect = effectView(selectEffect.get(result.effect.effectId));
      if (
        !storedEffect
        || fingerprint(storedEffect) !== fingerprint(result.effect)
        || storedEffect.taskId !== result.taskCommand?.taskId
        || fingerprint(storedEffect.task) !== fingerprint(result.task)
        || (
          !result.suppressed
          && (
            storedEffect.requestId !== result.taskCommand?.requestId
            || storedEffect.traceId !== result.taskCommand?.traceId
            || fingerprint(storedEffect.actor) !== fingerprint(result.taskCommand?.actor)
            || fingerprint(storedEffect.source) !== fingerprint(result.taskCommand?.source)
            || result.event?.id !== storedEffect.eventId
          )
        )
      ) {
        throw persistedDataCorrupt(`Task application receipt effect linkage mismatch: ${sourceKey}`);
      }
    }
    if (
      result.authorizationDecision?.commandId !== result.taskCommand?.commandId
    ) {
      throw persistedDataCorrupt(`Task application receipt authorization linkage mismatch: ${sourceKey}`);
    }
    return { ...result, replayed: true };
  }

  function effectMatchesFeedbackContext(effect, context, commandType) {
    const event = selectEvent.get(effect.taskId, effect.coreVersion);
    return (
      event
      && EVENT_COMMANDS[event.event_type] === commandType
      && effect.actor.provider === context.actor.provider
      && effect.actor.tenantRef === context.actor.tenantRef
      && effect.actor.externalId === context.actor.externalId
      && effect.actor.provenance === context.actor.provenance
      && effect.source.adapterId === context.source.adapterId
      && effect.source.accountRef === context.source.accountRef
    );
  }

  function applyExistingCommand({
    requestId,
    turnId,
    sourceKey,
    context,
    taskId,
    rawCommand,
    rawExpectedVersion,
    rawCapability,
  }) {
    const command = normalizeApplicationCommand(rawCommand);
    const expectedVersion = normalizeExpectedVersion(rawExpectedVersion);
    const capability = requireText(rawCapability, 'capability');
    const requestFingerprint = fingerprint({
      requestId,
      turnId,
      sourceKey,
      context,
      taskId,
      command,
      expectedVersion,
      capability,
    });
    const existing = replay(sourceKey, requestFingerprint);
    if (existing) return existing;

    const commandId = stableId('task-command', { sourceKey, requestId, turnId });
    const taskCommand = toTaskCommand({
      commandId,
      sourceKey,
      requestId,
      turnId,
      context,
      taskId,
      command: command.type,
      capability,
      expectedVersion,
    });
    const timestamp = requireText(clock(), 'clock result');
    const requiredCapability = COMMAND_CAPABILITIES[command.type];
    if (capability !== requiredCapability || !context.capabilities.includes(capability)) {
      const result = {
        accepted: false,
        replayed: false,
        suppressed: false,
        code: 'CAPABILITY_DENIED',
        taskCommand,
        authorizationDecision: authorizationDecision(commandId, 'deny'),
        task: null,
        event: null,
        effect: null,
      };
      saveReceipt(sourceKey, requestFingerprint, result, timestamp);
      return result;
    }

    const scopeCode = taskScopeCode(taskId, context, timestamp);
    if (scopeCode) {
      const result = {
        accepted: false,
        replayed: false,
        suppressed: false,
        code: scopeCode,
        taskCommand,
        authorizationDecision: authorizationDecision(commandId, 'deny'),
        task: null,
        event: null,
        effect: null,
      };
      saveReceipt(sourceKey, requestFingerprint, result, timestamp);
      return result;
    }

    if (context.origin === 'native_task_projection' && context.originEffectId !== null) {
      const originEffect = effectView(selectEffect.get(context.originEffectId));
      const currentTask = selectTaskVersion.get(taskId);
      if (
        originEffect
        && originEffect.taskId === taskId
        && originEffect.coreVersion === expectedVersion
        && currentTask?.version === expectedVersion
        && effectMatchesFeedbackContext(originEffect, context, command.type)
      ) {
        const result = {
          accepted: true,
          replayed: false,
          suppressed: true,
          code: null,
          taskCommand,
          authorizationDecision: authorizationDecision(commandId, 'allow'),
          task: originEffect.task,
          event: null,
          effect: originEffect,
        };
        saveReceipt(sourceKey, requestFingerprint, result, timestamp);
        return result;
      }
    }

    let coreResult;
    try {
      coreResult = commandWithinTransaction({
        ...command,
        taskId,
        actorId: context.actor.externalId,
        idempotencyKey: sourceKey,
      }, expectedVersion);
    } catch (error) {
      if (!DENIAL_CODES.has(error?.code)) throw error;
      const result = {
        accepted: false,
        replayed: false,
        suppressed: false,
        code: error.code,
        taskCommand,
        authorizationDecision: authorizationDecision(commandId, 'deny'),
        task: null,
        event: null,
        effect: null,
      };
      saveReceipt(sourceKey, requestFingerprint, result, timestamp);
      return result;
    }

    const effect = createAndInsertEffect({
      commandId,
      requestId,
      context,
      task: coreResult.task,
      event: coreResult.event,
      timestamp,
    });
    const result = {
      accepted: true,
      replayed: false,
      suppressed: false,
      code: null,
      taskCommand,
      authorizationDecision: authorizationDecision(commandId, 'allow'),
      task: coreResult.task,
      event: coreResult.event,
      effect,
    };
    saveReceipt(sourceKey, requestFingerprint, result, timestamp);
    return result;
  }

  const acceptIntentTransaction = database.transaction((
    rawRequestId,
    rawTurnId,
    rawSourceKey,
    rawVerifiedActor,
    rawIntent,
  ) => {
    const requestId = requireText(rawRequestId, 'requestId');
    const turnId = requireText(rawTurnId, 'turnId');
    const sourceKey = requireText(rawSourceKey, 'sourceKey');
    const context = normalizeVerifiedContext(rawVerifiedActor, verifyActorAssertion);
    const intent = normalizeTaskIntent(rawIntent);
    if (intent.command !== 'CreateTask') {
      const normalizedCommand = normalizeApplicationCommand(intent.command);
      return applyExistingCommand({
        requestId,
        turnId,
        sourceKey,
        context,
        taskId: intent.taskId,
        rawCommand: normalizedCommand,
        rawExpectedVersion: intent.expectedVersion,
        rawCapability: COMMAND_CAPABILITIES[normalizedCommand.type],
      });
    }
    const requestFingerprint = fingerprint({ requestId, turnId, sourceKey, context, intent });
    const existing = replay(sourceKey, requestFingerprint);
    if (existing) return existing;

    const commandId = stableId('task-command', { sourceKey, requestId, turnId });
    const timestamp = requireText(clock(), 'clock result');
    if (!context.capabilities.includes('task.create')) {
      const requestedTaskId = requireText(idGenerator(), 'generated task id');
      const taskCommand = toTaskCommand({
        commandId,
        sourceKey,
        requestId,
        turnId,
        context,
        taskId: requestedTaskId,
        command: 'CreateTask',
        capability: 'task.create',
        expectedVersion: 0,
      });
      const result = {
        accepted: false,
        replayed: false,
        code: 'CAPABILITY_DENIED',
        taskCommand,
        authorizationDecision: authorizationDecision(commandId, 'deny'),
        task: null,
        event: null,
        effect: null,
      };
      saveReceipt(sourceKey, requestFingerprint, result, timestamp);
      return result;
    }

    const { created, task, creationFact } = ingestWithinTransaction({
      idempotencyKey: sourceKey,
      source: {
        channel: context.source.adapterId,
        externalId: context.source.messageId,
        senderId: context.actor.externalId,
      },
      task: {
        title: intent.title,
        description: intent.description,
        ownerId: context.actor.externalId,
        acceptorId: context.actor.externalId,
        assigneeId: null,
        dueAt: intent.dueAt,
        reminderMinutesBeforeDue: intent.reminderMinutesBeforeDue,
      },
    }, { includeCreationFact: true });
    const taskCommand = toTaskCommand({
      commandId,
      sourceKey,
      requestId,
      turnId,
      context,
      taskId: task.id,
      command: 'CreateTask',
      capability: 'task.create',
      expectedVersion: 0,
    });
    if (created) {
      bindTaskScope(task.id, {
        provider: context.actor.provider,
        tenantRef: context.actor.tenantRef,
        adapterId: context.source.adapterId,
        accountRef: context.source.accountRef,
        policyId: 'task_core_create',
      }, timestamp);
    } else {
      const scopeCode = taskScopeCode(task.id, context, timestamp);
      if (scopeCode) {
        const result = {
          accepted: false,
          replayed: false,
          code: scopeCode,
          taskCommand,
          authorizationDecision: authorizationDecision(commandId, 'deny'),
          task: null,
          event: null,
          effect: null,
        };
        saveReceipt(sourceKey, requestFingerprint, result, timestamp);
        return result;
      }
    }
    const factTask = creationFact.task;
    const event = creationFact.event;
    const effect = createAndInsertEffect({
      commandId,
      requestId,
      context,
      task: factTask,
      event,
      timestamp,
    });
    const result = {
      accepted: true,
      replayed: false,
      code: null,
      taskCommand,
      authorizationDecision: authorizationDecision(commandId, 'allow'),
      task: factTask,
      event,
      effect,
    };
    saveReceipt(sourceKey, requestFingerprint, result, timestamp);
    return result;
  });

  const executeCommandTransaction = database.transaction((
    rawRequestId,
    rawTurnId,
    rawSourceKey,
    rawVerifiedActor,
    rawTaskId,
    rawCommand,
    rawExpectedVersion,
    rawCapability,
  ) => applyExistingCommand({
    requestId: requireText(rawRequestId, 'requestId'),
    turnId: requireText(rawTurnId, 'turnId'),
    sourceKey: requireText(rawSourceKey, 'sourceKey'),
    context: normalizeVerifiedContext(rawVerifiedActor, verifyActorAssertion),
    taskId: requireText(rawTaskId, 'taskId'),
    rawCommand,
    rawExpectedVersion,
    rawCapability,
  }));

  return Object.freeze({
    effects: taskEffectRelay.publicInterface,
    acceptIntent(requestId, turnId, sourceKey, verifiedActor, intent) {
      return acceptIntentTransaction.immediate(
        requestId,
        turnId,
        sourceKey,
        verifiedActor,
        intent,
      );
    },
    executeCommand(
      requestId,
      turnId,
      sourceKey,
      verifiedActor,
      taskId,
      command,
      expectedVersion,
      capability,
    ) {
      return executeCommandTransaction.immediate(
        requestId,
        turnId,
        sourceKey,
        verifiedActor,
        taskId,
        command,
        expectedVersion,
        capability,
      );
    },
  });
}
