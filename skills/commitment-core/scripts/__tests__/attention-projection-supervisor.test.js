import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import Database from 'better-sqlite3';

import { resolveEcosystemTemplate } from './ecosystem-template-resolver.js';
import { openCommitmentCore } from '../core.js';
import {
  acquireAttentionProjectionLease,
  initializeAttentionProjection,
  runAttentionProjectionOnce,
  superviseAttentionProjection,
} from '../attention-projection-supervisor.js';

const SUPERVISOR_PATH = fileURLToPath(
  new URL('../attention-projection-supervisor.js', import.meta.url),
);
const SOURCE_ECOSYSTEM_PATH = fileURLToPath(
  new URL('../../../../templates/pm2/ecosystem.config.cjs', import.meta.url),
);
const ECOSYSTEM_PATH = resolveEcosystemTemplate(SOURCE_ECOSYSTEM_PATH);

function pathEntryExists(filePath) {
  try {
    fs.lstatSync(filePath);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

function singletonLeaseCount(zylosDir) {
  const dbPath = path.join(zylosDir, '.zylos', 'supervisor-leases.db');
  if (!pathEntryExists(dbPath)) return 0;
  const database = new Database(dbPath, { readonly: true });
  try {
    return database.prepare('SELECT COUNT(*) AS count FROM commitment_supervisor_leases').get().count;
  } finally {
    database.close();
  }
}

function singletonLeaseOwner(dbPath) {
  const database = new Database(dbPath, { readonly: true });
  try {
    return database.prepare(
      'SELECT owner_token FROM commitment_supervisor_leases',
    ).get()?.owner_token ?? null;
  } finally {
    database.close();
  }
}

test('initialization registers from_now before publishing the current Attention snapshot', async () => {
  const calls = [];
  let closed = false;
  const core = {
    outbox: {
      register(request) {
        calls.push(['register', request]);
        return { created: true, registration: { projection: 'attention' } };
      },
    },
    close() { closed = true; },
  };

  const result = await initializeAttentionProjection({
    outputPath: '/tmp/task-attention.md',
    openCore: () => core,
    adapterFactory(options) {
      assert.equal(options.core, core);
      assert.equal(options.outputPath, '/tmp/task-attention.md');
      return {
        publishCurrent() {
          calls.push(['publish']);
          return { taskCount: 2 };
        },
      };
    },
  });

  assert.equal(calls[0][0], 'register');
  assert.deepEqual(calls[0][1], {
    projection: 'attention',
    bootstrapPolicy: 'from_now',
    actorId: 'commitment-attention-projection',
    idempotencyKey: 'commitment-attention-projection:register:from-now:v1',
  });
  assert.deepEqual(calls[1], ['publish']);
  assert.equal(result.registration.created, true);
  assert.equal(result.publication.taskCount, 2);
  assert.equal(closed, true);
});

test('one cycle opens Core, publishes one bounded batch, and always closes Core', async () => {
  let closed = false;
  let received;
  const core = {
    query() { return []; },
    outbox: { claim() {}, ack() {}, fail() {} },
    close() { closed = true; },
  };

  const result = await runAttentionProjectionOnce({
    workerId: 'worker-1',
    leaseMs: 30_000,
    limit: 7,
    retryAfterMs: 5_000,
    maxAttempts: 3,
    outputPath: '/tmp/test-task-attention.md',
    operationId: 'cycle-1',
    openCore: () => core,
    async processBatch(options) {
      received = options;
      return { claimed: 0, idle: true };
    },
  });

  assert.deepEqual(result, { claimed: 0, idle: true });
  assert.equal(received.core, core);
  assert.equal(received.projection, 'attention');
  assert.equal(received.workerId, 'worker-1');
  assert.equal(received.limit, 7);
  assert.equal(received.operationId, 'cycle-1');
  assert.equal(typeof received.adapter.publishBatch, 'function');
  assert.equal(closed, true);
});

test('the supervisor logs a failed cycle, continues, and exits gracefully', async () => {
  const controller = new AbortController();
  const events = [];
  const operationIds = [];
  let cycles = 0;

  const result = await superviseAttentionProjection({
    workerId: 'worker-1',
    leaseMs: 30_000,
    limit: 7,
    retryAfterMs: 5_000,
    maxAttempts: 3,
    intervalMs: 2_000,
    signal: controller.signal,
    operationIdFactory: () => 'supervisor-test',
    async runOnce(options) {
      cycles += 1;
      operationIds.push(options.operationId);
      if (cycles === 1) throw new Error('temporary database fault');
      return { claimed: 1, acknowledged: 1, idle: false };
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
    'commitment_attention_projection_failed',
    'commitment_attention_projection',
    'commitment_attention_projection_supervisor_stopped',
  ]);
});

test('one-shot CLI publishes to the dedicated default file and releases its SQLite lease', () => {
  const zylosDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-attention-supervisor-once-'));
  const core = openCommitmentCore({
    dbPath: path.join(zylosDir, 'commitments', 'commitments.db'),
    clock: () => '2026-08-25T10:00:00.000Z',
    idGenerator: () => 'task-1',
    eventIdGenerator: () => 'event-1',
  });
  core.ingest({
    idempotencyKey: 'source:1',
    source: { channel: 'test', externalId: 'message-1', senderId: 'owner-1' },
    task: { title: 'Projected from supervisor', ownerId: 'owner-1' },
  });
  core.close();
  try {
    const result = spawnSync(process.execPath, [SUPERVISOR_PATH, '--once'], {
      env: { ...process.env, ZYLOS_DIR: zylosDir },
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const events = result.stdout.trim().split('\n').map((line) => JSON.parse(line));
    assert.deepEqual(events.map((event) => event.event), [
      'commitment_attention_projection_supervisor_started',
      'commitment_attention_projection',
    ]);
    const outputPath = path.join(zylosDir, 'memory', 'task-attention.md');
    assert.match(fs.readFileSync(outputPath, 'utf8'), /Projected from supervisor/);
    assert.equal(pathEntryExists(path.join(zylosDir, 'memory', 'state.md')), false);
    assert.equal(singletonLeaseCount(zylosDir), 0);
  } finally {
    fs.rmSync(zylosDir, { recursive: true, force: true });
  }
});

test('the SQLite singleton lease fences a live owner and recovers exactly at expiry', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-attention-lease-'));
  const dbPath = path.join(directory, 'supervisor-leases.db');
  let now = 1_000;
  const first = acquireAttentionProjectionLease({
    dbPath,
    ownerToken: 'owner-1',
    leaseMs: 1_000,
    clock: () => now,
  });
  let second;
  try {
    now = 1_999;
    assert.throws(() => acquireAttentionProjectionLease({
      dbPath,
      ownerToken: 'owner-2',
      leaseMs: 1_000,
      clock: () => now,
    }), (error) => error?.code === 'ALREADY_RUNNING');

    now = 2_000;
    second = acquireAttentionProjectionLease({
      dbPath,
      ownerToken: 'owner-2',
      leaseMs: 1_000,
      clock: () => now,
    });
    assert.throws(() => first.renew(), (error) => error?.code === 'SINGLETON_LEASE_LOST');
    first.release();
    assert.equal(singletonLeaseOwner(dbPath), 'owner-2');
  } finally {
    first.release();
    second?.release();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('CLI enforces one instance and releases it after graceful SIGTERM', async () => {
  const zylosDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-attention-supervisor-'));
  const environment = {
    ...process.env,
    ZYLOS_DIR: zylosDir,
    COMMITMENT_ATTENTION_PROJECTION_INTERVAL_MS: '60000',
  };
  const child = spawn(process.execPath, [SUPERVISOR_PATH], {
    env: environment,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });

  try {
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error(`supervisor did not start: ${stdout}\n${stderr}`)),
        2_000,
      );
      child.stdout.on('data', () => {
        if (!stdout.includes('commitment_attention_projection_supervisor_started')) return;
        clearTimeout(timeout);
        resolve();
      });
      child.once('error', reject);
    });

    const contender = spawnSync(process.execPath, [SUPERVISOR_PATH], {
      env: environment,
      encoding: 'utf8',
      timeout: 1_000,
    });
    assert.equal(contender.status, 1, contender.stderr || contender.stdout);
    assert.match(contender.stdout, /already running/);

    child.kill('SIGTERM');
    const exitCode = await new Promise((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error(`supervisor did not stop: ${stdout}\n${stderr}`)),
        2_000,
      );
      child.once('close', (code) => {
        clearTimeout(timeout);
        resolve(code);
      });
    });
    assert.equal(exitCode, 0, stderr || stdout);
    assert.match(stdout, /commitment_attention_projection_supervisor_stopped/);
    assert.equal(singletonLeaseCount(zylosDir), 0);
  } finally {
    if (child.exitCode === null) child.kill('SIGKILL');
    fs.rmSync(zylosDir, { recursive: true, force: true });
  }
});

test('default PM2 ecosystem does not auto-start the opt-in Attention projection', () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-attention-pm2-'));
  try {
    const script = [
      'const config = require(process.argv[1]);',
      'process.stdout.write(JSON.stringify(config.apps.map((app) => app.name)));',
    ].join('');
    const result = spawnSync(process.execPath, ['-e', script, ECOSYSTEM_PATH], {
      env: { HOME: homeDir, PATH: '/usr/bin:/bin' },
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(JSON.parse(result.stdout).includes('commitment-attention-projection'), false);
  } finally {
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});
