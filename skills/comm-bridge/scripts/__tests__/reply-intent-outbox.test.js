import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import Database from 'better-sqlite3';

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
      action: 'send',
      route: { adapterId: 'feishu', targetRef: `opaque:${id}` },
      disposition: 'send',
    },
  });
  return { ledger, run, intent: committed.intent };
}

function createFailureIntent(t, dbPath, id, clock = () => 100) {
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
    idempotencyKey: `run:${run.requestId}:failed`,
    outcome: { kind: 'failure', code: 'RUNTIME_FAILED', retryable: true },
    reply: {
      action: 'send',
      route: { adapterId: 'feishu', targetRef: `opaque:${id}` },
      disposition: 'failure_notice',
      payload: { format: 'text', text: 'Unable to complete.' },
    },
  });
  return { ledger, run, intent: committed.intent };
}

function recordReceiptForClaim(outbox, claim, receipt, overrides = {}) {
  return outbox.recordReceipt({
    action: claim.action,
    claimEpoch: claim.claimEpoch,
    leaseToken: claim.leaseToken,
    receipt,
    ...overrides,
  });
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

test('tampered ReplyIntent canonical bytes fail closed before claim or settlement', (t) => {
  const dbPath = temporaryDatabase(t);
  const { intent } = createAnswerIntent(t, dbPath, 'tampered-intent');
  const mutate = new Database(dbPath);
  mutate.exec('DROP TRIGGER IF EXISTS assistant_reply_intents_canonical_immutable');
  mutate.prepare(`
    UPDATE assistant_reply_intents
    SET route_json = '{"adapterId":"feishu","targetRef":"opaque:attacker"}',
        envelope_json = json_set(envelope_json, '$.route.targetRef', 'opaque:attacker')
    WHERE intent_id = ?
  `).run(intent.intentId);
  mutate.close();

  const outbox = openReplyIntentOutbox({ dbPath, clock: () => 100 });
  t.after(() => outbox.close());
  assert.throws(
    () => outbox.claimNext({ ownerId: 'adapter-a' }),
    error => error?.code === 'CANONICAL_REPLY_INTENT_CORRUPT',
  );
  assert.throws(
    () => outbox.listSettlements(intent.intentId),
    error => error?.code === 'CANONICAL_REPLY_INTENT_CORRUPT',
  );
});

test('orphan run_terminal ReplyIntent cannot be claimed without its canonical terminal cause', (t) => {
  const dbPath = temporaryDatabase(t);
  const { intent } = createAnswerIntent(t, dbPath, 'orphan-terminal-intent');
  const mutate = new Database(dbPath);
  mutate.exec('DROP TRIGGER assistant_response_events_canonical_no_delete');
  mutate.prepare(`DELETE FROM assistant_response_events WHERE event_id = ?`).run(intent.cause.eventId);
  mutate.close();
  const outbox = openReplyIntentOutbox({ dbPath, clock: () => 100 });
  t.after(() => outbox.close());
  assert.throws(
    () => outbox.claimNext({ ownerId: 'adapter-a' }),
    error => error?.code === 'CANONICAL_REPLY_INTENT_CAUSE_INVALID',
  );
  assert.throws(
    () => outbox.get(intent.intentId),
    error => error?.code === 'CANONICAL_REPLY_INTENT_CAUSE_INVALID',
  );
});

test('run_terminal ReplyIntent claim validates durable Outcome identity and intake route linkage', (t) => {
  for (const scenario of ['outcome-trace', 'durable-route']) {
    const dbPath = temporaryDatabase(t);
    const { intent } = createAnswerIntent(t, dbPath, `intent-link-${scenario}`);
    const mutate = new Database(dbPath);
    if (scenario === 'outcome-trace') {
      mutate.exec('DROP TRIGGER assistant_reply_outcomes_immutable');
      const row = mutate.prepare(`SELECT envelope_json FROM assistant_reply_outcomes WHERE request_id = ?`)
        .get(intent.requestId);
      const envelope = { ...JSON.parse(row.envelope_json), traceId: 'trace:attacker' };
      const envelopeJson = canonicalJson(envelope);
      mutate.prepare(`
        UPDATE assistant_reply_outcomes
        SET trace_id = 'trace:attacker', envelope_json = ?, canonical_hash = ?
        WHERE request_id = ?
      `).run(envelopeJson, sha256(envelopeJson), intent.requestId);
    } else {
      mutate.prepare(`
        UPDATE assistant_run_ledger
        SET reply_route_json = '{"adapterId":"feishu","targetRef":"opaque:attacker"}'
        WHERE request_id = ?
      `).run(intent.requestId);
    }
    mutate.close();
    const outbox = openReplyIntentOutbox({ dbPath, clock: () => 100 });
    assert.throws(
      () => outbox.claimNext({ ownerId: 'adapter-a' }),
      error => error?.code === 'CANONICAL_REPLY_INTENT_CAUSE_INVALID',
    );
    outbox.close();
  }
});

test('run_terminal ReplyIntent cannot outlive a terminal event/ledger/request status split', (t) => {
  const dbPath = temporaryDatabase(t);
  const { intent, ledger } = createAnswerIntent(t, dbPath, 'terminal-status-split');
  const mutate = new Database(dbPath);
  mutate.prepare(`UPDATE assistant_run_ledger SET status = 'failed' WHERE request_id = ?`)
    .run(intent.requestId);
  mutate.prepare(`UPDATE assistant_requests SET status = 'failed' WHERE request_id = ?`)
    .run(intent.requestId);
  mutate.close();

  assert.throws(
    () => ledger.get(intent.requestId),
    error => error?.code === 'CANONICAL_RUN_LEDGER_CORRUPT',
  );

  const outbox = openReplyIntentOutbox({ dbPath, clock: () => 100 });
  t.after(() => outbox.close());
  assert.throws(
    () => outbox.claimNext({ ownerId: 'adapter-a' }),
    error => error?.code === 'CANONICAL_REPLY_INTENT_CAUSE_INVALID',
  );
  assert.throws(
    () => outbox.get(intent.intentId),
    error => error?.code === 'CANONICAL_REPLY_INTENT_CAUSE_INVALID',
  );
});

test('RunFailed terminal payload must equal its canonical failure Outcome', (t) => {
  const dbPath = temporaryDatabase(t);
  const { intent } = createFailureIntent(t, dbPath, 'failure-payload-link');
  const mutate = new Database(dbPath);
  mutate.exec('DROP TRIGGER assistant_reply_outcomes_immutable');
  const row = mutate.prepare(`SELECT envelope_json FROM assistant_reply_outcomes WHERE request_id = ?`)
    .get(intent.requestId);
  const envelope = { ...JSON.parse(row.envelope_json), code: 'DIFFERENT_FAILURE' };
  const envelopeJson = canonicalJson(envelope);
  mutate.prepare(`
    UPDATE assistant_reply_outcomes
    SET envelope_json = ?, canonical_hash = ?
    WHERE request_id = ?
  `).run(envelopeJson, sha256(envelopeJson), intent.requestId);
  mutate.close();

  const outbox = openReplyIntentOutbox({ dbPath, clock: () => 100 });
  t.after(() => outbox.close());
  assert.throws(
    () => outbox.claimNext({ ownerId: 'adapter-a' }),
    error => error?.code === 'CANONICAL_REPLY_INTENT_CAUSE_INVALID',
  );
});

test('task_effect ReplyIntent cannot be claimed after its durable TaskEffect fact is orphaned', (t) => {
  const dbPath = temporaryDatabase(t);
  const ledger = openRunLedger({ dbPath, clock: () => 100 });
  const run = ledger.accept(acceptMessage('orphan-task-effect')).request;
  const command = {
    requestId: run.requestId,
    traceId: run.traceId,
    cause: { kind: 'task_effect', eventId: 'task-effect:orphan:applied' },
    route: { adapterId: 'feishu', targetRef: 'opaque:orphan-task-effect' },
    disposition: 'task_receipt',
    payload: { format: 'text', text: 'Task created.' },
  };
  const replies = openReplyOutcomeTransactions({
    dbPath,
    clock: () => 101,
    taskEffectVerifier: () => ({
      canonical: true,
      applied: true,
      eventId: command.cause.eventId,
      effectId: command.cause.eventId,
      taskId: 'task:orphan',
      requestId: command.requestId,
      traceId: command.traceId,
      route: command.route,
      disposition: command.disposition,
      payload: command.payload,
    }),
  });
  const committed = replies.commitTaskReceipt(command);
  replies.close();
  ledger.close();

  const mutate = new Database(dbPath);
  const exists = mutate.prepare(`
    SELECT 1 FROM sqlite_master
    WHERE type = 'table' AND name = 'assistant_verified_task_effects'
  `).get();
  if (exists) {
    mutate.exec('DROP TRIGGER assistant_verified_task_effects_no_delete');
    mutate.prepare(`DELETE FROM assistant_verified_task_effects WHERE event_id = ?`)
      .run(command.cause.eventId);
  }
  mutate.close();

  const outbox = openReplyIntentOutbox({ dbPath, clock: () => 102 });
  t.after(() => outbox.close());
  assert.throws(
    () => outbox.claimNext({ ownerId: 'adapter-a' }),
    error => error?.code === 'CANONICAL_REPLY_INTENT_CAUSE_INVALID',
  );
  assert.throws(
    () => outbox.get(committed.intent.intentId),
    error => error?.code === 'CANONICAL_REPLY_INTENT_CAUSE_INVALID',
  );
});

test('ReplyIntent identity/body and DeliveryReceipt/Settlement rows are immutable', (t) => {
  const dbPath = temporaryDatabase(t);
  const { run, intent } = createAnswerIntent(t, dbPath, 'immutable-delivery-ledger');
  const outbox = openReplyIntentOutbox({
    dbPath,
    clock: () => 100,
    leaseTokenFactory: () => 'immutable-lease',
  });
  t.after(() => outbox.close());
  const claim = outbox.claimNext({ ownerId: 'adapter-a' });
  recordReceiptForClaim(outbox, claim, {
    schemaVersion: 1,
    type: 'DeliveryReceipt',
    receiptId: 'receipt:immutable-delivery-ledger:accepted',
    intentId: intent.intentId,
    deliveryId: claim.deliveryId,
    requestId: run.requestId,
    attemptId: claim.attemptId,
    traceId: run.traceId,
    adapterId: 'feishu',
    outcome: 'platform_accepted',
    externalRef: 'opaque:accepted',
    observedAt: '2026-09-01T00:05:00.000Z',
  });
  const mutate = new Database(dbPath);
  for (const statement of [
    `UPDATE assistant_reply_intents SET route_json = '{}' WHERE intent_id = ?`,
    `UPDATE assistant_reply_intents SET payload_json = '{}' WHERE intent_id = ?`,
    `UPDATE assistant_reply_intents SET cause_event_id = 'evt:attacker:1' WHERE intent_id = ?`,
    `UPDATE assistant_reply_intents SET canonical_hash = 'attacker' WHERE intent_id = ?`,
    `UPDATE assistant_reply_intents SET envelope_json = '{}' WHERE intent_id = ?`,
    `DELETE FROM assistant_reply_intents WHERE intent_id = ?`,
  ]) {
    assert.throws(() => mutate.prepare(statement).run(intent.intentId), /immutable/);
  }
  assert.throws(
    () => mutate.prepare(`UPDATE assistant_delivery_receipts SET outcome = 'unknown' WHERE intent_id = ?`).run(intent.intentId),
    /immutable/,
  );
  assert.throws(
    () => mutate.prepare(`DELETE FROM assistant_delivery_receipts WHERE intent_id = ?`).run(intent.intentId),
    /immutable/,
  );
  assert.throws(
    () => mutate.prepare(`UPDATE assistant_delivery_settlements SET basis = 'reconciled' WHERE intent_id = ?`).run(intent.intentId),
    /immutable/,
  );
  assert.throws(
    () => mutate.prepare(`DELETE FROM assistant_delivery_settlements WHERE intent_id = ?`).run(intent.intentId),
    /immutable/,
  );
  assert.throws(
    () => mutate.prepare(`
      INSERT INTO assistant_delivery_settlements (
        settlement_id, intent_id, delivery_id, request_id, trace_id, adapter_id,
        state, basis, presented, envelope_json, canonical_hash, created_at
      )
      SELECT
        'settlement:attacker', intent_id, delivery_id, request_id, trace_id, adapter_id,
        state, basis, presented, envelope_json, canonical_hash, created_at
      FROM assistant_delivery_settlements WHERE intent_id = ?
    `).run(intent.intentId),
    /immutable|UNIQUE/,
  );
  assert.throws(
    () => mutate.prepare(`
      INSERT OR REPLACE INTO assistant_delivery_settlements
      SELECT * FROM assistant_delivery_settlements WHERE intent_id = ?
    `).run(intent.intentId),
    /immutable/,
  );
  mutate.close();
  assert.equal(outbox.get(intent.intentId).delivery.state, 'accepted');
});

test('schema migration replaces a same-name legacy trigger with the complete protected-column set', (t) => {
  const dbPath = temporaryDatabase(t);
  const { intent } = createAnswerIntent(t, dbPath, 'legacy-trigger-upgrade');
  const legacy = new Database(dbPath);
  legacy.exec(`
    DROP TRIGGER assistant_reply_intents_canonical_immutable;
    CREATE TRIGGER assistant_reply_intents_canonical_immutable
    BEFORE UPDATE OF route_json ON assistant_reply_intents
    BEGIN
      SELECT RAISE(ABORT, 'legacy narrow trigger');
    END;
  `);
  legacy.close();
  const migrated = openReplyIntentOutbox({ dbPath, clock: () => 100 });
  t.after(() => migrated.close());
  const inspect = new Database(dbPath);
  const sql = inspect.prepare(`SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = ?`)
    .get('assistant_reply_intents_canonical_immutable').sql;
  assert.match(sql, /envelope_json/);
  assert.match(sql, /cause_event_id/);
  assert.throws(
    () => inspect.prepare(`UPDATE assistant_reply_intents SET envelope_json = '{}' WHERE intent_id = ?`).run(intent.intentId),
    /immutable/,
  );
  inspect.close();
});

test('legacy receipt and settlement tampering fails canonical replay and list validation', (t) => {
  const dbPath = temporaryDatabase(t);
  const { run, intent } = createAnswerIntent(t, dbPath, 'tampered-delivery-ledger');
  const outbox = openReplyIntentOutbox({
    dbPath,
    clock: () => 100,
    leaseTokenFactory: () => 'tampered-ledger-lease',
  });
  t.after(() => outbox.close());
  const claim = outbox.claimNext({ ownerId: 'adapter-a' });
  const receipt = {
    schemaVersion: 1,
    type: 'DeliveryReceipt',
    receiptId: 'receipt:tampered-delivery-ledger:accepted',
    intentId: intent.intentId,
    deliveryId: claim.deliveryId,
    requestId: run.requestId,
    attemptId: claim.attemptId,
    traceId: run.traceId,
    adapterId: 'feishu',
    outcome: 'platform_accepted',
    externalRef: 'opaque:accepted',
    observedAt: '2026-09-01T00:05:00.000Z',
  };
  recordReceiptForClaim(outbox, claim, receipt);
  const mutate = new Database(dbPath);
  mutate.exec(`
    DROP TRIGGER assistant_delivery_receipts_immutable;
    DROP TRIGGER assistant_delivery_settlements_immutable;
  `);
  const receiptEnvelope = { ...receipt, outcome: 'unknown', externalRef: null, nextAction: 'reconcile_before_retry' };
  const receiptJson = canonicalJson(receiptEnvelope);
  mutate.prepare(`UPDATE assistant_delivery_receipts SET envelope_json = ?, canonical_hash = ? WHERE receipt_id = ?`)
    .run(receiptJson, sha256(receiptJson), receipt.receiptId);
  const settlement = mutate.prepare(`SELECT * FROM assistant_delivery_settlements WHERE intent_id = ?`).get(intent.intentId);
  const settlementEnvelope = { ...JSON.parse(settlement.envelope_json), basis: 'reconciled' };
  const settlementJson = canonicalJson(settlementEnvelope);
  mutate.prepare(`UPDATE assistant_delivery_settlements SET envelope_json = ?, canonical_hash = ? WHERE settlement_id = ?`)
    .run(settlementJson, sha256(settlementJson), settlement.settlement_id);
  mutate.close();
  assert.throws(
    () => outbox.listReceipts(intent.intentId),
    error => error?.code === 'CANONICAL_DELIVERY_RECEIPT_CORRUPT',
  );
  assert.throws(
    () => recordReceiptForClaim(outbox, claim, receipt),
    error => error?.code === 'CANONICAL_DELIVERY_RECEIPT_CORRUPT',
  );
  const restore = new Database(dbPath);
  const originalReceiptJson = canonicalJson(receipt);
  restore.prepare(`UPDATE assistant_delivery_receipts SET envelope_json = ?, canonical_hash = ? WHERE receipt_id = ?`)
    .run(originalReceiptJson, sha256(originalReceiptJson), receipt.receiptId);
  restore.close();
  assert.throws(
    () => outbox.listSettlements(intent.intentId),
    error => error?.code === 'CANONICAL_DELIVERY_SETTLEMENT_CORRUPT',
  );
});

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
  const unknownResult = recordReceiptForClaim(outbox, sendClaim, unknown);
  assert.equal(unknownResult.delivery.state, 'reconcile_required');
  assert.equal(unknownResult.settlement, null);

  const reconcileClaim = outbox.claimNext({ ownerId: 'adapter-b', leaseSeconds: 30 });
  assert.equal(reconcileClaim.action, 'reconcile');
  assert.equal(reconcileClaim.attemptId, sendClaim.attemptId);
  const { nextAction: _unknownNextAction, ...receiptWithoutNextAction } = unknown;
  const reconciled = recordReceiptForClaim(outbox, reconcileClaim, {
      ...receiptWithoutNextAction,
      receiptId: `receipt:${sendClaim.attemptId}:reconciled`,
      outcome: 'reconciled',
      externalRef: 'opaque:platform-message-1',
      observedAt: '2026-09-01T00:02:00.000Z',
  });
  assert.equal(reconciled.delivery.state, 'accepted');
  assert.equal(reconciled.settlement.type, 'DeliverySettlement');
  assert.equal(reconciled.settlement.state, 'accepted');
  assert.equal(reconciled.settlement.basis, 'reconciled');
  assert.equal(reconciled.settlement.presented, true);
  assert.equal(ledger.get(run.requestId).status, 'completed');
  assert.equal(outbox.claimNext({ ownerId: 'adapter-c' }), null);
});

