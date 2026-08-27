import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Worker } from 'node:worker_threads';

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
  for (const projection of ['feishu', 'openmax']) {
    core.outbox.register({
      projection,
      bootstrapPolicy: 'from_beginning',
      actorId: 'test-operator',
      idempotencyKey: `register:${projection}`,
    });
  }

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

function registerFromWorker({ dbPath, barrier, actorId, idempotencyKey }) {
  const source = `
    const { parentPort, workerData } = require('node:worker_threads');
    (async () => {
      const { openCommitmentCore } = await import(workerData.coreUrl);
      const core = openCommitmentCore({
        dbPath: workerData.dbPath,
        clock: () => '2026-08-25T10:00:00.000Z',
      });
      const state = new Int32Array(workerData.barrier);
      Atomics.add(state, 0, 1);
      parentPort.postMessage({ type: 'ready' });
      Atomics.wait(state, 1, 0);
      try {
        const result = core.outbox.register({
          projection: 'concurrent',
          bootstrapPolicy: 'from_now',
          actorId: workerData.actorId,
          idempotencyKey: workerData.idempotencyKey,
        });
        parentPort.postMessage({ type: 'result', result });
      } catch (error) {
        parentPort.postMessage({
          type: 'error',
          error: { message: error.message, code: error.code },
        });
      } finally {
        core.close();
      }
    })().catch((error) => {
      parentPort.postMessage({
        type: 'error',
        error: { message: error.message, code: error.code },
      });
    });
  `;
  const worker = new Worker(source, {
    eval: true,
    workerData: {
      dbPath,
      barrier,
      actorId,
      idempotencyKey,
      coreUrl: new URL('../core.js', import.meta.url).href,
    },
  });
  return new Promise((resolve, reject) => {
    worker.on('message', (message) => {
      if (message.type === 'result') resolve(message.result);
      if (message.type === 'error') {
        const error = new Error(message.error.message);
        error.code = message.error.code;
        reject(error);
      }
    });
    worker.on('error', reject);
    worker.on('exit', (code) => {
      if (code !== 0) reject(new Error(`registration worker exited with code ${code}`));
    });
  });
}

