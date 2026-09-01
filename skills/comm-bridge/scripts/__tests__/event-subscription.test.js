import assert from 'node:assert/strict';
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
  subscriptions.subscribe({ consumerId: 'consumer-a' });
  subscriptions.subscribe({ consumerId: 'consumer-b' });

  const a1 = subscriptions.claimNext({ consumerId: 'consumer-a', ownerId: 'worker-a' });
  const ack = subscriptions.ack({
    consumerId: 'consumer-a',
    eventId: a1.event.eventId,
    leaseToken: a1.leaseToken,
  });
  const duplicateAck = subscriptions.ack({
    consumerId: 'consumer-a',
    eventId: a1.event.eventId,
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

test('wrong and expired event leases cannot ACK, while restart recovery has one concurrent owner', async (t) => {
  const dbPath = temporaryDatabase(t);
  let now = 100;
  createProgressEvents(t, dbPath);
  const crashed = openEventSubscriptions({
    dbPath,
    clock: () => now,
    leaseTokenFactory: () => 'crashed-event-lease',
  });
  crashed.subscribe({ consumerId: 'restart-consumer' });
  const first = crashed.claimNext({
    consumerId: 'restart-consumer',
    ownerId: 'crashed-worker',
    leaseSeconds: 5,
  });
  assert.throws(
    () => crashed.ack({
      consumerId: 'restart-consumer',
      eventId: first.event.eventId,
      leaseToken: 'wrong-event-lease',
    }),
    error => error?.code === 'LEASE_FENCED',
  );
  now = 105;
  assert.throws(
    () => crashed.ack({
      consumerId: 'restart-consumer',
      eventId: first.event.eventId,
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
      leaseToken: first.leaseToken,
    }),
    error => error?.code === 'LEASE_FENCED',
  );
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
  subscriptions.subscribe({ consumerId: 'projection' });
  for (let index = 0; index < 3; index += 1) {
    const claimed = subscriptions.claimNext({ consumerId: 'projection', ownerId: 'worker' });
    subscriptions.ack({
      consumerId: 'projection',
      eventId: claimed.event.eventId,
      leaseToken: claimed.leaseToken,
    });
  }
  const progress = subscriptions.claimNext({ consumerId: 'projection', ownerId: 'worker' });
  assert.equal(progress.event.type, 'ProgressUpdated');
  const failed = subscriptions.fail({
    consumerId: 'projection',
    eventId: progress.event.eventId,
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
      route: { adapterId: 'feishu', targetRef: 'opaque:progress' },
      disposition: 'send',
    },
  });

  assert.equal(committed.delivery.state, 'pending');
  assert.equal(ledger.get(run.requestId).status, 'completed');
  assert.equal(subscriptions.claimNext({ consumerId: 'projection', ownerId: 'worker' }), null);
});
