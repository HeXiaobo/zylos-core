import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import Database from 'better-sqlite3';

import { openCommitmentCore } from '../core.js';

function createHarness({ runEventIdGenerator } = {}) {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'zylos-run-command-policy-'));
  const dbPath = path.join(directory, 'commitments.db');
  const now = { value: '2026-08-25T10:00:00.000Z' };
  let taskEvent = 0;
  let runEvent = 0;
  const core = openCommitmentCore({
    dbPath,
    clock: () => now.value,
    idGenerator: () => 'task-001',
    eventIdGenerator: () => `task-event-${++taskEvent}`,
    runIdGenerator: () => 'run-001',
    runEventIdGenerator: runEventIdGenerator ?? (() => `run-event-${++runEvent}`),
  });

  return {
    core,
    dbPath,
    now,
    cleanup() {
      core.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

function ingestAndClaim(core) {
  core.ingest({
    idempotencyKey: 'source:task-001',
    source: { channel: 'test', externalId: 'task-001', senderId: 'owner-1' },
    task: {
      title: '执行并验收任务',
      ownerId: 'owner-1',
      acceptorId: 'acceptor-1',
      assigneeId: 'agent-1',
    },
  });
  return core.runs.claim({
    taskId: 'task-001',
    actorId: 'agent-1',
    workerId: 'worker-1',
    idempotencyKey: 'run-command:claim:1',
    leaseMs: 10_000,
  }, 1);
}

test('direct SubmitForReview fails closed while an active Run owns execution', () => {
  const harness = createHarness();

  try {
    ingestAndClaim(harness.core);

    assert.throws(
      () => harness.core.command({
        type: 'SubmitForReview',
        taskId: 'task-001',
        actorId: 'agent-1',
        idempotencyKey: 'command:submit:blocked',
      }, 2),
      (error) => error?.code === 'ACTIVE_RUN_CONFLICT'
        && /runs\.complete/.test(error.message),
    );
    assert.equal(harness.core.query({ taskId: 'task-001' }).state, 'in_progress');
    assert.equal(harness.core.runs.query({ runId: 'run-001' }).status, 'active');
    assert.deepEqual(
      harness.core.query({ taskId: 'task-001', includeEvents: true }).events
        .map((event) => event.type),
      ['TaskCreated', 'TaskStarted'],
    );
  } finally {
    harness.cleanup();
  }
});

test('owner or acceptor cancellation atomically interrupts the active Run and replays once', () => {
  for (const actorId of ['owner-1', 'acceptor-1']) {
    const harness = createHarness();
    try {
      ingestAndClaim(harness.core);
      const command = {
        type: 'CancelTask',
        taskId: 'task-001',
        actorId,
        idempotencyKey: `command:cancel:${actorId}`,
      };
      const first = harness.core.command(command, 2);
      const replay = harness.core.command(command, 2);

      assert.deepEqual(replay, first);
      assert.equal(first.task.state, 'cancelled');
      const runHistory = harness.core.runs.query({
        runId: 'run-001', includeEvents: true,
      });
      assert.equal(runHistory.run.status, 'interrupted');
      assert.equal(runHistory.run.version, 2);
      assert.deepEqual(
        runHistory.events.map((event) => event.type),
        ['TaskRunClaimed', 'TaskRunInterrupted'],
      );

      const attempts = [
        () => harness.core.runs.heartbeat({
          taskId: 'task-001', runId: 'run-001', workerId: 'worker-1',
          idempotencyKey: 'run-command:heartbeat:after-cancel', leaseMs: 1_000,
        }, 2),
        () => harness.core.runs.complete({
          taskId: 'task-001', runId: 'run-001', workerId: 'worker-1',
          idempotencyKey: 'run-command:complete:after-cancel',
        }, { runVersion: 2, taskVersion: 3 }),
        () => harness.core.runs.release({
          taskId: 'task-001', runId: 'run-001', workerId: 'worker-1',
          idempotencyKey: 'run-command:release:after-cancel',
        }, { runVersion: 2, taskVersion: 3 }),
      ];
      for (const attempt of attempts) {
        assert.throws(attempt, (error) => error?.code === 'LEASE_NOT_ACTIVE');
      }

      assert.equal(
        harness.core.runs.query({ runId: 'run-001', includeEvents: true }).events.length,
        2,
      );
    } finally {
      harness.cleanup();
    }
  }
});

test('heartbeat rejects a legacy split-brain Task but exact receipt replay stays stable', () => {
  const harness = createHarness();

  try {
    ingestAndClaim(harness.core);
    const heartbeat = {
      taskId: 'task-001',
      runId: 'run-001',
      workerId: 'worker-1',
      idempotencyKey: 'run-command:heartbeat:before-split',
      leaseMs: 20_000,
    };
    const first = harness.core.runs.heartbeat(heartbeat, 1);

    const database = new Database(harness.dbPath);
    try {
      database.prepare(`
        UPDATE commitment_tasks
        SET state = 'review', version = 3
        WHERE id = 'task-001'
      `).run();
    } finally {
      database.close();
    }

    assert.deepEqual(harness.core.runs.heartbeat(heartbeat, 1), first);
    assert.throws(
      () => harness.core.runs.heartbeat({
        ...heartbeat,
        idempotencyKey: 'run-command:heartbeat:after-split',
      }, 2),
      (error) => error?.code === 'INVALID_TRANSITION',
    );
    assert.equal(harness.core.runs.query({ runId: 'run-001' }).version, 2);
  } finally {
    harness.cleanup();
  }
});

test('CancelTask rolls Task, Run, Run Event, and command receipt back together', () => {
  const runEventIds = ['run-event-claim', 'run-event-claim', 'run-event-interrupted-retry'];
  const harness = createHarness({ runEventIdGenerator: () => runEventIds.shift() });

  try {
    ingestAndClaim(harness.core);
    const command = {
      type: 'CancelTask',
      taskId: 'task-001',
      actorId: 'owner-1',
      idempotencyKey: 'command:cancel:rollback',
    };

    assert.throws(() => harness.core.command(command, 2), /UNIQUE constraint failed/);
    assert.equal(harness.core.query({ taskId: 'task-001' }).state, 'in_progress');
    assert.equal(harness.core.runs.query({ runId: 'run-001' }).status, 'active');
    assert.deepEqual(
      harness.core.runs.query({ runId: 'run-001', includeEvents: true }).events
        .map((event) => event.type),
      ['TaskRunClaimed'],
    );

    const retry = harness.core.command(command, 2);
    assert.equal(retry.task.state, 'cancelled');
    assert.equal(harness.core.runs.query({ runId: 'run-001' }).status, 'interrupted');
  } finally {
    harness.cleanup();
  }
});

test('opening the previous Task Run schema migrates it before interrupting a Run', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'zylos-run-status-migration-'));
  const dbPath = path.join(directory, 'commitments.db');
  const database = new Database(dbPath);
  database.exec(`
    CREATE TABLE commitment_tasks (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT,
      state TEXT NOT NULL CHECK (
        state IN ('ready', 'in_progress', 'review', 'done', 'cancelled')
      ),
      owner_id TEXT NOT NULL,
      acceptor_id TEXT NOT NULL,
      assignee_id TEXT,
      version INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    INSERT INTO commitment_tasks VALUES (
      'task-001', 'legacy active run', NULL, 'in_progress',
      'owner-1', 'acceptor-1', 'agent-1', 2,
      '2026-08-25T09:00:00.000Z', '2026-08-25T09:01:00.000Z'
    );
    CREATE TABLE commitment_task_runs (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      actor_id TEXT NOT NULL,
      worker_id TEXT NOT NULL,
      status TEXT NOT NULL CHECK (
        status IN ('active', 'completed', 'released', 'expired')
      ),
      version INTEGER NOT NULL,
      lease_expires_at TEXT NOT NULL,
      last_heartbeat_at TEXT NOT NULL,
      started_at TEXT NOT NULL,
      ended_at TEXT,
      FOREIGN KEY (task_id) REFERENCES commitment_tasks(id) ON DELETE RESTRICT
    );
    INSERT INTO commitment_task_runs VALUES (
      'run-001', 'task-001', 'agent-1', 'worker-1', 'active', 1,
      '2026-08-25T11:00:00.000Z', '2026-08-25T09:01:00.000Z',
      '2026-08-25T09:01:00.000Z', NULL
    );
    CREATE TABLE commitment_run_events (
      id TEXT PRIMARY KEY,
      event_type TEXT NOT NULL,
      run_id TEXT NOT NULL,
      task_id TEXT NOT NULL,
      worker_id TEXT NOT NULL,
      run_version INTEGER NOT NULL,
      task_version INTEGER NOT NULL,
      lease_expires_at TEXT NOT NULL,
      occurred_at TEXT NOT NULL,
      FOREIGN KEY (run_id) REFERENCES commitment_task_runs(id) ON DELETE RESTRICT,
      FOREIGN KEY (task_id) REFERENCES commitment_tasks(id) ON DELETE RESTRICT
    );
    INSERT INTO commitment_run_events VALUES (
      'run-event-claim', 'TaskRunClaimed', 'run-001', 'task-001', 'worker-1',
      1, 2, '2026-08-25T11:00:00.000Z', '2026-08-25T09:01:00.000Z'
    );
    CREATE TABLE commitment_run_commands (
      idempotency_key TEXT PRIMARY KEY,
      operation TEXT NOT NULL,
      request_fingerprint TEXT NOT NULL,
      task_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      result_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (task_id) REFERENCES commitment_tasks(id) ON DELETE RESTRICT,
      FOREIGN KEY (run_id) REFERENCES commitment_task_runs(id) ON DELETE RESTRICT
    );
    INSERT INTO commitment_run_commands VALUES (
      'legacy:claim', 'claim', 'fingerprint', 'task-001', 'run-001', '{}',
      '2026-08-25T09:01:00.000Z'
    );
  `);
  database.close();

  let taskEvent = 0;
  const core = openCommitmentCore({
    dbPath,
    clock: () => '2026-08-25T10:00:00.000Z',
    eventIdGenerator: () => `task-event-${++taskEvent}`,
    runEventIdGenerator: () => 'run-event-interrupted',
  });

  try {
    const result = core.command({
      type: 'CancelTask',
      taskId: 'task-001',
      actorId: 'owner-1',
      idempotencyKey: 'command:cancel:legacy-run',
    }, 2);

    assert.equal(result.task.state, 'cancelled');
    const runHistory = core.runs.query({ runId: 'run-001', includeEvents: true });
    assert.equal(runHistory.run.status, 'interrupted');
    assert.deepEqual(
      runHistory.events.map((event) => event.type),
      ['TaskRunClaimed', 'TaskRunInterrupted'],
    );
  } finally {
    core.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
