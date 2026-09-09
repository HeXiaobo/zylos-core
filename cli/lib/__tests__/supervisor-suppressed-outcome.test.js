import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import { openAssistantResponseStream } from '../../../skills/comm-bridge/scripts/assistant-response-stream.js';
import { createAssistantResponseDeliveryWorker } from '../../../skills/comm-bridge/scripts/c4-response-stream-supervisor.js';

function accept(stream, requestId = 'assistant.feishu.sup_1', sourceId = 'sup_1') {
  return stream.execute({
    type: 'AcceptAssistantRequest',
    requestId,
    sourceId,
    route: { channel: 'feishu', endpointId: 'oc_sup|type:p2p|msg:sup_1' },
    conversation: {
      content: '[Feishu DM] User said: hello',
      status: 'pending',
      priority: 3,
      requireIdle: false,
    },
  });
}

function eventStatuses(stream, requestId = 'assistant.feishu.sup_1') {
  const statuses = [];
  for (const status of ['pending', 'processing', 'delivered', 'dead_letter', 'suppressed']) {
    for (const delivery of stream.queryDeliveries({ requestId, status, limit: 100 })) {
      statuses.push([delivery.event.sequence, status]);
    }
  }
  return statuses.sort((left, right) => left[0] - right[0]).map(([, status]) => status);
}

describe('the supervisor records suppressed adapters distinctly from deliveries (issue #778)', () => {
  it('acknowledges a {status:"suppressed"} adapter answer as suppressed', async () => {
    const stream = openAssistantResponseStream({ dbPath: ':memory:', clock: () => 5_000 });
    accept(stream);
    const worker = createAssistantResponseDeliveryWorker({
      responseStream: stream,
      adapterForChannel: () => '/adapters/feishu/stream.js',
      adapterExists: () => true,
      deliver: async () => ({ status: 'suppressed' }),
      clock: () => 5_000,
      staleSeconds: 1_000,
    });
    try {
      const result = await worker.drainOnce();
      assert.deepEqual(result, {
        expired: 0,
        claimed: 2,
        groups: 1,
        acknowledged: 0,
        suppressed: 2,
        retried: 0,
        deadLettered: 0,
      });
      assert.deepEqual(
        eventStatuses(stream),
        ['suppressed', 'suppressed'],
      );
      // A terminal outcome: nothing is left leased or claimable.
      assert.equal((await worker.drainOnce()).claimed, 0);
    } finally {
      worker.close();
    }
  });

  it('keeps a delivered or silent adapter answer mapping to delivered', async () => {
    for (const adapterAnswer of [{ status: 'delivered' }, undefined, { exit: 0 }]) {
      const stream = openAssistantResponseStream({ dbPath: ':memory:', clock: () => 5_000 });
      accept(stream);
      const worker = createAssistantResponseDeliveryWorker({
        responseStream: stream,
        adapterForChannel: () => '/adapters/feishu/stream.js',
        adapterExists: () => true,
        deliver: async () => adapterAnswer,
        clock: () => 5_000,
        staleSeconds: 1_000,
      });
      try {
        const result = await worker.drainOnce();
        assert.equal(result.acknowledged, 2, JSON.stringify(adapterAnswer));
        assert.equal(result.suppressed, 0, JSON.stringify(adapterAnswer));
        assert.deepEqual(
          eventStatuses(stream),
          ['delivered', 'delivered'],
        );
      } finally {
        worker.close();
      }
    }
  });

  it('reads the real adapter stdout: a JSON suppressed line settles as suppressed', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-supervisor-suppressed-'));
    try {
      const suppressedAdapter = path.join(directory, 'suppressed-stream.js');
      fs.writeFileSync(suppressedAdapter, `
        process.stdout.write(JSON.stringify({ status: 'suppressed' }) + '\\n');
        process.exit(0);
      `);
      const deliveredAdapter = path.join(directory, 'delivered-stream.js');
      fs.writeFileSync(deliveredAdapter, `
        console.log('adapter boot noise');
        process.stdout.write(JSON.stringify({ status: 'ok' }) + '\\n');
        process.exit(0);
      `);

      for (const [adapter, expectedStatus] of [
        [suppressedAdapter, 'suppressed'],
        [deliveredAdapter, 'delivered'],
      ]) {
        const stream = openAssistantResponseStream({ dbPath: ':memory:', clock: () => 5_000 });
        accept(stream);
        // No injected deliver: the worker uses its real spawn-based
        // deliverToAdapter, exercising the stdout contract end to end.
        const worker = createAssistantResponseDeliveryWorker({
          responseStream: stream,
          adapterForChannel: () => adapter,
          adapterExists: () => true,
          clock: () => 5_000,
          staleSeconds: 1_000,
        });
        try {
          const result = await worker.drainOnce();
          assert.equal(result.suppressed, expectedStatus === 'suppressed' ? 2 : 0);
          assert.equal(result.acknowledged, expectedStatus === 'suppressed' ? 0 : 2);
        } finally {
          worker.close();
        }
      }
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe('stuck assistant runs reach an explicit terminal via the supervisor sweep (issue #26)', () => {
  it('expires an abandoned started run, fails it, and delivers the RunFailed event', async () => {
    let now = 10_000;
    const stream = openAssistantResponseStream({ dbPath: ':memory:', clock: () => now });
    accept(stream);
    stream.execute({ type: 'StartRun', requestId: 'assistant.feishu.sup_1' });

    const payloads = [];
    const worker = createAssistantResponseDeliveryWorker({
      responseStream: stream,
      adapterForChannel: () => '/adapters/feishu/stream.js',
      adapterExists: () => true,
      deliver: async (_adapter, payload) => payloads.push(payload),
      clock: () => now,
      staleSeconds: 60,
    });
    try {
      // Before the stale window: the run stays open, nothing expires.
      now += 10;
      const early = await worker.drainOnce();
      assert.equal(early.expired, 0);
      assert.equal(stream.query({ requestId: 'assistant.feishu.sup_1' }).request.status, 'started');

      // Past the stale window with no runtime activity: the sweep must give
      // the request an explicit terminal — never an endless open state.
      now += 120;
      const expired = await worker.drainOnce();
      assert.equal(expired.expired, 1);
      assert.equal(stream.query({ requestId: 'assistant.feishu.sup_1' }).request.status, 'failed');

      const deliveredTypes = payloads.flatMap(payload => payload.events.map(event => event.type));
      assert.ok(deliveredTypes.includes('RunFailed'),
        'the terminal event must be handed to the channel adapter, not kept silent');
      assert.ok(deliveredTypes.includes('RunCompleted') === false);
    } finally {
      worker.close();
    }
  });
});
