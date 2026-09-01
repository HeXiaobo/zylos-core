import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import Database from 'better-sqlite3';

import { openEventSubscriptions } from '../event-subscription.js';
import { openReplyOutcomeTransactions } from '../reply-outcome.js';
import { openRunLedger } from '../run-ledger.js';
import { openRuntimePendingQueue } from '../runtime-pending-queue.js';

function temporaryDatabase(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-event-subscription-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return path.join(directory, 'c4.db');
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => (
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`
    )).join(',')}}`;
  }
  return JSON.stringify(value);
}

function acceptMessage(id) {
  return {
    schemaVersion: 1,
    type: 'AcceptMessage',
    commandId: `command:${id}`,
    idempotencyKey: `idempotency:${id}`,
    traceId: `trace:${id}`,
    causationId: `cause:${id}`,
    issuedAt: '2026-09-01T00:00:00.000Z',
    source: {
      adapterId: 'feishu',
      accountRef: 'account-1',
      targetRef: `opaque:${id}`,
      conversationKey: `lane:${id}`,
      messageId: `message:${id}`,
      eventId: `event:${id}`,
      eventType: 'message',
      payloadHash: `sha256:${'c'.repeat(64)}`,
    },
    actor: { provider: 'feishu', tenantRef: 'tenant-1', externalId: 'user-1' },
    content: { kind: 'text', text: `content ${id}` },
    contextHints: {
      threadRef: null,
      rootRef: null,
      parentRef: null,
      quoteRefs: [],
      mentionRefs: [],
      attachmentRefs: [],
    },
    reply: { mode: 'required', targetRef: `opaque:${id}` },
    policy: { priority: 2, requireIdle: false },
  };
}

function createProgressEvents(t, dbPath) {
  const ledger = openRunLedger({ dbPath, clock: () => 100 });
  const queue = openRuntimePendingQueue({ dbPath, clock: () => 100 });
  t.after(() => ledger.close());
  t.after(() => queue.close());
  const accepted = ledger.accept(acceptMessage('progress')).request;
  const claim = queue.claimNext();
  const run = queue.confirmStarted({
    admissionId: claim.admission.id,
    requestId: accepted.requestId,
    turnId: accepted.turnId,
    generation: accepted.generation,
    runtimeSessionId: 'runtime:progress',
  }).request;
  ledger.appendEvent({
    type: 'ProgressUpdated',
    requestId: run.requestId,
    turnId: run.turnId,
    generation: run.generation,
    traceId: run.traceId,
    causationId: ledger.listEvents(run.requestId).at(-1).eventId,
    producer: 'runtime:shared',
    idempotencyKey: `run:${run.requestId}:progress:1`,
    payload: { stage: 'working' },
  });
  return { ledger, run };
}

test('consumer ACK is independent, ordered and ignores legacy global delivery_status', (t) => {
  const dbPath = temporaryDatabase(t);
  const { ledger, run } = createProgressEvents(t, dbPath);
  const legacy = new Database(dbPath);
  legacy.prepare(`UPDATE assistant_response_events SET delivery_status = 'delivered'`).run();
  legacy.close();
  let token = 0;
  const subscriptions = openEventSubscriptions({
    dbPath,
    clock: () => 100,
    leaseTokenFactory: () => `event-lease-${++token}`,
  });
  t.after(() => subscriptions.close());
  subscriptions.subscribe({ consumerId: 'consumer-a', bootstrap: 'canonical_cutover' });
  subscriptions.subscribe({ consumerId: 'consumer-b', bootstrap: 'canonical_cutover' });

  const a1 = subscriptions.claimNext({ consumerId: 'consumer-a', ownerId: 'worker-a' });
  const ack = subscriptions.ack({
    consumerId: 'consumer-a',
    eventId: a1.event.eventId,
    claimEpoch: a1.claimEpoch,
    leaseToken: a1.leaseToken,
  });
  const duplicateAck = subscriptions.ack({
    consumerId: 'consumer-a',
    eventId: a1.event.eventId,
    claimEpoch: a1.claimEpoch,
    leaseToken: a1.leaseToken,
  });
  const b1 = subscriptions.claimNext({ consumerId: 'consumer-b', ownerId: 'worker-b' });
  const a2 = subscriptions.claimNext({ consumerId: 'consumer-a', ownerId: 'worker-a' });

  assert.equal(ack.replayed, false);
  assert.equal(duplicateAck.replayed, true);
  assert.equal(a1.event.eventId, b1.event.eventId);
  assert.equal(a1.event.type, 'RunAccepted');
  assert.equal(a2.event.type, 'RunQueued');
  assert.equal(subscriptions.getState({ consumerId: 'consumer-a', eventId: a1.event.eventId }).status, 'acknowledged');
  assert.equal(subscriptions.getState({ consumerId: 'consumer-b', eventId: b1.event.eventId }).status, 'processing');
  assert.equal(ledger.get(run.requestId).status, 'active');
});

test('event subscription public commands reject unknown v1 fields', (t) => {
  const dbPath = temporaryDatabase(t);
  const ledger = openRunLedger({ dbPath, clock: () => 100 });
  ledger.accept(acceptMessage('strict-subscription-input'));
  t.after(() => ledger.close());
  const subscriptions = openEventSubscriptions({ dbPath, clock: () => 101 });
  t.after(() => subscriptions.close());
  assert.throws(
    () => subscriptions.subscribe({
      consumerId: 'strict-consumer',
      bootstrap: 'canonical_cutover',
      attacker: true,
    }),
    error => error?.code === 'NONCANONICAL_V1_SHAPE',
  );
  subscriptions.subscribe({ consumerId: 'strict-consumer', bootstrap: 'canonical_cutover' });
  assert.throws(
    () => subscriptions.claimNext({
      consumerId: 'strict-consumer',
      ownerId: 'worker',
      attacker: true,
    }),
    error => error?.code === 'NONCANONICAL_V1_SHAPE',
  );
});

