import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import Database from 'better-sqlite3';

import {
  createTaskActorAssertionAuthority,
  openCommitmentCore,
} from '../core.js';

const actorAuthority = createTaskActorAssertionAuthority();

const TASK_APPLICATION_TEST_PREFIXES = [
  'zylos-task-application-',
  'zylos-task-legacy-scope-',
  'zylos-task-legacy-replay-',
  'zylos-task-tamper-',
  'zylos-task-effect-relay-',
  'zylos-task-effect-corrupt-',
  'zylos-task-concurrency-',
  'zylos-task-rollback-',
  'zylos-task-migration-',
  'zylos-task-hardening-migration-',
];

function removeTaskApplicationTestDirectory(directory) {
  assert.equal(path.dirname(directory), os.tmpdir());
  assert.equal(
    TASK_APPLICATION_TEST_PREFIXES.some(prefix => path.basename(directory).startsWith(prefix)),
    true,
  );
  rmSync(directory, { recursive: true, force: true });
}

function rawVerifiedContext(overrides = {}) {
  return {
    provider: 'feishu',
    tenantRef: 'tenant-01',
    externalId: 'owner-01',
    provenance: 'verified_channel_actor',
    traceId: 'trace:req-001',
    origin: 'assistant_tool',
    capabilities: ['task.create'],
    source: {
      adapterId: 'feishu',
      accountRef: 'acct-01',
      eventType: 'im.message.receive_v1',
      eventId: 'event-001',
      messageId: 'message-001',
    },
    ...overrides,
  };
}

function verifiedContext(overrides = {}) {
  return actorAuthority.issue(rawVerifiedContext(overrides));
}

function testLegacyScopeResolver() {
  return {
    provider: 'feishu',
    tenantRef: 'tenant-01',
    adapterId: 'feishu',
    accountRef: 'acct-01',
    policyId: 'test-explicit-legacy-scope',
  };
}

function openAuthorizedCore(options) {
  const {
    dbPath,
    taskLegacyScopeResolver = testLegacyScopeResolver,
    ...coreOptions
  } = options;
  return openCommitmentCore({
    ...coreOptions,
    dbPath,
    taskActorAssertionVerifier: actorAuthority.verify,
    taskLegacyScopeResolver,
  });
}

function createHarness() {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'zylos-task-application-'));
  let eventIndex = 0;
  const core = openAuthorizedCore({
    dbPath: path.join(directory, 'commitments.db'),
    clock: () => '2026-09-01T10:00:00.000Z',
    idGenerator: () => 'task-001',
    eventIdGenerator: () => `event-${++eventIndex}`,
  });
  return {
    core,
    cleanup() {
      core.close();
      removeTaskApplicationTestDirectory(directory);
    },
  };
}

test('AI create intent derives identity and ownership only from verified context', () => {
  const harness = createHarness();
  try {
    const decision = harness.core.taskCore.acceptIntent(
      'req-001',
      'turn:req-001:1',
      'feishu:acct-01:message-001:create',
      verifiedContext(),
      { command: 'CreateTask', title: 'Prepare the customer review' },
    );

    assert.equal(decision.accepted, true);
    assert.equal(decision.task.ownerId, 'owner-01');
    assert.equal(decision.task.acceptorId, 'owner-01');
    assert.equal(decision.task.assigneeId, null);
    assert.deepEqual(decision.taskCommand.actor, {
      provider: 'feishu',
      tenantRef: 'tenant-01',
      externalId: 'owner-01',
      provenance: 'verified_channel_actor',
    });
    assert.deepEqual(decision.taskCommand.source, rawVerifiedContext().source);
    assert.equal(decision.taskCommand.capability, 'task.create');
    assert.equal(decision.taskCommand.aiMayConstructActor, false);
    assert.equal(decision.taskCommand.aiMayWriteDatabase, false);
    assert.equal(harness.core.query({ taskId: 'task-001' }).state, 'ready');
  } finally {
    harness.cleanup();
  }
});

test('AI intent cannot inject identity, ownership, source, or capability', () => {
  const harness = createHarness();
  try {
    for (const injected of [
      { actor: { externalId: 'attacker' } },
      { tenantRef: 'tenant-attacker' },
      { source: { adapterId: 'forged' } },
      { capability: 'task.accept' },
      { ownerId: 'attacker' },
      { acceptorId: 'attacker' },
      { assigneeId: 'attacker' },
    ]) {
      assert.throws(() => harness.core.taskCore.acceptIntent(
        'req-001',
        'turn:req-001:1',
        `source:${Object.keys(injected)[0]}`,
        verifiedContext(),
        { command: 'CreateTask', title: 'Do not trust the model', ...injected },
      ), /unsupported task intent field/);
    }

    const denied = harness.core.taskCore.acceptIntent(
      'req-denied',
      'turn:req-denied:1',
      'source:missing-capability',
      verifiedContext({ traceId: 'trace:req-denied', capabilities: [] }),
      { command: 'CreateTask', title: 'Must not be created' },
    );
    assert.equal(denied.accepted, false);
    assert.equal(denied.code, 'CAPABILITY_DENIED');
    assert.equal(denied.authorizationDecision.decision, 'deny');
    assert.equal(harness.core.query({ taskId: denied.taskCommand.taskId }), null);

    assert.throws(() => harness.core.taskCore.acceptIntent(
      'req-unverified',
      'turn:req-unverified:1',
      'source:unverified',
      rawVerifiedContext(),
      { command: 'CreateTask', title: 'Must fail closed' },
    ), (error) => error?.code === 'UNVERIFIED_ACTOR');

    const otherAuthority = createTaskActorAssertionAuthority();
    assert.throws(() => harness.core.taskCore.acceptIntent(
      'req-wrong-authority',
      'turn:req-wrong-authority:1',
      'source:wrong-authority',
      otherAuthority.issue(rawVerifiedContext()),
      { command: 'CreateTask', title: 'Must fail closed' },
    ), (error) => error?.code === 'UNVERIFIED_ACTOR');
  } finally {
    harness.cleanup();
  }
});

