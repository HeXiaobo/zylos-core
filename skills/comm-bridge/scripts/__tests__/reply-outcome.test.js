import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import Database from 'better-sqlite3';

import { openReplyOutcomeTransactions } from '../reply-outcome.js';
import { openRunLedger } from '../run-ledger.js';
import { openRuntimePendingQueue } from '../runtime-pending-queue.js';

function temporaryDatabase(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-reply-outcome-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return path.join(directory, 'c4.db');
}

function acceptMessage(id = 'answer', replyMode = 'required') {
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
      payloadHash: `sha256:${'a'.repeat(64)}`,
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
    reply: { mode: replyMode, targetRef: `opaque:${id}` },
    policy: { priority: 2, requireIdle: false },
  };
}

function startRun(ledger, queue, id = 'answer', replyMode = 'required') {
  const accepted = ledger.accept(acceptMessage(id, replyMode)).request;
  const claim = queue.claimNext();
  return queue.confirmStarted({
    admissionId: claim.admission.id,
    requestId: accepted.requestId,
    turnId: accepted.turnId,
    generation: accepted.generation,
    runtimeSessionId: `runtime:${id}`,
  }).request;
}

test('answer commits one canonical outcome, terminal and pending intent atomically', (t) => {
  const dbPath = temporaryDatabase(t);
  const ledger = openRunLedger({ dbPath, clock: () => 100 });
  const queue = openRuntimePendingQueue({ dbPath, clock: () => 100 });
  const replies = openReplyOutcomeTransactions({ dbPath, clock: () => 101 });
  t.after(() => ledger.close());
  t.after(() => queue.close());
  t.after(() => replies.close());
  const run = startRun(ledger, queue);

  const committed = replies.commitRunOutcome({
    requestId: run.requestId,
    turnId: run.turnId,
    generation: run.generation,
    traceId: run.traceId,
    causationId: ledger.listEvents(run.requestId).at(-1).eventId,
    producer: 'runtime:shared',
    idempotencyKey: `run:${run.requestId}:completed`,
    outcome: {
      kind: 'answer',
      content: { format: 'text', text: 'The decision is approved.' },
    },
    reply: {
      action: 'send',
      route: { adapterId: 'feishu', targetRef: 'opaque:answer' },
      disposition: 'send',
    },
  });

  assert.equal(committed.replayed, false);
  assert.equal(committed.outcome.type, 'ReplyOutcome');
  assert.equal(committed.outcome.outcomeId, `outcome:${run.requestId}`);
  assert.equal(committed.terminal.type, 'RunCompleted');
  assert.deepEqual(committed.terminal.payload, { outcomeId: committed.outcome.outcomeId });
  assert.equal(committed.intent.type, 'ReplyIntent');
  assert.equal(committed.intent.cause.eventId, committed.terminal.eventId);
  assert.match(committed.intent.intentId, new RegExp(`^reply:${run.requestId}:[a-f0-9]{64}$`));
  assert.equal(committed.intent.idempotencyKey, committed.intent.intentId);
  assert.match(committed.intent.contentHash, /^sha256:[a-f0-9]{64}$/);
  assert.equal(committed.delivery.state, 'pending');
  assert.equal(ledger.get(run.requestId).status, 'completed');
  assert.deepEqual(ledger.listEvents(run.requestId).map(event => event.type), [
    'RunAccepted',
    'RunQueued',
    'RunStarted',
    'RunCompleted',
  ]);
});

