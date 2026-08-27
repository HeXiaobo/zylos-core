import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { resolveEcosystemTemplate } from './ecosystem-template-resolver.js';
import {
  acquireRunSweepLease,
  runLeaseSweepOnce,
  superviseRunLeaseSweep,
} from '../run-lease-sweep-supervisor.js';

const SUPERVISOR_PATH = fileURLToPath(
  new URL('../run-lease-sweep-supervisor.js', import.meta.url),
);
const SOURCE_ECOSYSTEM_PATH = fileURLToPath(
  new URL('../../../../templates/pm2/ecosystem.config.cjs', import.meta.url),
);
const ECOSYSTEM_PATH = resolveEcosystemTemplate(SOURCE_ECOSYSTEM_PATH);

test('a second process cannot acquire an unexpired Run sweep lease', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-run-sweep-lease-'));
  const dbPath = path.join(directory, 'supervisor-leases.db');
  const first = acquireRunSweepLease({
    dbPath,
    ownerToken: 'owner-1',
    clock: () => 1_000,
    leaseMs: 10_000,
  });

  try {
    assert.throws(
      () => acquireRunSweepLease({
        dbPath,
        ownerToken: 'owner-2',
        clock: () => 2_000,
        leaseMs: 10_000,
      }),
      (error) => error?.code === 'ALREADY_RUNNING',
    );
  } finally {
    first.release();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('an expired lease is fenced on takeover and only the new owner can release it', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-run-sweep-takeover-'));
  const dbPath = path.join(directory, 'supervisor-leases.db');
  let now = 1_000;
  const first = acquireRunSweepLease({
    dbPath,
    ownerToken: 'owner-1',
    clock: () => now,
    leaseMs: 100,
  });

  try {
    now = 1_100;
    const second = acquireRunSweepLease({
      dbPath,
      ownerToken: 'owner-2',
      clock: () => now,
      leaseMs: 100,
    });
    try {
      assert.equal(first.fencingToken, 1);
      assert.equal(second.fencingToken, 2);
      assert.equal(first.release(), false);

      now = 1_150;
      assert.deepEqual(second.renew(), {
        fencingToken: 2,
        expiresAt: 1_250,
      });
      assert.equal(second.release(), true);
    } finally {
      second.release();
    }
  } finally {
    first.release();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('fencing tokens remain monotonic after a graceful release', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-run-sweep-fencing-'));
  const dbPath = path.join(directory, 'supervisor-leases.db');
  try {
    const first = acquireRunSweepLease({
      dbPath,
      ownerToken: 'owner-1',
      clock: () => 1_000,
      leaseMs: 100,
    });
    assert.equal(first.fencingToken, 1);
    assert.equal(first.release(), true);

    const second = acquireRunSweepLease({
      dbPath,
      ownerToken: 'owner-2',
      clock: () => 1_001,
      leaseMs: 100,
    });
    try {
      assert.equal(second.fencingToken, 2);
    } finally {
      second.release();
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('one sweep opens Core, applies the configured bound, and always closes Core', () => {
  let closed = false;
  const result = runLeaseSweepOnce({
    limit: 7,
    openCore() {
      return {
        runs: {
          sweepExpired(options) {
            assert.deepEqual(options, { limit: 7 });
            return { expiredCount: 2, hasMore: true };
          },
        },
        close() {
          closed = true;
        },
      };
    },
  });

  assert.deepEqual(result, { expiredCount: 2, hasMore: true });
  assert.equal(closed, true);
});

test('one sweep closes Core when the transactional sweep fails', () => {
  let closed = false;
  assert.throws(
    () => runLeaseSweepOnce({
      limit: 7,
      openCore: () => ({
        runs: {
          sweepExpired() {
            throw new Error('database unavailable');
          },
        },
        close() {
          closed = true;
        },
      }),
    }),
    /database unavailable/,
  );
  assert.equal(closed, true);
});

test('supervisor logs a failed sweep and continues until gracefully aborted', async () => {
  const controller = new AbortController();
  const events = [];
  let sweepCount = 0;

  const result = await superviseRunLeaseSweep({
    limit: 5,
    intervalMs: 2_000,
    signal: controller.signal,
    async sweep(options) {
      assert.deepEqual(options, { limit: 5 });
      sweepCount += 1;
      if (sweepCount === 1) throw new Error('temporary database fault');
      return { expiredCount: 1, hasMore: false };
    },
    async sleep(intervalMs) {
      assert.equal(intervalMs, 2_000);
      if (sweepCount === 2) controller.abort();
    },
    log(event) {
      events.push(event);
    },
    clock: () => '2026-08-25T10:00:00.000Z',
  });

  assert.equal(sweepCount, 2);
  assert.deepEqual(result, { cycles: 2, stopReason: 'aborted' });
  assert.deepEqual(events.map((event) => event.event), [
    'commitment_run_lease_sweep_failed',
    'commitment_run_lease_sweep',
    'commitment_run_lease_sweep_supervisor_stopped',
  ]);
  assert.match(events[0].error, /temporary database fault/);
});

test('supervisor stops before another sweep when lease ownership is lost', async () => {
  let renewals = 0;
  let sweeps = 0;

  await assert.rejects(
    superviseRunLeaseSweep({
      limit: 5,
      intervalMs: 2_000,
      renewLease() {
        renewals += 1;
        if (renewals === 2) {
          const error = new Error('lease ownership was lost');
          error.code = 'LEASE_LOST';
          throw error;
        }
      },
      sweep() {
        sweeps += 1;
        return { expiredCount: 0, hasMore: false };
      },
      async sleep() {},
      log() {},
    }),
    (error) => error?.code === 'LEASE_LOST',
  );
  assert.equal(renewals, 2);
  assert.equal(sweeps, 1);
});

test('supervisor rejects unsafe bounds before beginning a cycle', async () => {
  for (const options of [
    { limit: 0, intervalMs: 2_000 },
    { limit: 101, intervalMs: 2_000 },
    { limit: 5, intervalMs: 249 },
    { limit: 5, intervalMs: 60_001 },
  ]) {
    let sweeps = 0;
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      superviseRunLeaseSweep({
        ...options,
        signal: controller.signal,
        sweep() {
          sweeps += 1;
        },
      }),
      /(limit|intervalMs)/,
    );
    assert.equal(sweeps, 0);
  }
});

test('CLI rejects configuration that could busy-spin the supervisor', () => {
  const result = spawnSync(process.execPath, [SUPERVISOR_PATH], {
    env: {
      ...process.env,
      COMMITMENT_RUN_SWEEP_INTERVAL_MS: '1',
    },
    encoding: 'utf8',
  });

  assert.equal(result.status, 1, result.stderr || result.stdout);
  const event = JSON.parse(result.stdout.trim());
  assert.equal(event.event, 'commitment_run_lease_sweep_supervisor_fatal');
  assert.match(event.error, /COMMITMENT_RUN_SWEEP_INTERVAL_MS must be between 250 and 60000/);
});

test('CLI enforces one instance and releases it on graceful SIGTERM', async () => {
  const zylosDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-run-sweep-cli-'));
  const environment = {
    ...process.env,
    ZYLOS_DIR: zylosDir,
    COMMITMENT_RUN_SWEEP_INTERVAL_MS: '60000',
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
        if (!stdout.includes('commitment_run_lease_sweep_supervisor_started')) return;
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
    const contenderEvent = JSON.parse(contender.stdout.trim());
    assert.equal(contenderEvent.event, 'commitment_run_lease_sweep_supervisor_fatal');
    assert.match(contenderEvent.error, /already running/);

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
    assert.match(stdout, /commitment_run_lease_sweep_supervisor_stopped/);
    const verifier = acquireRunSweepLease({
      dbPath: path.join(zylosDir, '.zylos', 'supervisor-leases.db'),
      ownerToken: 'post-sigterm-verifier',
      clock: () => Date.now(),
      leaseMs: 1_000,
    });
    assert.equal(verifier.fencingToken, 2);
    assert.equal(verifier.release(), true);
  } finally {
    if (child.exitCode === null) child.kill('SIGKILL');
    fs.rmSync(zylosDir, { recursive: true, force: true });
  }
});

test('one-shot CLI takes over an expired fenced lease and exits after one bounded sweep', () => {
  const zylosDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-run-sweep-once-'));
  const dbPath = path.join(zylosDir, '.zylos', 'supervisor-leases.db');
  const expired = acquireRunSweepLease({
    dbPath,
    ownerToken: 'crashed-owner',
    clock: () => 0,
    leaseMs: 1,
  });

  try {
    const result = spawnSync(process.execPath, [SUPERVISOR_PATH, '--once'], {
      env: {
        ...process.env,
        ZYLOS_DIR: zylosDir,
        COMMITMENT_RUN_SWEEP_BATCH_SIZE: '3',
      },
      encoding: 'utf8',
    });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const events = result.stdout.trim().split('\n').map((line) => JSON.parse(line));
    assert.deepEqual(events.map((event) => event.event), [
      'commitment_run_lease_sweep_supervisor_started',
      'commitment_run_lease_sweep',
    ]);
    assert.equal(events[0].limit, 3);
    assert.equal(events[0].once, true);
    assert.equal(events[0].fencingToken, 2);
    assert.equal(expired.release(), false);

    const verifier = acquireRunSweepLease({
      dbPath,
      ownerToken: 'post-once-verifier',
      clock: () => Date.now(),
      leaseMs: 1_000,
    });
    assert.equal(verifier.fencingToken, 3);
    verifier.release();
  } finally {
    expired.release();
    fs.rmSync(zylosDir, { recursive: true, force: true });
  }
});

test('concurrent processes cannot both take over the same expired lease', async () => {
  const zylosDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-run-sweep-race-'));
  const dbPath = path.join(zylosDir, '.zylos', 'supervisor-leases.db');
  const expired = acquireRunSweepLease({
    dbPath,
    ownerToken: 'crashed-owner',
    clock: () => 0,
    leaseMs: 1,
  });
  const environment = {
    ...process.env,
    ZYLOS_DIR: zylosDir,
    COMMITMENT_RUN_SWEEP_INTERVAL_MS: '60000',
  };
  const children = [
    spawn(process.execPath, [SUPERVISOR_PATH], {
      env: environment,
      stdio: ['ignore', 'pipe', 'pipe'],
    }),
    spawn(process.execPath, [SUPERVISOR_PATH], {
      env: environment,
      stdio: ['ignore', 'pipe', 'pipe'],
    }),
  ];

  function observeStartOrExit(child) {
    return new Promise((resolve, reject) => {
      let stdout = '';
      let stderr = '';
      let settled = false;
      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new Error(`contender did not settle: ${stdout}\n${stderr}`));
      }, 2_000);
      const finish = (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        resolve({ ...result, stdout, stderr });
      };
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk) => {
        stdout += chunk;
        if (stdout.includes('commitment_run_lease_sweep_supervisor_started')) {
          finish({ outcome: 'started' });
        }
      });
      child.stderr.on('data', (chunk) => { stderr += chunk; });
      child.once('error', reject);
      child.once('close', (code) => finish({ outcome: 'exited', code }));
    });
  }

  try {
    try {
      const results = await Promise.all(children.map(observeStartOrExit));
      assert.deepEqual(
        results.map(({ outcome }) => outcome).sort(),
        ['exited', 'started'],
        JSON.stringify(results),
      );
      const rejected = results.find(({ outcome }) => outcome === 'exited');
      assert.equal(rejected.code, 1, rejected.stderr || rejected.stdout);
      const fatal = rejected.stdout.trim().split('\n').map((line) => JSON.parse(line))
        .find((event) => event.event === 'commitment_run_lease_sweep_supervisor_fatal');
      assert.equal(fatal?.event, 'commitment_run_lease_sweep_supervisor_fatal');
      assert.match(fatal.error, /already running/);
    } finally {
      await Promise.all(children.map((child) => {
        if (child.exitCode !== null) return Promise.resolve();
        return new Promise((resolve) => {
          child.once('close', resolve);
          child.kill('SIGTERM');
        });
      }));
    }

    assert.equal(expired.release(), false);
    const verifier = acquireRunSweepLease({
      dbPath,
      ownerToken: 'post-race-verifier',
      clock: () => Date.now(),
      leaseMs: 1_000,
    });
    assert.equal(verifier.fencingToken, 3);
    verifier.release();
  } finally {
    expired.release();
    fs.rmSync(zylosDir, { recursive: true, force: true });
  }
});

test('default PM2 ecosystem does not auto-start the opt-in lease sweep', () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-run-sweep-pm2-'));
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
    assert.equal(
      JSON.parse(result.stdout).includes('commitment-run-lease-sweep'),
      false,
    );
  } finally {
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});
