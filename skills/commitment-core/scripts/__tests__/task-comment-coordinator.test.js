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

test('an Agent exact reply notifies only the original human commenter', async () => {
  const harness = createHarness();
  const publications = [];
  try {
    harness.core.conversation.record({
      type: 'AddComment',
      taskId: harness.task.id,
      commentId: 'external-comment:parent',
      actorId: 'ou_requester',
      body: 'Which renewal date is authoritative?',
      occurredAt: '2026-08-25T11:58:00.000Z',
      idempotencyKey: 'feishu-comment-effect:parent',
    });
    const coordinator = createTaskCommentCoordinator({
      core: harness.core,
      async publishNotification(publication) {
        publications.push(publication);
      },
    });

    await coordinator.record({
      type: 'AddComment',
      taskId: harness.task.id,
      commentId: 'external-comment:reply',
      actorId: 'agent:yueran',
      body: 'The signed contract date is authoritative.',
      replyToCommentId: 'external-comment:parent',
      occurredAt: '2026-08-25T12:00:00.000Z',
      idempotencyKey: 'feishu-comment-effect:reply',
    });

    assert.deepEqual(
      publications.flatMap(({ decision }) => decision.deliveries)
        .map(({ recipientId }) => recipientId),
      ['ou_requester'],
    );
  } finally {
    harness.core.close();
  }
});

test('an Agent reply keeps the original commenter when an Adapter revised the parent', async () => {
  const harness = createHarness();
  const publications = [];
  try {
    harness.core.conversation.record({
      type: 'AddComment',
      taskId: harness.task.id,
      commentId: 'external-comment:revised-parent',
      actorId: 'ou_requester',
      body: 'Original question',
      occurredAt: '2026-08-25T11:57:00.000Z',
      idempotencyKey: 'feishu-comment-effect:revised-parent:add',
    });
    harness.core.conversation.record({
      type: 'ReviseComment',
      taskId: harness.task.id,
      commentId: 'external-comment:revised-parent',
      actorId: 'external:feishu-sync',
      body: 'Edited question',
      occurredAt: '2026-08-25T11:58:00.000Z',
      idempotencyKey: 'feishu-comment-effect:revised-parent:revise',
    });
    const coordinator = createTaskCommentCoordinator({
      core: harness.core,
      async publishNotification(publication) {
        publications.push(publication);
      },
    });

    await coordinator.record({
      type: 'AddComment',
      taskId: harness.task.id,
      commentId: 'external-comment:reply-to-revised',
      actorId: 'agent:yueran',
      body: 'Answer after the edit.',
      replyToCommentId: 'external-comment:revised-parent',
      occurredAt: '2026-08-25T12:00:00.000Z',
      idempotencyKey: 'feishu-comment-effect:reply-to-revised',
    });

    assert.deepEqual(
      publications[0].decision.deliveries.map(({ recipientId }) => recipientId),
      ['ou_requester'],
    );
  } finally {
    harness.core.close();
  }
});

test('an Agent reply waits for a late Add event instead of freezing a revision actor as author', async () => {
  const harness = createHarness();
  const publications = [];
  try {
    harness.core.conversation.record({
      type: 'ReviseComment',
      taskId: harness.task.id,
      commentId: 'external-comment:out-of-order-parent',
      actorId: 'external:feishu-sync',
      body: 'Edited question delivered before its Add event',
      occurredAt: '2026-08-25T11:58:00.000Z',
      idempotencyKey: 'feishu-comment-effect:out-of-order-parent:revise',
    });
    const coordinator = createTaskCommentCoordinator({
      core: harness.core,
      async publishNotification(publication) {
        publications.push(publication);
      },
    });
    const reply = {
      type: 'AddComment',
      taskId: harness.task.id,
      commentId: 'external-comment:out-of-order-reply',
      actorId: 'agent:yueran',
      body: 'Answer while the parent Add event is still in flight.',
      replyToCommentId: 'external-comment:out-of-order-parent',
      occurredAt: '2026-08-25T12:00:00.000Z',
      idempotencyKey: 'feishu-comment-effect:out-of-order-reply',
    };

    await coordinator.record(reply);
    assert.deepEqual(publications, []);

    harness.core.conversation.record({
      type: 'AddComment',
      taskId: harness.task.id,
      commentId: 'external-comment:out-of-order-parent',
      actorId: 'ou_requester',
      body: 'Original question delivered late',
      occurredAt: '2026-08-25T11:57:00.000Z',
      idempotencyKey: 'feishu-comment-effect:out-of-order-parent:add',
    });
    await coordinator.record(reply);

    assert.deepEqual(
      publications.flatMap(({ decision }) => decision.deliveries)
        .map(({ recipientId }) => recipientId),
      ['ou_requester'],
    );
  } finally {
    harness.core.close();
  }
});