test('a leased or delayed stream does not block another request for the same consumer', (t) => {
  const dbPath = temporaryDatabase(t);
  const ledger = openRunLedger({ dbPath, clock: () => 100 });
  t.after(() => ledger.close());
  const requestA = ledger.accept(acceptMessage('stream-a')).request;
  const requestB = ledger.accept(acceptMessage('stream-b')).request;
  let token = 0;
  const subscriptions = openEventSubscriptions({
    dbPath,
    clock: () => 100,
    maxInFlightPerConsumer: 2,
    leaseTokenFactory: () => `stream-lease-${++token}`,
  });
  t.after(() => subscriptions.close());
  subscriptions.subscribe({ consumerId: 'parallel-consumer', bootstrap: 'canonical_cutover' });

  const first = subscriptions.claimNext({
    consumerId: 'parallel-consumer',
    ownerId: 'worker-a',
    leaseSeconds: 120,
  });
  const second = subscriptions.claimNext({
    consumerId: 'parallel-consumer',
    ownerId: 'worker-b',
    leaseSeconds: 120,
  });
  assert.equal(first.event.requestId, requestA.requestId);
  assert.equal(second.event.requestId, requestB.requestId);
  assert.equal(subscriptions.claimNext({
    consumerId: 'parallel-consumer',
    ownerId: 'worker-c',
  }), null);

  subscriptions.fail({
    consumerId: 'parallel-consumer',
    eventId: first.event.eventId,
    claimEpoch: first.claimEpoch,
    leaseToken: first.leaseToken,
    error: 'poison stream delay',
    retryDelaySeconds: 60,
  });
  subscriptions.ack({
    consumerId: 'parallel-consumer',
    eventId: second.event.eventId,
    claimEpoch: second.claimEpoch,
    leaseToken: second.leaseToken,
  });
  const nextB = subscriptions.claimNext({
    consumerId: 'parallel-consumer',
    ownerId: 'worker-b',
  });
  assert.equal(nextB.event.requestId, requestB.requestId);
  assert.equal(nextB.event.sequence, 2);

  subscriptions.subscribe({ consumerId: 'fair-consumer', bootstrap: 'canonical_cutover' });
  const poisonA = subscriptions.claimNext({
    consumerId: 'fair-consumer',
    ownerId: 'poison-worker',
  });
  subscriptions.fail({
    consumerId: 'fair-consumer',
    eventId: poisonA.event.eventId,
    claimEpoch: poisonA.claimEpoch,
    leaseToken: poisonA.leaseToken,
    error: 'immediate poison retry',
    retryDelaySeconds: 0,
  });
  const fairNext = subscriptions.claimNext({
    consumerId: 'fair-consumer',
    ownerId: 'healthy-worker',
  });
  assert.equal(fairNext.event.requestId, requestB.requestId);
});

test('one degraded request stream does not block healthy requests for the same consumer', (t) => {
  const dbPath = temporaryDatabase(t);
  const ledger = openRunLedger({ dbPath, clock: () => 100 });
  t.after(() => ledger.close());
  const poison = ledger.accept(acceptMessage('poison-stream')).request;
  const healthy = ledger.accept(acceptMessage('healthy-stream')).request;
  const buggyWriter = new Database(dbPath);
  buggyWriter.exec('DROP TRIGGER assistant_response_events_canonical_immutable');
  buggyWriter.prepare(`
    UPDATE assistant_response_events SET causation_id = 'attacker-cause'
    WHERE request_id = ? AND sequence = 1
  `).run(poison.requestId);
  buggyWriter.close();
  const subscriptions = openEventSubscriptions({ dbPath, clock: () => 101 });
  t.after(() => subscriptions.close());
  subscriptions.subscribe({ consumerId: 'isolated-consumer', bootstrap: 'canonical_cutover' });
  const poisonState = subscriptions.getStream({
    consumerId: 'isolated-consumer',
    requestId: poison.requestId,
  });
  assert.equal(poisonState.consumerId, 'isolated-consumer');
  assert.equal(poisonState.requestId, poison.requestId);
  assert.equal(poisonState.status, 'degraded');
  assert.equal(poisonState.degradedReason, 'RUN_ACCEPTED_LEDGER_MISMATCH');
  assert.equal(typeof poisonState.degradedEventRowId, 'number');
  const claim = subscriptions.claimNext({
    consumerId: 'isolated-consumer',
    ownerId: 'healthy-worker',
  });
  assert.equal(claim.event.requestId, healthy.requestId);
  assert.equal(claim.event.type, 'RunAccepted');
});