test('required reply policy rejects a missing delivery decision before any terminal write', (t) => {
  const dbPath = temporaryDatabase(t);
  const ledger = openRunLedger({ dbPath, clock: () => 100 });
  const queue = openRuntimePendingQueue({ dbPath, clock: () => 100 });
  const replies = openReplyOutcomeTransactions({ dbPath, clock: () => 101 });
  t.after(() => ledger.close());
  t.after(() => queue.close());
  t.after(() => replies.close());
  const run = startRun(ledger, queue, 'required-missing-reply');

  assert.throws(
    () => replies.commitRunOutcome({
      requestId: run.requestId,
      turnId: run.turnId,
      generation: run.generation,
      traceId: run.traceId,
      causationId: ledger.listEvents(run.requestId).at(-1).eventId,
      producer: 'runtime:shared',
      idempotencyKey: `run:${run.requestId}:completed`,
      outcome: { kind: 'answer', content: { format: 'text', text: 'Must be visible.' } },
    }),
    error => error?.code === 'REPLY_DECISION_REQUIRED',
  );

  assert.equal(ledger.get(run.requestId).status, 'active');
  assert.deepEqual(ledger.listEvents(run.requestId).map(event => event.type), [
    'RunAccepted',
    'RunQueued',
    'RunStarted',
  ]);
  const inspect = new Database(dbPath, { readonly: true });
  assert.deepEqual(inspect.prepare(`
    SELECT
      (SELECT COUNT(*) FROM assistant_reply_outcomes WHERE request_id = ?) AS outcomes,
      (SELECT COUNT(*) FROM assistant_reply_intents WHERE request_id = ?) AS intents
  `).get(run.requestId, run.requestId), { outcomes: 0, intents: 0 });
  inspect.close();
});

test('explicit silent completes execution without creating a ReplyIntent', (t) => {
  const dbPath = temporaryDatabase(t);
  const ledger = openRunLedger({ dbPath, clock: () => 100 });
  const queue = openRuntimePendingQueue({ dbPath, clock: () => 100 });
  const replies = openReplyOutcomeTransactions({ dbPath, clock: () => 101 });
  t.after(() => ledger.close());
  t.after(() => queue.close());
  t.after(() => replies.close());
  const run = startRun(ledger, queue, 'silent');

  const committed = replies.commitRunOutcome({
    requestId: run.requestId,
    turnId: run.turnId,
    generation: run.generation,
    traceId: run.traceId,
    causationId: ledger.listEvents(run.requestId).at(-1).eventId,
    producer: 'runtime:shared',
    idempotencyKey: `run:${run.requestId}:completed`,
    outcome: {
      kind: 'silent',
      explicit: true,
      reason: 'no_user_visible_reply_required',
    },
    reply: { action: 'suppress' },
  });

  assert.equal(committed.outcome.kind, 'silent');
  assert.equal(committed.terminal.type, 'RunCompleted');
  assert.equal(committed.intent, null);
  assert.equal(committed.delivery, null);
  assert.equal(ledger.get(run.requestId).status, 'completed');
});

test('durable optional and none policies require an explicit permitted decision', (t) => {
  const optionalDb = temporaryDatabase(t);
  const optionalLedger = openRunLedger({ dbPath: optionalDb, clock: () => 100 });
  const optionalQueue = openRuntimePendingQueue({ dbPath: optionalDb, clock: () => 100 });
  const optionalReplies = openReplyOutcomeTransactions({ dbPath: optionalDb, clock: () => 101 });
  t.after(() => optionalLedger.close());
  t.after(() => optionalQueue.close());
  t.after(() => optionalReplies.close());
  const optionalRun = startRun(optionalLedger, optionalQueue, 'optional', 'optional');
  assert.deepEqual(optionalLedger.get(optionalRun.requestId).replyPolicy, {
    mode: 'optional',
    route: { adapterId: 'feishu', targetRef: 'opaque:optional' },
  });
  const optionalCommitted = optionalReplies.commitRunOutcome({
    requestId: optionalRun.requestId,
    turnId: optionalRun.turnId,
    generation: optionalRun.generation,
    traceId: optionalRun.traceId,
    causationId: optionalLedger.listEvents(optionalRun.requestId).at(-1).eventId,
    producer: 'runtime:shared',
    idempotencyKey: `run:${optionalRun.requestId}:completed`,
    outcome: { kind: 'answer', content: { format: 'text', text: 'Optional visible answer.' } },
    reply: { action: 'send', disposition: 'send' },
  });
  assert.equal(optionalCommitted.intent.route.targetRef, 'opaque:optional');

  const noneDb = temporaryDatabase(t);
  const noneLedger = openRunLedger({ dbPath: noneDb, clock: () => 100 });
  const noneQueue = openRuntimePendingQueue({ dbPath: noneDb, clock: () => 100 });
  const noneReplies = openReplyOutcomeTransactions({ dbPath: noneDb, clock: () => 101 });
  t.after(() => noneLedger.close());
  t.after(() => noneQueue.close());
  t.after(() => noneReplies.close());
  const noneRun = startRun(noneLedger, noneQueue, 'none', 'none');
  const noneBase = {
    requestId: noneRun.requestId,
    turnId: noneRun.turnId,
    generation: noneRun.generation,
    traceId: noneRun.traceId,
    causationId: noneLedger.listEvents(noneRun.requestId).at(-1).eventId,
    producer: 'runtime:shared',
    idempotencyKey: `run:${noneRun.requestId}:completed`,
  };
  assert.throws(
    () => noneReplies.commitRunOutcome({
      ...noneBase,
      outcome: { kind: 'answer', content: { format: 'text', text: 'Forbidden answer.' } },
      reply: { action: 'send', disposition: 'send' },
    }),
    error => error?.code === 'REPLY_POLICY_VIOLATION',
  );
  assert.equal(noneLedger.get(noneRun.requestId).status, 'active');
  const noneCommitted = noneReplies.commitRunOutcome({
    ...noneBase,
    outcome: { kind: 'silent', explicit: true, reason: 'reply_policy_none' },
    reply: { action: 'suppress' },
  });
  assert.equal(noneCommitted.intent, null);
  assert.equal(noneLedger.get(noneRun.requestId).status, 'completed');
});

