import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { openCommitmentCore } from '../core.js';

function createHarness(taskOverrides = {}) {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'zylos-task-conversation-'));
  let conversationEventIndex = 0;
  const core = openCommitmentCore({
    dbPath: path.join(directory, 'commitments.db'),
    clock: () => '2026-08-25T10:30:00.000Z',
    idGenerator: () => 'task-comments-1',
    eventIdGenerator: () => 'event-task-created',
    conversationEventIdGenerator: () => `conversation-event-${conversationEventIndex++}`,
  });
  core.ingest({
    idempotencyKey: 'source:task-comments-1',
    source: { channel: 'test', externalId: 'source-1', senderId: 'owner-1' },
    task: {
      title: 'Resolve the customer question',
      ownerId: 'owner-1',
      acceptorId: 'acceptor-1',
      assigneeId: 'agent-1',
      ...taskOverrides,
    },
  });
  return {
    core,
    cleanup() {
      core.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

test('TaskConversation keeps add, revision, and deletion as immutable history with a tombstone', () => {
  const harness = createHarness();
  try {
    const added = harness.core.conversation.record({
      type: 'AddComment',
      taskId: 'task-comments-1',
      commentId: 'comment-parent',
      actorId: 'owner-1',
      body: 'Please verify the renewal date.',
      occurredAt: '2026-08-25T10:01:00.000Z',
      idempotencyKey: 'comment:add:parent:v1',
    });
    harness.core.conversation.record({
      type: 'AddComment',
      taskId: 'task-comments-1',
      commentId: 'comment-reply',
      actorId: 'agent-1',
      body: 'I am checking the contract now.',
      replyToCommentId: 'comment-parent',
      occurredAt: '2026-08-25T10:02:00.000Z',
      idempotencyKey: 'comment:add:reply:v1',
    });
    harness.core.conversation.record({
      type: 'ReviseComment',
      taskId: 'task-comments-1',
      commentId: 'comment-parent',
      actorId: 'owner-1',
      body: 'Please verify the renewal date and owner.',
      occurredAt: '2026-08-25T10:03:00.000Z',
      idempotencyKey: 'comment:revise:parent:v2',
    });
    const deleted = harness.core.conversation.record({
      type: 'DeleteComment',
      taskId: 'task-comments-1',
      commentId: 'comment-parent',
      actorId: 'external:feishu',
      occurredAt: '2026-08-25T10:04:00.000Z',
      idempotencyKey: 'comment:delete:parent:v3',
    });

    assert.equal(added.event.type, 'CommentAdded');
    assert.deepEqual(deleted.comment, {
      id: 'comment-parent',
      taskId: 'task-comments-1',
      actorId: 'external:feishu',
      body: null,
      replyToCommentId: null,
      deleted: true,
      lastEventId: 'conversation-event-3',
      occurredAt: '2026-08-25T10:04:00.000Z',
    });
    const history = harness.core.conversation.query({
      taskId: 'task-comments-1',
      commentId: 'comment-parent',
      includeHistory: true,
    });
    assert.equal(history.comment.deleted, true);
    assert.deepEqual(
      history.events.map(({ type, body }) => ({ type, body })),
      [
        { type: 'CommentAdded', body: 'Please verify the renewal date.' },
        { type: 'CommentRevised', body: 'Please verify the renewal date and owner.' },
        { type: 'CommentDeleted', body: null },
      ],
    );
    assert.deepEqual(
      harness.core.conversation.query({
        taskId: 'task-comments-1',
        commentId: 'comment-parent',
        includeHistory: true,
        limit: 2,
      }).events.map(({ type }) => type),
      ['CommentRevised', 'CommentDeleted'],
    );
    assert.equal(harness.core.conversation.update, undefined);
    assert.equal(harness.core.conversation.remove, undefined);
    assert.equal(
      harness.core.conversation.query({ taskId: 'task-comments-1' })
        .find(({ id }) => id === 'comment-reply').replyToCommentId,
      'comment-parent',
    );
  } finally {
    harness.cleanup();
  }
});

test('TaskConversation is exactly idempotent and late older events cannot replace a newer view', () => {
  const harness = createHarness();
  try {
    const command = {
      type: 'ReviseComment',
      taskId: 'task-comments-1',
      commentId: 'comment-1',
      actorId: 'owner-1',
      body: 'Newest body',
      occurredAt: '2026-08-25T10:05:00.000Z',
      idempotencyKey: 'comment:1:newest',
    };
    const first = harness.core.conversation.record(command);
    assert.deepEqual(harness.core.conversation.record(command), first);
    harness.core.conversation.record({
      ...command,
      type: 'AddComment',
      body: 'Older body delivered late',
      occurredAt: '2026-08-25T10:01:00.000Z',
      idempotencyKey: 'comment:1:older',
    });
    assert.equal(
      harness.core.conversation.query({
        taskId: 'task-comments-1',
        commentId: 'comment-1',
      }).body,
      'Newest body',
    );
    assert.throws(
      () => harness.core.conversation.record({ ...command, body: 'Different body' }),
      (error) => error?.code === 'IDEMPOTENCY_CONFLICT',
    );
    assert.throws(
      () => harness.core.conversation.record({
        ...command,
        taskId: 'missing-task',
        idempotencyKey: 'comment:missing-task',
      }),
      (error) => error?.code === 'TASK_NOT_FOUND',
    );
  } finally {
    harness.cleanup();
  }
});

test('TaskAudience merges business roles without treating followers as domain facts', () => {
  const harness = createHarness({ acceptorId: 'owner-1' });
  try {
    assert.deepEqual(harness.core.audience.resolve({ taskId: 'task-comments-1' }), [
      { recipientId: 'owner-1', roles: ['owner', 'acceptor'] },
      { recipientId: 'agent-1', roles: ['assignee'] },
    ]);
  } finally {
    harness.cleanup();
  }
});

test('NotificationPolicy routes critical work, suppresses progress and never notifies the actor', () => {
  const harness = createHarness();
  try {
    assert.deepEqual(
      harness.core.notifications.decide({
        taskId: 'task-comments-1',
        eventId: 'event-review-1',
        kind: 'review',
        actorId: 'agent-1',
      }).deliveries,
      [{
        recipientId: 'acceptor-1',
        reason: 'review_required',
        urgency: 'high',
        deliveryMode: 'immediate',
        coalesceWindowMs: 0,
        dedupeKey: 'event-review-1:acceptor-1',
      }],
    );
    assert.deepEqual(
      harness.core.notifications.decide({
        taskId: 'task-comments-1',
        eventId: 'event-failed-1',
        kind: 'failed',
        actorId: 'owner-1',
      }).deliveries,
      [{
        recipientId: 'agent-1',
        reason: 'failed',
        urgency: 'high',
        deliveryMode: 'coalesce',
        coalesceWindowMs: 30_000,
        dedupeKey: 'event-failed-1:agent-1',
      }],
    );
    for (const kind of ['blocked', 'overdue']) {
      assert.deepEqual(
        harness.core.notifications.decide({
          taskId: 'task-comments-1',
          eventId: `event-${kind}-1`,
          kind,
        }).deliveries.map(({ recipientId, reason, deliveryMode, coalesceWindowMs }) => ({
          recipientId,
          reason,
          deliveryMode,
          coalesceWindowMs,
        })),
        [
          {
            recipientId: 'owner-1',
            reason: kind,
            deliveryMode: 'coalesce',
            coalesceWindowMs: 30_000,
          },
          {
            recipientId: 'agent-1',
            reason: kind,
            deliveryMode: 'coalesce',
            coalesceWindowMs: 30_000,
          },
        ],
      );
    }
    assert.deepEqual(
      harness.core.notifications.decide({
        taskId: 'task-comments-1',
        eventId: 'event-progress-1',
        kind: 'progress',
        actorId: 'agent-1',
      }).deliveries,
      [],
    );
    assert.deepEqual(
      harness.core.notifications.decide({
        taskId: 'task-comments-1',
        eventId: 'event-question-1',
        kind: 'action_required',
        actorId: 'owner-1',
        targetIds: ['owner-1', 'agent-1'],
      }).deliveries.map(({ recipientId }) => recipientId),
      ['agent-1'],
    );
    assert.throws(
      () => harness.core.notifications.decide({
        taskId: 'task-comments-1',
        eventId: 'event-question-2',
        kind: 'action_required',
        targetIds: ['feishu-follower-without-core-role'],
      }),
      (error) => error?.code === 'INVALID_NOTIFICATION_TARGET',
    );
  } finally {
    harness.cleanup();
  }
});