test('unknown and rejected receipts with an externalRef fail atomically before ledger mutation', (t) => {
  for (const outcome of ['unknown', 'rejected']) {
    const dbPath = temporaryDatabase(t);
    const { run, intent } = createAnswerIntent(t, dbPath, `invalid-${outcome}-external-ref`);
    const outbox = openReplyIntentOutbox({
      dbPath,
      clock: () => 100,
      leaseTokenFactory: () => `lease:invalid-${outcome}-external-ref`,
    });
    t.after(() => outbox.close());
    const claim = outbox.claimNext({ ownerId: 'adapter-a' });
    const receipt = {
      schemaVersion: 1,
      type: 'DeliveryReceipt',
      receiptId: `receipt:invalid-${outcome}-external-ref`,
      intentId: intent.intentId,
      deliveryId: claim.deliveryId,
      requestId: run.requestId,
      attemptId: claim.attemptId,
      traceId: run.traceId,
      adapterId: 'feishu',
      outcome,
      externalRef: 'BAD',
      observedAt: '2026-09-01T00:01:00.000Z',
      ...(outcome === 'unknown'
        ? { nextAction: 'reconcile_before_retry' }
        : { errorCode: 'PLATFORM_REJECTED', retryable: true }),
    };

    assert.throws(
      () => recordReceiptForClaim(outbox, claim, receipt),
      error => error?.code === 'INVALID_EXTERNAL_REF',
    );
    assert.deepEqual(outbox.listReceipts(intent.intentId), []);
    assert.deepEqual(outbox.listSettlements(intent.intentId), []);
    assert.equal(outbox.get(intent.intentId).delivery.state, 'sending');
  }
});