test('wrong and expired event leases cannot ACK, while restart recovery has one concurrent owner', async (t) => {
  const dbPath = temporaryDatabase(t);
  let now = 100;
  createProgressEvents(t, dbPath);
  const crashed = openEventSubscriptions({
    dbPath,
    clock: () => now,
    leaseTokenFactory: () => 'crashed-event-lease',
  });
  crashed.subscribe({ consumerId: 'restart-consumer', bootstrap: 'canonical_cutover' });
  const first = crashed.claimNext({
    consumerId: 'restart-consumer',
    ownerId: 'crashed-worker',
    leaseSeconds: 5,
  });
  assert.throws(
    () => crashed.ack({
      consumerId: 'restart-consumer',
      eventId: first.event.eventId,
      claimEpoch: first.claimEpoch,
      leaseToken: 'wrong-event-lease',
    }),
    error => error?.code === 'LEASE_FENCED',
  );
  now = 105;
  assert.throws(
    () => crashed.ack({
      consumerId: 'restart-consumer',
      eventId: first.event.eventId,
      claimEpoch: first.claimEpoch,
      leaseToken: first.leaseToken,
    }),
    error => error?.code === 'LEASE_EXPIRED',
  );
  crashed.close();

  const ownerA = openEventSubscriptions({
    dbPath,
    clock: () => now,
    leaseTokenFactory: () => 'recovered-event-lease-a',
  });
  const ownerB = openEventSubscriptions({
    dbPath,
    clock: () => now,
    leaseTokenFactory: () => 'recovered-event-lease-b',
  });
  t.after(() => ownerA.close());
  t.after(() => ownerB.close());
  const [claimA, claimB] = await Promise.all([
    Promise.resolve().then(() => ownerA.claimNext({
      consumerId: 'restart-consumer',
      ownerId: 'worker-a',
    })),
    Promise.resolve().then(() => ownerB.claimNext({
      consumerId: 'restart-consumer',
      ownerId: 'worker-b',
    })),
  ]);
  const [winner] = [claimA, claimB].filter(Boolean);
  assert.equal([claimA, claimB].filter(Boolean).length, 1);
  assert.equal(winner.event.eventId, first.event.eventId);
  assert.notEqual(winner.leaseToken, first.leaseToken);
  assert.throws(
    () => ownerA.ack({
      consumerId: 'restart-consumer',
      eventId: first.event.eventId,
      claimEpoch: first.claimEpoch,
      leaseToken: first.leaseToken,
    }),
    error => error?.code === 'LEASE_FENCED',
  );
});

test('claim epoch fences a reused lease token after expiration', (t) => {
  const dbPath = temporaryDatabase(t);
  let now = 100;
  createProgressEvents(t, dbPath);
  const subscriptions = openEventSubscriptions({
    dbPath,
    clock: () => now,
    leaseTokenFactory: () => 'same-token',
  });
  t.after(() => subscriptions.close());
  subscriptions.subscribe({ consumerId: 'epoch-consumer', bootstrap: 'canonical_cutover' });
  const oldLease = subscriptions.claimNext({
    consumerId: 'epoch-consumer',
    ownerId: 'old-owner',
    leaseSeconds: 1,
  });
  now = 101;
  const newLease = subscriptions.claimNext({
    consumerId: 'epoch-consumer',
    ownerId: 'new-owner',
    leaseSeconds: 30,
  });
  assert.equal(oldLease.leaseToken, newLease.leaseToken);
  assert.notEqual(oldLease.claimEpoch, newLease.claimEpoch);
  assert.throws(
    () => subscriptions.ack({
      consumerId: 'epoch-consumer',
      eventId: oldLease.event.eventId,
      leaseToken: oldLease.leaseToken,
      claimEpoch: oldLease.claimEpoch,
    }),
    error => error?.code === 'LEASE_FENCED',
  );
  assert.equal(subscriptions.ack({
    consumerId: 'epoch-consumer',
    eventId: newLease.event.eventId,
    leaseToken: newLease.leaseToken,
    claimEpoch: newLease.claimEpoch,
  }).state.status, 'acknowledged');
});

test('progress failure, lag and duplicate event replay cannot block the final ReplyIntent or change Run terminal', (t) => {
  const dbPath = temporaryDatabase(t);
  const { ledger, run } = createProgressEvents(t, dbPath);
  const subscriptions = openEventSubscriptions({
    dbPath,
    clock: () => 100,
    leaseTokenFactory: (() => {
      let token = 0;
      return () => `progress-event-lease-${++token}`;
    })(),
  });
  const outcomes = openReplyOutcomeTransactions({ dbPath, clock: () => 101 });
  t.after(() => subscriptions.close());
  t.after(() => outcomes.close());
  subscriptions.subscribe({ consumerId: 'projection', bootstrap: 'canonical_cutover' });
  for (let index = 0; index < 3; index += 1) {
    const claimed = subscriptions.claimNext({ consumerId: 'projection', ownerId: 'worker' });
    subscriptions.ack({
      consumerId: 'projection',
      eventId: claimed.event.eventId,
      claimEpoch: claimed.claimEpoch,
      leaseToken: claimed.leaseToken,
    });
  }
  const progress = subscriptions.claimNext({ consumerId: 'projection', ownerId: 'worker' });
  assert.equal(progress.event.type, 'ProgressUpdated');
  const failed = subscriptions.fail({
    consumerId: 'projection',
    eventId: progress.event.eventId,
    claimEpoch: progress.claimEpoch,
    leaseToken: progress.leaseToken,
    error: 'projection unavailable',
    retryDelaySeconds: 60,
  });
  assert.equal(failed.status, 'pending');
  assert.equal(failed.retryCount, 1);

  const duplicate = ledger.appendEvent({
    type: 'ProgressUpdated',
    requestId: run.requestId,
    turnId: run.turnId,
    generation: run.generation,
    traceId: run.traceId,
    causationId: ledger.listEvents(run.requestId).at(-2).eventId,
    producer: 'runtime:shared',
    idempotencyKey: `run:${run.requestId}:progress:1`,
    payload: { stage: 'working' },
  });
  assert.equal(duplicate.replayed, true);
  const committed = outcomes.commitRunOutcome({
    requestId: run.requestId,
    turnId: run.turnId,
    generation: run.generation,
    traceId: run.traceId,
    causationId: ledger.listEvents(run.requestId).at(-1).eventId,
    producer: 'runtime:shared',
    idempotencyKey: `run:${run.requestId}:completed`,
    outcome: { kind: 'answer', content: { format: 'text', text: 'Final answer.' } },
    reply: {
      action: 'send',
      route: { adapterId: 'feishu', targetRef: 'opaque:progress' },
      disposition: 'send',
    },
  });

  assert.equal(committed.delivery.state, 'pending');
  assert.equal(ledger.get(run.requestId).status, 'completed');
  assert.equal(subscriptions.claimNext({ consumerId: 'projection', ownerId: 'worker' }), null);
});

