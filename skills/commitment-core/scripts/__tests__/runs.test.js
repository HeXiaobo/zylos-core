import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import Database from 'better-sqlite3';

import { openCommitmentCore } from '../core.js';

function createHarness({
  dbPath,
  taskEventIds = ['task-event-start', 'task-event-submit', 'task-event-release'],
  runEventIds = [
    'run-event-claim',
    'run-event-heartbeat',
    'run-event-complete',
    'run-event-expired',
    'run-event-takeover',
  ],
  runIds = ['run-001', 'run-002'],
} = {}) {
  const directory = dbPath ? null : mkdtempSync(path.join(os.tmpdir(), 'zylos-task-run-'));
  const databasePath = dbPath ?? path.join(directory, 'commitments.db');
  const now = { value: '2026-08-25T10:00:00.000Z' };
  let taskEventIndex = 0;
  let runEventIndex = 0;
  let runIdIndex = 0;
  let creationPending = true;
  const core = openCommitmentCore({
    dbPath: databasePath,
    clock: () => now.value,
    idGenerator: () => 'task-001',
    eventIdGenerator: () => {
      if (creationPending) {
        creationPending = false;
        return 'task-event-created';
      }
      return taskEventIds[taskEventIndex++];
    },
    runIdGenerator: () => runIds[runIdIndex++],
    runEventIdGenerator: () => runEventIds[runEventIndex++],
  });

  return {
    core,
    now,
    dbPath: databasePath,
    cleanup() {
      core.close();
      if (directory) rmSync(directory, { recursive: true, force: true });
    },
  };
}

function ingestTask(core) {
  return core.ingest({
    idempotencyKey: 'source:task-001',
    source: { channel: 'test', externalId: 'task-001', senderId: 'owner-1' },
    task: {
      title: '执行客户回访',
      ownerId: 'owner-1',
      acceptorId: 'acceptor-1',
      assigneeId: 'agent-1',
    },
  }).task;
}

function claim(core, overrides = {}, expectedTaskVersion = 1) {
  return core.runs.claim({
    taskId: 'task-001',
    actorId: 'agent-1',
    workerId: 'worker-1',
    idempotencyKey: 'run-command:claim:1',
    leaseMs: 1_000,
    ...overrides,
  }, expectedTaskVersion);
}

test('claim atomically starts a ready task and exact replay creates one active run', () => {
  const harness = createHarness();

  try {
    ingestTask(harness.core);
    const first = claim(harness.core);
    const replay = claim(harness.core);

    assert.deepEqual(replay, first);
    assert.equal(first.task.state, 'in_progress');
    assert.equal(first.task.version, 2);
    assert.deepEqual(first.run, {
      id: 'run-001',
      taskId: 'task-001',
      actorId: 'agent-1',
      workerId: 'worker-1',
      status: 'active',
      version: 1,
      leaseExpiresAt: '2026-08-25T10:00:01.000Z',
      lastHeartbeatAt: '2026-08-25T10:00:00.000Z',
      startedAt: '2026-08-25T10:00:00.000Z',
      endedAt: null,
    });
    assert.equal(first.event.type, 'TaskRunClaimed');
    assert.equal(first.taskEvent.type, 'TaskStarted');
    assert.equal(first.recoveredRun, null);
    assert.deepEqual(
      harness.core.runs.query({ taskId: 'task-001' }).map((run) => run.id),
      ['run-001'],
    );
    assert.deepEqual(
      harness.core.runs.query({ runId: 'run-001', includeEvents: true }).events
        .map((event) => event.type),
      ['TaskRunClaimed'],
    );
    assert.equal(
      harness.core.query({ taskId: 'task-001', includeEvents: true }).events.at(-1).type,
      'TaskStarted',
    );

    assert.throws(
      () => claim(harness.core, { workerId: 'worker-other' }),
      (error) => error?.code === 'IDEMPOTENCY_CONFLICT',
    );
  } finally {
    harness.cleanup();
  }
});