test('executeCommand enforces capability, object role, state, and expected version', () => {
  const harness = createHarness();
  try {
    harness.core.ingest({
      idempotencyKey: 'seed:task-001',
      source: { channel: 'test', externalId: 'seed-001', senderId: 'owner-01' },
      task: {
        title: 'Role protected task',
        ownerId: 'owner-01',
        assigneeId: 'assignee-01',
        acceptorId: 'acceptor-01',
      },
    });

    const assignee = verifiedContext({
      externalId: 'assignee-01',
      origin: 'structured_action',
      capabilities: ['task.start', 'task.submit_for_review'],
    });
    const started = harness.core.taskCore.executeCommand(
      'req-start', 'turn:req-start:1', 'source:start', assignee,
      'task-001', 'StartTask', 1, 'task.start',
    );
    assert.equal(started.accepted, true);
    assert.equal(started.task.state, 'in_progress');

    const forgedCapability = harness.core.taskCore.executeCommand(
      'req-forged-cap', 'turn:req-forged-cap:1', 'source:forged-cap', assignee,
      'task-001', 'SubmitForReview', 2, 'task.accept',
    );
    assert.equal(forgedCapability.accepted, false);
    assert.equal(forgedCapability.code, 'CAPABILITY_DENIED');
    assert.equal(harness.core.query({ taskId: 'task-001' }).version, 2);

    const wrongActor = harness.core.taskCore.executeCommand(
      'req-wrong-actor', 'turn:req-wrong-actor:1', 'source:wrong-actor',
      verifiedContext({
        externalId: 'attacker-01',
        capabilities: ['task.submit_for_review'],
      }),
      'task-001', 'SubmitForReview', 2, 'task.submit_for_review',
    );
    assert.equal(wrongActor.accepted, false);
    assert.equal(wrongActor.code, 'FORBIDDEN');

    const stale = harness.core.taskCore.executeCommand(
      'req-stale', 'turn:req-stale:1', 'source:stale', assignee,
      'task-001', 'SubmitForReview', 1, 'task.submit_for_review',
    );
    assert.equal(stale.accepted, false);
    assert.equal(stale.code, 'VERSION_CONFLICT');

    const submitted = harness.core.taskCore.executeCommand(
      'req-submit', 'turn:req-submit:1', 'source:submit', assignee,
      'task-001', 'SubmitForReview', 2, 'task.submit_for_review',
    );
    assert.equal(submitted.task.state, 'review');

    const ownerCannotAccept = harness.core.taskCore.executeCommand(
      'req-owner-accept', 'turn:req-owner-accept:1', 'source:owner-accept',
      verifiedContext({ externalId: 'owner-01', capabilities: ['task.accept'] }),
      'task-001', 'AcceptTask', 3, 'task.accept',
    );
    assert.equal(ownerCannotAccept.code, 'FORBIDDEN');

    const accepted = harness.core.taskCore.executeCommand(
      'req-accept', 'turn:req-accept:1', 'source:accept',
      verifiedContext({ externalId: 'acceptor-01', capabilities: ['task.accept'] }),
      'task-001', 'AcceptTask', 3, 'task.accept',
    );
    assert.equal(accepted.task.state, 'done');

    const reopened = harness.core.taskCore.executeCommand(
      'req-reopen', 'turn:req-reopen:1', 'source:reopen',
      verifiedContext({ externalId: 'owner-01', capabilities: ['task.reopen'] }),
      'task-001', 'ReopenTask', 4, 'task.reopen',
    );
    assert.equal(reopened.task.state, 'ready');

    const illegalAccept = harness.core.taskCore.executeCommand(
      'req-illegal', 'turn:req-illegal:1', 'source:illegal',
      verifiedContext({ externalId: 'acceptor-01', capabilities: ['task.accept'] }),
      'task-001', 'AcceptTask', 5, 'task.accept',
    );
    assert.equal(illegalAccept.code, 'INVALID_TRANSITION');

    const cancelled = harness.core.taskCore.executeCommand(
      'req-cancel', 'turn:req-cancel:1', 'source:cancel',
      verifiedContext({ externalId: 'owner-01', capabilities: ['task.cancel'] }),
      'task-001', 'CancelTask', 5, 'task.cancel',
    );
    assert.equal(cancelled.task.state, 'cancelled');
  } finally {
    harness.cleanup();
  }
});

test('Task Core scopes authorization to the verified tenant and route', () => {
  const harness = createHarness();
  try {
    const created = harness.core.taskCore.acceptIntent(
      'req-scope-create',
      'turn:req-scope-create:1',
      'source:scope-create',
      verifiedContext(),
      { command: 'CreateTask', title: 'Tenant-owned task' },
    );
    const crossTenant = harness.core.taskCore.executeCommand(
      'req-cross-tenant',
      'turn:req-cross-tenant:1',
      'source:cross-tenant',
      verifiedContext({
        tenantRef: 'tenant-02',
        capabilities: ['task.start'],
      }),
      created.task.id,
      'StartTask',
      created.task.version,
      'task.start',
    );
    assert.equal(crossTenant.accepted, false);
    assert.equal(crossTenant.code, 'AUTHORIZATION_SCOPE_MISMATCH');
    assert.equal(harness.core.query({ taskId: created.task.id }).state, 'ready');

    for (const [label, context] of [
      ['provider', { provider: 'lark' }],
      ['adapter', {
        source: { ...rawVerifiedContext().source, adapterId: 'feishu-secondary' },
      }],
      ['account', {
        source: { ...rawVerifiedContext().source, accountRef: 'acct-02' },
      }],
    ]) {
      const denied = harness.core.taskCore.executeCommand(
        `req-cross-${label}`,
        `turn:req-cross-${label}:1`,
        `source:cross-${label}`,
        verifiedContext({ ...context, capabilities: ['task.start'] }),
        created.task.id,
        'StartTask',
        created.task.version,
        'task.start',
      );
      assert.equal(denied.code, 'AUTHORIZATION_SCOPE_MISMATCH', label);
    }
  } finally {
    harness.cleanup();
  }
});

