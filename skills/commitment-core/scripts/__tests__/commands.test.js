import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import Database from 'better-sqlite3';

import { openCommitmentCore } from '../core.js';

function createHarness({ taskId = 'task-001', eventIds = ['event-001'] } = {}) {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'zylos-commitment-command-'));
  const dbPath = path.join(directory, 'commitments.db');
  let eventIndex = 0;
  let creationEventPending = true;
  const core = openCommitmentCore({
    dbPath,
    clock: () => '2026-08-25T10:00:00.000Z',
    idGenerator: () => taskId,
    eventIdGenerator: () => {
      if (creationEventPending) {
        creationEventPending = false;
        return `event-created-${taskId}`;
      }
      return eventIds[eventIndex++];
    },
  });

  return {
    core,
    dbPath,
    cleanup() {
      core.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

function readyEnvelope(overrides = {}) {
  return {
    idempotencyKey: `source:${overrides.taskId ?? 'task-001'}`,
    source: {
      channel: 'test',
      externalId: `source:${overrides.taskId ?? 'task-001'}`,
      senderId: 'requester-1',
    },
    task: {
      title: '完成客户跟进',
      ownerId: 'owner-1',
      acceptorId: 'acceptor-1',
      assigneeId: 'assignee-1',
      ...overrides,
    },
  };
}

function ingestReadyTask(core, overrides = {}) {
  return core.ingest(readyEnvelope(overrides)).task;
}

function moveToReview(core) {
  core.command({
    type: 'StartTask',
    taskId: 'task-001',
    actorId: 'assignee-1',
    idempotencyKey: 'command:start:task-001',
  }, 1);
  core.command({
    type: 'SubmitForReview',
    taskId: 'task-001',
    actorId: 'assignee-1',
    idempotencyKey: 'command:submit:task-001',
  }, 2);
}

test('StartTask moves ready to in_progress and records one domain event', () => {
  const harness = createHarness();

  try {
    ingestReadyTask(harness.core);

    const result = harness.core.command({
      type: 'StartTask',
      taskId: 'task-001',
      actorId: 'assignee-1',
      idempotencyKey: 'command:start:task-001',
    }, 1);

    assert.equal(result.task.state, 'in_progress');
    assert.equal(result.task.version, 2);
    assert.deepEqual(result.event, {
      id: 'event-001',
      type: 'TaskStarted',
      taskId: 'task-001',
      actorId: 'assignee-1',
      fromState: 'ready',
      toState: 'in_progress',
      version: 2,
      occurredAt: '2026-08-25T10:00:00.000Z',
    });
    const history = harness.core.query({ taskId: 'task-001', includeEvents: true });
    assert.deepEqual(history.task, result.task);
    assert.equal(history.events.length, 2);
    assert.equal(history.events[0].type, 'TaskCreated');
    assert.deepEqual(history.events[1], result.event);
  } finally {
    harness.cleanup();
  }
});

test('UpdateTaskReminder changes the canonical reminder and projects one Task event', () => {
  const harness = createHarness({ eventIds: ['event-reminder'] });

  try {
    harness.core.outbox.register({
      projection: 'test-reminder',
      bootstrapPolicy: 'from_beginning',
      actorId: 'test-operator',
      idempotencyKey: 'register:test-reminder',
    });
    ingestReadyTask(harness.core, {
      dueAt: '2026-08-28T18:00:00+08:00',
    });

    const result = harness.core.command({
      type: 'UpdateTaskReminder',
      taskId: 'task-001',
      actorId: 'owner-1',
      reminderMinutesBeforeDue: 60,
      idempotencyKey: 'command:reminder:task-001',
    }, 1);

    assert.equal(result.task.reminderMinutesBeforeDue, 60);
    assert.equal(result.task.version, 2);
    assert.deepEqual(result.event, {
      id: 'event-reminder',
      type: 'TaskReminderUpdated',
      taskId: 'task-001',
      actorId: 'owner-1',
      fromState: 'ready',
      toState: 'ready',
      version: 2,
      occurredAt: '2026-08-25T10:00:00.000Z',
    });
    assert.deepEqual(
      harness.core.query({ taskId: 'task-001', includeEvents: true })
        .events.map((event) => event.type),
      ['TaskCreated', 'TaskReminderUpdated'],
    );
    assert.deepEqual(
      harness.core.outbox.query({ projection: 'test-reminder', limit: 10 })
        .map((delivery) => delivery.event.type),
      ['TaskCreated', 'TaskReminderUpdated'],
    );
  } finally {
    harness.cleanup();
  }
});

test('UpdateTaskReminder records a deterministic receipt without mutation when the value matches', () => {
  const harness = createHarness({ eventIds: ['event-reminder-change'] });

  try {
    harness.core.outbox.register({
      projection: 'test-reminder-noop',
      bootstrapPolicy: 'from_beginning',
      actorId: 'test-operator',
      idempotencyKey: 'register:test-reminder-noop',
    });
    const original = ingestReadyTask(harness.core, {
      dueAt: '2026-08-28T18:00:00+08:00',
      reminderMinutesBeforeDue: 60,
    });
    const command = {
      type: 'UpdateTaskReminder',
      taskId: 'task-001',
      actorId: 'owner-1',
      reminderMinutesBeforeDue: 60,
      idempotencyKey: 'command:reminder:no-op',
    };

    const noOp = harness.core.command(command, 1);
    assert.deepEqual(noOp, { task: original, event: null });
    assert.deepEqual(
      harness.core.query({ taskId: 'task-001', includeEvents: true })
        .events.map((event) => event.type),
      ['TaskCreated'],
    );
    assert.deepEqual(
      harness.core.outbox.query({ projection: 'test-reminder-noop', limit: 10 })
        .map((delivery) => delivery.event.type),
      ['TaskCreated'],
    );

    harness.core.command({
      ...command,
      reminderMinutesBeforeDue: 30,
      idempotencyKey: 'command:reminder:change-after-no-op',
    }, 1);
    assert.deepEqual(harness.core.command(command, 1), noOp);
    assert.throws(
      () => harness.core.command({ ...command, reminderMinutesBeforeDue: 15 }, 1),
      (error) => error?.code === 'IDEMPOTENCY_CONFLICT',
    );
  } finally {
    harness.cleanup();
  }
});

test('UpdateTaskReminder requires the Task to have a canonical deadline', () => {
  const harness = createHarness();

  try {
    ingestReadyTask(harness.core);

    assert.throws(
      () => harness.core.command({
        type: 'UpdateTaskReminder',
        taskId: 'task-001',
        actorId: 'owner-1',
        reminderMinutesBeforeDue: 60,
        idempotencyKey: 'command:reminder:without-due-at',
      }, 1),
      (error) => error?.code === 'REMINDER_REQUIRES_DUE_AT',
    );
    const unchanged = harness.core.query({ taskId: 'task-001', includeEvents: true });
    assert.equal(unchanged.task.version, 1);
    assert.deepEqual(unchanged.events.map((event) => event.type), ['TaskCreated']);
  } finally {
    harness.cleanup();
  }
});

test('UpdateTaskReminder accepts zero and rejects values outside non-negative safe integers', () => {
  const harness = createHarness({ eventIds: ['event-reminder-zero'] });

  try {
    ingestReadyTask(harness.core, { dueAt: '2026-08-28T18:00:00+08:00' });
    const zero = harness.core.command({
      type: 'UpdateTaskReminder',
      taskId: 'task-001',
      actorId: 'owner-1',
      reminderMinutesBeforeDue: 0,
      idempotencyKey: 'command:reminder:zero',
    }, 1);
    assert.equal(zero.task.reminderMinutesBeforeDue, 0);

    for (const [index, reminderMinutesBeforeDue] of [
      -1,
      1.5,
      '60',
      Number.MAX_SAFE_INTEGER + 1,
      null,
    ].entries()) {
      assert.throws(
        () => harness.core.command({
          type: 'UpdateTaskReminder',
          taskId: 'task-001',
          actorId: 'owner-1',
          reminderMinutesBeforeDue,
          idempotencyKey: `command:reminder:invalid:${index}`,
        }, 2),
        (error) => error instanceof TypeError,
      );
    }
  } finally {
    harness.cleanup();
  }
});

test('UpdateTaskReminder allows the acceptor and rejects actors outside owner or acceptor', () => {
  const harness = createHarness({ eventIds: ['event-reminder-acceptor'] });

  try {
    ingestReadyTask(harness.core, { dueAt: '2026-08-28T18:00:00+08:00' });
    const updated = harness.core.command({
      type: 'UpdateTaskReminder',
      taskId: 'task-001',
      actorId: 'acceptor-1',
      reminderMinutesBeforeDue: 60,
      idempotencyKey: 'command:reminder:acceptor',
    }, 1);
    assert.equal(updated.event.actorId, 'acceptor-1');

    assert.throws(
      () => harness.core.command({
        type: 'UpdateTaskReminder',
        taskId: 'task-001',
        actorId: 'assignee-1',
        reminderMinutesBeforeDue: 30,
        idempotencyKey: 'command:reminder:forbidden',
      }, 2),
      (error) => error?.code === 'FORBIDDEN',
    );
    assert.equal(harness.core.query({ taskId: 'task-001' }).version, 2);
  } finally {
    harness.cleanup();
  }
});

test('UpdateTaskReminder is available only while a Task can still be acted on', () => {
  const cases = [
    {
      state: 'done',
      version: 4,
      eventIds: ['event-start', 'event-submit', 'event-accept'],
      prepare: moveToReview,
      finish(core) {
        core.command({
          type: 'AcceptTask',
          taskId: 'task-001',
          actorId: 'acceptor-1',
          idempotencyKey: 'command:accept:reminder-state',
        }, 3);
      },
    },
    {
      state: 'cancelled',
      version: 2,
      eventIds: ['event-cancel'],
      prepare() {},
      finish(core) {
        core.command({
          type: 'CancelTask',
          taskId: 'task-001',
          actorId: 'owner-1',
          idempotencyKey: 'command:cancel:reminder-state',
        }, 1);
      },
    },
  ];

  for (const testCase of cases) {
    const harness = createHarness({ eventIds: testCase.eventIds });
    try {
      ingestReadyTask(harness.core, { dueAt: '2026-08-28T18:00:00+08:00' });
      testCase.prepare(harness.core);
      testCase.finish(harness.core);
      assert.throws(
        () => harness.core.command({
          type: 'UpdateTaskReminder',
          taskId: 'task-001',
          actorId: 'owner-1',
          reminderMinutesBeforeDue: 60,
          idempotencyKey: `command:reminder:${testCase.state}`,
        }, testCase.version),
        (error) => error?.code === 'INVALID_TRANSITION',
        testCase.state,
      );
    } finally {
      harness.cleanup();
    }
  }
});

test('UpdateTaskReminder preserves in_progress and review state', () => {
  const harness = createHarness({
    eventIds: [
      'event-start-reminder-states',
      'event-reminder-in-progress',
      'event-submit-reminder-states',
      'event-reminder-review',
    ],
  });

  try {
    ingestReadyTask(harness.core, { dueAt: '2026-08-28T18:00:00+08:00' });
    harness.core.command({
      type: 'StartTask',
      taskId: 'task-001',
      actorId: 'assignee-1',
      idempotencyKey: 'command:start:reminder-states',
    }, 1);
    const inProgress = harness.core.command({
      type: 'UpdateTaskReminder',
      taskId: 'task-001',
      actorId: 'owner-1',
      reminderMinutesBeforeDue: 60,
      idempotencyKey: 'command:reminder:in-progress',
    }, 2);
    assert.equal(inProgress.task.state, 'in_progress');
    assert.equal(inProgress.event.fromState, 'in_progress');
    assert.equal(inProgress.event.toState, 'in_progress');

    harness.core.command({
      type: 'SubmitForReview',
      taskId: 'task-001',
      actorId: 'assignee-1',
      idempotencyKey: 'command:submit:reminder-states',
    }, 3);
    const review = harness.core.command({
      type: 'UpdateTaskReminder',
      taskId: 'task-001',
      actorId: 'acceptor-1',
      reminderMinutesBeforeDue: 30,
      idempotencyKey: 'command:reminder:review',
    }, 4);
    assert.equal(review.task.state, 'review');
    assert.equal(review.event.fromState, 'review');
    assert.equal(review.event.toState, 'review');
  } finally {
    harness.cleanup();
  }
});

test('UpdateTaskReminder applies expectedVersion CAS before a same-value no-op', () => {
  const harness = createHarness();

  try {
    ingestReadyTask(harness.core, {
      dueAt: '2026-08-28T18:00:00+08:00',
      reminderMinutesBeforeDue: 60,
    });
    assert.throws(
      () => harness.core.command({
        type: 'UpdateTaskReminder',
        taskId: 'task-001',
        actorId: 'owner-1',
        reminderMinutesBeforeDue: 60,
        idempotencyKey: 'command:reminder:stale-no-op',
      }, 2),
      (error) => error?.code === 'VERSION_CONFLICT',
    );
    const unchanged = harness.core.query({ taskId: 'task-001', includeEvents: true });
    assert.equal(unchanged.task.version, 1);
    assert.deepEqual(unchanged.events.map((event) => event.type), ['TaskCreated']);
  } finally {
    harness.cleanup();
  }
});

test('UpdateTaskReminder rolls Task, Event, receipt, and Outbox back together', () => {
  const harness = createHarness({
    eventIds: ['event-reminder-failed', 'event-reminder-retry'],
  });
  const raw = new Database(harness.dbPath);

  try {
    harness.core.outbox.register({
      projection: 'test-reminder-atomicity',
      bootstrapPolicy: 'from_beginning',
      actorId: 'test-operator',
      idempotencyKey: 'register:test-reminder-atomicity',
    });
    ingestReadyTask(harness.core, { dueAt: '2026-08-28T18:00:00+08:00' });
    raw.exec(`
      CREATE TRIGGER reject_reminder_projection_record
      BEFORE INSERT ON commitment_projection_outbox
      BEGIN
        SELECT RAISE(ABORT, 'reminder projection outbox rejected');
      END;
    `);
    const command = {
      type: 'UpdateTaskReminder',
      taskId: 'task-001',
      actorId: 'owner-1',
      reminderMinutesBeforeDue: 60,
      idempotencyKey: 'command:reminder:atomicity',
    };

    assert.throws(
      () => harness.core.command(command, 1),
      /reminder projection outbox rejected/,
    );
    const afterFailure = harness.core.query({ taskId: 'task-001', includeEvents: true });
    assert.equal(afterFailure.task.reminderMinutesBeforeDue, null);
    assert.equal(afterFailure.task.version, 1);
    assert.deepEqual(afterFailure.events.map((event) => event.type), ['TaskCreated']);
    assert.deepEqual(
      harness.core.outbox.query({ projection: 'test-reminder-atomicity', limit: 10 })
        .map((delivery) => delivery.event.type),
      ['TaskCreated'],
    );

    raw.exec('DROP TRIGGER reject_reminder_projection_record');
    const retry = harness.core.command(command, 1);
    assert.equal(retry.event.id, 'event-reminder-retry');
    assert.equal(retry.task.reminderMinutesBeforeDue, 60);
  } finally {
    raw.close();
    harness.cleanup();
  }
});

test('ingest records one TaskCreated event and source replay does not duplicate it', () => {
  const harness = createHarness();

  try {
    const envelope = readyEnvelope();
    const first = harness.core.ingest(envelope);
    const replay = harness.core.ingest(envelope);
    const history = harness.core.query({ taskId: first.task.id, includeEvents: true });

    assert.equal(replay.created, false);
    assert.deepEqual(history.events, [{
      id: 'event-created-task-001',
      type: 'TaskCreated',
      taskId: 'task-001',
      actorId: 'requester-1',
      fromState: null,
      toState: 'ready',
      version: 1,
      occurredAt: '2026-08-25T10:00:00.000Z',
    }]);
  } finally {
    harness.cleanup();
  }
});

test('TaskCreated falls back to owner when the source has no sender', () => {
  const harness = createHarness();

  try {
    const envelope = readyEnvelope();
    delete envelope.source.senderId;
    const created = harness.core.ingest(envelope);
    const [event] = harness.core.query({
      taskId: created.task.id,
      includeEvents: true,
    }).events;

    assert.equal(event.actorId, 'owner-1');
  } finally {
    harness.cleanup();
  }
});

test('SubmitForReview moves in_progress to review for the assignee', () => {
  const harness = createHarness({ eventIds: ['event-start', 'event-submit'] });

  try {
    ingestReadyTask(harness.core);
    harness.core.command({
      type: 'StartTask',
      taskId: 'task-001',
      actorId: 'assignee-1',
      idempotencyKey: 'command:start:task-001',
    }, 1);

    const result = harness.core.command({
      type: 'SubmitForReview',
      taskId: 'task-001',
      actorId: 'assignee-1',
      idempotencyKey: 'command:submit:task-001',
    }, 2);

    assert.equal(result.task.state, 'review');
    assert.equal(result.task.version, 3);
    assert.equal(result.event.type, 'TaskSubmittedForReview');
    assert.equal(result.event.fromState, 'in_progress');
    assert.equal(result.event.toState, 'review');
  } finally {
    harness.cleanup();
  }
});

test('AcceptTask moves review to done for the acceptor', () => {
  const harness = createHarness({ eventIds: ['event-start', 'event-submit', 'event-accept'] });

  try {
    ingestReadyTask(harness.core);
    moveToReview(harness.core);

    const result = harness.core.command({
      type: 'AcceptTask',
      taskId: 'task-001',
      actorId: 'acceptor-1',
      idempotencyKey: 'command:accept:task-001',
    }, 3);

    assert.equal(result.task.state, 'done');
    assert.equal(result.task.version, 4);
    assert.equal(result.event.type, 'TaskAccepted');
    assert.equal(result.event.fromState, 'review');
    assert.equal(result.event.toState, 'done');
  } finally {
    harness.cleanup();
  }
});

test('RequestChanges moves review back to ready for the acceptor', () => {
  const harness = createHarness({ eventIds: ['event-start', 'event-submit', 'event-changes'] });

  try {
    ingestReadyTask(harness.core);
    moveToReview(harness.core);

    const result = harness.core.command({
      type: 'RequestChanges',
      taskId: 'task-001',
      actorId: 'acceptor-1',
      idempotencyKey: 'command:changes:task-001',
    }, 3);

    assert.equal(result.task.state, 'ready');
    assert.equal(result.task.version, 4);
    assert.equal(result.event.type, 'TaskChangesRequested');
    assert.equal(result.event.fromState, 'review');
    assert.equal(result.event.toState, 'ready');
  } finally {
    harness.cleanup();
  }
});

test('CancelTask moves ready, in_progress, or review to cancelled', () => {
  const cases = [
    { state: 'ready', expectedVersion: 1, prepare() {}, eventIds: ['event-cancel'] },
    {
      state: 'in_progress',
      expectedVersion: 2,
      eventIds: ['event-start', 'event-cancel'],
      prepare(core) {
        core.command({
          type: 'StartTask',
          taskId: 'task-001',
          actorId: 'assignee-1',
          idempotencyKey: 'command:start:task-001',
        }, 1);
      },
    },
    {
      state: 'review',
      expectedVersion: 3,
      eventIds: ['event-start', 'event-submit', 'event-cancel'],
      prepare: moveToReview,
    },
  ];

  for (const testCase of cases) {
    const harness = createHarness({ eventIds: testCase.eventIds });
    try {
      ingestReadyTask(harness.core);
      testCase.prepare(harness.core);

      const result = harness.core.command({
        type: 'CancelTask',
        taskId: 'task-001',
        actorId: 'owner-1',
        idempotencyKey: `command:cancel:${testCase.state}`,
      }, testCase.expectedVersion);

      assert.equal(result.task.state, 'cancelled', testCase.state);
      assert.equal(result.event.type, 'TaskCancelled', testCase.state);
      assert.equal(result.event.fromState, testCase.state, testCase.state);
      assert.equal(result.event.toState, 'cancelled', testCase.state);
    } finally {
      harness.cleanup();
    }
  }
});

test('ReopenTask moves done back to ready for the owner', () => {
  const harness = createHarness({
    eventIds: ['event-start', 'event-submit', 'event-accept', 'event-reopen'],
  });

  try {
    ingestReadyTask(harness.core);
    moveToReview(harness.core);
    harness.core.command({
      type: 'AcceptTask',
      taskId: 'task-001',
      actorId: 'acceptor-1',
      idempotencyKey: 'command:accept:task-001',
    }, 3);

    const result = harness.core.command({
      type: 'ReopenTask',
      taskId: 'task-001',
      actorId: 'owner-1',
      idempotencyKey: 'command:reopen:task-001',
    }, 4);

    assert.equal(result.task.state, 'ready');
    assert.equal(result.task.version, 5);
    assert.equal(result.event.type, 'TaskReopened');
    assert.equal(result.event.fromState, 'done');
    assert.equal(result.event.toState, 'ready');
  } finally {
    harness.cleanup();
  }
});

test('command receipts replay the original result and reject different content', () => {
  const harness = createHarness({ eventIds: ['event-start', 'event-submit'] });

  try {
    ingestReadyTask(harness.core);
    const command = {
      type: 'StartTask',
      taskId: 'task-001',
      actorId: 'assignee-1',
      idempotencyKey: 'command:stable-key',
    };
    const first = harness.core.command(command, 1);
    harness.core.command({
      type: 'SubmitForReview',
      taskId: 'task-001',
      actorId: 'assignee-1',
      idempotencyKey: 'command:submit:task-001',
    }, 2);

    assert.deepEqual(harness.core.command(command, 1), first);
    assert.throws(
      () => harness.core.command({ ...command, actorId: 'owner-1' }, 1),
      (error) => error?.code === 'IDEMPOTENCY_CONFLICT',
    );
  } finally {
    harness.cleanup();
  }
});

test('commands reject invalid expected versions, stale versions, and illegal transitions', () => {
  const harness = createHarness();

  try {
    ingestReadyTask(harness.core);
    const start = {
      type: 'StartTask',
      taskId: 'task-001',
      actorId: 'assignee-1',
      idempotencyKey: 'command:start:validation',
    };

    for (const invalidVersion of [0, -1, 1.5, '1', null]) {
      assert.throws(
        () => harness.core.command(start, invalidVersion),
        (error) => error instanceof TypeError,
      );
    }
    assert.throws(
      () => harness.core.command(start, 2),
      (error) => error?.code === 'VERSION_CONFLICT',
    );
    assert.throws(
      () => harness.core.command({
        type: 'SubmitForReview',
        taskId: 'task-001',
        actorId: 'assignee-1',
        idempotencyKey: 'command:submit:too-early',
      }, 1),
      (error) => error?.code === 'INVALID_TRANSITION',
    );

    const unchanged = harness.core.query({ taskId: 'task-001', includeEvents: true });
    assert.deepEqual(unchanged.task, harness.core.query({ taskId: 'task-001' }));
    assert.deepEqual(unchanged.events.map((event) => event.type), ['TaskCreated']);
  } finally {
    harness.cleanup();
  }
});

test('each command rejects actors outside its role policy', () => {
  const cases = [
    {
      type: 'StartTask',
      actorId: 'owner-1',
      version: 1,
      eventIds: ['event-unused'],
      prepare() {},
    },
    {
      type: 'SubmitForReview',
      actorId: 'owner-1',
      version: 2,
      eventIds: ['event-start', 'event-unused'],
      prepare(core) {
        core.command({
          type: 'StartTask', taskId: 'task-001', actorId: 'assignee-1',
          idempotencyKey: 'command:start:permission',
        }, 1);
      },
    },
    {
      type: 'AcceptTask',
      actorId: 'owner-1',
      version: 3,
      eventIds: ['event-start', 'event-submit', 'event-unused'],
      prepare: moveToReview,
    },
    {
      type: 'RequestChanges',
      actorId: 'owner-1',
      version: 3,
      eventIds: ['event-start', 'event-submit', 'event-unused'],
      prepare: moveToReview,
    },
    {
      type: 'CancelTask',
      actorId: 'stranger-1',
      version: 1,
      eventIds: ['event-unused'],
      prepare() {},
    },
    {
      type: 'ReopenTask',
      actorId: 'stranger-1',
      version: 4,
      eventIds: ['event-start', 'event-submit', 'event-accept', 'event-unused'],
      prepare(core) {
        moveToReview(core);
        core.command({
          type: 'AcceptTask', taskId: 'task-001', actorId: 'acceptor-1',
          idempotencyKey: 'command:accept:permission',
        }, 3);
      },
    },
  ];

  for (const testCase of cases) {
    const harness = createHarness({ eventIds: testCase.eventIds });
    try {
      ingestReadyTask(harness.core);
      testCase.prepare(harness.core);
      assert.throws(
        () => harness.core.command({
          type: testCase.type,
          taskId: 'task-001',
          actorId: testCase.actorId,
          idempotencyKey: `command:forbidden:${testCase.type}`,
        }, testCase.version),
        (error) => error?.code === 'FORBIDDEN',
        testCase.type,
      );
    } finally {
      harness.cleanup();
    }
  }
});

test('owner performs assignee commands when the task has no assignee', () => {
  const harness = createHarness({ eventIds: ['event-start', 'event-submit'] });

  try {
    ingestReadyTask(harness.core, { assigneeId: null });
    harness.core.command({
      type: 'StartTask', taskId: 'task-001', actorId: 'owner-1',
      idempotencyKey: 'command:start:owner-fallback',
    }, 1);
    const result = harness.core.command({
      type: 'SubmitForReview', taskId: 'task-001', actorId: 'owner-1',
      idempotencyKey: 'command:submit:owner-fallback',
    }, 2);

    assert.equal(result.task.state, 'review');
  } finally {
    harness.cleanup();
  }
});

test('acceptor can cancel active work and reopen completed work', () => {
  const cancelHarness = createHarness({ eventIds: ['event-cancel'] });
  try {
    ingestReadyTask(cancelHarness.core);
    const cancelled = cancelHarness.core.command({
      type: 'CancelTask', taskId: 'task-001', actorId: 'acceptor-1',
      idempotencyKey: 'command:cancel:acceptor',
    }, 1);
    assert.equal(cancelled.task.state, 'cancelled');
  } finally {
    cancelHarness.cleanup();
  }

  const reopenHarness = createHarness({
    eventIds: ['event-start', 'event-submit', 'event-accept', 'event-reopen'],
  });
  try {
    ingestReadyTask(reopenHarness.core);
    moveToReview(reopenHarness.core);
    reopenHarness.core.command({
      type: 'AcceptTask', taskId: 'task-001', actorId: 'acceptor-1',
      idempotencyKey: 'command:accept:acceptor',
    }, 3);
    const reopened = reopenHarness.core.command({
      type: 'ReopenTask', taskId: 'task-001', actorId: 'acceptor-1',
      idempotencyKey: 'command:reopen:acceptor',
    }, 4);
    assert.equal(reopened.task.state, 'ready');
  } finally {
    reopenHarness.cleanup();
  }
});

test('opening a first-tranche database migrates task states without losing source replay', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'zylos-commitment-migration-'));
  const dbPath = path.join(directory, 'commitments.db');
  const envelope = {
    idempotencyKey: 'legacy-source-1',
    source: { channel: 'test', externalId: 'legacy-event-1', senderId: 'owner-1' },
    task: {
      title: '迁移已有任务',
      ownerId: 'owner-1',
      acceptorId: 'acceptor-1',
      assigneeId: 'assignee-1',
    },
  };
  const normalizedEnvelope = {
    idempotencyKey: envelope.idempotencyKey,
    source: envelope.source,
    task: {
      title: envelope.task.title,
      description: null,
      ownerId: envelope.task.ownerId,
      acceptorId: envelope.task.acceptorId,
      assigneeId: envelope.task.assigneeId,
    },
  };
  const fingerprint = createHash('sha256')
    .update(JSON.stringify(normalizedEnvelope))
    .digest('hex');
  const legacy = new Database(dbPath);
  legacy.pragma('foreign_keys = ON');
  legacy.exec(`
    CREATE TABLE commitment_tasks (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT,
      state TEXT NOT NULL CHECK (state IN ('ready')),
      owner_id TEXT NOT NULL,
      acceptor_id TEXT NOT NULL,
      assignee_id TEXT,
      version INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE commitment_sources (
      idempotency_key TEXT PRIMARY KEY,
      channel TEXT NOT NULL,
      external_id TEXT NOT NULL,
      sender_id TEXT,
      request_fingerprint TEXT NOT NULL,
      task_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (task_id) REFERENCES commitment_tasks(id) ON DELETE RESTRICT
    );
  `);
  legacy.prepare(`
    INSERT INTO commitment_tasks VALUES (?, ?, ?, 'ready', ?, ?, ?, 1, ?, ?)
  `).run(
    'task-legacy', '迁移已有任务', null, 'owner-1', 'acceptor-1', 'assignee-1',
    '2026-08-24T00:00:00.000Z', '2026-08-24T00:00:00.000Z',
  );
  legacy.prepare(`
    INSERT INTO commitment_sources VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    'legacy-source-1', 'test', 'legacy-event-1', 'owner-1', fingerprint,
    'task-legacy', '2026-08-24T00:00:00.000Z',
  );
  legacy.close();

  try {
    const migrationEventIds = ['event-migrated-created', 'event-migrated-start'];
    const core = openCommitmentCore({
      dbPath,
      clock: () => '2026-08-25T10:00:00.000Z',
      eventIdGenerator: () => migrationEventIds.shift(),
    });
    assert.deepEqual(
      core.query({ taskId: 'task-legacy', includeEvents: true }).events.map((event) => event.type),
      ['TaskCreated'],
    );
    assert.equal(core.query({ taskId: 'task-legacy' }).dueAt, null);
    assert.equal(core.query({ taskId: 'task-legacy' }).reminderMinutesBeforeDue, null);
    assert.equal(core.ingest(envelope).created, false);
    const started = core.command({
      type: 'StartTask',
      taskId: 'task-legacy',
      actorId: 'assignee-1',
      idempotencyKey: 'command:start:legacy',
    }, 1);
    assert.equal(started.task.state, 'in_progress');
    core.close();

    const reopened = openCommitmentCore({ dbPath });
    assert.equal(reopened.query({ taskId: 'task-legacy' }).state, 'in_progress');
    assert.deepEqual(
      reopened.query({ taskId: 'task-legacy', includeEvents: true }).events
        .map((event) => event.type),
      ['TaskCreated', 'TaskStarted'],
    );
    reopened.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('opening a database with non-null event origins enables TaskCreated backfill', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'zylos-event-migration-'));
  const dbPath = path.join(directory, 'commitments.db');
  const legacy = new Database(dbPath);
  legacy.pragma('foreign_keys = ON');
  legacy.exec(`
    CREATE TABLE commitment_tasks (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT,
      state TEXT NOT NULL CHECK (
        state IN ('ready', 'in_progress', 'review', 'done', 'cancelled')
      ),
      owner_id TEXT NOT NULL,
      acceptor_id TEXT NOT NULL,
      assignee_id TEXT,
      version INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE commitment_sources (
      idempotency_key TEXT PRIMARY KEY,
      channel TEXT NOT NULL,
      external_id TEXT NOT NULL,
      sender_id TEXT,
      request_fingerprint TEXT NOT NULL,
      task_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (task_id) REFERENCES commitment_tasks(id) ON DELETE RESTRICT
    );
    CREATE TABLE commitment_events (
      id TEXT PRIMARY KEY,
      event_type TEXT NOT NULL,
      task_id TEXT NOT NULL,
      actor_id TEXT NOT NULL,
      from_state TEXT NOT NULL,
      to_state TEXT NOT NULL,
      task_version INTEGER NOT NULL,
      occurred_at TEXT NOT NULL,
      FOREIGN KEY (task_id) REFERENCES commitment_tasks(id) ON DELETE RESTRICT
    );
    INSERT INTO commitment_tasks VALUES (
      'task-old-event-schema', '补齐创建事件', NULL, 'ready',
      'owner-1', 'acceptor-1', NULL, 1,
      '2026-08-24T00:00:00.000Z', '2026-08-24T00:00:00.000Z'
    );
    INSERT INTO commitment_sources VALUES (
      'source-old-event-schema', 'test', 'external-old-event-schema',
      'requester-1', 'unused-fingerprint', 'task-old-event-schema',
      '2026-08-24T00:00:00.000Z'
    );
  `);
  legacy.close();

  try {
    const core = openCommitmentCore({
      dbPath,
      eventIdGenerator: () => 'event-backfilled-created',
    });
    assert.deepEqual(
      core.query({ taskId: 'task-old-event-schema', includeEvents: true }).events,
      [{
        id: 'event-backfilled-created',
        type: 'TaskCreated',
        taskId: 'task-old-event-schema',
        actorId: 'requester-1',
        fromState: null,
        toState: 'ready',
        version: 1,
        occurredAt: '2026-08-24T00:00:00.000Z',
      }],
    );
    core.close();

    const reopened = openCommitmentCore({ dbPath });
    assert.equal(
      reopened.query({ taskId: 'task-old-event-schema', includeEvents: true }).events.length,
      1,
    );
    reopened.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('initial task, source receipt, and TaskCreated event roll back together', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'zylos-ingest-atomicity-'));
  const taskIds = ['task-first', 'task-second', 'task-second'];
  const eventIds = ['event-duplicate', 'event-duplicate', 'event-second'];
  const core = openCommitmentCore({
    dbPath: path.join(directory, 'commitments.db'),
    clock: () => '2026-08-25T10:00:00.000Z',
    idGenerator: () => taskIds.shift(),
    eventIdGenerator: () => eventIds.shift(),
  });

  try {
    core.ingest(readyEnvelope({ taskId: 'first' }));
    const secondEnvelope = readyEnvelope({ taskId: 'second' });

    assert.throws(
      () => core.ingest(secondEnvelope),
      (error) => error?.code === 'SQLITE_CONSTRAINT_PRIMARYKEY',
    );
    assert.equal(core.query({ taskId: 'task-second' }), null);

    const retry = core.ingest(secondEnvelope);
    assert.equal(retry.created, true);
    assert.equal(retry.task.id, 'task-second');
    assert.deepEqual(
      core.query({ taskId: 'task-second', includeEvents: true }).events
        .map((event) => event.type),
      ['TaskCreated'],
    );
  } finally {
    core.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('task update, event, and command receipt roll back together', () => {
  const harness = createHarness({ eventIds: ['event-duplicate', 'event-duplicate', 'event-retry'] });

  try {
    ingestReadyTask(harness.core);
    harness.core.command({
      type: 'StartTask', taskId: 'task-001', actorId: 'assignee-1',
      idempotencyKey: 'command:start:atomicity',
    }, 1);
    const submit = {
      type: 'SubmitForReview', taskId: 'task-001', actorId: 'assignee-1',
      idempotencyKey: 'command:submit:atomicity',
    };

    assert.throws(
      () => harness.core.command(submit, 2),
      (error) => error?.code === 'SQLITE_CONSTRAINT_PRIMARYKEY',
    );
    const afterFailure = harness.core.query({ taskId: 'task-001', includeEvents: true });
    assert.equal(afterFailure.task.state, 'in_progress');
    assert.equal(afterFailure.task.version, 2);
    assert.deepEqual(
      afterFailure.events.map((event) => event.type),
      ['TaskCreated', 'TaskStarted'],
    );

    const retry = harness.core.command(submit, 2);
    assert.equal(retry.task.state, 'review');
    assert.equal(retry.event.id, 'event-retry');
  } finally {
    harness.cleanup();
  }
});

test('commands require taskId, actorId, and idempotencyKey', () => {
  const harness = createHarness();

  try {
    ingestReadyTask(harness.core);
    const command = {
      type: 'StartTask',
      taskId: 'task-001',
      actorId: 'assignee-1',
      idempotencyKey: 'command:start:required-fields',
    };

    for (const field of ['taskId', 'actorId', 'idempotencyKey']) {
      const invalid = { ...command };
      delete invalid[field];
      assert.throws(
        () => harness.core.command(invalid, 1),
        (error) => error instanceof TypeError,
        field,
      );
    }
  } finally {
    harness.cleanup();
  }
});
