import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { openCommitmentCore } from '../core.js';
import {
  initializeFeishuProjection,
  loadFeishuProjectionRuntime,
  runFeishuProjectionWorkerCli,
  runFeishuProjectionOnce,
  superviseFeishuProjection,
} from '../feishu-projection-worker.js';

const WORKER_PATH = fileURLToPath(new URL('../feishu-projection-worker.js', import.meta.url));

test('initialization requires an explicit history policy and registers Feishu exactly once', () => {
  const calls = [];
  let closed = false;
  const core = {
    outbox: {
      register(request) {
        calls.push(request);
        return { created: true, registration: { projection: 'feishu' } };
      },
    },
    close() { closed = true; },
  };

  const result = initializeFeishuProjection({
    bootstrapPolicy: 'from_now',
    openCore: () => core,
  });

  assert.deepEqual(calls, [{
    projection: 'feishu',
    bootstrapPolicy: 'from_now',
    actorId: 'commitment-feishu-projection',
    idempotencyKey: 'commitment-feishu-projection:register:from_now:v1',
  }]);
  assert.equal(result.created, true);
  assert.equal(closed, true);
  assert.throws(
    () => initializeFeishuProjection({ openCore: () => core }),
    /bootstrapPolicy must be from_now or from_beginning/,
  );
});

test('one worker cycle opens Core, builds the deep Adapter, settles one batch, and closes Core', async () => {
  let received;
  let factoryOptions;
  let closed = false;
  const core = {
    query() {},
    externalLinks: { query() {}, link() {} },
    outbox: { claim() {}, ack() {}, fail() {} },
    close() { closed = true; },
  };
  const publisher = { createTask() {}, updateTask() {} };
  const resolveTarget = () => ({ receiveId: 'chat-1', receiveIdType: 'chat_id' });
  const adapter = { publishBatch() {} };

  const result = await runFeishuProjectionOnce({
    workerId: 'feishu-worker-1',
    leaseMs: 30_000,
    limit: 7,
    retryAfterMs: 5_000,
    maxAttempts: 3,
    operationId: 'cycle-1',
    publisher,
    resolveTarget,
    openCore: () => core,
    adapterFactory(options) {
      factoryOptions = options;
      return adapter;
    },
    async processBatch(options) {
      received = options;
      return { projection: 'feishu', claimed: 0, idle: true };
    },
  });

  assert.deepEqual(result, { projection: 'feishu', claimed: 0, idle: true });
  assert.deepEqual(factoryOptions, { core, publisher, resolveTarget });
  assert.equal(received.core, core);
  assert.equal(received.projection, 'feishu');
  assert.equal(received.workerId, 'feishu-worker-1');
  assert.equal(received.limit, 7);
  assert.equal(received.operationId, 'cycle-1');
  assert.equal(received.adapter, adapter);
  assert.equal(closed, true);
});

test('the supervisor gives every cycle a fresh identity, continues after failure, and stops on abort', async () => {
  const controller = new AbortController();
  const events = [];
  const operationIds = [];
  let cycles = 0;

  const result = await superviseFeishuProjection({
    workerId: 'feishu-worker-1',
    leaseMs: 30_000,
    limit: 7,
    retryAfterMs: 5_000,
    maxAttempts: 3,
    intervalMs: 2_000,
    publisher: { createTask() {}, updateTask() {} },
    resolveTarget: () => ({ receiveId: 'chat-1', receiveIdType: 'chat_id' }),
    signal: controller.signal,
    operationIdFactory: () => 'supervisor-test',
    async runOnce(options) {
      cycles += 1;
      operationIds.push(options.operationId);
      if (cycles === 1) throw new Error('temporary Core failure');
      return { projection: 'feishu', claimed: 1, acknowledged: 1, idle: false };
    },
    async sleep(intervalMs) {
      assert.equal(intervalMs, 2_000);
      if (cycles === 2) controller.abort();
    },
    log(event) { events.push(event); },
    clock: () => '2026-08-25T10:00:00.000Z',
  });

  assert.deepEqual(operationIds, ['supervisor-test:1', 'supervisor-test:2']);
  assert.deepEqual(result, { cycles: 2, stopReason: 'aborted' });
  assert.deepEqual(events.map((event) => event.event), [
    'commitment_feishu_projection_failed',
    'commitment_feishu_projection',
    'commitment_feishu_projection_supervisor_stopped',
  ]);
});

