import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { openReplyIntentOutbox } from '../reply-intent-outbox.js';
import { openReplyOutcomeTransactions } from '../reply-outcome.js';
import { openRunLedger } from '../run-ledger.js';
import { openRuntimePendingQueue } from '../runtime-pending-queue.js';

function temporaryDatabase(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-reply-outbox-'));
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
      payloadHash: `sha256:${'b'.repeat(64)}`,
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

function createAnswerIntent(t, dbPath, id, clock = () => 100) {
  const ledger = openRunLedger({ dbPath, clock });
  const queue = openRuntimePendingQueue({ dbPath, clock });
  const outcomes = openReplyOutcomeTransactions({ dbPath, clock });
  t.after(() => ledger.close());
  t.after(() => queue.close());
  t.after(() => outcomes.close());
  const accepted = ledger.accept(acceptMessage(id)).request;
  const claim = queue.claimNext();
  const run = queue.confirmStarted({
    admissionId: claim.admission.id,
    requestId: accepted.requestId,
    turnId: accepted.turnId,
    generation: accepted.generation,
    runtimeSessionId: `runtime:${id}`,
  }).request;
  const committed = outcomes.commitRunOutcome({
    requestId: run.requestId,
    turnId: run.turnId,
    generation: run.generation,
    traceId: run.traceId,
    causationId: ledger.listEvents(run.requestId).at(-1).eventId,
    producer: 'runtime:shared',
    idempotencyKey: `run:${run.requestId}:completed`,
    outcome: { kind: 'answer', content: { format: 'text', text: `answer ${id}` } },
    reply: {
      route: { adapterId: 'feishu', targetRef: `opaque:${id}` },
      disposition: 'send',
    },
  });
  return { ledger, run, intent: committed.intent };
}

test('unknown delivery reconciles before retry and only reconciled settles accepted', (t) => {
  const dbPath = temporaryDatabase(t);
  let now = 100;
  let token = 0;
  const { ledger, run, intent } = createAnswerIntent(t, dbPath, 'unknown', () => now);
  const outbox = openReplyIntentOutbox({
    dbPath,
    clock: () => now,
    leaseTokenFactory: () => `lease-${++token}`,
  });
  t.after(() => outbox.close());

  const sendClaim = outbox.claimNext({ ownerId: 'adapter-a', leaseSeconds: 30 });
  assert.equal(sendClaim.action, 'send');
  assert.equal(sendClaim.intent.intentId, intent.intentId);
  const unknown = {
    schemaVersion: 1,
    type: 'DeliveryReceipt',
    receiptId: `receipt:${sendClaim.attemptId}:unknown`,
    intentId: intent.intentId,
    deliveryId: sendClaim.deliveryId,
    requestId: run.requestId,
    attemptId: sendClaim.attemptId,
    traceId: run.traceId,
    adapterId: 'feishu',
    outcome: 'unknown',
    externalRef: null,
    observedAt: '2026-09-01T00:01:00.000Z',
    nextAction: 'reconcile_before_retry',
  };
  const unknownResult = outbox.recordReceipt({
    leaseToken: sendClaim.leaseToken,
    receipt: unknown,
  });
  assert.equal(unknownResult.delivery.state, 'reconcile_required');
  assert.equal(unknownResult.settlement, null);

  const reconcileClaim = outbox.claimNext({ ownerId: 'adapter-b', leaseSeconds: 30 });
  assert.equal(reconcileClaim.action, 'reconcile');
  assert.equal(reconcileClaim.attemptId, sendClaim.attemptId);
  const reconciled = outbox.recordReceipt({
    leaseToken: reconcileClaim.leaseToken,
    receipt: {
      ...unknown,
      receiptId: `receipt:${sendClaim.attemptId}:reconciled`,
      outcome: 'reconciled',
      externalRef: 'opaque:platform-message-1',
      observedAt: '2026-09-01T00:02:00.000Z',
      nextAction: undefined,
    },
  });
  assert.equal(reconciled.delivery.state, 'accepted');
  assert.equal(reconciled.settlement.type, 'DeliverySettlement');
  assert.equal(reconciled.settlement.state, 'accepted');
  assert.equal(reconciled.settlement.basis, 'reconciled');
  assert.equal(reconciled.settlement.presented, true);
  assert.equal(ledger.get(run.requestId).status, 'completed');
  assert.equal(outbox.claimNext({ ownerId: 'adapter-c' }), null);
});

test('rejected delivery retries with a new attempt then settles unpresentable at exhaustion', (t) => {
  const dbPath = temporaryDatabase(t);
  let token = 0;
  const { ledger, run, intent } = createAnswerIntent(t, dbPath, 'retry');
  const outbox = openReplyIntentOutbox({
    dbPath,
    clock: () => 100,
    leaseTokenFactory: () => `retry-lease-${++token}`,
    maxAttempts: 2,
  });
  t.after(() => outbox.close());

  const first = outbox.claimNext({ ownerId: 'adapter-a' });
  const rejectedReceipt = (claim, receiptId) => ({
    schemaVersion: 1,
    type: 'DeliveryReceipt',
    receiptId,
    intentId: intent.intentId,
    deliveryId: claim.deliveryId,
    requestId: run.requestId,
    attemptId: claim.attemptId,
    traceId: run.traceId,
    adapterId: 'feishu',
    outcome: 'rejected',
    externalRef: null,
    observedAt: '2026-09-01T00:03:00.000Z',
    errorCode: 'PLATFORM_REJECTED',
    retryable: true,
  });
  const firstRejected = outbox.recordReceipt({
    leaseToken: first.leaseToken,
    receipt: rejectedReceipt(first, 'receipt:retry:1'),
  });
  assert.equal(firstRejected.delivery.state, 'retrying');
  assert.equal(firstRejected.settlement, null);

  const second = outbox.claimNext({ ownerId: 'adapter-b' });
  assert.equal(second.action, 'send');
  assert.notEqual(second.attemptId, first.attemptId);
  const exhausted = outbox.recordReceipt({
    leaseToken: second.leaseToken,
    receipt: rejectedReceipt(second, 'receipt:retry:2'),
  });
  assert.equal(exhausted.delivery.state, 'unpresentable');
  assert.equal(exhausted.settlement.state, 'unpresentable');
  assert.equal(exhausted.settlement.basis, 'retry_exhausted');
  assert.equal(exhausted.settlement.presented, false);
  assert.equal(outbox.listReceipts(intent.intentId).length, 2);
  assert.equal(outbox.listSettlements(intent.intentId).length, 1);
  assert.equal(ledger.get(run.requestId).status, 'completed');
});

test('leases replay for one owner and fail closed for wrong, expired or superseded tokens', (t) => {
  const dbPath = temporaryDatabase(t);
  let now = 100;
  let token = 0;
  const { run, intent } = createAnswerIntent(t, dbPath, 'lease', () => now);
  const outbox = openReplyIntentOutbox({
    dbPath,
    clock: () => now,
    leaseTokenFactory: () => `fenced-lease-${++token}`,
  });
  t.after(() => outbox.close());
  const claim = outbox.claimNext({ ownerId: 'adapter-a', leaseSeconds: 10 });
  const replay = outbox.claimNext({ ownerId: 'adapter-a', leaseSeconds: 10 });
  assert.equal(replay.replayed, true);
  assert.equal(replay.leaseToken, claim.leaseToken);
  const accepted = {
    schemaVersion: 1,
    type: 'DeliveryReceipt',
    receiptId: 'receipt:lease:accepted',
    intentId: intent.intentId,
    deliveryId: claim.deliveryId,
    requestId: run.requestId,
    attemptId: claim.attemptId,
    traceId: run.traceId,
    adapterId: 'feishu',
    outcome: 'platform_accepted',
    externalRef: 'opaque:platform-message-lease',
    observedAt: '2026-09-01T00:04:00.000Z',
  };
  assert.throws(
    () => outbox.recordReceipt({ leaseToken: 'wrong-token', receipt: accepted }),
    error => error?.code === 'LEASE_FENCED',
  );
  now = 110;
  assert.throws(
    () => outbox.recordReceipt({ leaseToken: claim.leaseToken, receipt: accepted }),
    error => error?.code === 'LEASE_EXPIRED',
  );

  const reconcile = outbox.claimNext({ ownerId: 'adapter-b', leaseSeconds: 10 });
  assert.equal(reconcile.action, 'reconcile');
  assert.notEqual(reconcile.leaseToken, claim.leaseToken);
  assert.throws(
    () => outbox.recordReceipt({ leaseToken: claim.leaseToken, receipt: accepted }),
    error => error?.code === 'LEASE_FENCED',
  );
});

test('crash restart recovers an expired send as reconciliation and concurrent claim has one owner', async (t) => {
  const dbPath = temporaryDatabase(t);
  let now = 100;
  const { intent } = createAnswerIntent(t, dbPath, 'restart', () => now);
  const crashed = openReplyIntentOutbox({
    dbPath,
    clock: () => now,
    leaseTokenFactory: () => 'crashed-lease',
  });
  const first = crashed.claimNext({ ownerId: 'crashed-owner', leaseSeconds: 5 });
  assert.equal(first.action, 'send');
  crashed.close();

  now = 106;
  const ownerA = openReplyIntentOutbox({
    dbPath,
    clock: () => now,
    leaseTokenFactory: () => 'recovery-lease-a',
  });
  const ownerB = openReplyIntentOutbox({
    dbPath,
    clock: () => now,
    leaseTokenFactory: () => 'recovery-lease-b',
  });
  t.after(() => ownerA.close());
  t.after(() => ownerB.close());
  const [claimA, claimB] = await Promise.all([
    Promise.resolve().then(() => ownerA.claimNext({ ownerId: 'owner-a' })),
    Promise.resolve().then(() => ownerB.claimNext({ ownerId: 'owner-b' })),
  ]);
  const [winner] = [claimA, claimB].filter(Boolean);
  assert.equal(winner.action, 'reconcile');
  assert.equal(winner.intent.intentId, intent.intentId);
  assert.equal(winner.attemptId, first.attemptId);
  assert.equal([claimA, claimB].filter(Boolean).length, 1);
});

test('platform_accepted receipt and accepted settlement are idempotent and fail closed on conflict', (t) => {
  const dbPath = temporaryDatabase(t);
  const { run, intent } = createAnswerIntent(t, dbPath, 'accepted');
  const outbox = openReplyIntentOutbox({
    dbPath,
    clock: () => 100,
    leaseTokenFactory: () => 'accepted-lease',
  });
  t.after(() => outbox.close());
  const claim = outbox.claimNext({ ownerId: 'adapter-a' });
  const receipt = {
    schemaVersion: 1,
    type: 'DeliveryReceipt',
    receiptId: 'receipt:accepted:1',
    intentId: intent.intentId,
    deliveryId: claim.deliveryId,
    requestId: run.requestId,
    attemptId: claim.attemptId,
    traceId: run.traceId,
    adapterId: 'feishu',
    outcome: 'platform_accepted',
    externalRef: 'opaque:platform-message-accepted',
    observedAt: '2026-09-01T00:05:00.000Z',
  };

  const first = outbox.recordReceipt({ leaseToken: claim.leaseToken, receipt });
  const replay = outbox.recordReceipt({ leaseToken: claim.leaseToken, receipt });
  assert.equal(first.replayed, false);
  assert.equal(replay.replayed, true);
  assert.equal(first.settlement.basis, 'platform_accepted');
  assert.deepEqual(replay.settlement, first.settlement);
  assert.equal(outbox.listReceipts(intent.intentId).length, 1);
  assert.equal(outbox.listSettlements(intent.intentId).length, 1);
  assert.throws(
    () => outbox.recordReceipt({
      leaseToken: claim.leaseToken,
      receipt: { ...receipt, externalRef: 'opaque:different-message' },
    }),
    error => error?.code === 'IDEMPOTENCY_CONFLICT',
  );
});

test('dead-letter redrive keeps the original ReplyIntent identity', (t) => {
  const dbPath = temporaryDatabase(t);
  let token = 0;
  const { run, intent } = createAnswerIntent(t, dbPath, 'redrive');
  const outbox = openReplyIntentOutbox({
    dbPath,
    clock: () => 100,
    leaseTokenFactory: () => `redrive-lease-${++token}`,
    maxAttempts: 1,
  });
  t.after(() => outbox.close());
  const claim = outbox.claimNext({ ownerId: 'adapter-a' });
  outbox.recordReceipt({
    leaseToken: claim.leaseToken,
    receipt: {
      schemaVersion: 1,
      type: 'DeliveryReceipt',
      receiptId: 'receipt:redrive:rejected',
      intentId: intent.intentId,
      deliveryId: claim.deliveryId,
      requestId: run.requestId,
      attemptId: claim.attemptId,
      traceId: run.traceId,
      adapterId: 'feishu',
      outcome: 'rejected',
      externalRef: null,
      observedAt: '2026-09-01T00:06:00.000Z',
      errorCode: 'PLATFORM_REJECTED',
      retryable: true,
    },
  });

  const redriven = outbox.redrive({ intentId: intent.intentId });
  assert.equal(redriven.replayed, false);
  assert.equal(redriven.intent.intentId, intent.intentId);
  assert.equal(redriven.delivery.state, 'pending');
  assert.equal(redriven.delivery.redriveCount, 1);
  const redriveClaim = outbox.claimNext({ ownerId: 'adapter-b' });
  assert.equal(redriveClaim.action, 'send');
  assert.equal(redriveClaim.intent.intentId, intent.intentId);
  assert.notEqual(redriveClaim.attemptId, claim.attemptId);
  assert.equal(outbox.listSettlements(intent.intentId).length, 1);
});
