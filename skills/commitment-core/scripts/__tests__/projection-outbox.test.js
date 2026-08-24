import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import Database from 'better-sqlite3';

import { openCommitmentCore } from '../core.js';

function createHarness() {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'zylos-projection-outbox-'));
  let now = '2026-08-25T10:00:00.000Z';
  let eventIndex = 0;
  const dbPath = path.join(directory, 'commitments.db');
  const core = openCommitmentCore({
    dbPath,
    clock: () => now,
    idGenerator: () => 'task-001',
    eventIdGenerator: () => `event-${++eventIndex}`,
  });

  return {
    core,
    dbPath,
    setNow(value) {
      now = value;
    },
    cleanup() {
      core.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

function createTask(core) {
  return core.ingest({
    idempotencyKey: 'source:task-001',
    source: { channel: 'test', externalId: 'message-001', senderId: 'owner-1' },
    task: {
      title: 'Project this task',
      ownerId: 'owner-1',
      assigneeId: 'agent-1',
    },
  }).task;
}

function claim(core, projection, workerId, idempotencyKey) {
  return core.outbox.claim({
    projection,
    workerId,
    idempotencyKey,
    leaseMs: 60_000,
    limit: 10,
  });
}

test('Task events become independently claimable projection deliveries', () => {
  const harness = createHarness();
  try {
    createTask(harness.core);

    const feishu = claim(harness.core, 'feishu', 'worker-feishu', 'claim:feishu:1');
    assert.deepEqual(claim(harness.core, 'feishu', 'worker-feishu', 'claim:feishu:1'), feishu);
    assert.equal(feishu.length, 1);
    assert.equal(feishu[0].projection, 'feishu');
    assert.equal(feishu[0].event.id, 'event-1');
    assert.equal(feishu[0].event.type, 'TaskCreated');
    assert.equal(feishu[0].status, 'leased');
    assert.equal(feishu[0].attempt, 1);
    assert.equal(feishu[0].version, 1);

    const openmax = claim(harness.core, 'openmax', 'worker-openmax', 'claim:openmax:1');
    assert.equal(openmax.length, 1);
    assert.equal(openmax[0].event.id, feishu[0].event.id);
    assert.equal(openmax[0].projection, 'openmax');
  } finally {
    harness.cleanup();
  }
});

test('acknowledged deliveries advance independently and expose later Task events', () => {
  const harness = createHarness();
  try {
    const task = createTask(harness.core);
    assert.equal(
      harness.core.outbox.query({ projection: 'openmax', eventId: 'event-1' }).status,
      'pending',
    );

    const [leased] = claim(harness.core, 'feishu', 'worker-feishu', 'claim:feishu:1');
    const ackRequest = {
      projection: 'feishu',
      eventId: leased.eventId,
      workerId: 'worker-feishu',
      idempotencyKey: 'ack:feishu:event-1',
    };
    const acknowledged = harness.core.outbox.ack(ackRequest, leased.version);
    assert.deepEqual(harness.core.outbox.ack(ackRequest, leased.version), acknowledged);
    assert.equal(acknowledged.status, 'acknowledged');
    assert.equal(acknowledged.version, 2);

    harness.setNow('2026-08-25T10:01:00.000Z');
    harness.core.command({
      type: 'StartTask',
      taskId: task.id,
      actorId: 'agent-1',
      idempotencyKey: 'command:start:task-001',
    }, task.version);

    const next = claim(harness.core, 'feishu', 'worker-feishu', 'claim:feishu:2');
    assert.equal(next.length, 1);
    assert.equal(next[0].event.id, 'event-2');
    assert.equal(next[0].event.type, 'TaskStarted');
    assert.deepEqual(
      harness.core.outbox.query({
        projection: 'feishu',
        statuses: ['acknowledged', 'leased'],
        limit: 10,
      }).map((delivery) => delivery.status),
      ['acknowledged', 'leased'],
    );
  } finally {
    harness.cleanup();
  }
});

test('failures retry after backoff, recover stale leases, and dead-letter at the attempt bound', () => {
  const harness = createHarness();
  try {
    createTask(harness.core);
    const [first] = claim(harness.core, 'feishu', 'worker-1', 'claim:1');
    const failRequest = {
      projection: 'feishu',
      eventId: first.eventId,
      workerId: 'worker-1',
      error: 'Feishu is temporarily unavailable',
      retryAfterMs: 30_000,
      maxAttempts: 3,
      idempotencyKey: 'fail:1',
    };
    const failed = harness.core.outbox.fail(failRequest, first.version);
    assert.deepEqual(harness.core.outbox.fail(failRequest, first.version), failed);
    assert.equal(failed.status, 'retry_wait');
    assert.equal(failed.version, 2);
    assert.equal(failed.nextAttemptAt, '2026-08-25T10:00:30.000Z');
    assert.equal(harness.core.query({ taskId: 'task-001' }).state, 'ready');

    harness.setNow('2026-08-25T10:00:20.000Z');
    assert.deepEqual(claim(harness.core, 'feishu', 'worker-2', 'claim:too-early'), []);

    harness.setNow('2026-08-25T10:00:30.000Z');
    const [second] = claim(harness.core, 'feishu', 'worker-2', 'claim:2');
    assert.equal(second.attempt, 2);
    assert.equal(second.version, 3);

    harness.setNow('2026-08-25T10:01:30.000Z');
    const [recovered] = claim(harness.core, 'feishu', 'worker-3', 'claim:3');
    assert.equal(recovered.attempt, 3);
    assert.equal(recovered.version, 4);
    assert.equal(recovered.workerId, 'worker-3');

    const dead = harness.core.outbox.fail({
      projection: 'feishu',
      eventId: recovered.eventId,
      workerId: 'worker-3',
      error: 'permanent projection failure',
      retryAfterMs: 30_000,
      maxAttempts: 3,
      idempotencyKey: 'fail:3',
    }, recovered.version);
    assert.equal(dead.status, 'dead_letter');
    assert.equal(dead.version, 5);
    assert.equal(dead.deadLetteredAt, '2026-08-25T10:01:30.000Z');

    harness.setNow('2026-08-25T11:00:00.000Z');
    assert.deepEqual(claim(harness.core, 'feishu', 'worker-4', 'claim:after-dead'), []);
  } finally {
    harness.cleanup();
  }
});

test('delivery fencing, idempotency, and input bounds fail closed with stable errors', () => {
  const harness = createHarness();
  try {
    createTask(harness.core);
    const [leased] = claim(harness.core, ' FeiShu ', 'worker-1', 'claim:1');

    assert.throws(
      () => harness.core.outbox.ack({
        projection: 'feishu',
        eventId: leased.eventId,
        workerId: 'intruder',
        idempotencyKey: 'ack:intruder',
      }, leased.version),
      (error) => error?.code === 'DELIVERY_FORBIDDEN',
    );
    assert.throws(
      () => harness.core.outbox.ack({
        projection: 'feishu',
        eventId: 'missing-event',
        workerId: 'worker-1',
        idempotencyKey: 'ack:missing',
      }, 1),
      (error) => error?.code === 'DELIVERY_NOT_FOUND',
    );
    assert.throws(
      () => claim(harness.core, 'openmax', 'worker-2', 'claim:1'),
      (error) => error?.code === 'IDEMPOTENCY_CONFLICT',
    );
    assert.throws(
      () => harness.core.outbox.claim({
        projection: 'bad projection',
        workerId: 'worker-1',
        idempotencyKey: 'claim:bad',
        leaseMs: 1000,
        limit: 1,
      }),
      /lowercase identifier/,
    );
    assert.throws(
      () => harness.core.outbox.claim({
        projection: 'feishu',
        workerId: 'worker-1',
        idempotencyKey: 'claim:unknown',
        leaseMs: 1000,
        limit: 1,
        backendToken: 'must-not-enter-core',
      }),
      /unsupported outbox claim request field/,
    );
    assert.throws(
      () => harness.core.outbox.query({ projection: 'feishu', limit: 101 }),
      /between 1 and 100/,
    );

    harness.setNow('2026-08-25T10:01:00.000Z');
    assert.throws(
      () => harness.core.outbox.ack({
        projection: 'feishu',
        eventId: leased.eventId,
        workerId: 'worker-1',
        idempotencyKey: 'ack:expired',
      }, leased.version),
      (error) => error?.code === 'DELIVERY_LEASE_EXPIRED',
    );
  } finally {
    harness.cleanup();
  }
});

test('Task, Event, receipt, and Outbox record roll back together on Outbox persistence failure', () => {
  const harness = createHarness();
  const raw = new Database(harness.dbPath);
  try {
    raw.exec(`
      CREATE TRIGGER reject_projection_record
      BEFORE INSERT ON commitment_projection_outbox
      BEGIN
        SELECT RAISE(ABORT, 'projection outbox rejected');
      END;
    `);

    assert.throws(() => createTask(harness.core), /projection outbox rejected/);
    assert.equal(harness.core.query({ taskId: 'task-001' }), null);
    assert.equal(
      harness.core.outbox.query({ projection: 'feishu', eventId: 'event-1' }),
      null,
    );

    raw.exec('DROP TRIGGER reject_projection_record');
    const task = createTask(harness.core);
    raw.exec(`
      CREATE TRIGGER reject_projection_record
      BEFORE INSERT ON commitment_projection_outbox
      BEGIN
        SELECT RAISE(ABORT, 'projection outbox rejected');
      END;
    `);
    const command = {
      type: 'StartTask',
      taskId: task.id,
      actorId: 'agent-1',
      idempotencyKey: 'command:start:atomic',
    };
    assert.throws(
      () => harness.core.command(command, task.version),
      /projection outbox rejected/,
    );
    assert.equal(harness.core.query({ taskId: task.id }).state, 'ready');
    assert.equal(
      harness.core.query({ taskId: task.id, includeEvents: true }).events.length,
      1,
    );

    raw.exec('DROP TRIGGER reject_projection_record');
    assert.equal(harness.core.command(command, task.version).task.state, 'in_progress');
    assert.equal(
      harness.core.outbox.query({ projection: 'feishu' }).length,
      2,
    );
  } finally {
    raw.close();
    harness.cleanup();
  }
});