test('stored reply route fences visible Outcome callers', (t) => {
  const dbPath = temporaryDatabase(t);
  const ledger = openRunLedger({ dbPath, clock: () => 100 });
  const queue = openRuntimePendingQueue({ dbPath, clock: () => 100 });
  const replies = openReplyOutcomeTransactions({ dbPath, clock: () => 101 });
  t.after(() => ledger.close());
  t.after(() => queue.close());
  t.after(() => replies.close());
  const run = startRun(ledger, queue, 'route-fence');

  assert.throws(
    () => replies.commitRunOutcome({
      requestId: run.requestId,
      turnId: run.turnId,
      generation: run.generation,
      traceId: run.traceId,
      causationId: ledger.listEvents(run.requestId).at(-1).eventId,
      producer: 'runtime:shared',
      idempotencyKey: `run:${run.requestId}:completed`,
      outcome: { kind: 'answer', content: { format: 'text', text: 'Wrong route.' } },
      reply: {
        action: 'send',
        route: { adapterId: 'feishu', targetRef: 'opaque:another-target' },
        disposition: 'send',
      },
    }),
    error => error?.code === 'REPLY_ROUTE_MISMATCH',
  );
  assert.equal(ledger.get(run.requestId).status, 'active');
});

test('failure writes RunFailed and a failure_notice intent without changing delivery to accepted', (t) => {
  const dbPath = temporaryDatabase(t);
  const ledger = openRunLedger({ dbPath, clock: () => 100 });
  const queue = openRuntimePendingQueue({ dbPath, clock: () => 100 });
  const replies = openReplyOutcomeTransactions({ dbPath, clock: () => 101 });
  t.after(() => ledger.close());
  t.after(() => queue.close());
  t.after(() => replies.close());
  const run = startRun(ledger, queue, 'failure');

  const committed = replies.commitRunOutcome({
    requestId: run.requestId,
    turnId: run.turnId,
    generation: run.generation,
    traceId: run.traceId,
    causationId: ledger.listEvents(run.requestId).at(-1).eventId,
    producer: 'runtime:shared',
    idempotencyKey: `run:${run.requestId}:failed`,
    outcome: { kind: 'failure', code: 'RUNTIME_FAILURE', retryable: true },
    reply: {
      action: 'send',
      route: { adapterId: 'feishu', targetRef: 'opaque:failure' },
      disposition: 'failure_notice',
      payload: { format: 'text', text: 'The assistant could not complete this request.' },
    },
  });

  assert.equal(committed.terminal.type, 'RunFailed');
  assert.deepEqual(committed.terminal.payload, {
    outcomeId: committed.outcome.outcomeId,
    code: 'RUNTIME_FAILURE',
    retryable: true,
  });
  assert.equal(committed.intent.disposition, 'failure_notice');
  assert.equal(committed.delivery.state, 'pending');
  assert.equal(ledger.get(run.requestId).status, 'failed');
});