test('two Core connections cannot hold concurrent active leases for one task', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'zylos-task-run-concurrency-'));
  const dbPath = path.join(directory, 'commitments.db');
  const first = createHarness({ dbPath });
  let second;

  try {
    ingestTask(first.core);
    second = createHarness({ dbPath, runIds: ['run-from-second'] });
    claim(first.core);

    assert.throws(
      () => claim(second.core, {
        workerId: 'worker-2',
        idempotencyKey: 'run-command:claim:2',
      }, 2),
      (error) => error?.code === 'LEASE_CONFLICT',
    );
    assert.equal(first.core.runs.query({ taskId: 'task-001' }).length, 1);

    const raw = new Database(dbPath);
    try {
      assert.throws(() => raw.prepare(`
        INSERT INTO commitment_task_runs (
          id, task_id, actor_id, worker_id, status, version, lease_expires_at,
          last_heartbeat_at, started_at, ended_at
        ) VALUES (
          'run-bypassing-api', 'task-001', 'agent-1', 'worker-raw', 'active', 1,
          '2026-08-25T10:00:05.000Z', '2026-08-25T10:00:00.000Z',
          '2026-08-25T10:00:00.000Z', NULL
        )
      `).run(), /UNIQUE constraint failed/);
    } finally {
      raw.close();
    }
  } finally {
    second?.core.close();
    first.core.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('heartbeat renews only the claiming worker lease and is idempotent', () => {
  const harness = createHarness();

  try {
    ingestTask(harness.core);
    claim(harness.core);
    harness.now.value = '2026-08-25T10:00:00.500Z';
    const command = {
      taskId: 'task-001',
      runId: 'run-001',
      workerId: 'worker-1',
      idempotencyKey: 'run-command:heartbeat:1',
      leaseMs: 2_000,
    };
    const renewed = harness.core.runs.heartbeat(command, 1);

    assert.equal(renewed.run.version, 2);
    assert.equal(renewed.run.leaseExpiresAt, '2026-08-25T10:00:02.500Z');
    assert.equal(renewed.event.type, 'TaskRunHeartbeat');
    assert.deepEqual(harness.core.runs.heartbeat(command, 1), renewed);
    assert.throws(
      () => harness.core.runs.heartbeat({
        ...command,
        workerId: 'worker-2',
        idempotencyKey: 'run-command:heartbeat:wrong-worker',
      }, 2),
      (error) => error?.code === 'LEASE_FORBIDDEN',
    );
    assert.throws(
      () => harness.core.runs.heartbeat({
        ...command,
        idempotencyKey: 'run-command:heartbeat:stale',
      }, 1),
      (error) => error?.code === 'RUN_VERSION_CONFLICT',
    );

    harness.now.value = '2026-08-25T10:00:00.750Z';
    const nonShortening = harness.core.runs.heartbeat({
      ...command,
      idempotencyKey: 'run-command:heartbeat:shorter',
      leaseMs: 500,
    }, 2);
    assert.equal(nonShortening.run.version, 3);
    assert.equal(
      nonShortening.run.leaseExpiresAt,
      '2026-08-25T10:00:02.500Z',
      'a heartbeat must not shorten the current lease',
    );

    harness.now.value = '2026-08-25T10:00:03.000Z';
    assert.deepEqual(
      harness.core.runs.heartbeat(command, 1),
      renewed,
      'an exact receipt replay wins even after the renewed lease expires',
    );
    assert.throws(
      () => harness.core.runs.heartbeat({
        ...command,
        idempotencyKey: 'run-command:heartbeat:expired',
      }, 3),
      (error) => error?.code === 'LEASE_EXPIRED',
    );
  } finally {
    harness.cleanup();
  }
});

test('an expired lease is recovered atomically by a new worker without advancing Task state', () => {
  const harness = createHarness({
    runEventIds: ['run-event-claim-1', 'run-event-expired', 'run-event-claim-2'],
  });

  try {
    ingestTask(harness.core);
    claim(harness.core);
    harness.now.value = '2026-08-25T10:00:02.000Z';

    const takeover = claim(harness.core, {
      workerId: 'worker-2',
      idempotencyKey: 'run-command:claim:2',
    }, 2);

    assert.equal(takeover.task.state, 'in_progress');
    assert.equal(takeover.task.version, 2);
    assert.equal(takeover.taskEvent, null);
    assert.equal(takeover.run.id, 'run-002');
    assert.equal(takeover.run.workerId, 'worker-2');
    assert.equal(takeover.recoveredRun.id, 'run-001');
    assert.equal(takeover.recoveredRun.status, 'expired');
    assert.equal(takeover.recoveredRun.version, 2);
    assert.deepEqual(
      harness.core.runs.query({ runId: 'run-001', includeEvents: true }).events
        .map((event) => event.type),
      ['TaskRunClaimed', 'TaskRunExpired'],
    );
    assert.deepEqual(
      harness.core.runs.query({ taskId: 'task-001' })
        .filter((run) => run.status === 'active')
        .map((run) => run.id),
      ['run-002'],
    );
  } finally {
    harness.cleanup();
  }
});

test('bounded lease sweep expires an active Run without advancing its Task', () => {
  const harness = createHarness({
    runEventIds: ['run-event-claim', 'run-event-expired'],
  });

  try {
    ingestTask(harness.core);
    claim(harness.core);
    harness.now.value = '2026-08-25T10:00:02.000Z';

    const result = harness.core.runs.sweepExpired({ limit: 25 });

    assert.deepEqual(result, { expiredCount: 1, hasMore: false });
    assert.equal(harness.core.query({ taskId: 'task-001' }).state, 'in_progress');
    assert.equal(harness.core.query({ taskId: 'task-001' }).version, 2);
    assert.equal(harness.core.runs.query({ runId: 'run-001' }).status, 'expired');
    assert.equal(harness.core.runs.query({ runId: 'run-001' }).version, 2);
    assert.deepEqual(
      harness.core.runs.query({ runId: 'run-001', includeEvents: true }).events
        .map((event) => event.type),
      ['TaskRunClaimed', 'TaskRunExpired'],
    );
  } finally {
    harness.cleanup();
  }
});

test('two Core connections cannot sweep the same expired Run twice', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'zylos-run-sweep-concurrency-'));
  const dbPath = path.join(directory, 'commitments.db');
  const first = createHarness({
    dbPath,
    runEventIds: ['run-event-claim', 'run-event-expired'],
  });
  let second;

  try {
    ingestTask(first.core);
    claim(first.core);
    first.now.value = '2026-08-25T10:00:02.000Z';
    second = createHarness({ dbPath, runEventIds: ['run-event-expired-second'] });
    second.now.value = first.now.value;

    assert.deepEqual(first.core.runs.sweepExpired({ limit: 1 }), {
      expiredCount: 1,
      hasMore: false,
    });
    assert.deepEqual(second.core.runs.sweepExpired({ limit: 1 }), {
      expiredCount: 0,
      hasMore: false,
    });
    assert.deepEqual(
      second.core.runs.query({ runId: 'run-001', includeEvents: true }).events
        .map((event) => event.type),
      ['TaskRunClaimed', 'TaskRunExpired'],
    );
  } finally {
    second?.core.close();
    first.core.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('sweep preserves exact receipts while old worker mutations fail closed', () => {
  const harness = createHarness({
    runEventIds: ['run-event-claim', 'run-event-heartbeat', 'run-event-expired'],
  });

  try {
    ingestTask(harness.core);
    const claimed = claim(harness.core);
    harness.now.value = '2026-08-25T10:00:00.500Z';
    const heartbeatCommand = {
      taskId: 'task-001',
      runId: 'run-001',
      workerId: 'worker-1',
      idempotencyKey: 'run-command:heartbeat:before-sweep',
      leaseMs: 1_000,
    };
    const heartbeat = harness.core.runs.heartbeat(heartbeatCommand, 1);
    harness.now.value = '2026-08-25T10:00:02.000Z';
    harness.core.runs.sweepExpired({ limit: 25 });

    assert.deepEqual(claim(harness.core), claimed);
    assert.deepEqual(harness.core.runs.heartbeat(heartbeatCommand, 1), heartbeat);
    assert.equal(harness.core.runs.query({ runId: 'run-001' }).version, 3);

    const mutations = [
      () => harness.core.runs.heartbeat({
        ...heartbeatCommand,
        idempotencyKey: 'run-command:heartbeat:after-sweep',
      }, 3),
      () => harness.core.runs.complete({
        taskId: 'task-001',
        runId: 'run-001',
        workerId: 'worker-1',
        idempotencyKey: 'run-command:complete:after-sweep',
      }, { runVersion: 3, taskVersion: 2 }),
      () => harness.core.runs.release({
        taskId: 'task-001',
        runId: 'run-001',
        workerId: 'worker-1',
        idempotencyKey: 'run-command:release:after-sweep',
      }, { runVersion: 3, taskVersion: 2 }),
    ];
    for (const mutate of mutations) {
      assert.throws(mutate, (error) => error?.code === 'LEASE_NOT_ACTIVE');
    }
    assert.equal(harness.core.query({ taskId: 'task-001' }).state, 'in_progress');
  } finally {
    harness.cleanup();
  }
});

test('lease sweep never processes more than its configured batch', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'zylos-run-sweep-bound-'));
  const now = { value: '2026-08-25T10:00:00.000Z' };
  const taskIds = ['task-001', 'task-002'];
  const taskEventIds = [
    'task-event-create-1', 'task-event-start-1',
    'task-event-create-2', 'task-event-start-2',
  ];
  const runIds = ['run-001', 'run-002'];
  const runEventIds = [
    'run-event-claim-1', 'run-event-claim-2',
    'run-event-expire-1', 'run-event-expire-2',
  ];
  const core = openCommitmentCore({
    dbPath: path.join(directory, 'commitments.db'),
    clock: () => now.value,
    idGenerator: () => taskIds.shift(),
    eventIdGenerator: () => taskEventIds.shift(),
    runIdGenerator: () => runIds.shift(),
    runEventIdGenerator: () => runEventIds.shift(),
  });

  try {
    for (const suffix of ['001', '002']) {
      const taskId = `task-${suffix}`;
      core.ingest({
        idempotencyKey: `source:${taskId}`,
        source: { channel: 'test', externalId: taskId, senderId: 'owner-1' },
        task: { title: taskId, ownerId: 'owner-1', assigneeId: 'agent-1' },
      });
      core.runs.claim({
        taskId,
        actorId: 'agent-1',
        workerId: `worker-${suffix}`,
        idempotencyKey: `run-command:claim:${suffix}`,
        leaseMs: 1_000,
      }, 1);
    }
    now.value = '2026-08-25T10:00:02.000Z';

    assert.deepEqual(core.runs.sweepExpired({ limit: 1 }), {
      expiredCount: 1,
      hasMore: true,
    });
    assert.equal(
      ['task-001', 'task-002']
        .map((taskId) => core.runs.query({ taskId, statuses: ['expired'] }).length)
        .reduce((sum, count) => sum + count, 0),
      1,
    );
    assert.deepEqual(core.runs.sweepExpired({ limit: 1 }), {
      expiredCount: 1,
      hasMore: false,
    });
    assert.deepEqual(core.runs.sweepExpired({ limit: 1 }), {
      expiredCount: 0,
      hasMore: false,
    });
  } finally {
    core.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('lease sweep rolls back the Run update when immutable Event persistence fails', () => {
  const harness = createHarness({
    runEventIds: ['run-event-claim', 'run-event-claim', 'run-event-expired-retry'],
  });

  try {
    ingestTask(harness.core);
    claim(harness.core);
    harness.now.value = '2026-08-25T10:00:02.000Z';

    assert.throws(
      () => harness.core.runs.sweepExpired({ limit: 1 }),
      /UNIQUE constraint failed/,
    );
    assert.equal(harness.core.runs.query({ runId: 'run-001' }).status, 'active');
    assert.deepEqual(
      harness.core.runs.query({ runId: 'run-001', includeEvents: true }).events
        .map((event) => event.type),
      ['TaskRunClaimed'],
    );

    assert.deepEqual(harness.core.runs.sweepExpired({ limit: 1 }), {
      expiredCount: 1,
      hasMore: false,
    });
    assert.equal(harness.core.runs.query({ runId: 'run-001' }).status, 'expired');
  } finally {
    harness.cleanup();
  }
});

test('complete ends the lease and submits for review; release returns work to ready', () => {
  const completeHarness = createHarness();
  const releaseHarness = createHarness();

  try {
    ingestTask(completeHarness.core);
    claim(completeHarness.core);
    completeHarness.now.value = '2026-08-25T10:00:00.500Z';
    const completed = completeHarness.core.runs.complete({
      taskId: 'task-001',
      runId: 'run-001',
      workerId: 'worker-1',
      idempotencyKey: 'run-command:complete:1',
    }, { runVersion: 1, taskVersion: 2 });

    assert.equal(completed.run.status, 'completed');
    assert.equal(completed.task.state, 'review');
    assert.equal(completed.task.version, 3);
    assert.equal(completed.event.type, 'TaskRunCompleted');
    assert.equal(completed.taskEvent.type, 'TaskSubmittedForReview');
    assert.notEqual(completed.task.state, 'done');
    assert.deepEqual(completeHarness.core.runs.complete({
      taskId: 'task-001',
      runId: 'run-001',
      workerId: 'worker-1',
      idempotencyKey: 'run-command:complete:1',
    }, { runVersion: 1, taskVersion: 2 }), completed);

    ingestTask(releaseHarness.core);
    claim(releaseHarness.core);
    const released = releaseHarness.core.runs.release({
      taskId: 'task-001',
      runId: 'run-001',
      workerId: 'worker-1',
      idempotencyKey: 'run-command:release:1',
    }, { runVersion: 1, taskVersion: 2 });

    assert.equal(released.run.status, 'released');
    assert.equal(released.task.state, 'ready');
    assert.equal(released.taskEvent.type, 'TaskRunReleased');
  } finally {
    completeHarness.cleanup();
    releaseHarness.cleanup();
  }
});

test('expired leases and mismatched task identities cannot complete or release', () => {
  for (const operation of ['complete', 'release']) {
    const harness = createHarness();
    try {
      ingestTask(harness.core);
      claim(harness.core);

      assert.throws(
        () => harness.core.runs[operation]({
          taskId: 'task-other',
          runId: 'run-001',
          workerId: 'worker-1',
          idempotencyKey: `run-command:${operation}:wrong-task`,
        }, { runVersion: 1, taskVersion: 2 }),
        (error) => error?.code === 'RUN_TASK_MISMATCH',
      );

      harness.now.value = '2026-08-25T10:00:02.000Z';
      assert.throws(
        () => harness.core.runs[operation]({
          taskId: 'task-001',
          runId: 'run-001',
          workerId: 'worker-1',
          idempotencyKey: `run-command:${operation}:expired`,
        }, { runVersion: 1, taskVersion: 2 }),
        (error) => error?.code === 'LEASE_EXPIRED',
      );
      assert.equal(harness.core.runs.query({ runId: 'run-001' }).status, 'active');
      assert.equal(harness.core.query({ taskId: 'task-001' }).state, 'in_progress');
    } finally {
      harness.cleanup();
    }
  }
});

test('run commands strictly validate identities, leases, versions, and roll back events together', () => {
  const harness = createHarness({
    taskEventIds: ['task-event-created', 'task-event-start-retry'],
    runEventIds: ['run-event-claim'],
  });

  try {
    ingestTask(harness.core);
    const invalidClaims = [
      [{ actorId: '' }, 1],
      [{ workerId: '' }, 1],
      [{ taskId: '' }, 1],
      [{ idempotencyKey: '' }, 1],
      [{ leaseMs: 0 }, 1],
      [{ leaseMs: 86_400_001 }, 1],
      [{ leaseMs: '1000' }, 1],
      [{ unexpected: true }, 1],
      [{}, 0],
    ];
    for (const [overrides, version] of invalidClaims) {
      assert.throws(() => claim(harness.core, overrides, version), TypeError);
    }
    assert.throws(
      () => claim(harness.core, {
        actorId: 'not-assignee',
        idempotencyKey: 'run-command:claim:forbidden',
      }),
      (error) => error?.code === 'FORBIDDEN',
    );

    // The duplicate Task event id makes the TaskStarted insert fail after the
    // Task/Run writes. The transaction must leave no Run or receipt behind.
    assert.throws(() => claim(harness.core), /UNIQUE constraint failed/);
    assert.equal(harness.core.query({ taskId: 'task-001' }).state, 'ready');
    assert.deepEqual(harness.core.runs.query({ taskId: 'task-001' }), []);

    const retry = claim(harness.core);
    assert.equal(retry.task.state, 'in_progress');
    assert.equal(retry.run.id, 'run-002');
  } finally {
    harness.cleanup();
  }
});

test('heartbeat Run, Event, and receipt roll back together when event persistence fails', () => {
  const harness = createHarness({
    runEventIds: ['run-event-claim', 'run-event-claim', 'run-event-heartbeat-retry'],
  });

  try {
    ingestTask(harness.core);
    claim(harness.core);
    harness.now.value = '2026-08-25T10:00:00.500Z';
    const heartbeat = {
      taskId: 'task-001',
      runId: 'run-001',
      workerId: 'worker-1',
      idempotencyKey: 'run-command:heartbeat:rollback',
      leaseMs: 2_000,
    };

    assert.throws(
      () => harness.core.runs.heartbeat(heartbeat, 1),
      /UNIQUE constraint failed/,
    );
    assert.equal(harness.core.runs.query({ runId: 'run-001' }).version, 1);
    assert.deepEqual(
      harness.core.runs.query({ runId: 'run-001', includeEvents: true }).events
        .map((event) => event.type),
      ['TaskRunClaimed'],
    );

    const retry = harness.core.runs.heartbeat(heartbeat, 1);
    assert.equal(retry.run.version, 2);
    assert.equal(retry.event.id, 'run-event-heartbeat-retry');
  } finally {
    harness.cleanup();
  }
});

test('Run queries keep identity modes mutually exclusive and validate bounded filters', () => {
  const harness = createHarness();

  try {
    const invalidQueries = [
      null,
      [],
      {},
      { runId: 'run-001', taskId: 'task-001' },
      { runId: 'run-001', includeEvents: 'yes' },
      { taskId: 'task-001', statuses: [] },
      { taskId: 'task-001', statuses: ['unknown'] },
      { taskId: 'task-001', limit: 0 },
      { taskId: 'task-001', limit: 101 },
      { taskId: 'task-001', unexpected: true },
    ];
    for (const query of invalidQueries) {
      assert.throws(() => harness.core.runs.query(query), TypeError);
    }
  } finally {
    harness.cleanup();
  }
});

test('lease sweep rejects malformed or unbounded requests before touching Runs', () => {
  const harness = createHarness();

  try {
    ingestTask(harness.core);
    claim(harness.core);
    harness.now.value = '2026-08-25T10:00:02.000Z';

    for (const options of [null, [], { limit: 0 }, { limit: 101 }, { limit: 1.5 }, {
      unexpected: true,
    }]) {
      assert.throws(() => harness.core.runs.sweepExpired(options), TypeError);
    }
    assert.equal(harness.core.runs.query({ runId: 'run-001' }).status, 'active');
  } finally {
    harness.cleanup();
  }
});