test('a noncanonical receipt candidate is rejected before its first durable insert', (t) => {
  const dbPath = temporaryDatabase(t);
  const { run, intent } = createAnswerIntent(t, dbPath, 'noncanonical-receipt-candidate');
  const outbox = openReplyIntentOutbox({
    dbPath,
    clock: () => 100,
    leaseTokenFactory: () => 'lease:noncanonical-receipt-candidate',
  });
  t.after(() => outbox.close());
  const claim = outbox.claimNext({ ownerId: 'adapter-a' });
  const tamper = new Database(dbPath);
  tamper.prepare(`
    UPDATE assistant_reply_intents SET current_attempt_id = 'attempt:attacker'
    WHERE intent_id = ?
  `).run(intent.intentId);
  tamper.close();
  const receipt = {
    schemaVersion: 1,
    type: 'DeliveryReceipt',
    receiptId: 'receipt:noncanonical-receipt-candidate',
    intentId: intent.intentId,
    deliveryId: claim.deliveryId,
    requestId: run.requestId,
    attemptId: 'attempt:attacker',
    traceId: run.traceId,
    adapterId: 'feishu',
    outcome: 'platform_accepted',
    externalRef: 'opaque:accepted',
    observedAt: '2026-09-01T00:01:00.000Z',
  };

  assert.throws(
    () => recordReceiptForClaim(outbox, claim, receipt),
    error => error?.code === 'NONCANONICAL_DELIVERY_RECEIPT',
  );
  assert.deepEqual(outbox.listReceipts(intent.intentId), []);
  assert.deepEqual(outbox.listSettlements(intent.intentId), []);
});

