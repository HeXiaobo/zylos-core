import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import Database from 'better-sqlite3';

import { openCommitmentCore } from '../core.js';

function createHarness({
  taskIds = ['task-adopted-1'],
  eventIds = ['event-adopted-1'],
  linkIds = ['external-link-adopted-1'],
} = {}) {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'zylos-legacy-adoption-'));
  const core = openCommitmentCore({
    dbPath: path.join(directory, 'commitments.db'),
    clock: () => '2026-08-27T10:00:00.000Z',
    idGenerator: () => taskIds.shift(),
    eventIdGenerator: () => eventIds.shift(),
    externalLinkIdGenerator: () => linkIds.shift(),
  });
  core.outbox.register({
    projection: 'feishu-task-v2',
    bootstrapPolicy: 'from_now',
    actorId: 'legacy-adoption-test',
    idempotencyKey: 'register:feishu-task-v2',
  });

  return {
    core,
    dbPath: path.join(directory, 'commitments.db'),
    cleanup() {
      core.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

function adoptionRequest(overrides = {}) {
  return {
    idempotencyKey: 'legacy-adoption:task-guid-1',
    externalId: 'task-guid-1',
    task: {
      title: 'Adopt this native task',
      description: 'Created before the Core link existed.',
      ownerId: 'owner-1',
      acceptorId: 'owner-1',
      assigneeId: 'agent:yueran',
    },
    ...overrides,
  };
}

test('adoptLegacyTask creates one Core task, TaskCreated outbox work, and Task v2 link', () => {
  const harness = createHarness();

  try {
    const result = harness.core.adoptLegacyTask(adoptionRequest());

    assert.equal(result.created, true);
    assert.equal(result.task.id, 'task-adopted-1');
    assert.equal(result.task.state, 'ready');
    assert.deepEqual(result.link, {
      id: 'external-link-adopted-1',
      taskId: 'task-adopted-1',
      actorId: 'owner-1',
      backend: 'feishu-task-v2',
      externalId: 'task-guid-1',
      createdAt: '2026-08-27T10:00:00.000Z',
    });
    assert.deepEqual(
      harness.core.query({ taskId: result.task.id, includeEvents: true }).events
        .map((event) => event.type),
      ['TaskCreated'],
    );
    const [delivery] = harness.core.outbox.query({
      projection: 'feishu-task-v2',
      limit: 10,
    });
    assert.equal(delivery.event.id, 'event-adopted-1');
    assert.equal(delivery.event.type, 'TaskCreated');
    assert.deepEqual(
      harness.core.externalLinks.query({
        taskId: result.task.id,
        backend: 'feishu-task-v2',
      }),
      [result.link],
    );
  } finally {
    harness.cleanup();
  }
});

test('adoptLegacyTask plan is read-only and the later commit consumes the plan once', () => {
  const harness = createHarness();

  try {
    const plan = harness.core.adoptLegacyTask({
      ...adoptionRequest(),
      mode: 'plan',
    });

    assert.deepEqual(plan, {
      planned: true,
      created: false,
      task: {
        id: null,
        title: 'Adopt this native task',
        description: 'Created before the Core link existed.',
        ownerId: 'owner-1',
        acceptorId: 'owner-1',
        assigneeId: 'agent:yueran',
        dueAt: null,
        reminderMinutesBeforeDue: null,
        state: 'ready',
        version: 1,
        createdAt: null,
        updatedAt: null,
      },
      link: {
        backend: 'feishu-task-v2',
        externalId: 'task-guid-1',
      },
    });
    assert.deepEqual(harness.core.query({ limit: 10 }), []);
    assert.deepEqual(harness.core.outbox.query({
      projection: 'feishu-task-v2',
      limit: 10,
    }), []);
    assert.deepEqual(harness.core.externalLinks.query({ backend: 'feishu-task-v2' }), []);

    const committed = harness.core.adoptLegacyTask(adoptionRequest());
    assert.equal(committed.created, true);
    assert.equal(committed.task.id, 'task-adopted-1');
    assert.equal(committed.link.id, 'external-link-adopted-1');
  } finally {
    harness.cleanup();
  }
});

test('adoptLegacyTask replay is idempotent and changed content conflicts', () => {
  const harness = createHarness();

  try {
    const first = harness.core.adoptLegacyTask(adoptionRequest());
    const replay = harness.core.adoptLegacyTask(adoptionRequest());

    assert.deepEqual(replay, first);
    assert.throws(
      () => harness.core.adoptLegacyTask(adoptionRequest({
        task: { ...adoptionRequest().task, title: 'Changed native task' },
      })),
      (error) => error?.code === 'IDEMPOTENCY_CONFLICT',
    );
    assert.equal(harness.core.query({ limit: 10 }).length, 1);
    assert.equal(harness.core.externalLinks.query({ backend: 'feishu-task-v2' }).length, 1);
    assert.equal(harness.core.outbox.query({
      projection: 'feishu-task-v2',
      limit: 10,
    }).length, 1);
  } finally {
    harness.cleanup();
  }
});

test('adoptLegacyTask rolls the Core task, event, outbox, link, and receipt back on link conflict', () => {
  const harness = createHarness({
    taskIds: ['task-adopted-1', 'task-adopted-2'],
    eventIds: ['event-adopted-1', 'event-adopted-2'],
    linkIds: ['external-link-adopted-1', 'external-link-adopted-2'],
  });

  try {
    harness.core.adoptLegacyTask(adoptionRequest());
    assert.throws(
      () => harness.core.adoptLegacyTask(adoptionRequest({
        idempotencyKey: 'legacy-adoption:task-guid-1:retry',
      })),
      (error) => error?.code === 'EXTERNAL_LINK_CONFLICT',
    );

    assert.equal(harness.core.query({ limit: 10 }).length, 1);
    assert.equal(harness.core.externalLinks.query({ backend: 'feishu-task-v2' }).length, 1);
    assert.equal(harness.core.outbox.query({
      projection: 'feishu-task-v2',
      limit: 10,
    }).length, 1);
    assert.equal(harness.core.query({ taskId: 'task-adopted-2' }), null);
  } finally {
    harness.cleanup();
  }
});

test('adoptLegacyTask rolls every write back when its adoption receipt cannot persist', () => {
  const harness = createHarness();
  const raw = new Database(harness.dbPath);

  try {
    raw.exec(`
      CREATE TRIGGER reject_legacy_task_adoption_receipt
      BEFORE INSERT ON commitment_legacy_task_adoption_receipts
      BEGIN
        SELECT RAISE(ABORT, 'adoption receipt rejected');
      END;
    `);
    assert.throws(
      () => harness.core.adoptLegacyTask(adoptionRequest()),
      /adoption receipt rejected/,
    );
    assert.deepEqual(harness.core.query({ limit: 10 }), []);
    assert.deepEqual(harness.core.externalLinks.query({ backend: 'feishu-task-v2' }), []);
    assert.deepEqual(harness.core.outbox.query({
      projection: 'feishu-task-v2',
      limit: 10,
    }), []);
  } finally {
    raw.close();
    harness.cleanup();
  }
});
