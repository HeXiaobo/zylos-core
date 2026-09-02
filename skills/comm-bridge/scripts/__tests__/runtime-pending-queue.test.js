import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import Database from 'better-sqlite3';

import { openAssistantResponseStream } from '../assistant-response-stream.js';
import { openRunLedger, RUNTIME_LANE_CAPACITY, RUNTIME_LANE_ID } from '../run-ledger.js';
import { openRuntimePendingQueue } from '../runtime-pending-queue.js';

function temporaryDatabase(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-runtime-queue-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return path.join(directory, 'c4.db');
}

function command(id, lane, priority = 2, overrides = {}) {
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
    ...overrides,
  };
}

function complete(ledger, run) {
  const events = ledger.listEvents(run.requestId);
  return ledger.appendEvent({
    type: 'RunCompleted',
    requestId: run.requestId,
    turnId: run.turnId,
    generation: run.generation,
    traceId: run.traceId,
    causationId: events.at(-1).eventId,
    producer: RUNTIME_LANE_ID,
    idempotencyKey: `run:${run.requestId}:completed`,
    payload: { outcomeId: `outcome:${run.requestId}` },
  });
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

test('claim reserves submitted capacity and only confirmed runtime binding starts the run', (t) => {
  const dbPath = temporaryDatabase(t);
  const ledger = openRunLedger({ dbPath, clock: () => 100 });
  const queue = openRuntimePendingQueue({ dbPath, clock: () => 100 });
  t.after(() => ledger.close());
  t.after(() => queue.close());

  const accepted = ledger.accept(command('30', 'lane:two-phase')).request;
  const claim = queue.claimNext();

  assert.equal(claim.claimed, true);
  assert.equal(claim.admission.status, 'submitted');
  assert.equal(claim.admission.runtimeSessionId, null);
  assert.equal(claim.request.status, 'queued');
  assert.equal(ledger.get(accepted.requestId).status, 'queued');
  assert.deepEqual(ledger.listEvents(accepted.requestId).map(event => event.type), [
    'RunAccepted',
    'RunQueued',
  ]);
  const claimedDatabase = new Database(dbPath, { readonly: true });
  assert.deepEqual(claimedDatabase.prepare(`
    SELECT status, runtime_session_id AS runtimeSessionId
    FROM assistant_requests
    WHERE request_id = ?
  `).get(accepted.requestId), { status: 'queued', runtimeSessionId: null });
  assert.notEqual(claimedDatabase.prepare(`
    SELECT delivery_action AS deliveryAction
    FROM conversations
    WHERE id = ?
  `).get(accepted.conversationId).deliveryAction, 'runtime-started');
  claimedDatabase.close();
  assert.deepEqual(queue.claimNext(), {
    claimed: false,
    reason: 'capacity_occupied',
    admission: claim.admission,
    request: null,
  });

  const started = queue.confirmStarted({
    admissionId: claim.admission.id,
    requestId: accepted.requestId,
    turnId: accepted.turnId,
    generation: accepted.generation,
    runtimeSessionId: 'runtime-session-two-phase',
  });
  assert.equal(started.started, true);
  assert.equal(started.replayed, false);
  assert.equal(started.admission.status, 'started');
  assert.equal(started.admission.runtimeSessionId, 'runtime-session-two-phase');
  assert.equal(started.request.status, 'active');
  assert.deepEqual(ledger.listEvents(accepted.requestId).map(event => event.type), [
    'RunAccepted',
    'RunQueued',
    'RunStarted',
  ]);

  const replay = queue.confirmStarted({
    admissionId: claim.admission.id,
    requestId: accepted.requestId,
    turnId: accepted.turnId,
    generation: accepted.generation,
    runtimeSessionId: 'runtime-session-two-phase',
  });
  assert.equal(replay.started, true);
  assert.equal(replay.replayed, true);
  assert.equal(ledger.listEvents(accepted.requestId).length, 3);
  assert.throws(
    () => queue.confirmStarted({
      admissionId: claim.admission.id,
      requestId: accepted.requestId,
      turnId: accepted.turnId,
      generation: accepted.generation,
      runtimeSessionId: 'runtime-session-conflict',
    }),
    error => error?.code === 'RUNTIME_SESSION_CONFLICT',
  );
  assert.throws(
    () => queue.confirmStarted({
      admissionId: claim.admission.id,
      requestId: accepted.requestId,
      turnId: `${accepted.turnId}:stale`,
      generation: accepted.generation,
      runtimeSessionId: 'runtime-session-two-phase',
    }),
    error => error?.code === 'RUN_EVENT_FENCED',
  );
  assert.throws(
    () => queue.confirmStarted({
      admissionId: claim.admission.id,
      requestId: accepted.requestId,
      turnId: accepted.turnId,
      generation: accepted.generation + 1,
      runtimeSessionId: 'runtime-session-two-phase',
    }),
    error => error?.code === 'RUN_EVENT_FENCED',
  );
  assert.throws(
    () => queue.confirmStarted({
      admissionId: claim.admission.id + 1,
      requestId: accepted.requestId,
      turnId: accepted.turnId,
      generation: accepted.generation,
      runtimeSessionId: 'runtime-session-two-phase',
    }),
    error => error?.code === 'RUNTIME_ADMISSION_NOT_FOUND',
  );
});

test('failed submit releases its reservation and stale unconfirmed submit advances the fence without starting', (t) => {
  const dbPath = temporaryDatabase(t);
  let now = 100;
  const ledger = openRunLedger({ dbPath, clock: () => now });
  const queue = openRuntimePendingQueue({ dbPath, clock: () => now });
  t.after(() => ledger.close());
  t.after(() => queue.close());

  const accepted = ledger.accept(command('31', 'lane:release')).request;
  const firstClaim = queue.claimNext();
  assert.equal(firstClaim.claimed, true);
  const releaseInput = {
    admissionId: firstClaim.admission.id,
    requestId: accepted.requestId,
    turnId: accepted.turnId,
    generation: accepted.generation,
    reason: 'runtime_submit_failed',
  };
  const released = queue.releaseSubmitted(releaseInput);
  const replay = queue.releaseSubmitted(releaseInput);

  assert.equal(released.released, true);
  assert.equal(released.replayed, false);
  assert.equal(replay.replayed, true);
  assert.equal(queue.getActive(), null);
  assert.equal(ledger.get(accepted.requestId).status, 'queued');
  assert.equal(
    ledger.listEvents(accepted.requestId).some(event => event.type === 'RunStarted'),
    false,
  );

  const crashClaim = queue.claimNext();
  assert.equal(crashClaim.claimed, true);
  assert.equal(crashClaim.admission.status, 'submitted');
  now = 200;
  const recovered = queue.recoverStale({ staleBefore: 150 });
  assert.equal(recovered.recovered, true);
  assert.equal(recovered.reason, 'unconfirmed_submission_fenced');
  assert.equal(recovered.admission.status, 'released');
  assert.equal(recovered.request.status, 'queued');
  assert.equal(recovered.request.generation, accepted.generation + 1);
  assert.notEqual(recovered.request.turnId, accepted.turnId);
  assert.equal(queue.getActive(), null);
  assert.deepEqual(ledger.listEvents(accepted.requestId).map(event => event.type), [
    'RunAccepted',
    'RunQueued',
    'RunQueued',
  ]);
  assert.throws(
    () => queue.confirmStarted({
      admissionId: crashClaim.admission.id,
      requestId: accepted.requestId,
      turnId: accepted.turnId,
      generation: accepted.generation,
      runtimeSessionId: 'late-runtime-session',
    }),
    error => error?.code === 'RUN_EVENT_FENCED',
  );
  assert.equal(queue.claimNext().claimed, true);
});

test('released admission attempts cannot start or release a later claim with the same run fence', (t) => {
  const dbPath = temporaryDatabase(t);
  const ledger = openRunLedger({ dbPath, clock: () => 100 });
  const queue = openRuntimePendingQueue({ dbPath, clock: () => 100 });
  t.after(() => ledger.close());
  t.after(() => queue.close());

  const accepted = ledger.accept(command('33', 'lane:attempt-fence')).request;
  const first = queue.claimNext();
  const firstRelease = {
    admissionId: first.admission.id,
    requestId: accepted.requestId,
    turnId: accepted.turnId,
    generation: accepted.generation,
    reason: 'first_submit_failed',
  };
  assert.equal(queue.releaseSubmitted(firstRelease).replayed, false);

  const second = queue.claimNext();
  assert.equal(second.claimed, true);
  assert.notEqual(second.admission.id, first.admission.id);
  const lateFirstConfirm = {
    admissionId: first.admission.id,
    requestId: accepted.requestId,
    turnId: accepted.turnId,
    generation: accepted.generation,
    runtimeSessionId: 'runtime-session:first-attempt',
  };
  assert.throws(
    () => queue.confirmStarted(lateFirstConfirm),
    error => error?.code === 'INVALID_RUNTIME_ADMISSION_STATE',
  );
  assert.equal(queue.getActive().id, second.admission.id);
  assert.equal(queue.getActive().status, 'submitted');

  const lateReleaseReplay = queue.releaseSubmitted(firstRelease);
  assert.equal(lateReleaseReplay.released, true);
  assert.equal(lateReleaseReplay.replayed, true);
  assert.equal(lateReleaseReplay.admission.id, first.admission.id);
  assert.equal(lateReleaseReplay.admission.status, 'released');
  assert.equal(queue.getActive().id, second.admission.id);
  assert.equal(queue.getActive().status, 'submitted');

  const secondConfirm = {
    admissionId: second.admission.id,
    requestId: accepted.requestId,
    turnId: accepted.turnId,
    generation: accepted.generation,
    runtimeSessionId: 'runtime-session:second-attempt',
  };
  const started = queue.confirmStarted(secondConfirm);
  assert.equal(started.started, true);
  assert.equal(started.replayed, false);
  assert.equal(started.admission.id, second.admission.id);
  complete(ledger, started.request);

  const terminalReplay = queue.confirmStarted(secondConfirm);
  assert.equal(terminalReplay.started, true);
  assert.equal(terminalReplay.replayed, true);
  assert.equal(terminalReplay.admission.id, second.admission.id);
  assert.equal(terminalReplay.admission.status, 'completed');
  assert.equal(terminalReplay.request.status, 'completed');
  assert.equal(ledger.listEvents(accepted.requestId).filter(
    event => event.type === 'RunStarted',
  ).length, 1);
});

test('legacy submitted and started admissions occupy capacity and remain owned by the legacy recovery path', (t) => {
  const dbPath = temporaryDatabase(t);
  const stream = openAssistantResponseStream({
    dbPath,
    clock: () => 50,
    observationClock: () => 50_000,
  });
  const legacy = stream.execute({
    type: 'AcceptAssistantRequest',
    requestId: 'assistant.legacy.capacity-owner',
    sourceId: 'legacy-capacity-owner',
    route: { channel: 'legacy', endpointId: 'opaque:legacy-capacity-owner' },
    conversation: {
      content: 'legacy capacity owner',
      status: 'pending',
      priority: 2,
      requireIdle: false,
    },
  });
  const ledger = openRunLedger({ dbPath, clock: () => 100 });
  const queue = openRuntimePendingQueue({ dbPath, clock: () => 100 });
  t.after(() => stream.close());
  t.after(() => ledger.close());
  t.after(() => queue.close());

  const pending = ledger.accept(command('32', 'lane:new-ledger')).request;
  const submitted = stream.acquireRuntimeTurn({
    conversationId: legacy.request.conversationId,
    requestId: legacy.request.requestId,
    routeChannel: 'legacy',
  });
  assert.equal(submitted.admission.status, 'submitted');

  const submittedBlocked = queue.claimNext();
  assert.equal(submittedBlocked.claimed, false);
  assert.equal(submittedBlocked.reason, 'capacity_occupied');
  assert.equal(submittedBlocked.admission.legacy, true);
  assert.equal(submittedBlocked.admission.runtimeLaneId, null);
  const submittedRecovery = queue.recoverStale({ staleBefore: 75 });
  assert.equal(submittedRecovery.recovered, false);
  assert.equal(
    submittedRecovery.reason,
    'legacy_admission_owned_by_assistant_response_stream',
  );
  assert.equal(stream.getActiveRuntimeTurn().status, 'submitted');

  assert.equal(stream.releaseRuntimeTurn({
    conversationId: legacy.request.conversationId,
    reason: 'legacy_submit_failed',
  }).released, true);
  const reacquired = stream.acquireRuntimeTurn({
    conversationId: legacy.request.conversationId,
    requestId: legacy.request.requestId,
    routeChannel: 'legacy',
  });
  assert.equal(reacquired.acquired, true);
  assert.equal(stream.startRuntimeTurn({
    runtimeSessionId: 'legacy-runtime-session',
  }).started, true);

  const startedBlocked = queue.claimNext();
  assert.equal(startedBlocked.claimed, false);
  assert.equal(startedBlocked.reason, 'capacity_occupied');
  assert.equal(startedBlocked.admission.status, 'started');
  assert.equal(startedBlocked.admission.legacy, true);
  const startedRecovery = queue.recoverStale({ staleBefore: 75 });
  assert.equal(startedRecovery.recovered, false);
  assert.equal(
    startedRecovery.reason,
    'legacy_admission_owned_by_assistant_response_stream',
  );
  assert.equal(stream.getActiveRuntimeTurn().status, 'started');

  assert.equal(stream.finishRuntimeTurn({
    runtimeSessionId: 'legacy-runtime-session',
    reason: 'stop',
  }).finished, true);
  const claim = queue.claimNext();
  assert.equal(claim.claimed, true);
  assert.equal(claim.request.requestId, pending.requestId);

  const database = new Database(dbPath, { readonly: true });
  t.after(() => database.close());
  assert.equal(database.prepare(`
    SELECT COUNT(*) AS count
    FROM assistant_run_ledger
    WHERE request_id = 'assistant.legacy.capacity-owner'
  `).get().count, 0);
});

test('the shared runtime schedules lane heads by priority then acceptance FIFO', (t) => {
  const dbPath = temporaryDatabase(t);
  const ledger = openRunLedger({ dbPath });
  const queue = openRuntimePendingQueue({ dbPath });
  t.after(() => ledger.close());
  t.after(() => queue.close());

  const laneAFirst = ledger.accept(command('1', 'lane:a', 3)).request;
  const laneALaterHighPriority = ledger.accept(command('2', 'lane:a', 1)).request;
  const laneB = ledger.accept(command('3', 'lane:b', 2)).request;

  const firstClaim = claimAndStart(queue, { runtimeIdle: false });
  assert.equal(firstClaim.requestId, laneB.requestId);
  assert.equal(firstClaim.runtimeLaneId, RUNTIME_LANE_ID);
  assert.equal(RUNTIME_LANE_CAPACITY, 1);
  assert.equal(queue.claimNext({ runtimeIdle: true }).reason, 'capacity_occupied');

  complete(ledger, firstClaim);
  const secondClaim = claimAndStart(queue, { runtimeIdle: false });
  assert.equal(secondClaim.requestId, laneAFirst.requestId);
  complete(ledger, secondClaim);
  const thirdClaim = claimAndStart(queue, { runtimeIdle: false });
  assert.equal(thirdClaim.requestId, laneALaterHighPriority.requestId);
});

test('equal-priority lane heads retain global acceptance FIFO', (t) => {
  const dbPath = temporaryDatabase(t);
  const ledger = openRunLedger({ dbPath });
  const queue = openRuntimePendingQueue({ dbPath });
  t.after(() => ledger.close());
  t.after(() => queue.close());

  const first = ledger.accept(command('20', 'lane:first', 2)).request;
  const second = ledger.accept(command('21', 'lane:second', 2)).request;
  const firstClaim = claimAndStart(queue);
  assert.equal(firstClaim.requestId, first.requestId);
  complete(ledger, firstClaim);
  assert.equal(claimAndStart(queue).requestId, second.requestId);
});

test('ordinary work does not require runtime idle while explicit maintenance still does', (t) => {
  const dbPath = temporaryDatabase(t);
  const ledger = openRunLedger({ dbPath });
  const queue = openRuntimePendingQueue({ dbPath });
  t.after(() => ledger.close());
  t.after(() => queue.close());

  const ordinary = ledger.accept(command('4', 'lane:ordinary')).request;
  const maintenance = ledger.accept(command('5', 'lane:maintenance', 1, {
    requestClass: 'maintenance',
    policy: { priority: 1, requireIdle: true },
  })).request;
  assert.equal(ordinary.requireIdle, false);
  assert.equal(maintenance.requireIdle, true);

  const ordinaryClaim = claimAndStart(queue, { runtimeIdle: false });
  assert.equal(ordinaryClaim.requestId, ordinary.requestId);
  complete(ledger, ordinaryClaim);
  assert.equal(queue.claimNext({ runtimeIdle: false }).reason, 'no_eligible_request');
  assert.equal(claimAndStart(queue, { runtimeIdle: true }).requestId, maintenance.requestId);
});

test('ordinary messages arriving during an active turn only queue and never append, merge, or preempt', (t) => {
  const dbPath = temporaryDatabase(t);
  const ledger = openRunLedger({ dbPath });
  const queue = openRuntimePendingQueue({ dbPath });
  t.after(() => ledger.close());
  t.after(() => queue.close());

  ledger.accept(command('6', 'lane:same'));
  const active = claimAndStart(queue, { runtimeIdle: false });
  const activeEventCount = ledger.listEvents(active.requestId).length;
  const later = ledger.accept(command('7', 'lane:same', 1)).request;

  assert.equal(queue.claimNext({ runtimeIdle: false }).reason, 'capacity_occupied');
  assert.equal(ledger.get(active.requestId).status, 'active');
  assert.equal(ledger.listEvents(active.requestId).length, activeEventCount);
  assert.equal(ledger.get(later.requestId).status, 'queued');
  assert.deepEqual(ledger.listEvents(later.requestId).map(event => event.type), [
    'RunAccepted',
    'RunQueued',
  ]);

  complete(ledger, active);
  assert.equal(claimAndStart(queue, { runtimeIdle: false }).requestId, later.requestId);
});
