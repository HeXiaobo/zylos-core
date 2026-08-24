import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  runLeaseSweepOnce,
  superviseRunLeaseSweep,
} from '../run-lease-sweep-supervisor.js';

const SUPERVISOR_PATH = fileURLToPath(
  new URL('../run-lease-sweep-supervisor.js', import.meta.url),
);
const ECOSYSTEM_PATH = fileURLToPath(
  new URL('../../../../templates/pm2/ecosystem.config.cjs', import.meta.url),
);

function pathEntryExists(filePath) {
  try {
    fs.lstatSync(filePath);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

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
    assert.equal(
      pathEntryExists(path.join(zylosDir, '.zylos', 'commitment-run-lease-sweep.lock')),
      false,
    );
  } finally {
    if (child.exitCode === null) child.kill('SIGKILL');
    fs.rmSync(zylosDir, { recursive: true, force: true });
  }
});

test('one-shot CLI recovers a stale instance lock and exits after one bounded sweep', () => {
  const zylosDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-run-sweep-once-'));
  const metadataDir = path.join(zylosDir, '.zylos');
  const lockPath = path.join(metadataDir, 'commitment-run-lease-sweep.lock');
  fs.mkdirSync(metadataDir, { recursive: true });
  fs.symlinkSync('pid:99999999', lockPath);

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
    assert.equal(pathEntryExists(lockPath), false);
  } finally {
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