test('legacy tasks fail closed until an explicit scope policy binds them durably', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'zylos-task-legacy-scope-'));
  const dbPath = path.join(directory, 'commitments.db');
  let core = openAuthorizedCore({
    dbPath,
    idGenerator: () => 'task-legacy-scope',
    eventIdGenerator: () => 'event-legacy-scope-created',
    taskLegacyScopeResolver: null,
  });
  try {
    core.ingest({
      idempotencyKey: 'seed:legacy-scope',
      source: { channel: 'test', externalId: 'legacy-scope', senderId: 'owner-01' },
      task: { title: 'Legacy unscoped task', ownerId: 'owner-01' },
    });
    const denied = core.taskCore.executeCommand(
      'req-legacy-denied', 'turn:req-legacy-denied:1', 'source:legacy-denied',
      verifiedContext({ capabilities: ['task.start'] }),
      'task-legacy-scope', 'StartTask', 1, 'task.start',
    );
    assert.equal(denied.code, 'AUTHORIZATION_SCOPE_UNKNOWN');
    core.close();

    core = openAuthorizedCore({
      dbPath,
      eventIdGenerator: () => 'event-legacy-scope-started',
    });
    const bound = core.taskCore.executeCommand(
      'req-legacy-bound', 'turn:req-legacy-bound:1', 'source:legacy-bound',
      verifiedContext({ capabilities: ['task.start'] }),
      'task-legacy-scope', 'StartTask', 1, 'task.start',
    );
    assert.equal(bound.accepted, true);
    core.close();

    core = openAuthorizedCore({ dbPath, taskLegacyScopeResolver: null });
    const persisted = core.taskCore.executeCommand(
      'req-legacy-persisted', 'turn:req-legacy-persisted:1', 'source:legacy-persisted',
      verifiedContext({ capabilities: ['task.submit_for_review'] }),
      'task-legacy-scope', 'SubmitForReview', 2, 'task.submit_for_review',
    );
    assert.equal(persisted.accepted, true);
  } finally {
    core.close();
    removeTaskApplicationTestDirectory(directory);
  }
});

test('legacy source cutover replays the original TaskCreated fact after the Task advances', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'zylos-task-legacy-replay-'));
  const dbPath = path.join(directory, 'commitments.db');
  const generatedIds = ['task-existing', 'task-ghost'];
  const eventIds = ['event-existing-created', 'event-existing-started'];
  let core = openAuthorizedCore({
    dbPath,
    idGenerator: () => generatedIds.shift(),
    eventIdGenerator: () => eventIds.shift(),
  });
  try {
    const created = core.ingest({
      idempotencyKey: 'source:legacy-replay',
      source: { channel: 'feishu', externalId: 'message-001', senderId: 'owner-01' },
      task: {
        title: 'Existing canonical task',
        ownerId: 'owner-01',
        acceptorId: 'owner-01',
        assigneeId: null,
      },
    });
    const started = core.command({
      type: 'StartTask',
      taskId: created.task.id,
      actorId: 'owner-01',
      idempotencyKey: 'legacy-command:start',
    }, 1);
    assert.equal(started.task.version, 2);
    assert.equal(started.event.type, 'TaskStarted');

    assert.throws(() => core.taskCore.acceptIntent(
      'req-legacy-replay',
      'turn:req-legacy-replay:1',
      'source:legacy-replay',
      verifiedContext(),
      { command: 'CreateTask', title: 'Conflicting title before cutover' },
    ), (error) => error?.code === 'IDEMPOTENCY_CONFLICT');

    const result = core.taskCore.acceptIntent(
      'req-legacy-replay',
      'turn:req-legacy-replay:1',
      'source:legacy-replay',
      verifiedContext(),
      { command: 'CreateTask', title: 'Existing canonical task' },
    );
    assert.equal(result.accepted, true);
    assert.equal(result.task.id, 'task-existing');
    assert.equal(result.task.state, 'ready');
    assert.equal(result.task.version, 1);
    assert.equal(result.taskCommand.taskId, 'task-existing');
    assert.equal(result.taskCommand.command, 'CreateTask');
    assert.equal(result.taskCommand.expectedVersion, 0);
    assert.equal(result.event.id, 'event-existing-created');
    assert.equal(result.event.type, 'TaskCreated');
    assert.equal(result.event.version, 1);
    assert.equal(result.effect.taskId, 'task-existing');
    assert.equal(result.effect.eventId, 'event-existing-created');
    assert.equal(result.effect.coreVersion, 1);
    assert.equal(result.effect.task.version, 1);
    assert.equal(core.query({ taskId: 'task-existing' }).state, 'in_progress');
    assert.equal(core.query({ taskId: 'task-existing' }).version, 2);
    assert.equal(core.query({ taskId: 'task-ghost' }), null);
    assert.deepEqual(generatedIds, ['task-ghost']);

    core.close();
    core = openAuthorizedCore({ dbPath });
    const replayed = core.taskCore.acceptIntent(
      'req-legacy-replay',
      'turn:req-legacy-replay:1',
      'source:legacy-replay',
      verifiedContext(),
      { command: 'CreateTask', title: 'Existing canonical task' },
    );
    assert.deepEqual(replayed, { ...result, replayed: true });
    assert.throws(() => core.taskCore.acceptIntent(
      'req-legacy-replay',
      'turn:req-legacy-replay:1',
      'source:legacy-replay',
      verifiedContext(),
      { command: 'CreateTask', title: 'Conflicting title' },
    ), (error) => error?.code === 'IDEMPOTENCY_CONFLICT');

    core.close();
    core = null;
    const database = new Database(dbPath, { readonly: true });
    assert.equal(database.prepare(`
      SELECT COUNT(*) FROM commitment_task_application_receipts
      WHERE idempotency_key = 'source:legacy-replay'
    `).pluck().get(), 1);
    assert.equal(database.prepare('SELECT COUNT(*) FROM commitment_task_effects').pluck().get(), 1);
    assert.equal(database.pragma('integrity_check', { simple: true }), 'ok');
    assert.deepEqual(database.pragma('foreign_key_check'), []);
    database.close();
  } finally {
    core?.close();
    removeTaskApplicationTestDirectory(directory);
  }
});