test('same-request canonical sequence gaps degrade the subscription and fail claims closed', (t) => {
  const dbPath = temporaryDatabase(t);
  const ledger = openRunLedger({ dbPath, clock: () => 100 });
  t.after(() => ledger.close());
  const run = ledger.accept(acceptMessage('gap')).request;
  const inject = new Database(dbPath);
  inject.prepare(`
    INSERT INTO assistant_response_events (
      request_id, sequence, event_type, payload_json, idempotency_key,
      delivery_status, available_at, created_at, event_id, turn_id,
      generation, trace_id, causation_id, producer
    ) VALUES (?, 4, 'ProgressUpdated', '{"stage":"gap"}', ?,
              'pending', 100, 100, ?, ?, 1, ?, ?, 'runtime:shared')
  `).run(
    run.requestId,
    `run:${run.requestId}:progress:1`,
    `evt:${run.requestId}:4`,
    run.turnId,
    run.traceId,
    `evt:${run.requestId}:2`,
  );
  inject.close();
  const subscriptions = openEventSubscriptions({ dbPath, clock: () => 101 });
  t.after(() => subscriptions.close());

  const subscribed = subscriptions.subscribe({
    consumerId: 'gap-consumer',
    bootstrap: 'canonical_cutover',
  });
  assert.equal(subscribed.status, 'degraded');
  assert.equal(subscribed.degradedReason, 'CANONICAL_SEQUENCE_GAP');
  assert.throws(
    () => subscriptions.claimNext({ consumerId: 'gap-consumer', ownerId: 'worker' }),
    error => error?.code === 'EVENT_SUBSCRIPTION_DEGRADED'
      && error.degradedReason === 'CANONICAL_SEQUENCE_GAP',
  );
});

test('unknown event types cannot masquerade as canonical subscription events', (t) => {
  const dbPath = temporaryDatabase(t);
  const ledger = openRunLedger({ dbPath, clock: () => 100 });
  t.after(() => ledger.close());
  const run = ledger.accept(acceptMessage('unknown-event-type')).request;
  const inject = new Database(dbPath);
  inject.prepare(`
    INSERT INTO assistant_response_events (
      request_id, sequence, event_type, payload_json, idempotency_key,
      delivery_status, available_at, created_at, event_id, turn_id,
      generation, trace_id, causation_id, producer
    ) VALUES (?, 3, 'UnknownRunFact', '{}', ?, 'pending', 100, 100, ?, ?, 1, ?, ?, ?)
  `).run(
    run.requestId,
    `run:${run.requestId}:unknown`,
    `evt:${run.requestId}:3`,
    run.turnId,
    run.traceId,
    `evt:${run.requestId}:2`,
    'runtime:shared',
  );
  inject.close();
  const subscriptions = openEventSubscriptions({ dbPath, clock: () => 101 });
  t.after(() => subscriptions.close());

  const subscribed = subscriptions.subscribe({
    consumerId: 'unknown-type-consumer',
    bootstrap: 'canonical_cutover',
  });
  assert.equal(subscribed.status, 'degraded');
  assert.equal(subscribed.degradedReason, 'NONCANONICAL_EVENT_TYPE');
  assert.throws(
    () => subscriptions.claimNext({ consumerId: 'unknown-type-consumer', ownerId: 'worker' }),
    error => error?.code === 'EVENT_SUBSCRIPTION_DEGRADED',
  );
});

test('canonical-looking events must extend their request causation chain', (t) => {
  const dbPath = temporaryDatabase(t);
  const ledger = openRunLedger({ dbPath, clock: () => 100 });
  const queue = openRuntimePendingQueue({ dbPath, clock: () => 100 });
  t.after(() => ledger.close());
  t.after(() => queue.close());
  const accepted = ledger.accept(acceptMessage('bad-causation')).request;
  const claim = queue.claimNext();
  const run = queue.confirmStarted({
    admissionId: claim.admission.id,
    requestId: accepted.requestId,
    turnId: accepted.turnId,
    generation: accepted.generation,
    runtimeSessionId: 'runtime:bad-causation',
  }).request;
  const inject = new Database(dbPath);
  inject.prepare(`
    INSERT INTO assistant_response_events (
      request_id, sequence, event_type, payload_json, idempotency_key,
      delivery_status, available_at, created_at, event_id, turn_id,
      generation, trace_id, causation_id, producer
    ) VALUES (?, 4, 'ProgressUpdated', '{"stage":"bad-cause"}', ?,
              'pending', 100, 100, ?, ?, 1, ?, 'BOGUS_CAUSE', 'runtime:shared')
  `).run(
    run.requestId,
    `run:${run.requestId}:progress:1`,
    `evt:${run.requestId}:4`,
    run.turnId,
    run.traceId,
  );
  inject.close();
  const subscriptions = openEventSubscriptions({ dbPath, clock: () => 101 });
  t.after(() => subscriptions.close());
  const subscribed = subscriptions.subscribe({
    consumerId: 'bad-causation-consumer',
    bootstrap: 'canonical_cutover',
  });
  assert.equal(subscribed.status, 'degraded');
  assert.equal(subscribed.degradedReason, 'NONCANONICAL_CAUSATION_CHAIN');
});

