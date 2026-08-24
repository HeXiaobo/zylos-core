import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { openCommitmentCore } from '../core.js';

function createHarness() {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'zylos-commitment-core-'));
  const core = openCommitmentCore({
    dbPath: path.join(directory, 'commitments.db'),
    clock: () => '2026-08-24T10:00:00.000Z',
    idGenerator: () => 'task-001',
  });

  return {
    core,
    cleanup() {
      core.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

test('replaying one source creates exactly one ready task', () => {
  const harness = createHarness();

  try {
    const envelope = {
      idempotencyKey: 'lark:om_123:task-intent',
      source: {
        channel: 'lark',
        externalId: 'om_123',
        senderId: 'ou_owner',
      },
      task: {
        title: '整理客户跟进报告',
        ownerId: 'ou_owner',
        acceptorId: 'ou_owner',
        assigneeId: 'agent:yueran',
      },
    };

    const first = harness.core.ingest(envelope);
    const replay = harness.core.ingest(envelope);
    const task = harness.core.query({ taskId: 'task-001' });

    assert.equal(first.created, true);
    assert.equal(replay.created, false);
    assert.equal(replay.task.id, first.task.id);
    assert.deepEqual(task, {
      id: 'task-001',
      title: '整理客户跟进报告',
      description: null,
      state: 'ready',
      ownerId: 'ou_owner',
      acceptorId: 'ou_owner',
      assigneeId: 'agent:yueran',
      version: 1,
      createdAt: '2026-08-24T10:00:00.000Z',
      updatedAt: '2026-08-24T10:00:00.000Z',
    });
  } finally {
    harness.cleanup();
  }
});

test('reusing an idempotency key for different task content is rejected', () => {
  const harness = createHarness();

  try {
    const envelope = {
      idempotencyKey: 'lark:om_456:task-intent',
      source: {
        channel: 'lark',
        externalId: 'om_456',
        senderId: 'ou_owner',
      },
      task: {
        title: '生成第一份报告',
        ownerId: 'ou_owner',
      },
    };
    harness.core.ingest(envelope);

    assert.throws(
      () => harness.core.ingest({
        ...envelope,
        task: { ...envelope.task, title: '偷偷替换成另一项任务' },
      }),
      (error) => error?.code === 'IDEMPOTENCY_CONFLICT',
    );
  } finally {
    harness.cleanup();
  }
});

test('the default database lives under ZYLOS_DIR when it is configured', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'zylos-commitment-path-'));
  const previousHome = process.env.HOME;
  const previousZylosDir = process.env.ZYLOS_DIR;
  const zylosDir = path.join(directory, 'custom-zylos');
  process.env.HOME = path.join(directory, 'isolated-home');
  process.env.ZYLOS_DIR = zylosDir;

  try {
    const moduleUrl = new URL(`../core.js?default-path-test=${Date.now()}`, import.meta.url);
    const { openCommitmentCore: openDefaultCore } = await import(moduleUrl);
    const core = openDefaultCore();
    core.close();

    assert.equal(
      existsSync(path.join(zylosDir, 'commitments', 'commitments.db')),
      true,
    );
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousZylosDir === undefined) delete process.env.ZYLOS_DIR;
    else process.env.ZYLOS_DIR = previousZylosDir;
    rmSync(directory, { recursive: true, force: true });
  }
});
