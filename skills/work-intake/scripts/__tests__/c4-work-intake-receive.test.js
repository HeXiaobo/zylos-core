import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import Database from '../../../commitment-core/node_modules/better-sqlite3/lib/index.js';

const C4_RECEIVE = fileURLToPath(new URL(
  '../../../comm-bridge/scripts/c4-receive.js',
  import.meta.url,
));

function inbound(text, messageId) {
  return {
    source: {
      channel: 'feishu',
      messageId,
      conversationId: 'oc_work_intake',
      conversationType: 'direct',
      threadId: null,
    },
    sender: { id: 'ou_sender', kind: 'human' },
    text,
    intentRevision: 1,
    receivedAt: '2026-08-25T02:00:00.000Z',
    timeZone: 'Asia/Shanghai',
    people: [],
  };
}

function receive(zylosDir, envelope) {
  const result = spawnSync(process.execPath, [
    C4_RECEIVE,
    '--channel', 'feishu',
    '--endpoint', `oc_work_intake|type:p2p|msg:${envelope.source.messageId}`,
    '--json',
    '--work-intake-envelope-json', JSON.stringify(envelope),
    '--content', `[Feishu DM] Sender said: ${envelope.text}`,
  ], {
    encoding: 'utf8',
    env: { ...process.env, ZYLOS_DIR: zylosDir },
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const jsonLine = result.stdout.trim().split('\n').findLast((line) => line.startsWith('{'));
  assert.ok(jsonLine, result.stdout);
  return JSON.parse(jsonLine);
}

function resolveConfirmation(zylosDir, {
  sourceKey,
  action,
  actorId = 'ou_sender',
  channel = 'feishu',
}) {
  const result = spawnSync(process.execPath, [
    C4_RECEIVE,
    '--channel', channel,
    '--endpoint', 'oc_work_intake|type:p2p|msg:om_confirm',
    '--json',
    '--work-intake-confirmation-json', JSON.stringify({ sourceKey, action, actorId }),
    '--content', '[Feishu WorkIntake confirmation]',
  ], {
    encoding: 'utf8',
    env: { ...process.env, ZYLOS_DIR: zylosDir },
  });
  const jsonLine = result.stdout.trim().split('\n').findLast((line) => line.startsWith('{'));
  return { result, response: jsonLine ? JSON.parse(jsonLine) : null };
}

function withZylosDir(run) {
  const zylosDir = fs.mkdtempSync(path.join(os.tmpdir(), 'c4-work-intake-'));
  fs.mkdirSync(path.join(zylosDir, '.claude', 'skills', 'feishu'), { recursive: true });
  try {
    run(zylosDir);
  } finally {
    fs.rmSync(zylosDir, { recursive: true, force: true });
  }
}

test('a clear assignment atomically queues one durable Commitment intake', () => {
  withZylosDir((zylosDir) => {
    const envelope = inbound('请玥然在周五前整理 A 客户的跟进记录', 'om_create');
    const first = receive(zylosDir, envelope);
    const replay = receive(zylosDir, envelope);

    assert.equal(first.action, 'queued');
    assert.equal(first.workIntake.decision, 'create_task');
    assert.equal(first.workIntake.replayed, false);
    assert.equal(replay.action, 'already_pending');
    assert.equal(replay.workIntake.replayed, true);

    const database = new Database(path.join(zylosDir, 'comm-bridge', 'c4.db'));
    try {
      const rows = database.prepare(`
        SELECT idempotency_key, payload_json
        FROM commitment_intake_queue
      `).all();
      assert.equal(rows.length, 1);
      assert.equal(rows[0].idempotency_key, 'feishu:om_create:work-intake:r1');
      const taskEnvelope = JSON.parse(rows[0].payload_json);
      assert.equal(taskEnvelope.task.ownerId, 'ou_sender');
      assert.equal(taskEnvelope.task.acceptorId, 'ou_sender');
      assert.equal(taskEnvelope.task.assigneeId, 'agent:yueran');
    } finally {
      database.close();
    }
  });
});

test('an ambiguous request is held for confirmation and is not routed or created', () => {
  withZylosDir((zylosDir) => {
    const envelope = inbound('跟一下这个事', 'om_confirm');
    const first = receive(zylosDir, envelope);
    const replay = receive(zylosDir, envelope);

    assert.equal(first.action, 'confirmation_required');
    assert.equal(first.workIntake.decision, 'confirm');
    assert.equal(first.workIntake.replayed, false);
    assert.equal(replay.action, 'confirmation_replayed');
    assert.equal(replay.id, first.id);
    assert.equal(replay.workIntake.replayed, true);

    const database = new Database(path.join(zylosDir, 'comm-bridge', 'c4.db'));
    try {
      assert.equal(
        database.prepare('SELECT COUNT(*) AS count FROM commitment_intake_queue').get().count,
        0,
      );
      assert.equal(
        database.prepare('SELECT COUNT(*) AS count FROM work_intake_confirmations').get().count,
        1,
      );
      const conversation = database.prepare('SELECT status, delivery_action FROM conversations').get();
      assert.deepEqual(conversation, {
        status: 'delivered',
        delivery_action: 'work-intake-confirmation-required',
      });
    } finally {
      database.close();
    }
  });
});

test('a persisted confirmation accepts one durable choice and rejects a conflicting choice', () => {
  withZylosDir((zylosDir) => {
    const envelope = inbound('跟一下这个事', 'om_confirm');
    const pending = receive(zylosDir, envelope);

    const mismatch = resolveConfirmation(zylosDir, {
      sourceKey: pending.workIntake.sourceKey,
      action: 'chat_only',
      channel: 'telegram',
    });
    assert.notEqual(mismatch.result.status, 0);

    const first = resolveConfirmation(zylosDir, {
      sourceKey: pending.workIntake.sourceKey,
      action: 'chat_only',
    });
    assert.equal(first.result.status, 0, first.result.stderr || first.result.stdout);
    assert.equal(first.response.action, 'queued');
    assert.equal(first.response.workIntakeConfirmation.replayed, false);

    const replay = resolveConfirmation(zylosDir, {
      sourceKey: pending.workIntake.sourceKey,
      action: 'chat_only',
    });
    assert.equal(replay.result.status, 0, replay.result.stderr || replay.result.stdout);
    assert.equal(replay.response.action, 'confirmation_replayed');
    assert.equal(replay.response.workIntakeConfirmation.replayed, true);

    const conflict = resolveConfirmation(zylosDir, {
      sourceKey: pending.workIntake.sourceKey,
      action: 'create_task',
    });
    assert.notEqual(conflict.result.status, 0);
    assert.equal(conflict.response.error.code, 'CONFIRMATION_ALREADY_RESOLVED');
  });
});

test('a confirmed task is converted by Core and duplicate clicks queue it once', () => {
  withZylosDir((zylosDir) => {
    const envelope = inbound('任务：发送邮件给供应商', 'om_confirm_create');
    const pending = receive(zylosDir, envelope);
    const request = {
      sourceKey: pending.workIntake.sourceKey,
      action: 'create_task',
    };

    const first = resolveConfirmation(zylosDir, request);
    assert.equal(first.result.status, 0, first.result.stderr || first.result.stdout);
    assert.equal(first.response.action, 'queued');
    const replay = resolveConfirmation(zylosDir, request);
    assert.equal(replay.result.status, 0, replay.result.stderr || replay.result.stdout);
    assert.equal(replay.response.action, 'already_pending');
    assert.deepEqual(replay.response.workIntakeConfirmation, {
      action: 'create_task',
      replayed: true,
    });

    const database = new Database(path.join(zylosDir, 'comm-bridge', 'c4.db'));
    try {
      const rows = database.prepare('SELECT idempotency_key, payload_json FROM commitment_intake_queue').all();
      assert.equal(rows.length, 1);
      assert.equal(rows[0].idempotency_key, pending.workIntake.sourceKey);
      const queued = JSON.parse(rows[0].payload_json);
      assert.equal(queued.task.ownerId, 'ou_sender');
      assert.equal(queued.task.acceptorId, 'ou_sender');
    } finally {
      database.close();
    }
  });
});

test('ordinary questions stay on the normal C4 chat path without task pollution', () => {
  withZylosDir((zylosDir) => {
    const response = receive(zylosDir, inbound('今天上海天气怎么样？', 'om_chat'));
    assert.equal(response.action, 'queued');
    assert.equal(response.workIntake.decision, 'chat_only');

    const database = new Database(path.join(zylosDir, 'comm-bridge', 'c4.db'));
    try {
      assert.equal(
        database.prepare('SELECT COUNT(*) AS count FROM commitment_intake_queue').get().count,
        0,
      );
      assert.equal(
        database.prepare('SELECT COUNT(*) AS count FROM conversations').get().count,
        1,
      );
    } finally {
      database.close();
    }
  });
});

test('rejects platform/source mismatch and dual task protocols', () => {
  withZylosDir((zylosDir) => {
    const envelope = inbound('任务：整理客户记录', 'om_invalid');
    const mismatch = spawnSync(process.execPath, [
      C4_RECEIVE,
      '--channel', 'telegram',
      '--endpoint', 'chat',
      '--json',
      '--work-intake-envelope-json', JSON.stringify(envelope),
      '--content', 'invalid',
    ], {
      encoding: 'utf8',
      env: { ...process.env, ZYLOS_DIR: zylosDir },
    });
    assert.notEqual(mismatch.status, 0);
    assert.match(mismatch.stdout, /source\.channel must match/);

    const dual = spawnSync(process.execPath, [
      C4_RECEIVE,
      '--channel', 'feishu',
      '--endpoint', 'chat',
      '--json',
      '--work-intake-envelope-json', JSON.stringify(envelope),
      '--task-envelope-json', '{}',
      '--content', 'invalid',
    ], {
      encoding: 'utf8',
      env: { ...process.env, ZYLOS_DIR: zylosDir },
    });
    assert.notEqual(dual.status, 0);
    assert.match(dual.stdout, /mutually exclusive/);
  });
});
