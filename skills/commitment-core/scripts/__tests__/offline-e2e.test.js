import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { runCommitmentIntakeWorkerOnce } from '../../../comm-bridge/scripts/c4-intake-worker.js';
import { openCommitmentIntakeQueue } from '../../../comm-bridge/scripts/c4-db.js';
import { openCommitmentCore } from '../core.js';

const C4_RECEIVE = fileURLToPath(new URL(
  '../../../comm-bridge/scripts/c4-receive.js',
  import.meta.url,
));

function receiveTask(zylosDir, envelope) {
  const result = spawnSync(process.execPath, [
    C4_RECEIVE,
    '--channel', 'feishu',
    '--endpoint', 'oc_customer_chat|type:p2p|msg:om_offline_e2e',
    '--json',
    '--content', '请完成重点客户回访并提交验收',
    '--task-envelope-json', JSON.stringify(envelope),
  ], {
    encoding: 'utf8',
    env: { ...process.env, ZYLOS_DIR: zylosDir },
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const jsonLine = result.stdout.trim().split('\n').findLast((line) => line.startsWith('{'));
  assert.ok(jsonLine, result.stdout);
  return JSON.parse(jsonLine);
}

test('offline Feishu-shaped intake survives replay and closes only after human acceptance', () => {
  const zylosDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-task-offline-e2e-'));
  const c4DbPath = path.join(zylosDir, 'comm-bridge', 'c4.db');
  const coreDbPath = path.join(zylosDir, 'commitments', 'commitments.db');
  fs.mkdirSync(path.join(zylosDir, '.claude', 'skills', 'feishu'), { recursive: true });

  const envelope = {
    idempotencyKey: 'feishu:om_offline_e2e:task-intent',
    source: {
      channel: 'feishu',
      externalId: 'om_offline_e2e',
      senderId: 'ou_owner',
    },
    task: {
      title: '完成重点客户回访',
      description: '整理客户反馈并提交给发起人验收',
      ownerId: 'ou_owner',
      acceptorId: 'ou_owner',
      assigneeId: 'agent:yueran',
    },
  };

  let now = '2026-08-25T01:00:00.000Z';
  let taskEventIndex = 0;
  let runEventIndex = 0;
  const coreOptions = {
    dbPath: coreDbPath,
    clock: () => now,
    idGenerator: () => 'task-offline-e2e',
    eventIdGenerator: () => `task-event-offline-${++taskEventIndex}`,
    runIdGenerator: () => 'run-offline-e2e',
    runEventIdGenerator: () => `run-event-offline-${++runEventIndex}`,
  };
  let core;

  try {
    const received = receiveTask(zylosDir, envelope);
    const replayedBeforeWorker = receiveTask(zylosDir, envelope);
    assert.equal(received.action, 'queued');
    assert.equal(replayedBeforeWorker.action, 'replayed');
    assert.equal(fs.existsSync(coreDbPath), false, 'C4 intake must not depend on Core availability');

    core = openCommitmentCore(coreOptions);
    const intakeResult = runCommitmentIntakeWorkerOnce({
      dbPath: c4DbPath,
      core,
      clock: () => 2_000_000_000,
    });
    assert.equal(intakeResult.status, 'completed');
    assert.equal(intakeResult.coreResult.created, true);

    const ready = core.query({ taskId: 'task-offline-e2e' });
    assert.equal(ready.state, 'ready');

    const claimed = core.runs.claim({
      taskId: ready.id,
      actorId: 'agent:yueran',
      workerId: 'local-runtime:test-worker',
      idempotencyKey: 'local-runtime:run:claim:offline-e2e',
      leaseMs: 60_000,
    }, ready.version);
    assert.equal(claimed.task.state, 'in_progress');

    now = '2026-08-25T01:00:30.000Z';
    const delivered = core.runs.complete({
      taskId: ready.id,
      runId: claimed.run.id,
      workerId: 'local-runtime:test-worker',
      idempotencyKey: 'local-runtime:run:complete:offline-e2e',
    }, {
      runVersion: claimed.run.version,
      taskVersion: claimed.task.version,
    });
    assert.equal(delivered.run.status, 'completed');
    assert.equal(delivered.task.state, 'review');
    assert.notEqual(delivered.task.state, 'done');

    const accepted = core.command({
      type: 'AcceptTask',
      taskId: ready.id,
      actorId: 'ou_owner',
      idempotencyKey: 'feishu:om_accept_offline_e2e:task-command',
    }, delivered.task.version);
    assert.equal(accepted.task.state, 'done');

    assert.equal(receiveTask(zylosDir, envelope).action, 'replayed');
    assert.equal(
      runCommitmentIntakeWorkerOnce({ dbPath: c4DbPath, core }).status,
      'idle',
    );

    const queue = openCommitmentIntakeQueue({ dbPath: c4DbPath });
    try {
      assert.equal(queue.get({ idempotencyKey: envelope.idempotencyKey }).status, 'completed');
    } finally {
      queue.close();
    }

    core.close();
    core = openCommitmentCore({ dbPath: coreDbPath });
    const persisted = core.query({ taskId: ready.id, includeEvents: true });
    assert.equal(persisted.task.state, 'done');
    assert.deepEqual(
      persisted.events.map((event) => event.type),
      ['TaskCreated', 'TaskStarted', 'TaskSubmittedForReview', 'TaskAccepted'],
    );
    assert.deepEqual(
      core.runs.query({ runId: claimed.run.id, includeEvents: true }).events
        .map((event) => event.type),
      ['TaskRunClaimed', 'TaskRunCompleted'],
    );
  } finally {
    core?.close();
    fs.rmSync(zylosDir, { recursive: true, force: true });
  }
});
