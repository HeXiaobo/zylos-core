import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const originalZylosDir = process.env.ZYLOS_DIR;
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'c4-intake-db-'));
process.env.ZYLOS_DIR = tempDir;

const c4db = await import(new URL('../c4-db.js', import.meta.url));

if (originalZylosDir === undefined) delete process.env.ZYLOS_DIR;
else process.env.ZYLOS_DIR = originalZylosDir;

process.on('exit', () => {
  try { c4db.close(); } catch { /* already closed */ }
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function taskEnvelope(overrides = {}) {
  return {
    idempotencyKey: 'feishu:om_001:task-intent',
    source: {
      channel: 'feishu',
      externalId: 'om_001',
      senderId: 'ou_owner',
    },
    task: {
      title: '跟进客户续约',
      ownerId: 'ou_owner',
    },
    ...overrides,
  };
}

function normalizedTaskEnvelope(overrides = {}) {
  const raw = taskEnvelope(overrides);
  return {
    idempotencyKey: raw.idempotencyKey,
    source: {
      channel: raw.source.channel,
      externalId: raw.source.externalId,
      senderId: raw.source.senderId ?? null,
    },
    task: {
      title: raw.task.title,
      description: raw.task.description ?? null,
      ownerId: raw.task.ownerId,
      acceptorId: raw.task.acceptorId ?? raw.task.ownerId,
      assigneeId: raw.task.assigneeId ?? null,
    },
  };
}

test('records one inbound conversation and commitment intake atomically', () => {
  const intake = c4db.openCommitmentIntakeQueue({ clock: () => 1_000 });

  const result = intake.recordInbound({
    conversation: {
      channel: 'feishu',
      endpointId: 'chat_001',
      content: '请创建续约跟进任务',
      status: 'pending',
      priority: 2,
      requireIdle: true,
    },
    envelope: taskEnvelope(),
  });

  assert.equal(result.created, true);
  assert.equal(result.conversation.id, 1);
  assert.equal(result.conversation.status, 'pending');
  assert.equal(result.intake.conversationId, 1);
  assert.equal(result.intake.idempotencyKey, 'feishu:om_001:task-intent');
  assert.equal(result.intake.status, 'pending');
  assert.equal(result.intake.retryCount, 0);
  assert.equal(result.intake.availableAt, 1_000);
  assert.deepEqual(result.intake.envelope, normalizedTaskEnvelope());

  assert.deepEqual(
    intake.get({ idempotencyKey: 'feishu:om_001:task-intent' }),
    result.intake,
  );
});

test('rolls back the conversation when the intake insert cannot complete', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'c4-intake-atomic-'));
  const dbPath = path.join(directory, 'c4.db');

  try {
    const failing = c4db.openCommitmentIntakeQueue({
      dbPath,
      clock: () => 2_000,
      beforeQueueInsert() {
        throw new Error('simulated queue write failure');
      },
    });

    assert.throws(
      () => failing.recordInbound({
        conversation: {
          channel: 'feishu',
          endpointId: 'chat_atomic',
          content: 'atomic intake',
        },
        envelope: taskEnvelope({
          idempotencyKey: 'feishu:om_atomic:task-intent',
        }),
      }),
      /simulated queue write failure/,
    );
    failing.close();

    const retry = c4db.openCommitmentIntakeQueue({ dbPath, clock: () => 2_001 });
    const result = retry.recordInbound({
      conversation: {
        channel: 'feishu',
        endpointId: 'chat_atomic',
        content: 'atomic intake',
      },
      envelope: taskEnvelope({
        idempotencyKey: 'feishu:om_atomic:task-intent',
      }),
    });

    assert.equal(result.conversation.id, 1);
    assert.equal(result.intake.conversationId, 1);
    retry.close();
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('replaying an idempotency key does not duplicate conversation or intake', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'c4-intake-replay-'));
  const intake = c4db.openCommitmentIntakeQueue({
    dbPath: path.join(directory, 'c4.db'),
    clock: () => 3_000,
  });
  const input = {
    conversation: {
      channel: 'feishu',
      endpointId: 'chat_replay',
      content: 'replayed event',
    },
    envelope: taskEnvelope({
      idempotencyKey: 'feishu:om_replay:task-intent',
    }),
  };

  try {
    const first = intake.recordInbound(input);
    const replay = intake.recordInbound(input);

    assert.equal(first.created, true);
    assert.equal(replay.created, false);
    assert.equal(replay.conversation.id, first.conversation.id);
    assert.deepEqual(replay.intake, first.intake);
  } finally {
    intake.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('treats reordered properties as the same normalized idempotent payload', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'c4-intake-normalized-replay-'));
  const intake = c4db.openCommitmentIntakeQueue({
    dbPath: path.join(directory, 'c4.db'),
    clock: () => 4_000,
  });
  const idempotencyKey = 'feishu:om_normalized:task-intent';

  try {
    const first = intake.recordInbound({
      conversation: { channel: 'feishu', content: 'normalized event' },
      envelope: {
        idempotencyKey,
        source: { channel: 'feishu', externalId: 'om_normalized' },
        task: { title: '规范化重放', ownerId: 'ou_owner' },
      },
    });
    const replay = intake.recordInbound({
      conversation: { channel: 'feishu', content: 'normalized event' },
      envelope: {
        task: {
          assigneeId: null,
          ownerId: 'ou_owner',
          title: '规范化重放',
          description: null,
          acceptorId: 'ou_owner',
        },
        source: {
          senderId: null,
          externalId: 'om_normalized',
          channel: 'feishu',
        },
        idempotencyKey,
      },
    });

    assert.equal(first.created, true);
    assert.equal(replay.created, false);
    assert.equal(replay.conversation.id, first.conversation.id);
  } finally {
    intake.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('rejects a reused idempotency key with different normalized payload', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'c4-intake-conflict-'));
  const intake = c4db.openCommitmentIntakeQueue({
    dbPath: path.join(directory, 'c4.db'),
    clock: () => 4_500,
  });
  const idempotencyKey = 'feishu:om_conflict:task-intent';
  const original = {
    conversation: { channel: 'feishu', content: 'original event' },
    envelope: taskEnvelope({ idempotencyKey }),
  };

  try {
    const first = intake.recordInbound(original);
    assert.throws(
      () => intake.recordInbound({
        conversation: { channel: 'feishu', content: 'conflicting event' },
        envelope: taskEnvelope({
          idempotencyKey,
          task: { title: '替换后的任务', ownerId: 'ou_owner' },
        }),
      }),
      (error) => error?.code === 'IDEMPOTENCY_CONFLICT',
    );

    const replay = intake.recordInbound(original);
    assert.equal(replay.created, false);
    assert.equal(replay.conversation.id, first.conversation.id);
  } finally {
    intake.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('atomically claims one available intake across queue instances', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'c4-intake-claim-'));
  const dbPath = path.join(directory, 'c4.db');
  const firstWorker = c4db.openCommitmentIntakeQueue({ dbPath, clock: () => 5_000 });
  const secondWorker = c4db.openCommitmentIntakeQueue({ dbPath, clock: () => 5_000 });

  try {
    firstWorker.recordInbound({
      conversation: { channel: 'feishu', content: 'claim exactly once' },
      envelope: taskEnvelope({
        idempotencyKey: 'feishu:om_claim:task-intent',
      }),
    });

    const claimed = firstWorker.claimNext({ staleAfterSeconds: 60 });
    const lostRace = secondWorker.claimNext({ staleAfterSeconds: 60 });

    assert.equal(claimed.status, 'processing');
    assert.equal(claimed.idempotencyKey, 'feishu:om_claim:task-intent');
    assert.equal(lostRace, null);
  } finally {
    firstWorker.close();
    secondWorker.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
