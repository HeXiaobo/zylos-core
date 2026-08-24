import test from 'node:test';
import assert from 'node:assert/strict';

import { mapExternalExecutionEvent } from '../external-execution-adapter.js';

test('maps a normalized work_started event to a Core StartTask command', () => {
  assert.deepEqual(
    mapExternalExecutionEvent({
      backend: 'openmax',
      eventId: 'evt-start-1',
      eventType: 'work_started',
      taskId: 'task-1',
      actorId: 'agent:yueran',
      expectedVersion: 1,
    }),
    {
      command: {
        type: 'StartTask',
        taskId: 'task-1',
        actorId: 'agent:yueran',
        idempotencyKey: 'openmax:evt-start-1:task-command',
      },
      expectedVersion: 1,
    },
  );
});

test('maps deliverable and backend completion signals to review, never acceptance', () => {
  const cases = [
    ['paperclip', 'deliverable_submitted'],
    ['openmax', 'completed'],
    ['local', 'done'],
    ['local.worker', 'succeeded'],
  ];

  for (const [backend, eventType] of cases) {
    const result = mapExternalExecutionEvent({
      backend,
      eventId: `evt-${eventType}`,
      eventType,
      taskId: 'task-review',
      actorId: 'agent:executor',
      expectedVersion: 2,
    });

    assert.equal(result.command.type, 'SubmitForReview');
    assert.notEqual(result.command.type, 'AcceptTask');
    assert.equal(
      result.command.idempotencyKey,
      `${backend}:evt-${eventType}:task-command`,
    );
  }
});

test('fails closed for malformed, unknown, or human-acceptance events', () => {
  const valid = {
    backend: 'openmax',
    eventId: 'evt-valid',
    eventType: 'work_started',
    taskId: 'task-valid',
    actorId: 'agent:executor',
    expectedVersion: 1,
  };
  const invalidEvents = [
    undefined,
    null,
    [],
    {},
    { ...valid, backend: '' },
    { ...valid, backend: 'OpenMax' },
    { ...valid, eventId: '   ' },
    { ...valid, eventId: 42 },
    { ...valid, eventType: '' },
    { ...valid, eventType: 'work_paused' },
    { ...valid, eventType: 'accepted' },
    { ...valid, eventType: 'approved' },
    { ...valid, eventType: 'deliverable_accepted' },
    { ...valid, taskId: '' },
    { ...valid, actorId: '   ' },
    { ...valid, expectedVersion: 0 },
    { ...valid, expectedVersion: -1 },
    { ...valid, expectedVersion: 1.5 },
    { ...valid, expectedVersion: '1' },
    { ...valid, platformMetadata: {} },
  ];

  for (const event of invalidEvents) {
    assert.throws(() => mapExternalExecutionEvent(event), TypeError);
  }
});