async function waitForReadyWorkers(state, count) {
  while (Atomics.load(state, 0) < count) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
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

test('an operator explicitly registers a projection before replaying existing events', () => {
  const harness = createHarness();
  try {
    createTask(harness.core);

    const registration = harness.core.outbox.register({
      projection: 'audit-log',
      bootstrapPolicy: 'from_beginning',
      actorId: 'operator-1',
      idempotencyKey: 'register:audit-log',
    });

    assert.equal(registration.created, true);
    assert.deepEqual(registration.registration, {
      projection: 'audit-log',
      bootstrapPolicy: 'from_beginning',
      enabled: true,
      baselineOutboxRowId: 0,
      createdAt: '2026-08-25T10:00:00.000Z',
      createdBy: 'operator-1',
    });
    assert.equal(
      claim(harness.core, 'audit-log', 'worker-audit', 'claim:audit-log:1').length,
      1,
    );
  } finally {
    harness.cleanup();
  }
});

test('workers and operators cannot use an unregistered projection', () => {
  const harness = createHarness();
  try {
    createTask(harness.core);
    const assertUnknownProjection = (operation) => assert.throws(
      operation,
      (error) => error?.code === 'UNKNOWN_PROJECTION',
    );

    assertUnknownProjection(() => claim(
      harness.core,
      'feishuu',
      'worker-typo',
      'claim:typo',
    ));
    assertUnknownProjection(() => harness.core.outbox.query({
      projection: 'random-name',
      limit: 10,
    }));
    assertUnknownProjection(() => harness.core.outbox.ack({
      projection: 'random-name',
      eventId: 'event-1',
      workerId: 'worker-1',
      idempotencyKey: 'ack:unknown',
    }, 1));
    assertUnknownProjection(() => harness.core.outbox.fail({
      projection: 'random-name',
      eventId: 'event-1',
      workerId: 'worker-1',
      error: 'must not be recorded',
      idempotencyKey: 'fail:unknown',
    }, 1));
    assertUnknownProjection(() => harness.core.outbox.redrive({
      projection: 'random-name',
      eventId: 'event-1',
      actorId: 'operator-1',
      idempotencyKey: 'redrive:unknown',
    }, 1));
    for (let index = 0; index < 25; index += 1) {
      assertUnknownProjection(() => claim(
        harness.core,
        `random-${index}`,
        'worker-random',
        `claim:random:${index}`,
      ));
    }
  } finally {
    harness.cleanup();
  }
});

test('migration backfills legacy delivery and receipt projections without losing work', () => {
  const harness = createHarness();
  try {
    createTask(harness.core);
    const [leased] = claim(harness.core, 'feishu', 'worker-legacy', 'claim:legacy');
    harness.core.close();

    const legacy = new Database(harness.dbPath);
    legacy.exec(`
      DELETE FROM commitment_projection_receipts WHERE operation = 'register';
      DROP TABLE commitment_projection_registry;
    `);
    legacy.prepare(`
      INSERT INTO commitment_projection_receipts (
        idempotency_key, operation, projection, request_fingerprint,
        result_json, created_at
      ) VALUES (?, 'claim', ?, ?, '[]', ?)
    `).run(
      'legacy:receipt-only',
      'receipt-only',
      'legacy-fingerprint',
      '2026-08-24T00:00:00.000Z',
    );
    legacy.close();

    const migrated = openCommitmentCore({
      dbPath: harness.dbPath,
      clock: () => '2026-08-25T10:00:01.000Z',
    });
    try {
      const feishu = migrated.outbox.register({
        projection: 'feishu',
        bootstrapPolicy: 'from_beginning',
        actorId: 'migration-operator',
        idempotencyKey: 'migration:register:feishu',
      });
      assert.equal(feishu.created, false);
      assert.equal(feishu.registration.createdBy, null);
      assert.equal(
        migrated.outbox.query({ projection: 'feishu', eventId: leased.eventId }).status,
        'leased',
      );

      const receiptOnly = migrated.outbox.register({
        projection: 'receipt-only',
        bootstrapPolicy: 'from_beginning',
        actorId: 'migration-operator',
        idempotencyKey: 'migration:register:receipt-only',
      });
      assert.equal(receiptOnly.created, false);
      assert.equal(
        claim(migrated, 'receipt-only', 'worker-receipt', 'claim:receipt-after-migration')
          .length,
        1,
      );
      assert.throws(
        () => claim(migrated, 'never-seen', 'worker-unknown', 'claim:never-seen'),
        (error) => error?.code === 'UNKNOWN_PROJECTION',
      );
    } finally {
      migrated.close();
    }
  } finally {
    try {
      harness.core.close();
    } catch {
      // The migration path intentionally closes and reopens this connection.
    }
    rmSync(path.dirname(harness.dbPath), { recursive: true, force: true });
  }
});

test('migration preserves legacy attempt totals and enables generation-one redrive', () => {
  const harness = createHarness();
  try {
    createTask(harness.core);
    const [leased] = claim(harness.core, 'feishu', 'worker-legacy', 'claim:legacy-redrive');
    harness.core.close();

    const legacy = new Database(harness.dbPath);
    legacy.exec(`
      DROP TABLE commitment_projection_redrives;
      ALTER TABLE commitment_projection_deliveries DROP COLUMN redrive_generation;
      ALTER TABLE commitment_projection_deliveries DROP COLUMN total_attempt_count;
      ALTER TABLE commitment_projection_deliveries DROP COLUMN last_redriven_at;
      ALTER TABLE commitment_projection_deliveries DROP COLUMN last_redriven_by;
    `);
    legacy.close();

    const migrated = openCommitmentCore({
      dbPath: harness.dbPath,
      clock: () => '2026-08-25T10:00:01.000Z',
    });
    try {
      const restored = migrated.outbox.query({
        projection: 'feishu',
        eventId: leased.eventId,
      });
      assert.equal(restored.attempt, 1);
      assert.equal(restored.totalAttempts, 1);
      assert.equal(restored.redriveGeneration, 0);

      const dead = migrated.outbox.fail({
        projection: 'feishu',
        eventId: leased.eventId,
        workerId: 'worker-legacy',
        error: 'legacy delivery failed',
        idempotencyKey: 'fail:legacy-redrive',
      }, leased.version);
      const redriven = migrated.outbox.redrive({
        projection: 'feishu',
        eventId: leased.eventId,
        actorId: 'migration-operator',
        idempotencyKey: 'redrive:legacy:1',
      }, dead.version);
      assert.equal(redriven.delivery.redriveGeneration, 1);
      assert.equal(redriven.delivery.totalAttempts, 1);
    } finally {
      migrated.close();
    }
  } finally {
    try {
      harness.core.close();
    } catch {
      // The migration path intentionally closes and reopens this connection.
    }
    rmSync(path.dirname(harness.dbPath), { recursive: true, force: true });
  }
});

test('from_now excludes existing events and includes later events at the same timestamp', () => {
  const harness = createHarness();
  try {
    const task = createTask(harness.core);
    const registered = harness.core.outbox.register({
      projection: 'webhook',
      bootstrapPolicy: 'from_now',
      actorId: 'operator-1',
      idempotencyKey: 'register:webhook',
    });
    assert.equal(registered.registration.baselineOutboxRowId, 1);
    assert.deepEqual(claim(harness.core, 'webhook', 'worker-1', 'claim:webhook:1'), []);
    assert.equal(
      harness.core.outbox.query({ projection: 'webhook', eventId: 'event-1' }),
      null,
    );

    harness.core.command({
      type: 'StartTask',
      taskId: task.id,
      actorId: 'agent-1',
      idempotencyKey: 'command:start:webhook-test',
    }, task.version);
    const [delivery] = claim(
      harness.core,
      'webhook',
      'worker-1',
      'claim:webhook:2',
    );
    assert.equal(delivery.eventId, 'event-2');
  } finally {
    harness.cleanup();
  }
});

test('registration is idempotent and fails closed on bootstrap conflicts', () => {
  const harness = createHarness();
  try {
    const request = {
      projection: 'analytics',
      bootstrapPolicy: 'from_now',
      actorId: 'operator-1',
      idempotencyKey: 'register:analytics:1',
    };
    const created = harness.core.outbox.register(request);
    assert.deepEqual(harness.core.outbox.register(request), created);

    const repeated = harness.core.outbox.register({
      ...request,
      actorId: 'operator-2',
      idempotencyKey: 'register:analytics:2',
    });
    assert.equal(repeated.created, false);
    assert.deepEqual(repeated.registration, created.registration);

    assert.throws(
      () => harness.core.outbox.register({
        ...request,
        bootstrapPolicy: 'from_beginning',
        idempotencyKey: 'register:analytics:conflict',
      }),
      (error) => error?.code === 'PROJECTION_REGISTRATION_CONFLICT',
    );
    assert.throws(
      () => harness.core.outbox.register({
        ...request,
        projection: 'changed-name',
      }),
      (error) => error?.code === 'IDEMPOTENCY_CONFLICT',
    );
    assert.throws(
      () => harness.core.outbox.register({
        projection: 'implicit-history-is-forbidden',
        actorId: 'operator-1',
        idempotencyKey: 'register:missing-policy',
      }),
      /bootstrapPolicy must be a non-empty string/,
    );
  } finally {
    harness.cleanup();
  }
});

test('two connections serialize concurrent registration without duplicating the registry', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'zylos-outbox-registry-race-'));
  const dbPath = path.join(directory, 'commitments.db');
  const bootstrap = openCommitmentCore({ dbPath });
  bootstrap.close();
  const barrier = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 2);
  const state = new Int32Array(barrier);

  try {
    const first = registerFromWorker({
      dbPath,
      barrier,
      actorId: 'operator-a',
      idempotencyKey: 'register:concurrent:a',
    });
    const second = registerFromWorker({
      dbPath,
      barrier,
      actorId: 'operator-b',
      idempotencyKey: 'register:concurrent:b',
    });
    await waitForReadyWorkers(state, 2);
    Atomics.store(state, 1, 1);
    Atomics.notify(state, 1, 2);

    const results = await Promise.all([first, second]);
    assert.deepEqual(results.map((result) => result.created).sort(), [false, true]);
    assert.deepEqual(results[0].registration, results[1].registration);
  } finally {
    rmSync(directory, { recursive: true, force: true });
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

test('an operator explicitly redrives one registered dead-letter delivery into a new attempt generation', () => {
  const harness = createHarness();
  try {
    createTask(harness.core);
    const [leased] = claim(harness.core, 'feishu', 'worker-1', 'claim:redrive:1');
    const dead = harness.core.outbox.fail({
      projection: 'feishu',
      eventId: leased.eventId,
      workerId: 'worker-1',
      error: 'permanent failure before operator review',
      idempotencyKey: 'fail:redrive:1',
    }, leased.version);

    harness.setNow('2026-08-25T10:05:00.000Z');
    const result = harness.core.outbox.redrive({
      projection: 'feishu',
      eventId: leased.eventId,
      actorId: 'operator-1',
      idempotencyKey: 'redrive:feishu:event-1:1',
    }, dead.version);

    assert.equal(result.delivery.status, 'retry_wait');
    assert.equal(result.delivery.attempt, 0);
    assert.equal(result.delivery.totalAttempts, 1);
    assert.equal(result.delivery.redriveGeneration, 1);
    assert.equal(result.delivery.version, 3);
    assert.equal(result.delivery.deadLetteredAt, null);
    assert.equal(result.delivery.lastRedrivenAt, '2026-08-25T10:05:00.000Z');
    assert.equal(result.delivery.lastRedrivenBy, 'operator-1');
    assert.deepEqual(result.redrive, {
      projection: 'feishu',
      eventId: 'event-1',
      generation: 1,
      actorId: 'operator-1',
      idempotencyKey: 'redrive:feishu:event-1:1',
      fromVersion: 2,
      toVersion: 3,
      previousAttemptCount: 1,
      totalAttempts: 1,
      previousError: 'permanent failure before operator review',
      previousDeadLetteredAt: '2026-08-25T10:00:00.000Z',
      redrivenAt: '2026-08-25T10:05:00.000Z',
    });

    const [reclaimed] = claim(
      harness.core,
      'feishu',
      'worker-2',
      'claim:redrive:2',
    );
    assert.equal(reclaimed.attempt, 1);
    assert.equal(reclaimed.totalAttempts, 2);
    assert.equal(reclaimed.redriveGeneration, 1);
  } finally {
    harness.cleanup();
  }
});

test('an exact redrive replay returns its original generation after delivery state advances', () => {
  const harness = createHarness();
  try {
    createTask(harness.core);
    const [leased] = claim(harness.core, 'feishu', 'worker-1', 'claim:redrive-replay:1');
    const dead = harness.core.outbox.fail({
      projection: 'feishu',
      eventId: leased.eventId,
      workerId: 'worker-1',
      error: 'dead for replay test',
      idempotencyKey: 'fail:redrive-replay:1',
    }, leased.version);
    const request = {
      projection: 'feishu',
      eventId: leased.eventId,
      actorId: 'operator-1',
      idempotencyKey: 'redrive:replay:1',
    };

    const first = harness.core.outbox.redrive(request, dead.version);
    harness.setNow('2026-08-25T10:01:00.000Z');
    const [reclaimed] = claim(
      harness.core,
      'feishu',
      'worker-2',
      'claim:redrive-replay:2',
    );
    assert.equal(reclaimed.version, 4);

    assert.deepEqual(harness.core.outbox.redrive(request, dead.version), first);
    assert.equal(
      harness.core.outbox.query({ projection: 'feishu', eventId: leased.eventId }).version,
      4,
    );
  } finally {
    harness.cleanup();
  }
});

test('redrive requires the current dead-letter delivery version and fails closed otherwise', () => {
  const harness = createHarness();
  try {
    createTask(harness.core);
    const [leased] = claim(harness.core, 'feishu', 'worker-1', 'claim:redrive-fence:1');
    const request = {
      projection: 'feishu',
      eventId: leased.eventId,
      actorId: 'operator-1',
      idempotencyKey: 'redrive:fence:1',
    };

    assert.throws(
      () => harness.core.outbox.redrive(request, leased.version),
      (error) => error?.code === 'DELIVERY_NOT_DEAD_LETTER',
    );

    const dead = harness.core.outbox.fail({
      projection: 'feishu',
      eventId: leased.eventId,
      workerId: 'worker-1',
      error: 'dead for fencing test',
      idempotencyKey: 'fail:redrive-fence:1',
    }, leased.version);
    assert.throws(
      () => harness.core.outbox.redrive({
        ...request,
        idempotencyKey: 'redrive:fence:stale',
      }, leased.version),
      (error) => error?.code === 'DELIVERY_VERSION_CONFLICT',
    );
    assert.equal(
      harness.core.outbox.query({ projection: 'feishu', eventId: leased.eventId }).version,
      dead.version,
    );
  } finally {
    harness.cleanup();
  }
});

test('redrive attempt totals remain cumulative across generations', () => {
  const harness = createHarness();
  try {
    createTask(harness.core);
    const [firstLease] = claim(harness.core, 'feishu', 'worker-1', 'claim:generation:1');
    const firstDead = harness.core.outbox.fail({
      projection: 'feishu',
      eventId: firstLease.eventId,
      workerId: 'worker-1',
      error: 'generation zero failed',
      idempotencyKey: 'fail:generation:0',
    }, firstLease.version);
    const firstRedrive = harness.core.outbox.redrive({
      projection: 'feishu',
      eventId: firstLease.eventId,
      actorId: 'operator-1',
      idempotencyKey: 'redrive:generation:1',
    }, firstDead.version);
    assert.equal(firstRedrive.delivery.redriveGeneration, 1);
    assert.equal(firstRedrive.delivery.attempt, 0);
    assert.equal(firstRedrive.delivery.totalAttempts, 1);

    const [secondLease] = claim(
      harness.core,
      'feishu',
      'worker-2',
      'claim:generation:2',
    );
    const secondDead = harness.core.outbox.fail({
      projection: 'feishu',
      eventId: secondLease.eventId,
      workerId: 'worker-2',
      error: 'generation one failed',
      idempotencyKey: 'fail:generation:1',
    }, secondLease.version);
    const secondRedrive = harness.core.outbox.redrive({
      projection: 'feishu',
      eventId: secondLease.eventId,
      actorId: 'operator-2',
      idempotencyKey: 'redrive:generation:2',
    }, secondDead.version);

    assert.equal(secondRedrive.delivery.redriveGeneration, 2);
    assert.equal(secondRedrive.delivery.attempt, 0);
    assert.equal(secondRedrive.delivery.totalAttempts, 2);
    assert.equal(secondRedrive.redrive.generation, 2);
    assert.equal(secondRedrive.redrive.previousAttemptCount, 1);
    assert.equal(secondRedrive.redrive.totalAttempts, 2);

    const audited = harness.core.outbox.query({
      projection: 'feishu',
      eventId: secondLease.eventId,
      includeRedrives: true,
    });
    assert.equal(audited.delivery.redriveGeneration, 2);
    assert.deepEqual(
      audited.redrives.map((redrive) => ({
        generation: redrive.generation,
        actorId: redrive.actorId,
        totalAttempts: redrive.totalAttempts,
      })),
      [
        { generation: 1, actorId: 'operator-1', totalAttempts: 1 },
        { generation: 2, actorId: 'operator-2', totalAttempts: 2 },
      ],
    );

    const [thirdLease] = claim(
      harness.core,
      'feishu',
      'worker-3',
      'claim:generation:3',
    );
    assert.equal(thirdLease.redriveGeneration, 2);
    assert.equal(thirdLease.attempt, 1);
    assert.equal(thirdLease.totalAttempts, 3);
  } finally {
    harness.cleanup();
  }
});

test('delivery update, redrive audit, and idempotency receipt roll back together', () => {
  const harness = createHarness();
  const raw = new Database(harness.dbPath);
  try {
    createTask(harness.core);
    const [leased] = claim(harness.core, 'feishu', 'worker-1', 'claim:redrive-atomic:1');
    const dead = harness.core.outbox.fail({
      projection: 'feishu',
      eventId: leased.eventId,
      workerId: 'worker-1',
      error: 'dead for atomicity test',
      idempotencyKey: 'fail:redrive-atomic:1',
    }, leased.version);
    const request = {
      projection: 'feishu',
      eventId: leased.eventId,
      actorId: 'operator-1',
      idempotencyKey: 'redrive:atomic:1',
    };
    raw.exec(`
      CREATE TRIGGER reject_redrive_receipt
      BEFORE INSERT ON commitment_projection_receipts
      WHEN NEW.operation = 'redrive'
      BEGIN
        SELECT RAISE(ABORT, 'redrive receipt rejected');
      END;
    `);

    assert.throws(
      () => harness.core.outbox.redrive(request, dead.version),
      /redrive receipt rejected/,
    );
    assert.deepEqual(
      harness.core.outbox.query({ projection: 'feishu', eventId: leased.eventId }),
      dead,
    );

    raw.exec('DROP TRIGGER reject_redrive_receipt');
    const retried = harness.core.outbox.redrive(request, dead.version);
    assert.equal(retried.redrive.generation, 1);
    assert.equal(retried.delivery.version, dead.version + 1);
  } finally {
    raw.close();
    harness.cleanup();
  }
});

test('redrive requires explicit bounded operator input and protects idempotency keys', () => {
  const harness = createHarness();
  try {
    createTask(harness.core);
    const [leased] = claim(harness.core, 'feishu', 'worker-1', 'claim:redrive-input:1');
    const dead = harness.core.outbox.fail({
      projection: 'feishu',
      eventId: leased.eventId,
      workerId: 'worker-1',
      error: 'dead for input test',
      idempotencyKey: 'fail:redrive-input:1',
    }, leased.version);
    const request = {
      projection: 'feishu',
      eventId: leased.eventId,
      actorId: 'operator-1',
      idempotencyKey: 'redrive:input:1',
    };

    assert.throws(
      () => harness.core.outbox.redrive({
        projection: request.projection,
        eventId: request.eventId,
        idempotencyKey: 'redrive:missing-actor',
      }, dead.version),
      /redrive.actorId must be a non-empty string/,
    );
    assert.throws(
      () => harness.core.outbox.redrive({ ...request, automatic: true }, dead.version),
      /unsupported outbox redrive request field: automatic/,
    );
    assert.throws(
      () => harness.core.outbox.redrive(request, 0),
      /expectedVersion must be a positive integer/,
    );

    harness.core.outbox.redrive(request, dead.version);
    assert.throws(
      () => harness.core.outbox.redrive({ ...request, actorId: 'operator-2' }, dead.version),
      (error) => error?.code === 'IDEMPOTENCY_CONFLICT',
    );
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