test('empty answers, implicit silence and media without a durable content reference fail closed', (t) => {
  const dbPath = temporaryDatabase(t);
  const ledger = openRunLedger({ dbPath, clock: () => 100 });
  const queue = openRuntimePendingQueue({ dbPath, clock: () => 100 });
  const replies = openReplyOutcomeTransactions({ dbPath, clock: () => 101 });
  t.after(() => ledger.close());
  t.after(() => queue.close());
  t.after(() => replies.close());
  const run = startRun(ledger, queue, 'invalid-output');
  const base = {
    requestId: run.requestId,
    turnId: run.turnId,
    generation: run.generation,
    traceId: run.traceId,
    causationId: ledger.listEvents(run.requestId).at(-1).eventId,
    producer: 'runtime:shared',
    idempotencyKey: `run:${run.requestId}:completed`,
  };

  for (const outcome of [
    { kind: 'answer', content: { format: 'text', text: '' } },
    { kind: 'answer', content: { format: 'text', text: '   ' } },
    { kind: 'answer', content: { format: 'media' } },
  ]) {
    assert.throws(
      () => replies.commitRunOutcome({ ...base, outcome }),
      error => error?.code === 'MISSING_OUTPUT' || error instanceof TypeError,
    );
  }
  assert.throws(
    () => replies.commitRunOutcome({
      ...base,
      outcome: { kind: 'silent', reason: 'implicit-is-not-valid' },
    }),
    error => error?.code === 'SILENT_NOT_EXPLICIT',
  );
  assert.equal(ledger.get(run.requestId).status, 'active');
  assert.equal(ledger.listEvents(run.requestId).length, 3);
});

test('outcome, terminal and intent replay safely as one identity and conflict on any payload change', (t) => {
  const dbPath = temporaryDatabase(t);
  const ledger = openRunLedger({ dbPath, clock: () => 100 });
  const queue = openRuntimePendingQueue({ dbPath, clock: () => 100 });
  const replies = openReplyOutcomeTransactions({ dbPath, clock: () => 101 });
  t.after(() => ledger.close());
  t.after(() => queue.close());
  t.after(() => replies.close());
  const run = startRun(ledger, queue, 'replay');
  const command = {
    requestId: run.requestId,
    turnId: run.turnId,
    generation: run.generation,
    traceId: run.traceId,
    causationId: ledger.listEvents(run.requestId).at(-1).eventId,
    producer: 'runtime:shared',
    idempotencyKey: `run:${run.requestId}:completed`,
    outcome: { kind: 'answer', content: { format: 'text', text: 'Stable answer.' } },
    reply: {
      action: 'send',
      route: { adapterId: 'feishu', targetRef: 'opaque:replay' },
      disposition: 'send',
    },
  };

  const first = replies.commitRunOutcome(command);
  const replay = replies.commitRunOutcome(command);
  assert.equal(replay.replayed, true);
  assert.deepEqual(replay.outcome, first.outcome);
  assert.deepEqual(replay.terminal, first.terminal);
  assert.deepEqual(replay.intent, first.intent);
  assert.equal(ledger.listEvents(run.requestId).length, 4);

  assert.throws(
    () => replies.commitRunOutcome({
      ...command,
      outcome: { kind: 'answer', content: { format: 'text', text: 'Changed answer.' } },
    }),
    error => error?.code === 'IDEMPOTENCY_CONFLICT',
  );
  assert.throws(
    () => replies.commitRunOutcome({
      ...command,
      reply: { ...command.reply, route: { ...command.reply.route, targetRef: 'opaque:other' } },
    }),
    error => error?.code === 'REPLY_ROUTE_MISMATCH',
  );
  assert.throws(
    () => replies.commitRunOutcome({ ...command, causationId: 'evt:changed-cause' }),
    error => error?.code === 'IDEMPOTENCY_CONFLICT',
  );
  assert.throws(
    () => replies.commitRunOutcome({ ...command, producer: 'runtime:changed' }),
    error => error?.code === 'IDEMPOTENCY_CONFLICT',
  );
});

