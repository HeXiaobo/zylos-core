import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { openCommitmentCore } from '../core.js';

const TEST_DIRECTORY_PREFIX = 'zylos-task-list-';

function createTestDirectory() {
  return mkdtempSync(path.join(os.tmpdir(), TEST_DIRECTORY_PREFIX));
}

function removeTestDirectory(directory) {
  assert.equal(path.dirname(directory), os.tmpdir());
  assert.equal(path.basename(directory).startsWith(TEST_DIRECTORY_PREFIX), true);
  rmSync(directory, { recursive: true, force: true });
}

function createTask(core, sourceId, task) {
  return core.ingest({
    idempotencyKey: `source:${sourceId}`,
    source: { channel: 'test', externalId: sourceId, senderId: task.ownerId },
    task: { title: sourceId, ...task },
  }).task;
}

test('list query filters tasks and uses stable recently-updated ordering', () => {
  const directory = createTestDirectory();
  const taskIds = ['task-1', 'task-2', 'task-3'];
  const timestamps = [
    '2026-08-25T01:00:00.000Z',
    '2026-08-25T02:00:00.000Z',
    '2026-08-25T03:00:00.000Z',
    '2026-08-25T04:00:00.000Z',
  ];
  let eventId = 0;
  const core = openCommitmentCore({
    dbPath: path.join(directory, 'commitments.db'),
    idGenerator: () => taskIds.shift(),
    eventIdGenerator: () => `event-${++eventId}`,
    clock: () => timestamps.shift(),
  });

  try {
    createTask(core, 'first', {
      ownerId: 'owner-1', acceptorId: 'acceptor-1', assigneeId: 'agent-1',
    });
    createTask(core, 'second', {
      ownerId: 'owner-1', acceptorId: 'acceptor-1', assigneeId: 'agent-2',
    });
    createTask(core, 'third', {
      ownerId: 'owner-2', acceptorId: 'acceptor-2', assigneeId: 'agent-1',
    });
    core.command({
      type: 'StartTask', taskId: 'task-2', actorId: 'agent-2',
      idempotencyKey: 'command:start:task-2',
    }, 1);

    assert.deepEqual(core.query({}).map((task) => task.id), ['task-2', 'task-3', 'task-1']);
    assert.deepEqual(
      core.query({ states: ['ready'] }).map((task) => task.id),
      ['task-3', 'task-1'],
    );
    assert.deepEqual(
      core.query({ ownerId: 'owner-1' }).map((task) => task.id),
      ['task-2', 'task-1'],
    );
    assert.deepEqual(
      core.query({ assigneeId: 'agent-1' }).map((task) => task.id),
      ['task-3', 'task-1'],
    );
    assert.deepEqual(
      core.query({
        states: ['ready'], ownerId: 'owner-1', assigneeId: 'agent-1', limit: 1,
      }).map((task) => task.id),
      ['task-1'],
    );
    assert.deepEqual(core.query({ limit: 1 }).map((task) => task.id), ['task-2']);
  } finally {
    core.close();
    removeTestDirectory(directory);
  }
});

test('list query cursor walks beyond the bounded page without gaps or duplicates', () => {
  const directory = createTestDirectory();
  let taskNumber = 0;
  const core = openCommitmentCore({
    dbPath: path.join(directory, 'commitments.db'),
    idGenerator: () => `task-${String(++taskNumber).padStart(3, '0')}`,
    clock: () => '2026-08-25T10:00:00.000Z',
  });

  try {
    for (let index = 1; index <= 5; index += 1) {
      createTask(core, `source-${index}`, { ownerId: 'owner-1' });
    }
    const first = core.query({ limit: 2 });
    const second = core.query({
      limit: 2,
      cursor: { updatedAt: first.at(-1).updatedAt, taskId: first.at(-1).id },
    });
    const third = core.query({
      limit: 2,
      cursor: { updatedAt: second.at(-1).updatedAt, taskId: second.at(-1).id },
    });

    assert.deepEqual(
      [...first, ...second, ...third].map(task => task.id),
      ['task-001', 'task-002', 'task-003', 'task-004', 'task-005'],
    );
  } finally {
    core.close();
    removeTestDirectory(directory);
  }
});

test('task and list query modes are mutually exclusive and strictly validated', () => {
  const directory = createTestDirectory();
  const core = openCommitmentCore({ dbPath: path.join(directory, 'commitments.db') });

  try {
    const invalidQueries = [
      null,
      [],
      { taskId: 'task-1', states: ['ready'] },
      { taskId: 'task-1', includeEvents: 'yes' },
      { includeEvents: true },
      { states: [] },
      { states: 'ready' },
      { states: ['unknown'] },
      { ownerId: null },
      { assigneeId: '' },
      { limit: 0 },
      { limit: 101 },
      { limit: 1.5 },
      { limit: '10' },
      { cursor: null },
      { cursor: { updatedAt: '2026-08-25T10:00:00.000Z' } },
      { cursor: { updatedAt: '2026-08-25T10:00:00.000Z', taskId: 'task-1', extra: true } },
      { unknown: true },
    ];

    for (const query of invalidQueries) {
      assert.throws(() => core.query(query), (error) => error instanceof TypeError);
    }
  } finally {
    core.close();
    removeTestDirectory(directory);
  }
});

test('list query defaults to at most fifty tasks', () => {
  const directory = createTestDirectory();
  let taskNumber = 0;
  const core = openCommitmentCore({
    dbPath: path.join(directory, 'commitments.db'),
    idGenerator: () => `task-${String(++taskNumber).padStart(3, '0')}`,
  });

  try {
    for (let index = 1; index <= 55; index += 1) {
      createTask(core, `source-${index}`, { ownerId: 'owner-1' });
    }
    assert.equal(core.query({}).length, 50);
    assert.equal(core.query({ limit: 100 }).length, 55);
  } finally {
    core.close();
    removeTestDirectory(directory);
  }
});
