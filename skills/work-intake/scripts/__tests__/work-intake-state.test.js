import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

function envelope(messageId, text) {
  return {
    source: {
      channel: 'feishu',
      messageId,
      conversationId: 'oc_decision_receipt',
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

function decision(input, kind) {
  return {
    decision: kind,
    reasonCode: `FIRST_${kind.toUpperCase()}`,
    intentRevision: input.intentRevision,
    sourceKey: `feishu:${input.source.messageId}:work-intake:r${input.intentRevision}`,
    taskDraft: kind === 'chat_only'
      ? null
      : {
          title: input.text,
          description: null,
          ownerId: input.sender.id,
          acceptorId: input.sender.id,
          assigneeId: null,
          dueText: null,
          riskLevel: 'normal',
        },
  };
}

test('the first decision for every WorkIntake outcome survives a classifier upgrade', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'work-intake-state-'));
  const previousDirectory = process.env.ZYLOS_DIR;
  process.env.ZYLOS_DIR = directory;
  try {
    const [{ recordWorkIntakeDecision }, { close }] = await Promise.all([
      import('../../../comm-bridge/scripts/c4-work-intake-confirmations.js'),
      import('../../../comm-bridge/scripts/c4-db.js'),
    ]);

    for (const kind of ['chat_only', 'create_task', 'confirm']) {
      const input = envelope(`om_${kind}`, `original ${kind}`);
      const first = recordWorkIntakeDecision({
        envelope: input,
        classify: value => decision(value, kind),
      });
      let reclassified = false;
      const replay = recordWorkIntakeDecision({
        envelope: input,
        classify: value => {
          reclassified = true;
          return decision(value, kind === 'chat_only' ? 'create_task' : 'chat_only');
        },
      });

      assert.equal(first.replayed, false);
      assert.equal(replay.replayed, true);
      assert.equal(replay.decision.decision, kind);
      assert.equal(reclassified, false);
    }
    close();
  } finally {
    if (previousDirectory === undefined) delete process.env.ZYLOS_DIR;
    else process.env.ZYLOS_DIR = previousDirectory;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('a confirmation capability binds the chosen action and actor at the local Core seam', async () => {
  const { createWorkIntakeConfirmationCapability } = await import('../confirmation-capability.js');
  const capability = createWorkIntakeConfirmationCapability({
    secret: '0123456789abcdef0123456789abcdef',
    clock: () => 1_700_000_000_000,
  });
  const authorization = {
    sourceKey: 'feishu:om_capability:work-intake:r1',
    action: 'create_task',
    actorId: 'ou_original_sender',
  };
  const token = capability.issue({
    ...authorization,
    expiresAt: 1_700_000_060_000,
    nonce: 'card-callback-event-1',
  });

  assert.deepEqual(capability.verify({ token, ...authorization }), {
    audience: 'c4-work-intake-confirmation',
    ...authorization,
    issuedAt: 1_700_000_000_000,
    expiresAt: 1_700_000_060_000,
    nonce: 'card-callback-event-1',
  });
  assert.throws(
    () => capability.verify({ token, ...authorization, actorId: 'ou_local_spoof' }),
    error => error?.code === 'INVALID_CONFIRMATION_CAPABILITY',
  );
  assert.throws(
    () => capability.verify({ token, ...authorization, action: 'chat_only' }),
    error => error?.code === 'INVALID_CONFIRMATION_CAPABILITY',
  );
});