test('legacy source cutover rejects when the original Task snapshot is no longer provable', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'zylos-task-legacy-replay-'));
  const dbPath = path.join(directory, 'commitments.db');
  const eventIds = ['event-unprovable-created'];
  let core = openAuthorizedCore({
    dbPath,
    idGenerator: () => 'task-unprovable-cutover',
    eventIdGenerator: () => eventIds.shift(),
  });
  const cutOver = () => core.taskCore.acceptIntent(
    'req-unprovable-cutover',
    'turn:req-unprovable-cutover:1',
    'source:unprovable-cutover',
    verifiedContext(),
    {
      command: 'CreateTask',
      title: 'Creation provenance must remain provable',
    },
  );
  try {
    const created = core.ingest({
      idempotencyKey: 'source:unprovable-cutover',
      source: { channel: 'feishu', externalId: 'message-001', senderId: 'owner-01' },
      task: {
        title: 'Creation provenance must remain provable',
        ownerId: 'owner-01',
        acceptorId: 'owner-01',
        assigneeId: null,
      },
    });
    core.close();
    core = null;
    const database = new Database(dbPath);
    database.prepare(`
      UPDATE commitment_events SET actor_id = 'tampered-actor'
      WHERE task_id = ? AND task_version = 1
    `).run(created.task.id);
    assert.equal(database.pragma('integrity_check', { simple: true }), 'ok');
    assert.deepEqual(database.pragma('foreign_key_check'), []);
    database.close();

    core = openAuthorizedCore({ dbPath });
    assert.throws(cutOver, (error) => (
      error?.code === 'IDEMPOTENCY_CONFLICT'
      && /provable original TaskCreated fact/.test(error.message)
    ));
    assert.equal(core.query({ taskId: created.task.id }).version, 1);

    core.close();
    core = null;
    const verification = new Database(dbPath, { readonly: true });
    assert.equal(verification.prepare(`
      SELECT COUNT(*) FROM commitment_task_application_receipts
      WHERE idempotency_key = 'source:unprovable-cutover'
    `).pluck().get(), 0);
    assert.equal(verification.prepare('SELECT COUNT(*) FROM commitment_task_effects').pluck().get(), 0);
    assert.equal(verification.pragma('integrity_check', { simple: true }), 'ok');
    assert.deepEqual(verification.pragma('foreign_key_check'), []);
    verification.close();
  } finally {
    core?.close();
    removeTaskApplicationTestDirectory(directory);
  }
});

test('assistant intent and structured action have equivalent authorization and facts', () => {
  function runPath(origin) {
    const harness = createHarness();
    harness.core.ingest({
      idempotencyKey: `seed:${origin}`,
      source: { channel: 'test', externalId: `seed:${origin}`, senderId: 'owner-01' },
      task: {
        title: 'Equivalent task',
        ownerId: 'owner-01',
        assigneeId: 'assignee-01',
        acceptorId: 'acceptor-01',
      },
    });
    harness.core.command({
      type: 'StartTask',
      taskId: 'task-001',
      actorId: 'assignee-01',
      idempotencyKey: `seed:start:${origin}`,
    }, 1);
    const context = verifiedContext({
      externalId: 'assignee-01',
      origin,
      capabilities: ['task.submit_for_review'],
    });
    const decision = origin === 'assistant_tool'
      ? harness.core.taskCore.acceptIntent(
        'req-equivalent', 'turn:req-equivalent:1', `source:${origin}`, context,
        { taskId: 'task-001', command: 'SubmitForReview', expectedVersion: 2 },
      )
      : harness.core.taskCore.executeCommand(
        'req-equivalent', 'turn:req-equivalent:1', `source:${origin}`, context,
        'task-001', 'SubmitForReview', 2, 'task.submit_for_review',
      );
    return { harness, decision };
  }

  const ai = runPath('assistant_tool');
  const structured = runPath('structured_action');
  try {
    assert.equal(ai.decision.accepted, structured.decision.accepted);
    assert.equal(ai.decision.code, structured.decision.code);
    assert.equal(ai.decision.task.state, structured.decision.task.state);
    assert.equal(ai.decision.task.version, structured.decision.task.version);
    assert.equal(ai.decision.event.type, structured.decision.event.type);
    assert.deepEqual(
      ai.decision.authorizationDecision.checked,
      structured.decision.authorizationDecision.checked,
    );
    assert.equal(ai.decision.effect.coreVersion, structured.decision.effect.coreVersion);
  } finally {
    ai.harness.cleanup();
    structured.harness.cleanup();
  }
});

