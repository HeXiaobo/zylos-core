import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import Database from 'better-sqlite3';

import { openRunLedger, RUNTIME_LANE_ID } from '../run-ledger.js';
import { openRuntimePendingQueue } from '../runtime-pending-queue.js';

function temporaryDatabase(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-run-lifecycle-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return path.join(directory, 'c4.db');
}

function command(id, lane = `lane:${id}`, priority = 2) {
  return {
    schemaVersion: 1,
    type: 'AcceptMessage',
    commandId: `command:${id}`,
    idempotencyKey: `idempotency:${id}`,
    traceId: `trace:${id}`,
    causationId: `cause:${id}`,
    issuedAt: '2026-09-01T00:00:00.000Z',
    source: {
      adapterId: 'test',
      accountRef: 'account',
      targetRef: `opaque:${id}`,
      conversationKey: lane,
      messageId: `message:${id}`,
      eventId: `event:${id}`,
      eventType: 'message',
      payloadHash: `sha256:${id.padStart(64, '0')}`,
    },
    actor: { provider: 'test', tenantRef: 'tenant', externalId: 'actor' },
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
    policy: { priority, requireIdle: false },
  };
}

function eventFor(run, type, causationId, payload, overrides = {}) {
  const suffix = {
    ProgressUpdated: 'progress:1',
    OutputDelta: 'delta:1',
    RunCompleted: 'completed',
    RunFailed: 'failed',
    RunCancelled: `cancelled:g${run.generation}`,
  }[type] ?? `${type}:${run.generation}`;
  return {
    type,
    requestId: run.requestId,
    turnId: run.turnId,
    generation: run.generation,
    traceId: run.traceId,
    causationId,
    producer: RUNTIME_LANE_ID,
    idempotencyKey: `run:${run.requestId}:${suffix}`,
    payload,
    ...overrides,
  };
}

function cancelCommand(run, id = 'cancel-1') {
  return {
    schemaVersion: 1,
    type: 'CancelRequest',
    commandId: id,
    idempotencyKey: `${id}:${run.requestId}:g${run.generation}`,
    requestId: run.requestId,
    turnId: run.turnId,
    generation: run.generation,
    traceId: run.traceId,
    causationId: `cause:${id}`,
    issuedAt: '2026-09-01T00:00:10.000Z',
    source: {
      adapterId: 'test',
      accountRef: 'account',
      eventType: 'message',
      eventId: `event:${id}`,
      messageId: `message:${id}`,
    },
    actor: {
      provider: 'test',
      tenantRef: 'tenant',
      externalId: 'actor',
      provenance: 'verified_channel_actor',
    },
    mode: 'cooperative',
    reason: 'user_requested',
  };
}

function claimAndStart(queue, options = {}) {
  const claim = queue.claimNext(options);
  assert.equal(claim.claimed, true);
  return queue.confirmStarted({
    admissionId: claim.admission.id,
    requestId: claim.request.requestId,
    turnId: claim.request.turnId,
    generation: claim.request.generation,
    runtimeSessionId: `runtime-session:${claim.request.requestId}:g${claim.request.generation}`,
  }).request;
}

