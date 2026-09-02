import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { openCommitmentCore } from '../core.js';
import { mapExternalTaskEvent } from '../external-task-adapter.js';

test('an external native-task completion submits for review and cannot accept the Task', () => {
  const testPrefix = 'zylos-external-task-adapter-';
  const directory = mkdtempSync(path.join(os.tmpdir(), testPrefix));
  let taskEvent = 0;
  const core = openCommitmentCore({
    dbPath: path.join(directory, 'commitments.db'),
    clock: () => '2026-08-25T12:00:00.000Z',
    idGenerator: () => 'task-native-completion',
    eventIdGenerator: () => `task-event-${++taskEvent}`,
  });
  try {
    const created = core.ingest({
      idempotencyKey: 'source:task-native-completion',
      source: { channel: 'feishu', externalId: 'task-guid-1', senderId: 'ou_owner' },
      task: {
        title: 'Verify native completion semantics',
        ownerId: 'ou_owner',
        acceptorId: 'ou_acceptor',
        assigneeId: 'agent:yueran',
      },
    });
    const started = core.command({
      type: 'StartTask',
      taskId: created.task.id,
      actorId: 'agent:yueran',
      idempotencyKey: 'task:start:native-completion',
    }, created.task.version);
    const mapped = mapExternalTaskEvent({
      backend: 'feishu-task',
      eventId: 'evt-native-completed-1',
      eventType: 'completed',
      taskId: created.task.id,
      actorId: 'agent:yueran',
      expectedVersion: started.task.version,
    });

    const completed = core.command(mapped.command, mapped.expectedVersion);

    assert.equal(mapped.command.type, 'SubmitForReview');
    assert.notEqual(mapped.command.type, 'AcceptTask');
    assert.equal(completed.task.state, 'review');
    assert.equal(completed.event.type, 'TaskSubmittedForReview');
    assert.equal(
      core.query({ taskId: created.task.id, includeEvents: true }).events
        .some(({ type }) => type === 'TaskAccepted'),
      false,
    );
  } finally {
    core.close();
    assert.equal(path.dirname(directory), os.tmpdir());
    assert.equal(path.basename(directory).startsWith(testPrefix), true);
    rmSync(directory, { recursive: true, force: true });
  }
});

test('external native-task acceptance-shaped events fail closed', () => {
  const event = {
    backend: 'feishu-task',
    eventId: 'evt-native-acceptance',
    eventType: 'accepted',
    taskId: 'task-native-completion',
    actorId: 'ou_acceptor',
    expectedVersion: 3,
  };

  for (const eventType of ['accepted', 'approved', 'done', 'succeeded']) {
    assert.throws(
      () => mapExternalTaskEvent({ ...event, eventType }),
      TypeError,
    );
  }
});