test('outbox public claims and DeliveryReceipt inputs reject unknown v1 fields', (t) => {
  const dbPath = temporaryDatabase(t);
  const { run, intent } = createAnswerIntent(t, dbPath, 'strict-delivery-receipt');
  const outbox = openReplyIntentOutbox({
    dbPath,
    clock: () => 100,
    leaseTokenFactory: () => 'strict-delivery-lease',
  });
  t.after(() => outbox.close());
  assert.throws(
    () => outbox.claimNext({ ownerId: 'adapter-a', attacker: true }),
    error => error?.code === 'NONCANONICAL_V1_SHAPE',
  );
  const claim = outbox.claimNext({ ownerId: 'adapter-a' });
  const receipt = {
    schemaVersion: 1,
    type: 'DeliveryReceipt',
    receiptId: 'receipt:strict-delivery-receipt:accepted',
    intentId: intent.intentId,
    deliveryId: claim.deliveryId,
    requestId: run.requestId,
    attemptId: claim.attemptId,
    traceId: run.traceId,
    adapterId: 'feishu',
    outcome: 'platform_accepted',
    externalRef: 'opaque:accepted',
    observedAt: '2026-09-01T00:05:00.000Z',
  };
  assert.throws(
    () => outbox.recordReceipt({
      action: claim.action,
      claimEpoch: claim.claimEpoch,
      leaseToken: claim.leaseToken,
      receipt,
      attacker: true,
    }),
    error => error?.code === 'NONCANONICAL_V1_SHAPE',
  );
  assert.throws(
    () => recordReceiptForClaim(outbox, claim, { ...receipt, attacker: true }),
    error => error?.code === 'NONCANONICAL_V1_SHAPE',
  );
  assert.equal(outbox.get(intent.intentId).delivery.state, 'sending');
  assert.deepEqual(outbox.listReceipts(intent.intentId), []);
});