test('TaskEffect is stable on replay and its origin fence suppresses projection feedback', () => {
  const harness = createHarness();
  try {
    const args = [
      'req-effect',
      'turn:req-effect:1',
      'source:effect',
      verifiedContext({ traceId: 'trace:req-effect' }),
      { command: 'CreateTask', title: 'Project exactly once' },
    ];
    const created = harness.core.taskCore.acceptIntent(...args);
    const replay = harness.core.taskCore.acceptIntent(...args);

    assert.equal(replay.replayed, true);
    assert.equal(replay.effect.effectId, created.effect.effectId);
    assert.deepEqual(Object.keys(created.taskCommand).sort(), [
      'actor', 'aiMayConstructActor', 'aiMayWriteDatabase', 'capability', 'command',
      'commandId', 'expectedVersion', 'idempotencyKey', 'requestId', 'schemaVersion',
      'source', 'taskId', 'traceId', 'turnId', 'type',
    ]);
    assert.deepEqual(Object.keys(created.authorizationDecision).sort(), [
      'checked', 'commandId', 'decision', 'decisionId', 'enforcedBy',
      'schemaVersion', 'type',
    ]);
    for (const field of [
      'effectId', 'requestId', 'traceId', 'source', 'actor', 'taskId',
      'coreVersion', 'origin',
    ]) assert.equal(Object.hasOwn(created.effect, field), true, field);

    assert.throws(() => harness.core.taskCore.acceptIntent(
      ...args.slice(0, 4),
      { command: 'CreateTask', title: 'Conflicting payload' },
    ), (error) => error?.code === 'IDEMPOTENCY_CONFLICT');

    const started = harness.core.taskCore.executeCommand(
      'req-effect-start',
      'turn:req-effect-start:1',
      'source:effect-start',
      verifiedContext({ capabilities: ['task.start'] }),
      created.task.id,
      'StartTask',
      created.task.version,
      'task.start',
    );

    const feedback = harness.core.taskCore.executeCommand(
      'req-feedback',
      'turn:req-feedback:1',
      'source:feedback',
      verifiedContext({
        traceId: 'trace:req-feedback',
        origin: 'native_task_projection',
        originEffectId: started.effect.effectId,
        capabilities: ['task.start'],
      }),
      created.task.id,
      'StartTask',
      started.task.version,
      'task.start',
    );
    assert.equal(feedback.accepted, true);
    assert.equal(feedback.suppressed, true);
    assert.equal(feedback.effect.effectId, started.effect.effectId);
    assert.equal(harness.core.query({ taskId: created.task.id }).state, 'in_progress');
    assert.deepEqual(
      harness.core.query({ taskId: created.task.id, includeEvents: true })
        .events.map((event) => event.type),
      ['TaskCreated', 'TaskStarted'],
    );

    const stolenEffect = harness.core.taskCore.executeCommand(
      'req-stolen-effect',
      'turn:req-stolen-effect:1',
      'source:stolen-effect',
      verifiedContext({
        externalId: 'attacker-01',
        traceId: 'trace:req-stolen-effect',
        origin: 'native_task_projection',
        originEffectId: started.effect.effectId,
        capabilities: ['task.start'],
      }),
      created.task.id,
      'StartTask',
      started.task.version,
      'task.start',
    );
    assert.equal(stolenEffect.accepted, false);
    assert.equal(stolenEffect.suppressed, false);
    assert.equal(stolenEffect.code, 'INVALID_TRANSITION');

    harness.core.command({
      type: 'SubmitForReview',
      taskId: created.task.id,
      actorId: 'owner-01',
      idempotencyKey: 'seed:submit-after-feedback',
    }, started.task.version);
    const staleFeedback = harness.core.taskCore.executeCommand(
      'req-stale-feedback',
      'turn:req-stale-feedback:1',
      'source:stale-feedback',
      verifiedContext({
        traceId: 'trace:req-stale-feedback',
        origin: 'native_task_projection',
        originEffectId: started.effect.effectId,
        capabilities: ['task.start'],
      }),
      created.task.id,
      'StartTask',
      started.task.version,
      'task.start',
    );
    assert.equal(staleFeedback.accepted, false);
    assert.equal(staleFeedback.suppressed, false);
    assert.equal(staleFeedback.code, 'VERSION_CONFLICT');
  } finally {
    harness.cleanup();
  }
});

test('projection feedback cannot use one TaskEffect to suppress a different command', () => {
  const harness = createHarness();
  try {
    const created = harness.core.taskCore.acceptIntent(
      'req-effect-command', 'turn:req-effect-command:1', 'source:effect-command',
      verifiedContext(),
      { command: 'CreateTask', title: 'Effect command linkage' },
    );
    const mismatched = harness.core.taskCore.executeCommand(
      'req-effect-command-mismatch',
      'turn:req-effect-command-mismatch:1',
      'source:effect-command-mismatch',
      verifiedContext({
        origin: 'native_task_projection',
        originEffectId: created.effect.effectId,
        capabilities: ['task.accept'],
      }),
      created.task.id,
      'AcceptTask',
      created.task.version,
      'task.accept',
    );
    assert.equal(mismatched.accepted, false);
    assert.equal(mismatched.suppressed, false);
    assert.equal(mismatched.code, 'INVALID_TRANSITION');
  } finally {
    harness.cleanup();
  }
});

