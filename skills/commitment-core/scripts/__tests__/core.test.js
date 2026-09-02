import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { openCommitmentCore } from '../core.js';

const CORE_TEST_PREFIXES = [
  'zylos-commitment-core-',
  'zylos-core-options-',
  'zylos-commitment-path-',
];

function removeCoreTestDirectory(directory) {
  assert.equal(path.dirname(directory), os.tmpdir());
  assert.equal(CORE_TEST_PREFIXES.some(prefix => path.basename(directory).startsWith(prefix)), true);
  rmSync(directory, { recursive: true, force: true });
}

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
      removeCoreTestDirectory(directory);
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
      dueAt: null,
      reminderMinutesBeforeDue: null,
      version: 1,
      createdAt: '2026-08-24T10:00:00.000Z',
      updatedAt: '2026-08-24T10:00:00.000Z',
    });
  } finally {
    harness.cleanup();
  }
});

test('unknown constructor options fail before the default database path is touched', () => {
  const testPrefix = 'zylos-core-options-';
  const directory = mkdtempSync(path.join(os.tmpdir(), testPrefix));
  const isolatedDefaultRoot = path.join(directory, 'must-not-be-created');
  const previousZylosDir = process.env.ZYLOS_DIR;
  let unexpectedCore;

  process.env.ZYLOS_DIR = isolatedDefaultRoot;
  try {
    assert.throws(
      () => {
        unexpectedCore = openCommitmentCore({
          dbPath: path.join(directory, 'explicit.db'),
          database: ':memory:',
        });
      },
      /unsupported Commitment Core option: database/,
    );
    assert.equal(existsSync(isolatedDefaultRoot), false);
    assert.equal(existsSync(path.join(directory, 'explicit.db')), false);
  } finally {
    unexpectedCore?.close();
    if (previousZylosDir === undefined) delete process.env.ZYLOS_DIR;
    else process.env.ZYLOS_DIR = previousZylosDir;
    removeCoreTestDirectory(directory);
  }
});

test('normalizes an optional deadline as a channel-neutral Core fact', () => {
  const harness = createHarness();

  try {
    const result = harness.core.ingest({
      idempotencyKey: 'lark:om_due_at:task-intent',
      source: {
        channel: 'lark',
        externalId: 'om_due_at',
        senderId: 'ou_owner',
      },
      task: {
        title: '在截止时间前交付',
        ownerId: 'ou_owner',
        dueAt: '2026-08-28T18:00:00+08:00',
      },
    });

    assert.equal(result.task.dueAt, '2026-08-28T10:00:00.000Z');
    assert.equal(harness.core.query({ taskId: result.task.id }).dueAt, result.task.dueAt);
    assert.throws(() => harness.core.ingest({
      idempotencyKey: 'lark:om_bad_due_at:task-intent',
      source: { channel: 'lark', externalId: 'om_bad_due_at', senderId: 'ou_owner' },
      task: { title: '非法截止时间', ownerId: 'ou_owner', dueAt: 'tomorrow' },
    }), /RFC 3339/);
  } finally {
    harness.cleanup();
  }
});

test('persists a reminder in minutes before the canonical deadline', () => {
  const harness = createHarness();

  try {
    const result = harness.core.ingest({
      idempotencyKey: 'lark:om_due_reminder:task-intent',
      source: {
        channel: 'lark',
        externalId: 'om_due_reminder',
        senderId: 'ou_owner',
      },
      task: {
        title: '在提醒后完成验收',
        ownerId: 'ou_owner',
        dueAt: '2026-08-28T18:00:00+08:00',
        reminderMinutesBeforeDue: 60,
      },
    });

    assert.equal(result.task.reminderMinutesBeforeDue, 60);
    assert.equal(
      harness.core.query({ taskId: result.task.id }).reminderMinutesBeforeDue,
      60,
    );
  } finally {
    harness.cleanup();
  }
});

test('requires a canonical deadline before accepting a reminder', () => {
  const harness = createHarness();

  try {
    assert.throws(() => harness.core.ingest({
      idempotencyKey: 'lark:om_reminder_without_due:task-intent',
      source: {
        channel: 'lark',
        externalId: 'om_reminder_without_due',
        senderId: 'ou_owner',
      },
      task: {
        title: '没有截止时间的提醒',
        ownerId: 'ou_owner',
        reminderMinutesBeforeDue: 60,
      },
    }), /requires task\.dueAt/);
  } finally {
    harness.cleanup();
  }
});

test('rejects a reminder that is not a non-negative integer', () => {
  const harness = createHarness();

  try {
    for (const reminderMinutesBeforeDue of [-1, 1.5, '60']) {
      assert.throws(() => harness.core.ingest({
        idempotencyKey: `lark:om_bad_reminder_${reminderMinutesBeforeDue}:task-intent`,
        source: {
          channel: 'lark',
          externalId: `om_bad_reminder_${reminderMinutesBeforeDue}`,
          senderId: 'ou_owner',
        },
        task: {
          title: '非法提醒',
          ownerId: 'ou_owner',
          dueAt: '2026-08-28T18:00:00+08:00',
          reminderMinutesBeforeDue,
        },
      }), /non-negative safe integer/);
    }
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
    removeCoreTestDirectory(directory);
  }
});