test('RunStarted requires a canonical runtime session identity', (t) => {
  const dbPath = temporaryDatabase(t);
  const ledger = openRunLedger({ dbPath, clock: () => 100 });
  t.after(() => ledger.close());
  const run = ledger.accept(acceptMessage('bad-runtime-session')).request;
  const inject = new Database(dbPath);
  inject.prepare(`
    INSERT INTO assistant_response_events (
      request_id, sequence, event_type, payload_json, idempotency_key,
      delivery_status, available_at, created_at, event_id, turn_id,
      generation, trace_id, causation_id, producer
    ) VALUES (?, 3, 'RunStarted', '{"runtimeLaneId":"runtime:shared"}', ?,
              'pending', 100, 100, ?, ?, 1, ?, ?, 'core:runtime-lane')
  `).run(
    run.requestId,
    `run:${run.requestId}:started:g1`,
    `evt:${run.requestId}:3`,
    run.turnId,
    run.traceId,
    `evt:${run.requestId}:2`,
  );
  inject.close();
  const subscriptions = openEventSubscriptions({ dbPath, clock: () => 101 });
  t.after(() => subscriptions.close());

  const subscribed = subscriptions.subscribe({
    consumerId: 'bad-runtime-session-consumer',
    bootstrap: 'canonical_cutover',
  });
  assert.equal(subscribed.status, 'degraded');
  assert.equal(subscribed.degradedReason, 'NONCANONICAL_RUNTIME_SESSION');
});

test('subscription validates RunAccepted intake and RunStarted admission persistence facts', (t) => {
  for (const scenario of ['accepted-cause', 'started-session']) {
    const dbPath = temporaryDatabase(t);
    const ledger = openRunLedger({ dbPath, clock: () => 100 });
    const queue = openRuntimePendingQueue({ dbPath, clock: () => 100 });
    const accepted = ledger.accept(acceptMessage(`persistent-${scenario}`)).request;
    const claim = queue.claimNext();
    queue.confirmStarted({
      admissionId: claim.admission.id,
      requestId: accepted.requestId,
      turnId: accepted.turnId,
      generation: accepted.generation,
      runtimeSessionId: `runtime:persistent-${scenario}`,
    });
    // Install the complete schema first, then simulate a pre-trigger buggy writer.
    const subscriptions = openEventSubscriptions({ dbPath, clock: () => 101 });
    const mutate = new Database(dbPath);
    if (scenario === 'accepted-cause') {
      mutate.exec('DROP TRIGGER assistant_response_events_canonical_immutable');
      mutate.prepare(`UPDATE assistant_response_events SET causation_id = 'attacker' WHERE request_id = ? AND sequence = 1`)
        .run(accepted.requestId);
    } else {
      mutate.prepare(`UPDATE runtime_turn_admissions SET runtime_session_id = 'runtime:attacker' WHERE request_id = ?`)
        .run(accepted.requestId);
    }
    mutate.close();
    const subscribed = subscriptions.subscribe({
      consumerId: `persistent-${scenario}-consumer`,
      bootstrap: 'canonical_cutover',
    });
    assert.equal(subscribed.status, 'degraded');
    assert.equal(subscribed.degradedReason, scenario === 'accepted-cause'
      ? 'RUN_ACCEPTED_LEDGER_MISMATCH'
      : 'RUN_STARTED_ADMISSION_MISMATCH');
    subscriptions.close();
    queue.close();
    ledger.close();
  }
});

test('canonical-looking terminals require a durable matching ReplyOutcome', (t) => {
  for (const [id, expectedReason] of [
    ['missing-outcome-id', 'TERMINAL_OUTCOME_ID_REQUIRED'],
    ['dangling-outcome-id', 'TERMINAL_OUTCOME_NOT_FOUND'],
  ]) {
    const dbPath = temporaryDatabase(t);
    const ledger = openRunLedger({ dbPath, clock: () => 100 });
    const queue = openRuntimePendingQueue({ dbPath, clock: () => 100 });
    t.after(() => ledger.close());
    t.after(() => queue.close());
    const accepted = ledger.accept(acceptMessage(id)).request;
    const claim = queue.claimNext();
    const run = queue.confirmStarted({
      admissionId: claim.admission.id,
      requestId: accepted.requestId,
      turnId: accepted.turnId,
      generation: accepted.generation,
      runtimeSessionId: `runtime:${id}`,
    }).request;
    const payload = id === 'missing-outcome-id'
      ? {}
      : { outcomeId: `outcome:${run.requestId}` };
    const inject = new Database(dbPath);
    inject.prepare(`
      INSERT INTO assistant_response_events (
        request_id, sequence, event_type, payload_json, idempotency_key,
        delivery_status, available_at, created_at, event_id, turn_id,
        generation, trace_id, causation_id, producer
      ) VALUES (?, 4, 'RunCompleted', ?, ?, 'pending', 100, 100, ?, ?, 1, ?, ?, 'runtime:shared')
    `).run(
      run.requestId,
      JSON.stringify(payload),
      `run:${run.requestId}:completed`,
      `evt:${run.requestId}:4`,
      run.turnId,
      run.traceId,
      `evt:${run.requestId}:3`,
    );
    inject.close();
    const subscriptions = openEventSubscriptions({ dbPath, clock: () => 101 });
    t.after(() => subscriptions.close());
    const subscribed = subscriptions.subscribe({
      consumerId: `terminal-consumer:${id}`,
      bootstrap: 'canonical_cutover',
    });
    assert.equal(subscribed.status, 'degraded');
    assert.equal(subscribed.degradedReason, expectedReason);
  }
});