test('application receipts and TaskEffects are immutable and tamper-evident on replay', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'zylos-task-tamper-'));
  const dbPath = path.join(directory, 'commitments.db');
  let core = openAuthorizedCore({
    dbPath,
    idGenerator: () => 'task-tamper',
    eventIdGenerator: () => 'event-tamper-created',
  });
  const args = [
    'req-tamper', 'turn:req-tamper:1', 'source:tamper', verifiedContext(),
    { command: 'CreateTask', title: 'Tamper-evident task' },
  ];
  try {
    const created = core.taskCore.acceptIntent(...args);
    core.close();

    const database = new Database(dbPath);
    assert.throws(() => database.prepare(`
      UPDATE commitment_task_application_receipts
      SET result_json = '{}'
      WHERE idempotency_key = 'source:tamper'
    `).run(), /immutable/);
    assert.throws(() => database.prepare(`
      DELETE FROM commitment_task_application_receipts
      WHERE idempotency_key = 'source:tamper'
    `).run(), /immutable/);
    assert.throws(() => database.prepare(`
      UPDATE commitment_task_effects
      SET actor_json = '{}'
      WHERE effect_id = ?
    `).run(created.effect.effectId), /immutable/);
    assert.throws(() => database.prepare(`
      DELETE FROM commitment_task_effects
      WHERE effect_id = ?
    `).run(created.effect.effectId), /immutable/);

    database.exec('DROP TRIGGER commitment_task_application_receipt_no_update');
    database.prepare(`
      UPDATE commitment_task_application_receipts
      SET result_json = '{}'
      WHERE idempotency_key = 'source:tamper'
    `).run();
    database.close();

    core = openAuthorizedCore({ dbPath });
    assert.throws(
      () => core.taskCore.acceptIntent(...args),
      (error) => error?.code === 'PERSISTED_DATA_CORRUPT',
    );
  } finally {
    core.close();
    removeTaskApplicationTestDirectory(directory);
  }
});

test('TaskEffect relay survives restart and fences an expired claimant with leaseEpoch', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'zylos-task-effect-relay-'));
  const dbPath = path.join(directory, 'commitments.db');
  let now = '2026-09-01T10:00:00.000Z';
  let core = openAuthorizedCore({
    dbPath,
    clock: () => now,
    idGenerator: () => 'task-relay',
    eventIdGenerator: () => 'event-relay-created',
  });
  try {
    const created = core.taskCore.acceptIntent(
      'req-relay', 'turn:req-relay:1', 'source:relay', verifiedContext(),
      { command: 'CreateTask', title: 'Relay after restart' },
    );
    core.close();

    core = openAuthorizedCore({ dbPath, clock: () => now });
    const [first] = core.taskCore.effects.claim({
      workerId: 'worker-1',
      leaseMs: 1_000,
      limit: 1,
    });
    assert.equal(first.effect.effectId, created.effect.effectId);
    assert.equal(first.leaseEpoch, 1);
    assert.equal(first.attempt, 1);

    now = '2026-09-01T10:00:02.000Z';
    const [second] = core.taskCore.effects.claim({
      workerId: 'worker-2',
      leaseMs: 1_000,
      limit: 1,
    });
    assert.equal(second.leaseEpoch, 2);
    assert.equal(second.attempt, 2);
    assert.throws(() => core.taskCore.effects.acknowledge({
      effectId: created.effect.effectId,
      workerId: 'worker-1',
      leaseEpoch: first.leaseEpoch,
      receipt: { projectionId: 'native-task-stale' },
    }), (error) => error?.code === 'EFFECT_LEASE_LOST');

    const acknowledged = core.taskCore.effects.acknowledge({
      effectId: created.effect.effectId,
      workerId: 'worker-2',
      leaseEpoch: second.leaseEpoch,
      receipt: { projectionId: 'native-task-001' },
    });
    assert.equal(acknowledged.status, 'acknowledged');
    core.close();

    core = openAuthorizedCore({ dbPath, clock: () => now });
    assert.deepEqual(core.taskCore.effects.claim({
      workerId: 'worker-3',
      leaseMs: 1_000,
      limit: 1,
    }), []);
  } finally {
    core.close();
    removeTaskApplicationTestDirectory(directory);
  }
});

test('TaskEffect relay claim fails closed when persisted effect content is tampered', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'zylos-task-effect-corrupt-'));
  const dbPath = path.join(directory, 'commitments.db');
  let core = openAuthorizedCore({
    dbPath,
    idGenerator: () => 'task-effect-corrupt',
    eventIdGenerator: () => 'event-effect-corrupt-created',
  });
  try {
    const created = core.taskCore.acceptIntent(
      'req-effect-corrupt', 'turn:req-effect-corrupt:1', 'source:effect-corrupt',
      verifiedContext(),
      { command: 'CreateTask', title: 'Reject corrupt effect claims' },
    );
    core.close();

    const database = new Database(dbPath);
    database.exec('DROP TRIGGER commitment_task_effect_no_update');
    database.prepare(`
      UPDATE commitment_task_effects
      SET actor_json = '{}'
      WHERE effect_id = ?
    `).run(created.effect.effectId);
    database.close();

    core = openAuthorizedCore({ dbPath });
    assert.throws(() => core.taskCore.effects.claim({
      workerId: 'worker-corrupt', leaseMs: 1_000, limit: 1,
    }), (error) => error?.code === 'PERSISTED_DATA_CORRUPT');
  } finally {
    core.close();
    removeTaskApplicationTestDirectory(directory);
  }
});

