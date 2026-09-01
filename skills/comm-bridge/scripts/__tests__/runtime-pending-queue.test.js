import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

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

test('the shared runtime schedules lane heads by priority then acceptance FIFO', (t) => {
  const dbPath = temporaryDatabase(t);
  const ledger = openRunLedger({ dbPath });
  const queue = openRuntimePendingQueue({ dbPath });
  t.after(() => ledger.close());
  t.after(() => queue.close());

  const laneAFirst = ledger.accept(command('1', 'lane:a', 3)).request;
  const laneALaterHighPriority = ledger.accept(command('2', 'lane:a', 1)).request;
  const laneB = ledger.accept(command('3', 'lane:b', 2)).request;

  const firstClaim = queue.claimNext({ runtimeIdle: false });
  assert.equal(firstClaim.requestId, laneB.requestId);
  assert.equal(firstClaim.runtimeLaneId, RUNTIME_LANE_ID);
  assert.equal(RUNTIME_LANE_CAPACITY, 1);
  assert.equal(queue.claimNext({ runtimeIdle: true }), null);

  complete(ledger, firstClaim);
  const secondClaim = queue.claimNext({ runtimeIdle: false });
  assert.equal(secondClaim.requestId, laneAFirst.requestId);
  complete(ledger, secondClaim);
  const thirdClaim = queue.claimNext({ runtimeIdle: false });
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
  const firstClaim = queue.claimNext();
  assert.equal(firstClaim.requestId, first.requestId);
  complete(ledger, firstClaim);
  assert.equal(queue.claimNext().requestId, second.requestId);
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

  const ordinaryClaim = queue.claimNext({ runtimeIdle: false });
  assert.equal(ordinaryClaim.requestId, ordinary.requestId);
  complete(ledger, ordinaryClaim);
  assert.equal(queue.claimNext({ runtimeIdle: false }), null);
  assert.equal(queue.claimNext({ runtimeIdle: true }).requestId, maintenance.requestId);
});

test('ordinary messages arriving during an active turn only queue and never append, merge, or preempt', (t) => {
  const dbPath = temporaryDatabase(t);
  const ledger = openRunLedger({ dbPath });
  const queue = openRuntimePendingQueue({ dbPath });
  t.after(() => ledger.close());
  t.after(() => queue.close());

  ledger.accept(command('6', 'lane:same'));
  const active = queue.claimNext({ runtimeIdle: false });
  const activeEventCount = ledger.listEvents(active.requestId).length;
  const later = ledger.accept(command('7', 'lane:same', 1)).request;

  assert.equal(queue.claimNext({ runtimeIdle: false }), null);
  assert.equal(ledger.get(active.requestId).status, 'active');
  assert.equal(ledger.listEvents(active.requestId).length, activeEventCount);
  assert.equal(ledger.get(later.requestId).status, 'queued');
  assert.deepEqual(ledger.listEvents(later.requestId).map(event => event.type), [
    'RunAccepted',
    'RunQueued',
  ]);

  complete(ledger, active);
  assert.equal(queue.claimNext({ runtimeIdle: false }).requestId, later.requestId);
});
