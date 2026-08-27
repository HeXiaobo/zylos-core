import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { openCommitmentCore } from '../core.js';
import { createAttentionViewProjectionAdapter } from '../attention-view-projection-adapter.js';
import {
  processProjectionBatch,
  ProjectionAdapterError,
} from '../projection-worker.js';
import { publishAttentionView } from '../render-attention-view.js';

const OWNED_PREVIOUS_VIEW = [
  '# Zylos Attention View',
  '',
  '<!-- zylos-attention-view: version=1; generated-at=2026-08-24T07:00:00.000Z; source=commitment-core; derived=true -->',
  '',
  '> previous attention view',
  '',
].join('\n');

function createHarness() {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'zylos-projection-worker-'));
  let now = '2026-08-25T10:00:00.000Z';
  let taskIndex = 0;
  let eventIndex = 0;
  const core = openCommitmentCore({
    dbPath: path.join(directory, 'commitments.db'),
    clock: () => now,
    idGenerator: () => `task-${++taskIndex}`,
    eventIdGenerator: () => `event-${++eventIndex}`,
  });
  core.outbox.register?.({
    projection: 'attention',
    bootstrapPolicy: 'from_beginning',
    actorId: 'projection-worker-test',
    idempotencyKey: 'projection-worker-test:register:attention',
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

function createTask(core, index) {
  return core.ingest({
    idempotencyKey: `source:${index}`,
    source: { channel: 'test', externalId: `message-${index}`, senderId: 'owner-1' },
    task: { title: `Task ${index}`, ownerId: 'owner-1' },
  }).task;
}

test('claims one bounded batch, invokes the adapter once, and acknowledges every delivery', async () => {
  const harness = createHarness();
  const publishedBatches = [];
  try {
    createTask(harness.core, 1);
    createTask(harness.core, 2);

    const result = await processProjectionBatch({
      core: harness.core,
      projection: 'attention',
      workerId: 'attention-worker-1',
      leaseMs: 30_000,
      limit: 10,
      retryAfterMs: 5_000,
      maxAttempts: 3,
      operationId: 'cycle-1',
      adapter: {
        async publishBatch({ deliveries }) {
          publishedBatches.push(deliveries.map((delivery) => delivery.eventId));
        },
      },
    });

    assert.deepEqual(publishedBatches, [['event-1', 'event-2']]);
    assert.deepEqual(result, {
      projection: 'attention',
      claimed: 2,
      published: 2,
      acknowledged: 2,
      retryWaiting: 0,
      deadLettered: 0,
      settlementFailed: 0,
      idle: false,
    });
    assert.deepEqual(
      harness.core.outbox.query({ projection: 'attention', limit: 10 })
        .map((delivery) => delivery.status),
      ['acknowledged', 'acknowledged'],
    );
  } finally {
    harness.cleanup();
  }
});

test('a retryable Adapter failure schedules every delivery without rolling back Core state', async () => {
  const harness = createHarness();
  try {
    createTask(harness.core, 1);

    const result = await processProjectionBatch({
      core: harness.core,
      projection: 'attention',
      workerId: 'attention-worker-1',
      leaseMs: 30_000,
      limit: 10,
      retryAfterMs: 5_000,
      maxAttempts: 3,
      operationId: 'cycle-1',
      adapter: {
        async publishBatch() {
          throw new ProjectionAdapterError('temporary filesystem pressure');
        },
      },
    });

    assert.equal(result.retryWaiting, 1);
    assert.equal(result.deadLettered, 0);
    const delivery = harness.core.outbox.query({
      projection: 'attention',
      eventId: 'event-1',
    });
    assert.equal(delivery.status, 'retry_wait');
    assert.equal(delivery.nextAttemptAt, '2026-08-25T10:00:05.000Z');
    assert.equal(harness.core.query({ taskId: 'task-1' }).state, 'ready');
  } finally {
    harness.cleanup();
  }
});

test('permanent failures and exhausted retry attempts are dead-lettered', async () => {
  const harness = createHarness();
  const retryableAdapter = {
    async publishBatch() {
      throw new ProjectionAdapterError('still unavailable');
    },
  };
  const baseOptions = {
    core: harness.core,
    projection: 'attention',
    workerId: 'attention-worker-1',
    leaseMs: 30_000,
    limit: 1,
    retryAfterMs: 5_000,
    maxAttempts: 2,
  };
  try {
    createTask(harness.core, 1);
    await processProjectionBatch({
      ...baseOptions,
      operationId: 'cycle-1',
      adapter: retryableAdapter,
    });
    harness.setNow('2026-08-25T10:00:05.000Z');
    const exhausted = await processProjectionBatch({
      ...baseOptions,
      operationId: 'cycle-2',
      adapter: retryableAdapter,
    });
    assert.equal(exhausted.deadLettered, 1);
    assert.equal(
      harness.core.outbox.query({ projection: 'attention', eventId: 'event-1' }).status,
      'dead_letter',
    );

    createTask(harness.core, 2);
    const permanent = await processProjectionBatch({
      ...baseOptions,
      operationId: 'cycle-3',
      adapter: {
        async publishBatch() {
          throw new ProjectionAdapterError('invalid destination', { retryable: false });
        },
      },
    });
    assert.equal(permanent.deadLettered, 1);
    assert.equal(
      harness.core.outbox.query({ projection: 'attention', eventId: 'event-2' }).status,
      'dead_letter',
    );
  } finally {
    harness.cleanup();
  }
});

test('a platform Adapter can mark a failure permanent without importing Core classes', async () => {
  const harness = createHarness();
  try {
    createTask(harness.core, 1);
    const platformError = new Error('invalid platform member');
    platformError.retryable = false;
    const summary = await processProjectionBatch({
      core: harness.core,
      projection: 'attention',
      workerId: 'attention-worker-1',
      leaseMs: 30_000,
      limit: 1,
      retryAfterMs: 5_000,
      maxAttempts: 2,
      operationId: 'platform-cycle-1',
      adapter: { async publishBatch() { throw platformError; } },
    });

    assert.equal(summary.deadLettered, 1);
    assert.equal(
      harness.core.outbox.query({ projection: 'attention', eventId: 'event-1' }).status,
      'dead_letter',
    );
  } finally {
    harness.cleanup();
  }
});

test('a per-delivery Adapter isolates one permanent failure from the rest of the claimed batch', async () => {
  const harness = createHarness();
  const visited = [];
  try {
    createTask(harness.core, 1);
    createTask(harness.core, 2);
    createTask(harness.core, 3);

    const summary = await processProjectionBatch({
      core: harness.core,
      projection: 'attention',
      workerId: 'attention-worker-1',
      leaseMs: 30_000,
      limit: 10,
      retryAfterMs: 5_000,
      maxAttempts: 3,
      operationId: 'isolated-platform-cycle-1',
      adapter: {
        async publishDelivery({ delivery }) {
          visited.push(delivery.eventId);
          if (delivery.eventId === 'event-2') {
            throw new ProjectionAdapterError('invalid destination', { retryable: false });
          }
        },
      },
    });

    assert.deepEqual(visited, ['event-1', 'event-2', 'event-3']);
    assert.deepEqual(summary, {
      projection: 'attention',
      claimed: 3,
      published: 2,
      acknowledged: 2,
      retryWaiting: 0,
      deadLettered: 1,
      settlementFailed: 0,
      idle: false,
    });
    assert.deepEqual(
      harness.core.outbox.query({ projection: 'attention', limit: 10 })
        .map(delivery => delivery.status),
      ['acknowledged', 'dead_letter', 'acknowledged'],
    );
  } finally {
    harness.cleanup();
  }
});

test('the Attention Adapter rebuilds one atomic view for a whole Event batch', async () => {
  const harness = createHarness();
  const outputPath = path.join(os.tmpdir(), `zylos-attention-projection-${process.pid}.md`);
  try {
    createTask(harness.core, 1);
    createTask(harness.core, 2);

    const result = await processProjectionBatch({
      core: harness.core,
      projection: 'attention',
      workerId: 'attention-worker-1',
      leaseMs: 30_000,
      limit: 10,
      retryAfterMs: 5_000,
      maxAttempts: 3,
      operationId: 'cycle-1',
      adapter: createAttentionViewProjectionAdapter({
        core: harness.core,
        outputPath,
        clock: () => '2026-08-25T10:00:00.000Z',
      }),
    });

    assert.equal(result.published, 2);
    const content = readFileSync(outputPath, 'utf8');
    assert.match(content, /Task 1/);
    assert.match(content, /Task 2/);
  } finally {
    rmSync(outputPath, { force: true });
    harness.cleanup();
  }
});

test('an Attention publisher failure preserves the old view and schedules retry', async () => {
  const harness = createHarness();
  const directory = mkdtempSync(path.join(os.tmpdir(), 'zylos-attention-projection-failure-'));
  const outputPath = path.join(directory, 'state.md');
  fs.writeFileSync(outputPath, OWNED_PREVIOUS_VIEW);
  try {
    createTask(harness.core, 1);
    const result = await processProjectionBatch({
      core: harness.core,
      projection: 'attention',
      workerId: 'attention-worker-1',
      leaseMs: 30_000,
      limit: 10,
      retryAfterMs: 5_000,
      maxAttempts: 3,
      operationId: 'cycle-1',
      adapter: createAttentionViewProjectionAdapter({
        core: harness.core,
        outputPath,
        clock: () => '2026-08-25T10:00:00.000Z',
        publish(options) {
          return publishAttentionView({
            ...options,
            fileSystem: {
              ...fs,
              renameSync() {
                throw new Error('injected publication failure');
              },
            },
            temporaryId: () => 'projection-failure',
          });
        },
      }),
    });

    assert.equal(result.retryWaiting, 1);
    assert.equal(result.published, 0);
    assert.equal(readFileSync(outputPath, 'utf8'), OWNED_PREVIOUS_VIEW);
    assert.deepEqual(fs.readdirSync(directory), ['state.md']);
  } finally {
    rmSync(directory, { recursive: true, force: true });
    harness.cleanup();
  }
});

test('publish-before-ack crash recovery safely rebuilds Attention after the lease expires', async () => {
  const harness = createHarness();
  const directory = mkdtempSync(path.join(os.tmpdir(), 'zylos-attention-projection-replay-'));
  const outputPath = path.join(directory, 'state.md');
  let publishCount = 0;
  let acknowledgeCount = 0;
  const crashAfterFirstAck = {
    ...harness.core,
    outbox: {
      ...harness.core.outbox,
      ack(request, expectedVersion) {
        acknowledgeCount += 1;
        if (acknowledgeCount === 2) throw new Error('simulated process exit before ack');
        return harness.core.outbox.ack(request, expectedVersion);
      },
    },
  };
  function attentionAdapter(core) {
    return createAttentionViewProjectionAdapter({
      core,
      outputPath,
      clock: () => '2026-08-25T10:00:00.000Z',
      publish(options) {
        publishCount += 1;
        return publishAttentionView(options);
      },
    });
  }

  try {
    createTask(harness.core, 1);
    createTask(harness.core, 2);
    const interrupted = await processProjectionBatch({
      core: crashAfterFirstAck,
      projection: 'attention',
      workerId: 'attention-worker-1',
      leaseMs: 1_000,
      limit: 10,
      retryAfterMs: 5_000,
      maxAttempts: 3,
      operationId: 'cycle-before-crash',
      adapter: attentionAdapter(crashAfterFirstAck),
    });
    assert.equal(interrupted.acknowledged, 1);
    assert.equal(interrupted.settlementFailed, 1);
    assert.equal(publishCount, 1);

    harness.setNow('2026-08-25T10:00:01.000Z');
    const recovered = await processProjectionBatch({
      core: harness.core,
      projection: 'attention',
      workerId: 'attention-worker-2',
      leaseMs: 1_000,
      limit: 10,
      retryAfterMs: 5_000,
      maxAttempts: 3,
      operationId: 'cycle-after-crash',
      adapter: attentionAdapter(harness.core),
    });

    assert.equal(recovered.claimed, 1);
    assert.equal(recovered.acknowledged, 1);
    assert.equal(publishCount, 2);
    assert.deepEqual(
      harness.core.outbox.query({ projection: 'attention', limit: 10 })
        .map((delivery) => delivery.status),
      ['acknowledged', 'acknowledged'],
    );
    const content = readFileSync(outputPath, 'utf8');
    assert.equal(content.match(/Task 1/g)?.length, 1);
    assert.equal(content.match(/Task 2/g)?.length, 1);
  } finally {
    rmSync(directory, { recursive: true, force: true });
    harness.cleanup();
  }
});

test('a reclaimed delivery fences the stale worker settlement without blocking the batch result', async () => {
  const harness = createHarness();
  let releasePublication;
  const publicationMayFinish = new Promise((resolve) => {
    releasePublication = resolve;
  });
  try {
    createTask(harness.core, 1);
    const staleWorker = processProjectionBatch({
      core: harness.core,
      projection: 'attention',
      workerId: 'attention-worker-stale',
      leaseMs: 1_000,
      limit: 10,
      retryAfterMs: 5_000,
      maxAttempts: 3,
      operationId: 'cycle-stale',
      adapter: {
        async publishBatch() {
          await publicationMayFinish;
        },
      },
    });

    harness.setNow('2026-08-25T10:00:01.000Z');
    const [reclaimed] = harness.core.outbox.claim({
      projection: 'attention',
      workerId: 'attention-worker-current',
      idempotencyKey: 'test:reclaim:event-1',
      leaseMs: 1_000,
      limit: 1,
    });
    assert.equal(reclaimed.version, 2);
    releasePublication();

    const staleResult = await staleWorker;
    assert.equal(staleResult.acknowledged, 0);
    assert.equal(staleResult.settlementFailed, 1);
    assert.equal(
      harness.core.outbox.query({ projection: 'attention', eventId: 'event-1' }).workerId,
      'attention-worker-current',
    );
  } finally {
    releasePublication?.();
    harness.cleanup();
  }
});

test('default operation identities are unique even across consecutive idle claims', async () => {
  const claimKeys = [];
  const core = {
    outbox: {
      claim(request) {
        claimKeys.push(request.idempotencyKey);
        return [];
      },
      ack() {},
      fail() {},
    },
  };
  const options = {
    core,
    projection: 'attention',
    workerId: 'attention-worker-1',
    leaseMs: 1_000,
    limit: 10,
    retryAfterMs: 5_000,
    maxAttempts: 3,
    adapter: { publishBatch() {} },
  };

  await processProjectionBatch(options);
  await processProjectionBatch(options);

  assert.equal(claimKeys.length, 2);
  assert.notEqual(claimKeys[0], claimKeys[1]);
});