test('reconciliation claim epoch fences a stale owner when lease tokens are reused', (t) => {
  const dbPath = temporaryDatabase(t);
  let now = 100;
  const { run, intent } = createAnswerIntent(t, dbPath, 'reconcile-epoch-aba', () => now);
  const outbox = openReplyIntentOutbox({
    dbPath,
    clock: () => now,
    leaseTokenFactory: () => 'same-token',
  });
  t.after(() => outbox.close());
  const send = outbox.claimNext({ ownerId: 'owner-a', leaseSeconds: 5 });
  const baseReceipt = {
    schemaVersion: 1,
    type: 'DeliveryReceipt',
    intentId: intent.intentId,
    deliveryId: send.deliveryId,
    requestId: run.requestId,
    attemptId: send.attemptId,
    traceId: run.traceId,
    adapterId: 'feishu',
    externalRef: null,
    observedAt: '2026-09-01T00:01:00.000Z',
  };
  outbox.recordReceipt({
    action: send.action,
    claimEpoch: send.claimEpoch,
    leaseToken: send.leaseToken,
    receipt: {
      ...baseReceipt,
      receiptId: 'receipt:reconcile-epoch-aba:unknown',
      outcome: 'unknown',
      nextAction: 'reconcile_before_retry',
    },
  });
  const ownerB = outbox.claimNext({ ownerId: 'owner-b', leaseSeconds: 5 });
  assert.equal(ownerB.action, 'reconcile');
  now = 106;
  const ownerC = outbox.claimNext({ ownerId: 'owner-c', leaseSeconds: 5 });
  assert.equal(ownerC.action, 'reconcile');
  assert.equal(ownerB.leaseToken, ownerC.leaseToken);
  assert.notEqual(ownerB.claimEpoch, ownerC.claimEpoch);
  const reconciledReceipt = {
    ...baseReceipt,
    receiptId: 'receipt:reconcile-epoch-aba:reconciled',
    outcome: 'reconciled',
    externalRef: 'opaque:reconciled-message',
    observedAt: '2026-09-01T00:02:00.000Z',
  };
  for (const staleReceipt of [
    reconciledReceipt,
    {
      ...baseReceipt,
      receiptId: 'receipt:reconcile-epoch-aba:rejected',
      outcome: 'rejected',
      errorCode: 'NOT_FOUND',
      retryable: true,
    },
    {
      ...baseReceipt,
      receiptId: 'receipt:reconcile-epoch-aba:unknown-again',
      outcome: 'unknown',
      nextAction: 'reconcile_before_retry',
    },
  ]) {
    assert.throws(
      () => outbox.recordReceipt({
        action: ownerB.action,
        claimEpoch: ownerB.claimEpoch,
        leaseToken: ownerB.leaseToken,
        receipt: staleReceipt,
      }),
      error => error?.code === 'LEASE_FENCED',
    );
  }
  const accepted = outbox.recordReceipt({
    action: ownerC.action,
    claimEpoch: ownerC.claimEpoch,
    leaseToken: ownerC.leaseToken,
    receipt: reconciledReceipt,
  });
  assert.equal(accepted.delivery.state, 'accepted');
  assert.equal(accepted.settlement.basis, 'reconciled');
  const replay = outbox.recordReceipt({
    action: ownerC.action,
    claimEpoch: ownerC.claimEpoch,
    leaseToken: ownerC.leaseToken,
    receipt: reconciledReceipt,
  });
  assert.equal(replay.replayed, true);
  assert.deepEqual(replay.settlement, accepted.settlement);
});

