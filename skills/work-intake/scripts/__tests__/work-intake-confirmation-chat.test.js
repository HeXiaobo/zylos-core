import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

test('chat-only confirmation queues its original conversation and applies the effect atomically', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'work-intake-confirmed-chat-'));
  process.env.ZYLOS_DIR = directory;
  try {
    const [{
      recordWorkIntakeConfirmation,
      resolveWorkIntakeConfirmation,
      queueConfirmedWorkIntakeChat,
    }, { close }] = await Promise.all([
      import('../../../comm-bridge/scripts/c4-work-intake-confirmations.js'),
      import('../../../comm-bridge/scripts/c4-db.js'),
    ]);
    const envelope = {
      source: {
        channel: 'feishu',
        messageId: 'om_confirmed_chat',
        conversationId: 'oc_confirmed_chat',
        conversationType: 'direct',
        threadId: null,
      },
      sender: { id: 'ou_sender', kind: 'human' },
      text: '跟一下这个事',
      intentRevision: 1,
      receivedAt: null,
      timeZone: 'Asia/Shanghai',
      people: [],
    };
    const decision = {
      decision: 'confirm',
      reasonCode: 'INSUFFICIENT_TASK_DETAIL',
      intentRevision: 1,
      sourceKey: 'feishu:om_confirmed_chat:work-intake:r1',
      taskDraft: {
        title: envelope.text,
        description: null,
        ownerId: 'ou_sender',
        acceptorId: 'ou_sender',
        assigneeId: null,
        dueText: null,
        riskLevel: 'normal',
      },
    };
    const pending = recordWorkIntakeConfirmation({
      conversation: {
        channel: 'feishu',
        endpointId: 'oc_confirmed_chat|type:p2p|msg:om_confirmed_chat',
        content: '[Feishu DM] Sender said: 跟一下这个事',
        priority: 3,
        requireIdle: false,
      },
      envelope,
      decision,
    });
    resolveWorkIntakeConfirmation({
      sourceKey: decision.sourceKey,
      action: 'chat_only',
      actorId: 'ou_sender',
    });

    const queued = queueConfirmedWorkIntakeChat({
      sourceKey: decision.sourceKey,
      actorId: 'ou_sender',
      status: 'pending',
    });
    const replay = queueConfirmedWorkIntakeChat({
      sourceKey: decision.sourceKey,
      actorId: 'ou_sender',
      status: 'pending',
    });

    assert.equal(queued.replayed, false);
    assert.equal(queued.effectStatus, 'applied');
    assert.deepEqual(queued.conversation, {
      id: pending.conversation.id,
      status: 'pending',
      deliveryAction: 'work-intake-chat-only',
    });
    assert.equal(replay.replayed, true);
    assert.deepEqual(replay.conversation, queued.conversation);
    close();
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