test('TaskEffect relay reconciles unknown delivery and explicitly redrives dead letters', () => {
  const harness = createHarness();
  try {
    const created = harness.core.taskCore.acceptIntent(
      'req-relay-recovery', 'turn:req-relay-recovery:1', 'source:relay-recovery',
      verifiedContext(),
      { command: 'CreateTask', title: 'Recover uncertain projection' },
    );
    const [first] = harness.core.taskCore.effects.claim({
      workerId: 'worker-unknown', leaseMs: 1_000, limit: 1,
    });
    const unknown = harness.core.taskCore.effects.fail({
      effectId: created.effect.effectId,
      workerId: 'worker-unknown',
      leaseEpoch: first.leaseEpoch,
      classification: 'unknown',
      error: 'remote response was lost',
    });
    assert.equal(unknown.status, 'unknown');
    assert.deepEqual(harness.core.taskCore.effects.claim({
      workerId: 'worker-blocked', leaseMs: 1_000, limit: 1,
    }), []);

    const reconciled = harness.core.taskCore.effects.reconcile({
      effectId: created.effect.effectId,
      actorId: 'projection-reconciler',
      outcome: 'not_delivered',
      receipt: { probeId: 'probe-001' },
    });
    assert.equal(reconciled.status, 'pending');
    const [second] = harness.core.taskCore.effects.claim({
      workerId: 'worker-permanent', leaseMs: 1_000, limit: 1,
    });
    assert.equal(second.attempt, 2);
    const dead = harness.core.taskCore.effects.fail({
      effectId: created.effect.effectId,
      workerId: 'worker-permanent',
      leaseEpoch: second.leaseEpoch,
      classification: 'permanent',
      error: 'projection target rejected the effect',
    });
    assert.equal(dead.status, 'dead_letter');

    const redriveRequest = {
      effectId: created.effect.effectId,
      actorId: 'projection-operator',
      idempotencyKey: 'redrive:effect:001',
    };
    const redriven = harness.core.taskCore.effects.redrive(redriveRequest);
    const replay = harness.core.taskCore.effects.redrive(redriveRequest);
    assert.equal(redriven.status, 'pending');
    assert.equal(redriven.generation, 1);
    assert.equal(replay.replayed, true);
    assert.throws(() => harness.core.taskCore.effects.redrive({
      ...redriveRequest,
      actorId: 'different-operator',
    }), (error) => error?.code === 'IDEMPOTENCY_CONFLICT');
  } finally {
    harness.cleanup();
  }
});

test('update intent uses the existing legal reminder command and CompleteTask is rejected', () => {
  const harness = createHarness();
  try {
    harness.core.ingest({
      idempotencyKey: 'seed:update',
      source: { channel: 'test', externalId: 'seed:update', senderId: 'owner-01' },
      task: {
        title: 'Update through Task Core',
        ownerId: 'owner-01',
        dueAt: '2026-09-02T10:00:00.000Z',
      },
    });
    const updated = harness.core.taskCore.acceptIntent(
      'req-update',
      'turn:req-update:1',
      'source:update',
      verifiedContext({ capabilities: ['task.update'] }),
      {
        taskId: 'task-001',
        command: 'UpdateTaskReminder',
        expectedVersion: 1,
        reminderMinutesBeforeDue: 30,
      },
    );
    assert.equal(updated.accepted, true);
    assert.equal(updated.task.reminderMinutesBeforeDue, 30);
    assert.equal(updated.event.type, 'TaskReminderUpdated');
    assert.equal(updated.taskCommand.command, 'UpdateTaskReminder');
    assert.equal(updated.taskCommand.capability, 'task.update');

    assert.throws(() => harness.core.taskCore.acceptIntent(
      'req-complete',
      'turn:req-complete:1',
      'source:complete',
      verifiedContext({ capabilities: ['task.submit_for_review'] }),
      { taskId: 'task-001', command: 'CompleteTask', expectedVersion: 2 },
    ), (error) => error?.code === 'INVALID_COMMAND');
  } finally {
    harness.cleanup();
  }
});

test('two Core connections cannot both apply the same expectedVersion', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'zylos-task-concurrency-'));
  const dbPath = path.join(directory, 'commitments.db');
  let eventA = 0;
  let eventB = 0;
  const coreA = openAuthorizedCore({
    dbPath,
    clock: () => '2026-09-01T10:00:00.000Z',
    idGenerator: () => 'task-concurrent',
    eventIdGenerator: () => `event-a-${++eventA}`,
  });
  let coreB;
  try {
    coreA.ingest({
      idempotencyKey: 'seed:concurrent',
      source: { channel: 'test', externalId: 'seed:concurrent', senderId: 'owner-01' },
      task: { title: 'Concurrent task', ownerId: 'owner-01' },
    });
    coreB = openAuthorizedCore({
      dbPath,
      clock: () => '2026-09-01T10:00:00.000Z',
      eventIdGenerator: () => `event-b-${++eventB}`,
    });
    const actor = verifiedContext({ capabilities: ['task.start'] });
    const winner = coreA.taskCore.executeCommand(
      'req-winner', 'turn:req-winner:1', 'source:winner', actor,
      'task-concurrent', 'StartTask', 1, 'task.start',
    );
    const loser = coreB.taskCore.executeCommand(
      'req-loser', 'turn:req-loser:1', 'source:loser', actor,
      'task-concurrent', 'StartTask', 1, 'task.start',
    );
    assert.equal(winner.accepted, true);
    assert.equal(loser.accepted, false);
    assert.equal(loser.code, 'VERSION_CONFLICT');
    const facts = coreB.query({ taskId: 'task-concurrent', includeEvents: true });
    assert.equal(facts.task.version, 2);
    assert.deepEqual(facts.events.map((event) => event.type), ['TaskCreated', 'TaskStarted']);
  } finally {
    coreB?.close();
    coreA.close();
    removeTaskApplicationTestDirectory(directory);
  }
});

