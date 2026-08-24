import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { openCommitmentCore } from '../../../commitment-core/scripts/core.js';
import { openCommitmentIntakeQueue } from '../c4-db.js';
import { runCommitmentIntakeWorkerOnce } from '../c4-intake-worker.js';

function envelope(idempotencyKey = 'feishu:om_worker:task-intent') {
  return {
    idempotencyKey,
    source: { channel: 'feishu', externalId: 'om_worker' },
    task: { title: '由 worker 创建任务', ownerId: 'ou_owner' },
  };
}

function normalizedEnvelope(idempotencyKey = 'feishu:om_worker:task-intent') {
  return {
    idempotencyKey,
    source: { channel: 'feishu', externalId: 'om_worker', senderId: null },
    task: {
      title: '由 worker 创建任务',
      description: null,
      ownerId: 'ou_owner',
      acceptorId: 'ou_owner',
      assigneeId: null,
    },
  };
}

function seedIntake(dbPath, taskEnvelope = envelope(), clock = () => 6_000) {
  const intake = openCommitmentIntakeQueue({ dbPath, clock });
  try {
    return intake.recordInbound({
      conversation: { channel: 'feishu', content: 'worker intake' },
      envelope: taskEnvelope,
    });
  } finally {
    intake.close();
  }
}

test('claims one intake, ingests it through Commitment Core, and completes it', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'c4-intake-worker-'));
  const dbPath = path.join(directory, 'c4.db');
  const seeded = seedIntake(dbPath);
  const ingested = [];
  const core = {
    ingest(taskEnvelope) {
      ingested.push(taskEnvelope);
      return { created: true, task: { id: 'task-worker-1' } };
    },
  };

  try {
    const result = runCommitmentIntakeWorkerOnce({
      dbPath,
      core,
      clock: () => 6_001,
    });
    const intake = openCommitmentIntakeQueue({ dbPath, clock: () => 6_001 });
    const stored = intake.get({ idempotencyKey: envelope().idempotencyKey });
    intake.close();

    assert.equal(result.status, 'completed');
    assert.equal(result.intakeId, seeded.intake.id);
    assert.deepEqual(ingested, [normalizedEnvelope()]);
    assert.equal(stored.status, 'completed');
    assert.equal(stored.lastError, null);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('requeues ingest failures with delay and fails at the fixed retry limit', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'c4-intake-worker-retry-'));
  const dbPath = path.join(directory, 'c4.db');
  const taskEnvelope = envelope('feishu:om_worker_retry:task-intent');
  seedIntake(dbPath, taskEnvelope, () => 7_000);
  let now = 7_000;
  const core = {
    ingest() {
      throw new Error('Commitment Core temporarily unavailable');
    },
  };

  try {
    const first = runCommitmentIntakeWorkerOnce({ dbPath, core, clock: () => now });
    assert.deepEqual(first, {
      status: 'pending',
      intakeId: 1,
      retryCount: 1,
    });

    assert.deepEqual(
      runCommitmentIntakeWorkerOnce({ dbPath, core, clock: () => now }),
      { status: 'idle' },
    );

    now += 5;
    const second = runCommitmentIntakeWorkerOnce({ dbPath, core, clock: () => now });
    assert.equal(second.status, 'pending');
    assert.equal(second.retryCount, 2);

    now += 5;
    const third = runCommitmentIntakeWorkerOnce({ dbPath, core, clock: () => now });
    assert.equal(third.status, 'failed');
    assert.equal(third.retryCount, 3);

    const intake = openCommitmentIntakeQueue({ dbPath, clock: () => now });
    const stored = intake.get({ idempotencyKey: taskEnvelope.idempotencyKey });
    intake.close();
    assert.equal(stored.status, 'failed');
    assert.equal(stored.retryCount, 3);
    assert.match(stored.lastError, /temporarily unavailable/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('terminal failed intake rejects source replay until an operator explicitly retries it', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'c4-intake-worker-redrive-'));
  const dbPath = path.join(directory, 'c4.db');
  const taskEnvelope = envelope('feishu:om_worker_redrive:task-intent');
  let now = 9_000;
  seedIntake(dbPath, taskEnvelope, () => now);
  const failingCore = {
    ingest() {
      throw new Error('Commitment Core unavailable until redelivery');
    },
  };

  try {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const result = runCommitmentIntakeWorkerOnce({
        dbPath,
        core: failingCore,
        clock: () => now,
      });
      now += 5;
      if (attempt < 2) assert.equal(result.status, 'pending');
      else assert.equal(result.status, 'failed');
    }

    const intake = openCommitmentIntakeQueue({ dbPath, clock: () => now });
    const replay = intake.recordInbound({
      conversation: { channel: 'feishu', content: 'source redelivered task' },
      envelope: taskEnvelope,
    });
    assert.equal(replay.created, false);
    assert.equal(replay.intake.status, 'failed');
    assert.equal(replay.intake.retryCount, 3);

    const retried = intake.retryFailed({ idempotencyKey: taskEnvelope.idempotencyKey });
    intake.close();
    assert.equal(retried.status, 'pending');
    assert.equal(retried.retryCount, 0);
    assert.equal(retried.retryGeneration, 1);
    assert.equal(retried.lastError, null);

    const recovered = runCommitmentIntakeWorkerOnce({
      dbPath,
      core: { ingest: () => ({ created: true, task: { id: 'task-redriven' } }) },
      clock: () => now,
    });
    assert.equal(recovered.status, 'completed');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('replays a stale post-ingest crash without creating a second task', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'c4-intake-worker-crash-'));
  const dbPath = path.join(directory, 'c4.db');
  const taskEnvelope = envelope('feishu:om_worker_crash:task-intent');
  seedIntake(dbPath, taskEnvelope, () => 8_000);
  let now = 8_000;
  let generatedTasks = 0;
  const core = openCommitmentCore({
    dbPath: path.join(directory, 'commitments.db'),
    clock: () => '2026-08-25T00:00:00.000Z',
    idGenerator() {
      generatedTasks += 1;
      return `task-crash-${generatedTasks}`;
    },
  });

  try {
    assert.throws(
      () => runCommitmentIntakeWorkerOnce({
        dbPath,
        core,
        clock: () => now,
        afterIngest() {
          throw new Error('simulated crash before queue completion');
        },
      }),
      /simulated crash/,
    );

    const afterCrash = openCommitmentIntakeQueue({ dbPath, clock: () => now });
    assert.equal(
      afterCrash.get({ idempotencyKey: taskEnvelope.idempotencyKey }).status,
      'processing',
    );
    afterCrash.close();

    now += 61;
    const recovered = runCommitmentIntakeWorkerOnce({ dbPath, core, clock: () => now });

    assert.equal(recovered.status, 'completed');
    assert.equal(recovered.coreResult.created, false);
    assert.equal(generatedTasks, 1);
    assert.equal(core.query({ taskId: 'task-crash-1' }).title, taskEnvelope.task.title);
  } finally {
    core.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