test('a storage failure after outcome and terminal inserts rolls the whole transaction back', (t) => {
  const dbPath = temporaryDatabase(t);
  const ledger = openRunLedger({ dbPath, clock: () => 100 });
  const queue = openRuntimePendingQueue({ dbPath, clock: () => 100 });
  const replies = openReplyOutcomeTransactions({ dbPath, clock: () => 101 });
  t.after(() => ledger.close());
  t.after(() => queue.close());
  t.after(() => replies.close());
  const run = startRun(ledger, queue, 'rollback');
  const fault = new Database(dbPath);
  fault.exec(`
    CREATE TRIGGER fail_reply_intent_insert
    BEFORE INSERT ON assistant_reply_intents
    BEGIN
      SELECT RAISE(ABORT, 'injected intent storage failure');
    END;
  `);
  fault.close();

  assert.throws(() => replies.commitRunOutcome({
    requestId: run.requestId,
    turnId: run.turnId,
    generation: run.generation,
    traceId: run.traceId,
    causationId: ledger.listEvents(run.requestId).at(-1).eventId,
    producer: 'runtime:shared',
    idempotencyKey: `run:${run.requestId}:completed`,
    outcome: { kind: 'answer', content: { format: 'text', text: 'Must roll back.' } },
    reply: {
      action: 'send',
      route: { adapterId: 'feishu', targetRef: 'opaque:rollback' },
      disposition: 'send',
    },
  }), /injected intent storage failure/);

  assert.equal(ledger.get(run.requestId).status, 'active');
  assert.deepEqual(ledger.listEvents(run.requestId).map(event => event.type), [
    'RunAccepted',
    'RunQueued',
    'RunStarted',
  ]);
  const inspect = new Database(dbPath, { readonly: true });
  assert.equal(inspect.prepare(`
    SELECT COUNT(*) AS count FROM assistant_reply_outcomes WHERE request_id = ?
  `).get(run.requestId).count, 0);
  assert.equal(inspect.prepare(`
    SELECT COUNT(*) AS count FROM assistant_reply_intents WHERE request_id = ?
  `).get(run.requestId).count, 0);
  inspect.close();
});

test('task_receipt accepts only a task_effect cause and replays by canonical identity', (t) => {
  const dbPath = temporaryDatabase(t);
  const ledger = openRunLedger({ dbPath, clock: () => 100 });
  let taskEffect = null;
  const replies = openReplyOutcomeTransactions({
    dbPath,
    clock: () => 101,
    taskEffectVerifier: () => taskEffect,
  });
  t.after(() => ledger.close());
  t.after(() => replies.close());
  const run = ledger.accept(acceptMessage('task-receipt')).request;
  const command = {
    requestId: run.requestId,
    traceId: run.traceId,
    cause: { kind: 'task_effect', eventId: 'task-effect-applied-001' },
    route: { adapterId: 'feishu', targetRef: 'opaque:task-receipt' },
    disposition: 'task_receipt',
    payload: { format: 'text', text: 'Task created.' },
  };

  const unverifiedReplies = openReplyOutcomeTransactions({ dbPath, clock: () => 101 });
  assert.throws(
    () => unverifiedReplies.commitTaskReceipt(command),
    error => error?.code === 'TASK_EFFECT_VERIFICATION_REQUIRED',
  );
  unverifiedReplies.close();
  assert.throws(
    () => replies.commitTaskReceipt(command),
    error => error?.code === 'TASK_EFFECT_NOT_VERIFIED',
  );
  taskEffect = {
    canonical: true,
    applied: false,
    eventId: command.cause.eventId,
    requestId: command.requestId,
    traceId: command.traceId,
  };
  assert.throws(
    () => replies.commitTaskReceipt(command),
    error => error?.code === 'TASK_EFFECT_NOT_VERIFIED',
  );
  taskEffect = { ...taskEffect, applied: true, requestId: 'request:wrong' };
  assert.throws(
    () => replies.commitTaskReceipt(command),
    error => error?.code === 'TASK_EFFECT_NOT_VERIFIED',
  );
  taskEffect = { ...taskEffect, requestId: command.requestId, traceId: 'trace:wrong' };
  assert.throws(
    () => replies.commitTaskReceipt(command),
    error => error?.code === 'TASK_EFFECT_NOT_VERIFIED',
  );
  taskEffect = { ...taskEffect, traceId: command.traceId, canonical: false };
  assert.throws(
    () => replies.commitTaskReceipt(command),
    error => error?.code === 'TASK_EFFECT_NOT_VERIFIED',
  );
  taskEffect = { ...taskEffect, canonical: true };
  const first = replies.commitTaskReceipt(command);
  const replay = replies.commitTaskReceipt(command);
  assert.equal(first.replayed, false);
  assert.equal(replay.replayed, true);
  assert.deepEqual(replay.intent, first.intent);
  assert.equal(first.intent.cause.kind, 'task_effect');
  assert.match(first.intent.intentId, /^reply:task-effect-applied-001:[a-f0-9]{64}$/);
  assert.equal(first.delivery.state, 'pending');
  assert.equal(ledger.get(run.requestId).status, 'queued');

  assert.throws(
    () => replies.commitTaskReceipt({
      ...command,
      cause: { kind: 'run_terminal', eventId: 'evt:wrong' },
    }),
    error => error?.code === 'INVALID_REPLY_CAUSE',
  );
  assert.throws(
    () => replies.commitTaskReceipt({
      ...command,
      payload: { format: 'text', text: 'Changed receipt.' },
    }),
    error => error?.code === 'IDEMPOTENCY_CONFLICT',
  );
});

