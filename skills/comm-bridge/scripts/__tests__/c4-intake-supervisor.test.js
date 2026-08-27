import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  drainCommitmentIntake,
  superviseCommitmentIntake,
} from '../c4-intake-supervisor.js';

const SUPERVISOR_PATH = fileURLToPath(new URL('../c4-intake-supervisor.js', import.meta.url));
const ECOSYSTEM_PATH = fileURLToPath(
  new URL('../../../../templates/pm2/ecosystem.config.cjs', import.meta.url),
);

test('drains only the configured batch and summarizes worker outcomes', () => {
  const outcomes = [
    { status: 'completed', intakeId: 1 },
    { status: 'pending', intakeId: 2, retryCount: 1 },
    { status: 'failed', intakeId: 3, retryCount: 3 },
  ];

  const result = drainCommitmentIntake({
    maxItems: 3,
    runOnce: () => outcomes.shift(),
  });

  assert.deepEqual(result, {
    attempted: 3,
    completed: 1,
    retried: 1,
    failed: 1,
    stopReason: 'limit',
  });
  assert.equal(outcomes.length, 0);
});

test('stops the bounded drain as soon as the intake queue is idle', () => {
  let calls = 0;
  const result = drainCommitmentIntake({
    maxItems: 10,
    runOnce() {
      calls += 1;
      return calls === 1
        ? { status: 'completed', intakeId: 1 }
        : { status: 'idle' };
    },
  });

  assert.deepEqual(result, {
    attempted: 1,
    completed: 1,
    retried: 0,
    failed: 0,
    stopReason: 'idle',
  });
  assert.equal(calls, 2);
});

test('rejects an invalid drain bound before claiming work', () => {
  let calls = 0;
  assert.throws(
    () => drainCommitmentIntake({
      maxItems: 0,
      runOnce() {
        calls += 1;
        return { status: 'idle' };
      },
    }),
    /maxItems must be a positive integer/,
  );
  assert.equal(calls, 0);
});

test('fails closed when the worker returns an unknown outcome', () => {
  assert.throws(
    () => drainCommitmentIntake({
      maxItems: 1,
      runOnce: () => ({ status: 'mystery' }),
    }),
    /unknown commitment intake worker status: mystery/,
  );
});

test('runs periodic drains sequentially and stops cleanly when aborted', async () => {
  const controller = new AbortController();
  const events = [];
  let activeDrains = 0;
  let maxActiveDrains = 0;
  let drainCount = 0;

  const result = await superviseCommitmentIntake({
    maxItems: 5,
    intervalMs: 2_000,
    signal: controller.signal,
    async drain(options) {
      assert.deepEqual(options, { maxItems: 5 });
      activeDrains += 1;
      maxActiveDrains = Math.max(maxActiveDrains, activeDrains);
      await Promise.resolve();
      activeDrains -= 1;
      drainCount += 1;
      return {
        attempted: 0,
        completed: 0,
        retried: 0,
        failed: 0,
        stopReason: 'idle',
      };
    },
    async sleep(intervalMs) {
      assert.equal(intervalMs, 2_000);
      if (drainCount === 2) controller.abort();
    },
    log(event) {
      events.push(event);
    },
  });

  assert.equal(maxActiveDrains, 1);
  assert.equal(drainCount, 2);
  assert.deepEqual(result, { cycles: 2, stopReason: 'aborted' });
  assert.deepEqual(events.map((event) => event.event), [
    'commitment_intake_drain',
    'commitment_intake_drain',
    'commitment_intake_supervisor_stopped',
  ]);
});

test('logs one failed drain and continues with the next cycle', async () => {
  const controller = new AbortController();
  const events = [];
  let drainCount = 0;

  const result = await superviseCommitmentIntake({
    maxItems: 5,
    intervalMs: 2_000,
    signal: controller.signal,
    async drain() {
      drainCount += 1;
      if (drainCount === 1) throw new Error('temporary database fault');
      return {
        attempted: 0,
        completed: 0,
        retried: 0,
        failed: 0,
        stopReason: 'idle',
      };
    },
    async sleep() {
      if (drainCount === 2) controller.abort();
    },
    log(event) {
      events.push(event);
    },
  });

  assert.equal(drainCount, 2);
  assert.deepEqual(result, { cycles: 2, stopReason: 'aborted' });
  assert.deepEqual(events.map((event) => event.event), [
    'commitment_intake_drain_failed',
    'commitment_intake_drain',
    'commitment_intake_supervisor_stopped',
  ]);
  assert.match(events[0].error, /temporary database fault/);
});

test('CLI exits non-zero with a structured fatal log for invalid configuration', () => {
  const result = spawnSync(process.execPath, [SUPERVISOR_PATH], {
    env: {
      ...process.env,
      C4_INTAKE_INTERVAL_MS: '0',
    },
    encoding: 'utf8',
  });

  assert.equal(result.status, 1);
  const event = JSON.parse(result.stdout.trim());
  assert.equal(event.event, 'commitment_intake_supervisor_fatal');
  assert.match(event.error, /C4_INTAKE_INTERVAL_MS must be a positive integer/);
});