test('runtime loading injects the publisher seam from an explicit module without knowing the Feishu SDK', async () => {
  const publisher = { createTask() {}, updateTask() {} };
  const resolveTarget = () => ({ receiveId: 'chat-1', receiveIdType: 'chat_id' });
  let imported;
  const runtime = await loadFeishuProjectionRuntime({
    modulePath: './zylos-feishu-runtime.mjs',
    cwd: '/opt/zylos-runtime',
    async importModule(specifier) {
      imported = specifier;
      return {
        async createFeishuProjectionRuntime() {
          return { publisher, resolveTarget };
        },
      };
    },
  });

  assert.equal(imported, 'file:///opt/zylos-runtime/zylos-feishu-runtime.mjs');
  assert.equal(runtime.publisher, publisher);
  assert.equal(runtime.resolveTarget, resolveTarget);
  assert.equal(Object.isFrozen(runtime), true);

  await assert.rejects(
    () => loadFeishuProjectionRuntime({
      modulePath: './invalid.mjs',
      cwd: '/opt/zylos-runtime',
      importModule: async () => ({ createFeishuProjectionRuntime: () => ({ publisher: {} }) }),
    }),
    /runtime publisher must provide createTask and updateTask/,
  );
});

test('the CLI makes projection history registration an explicit operator action', async () => {
  const calls = [];
  let output = '';
  const result = await runFeishuProjectionWorkerCli({
    args: ['register', '--bootstrap-policy', 'from_now'],
    initialize(options) {
      calls.push(options);
      return { created: true, registration: { projection: 'feishu', bootstrapPolicy: 'from_now' } };
    },
    stdout: { write(value) { output += value; } },
  });

  assert.deepEqual(calls, [{ bootstrapPolicy: 'from_now' }]);
  assert.equal(result.registration.projection, 'feishu');
  assert.deepEqual(JSON.parse(output), result);
  await assert.rejects(
    () => runFeishuProjectionWorkerCli({
      args: ['register'],
      initialize() { assert.fail('invalid CLI must fail before registration'); },
    }),
    /usage:/,
  );
});

test('the one-shot CLI loads an explicit runtime Module and runs with bounded configuration', async () => {
  const publisher = { createTask() {}, updateTask() {} };
  const calls = [];
  let output = '';
  const result = await runFeishuProjectionWorkerCli({
    args: ['run', '--runtime-module', './runtime.mjs', '--once'],
    env: {
      COMMITMENT_FEISHU_PROJECTION_WORKER_ID: 'worker-from-env',
      COMMITMENT_FEISHU_PROJECTION_BATCH_SIZE: '9',
      COMMITMENT_FEISHU_PROJECTION_LEASE_MS: '40000',
      COMMITMENT_FEISHU_PROJECTION_RETRY_AFTER_MS: '6000',
      COMMITMENT_FEISHU_PROJECTION_MAX_ATTEMPTS: '4',
    },
    async loadRuntime(options) {
      assert.equal(options.modulePath, './runtime.mjs');
      return { publisher };
    },
    async runOnce(options) {
      calls.push(options);
      return { projection: 'feishu', claimed: 0, idle: true };
    },
    stdout: { write(value) { output += value; } },
  });

  assert.equal(result.idle, true);
  assert.deepEqual(calls, [{
    workerId: 'worker-from-env',
    limit: 9,
    leaseMs: 40_000,
    retryAfterMs: 6_000,
    maxAttempts: 4,
    publisher,
    resolveTarget: undefined,
  }]);
  assert.deepEqual(JSON.parse(output), result);
});

test('the executable register command persists the selected projection policy without loading a runtime', () => {
  const zylosDir = mkdtempSync(path.join(os.tmpdir(), 'zylos-feishu-register-'));
  try {
    const result = spawnSync(process.execPath, [
      WORKER_PATH,
      'register',
      '--bootstrap-policy',
      'from_now',
    ], {
      env: { ...process.env, ZYLOS_DIR: zylosDir },
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(JSON.parse(result.stdout).registration.projection, 'feishu');

    const core = openCommitmentCore({
      dbPath: path.join(zylosDir, 'commitments', 'commitments.db'),
    });
    try {
      assert.deepEqual(core.outbox.query({ projection: 'feishu', limit: 1 }), []);
    } finally {
      core.close();
    }
  } finally {
    rmSync(zylosDir, { recursive: true, force: true });
  }
});
