import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

test('an accepted confirmation remains pending and resumable until its side effect is durable', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'work-intake-confirmation-state-'));
  process.env.ZYLOS_DIR = directory;
  try {
    const [{
      recordWorkIntakeConfirmation,
      resolveWorkIntakeConfirmation,
      completeWorkIntakeConfirmationEffect,
    }, { close }] = await Promise.all([
      import('../../../comm-bridge/scripts/c4-work-intake-confirmations.js'),
      import('../../../comm-bridge/scripts/c4-db.js'),
    ]);
    const envelope = {
      source: {
        channel: 'feishu',
        messageId: 'om_pending_effect',
        conversationId: 'oc_pending_effect',
        conversationType: 'direct',
        threadId: null,
      },
      sender: { id: 'ou_sender', kind: 'human' },
      text: '跟一下这个事',
      intentRevision: 1,
      receivedAt: '2026-08-25T02:00:00.000Z',
      timeZone: 'Asia/Shanghai',
      people: [],
    };
    const decision = {
      decision: 'confirm',
      reasonCode: 'INSUFFICIENT_TASK_DETAIL',
      intentRevision: 1,
      sourceKey: 'feishu:om_pending_effect:work-intake:r1',
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
    recordWorkIntakeConfirmation({
      conversation: {
        channel: 'feishu',
        endpointId: 'oc_pending_effect|type:p2p|msg:om_pending_effect',
        content: '[Feishu DM] Sender said: 跟一下这个事',
        priority: 3,
        requireIdle: false,
      },
      envelope,
      decision,
    });

    const first = resolveWorkIntakeConfirmation({
      sourceKey: decision.sourceKey,
      action: 'create_task',
      actorId: 'ou_sender',
    });
    const replay = resolveWorkIntakeConfirmation({
      sourceKey: decision.sourceKey,
      action: 'create_task',
      actorId: 'ou_sender',
    });

    assert.equal(first.created, true);
    assert.equal(first.effectStatus, 'pending');
    assert.equal(replay.created, false);
    assert.equal(replay.effectStatus, 'pending');
    const applied = completeWorkIntakeConfirmationEffect({
      sourceKey: decision.sourceKey,
      action: 'create_task',
      actorId: 'ou_sender',
    });
    const appliedReplay = resolveWorkIntakeConfirmation({
      sourceKey: decision.sourceKey,
      action: 'create_task',
      actorId: 'ou_sender',
    });
    assert.equal(applied.effectStatus, 'applied');
    assert.equal(appliedReplay.effectStatus, 'applied');
    close();
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
