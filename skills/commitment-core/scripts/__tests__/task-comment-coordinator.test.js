import assert from 'node:assert/strict';
import test from 'node:test';

import { createTaskCommentCoordinator } from '../task-comment-coordinator.js';
import { openCommitmentCore } from '../core.js';

function createHarness() {
  let taskId = 0;
  let eventId = 0;
  const core = openCommitmentCore({
    dbPath: ':memory:',
    idGenerator: () => `task-${++taskId}`,
    eventIdGenerator: () => `task-event-${++eventId}`,
    conversationEventIdGenerator: () => `comment-event-${++eventId}`,
    clock: () => '2026-08-25T12:00:00.000Z',
  });
  const created = core.ingest({
    idempotencyKey: 'source:task-comment-coordinator',
    source: { channel: 'feishu', externalId: 'om_task', senderId: 'ou_owner' },
    task: {
      title: 'Follow up renewal',
      description: 'Confirm the renewal date.',
      ownerId: 'ou_owner',
      acceptorId: 'ou_acceptor',
      assigneeId: 'agent:yueran',
    },
  });
  return { core, task: created.task };
}

test('comment coordinator records once and publishes a human-audience notification decision', async () => {
  const harness = createHarness();
  const publications = [];
  try {
    const coordinator = createTaskCommentCoordinator({
      core: harness.core,
      async publishNotification(publication) {
        publications.push(publication);
      },
    });
    const command = {
      type: 'AddComment',
      taskId: harness.task.id,
      commentId: 'external-comment:1',
      actorId: 'ou_owner',
      body: 'Please confirm before Friday.',
      occurredAt: '2026-08-25T12:00:00.000Z',
      idempotencyKey: 'feishu-comment-effect:1',
    };

    const first = await coordinator.record(command);
    const replay = await coordinator.record(command);

    assert.deepEqual(replay, first);
    assert.equal(harness.core.conversation.query({ taskId: harness.task.id }).length, 1);
    assert.equal(publications.length, 2, 'a crash retry republishes the same idempotent delivery');
    assert.deepEqual(publications[0], publications[1]);
    assert.deepEqual(
      publications[0].decision.deliveries.map(({ recipientId }) => recipientId),
      ['ou_acceptor'],
    );
    assert.equal(publications[0].summary, 'Please confirm before Friday.');
  } finally {
    harness.core.close();
  }
});