test('RunCompleted cannot jump directly from RunQueued even with a matching Outcome', (t) => {
  const dbPath = temporaryDatabase(t);
  const ledger = openRunLedger({ dbPath, clock: () => 100 });
  const subscriptions = openEventSubscriptions({ dbPath, clock: () => 101 });
  t.after(() => ledger.close());
  t.after(() => subscriptions.close());
  const run = ledger.accept(acceptMessage('queued-terminal-jump')).request;
  const outcome = {
    schemaVersion: 1,
    type: 'ReplyOutcome',
    outcomeId: `outcome:${run.requestId}`,
    requestId: run.requestId,
    turnId: run.turnId,
    traceId: run.traceId,
    kind: 'answer',
    content: { format: 'text', text: 'Impossible completion.' },
  };
  const outcomeJson = canonicalJson(outcome);
  const inject = new Database(dbPath);
  inject.prepare(`
    INSERT INTO assistant_reply_outcomes (
      outcome_id, request_id, turn_id, generation, trace_id, kind,
      envelope_json, canonical_hash, created_at
    ) VALUES (?, ?, ?, ?, ?, 'answer', ?, ?, 100)
  `).run(
    outcome.outcomeId,
    run.requestId,
    run.turnId,
    run.generation,
    run.traceId,
    outcomeJson,
    createHash('sha256').update(outcomeJson).digest('hex'),
  );
  inject.prepare(`
    INSERT INTO assistant_response_events (
      request_id, sequence, event_type, payload_json, idempotency_key,
      delivery_status, available_at, created_at, event_id, turn_id,
      generation, trace_id, causation_id, producer
    ) VALUES (?, 3, 'RunCompleted', ?, ?, 'pending', 100, 100, ?, ?, ?, ?, ?, 'runtime:shared')
  `).run(
    run.requestId,
    canonicalJson({ outcomeId: outcome.outcomeId }),
    `run:${run.requestId}:completed`,
    `evt:${run.requestId}:3`,
    run.turnId,
    run.generation,
    run.traceId,
    `evt:${run.requestId}:2`,
  );
  inject.close();

  const subscribed = subscriptions.subscribe({
    consumerId: 'queued-terminal-jump-consumer',
    bootstrap: 'canonical_cutover',
  });
  assert.equal(subscribed.status, 'degraded');
  assert.equal(subscribed.degradedReason, 'NONCANONICAL_EVENT_TRANSITION');
});

test('RunCancelled requires a matching durable cancellation command cause', (t) => {
  const dbPath = temporaryDatabase(t);
  const ledger = openRunLedger({ dbPath, clock: () => 100 });
  const subscriptions = openEventSubscriptions({ dbPath, clock: () => 101 });
  t.after(() => ledger.close());
  t.after(() => subscriptions.close());
  const run = ledger.accept(acceptMessage('cancel-without-command')).request;
  const inject = new Database(dbPath);
  inject.prepare(`
    INSERT INTO assistant_response_events (
      request_id, sequence, event_type, payload_json, idempotency_key,
      delivery_status, available_at, created_at, event_id, turn_id,
      generation, trace_id, causation_id, producer
    ) VALUES (?, 3, 'RunCancelled', '{"mode":"queued"}', ?,
              'pending', 100, 100, ?, ?, ?, ?, 'BOGUS_CANCEL_CAUSE', 'core:runtime-lane')
  `).run(
    run.requestId,
    `run:${run.requestId}:cancelled:g${run.generation}`,
    `evt:${run.requestId}:3`,
    run.turnId,
    run.generation,
    run.traceId,
  );
  inject.close();

  const subscribed = subscriptions.subscribe({
    consumerId: 'cancel-without-command-consumer',
    bootstrap: 'canonical_cutover',
  });
  assert.equal(subscribed.status, 'degraded');
  assert.equal(subscribed.degradedReason, 'RUN_CANCEL_CAUSE_NOT_FOUND');
});

test('RunCancelled rejects noncanonical idempotency and payload', (t) => {
  for (const scenario of [
    {
      id: 'bad-cancel-key',
      idempotencyKey: 'arbitrary-cancel-key',
      payload: { mode: 'queued' },
      reason: 'NONCANONICAL_EVENT_IDEMPOTENCY',
    },
    {
      id: 'bad-cancel-payload',
      idempotencyKey: null,
      payload: { arbitrary: true },
      reason: 'NONCANONICAL_CANCELLED_PAYLOAD',
    },
  ]) {
    const dbPath = temporaryDatabase(t);
    const ledger = openRunLedger({ dbPath, clock: () => 100 });
    const subscriptions = openEventSubscriptions({ dbPath, clock: () => 101 });
    t.after(() => ledger.close());
    t.after(() => subscriptions.close());
    const run = ledger.accept(acceptMessage(scenario.id)).request;
    const inject = new Database(dbPath);
    inject.prepare(`
      INSERT INTO assistant_response_events (
        request_id, sequence, event_type, payload_json, idempotency_key,
        delivery_status, available_at, created_at, event_id, turn_id,
        generation, trace_id, causation_id, producer
      ) VALUES (?, 3, 'RunCancelled', ?, ?, 'pending', 100, 100, ?, ?, ?, ?, ?, 'core:runtime-lane')
    `).run(
      run.requestId,
      canonicalJson(scenario.payload),
      scenario.idempotencyKey ?? `run:${run.requestId}:cancelled:g${run.generation}`,
      `evt:${run.requestId}:3`,
      run.turnId,
      run.generation,
      run.traceId,
      `cancel:${scenario.id}`,
    );
    inject.close();

    const subscribed = subscriptions.subscribe({
      consumerId: `consumer:${scenario.id}`,
      bootstrap: 'canonical_cutover',
    });
    assert.equal(subscribed.status, 'degraded');
    assert.equal(subscribed.degradedReason, scenario.reason);
  }
});