test('CLI starts when invoked through a symlinked entry path', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'c4-intake-cli-link-'));
  const linkedEntry = path.join(directory, 'c4-intake-supervisor.js');
  try {
    fs.symlinkSync(SUPERVISOR_PATH, linkedEntry);
    const result = spawnSync(process.execPath, [linkedEntry], {
      env: {
        ...process.env,
        C4_INTAKE_INTERVAL_MS: '0',
      },
      encoding: 'utf8',
    });

    assert.equal(result.status, 1, result.stderr || result.stdout);
    const event = JSON.parse(result.stdout.trim());
    assert.equal(event.event, 'commitment_intake_supervisor_fatal');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('PM2-style module loading starts with the dedicated autostart opt-in', () => {
  const script = `await import(${JSON.stringify(pathToFileURL(SUPERVISOR_PATH).href)});`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    env: {
      ...process.env,
      C4_INTAKE_SUPERVISOR_AUTOSTART: '1',
      C4_INTAKE_INTERVAL_MS: '0',
    },
    encoding: 'utf8',
  });

  assert.equal(result.status, 1, result.stderr || result.stdout);
  const event = JSON.parse(result.stdout.trim());
  assert.equal(event.event, 'commitment_intake_supervisor_fatal');
});

test('module import fails closed for a non-opt-in autostart value', () => {
  const script = `await import(${JSON.stringify(pathToFileURL(SUPERVISOR_PATH).href)});`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    env: {
      ...process.env,
      C4_INTAKE_SUPERVISOR_AUTOSTART: '0',
      C4_INTAKE_INTERVAL_MS: '0',
    },
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(result.stdout, '');
});

test('CLI rejects an interval that would busy-spin the supervisor', () => {
  const zylosDir = fs.mkdtempSync(path.join(os.tmpdir(), 'c4-intake-config-'));
  try {
    const result = spawnSync(process.execPath, [SUPERVISOR_PATH], {
      env: {
        ...process.env,
        ZYLOS_DIR: zylosDir,
        C4_INTAKE_INTERVAL_MS: '1',
      },
      encoding: 'utf8',
      timeout: 500,
    });

    assert.equal(result.status, 1, result.stderr || result.stdout);
    const event = JSON.parse(result.stdout.trim());
    assert.equal(event.event, 'commitment_intake_supervisor_fatal');
    assert.match(event.error, /C4_INTAKE_INTERVAL_MS must be between 250 and 60000/);
  } finally {
    fs.rmSync(zylosDir, { recursive: true, force: true });
  }
});

test('CLI rejects an unbounded intake batch', () => {
  const result = spawnSync(process.execPath, [SUPERVISOR_PATH], {
    env: {
      ...process.env,
      C4_INTAKE_BATCH_SIZE: '101',
    },
    encoding: 'utf8',
  });

  assert.equal(result.status, 1);
  const event = JSON.parse(result.stdout.trim());
  assert.equal(event.event, 'commitment_intake_supervisor_fatal');
  assert.match(event.error, /C4_INTAKE_BATCH_SIZE must be between 1 and 100/);
});

test('CLI handles SIGTERM as a graceful zero-exit shutdown', async () => {
  const zylosDir = fs.mkdtempSync(path.join(os.tmpdir(), 'c4-intake-sigterm-'));
  const child = spawn(process.execPath, [SUPERVISOR_PATH], {
    env: {
      ...process.env,
      ZYLOS_DIR: zylosDir,
      C4_INTAKE_INTERVAL_MS: '60000',
    },
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
        if (!stdout.includes('commitment_intake_supervisor_started')) return;
        clearTimeout(timeout);
        resolve();
      });
      child.once('error', reject);
    });
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
    const events = stdout
      .split('\n')
      .filter((line) => line.startsWith('{'))
      .map((line) => JSON.parse(line));
    assert.ok(events.some((event) => event.event === 'commitment_intake_supervisor_started'));
    assert.ok(events.some((event) => event.event === 'commitment_intake_supervisor_stopped'));
    assert.equal(events.some((event) => event.event === 'commitment_intake_supervisor_fatal'), false);
  } finally {
    if (child.exitCode === null) child.kill('SIGKILL');
    fs.rmSync(zylosDir, { recursive: true, force: true });
  }
});

test('PM2 ecosystem exposes the supervisor as a single isolated core process', () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'c4-intake-ecosystem-'));
  try {
    const script = [
      'const config = require(process.argv[1]);',
      "const app = config.apps.find((entry) => entry.name === 'c4-intake-supervisor');",
      'process.stdout.write(JSON.stringify(app));',
    ].join('');
    const result = spawnSync(process.execPath, ['-e', script, ECOSYSTEM_PATH], {
      env: { HOME: homeDir, PATH: '/usr/bin:/bin' },
      encoding: 'utf8',
    });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const app = JSON.parse(result.stdout);
    assert.equal(app.name, 'c4-intake-supervisor');
    assert.equal(
      app.script,
      path.join(
        homeDir,
        'zylos',
        '.claude',
        'skills',
        'comm-bridge',
        'scripts',
        'c4-intake-supervisor.js',
      ),
    );
    assert.equal(app.instances, 1);
    assert.equal(app.exec_mode, 'fork');
    assert.equal(app.autorestart, true);
    assert.equal(app.env.C4_INTAKE_SUPERVISOR_AUTOSTART, '1');
  } finally {
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});