test('events preserve complete fenced identity, monotonic sequence, and exactly one final terminal', (t) => {
  const dbPath = temporaryDatabase(t);
  const ledger = openRunLedger({ dbPath, clock: () => 100 });
  const queue = openRuntimePendingQueue({ dbPath, clock: () => 100 });
  t.after(() => ledger.close());
  t.after(() => queue.close());

  const accepted = ledger.accept(command('10')).request;
  const run = claimAndStart(queue);
  const started = ledger.listEvents(run.requestId).at(-1);
  const progress = ledger.appendEvent(eventFor(
    run,
    'ProgressUpdated',
    started.eventId,
    { stage: 'working' },
  ));
  assert.equal(progress.replayed, false);
  const terminalCommand = eventFor(
    run,
    'RunCompleted',
    progress.event.eventId,
    { outcomeId: `outcome:${run.requestId}` },
  );
  const completed = ledger.appendEvent(terminalCommand);
  const exactReplay = ledger.appendEvent(terminalCommand);
  const semanticReplay = ledger.appendEvent({
    ...terminalCommand,
    idempotencyKey: `${terminalCommand.idempotencyKey}:retry`,
  });

  assert.equal(completed.replayed, false);
  assert.equal(exactReplay.replayed, true);
  assert.equal(semanticReplay.replayed, true);
  assert.throws(
    () => ledger.appendEvent(eventFor(
      run,
      'RunFailed',
      progress.event.eventId,
      { outcomeId: `outcome:failure:${run.requestId}`, code: 'RUNTIME_FAILURE', retryable: true },
    )),
    error => error?.code === 'TERMINAL_CONFLICT',
  );
  assert.throws(
    () => ledger.appendEvent(eventFor(
      run,
      'ProgressUpdated',
      completed.event.eventId,
      { stage: 'late' },
      { idempotencyKey: `run:${run.requestId}:late-progress` },
    )),
    error => error?.code === 'RUN_TERMINAL',
  );
  assert.throws(
    () => ledger.appendEvent(eventFor(
      accepted,
      'RunCompleted',
      started.eventId,
      { outcomeId: 'outcome:invalid', text: 'must not be embedded' },
    )),
    error => ['INVALID_TERMINAL_PAYLOAD', 'NONCANONICAL_V1_SHAPE'].includes(error?.code),
  );

  const events = ledger.listEvents(run.requestId);
  assert.deepEqual(events.map(event => event.sequence), [1, 2, 3, 4, 5]);
  assert.equal(events.at(-1).type, 'RunCompleted');
  assert.equal(events.filter(event => event.type.startsWith('Run') && [
    'RunCompleted', 'RunFailed', 'RunCancelled',
  ].includes(event.type)).length, 1);
  for (const event of events) {
    assert.equal(event.requestId, run.requestId);
    assert.equal(event.turnId, run.turnId);
    assert.equal(event.generation, run.generation);
    assert.equal(event.traceId, run.traceId);
    assert.ok(event.eventId);
    assert.ok(event.causationId);
    assert.ok(event.producer);
  }
  assert.deepEqual(events.at(-1).payload, { outcomeId: `outcome:${run.requestId}` });

  const database = new Database(dbPath, { readonly: true });
  const outboundCount = database.prepare(`
    SELECT COUNT(*) AS count FROM conversations WHERE direction = 'out'
  `).get().count;
  const inbound = database.prepare(`
    SELECT status, delivery_action FROM conversations WHERE id = ?
  `).get(run.conversationId);
  database.close();
  assert.equal(outboundCount, 0);
  assert.deepEqual(inbound, { status: 'delivered', delivery_action: 'runtime-started' });
});

test('queued cancellation is idempotent, terminal, and produces no outcome reference', (t) => {
  const dbPath = temporaryDatabase(t);
  const ledger = openRunLedger({ dbPath });
  const queue = openRuntimePendingQueue({ dbPath });
  t.after(() => ledger.close());
  t.after(() => queue.close());

  const queued = ledger.accept(command('11', 'lane:cancel')).request;
  const next = ledger.accept(command('12', 'lane:cancel')).request;
  const cancellation = cancelCommand(queued);
  const first = ledger.cancel(cancellation);
  const replay = ledger.cancel(cancellation);

  assert.equal(first.status, 'cancelled');
  assert.equal(replay.replayed, true);
  assert.equal(ledger.get(queued.requestId).status, 'cancelled');
  const terminal = ledger.listEvents(queued.requestId).at(-1);
  assert.equal(terminal.type, 'RunCancelled');
  assert.equal(Object.hasOwn(terminal.payload, 'outcomeId'), false);
  assert.equal(queue.claimNext().request.requestId, next.requestId);
});