test('send claim epoch fences an expired owner when a later send reuses the token', (t) => {
  const dbPath = temporaryDatabase(t);
  let now = 100;
  const { run, intent } = createAnswerIntent(t, dbPath, 'send-epoch-aba', () => now);
  const outbox = openReplyIntentOutbox({
    dbPath,
    clock: () => now,
    leaseTokenFactory: () => 'same-send-token',
  });
  t.after(() => outbox.close());
  const ownerA = outbox.claimNext({ ownerId: 'owner-a', leaseSeconds: 5 });
  now = 106;
  const reconcile = outbox.claimNext({ ownerId: 'owner-b', leaseSeconds: 5 });
  const rejected = {
    schemaVersion: 1,
    type: 'DeliveryReceipt',
    receiptId: 'receipt:send-epoch-aba:reconcile-rejected',
    intentId: intent.intentId,
    deliveryId: reconcile.deliveryId,
    requestId: run.requestId,
    attemptId: reconcile.attemptId,
    traceId: run.traceId,
    adapterId: 'feishu',
    outcome: 'rejected',
    externalRef: null,
    observedAt: '2026-09-01T00:03:00.000Z',
    errorCode: 'NOT_FOUND',
    retryable: true,
  };
  recordReceiptForClaim(outbox, reconcile, rejected);
  const ownerC = outbox.claimNext({ ownerId: 'owner-c', leaseSeconds: 5 });
  assert.equal(ownerC.action, 'send');
  assert.equal(ownerA.leaseToken, ownerC.leaseToken);
  assert.notEqual(ownerA.claimEpoch, ownerC.claimEpoch);
  const staleAccepted = {
    schemaVersion: 1,
    type: 'DeliveryReceipt',
    receiptId: 'receipt:send-epoch-aba:stale-accepted',
    intentId: intent.intentId,
    deliveryId: ownerA.deliveryId,
    requestId: run.requestId,
    attemptId: ownerA.attemptId,
    traceId: run.traceId,
    adapterId: 'feishu',
    outcome: 'platform_accepted',
    externalRef: 'opaque:stale-message',
    observedAt: '2026-09-01T00:04:00.000Z',
  };
  assert.throws(
    () => recordReceiptForClaim(outbox, ownerA, staleAccepted),
    error => error?.code === 'LEASE_FENCED',
  );
  const accepted = recordReceiptForClaim(outbox, ownerC, {
    ...staleAccepted,
    receiptId: 'receipt:send-epoch-aba:current-accepted',
    attemptId: ownerC.attemptId,
    externalRef: 'opaque:current-message',
  });
  assert.equal(accepted.delivery.state, 'accepted');
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
  const firstRejected = recordReceiptForClaim(
    outbox,
    first,
    rejectedReceipt(first, 'receipt:retry:1'),
  );
  assert.equal(firstRejected.delivery.state, 'retrying');
  assert.equal(firstRejected.settlement, null);

  const second = outbox.claimNext({ ownerId: 'adapter-b' });
  assert.equal(second.action, 'send');
  assert.notEqual(second.attemptId, first.attemptId);
  const exhausted = recordReceiptForClaim(
    outbox,
    second,
    rejectedReceipt(second, 'receipt:retry:2'),
  );
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
    () => recordReceiptForClaim(outbox, claim, accepted, { leaseToken: 'wrong-token' }),
    error => error?.code === 'LEASE_FENCED',
  );
  now = 110;
  assert.throws(
    () => recordReceiptForClaim(outbox, claim, accepted),
    error => error?.code === 'LEASE_EXPIRED',
  );

  const reconcile = outbox.claimNext({ ownerId: 'adapter-b', leaseSeconds: 10 });
  assert.equal(reconcile.action, 'reconcile');
  assert.notEqual(reconcile.leaseToken, claim.leaseToken);
  assert.throws(
    () => recordReceiptForClaim(outbox, claim, accepted),
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

  const first = recordReceiptForClaim(outbox, claim, receipt);
  const replay = recordReceiptForClaim(outbox, claim, receipt);
  assert.equal(first.replayed, false);
  assert.equal(replay.replayed, true);
  assert.equal(first.settlement.basis, 'platform_accepted');
  assert.deepEqual(replay.settlement, first.settlement);
  assert.equal(outbox.listReceipts(intent.intentId).length, 1);
  assert.equal(outbox.listSettlements(intent.intentId).length, 1);
  assert.throws(
    () => recordReceiptForClaim(
      outbox,
      claim,
      { ...receipt, externalRef: 'opaque:different-message' },
    ),
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
  recordReceiptForClaim(outbox, claim, {
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