test('Task state, event, Core receipt, and TaskEffect roll back together', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'zylos-task-rollback-'));
  const dbPath = path.join(directory, 'commitments.db');
  let eventIndex = 0;
  let core = openAuthorizedCore({
    dbPath,
    clock: () => '2026-09-01T10:00:00.000Z',
    idGenerator: () => 'task-rollback',
    eventIdGenerator: () => `event-rollback-${++eventIndex}`,
    taskEffectIdGenerator: () => 'task-effect:forced-collision',
  });
  try {
    core.ingest({
      idempotencyKey: 'seed:rollback',
      source: { channel: 'test', externalId: 'seed:rollback', senderId: 'owner-01' },
      task: { title: 'Rollback task', ownerId: 'owner-01' },
    });
    const actor = verifiedContext({
      capabilities: ['task.start', 'task.submit_for_review'],
    });
    core.taskCore.executeCommand(
      'req-rb-start', 'turn:req-rb-start:1', 'source:rb-start', actor,
      'task-rollback', 'StartTask', 1, 'task.start',
    );
    assert.throws(() => core.taskCore.executeCommand(
      'req-rb-submit', 'turn:req-rb-submit:1', 'source:rb-submit', actor,
      'task-rollback', 'SubmitForReview', 2, 'task.submit_for_review',
    ), /UNIQUE constraint failed/);

    let facts = core.query({ taskId: 'task-rollback', includeEvents: true });
    assert.equal(facts.task.state, 'in_progress');
    assert.equal(facts.task.version, 2);
    assert.deepEqual(facts.events.map((event) => event.type), ['TaskCreated', 'TaskStarted']);

    core.close();
    core = openAuthorizedCore({
      dbPath,
      clock: () => '2026-09-01T10:00:00.000Z',
      eventIdGenerator: () => `event-retry-${++eventIndex}`,
    });
    const retried = core.taskCore.executeCommand(
      'req-rb-submit', 'turn:req-rb-submit:1', 'source:rb-submit', actor,
      'task-rollback', 'SubmitForReview', 2, 'task.submit_for_review',
    );
    assert.equal(retried.accepted, true);
    facts = core.query({ taskId: 'task-rollback', includeEvents: true });
    assert.equal(facts.task.state, 'review');
    assert.equal(facts.events.at(-1).type, 'TaskSubmittedForReview');
  } finally {
    core.close();
    removeTaskApplicationTestDirectory(directory);
  }
});

test('old databases migrate additively and restart replay returns the original effect', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'zylos-task-migration-'));
  const dbPath = path.join(directory, 'commitments.db');
  let core = openAuthorizedCore({
    dbPath,
    clock: () => '2026-09-01T10:00:00.000Z',
    idGenerator: () => 'task-migrated',
    eventIdGenerator: () => 'event-migrated-created',
  });
  try {
    core.ingest({
      idempotencyKey: 'seed:migration',
      source: { channel: 'test', externalId: 'seed:migration', senderId: 'owner-01' },
      task: { title: 'Pre-application task', ownerId: 'owner-01' },
    });
    core.close();

    const legacyDb = new Database(dbPath);
    legacyDb.exec(`
      DROP TABLE commitment_task_effects;
      DROP TABLE commitment_task_application_receipts;
    `);
    legacyDb.close();

    core = openAuthorizedCore({
      dbPath,
      clock: () => '2026-09-01T10:00:00.000Z',
      eventIdGenerator: () => 'event-migrated-started',
    });
    assert.equal(core.query({ taskId: 'task-migrated' }).state, 'ready');
    const args = [
      'req-migrated', 'turn:req-migrated:1', 'source:migrated',
      verifiedContext({ capabilities: ['task.start'] }),
      'task-migrated', 'StartTask', 1, 'task.start',
    ];
    const applied = core.taskCore.executeCommand(...args);
    core.close();

    core = openAuthorizedCore({ dbPath });
    const replay = core.taskCore.executeCommand(...args);
    assert.equal(replay.replayed, true);
    assert.equal(replay.effect.effectId, applied.effect.effectId);
    assert.equal(core.query({ taskId: 'task-migrated' }).version, 2);
  } finally {
    core.close();
    removeTaskApplicationTestDirectory(directory);
  }
});

test('pre-hardening Task application data migrates hashes and relay without inventing scope', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'zylos-task-hardening-migration-'));
  const dbPath = path.join(directory, 'commitments.db');
  const args = [
    'req-hardening-migration',
    'turn:req-hardening-migration:1',
    'source:hardening-migration',
    verifiedContext(),
    { command: 'CreateTask', title: 'Migrate hardening schema' },
  ];
  let core = openAuthorizedCore({
    dbPath,
    idGenerator: () => 'task-hardening-migration',
    eventIdGenerator: () => 'event-hardening-migration-created',
  });
  try {
    const created = core.taskCore.acceptIntent(...args);
    core.close();

    const legacy = new Database(dbPath);
    legacy.pragma('foreign_keys = OFF');
    legacy.exec(`
      DROP TABLE commitment_task_effect_deliveries;
      DROP TABLE commitment_task_effect_delivery_receipts;
      DROP TABLE commitment_task_effect_redrive_receipts;
      DROP TABLE commitment_task_authorization_scopes;
      DROP TRIGGER commitment_task_application_receipt_no_update;
      DROP TRIGGER commitment_task_application_receipt_no_delete;
      DROP TRIGGER commitment_task_effect_no_update;
      DROP TRIGGER commitment_task_effect_no_delete;
      ALTER TABLE commitment_task_application_receipts DROP COLUMN receipt_hash;
      ALTER TABLE commitment_task_effects DROP COLUMN effect_hash;
    `);
    legacy.close();

    core = openAuthorizedCore({ dbPath, taskLegacyScopeResolver: null });
    const replay = core.taskCore.acceptIntent(...args);
    assert.equal(replay.replayed, true);
    assert.equal(replay.effect.effectId, created.effect.effectId);
    const denied = core.taskCore.executeCommand(
      'req-hardening-scope', 'turn:req-hardening-scope:1', 'source:hardening-scope',
      verifiedContext({ capabilities: ['task.start'] }),
      created.task.id, 'StartTask', created.task.version, 'task.start',
    );
    assert.equal(denied.code, 'AUTHORIZATION_SCOPE_UNKNOWN');
    const [delivery] = core.taskCore.effects.claim({
      workerId: 'worker-hardening-migration', leaseMs: 1_000, limit: 1,
    });
    assert.equal(delivery.effect.effectId, created.effect.effectId);
    core.close();

    const verified = new Database(dbPath);
    verified.pragma('foreign_keys = ON');
    assert.deepEqual(verified.pragma('foreign_key_check'), []);
    verified.close();
  } finally {
    core.close();
    removeTaskApplicationTestDirectory(directory);
  }
});
