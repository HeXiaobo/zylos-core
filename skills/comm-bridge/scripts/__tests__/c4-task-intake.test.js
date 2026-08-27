import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { openCommitmentIntakeQueue } from '../c4-db.js';
import { validateTaskEnvelope } from '../c4-task-envelope.js';
import { persistTaskBeforeRoute } from '../c4-task-intake.js';

test('preserves a canonical reminder in the strict C4 Task envelope', () => {
  const envelope = validateTaskEnvelope({
    idempotencyKey: 'feishu:om_reminder:task-intent',
    source: { channel: 'feishu', externalId: 'om_reminder', senderId: 'ou_owner' },
    task: {
      title: 'Reminder through C4',
      ownerId: 'ou_owner',
      dueAt: '2026-08-27T10:00:00.000Z',
      reminderMinutesBeforeDue: 60,
    },
  });

  assert.equal(envelope.task.reminderMinutesBeforeDue, 60);
});

test('persists task intake before invoking a failing route dependency', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'c4-task-before-route-'));
  const intake = openCommitmentIntakeQueue({
    dbPath: path.join(directory, 'c4.db'),
    clock: () => 5_000,
  });
  const envelope = {
    idempotencyKey: 'feishu:om_route_failure:task-intent',
    source: { channel: 'feishu', externalId: 'om_route_failure' },
    task: { title: '路由故障也不能丢', ownerId: 'ou_owner' },
  };
  let observedBeforeRouteFailure = null;

  try {
    await assert.rejects(
      persistTaskBeforeRoute({
        intake,
        conversation: {
          channel: 'feishu',
          endpointId: 'chat_route_failure',
          content: '先落盘再检查路由',
          status: 'pending',
        },
        envelope,
        async route() {
          observedBeforeRouteFailure = intake.get({
            idempotencyKey: envelope.idempotencyKey,
          });
          throw new Error('simulated route failure');
        },
      }),
      /simulated route failure/,
    );

    assert.ok(observedBeforeRouteFailure);
    assert.equal(observedBeforeRouteFailure.status, 'pending');
    assert.deepEqual(
      intake.get({ idempotencyKey: envelope.idempotencyKey }),
      observedBeforeRouteFailure,
    );
  } finally {
    intake.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
