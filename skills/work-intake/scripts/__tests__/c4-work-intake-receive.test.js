import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import Database from '../../../commitment-core/node_modules/better-sqlite3/lib/index.js';
import { createWorkIntakeConfirmationCapability } from '../confirmation-capability.js';

const C4_RECEIVE = fileURLToPath(new URL(
  '../../../comm-bridge/scripts/c4-receive.js',
  import.meta.url,
));
const C4_CONFIRMATIONS = fileURLToPath(new URL(
  '../../../comm-bridge/scripts/c4-work-intake-confirmations.js',
  import.meta.url,
));
const CAPABILITY_SECRET = '0123456789abcdef0123456789abcdef';
const confirmationCapability = createWorkIntakeConfirmationCapability({
  secret: CAPABILITY_SECRET,
  clock: Date.now,
});

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

function receive(zylosDir, envelope, { assistantRequest = null, env = {} } = {}) {
  const args = [
    C4_RECEIVE,
    '--channel', 'feishu',
    '--endpoint', `oc_work_intake|type:p2p|msg:${envelope.source.messageId}`,
    '--json',
    '--work-intake-envelope-json', JSON.stringify(envelope),
  ];
  if (assistantRequest) {
    args.push(
      '--assistant-request-id', assistantRequest.requestId,
      '--assistant-source-id', assistantRequest.sourceId,
    );
  }
  args.push('--content', `[Feishu DM] Sender said: ${envelope.text}`);
  const result = spawnSync(process.execPath, args, {
    encoding: 'utf8',
    env: { ...process.env, ZYLOS_DIR: zylosDir, ...env },
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
  capabilityActorId = actorId,
  channel = 'feishu',
}) {
  const capability = confirmationCapability.issue({
    sourceKey,
    action,
    actorId: capabilityActorId,
    expiresAt: Date.now() + 60_000,
    nonce: `callback:${sourceKey}:${action}:${capabilityActorId}`,
  });
  const result = spawnSync(process.execPath, [
    C4_RECEIVE,
    '--channel', channel,
    '--endpoint', 'oc_work_intake|type:p2p|msg:om_confirm',
    '--json',
    '--work-intake-confirmation-json', JSON.stringify({ sourceKey, action, actorId, capability }),
    '--content', '[Feishu WorkIntake confirmation]',
  ], {
    encoding: 'utf8',
    env: {
      ...process.env,
      ZYLOS_DIR: zylosDir,
      C4_WORK_INTAKE_CAPABILITY_SECRET: CAPABILITY_SECRET,
    },
  });
  const jsonLine = result.stdout.trim().split('\n').findLast((line) => line.startsWith('{'));
  return { result, response: jsonLine ? JSON.parse(jsonLine) : null };
}

function acknowledgeEditEffect(zylosDir, { sourceKey, actorId = 'ou_sender', effectKey }) {
  const action = 'edit';
  const capability = confirmationCapability.issue({
    sourceKey,
    action,
    actorId,
    expiresAt: Date.now() + 60_000,
    nonce: `effect:${effectKey}`,
  });
  const result = spawnSync(process.execPath, [
    C4_RECEIVE,
    '--channel', 'feishu',
    '--json',
    '--work-intake-confirmation-effect-json', JSON.stringify({
      sourceKey,
      action,
      actorId,
      effectKey,
      capability,
    }),
  ], {
    encoding: 'utf8',
    env: {
      ...process.env,
      ZYLOS_DIR: zylosDir,
      C4_WORK_INTAKE_CAPABILITY_SECRET: CAPABILITY_SECRET,
    },
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
    const deploymentEnv = {
      ZYLOS_AGENT_ID: 'agent:yueran',
      ZYLOS_AGENT_ALIASES: '["玥然"]',
    };
    const first = receive(zylosDir, envelope, { env: deploymentEnv });
    const replay = receive(zylosDir, envelope, { env: deploymentEnv });

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

test('maps a configured non-Yueran Agent alias to its logical deployment identity', () => {
  withZylosDir((zylosDir) => {
    const envelope = inbound('请 Mylos 明天18:00前整理客户回访记录，提前1小时提醒', 'om_mylos');
    const response = receive(zylosDir, envelope, {
      env: {
        ZYLOS_AGENT_ID: 'agent:mylos',
        ZYLOS_AGENT_ALIASES: '["Mylos","麦洛斯"]',
      },
    });

    assert.equal(response.workIntake.decision, 'create_task');
    const database = new Database(path.join(zylosDir, 'comm-bridge', 'c4.db'));
    try {
      const queued = database.prepare('SELECT payload_json FROM commitment_intake_queue').get();
      const task = JSON.parse(queued.payload_json).task;
      assert.equal(task.assigneeId, 'agent:mylos');
      assert.equal(task.dueAt, '2026-08-26T10:00:00.000Z');
      assert.equal(task.reminderMinutesBeforeDue, 60);
    } finally {
      database.close();
    }
  });
});

test('the configured Agent identity is persisted for an otherwise unassigned task', () => {
  withZylosDir((zylosDir) => {
    const envelope = inbound('明天 18:00 前完成客户复盘', 'om_default_assignee');
    const response = receive(zylosDir, envelope, {
      env: { ZYLOS_AGENT_ID: 'agent:yueran' },
    });

    assert.equal(response.workIntake.decision, 'create_task');
    const database = new Database(path.join(zylosDir, 'comm-bridge', 'c4.db'));
    try {
      const queued = database.prepare('SELECT payload_json FROM commitment_intake_queue').get();
      const task = JSON.parse(queued.payload_json).task;
      assert.equal(task.assigneeId, 'agent:yueran');
      assert.equal(task.dueAt, '2026-08-26T10:00:00.000Z');
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

test('a locally forged confirmation actor is rejected without a matching capability', () => {
  withZylosDir((zylosDir) => {
    const pending = receive(zylosDir, inbound('跟一下这个事', 'om_forged_actor'));
    const forged = resolveConfirmation(zylosDir, {
      sourceKey: pending.workIntake.sourceKey,
      action: 'create_task',
      actorId: 'ou_sender',
      capabilityActorId: 'ou_attacker',
    });

    assert.notEqual(forged.result.status, 0);
    assert.equal(forged.response.error.code, 'INVALID_CONFIRMATION_CAPABILITY');
  });
});

test('chat-only confirmation resumes its queue effect after a crash immediately following the choice', () => {
  withZylosDir((zylosDir) => {
    const pending = receive(zylosDir, inbound('跟一下这个事', 'om_chat_effect_crash'));
    const interrupted = spawnSync(process.execPath, [
      '--input-type=module',
      '-e',
      [
        'process.env.ZYLOS_DIR = process.argv[1];',
        'const state = await import(process.argv[2]);',
        'state.resolveWorkIntakeConfirmation({',
        '  sourceKey: process.argv[3], action: "chat_only", actorId: "ou_sender"',
        '});',
      ].join('\n'),
      zylosDir,
      C4_CONFIRMATIONS,
      pending.workIntake.sourceKey,
    ], { encoding: 'utf8' });
    assert.equal(interrupted.status, 0, interrupted.stderr || interrupted.stdout);

    const retry = resolveConfirmation(zylosDir, {
      sourceKey: pending.workIntake.sourceKey,
      action: 'chat_only',
    });
    assert.equal(retry.result.status, 0, retry.result.stderr || retry.result.stdout);
    assert.equal(retry.response.action, 'queued');
    assert.equal(retry.response.workIntakeConfirmation.effectStatus, 'applied');

    const database = new Database(path.join(zylosDir, 'comm-bridge', 'c4.db'));
    try {
      const rows = database.prepare(`
        SELECT status, delivery_action FROM conversations ORDER BY id
      `).all();
      assert.deepEqual(rows, [{
        status: 'pending',
        delivery_action: 'work-intake-chat-only',
      }]);
    } finally {
      database.close();
    }
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
      effectStatus: 'applied',
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

test('edit confirmation keeps returning one stable pending effect for adapter redrive', () => {
  withZylosDir((zylosDir) => {
    const pending = receive(zylosDir, inbound('跟一下这个事', 'om_confirm_edit'));
    const request = {
      sourceKey: pending.workIntake.sourceKey,
      action: 'edit',
    };

    const first = resolveConfirmation(zylosDir, request);
    const replay = resolveConfirmation(zylosDir, request);

    assert.equal(first.result.status, 0, first.result.stderr || first.result.stdout);
    assert.equal(first.response.action, 'confirmation_resolved');
    assert.deepEqual(first.response.workIntakeConfirmation, {
      action: 'edit',
      replayed: false,
      decisionReplayed: false,
      effectStatus: 'pending',
      effectKey: `${pending.workIntake.sourceKey}:edit-guidance`,
    });
    assert.equal(replay.result.status, 0, replay.result.stderr || replay.result.stdout);
    assert.deepEqual(replay.response.workIntakeConfirmation, {
      ...first.response.workIntakeConfirmation,
      decisionReplayed: true,
    });

    const database = new Database(path.join(zylosDir, 'comm-bridge', 'c4.db'));
    try {
      assert.deepEqual(database.prepare(`
        SELECT resolved_action, effect_status
        FROM work_intake_confirmations
      `).get(), {
        resolved_action: 'edit',
        effect_status: 'pending',
      });
    } finally {
      database.close();
    }
  });
});

test('edit effect becomes applied only after the adapter acknowledges durable delivery', () => {
  withZylosDir((zylosDir) => {
    const pending = receive(zylosDir, inbound('跟一下这个事', 'om_confirm_edit_ack'));
    const request = {
      sourceKey: pending.workIntake.sourceKey,
      action: 'edit',
    };
    const instruction = resolveConfirmation(zylosDir, request);
    const effectKey = instruction.response.workIntakeConfirmation.effectKey;

    const acknowledged = acknowledgeEditEffect(zylosDir, {
      sourceKey: request.sourceKey,
      effectKey,
    });
    assert.equal(
      acknowledged.result.status,
      0,
      acknowledged.result.stderr || acknowledged.result.stdout,
    );
    assert.deepEqual(acknowledged.response.workIntakeConfirmation, {
      action: 'edit',
      effectStatus: 'applied',
      effectKey,
      replayed: false,
    });

    const replay = resolveConfirmation(zylosDir, request);
    assert.equal(replay.response.action, 'confirmation_replayed');
    assert.deepEqual(replay.response.workIntakeConfirmation, {
      action: 'edit',
      effectStatus: 'applied',
      replayed: true,
    });
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

test('standalone authorization acknowledgements stay on chat without task pollution', () => {
  withZylosDir((zylosDir) => {
    const response = receive(
      zylosDir,
      inbound('已授权', 'om_authorization_ack'),
      { env: { ZYLOS_AGENT_ID: 'agent:yueran' } },
    );
    assert.equal(response.action, 'queued');
    assert.equal(response.workIntake.decision, 'chat_only');
    assert.equal(response.workIntake.reasonCode, 'ACKNOWLEDGEMENT_ONLY');

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

test('a deferred response stream is opened only when WorkIntake resolves to ordinary chat', () => {
  withZylosDir((zylosDir) => {
    const assistantRequest = {
      requestId: 'assistant.feishu.deferred-chat',
      sourceId: 'om_deferred_chat',
    };
    const chat = receive(
      zylosDir,
      inbound('今天上海天气怎么样？', 'om_deferred_chat'),
      { assistantRequest },
    );
    assert.equal(chat.workIntake.decision, 'chat_only');
    assert.equal(chat.assistantResponse.requestId, assistantRequest.requestId);

    const create = receive(
      zylosDir,
      inbound('请玥然在周五前整理 A 客户的跟进记录', 'om_deferred_task'),
      {
        assistantRequest: {
          requestId: 'assistant.feishu.deferred-task',
          sourceId: 'om_deferred_task',
        },
        env: {
          ZYLOS_AGENT_ID: 'agent:yueran',
          ZYLOS_AGENT_ALIASES: '["玥然"]',
        },
      },
    );
    assert.equal(create.workIntake.decision, 'create_task');
    assert.equal(create.assistantResponse, undefined);

    const confirm = receive(
      zylosDir,
      inbound('跟一下这个事', 'om_deferred_confirm'),
      {
        assistantRequest: {
          requestId: 'assistant.feishu.deferred-confirm',
          sourceId: 'om_deferred_confirm',
        },
      },
    );
    assert.equal(confirm.workIntake.decision, 'confirm');
    assert.equal(confirm.assistantResponse, undefined);

    const database = new Database(path.join(zylosDir, 'comm-bridge', 'c4.db'));
    try {
      assert.deepEqual(
        database.prepare('SELECT request_id FROM assistant_requests ORDER BY request_id').all(),
        [{ request_id: assistantRequest.requestId }],
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