test('active RunCancelled cause must match its durable runtime confirmation', (t) => {
  const dbPath = temporaryDatabase(t);
  const { ledger, run } = createProgressEvents(t, dbPath);
  ledger.cancel({
    schemaVersion: 1,
    type: 'CancelRequest',
    commandId: 'cancel:bad-active-cause',
    idempotencyKey: `cancel:${run.requestId}:g${run.generation}`,
    requestId: run.requestId,
    turnId: run.turnId,
    generation: run.generation,
    traceId: run.traceId,
    causationId: 'cancel-requested:bad-active-cause',
    mode: 'cooperative',
    reason: 'user_requested',
  });
  ledger.confirmCancellation({
    requestId: run.requestId,
    turnId: run.turnId,
    generation: run.generation,
    traceId: run.traceId,
    causationId: 'runtime-confirmed:bad-active-cause',
    producer: 'runtime:shared',
  });
  const mutate = new Database(dbPath);
  mutate.exec('DROP TRIGGER assistant_response_events_canonical_immutable');
  mutate.prepare(`
    UPDATE assistant_response_events SET causation_id = 'BOGUS_CONFIRMATION_CAUSE'
    WHERE request_id = ? AND event_type = 'RunCancelled'
  `).run(run.requestId);
  mutate.close();
  const subscriptions = openEventSubscriptions({ dbPath, clock: () => 101 });
  t.after(() => subscriptions.close());

  const subscribed = subscriptions.subscribe({
    consumerId: 'bad-active-cancel-cause-consumer',
    bootstrap: 'canonical_cutover',
  });
  assert.equal(subscribed.status, 'degraded');
  assert.equal(subscribed.degradedReason, 'RUN_CANCEL_CAUSE_NOT_FOUND');
});

test('a canonical event after a terminal degrades the stream', (t) => {
  const dbPath = temporaryDatabase(t);
  const ledger = openRunLedger({ dbPath, clock: () => 100 });
  t.after(() => ledger.close());
  const run = ledger.accept(acceptMessage('terminal-last')).request;
  const inject = new Database(dbPath);
  const insert = inject.prepare(`
    INSERT INTO assistant_response_events (
      request_id, sequence, event_type, payload_json, idempotency_key,
      delivery_status, available_at, created_at, event_id, turn_id,
      generation, trace_id, causation_id, producer
    ) VALUES (?, ?, ?, ?, ?, 'pending', 100, 100, ?, ?, 1, ?, ?, ?)
  `);
  insert.run(
    run.requestId,
    3,
    'RunCancelled',
    '{"mode":"queued"}',
    `run:${run.requestId}:cancelled:g1`,
    `evt:${run.requestId}:3`,
    run.turnId,
    run.traceId,
    'cancel:terminal-last',
    'core:runtime-lane',
  );
  insert.run(
    run.requestId,
    4,
    'ProgressUpdated',
    '{"stage":"too-late"}',
    `run:${run.requestId}:progress:late`,
    `evt:${run.requestId}:4`,
    run.turnId,
    run.traceId,
    `evt:${run.requestId}:3`,
    'runtime:shared',
  );
  inject.close();
  const subscriptions = openEventSubscriptions({ dbPath, clock: () => 101 });
  t.after(() => subscriptions.close());
  const subscribed = subscriptions.subscribe({
    consumerId: 'terminal-last-consumer',
    bootstrap: 'canonical_cutover',
  });
  assert.equal(subscribed.status, 'degraded');
  assert.equal(subscribed.degradedReason, 'EVENT_AFTER_TERMINAL');
});

test('cooperative runtime cancellation remains a canonical terminal stream', (t) => {
  const dbPath = temporaryDatabase(t);
  const { ledger, run } = createProgressEvents(t, dbPath);
  ledger.cancel({
    schemaVersion: 1,
    type: 'CancelRequest',
    commandId: 'cancel:runtime-terminal',
    idempotencyKey: `cancel:${run.requestId}:g${run.generation}`,
    requestId: run.requestId,
    turnId: run.turnId,
    generation: run.generation,
    traceId: run.traceId,
    causationId: 'cancel-requested:runtime-terminal',
    mode: 'cooperative',
    reason: 'user_requested',
  });
  ledger.confirmCancellation({
    requestId: run.requestId,
    turnId: run.turnId,
    generation: run.generation,
    traceId: run.traceId,
    causationId: 'runtime-stop-confirmed',
    producer: 'runtime:shared',
  });
  const subscriptions = openEventSubscriptions({ dbPath, clock: () => 101 });
  t.after(() => subscriptions.close());

  const subscribed = subscriptions.subscribe({
    consumerId: 'runtime-cancel-consumer',
    bootstrap: 'canonical_cutover',
  });
  assert.equal(subscribed.status, 'active');
});

test('canonical event identity and body are immutable while legacy delivery_status stays mutable', (t) => {
  const dbPath = temporaryDatabase(t);
  const ledger = openRunLedger({ dbPath, clock: () => 100 });
  t.after(() => ledger.close());
  ledger.accept(acceptMessage('immutable'));
  const subscriptions = openEventSubscriptions({ dbPath, clock: () => 101 });
  t.after(() => subscriptions.close());
  const mutate = new Database(dbPath);
  assert.throws(
    () => mutate.prepare(`
      UPDATE assistant_response_events SET payload_json = '{"changed":true}' WHERE sequence = 1
    `).run(),
    /canonical assistant event is immutable/,
  );
  assert.throws(
    () => mutate.prepare(`
      UPDATE assistant_response_events SET id = 99 WHERE sequence = 1
    `).run(),
    /canonical assistant event is immutable/,
  );
  assert.throws(
    () => mutate.prepare(`
      DELETE FROM assistant_response_events WHERE sequence = 1
    `).run(),
    /canonical assistant event is immutable/,
  );
  mutate.prepare(`
    UPDATE assistant_response_events SET delivery_status = 'delivered'
  `).run();
  mutate.close();

  subscriptions.subscribe({ consumerId: 'immutable-consumer', bootstrap: 'canonical_cutover' });
  assert.equal(subscriptions.getConsumer({ consumerId: 'immutable-consumer' }).status, 'active');
  assert.equal(subscriptions.claimNext({
    consumerId: 'immutable-consumer',
    ownerId: 'worker',
  }).event.type, 'RunAccepted');
});