test('active cancellation retains the runtime owner until cooperative confirmation', (t) => {
  const dbPath = temporaryDatabase(t);
  const ledger = openRunLedger({ dbPath });
  const queue = openRuntimePendingQueue({ dbPath });
  t.after(() => ledger.close());
  t.after(() => queue.close());

  ledger.accept(command('13', 'lane:active'));
  const active = claimAndStart(queue);
  ledger.accept(command('14', 'lane:other'));
  assert.throws(
    () => ledger.appendEvent(eventFor(
      active,
      'RunCancelled',
      'implicit-cancel',
      { mode: 'active' },
    )),
    error => error?.code === 'INVALID_CANCEL_STATE',
  );
  assert.equal(queue.getActive().requestId, active.requestId);
  const requested = ledger.cancel(cancelCommand(active));

  assert.equal(requested.status, 'cancel_requested');
  assert.equal(ledger.get(active.requestId).status, 'cancel_requested');
  assert.equal(queue.getActive().requestId, active.requestId);
  assert.equal(queue.claimNext().reason, 'capacity_occupied');
  assert.equal(ledger.listEvents(active.requestId).at(-1).type, 'RunStarted');

  const confirmed = ledger.confirmCancellation({
    requestId: active.requestId,
    turnId: active.turnId,
    generation: active.generation,
    traceId: active.traceId,
    causationId: 'runtime-stop-confirmed',
    producer: RUNTIME_LANE_ID,
  });
  const confirmationReplay = ledger.confirmCancellation({
    requestId: active.requestId,
    turnId: active.turnId,
    generation: active.generation,
    traceId: active.traceId,
    causationId: 'runtime-stop-confirmed',
    producer: RUNTIME_LANE_ID,
  });
  assert.equal(confirmed.status, 'cancelled');
  assert.equal(confirmationReplay.replayed, true);
  assert.equal(queue.getActive(), null);
  assert.equal(ledger.listEvents(active.requestId).at(-1).type, 'RunCancelled');
  assert.equal(queue.claimNext().claimed, true);
});

test('explicit stale recovery advances generation, fences late events, and never creates two owners', (t) => {
  const dbPath = temporaryDatabase(t);
  let now = 100;
  const ledger = openRunLedger({ dbPath, clock: () => now });
  let queue = openRuntimePendingQueue({ dbPath, clock: () => now });
  t.after(() => ledger.close());
  t.after(() => queue.close());

  ledger.accept(command('15', 'lane:recovery', 2));
  const stale = claimAndStart(queue);
  const staleStarted = ledger.listEvents(stale.requestId).at(-1);
  const newer = ledger.accept(command('16', 'lane:newer', 1)).request;
  queue.close();

  now = 200;
  queue = openRuntimePendingQueue({ dbPath, clock: () => now });
  assert.equal(
    queue.claimNext().reason,
    'capacity_occupied',
    'ordinary dispatch must not implicitly recover stale work',
  );
  const recovered = queue.recoverStale({ staleBefore: 150 });
  assert.equal(recovered.recovered, true);
  assert.equal(recovered.request.requestId, stale.requestId);
  assert.equal(recovered.request.generation, stale.generation + 1);
  assert.notEqual(recovered.request.turnId, stale.turnId);
  assert.equal(queue.getActive(), null);

  const active = claimAndStart(queue);
  assert.equal(active.requestId, newer.requestId);
  assert.equal(queue.claimNext().reason, 'capacity_occupied');
  assert.throws(
    () => ledger.appendEvent(eventFor(
      stale,
      'OutputDelta',
      staleStarted.eventId,
      { deltaIndex: 1, text: 'late output from the old turn' },
    )),
    error => error?.code === 'RUN_EVENT_FENCED',
  );
  assert.deepEqual(ledger.listEvents(active.requestId).map(event => event.type), [
    'RunAccepted',
    'RunQueued',
    'RunStarted',
  ]);
  assert.equal(queue.getActive().requestId, active.requestId);
});