test('a human comment notifies business and explicit subscribers but not its author, Agent, or prior commenters', async () => {
  const harness = createHarness();
  const publications = [];
  try {
    harness.core.subscriptions.add({
      taskId: harness.task.id,
      subscriberId: 'ou_stakeholder',
      actorId: 'ou_owner',
      idempotencyKey: 'subscription:add:stakeholder',
    });
    harness.core.conversation.record({
      type: 'AddComment',
      taskId: harness.task.id,
      commentId: 'external-comment:prior',
      actorId: 'ou_prior_commenter',
      body: 'An earlier observation.',
      occurredAt: '2026-08-25T11:55:00.000Z',
      idempotencyKey: 'feishu-comment-effect:prior',
    });
    const coordinator = createTaskCommentCoordinator({
      core: harness.core,
      async publishNotification(publication) {
        publications.push(publication);
      },
    });

    await coordinator.record({
      type: 'AddComment',
      taskId: harness.task.id,
      commentId: 'external-comment:new-human',
      actorId: 'ou_requester',
      body: 'A new question for the task owners.',
      occurredAt: '2026-08-25T12:00:00.000Z',
      idempotencyKey: 'feishu-comment-effect:new-human',
    });

    assert.deepEqual(
      publications[0].decision.deliveries.map(({ recipientId }) => recipientId),
      ['ou_owner', 'ou_acceptor', 'ou_stakeholder'],
    );
  } finally {
    harness.core.close();
  }
});

test('comment replay republishes the persisted decision when subscribers changed', async () => {
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
      commentId: 'external-comment:audience-drift',
      actorId: 'ou_owner',
      body: 'Keep this notification audience stable.',
      occurredAt: '2026-08-25T12:00:00.000Z',
      idempotencyKey: 'feishu-comment-effect:audience-drift',
    };

    await coordinator.record(command);
    harness.core.subscriptions.add({
      taskId: harness.task.id,
      subscriberId: 'ou_late_subscriber',
      actorId: 'ou_owner',
      idempotencyKey: 'subscription:add:late-subscriber',
    });
    await coordinator.record(command);

    assert.equal(publications.length, 2);
    assert.deepEqual(publications[1], publications[0]);
    assert.deepEqual(
      publications[1].decision.deliveries.map(({ recipientId }) => recipientId),
      ['ou_acceptor'],
    );
  } finally {
    harness.core.close();
  }
});

test('an exact reply can target a commenter beyond the ordinary conversation query limit', async () => {
  const harness = createHarness();
  const publications = [];
  try {
    for (let index = 0; index < 60; index += 1) {
      harness.core.conversation.record({
        type: 'AddComment',
        taskId: harness.task.id,
        commentId: `external-comment:earlier-${String(index).padStart(2, '0')}`,
        actorId: `ou_earlier_${index}`,
        body: `Earlier comment ${index}`,
        occurredAt: `2026-08-25T11:00:00.${String(index).padStart(3, '0')}Z`,
        idempotencyKey: `feishu-comment-effect:earlier-${index}`,
      });
    }
    harness.core.conversation.record({
      type: 'AddComment',
      taskId: harness.task.id,
      commentId: 'external-comment:late-parent',
      actorId: 'ou_late_requester',
      body: 'A question after the audience listing limit.',
      occurredAt: '2026-08-25T11:30:00.000Z',
      idempotencyKey: 'feishu-comment-effect:late-parent',
    });
    const coordinator = createTaskCommentCoordinator({
      core: harness.core,
      async publishNotification(publication) {
        publications.push(publication);
      },
    });

    await coordinator.record({
      type: 'AddComment',
      taskId: harness.task.id,
      commentId: 'external-comment:late-parent-reply',
      actorId: 'agent:yueran',
      body: 'A precise answer to the late commenter.',
      replyToCommentId: 'external-comment:late-parent',
      occurredAt: '2026-08-25T12:00:00.000Z',
      idempotencyKey: 'feishu-comment-effect:late-parent-reply',
    });

    assert.deepEqual(
      publications[0].decision.deliveries.map(({ recipientId }) => recipientId),
      ['ou_late_requester'],
    );
  } finally {
    harness.core.close();
  }
});