test('stale generation is fenced and RunCancelled never gains an Outcome or Intent', (t) => {
  const dbPath = temporaryDatabase(t);
  const ledger = openRunLedger({ dbPath, clock: () => 100 });
  const queue = openRuntimePendingQueue({ dbPath, clock: () => 100 });
  const replies = openReplyOutcomeTransactions({ dbPath, clock: () => 101 });
  t.after(() => ledger.close());
  t.after(() => queue.close());
  t.after(() => replies.close());
  const cancelled = ledger.accept(acceptMessage('cancelled')).request;
  ledger.cancel({
    schemaVersion: 1,
    type: 'CancelRequest',
    commandId: 'cancel:cancelled',
    idempotencyKey: `cancel:${cancelled.requestId}:g${cancelled.generation}`,
    requestId: cancelled.requestId,
    turnId: cancelled.turnId,
    generation: cancelled.generation,
    traceId: cancelled.traceId,
    causationId: 'cancel-event',
    issuedAt: '2026-09-01T00:00:10.000Z',
    source: {
      adapterId: 'feishu',
      accountRef: 'account-1',
      eventType: 'message',
      eventId: 'cancel-event',
      messageId: 'cancel-message',
    },
    actor: {
      provider: 'feishu',
      tenantRef: 'tenant-1',
      externalId: 'user-1',
      provenance: 'verified_channel_actor',
    },
    mode: 'cooperative',
    reason: 'user_requested',
  });
  const terminal = ledger.listEvents(cancelled.requestId).at(-1);
  assert.equal(terminal.type, 'RunCancelled');
  assert.throws(
    () => replies.commitRunOutcome({
      requestId: cancelled.requestId,
      turnId: cancelled.turnId,
      generation: cancelled.generation + 1,
      traceId: cancelled.traceId,
      causationId: terminal.eventId,
      producer: 'runtime:shared',
      idempotencyKey: `run:${cancelled.requestId}:completed`,
      outcome: { kind: 'answer', content: { format: 'text', text: 'late answer' } },
      reply: {
        action: 'send',
        route: { adapterId: 'feishu', targetRef: 'opaque:cancelled' },
        disposition: 'send',
      },
    }),
    error => error?.code === 'RUN_EVENT_FENCED',
  );
  const inspect = new Database(dbPath, { readonly: true });
  assert.equal(inspect.prepare(`
    SELECT COUNT(*) AS count FROM assistant_reply_outcomes WHERE request_id = ?
  `).get(cancelled.requestId).count, 0);
  assert.equal(inspect.prepare(`
    SELECT COUNT(*) AS count FROM assistant_reply_intents WHERE request_id = ?
  `).get(cancelled.requestId).count, 0);
  inspect.close();
});
