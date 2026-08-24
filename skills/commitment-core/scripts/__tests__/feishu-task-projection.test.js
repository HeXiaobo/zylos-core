import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { openCommitmentCore } from '../core.js';
import { createFeishuTaskProjectionAdapter } from '../feishu-task-projection.js';
import { processProjectionBatch } from '../projection-worker.js';

function createHarness() {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'zylos-feishu-projection-'));
  let eventIndex = 0;
  let taskIndex = 0;
  let externalLinkIndex = 0;
  let now = '2026-08-25T10:00:00.000Z';
  const core = openCommitmentCore({
    dbPath: path.join(directory, 'commitments.db'),
    clock: () => now,
    idGenerator: () => `task-${++taskIndex}`,
    eventIdGenerator: () => `event-${++eventIndex}`,
    externalLinkIdGenerator: () => `external-link-${++externalLinkIndex}`,
  });
  core.outbox.register({
    projection: 'feishu',
    bootstrapPolicy: 'from_beginning',
    actorId: 'feishu-projection-test',
    idempotencyKey: 'register:feishu',
  });
  return {
    core,
    setNow(value) { now = value; },
    cleanup() {
      core.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

function ingestTask(core) {
  return core.ingest({
    idempotencyKey: 'source:1',
    source: { channel: 'test', externalId: 'message-1', senderId: 'owner-1' },
    task: {
      title: 'Prepare customer proposal',
      description: 'Draft and submit for review',
      ownerId: 'owner-1',
      acceptorId: 'manager-1',
      assigneeId: 'agent-1',
    },
  }).task;
}

async function runWorker(core, adapter, operationId) {
  return processProjectionBatch({
    core,
    projection: 'feishu',
    workerId: 'feishu-worker-1',
    leaseMs: 30_000,
    limit: 10,
    retryAfterMs: 5_000,
    maxAttempts: 3,
    operationId,
    adapter,
  });
}

test('creates one Feishu task from the authoritative Core snapshot, links it, and acknowledges delivery', async () => {
  const harness = createHarness();
  const calls = [];
  try {
    const task = ingestTask(harness.core);
    const adapter = createFeishuTaskProjectionAdapter({
      core: harness.core,
      resolveTarget({ task: snapshot }) {
        assert.equal(snapshot.id, task.id);
        return { receiveId: 'chat-1', receiveIdType: 'chat_id' };
      },
      publisher: {
        async createTask(request) {
          calls.push(request);
          return { externalId: 'feishu-task-9001' };
        },
        async updateTask() {
          assert.fail('the first projection must create, not update');
        },
      },
    });

    const summary = await runWorker(harness.core, adapter, 'cycle-1');

    assert.equal(summary.acknowledged, 1);
    assert.deepEqual(calls, [{
      target: { receiveId: 'chat-1', receiveIdType: 'chat_id' },
      task,
      idempotencyKey: 'zylos:feishu:create:task-1',
    }]);
    assert.equal(
      harness.core.outbox.query({ projection: 'feishu', eventId: 'event-1' }).status,
      'acknowledged',
    );
    assert.deepEqual(harness.core.externalLinks.query({ taskId: task.id, backend: 'feishu' }), [{
      id: 'external-link-1',
      taskId: task.id,
      actorId: 'owner-1',
      backend: 'feishu',
      externalId: 'feishu-task-9001',
      createdAt: '2026-08-25T10:00:00.000Z',
    }]);
  } finally {
    harness.cleanup();
  }
});

test('updates the linked Feishu task from the latest Core snapshot without creating another object', async () => {
  const harness = createHarness();
  const creates = [];
  const updates = [];
  try {
    const createdTask = ingestTask(harness.core);
    const publisher = {
      async createTask(request) {
        creates.push(request);
        return { externalId: 'feishu-task-9001' };
      },
      async updateTask(request) {
        updates.push(request);
        return { externalId: request.externalId };
      },
    };
    const adapter = createFeishuTaskProjectionAdapter({
      core: harness.core,
      resolveTarget: () => ({ receiveId: 'chat-1', receiveIdType: 'chat_id' }),
      publisher,
    });
    await runWorker(harness.core, adapter, 'cycle-1');

    const transition = harness.core.command({
      type: 'StartTask',
      taskId: createdTask.id,
      actorId: 'agent-1',
      idempotencyKey: 'command:start:task-1',
    }, createdTask.version);
    const summary = await runWorker(harness.core, adapter, 'cycle-2');

    assert.equal(summary.acknowledged, 1);
    assert.equal(creates.length, 1);
    assert.deepEqual(updates, [{
      target: { receiveId: 'chat-1', receiveIdType: 'chat_id' },
      externalId: 'feishu-task-9001',
      task: transition.task,
      idempotencyKey: 'zylos:feishu:update:task-1:v2',
    }]);
    assert.equal(
      harness.core.externalLinks.query({ taskId: createdTask.id, backend: 'feishu' }).length,
      1,
    );
  } finally {
    harness.cleanup();
  }
});

test('replays the same remote create identity after a crash before ExternalLink persistence', async () => {
  const harness = createHarness();
  const createRequests = [];
  let linkAttempts = 0;
  try {
    const task = ingestTask(harness.core);
    const adapterCore = {
      query: harness.core.query,
      externalLinks: {
        query: harness.core.externalLinks.query,
        link(request) {
          linkAttempts += 1;
          if (linkAttempts === 1) throw new Error('simulated process boundary failure');
          return harness.core.externalLinks.link(request);
        },
      },
    };
    const adapter = createFeishuTaskProjectionAdapter({
      core: adapterCore,
      resolveTarget: () => ({ receiveId: 'chat-1', receiveIdType: 'chat_id' }),
      publisher: {
        async createTask(request) {
          createRequests.push(request);
          return { externalId: 'feishu-task-9001' };
        },
        async updateTask() {},
      },
    });

    const failed = await runWorker(harness.core, adapter, 'cycle-1');
    assert.equal(failed.retryWaiting, 1);
    assert.equal(harness.core.externalLinks.query({ taskId: task.id }).length, 0);

    harness.setNow('2026-08-25T10:00:05.000Z');
    const recovered = await runWorker(harness.core, adapter, 'cycle-2');

    assert.equal(recovered.acknowledged, 1);
    assert.equal(createRequests.length, 2);
    assert.deepEqual(createRequests[1], createRequests[0]);
    assert.equal(createRequests[0].idempotencyKey, 'zylos:feishu:create:task-1');
    assert.equal(harness.core.externalLinks.query({ taskId: task.id }).length, 1);
  } finally {
    harness.cleanup();
  }
});

test('a partially published batch safely replays: linked tasks update and unlinked tasks reuse create identity', async () => {
  const harness = createHarness();
  const creates = [];
  const updates = [];
  let taskTwoFailures = 0;
  try {
    const first = ingestTask(harness.core);
    const second = harness.core.ingest({
      idempotencyKey: 'source:2',
      source: { channel: 'test', externalId: 'message-2', senderId: 'owner-2' },
      task: { title: 'Second task', ownerId: 'owner-2' },
    }).task;
    const adapter = createFeishuTaskProjectionAdapter({
      core: harness.core,
      resolveTarget: ({ task }) => ({
        receiveId: `chat-for-${task.ownerId}`,
        receiveIdType: 'chat_id',
      }),
      publisher: {
        async createTask(request) {
          creates.push(request);
          if (request.task.id === second.id && taskTwoFailures++ === 0) {
            throw new Error('temporary Feishu failure');
          }
          return { externalId: `feishu-${request.task.id}` };
        },
        async updateTask(request) {
          updates.push(request);
          return { externalId: request.externalId };
        },
      },
    });

    const partial = await runWorker(harness.core, adapter, 'cycle-1');
    assert.equal(partial.retryWaiting, 2);
    assert.equal(harness.core.externalLinks.query({ taskId: first.id }).length, 1);
    assert.equal(harness.core.externalLinks.query({ taskId: second.id }).length, 0);

    harness.setNow('2026-08-25T10:00:05.000Z');
    const recovered = await runWorker(harness.core, adapter, 'cycle-2');

    assert.equal(recovered.acknowledged, 2);
    assert.deepEqual(creates.map((request) => request.idempotencyKey), [
      'zylos:feishu:create:task-1',
      'zylos:feishu:create:task-2',
      'zylos:feishu:create:task-2',
    ]);
    assert.deepEqual(updates.map((request) => request.externalId), ['feishu-task-1']);
    assert.equal(harness.core.externalLinks.query({ backend: 'feishu' }).length, 2);
  } finally {
    harness.cleanup();
  }
});

test('missing target mapping fails closed into dead-letter without publishing or changing Core', async () => {
  const harness = createHarness();
  let publishCalls = 0;
  try {
    const task = ingestTask(harness.core);
    const adapter = createFeishuTaskProjectionAdapter({
      core: harness.core,
      resolveTarget: () => null,
      publisher: {
        async createTask() { publishCalls += 1; },
        async updateTask() { publishCalls += 1; },
      },
    });

    const summary = await runWorker(harness.core, adapter, 'cycle-1');

    assert.equal(summary.deadLettered, 1);
    assert.equal(summary.acknowledged, 0);
    assert.equal(publishCalls, 0);
    assert.equal(harness.core.query({ taskId: task.id }).state, 'ready');
    assert.equal(harness.core.externalLinks.query({ taskId: task.id }).length, 0);
    const delivery = harness.core.outbox.query({ projection: 'feishu', eventId: 'event-1' });
    assert.equal(delivery.status, 'dead_letter');
    assert.match(delivery.lastError, /Feishu target is not configured/);
  } finally {
    harness.cleanup();
  }
});

test('a conflicting remote identity is dead-lettered immediately instead of being acknowledged', async () => {
  const harness = createHarness();
  try {
    const first = ingestTask(harness.core);
    const publisher = {
      async createTask() { return { externalId: 'same-feishu-id' }; },
      async updateTask(request) { return { externalId: request.externalId }; },
    };
    const adapter = createFeishuTaskProjectionAdapter({
      core: harness.core,
      resolveTarget: () => ({ receiveId: 'chat-1', receiveIdType: 'chat_id' }),
      publisher,
    });
    const firstSummary = await runWorker(harness.core, adapter, 'cycle-1');
    assert.equal(firstSummary.acknowledged, 1);
    assert.equal(harness.core.externalLinks.query({ taskId: first.id }).length, 1);

    const second = harness.core.ingest({
      idempotencyKey: 'source:2',
      source: { channel: 'test', externalId: 'message-2', senderId: 'owner-2' },
      task: { title: 'Second task', ownerId: 'owner-2' },
    }).task;
    const conflict = await runWorker(harness.core, adapter, 'cycle-2');

    assert.equal(conflict.deadLettered, 1);
    assert.equal(conflict.retryWaiting, 0);
    assert.equal(harness.core.externalLinks.query({ taskId: second.id }).length, 0);
    const delivery = harness.core.outbox.query({ projection: 'feishu', eventId: 'event-2' });
    assert.equal(delivery.status, 'dead_letter');
    assert.match(delivery.lastError, /EXTERNAL_LINK_CONFLICT/);
  } finally {
    harness.cleanup();
  }
});

test('publisher error classification controls retry waiting versus immediate dead-letter', async () => {
  const harness = createHarness();
  try {
    ingestTask(harness.core);
    const base = {
      core: harness.core,
      resolveTarget: () => ({ receiveId: 'chat-1', receiveIdType: 'chat_id' }),
    };
    const retryable = await runWorker(harness.core, createFeishuTaskProjectionAdapter({
      ...base,
      publisher: {
        async createTask() { throw new Error('Feishu timeout'); },
        async updateTask() {},
      },
    }), 'cycle-1');
    assert.equal(retryable.retryWaiting, 1);

    harness.setNow('2026-08-25T10:00:05.000Z');
    const rejected = new Error('Feishu target was removed');
    rejected.retryable = false;
    const permanent = await runWorker(harness.core, createFeishuTaskProjectionAdapter({
      ...base,
      publisher: {
        async createTask() { throw rejected; },
        async updateTask() {},
      },
    }), 'cycle-2');

    assert.equal(permanent.deadLettered, 1);
    assert.equal(permanent.retryWaiting, 0);
    assert.match(
      harness.core.outbox.query({ projection: 'feishu', eventId: 'event-1' }).lastError,
      /Feishu target was removed/,
    );
  } finally {
    harness.cleanup();
  }
});

test('the default MVP target is the Task acceptor Feishu open_id DM and rejects generic actor ids', async () => {
  const harness = createHarness();
  const targets = [];
  try {
    harness.core.ingest({
      idempotencyKey: 'source:dm-canary',
      source: { channel: 'test', externalId: 'message-dm', senderId: 'ou_owner_1' },
      task: {
        title: 'DM canary',
        ownerId: 'ou_owner_1',
        acceptorId: 'ou_manager_1',
      },
    });
    const adapter = createFeishuTaskProjectionAdapter({
      core: harness.core,
      publisher: {
        async createTask(request) {
          targets.push(request.target);
          return { externalId: 'feishu-dm-1' };
        },
        async updateTask() {},
      },
    });

    const summary = await runWorker(harness.core, adapter, 'cycle-1');
    assert.equal(summary.acknowledged, 1);
    assert.deepEqual(targets, [{ receiveId: 'ou_manager_1', receiveIdType: 'open_id' }]);
  } finally {
    harness.cleanup();
  }

  const invalid = createHarness();
  try {
    ingestTask(invalid.core);
    const summary = await runWorker(invalid.core, createFeishuTaskProjectionAdapter({
      core: invalid.core,
      publisher: {
        async createTask() { assert.fail('invalid actor id must not be published'); },
        async updateTask() {},
      },
    }), 'cycle-invalid-target');
    assert.equal(summary.deadLettered, 1);
  } finally {
    invalid.cleanup();
  }
});

test('concurrent Event workers converge on one Feishu identity through stable create and link receipts', async () => {
  const harness = createHarness();
  const createRequests = [];
  const createWaiters = [];
  try {
    const task = ingestTask(harness.core);
    harness.core.command({
      type: 'StartTask',
      taskId: task.id,
      actorId: 'agent-1',
      idempotencyKey: 'command:start:concurrent',
    }, task.version);
    const publisher = {
      createTask(request) {
        createRequests.push(request);
        return new Promise((resolve) => {
          createWaiters.push(resolve);
          if (createWaiters.length === 2) {
            for (const finish of createWaiters) finish({ externalId: 'feishu-converged-1' });
          }
        });
      },
      async updateTask() { assert.fail('both workers reach create before either link commits'); },
    };
    const adapter = createFeishuTaskProjectionAdapter({
      core: harness.core,
      resolveTarget: () => ({ receiveId: 'chat-1', receiveIdType: 'chat_id' }),
      publisher,
    });
    const options = {
      core: harness.core,
      projection: 'feishu',
      leaseMs: 30_000,
      limit: 1,
      retryAfterMs: 5_000,
      maxAttempts: 3,
      adapter,
    };

    const [first, second] = await Promise.all([
      processProjectionBatch({
        ...options,
        workerId: 'feishu-worker-a',
        operationId: 'concurrent-a',
      }),
      processProjectionBatch({
        ...options,
        workerId: 'feishu-worker-b',
        operationId: 'concurrent-b',
      }),
    ]);

    assert.equal(first.acknowledged, 1);
    assert.equal(second.acknowledged, 1);
    assert.equal(createRequests.length, 2);
    assert.equal(createRequests[0].idempotencyKey, 'zylos:feishu:create:task-1');
    assert.equal(createRequests[1].idempotencyKey, createRequests[0].idempotencyKey);
    assert.deepEqual(
      harness.core.externalLinks.query({ taskId: task.id, backend: 'feishu' })
        .map((link) => link.externalId),
      ['feishu-converged-1'],
    );
  } finally {
    harness.cleanup();
  }
});