test('post-cutover legacy rows cannot be promoted to canonical and remain observably degraded', (t) => {
  const dbPath = temporaryDatabase(t);
  const ledger = openRunLedger({ dbPath, clock: () => 100 });
  t.after(() => ledger.close());
  const run = ledger.accept(acceptMessage('mixed-writer-promotion')).request;
  const subscriptions = openEventSubscriptions({ dbPath, clock: () => 101 });
  t.after(() => subscriptions.close());
  subscriptions.subscribe({ consumerId: 'mixed-writer-consumer', bootstrap: 'canonical_cutover' });
  const mixedWriter = new Database(dbPath);
  mixedWriter.prepare(`
    INSERT INTO assistant_response_events (
      request_id, sequence, event_type, payload_json, idempotency_key,
      delivery_status, available_at, created_at
    ) VALUES (?, 3, 'ProgressUpdated', '{"stage":"legacy"}', ?, 'pending', 102, 102)
  `).run(run.requestId, `legacy:${run.requestId}:progress`);
  assert.throws(
    () => mixedWriter.prepare(`
      UPDATE assistant_response_events
      SET event_id = ?, turn_id = ?, generation = ?, trace_id = ?,
          causation_id = ?, producer = 'runtime:shared',
          idempotency_key = ?
      WHERE request_id = ? AND sequence = 3
    `).run(
      `evt:${run.requestId}:3`,
      run.turnId,
      run.generation,
      run.traceId,
      `evt:${run.requestId}:2`,
      `run:${run.requestId}:progress:1`,
      run.requestId,
    ),
    /legacy assistant event cannot be promoted to canonical/,
  );
  mixedWriter.close();
  assert.throws(
    () => subscriptions.claimNext({
      consumerId: 'mixed-writer-consumer',
      ownerId: 'worker',
    }),
    error => error?.code === 'EVENT_SUBSCRIPTION_DEGRADED'
      && error?.degradedReason === 'NONCANONICAL_EVENT_ID',
  );
});

test('canonical ReplyOutcome rows are immutable', (t) => {
  const dbPath = temporaryDatabase(t);
  const { ledger, run } = createProgressEvents(t, dbPath);
  const outcomes = openReplyOutcomeTransactions({ dbPath, clock: () => 101 });
  t.after(() => outcomes.close());
  outcomes.commitRunOutcome({
    requestId: run.requestId,
    turnId: run.turnId,
    generation: run.generation,
    traceId: run.traceId,
    causationId: ledger.listEvents(run.requestId).at(-1).eventId,
    producer: 'runtime:shared',
    idempotencyKey: `run:${run.requestId}:completed`,
    outcome: { kind: 'answer', content: { format: 'text', text: 'Immutable answer.' } },
    reply: {
      action: 'send',
      route: { adapterId: 'feishu', targetRef: 'opaque:progress' },
      disposition: 'send',
    },
  });
  const mutate = new Database(dbPath);
  assert.throws(
    () => mutate.prepare(`
      UPDATE assistant_reply_outcomes SET envelope_json = '{"tampered":true}'
      WHERE request_id = ?
    `).run(run.requestId),
    /canonical ReplyOutcome is immutable/,
  );
  assert.throws(
    () => mutate.prepare(`
      DELETE FROM assistant_reply_outcomes WHERE request_id = ?
    `).run(run.requestId),
    /canonical ReplyOutcome is immutable/,
  );
  mutate.close();
});

test('subscription degrades when a legacy database contains a tampered Outcome envelope/hash', (t) => {
  const dbPath = temporaryDatabase(t);
  const { ledger, run } = createProgressEvents(t, dbPath);
  const outcomes = openReplyOutcomeTransactions({ dbPath, clock: () => 101 });
  outcomes.commitRunOutcome({
    requestId: run.requestId,
    turnId: run.turnId,
    generation: run.generation,
    traceId: run.traceId,
    causationId: ledger.listEvents(run.requestId).at(-1).eventId,
    producer: 'runtime:shared',
    idempotencyKey: `run:${run.requestId}:completed`,
    outcome: { kind: 'answer', content: { format: 'text', text: 'Original answer.' } },
    reply: {
      action: 'send',
      route: { adapterId: 'feishu', targetRef: 'opaque:progress' },
      disposition: 'send',
    },
  });
  outcomes.close();
  const tamper = new Database(dbPath);
  const stored = tamper.prepare(`
    SELECT envelope_json FROM assistant_reply_outcomes WHERE request_id = ?
  `).get(run.requestId);
  const envelope = JSON.parse(stored.envelope_json);
  envelope.content.text = 'Tampered answer.';
  tamper.exec('DROP TRIGGER assistant_reply_outcomes_immutable');
  tamper.prepare(`
    UPDATE assistant_reply_outcomes SET envelope_json = ? WHERE request_id = ?
  `).run(canonicalJson(envelope), run.requestId);
  tamper.close();

  const subscriptions = openEventSubscriptions({ dbPath, clock: () => 102 });
  t.after(() => subscriptions.close());
  const subscribed = subscriptions.subscribe({
    consumerId: 'tampered-outcome-consumer',
    bootstrap: 'canonical_cutover',
  });
  assert.equal(subscribed.status, 'degraded');
  assert.equal(subscribed.degradedReason, 'OUTCOME_CANONICAL_HASH_MISMATCH');
});
