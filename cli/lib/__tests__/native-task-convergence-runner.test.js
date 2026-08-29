import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

import { captureProcessIdentity } from '../process-identity.js';

const RUNNER = path.resolve('scripts/native-task-convergence-runner.js');
const LOCK_SCHEMA = 'zylos.native-task-convergence-lock/v1';
const JOB_SCHEMA = 'zylos.native-task-convergence-runner-job/v1';

test('controlled runner records itself before the business command starts', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-native-runner-'));
  try {
    const transactionId = '33333333-3333-4333-8333-333333333333';
    const lockPath = path.join(root, 'native-task-convergence.lock');
    const jobPath = path.join(root, 'job.json');
    const resultPath = path.join(root, 'result.json');
    const markerPath = path.join(root, 'business-seen-runner.txt');
    const parent = captureProcessIdentity();
    fs.writeFileSync(lockPath, `${JSON.stringify({
      schema: LOCK_SCHEMA,
      transactionId,
      hostname: os.hostname(),
      parent,
      runnerToken: 'runner-token',
      phase: 'PARENT_READY',
    })}\n`);
    const businessScript = [
      "import fs from 'node:fs';",
      "const lock = JSON.parse(fs.readFileSync(process.env.TEST_LOCK_PATH, 'utf8'));",
      "fs.writeFileSync(process.env.TEST_MARKER_PATH, String(Boolean(lock.runner?.pid && lock.runner?.startToken)));",
    ].join(' ');
    fs.writeFileSync(jobPath, `${JSON.stringify({
      schema: JOB_SCHEMA,
      transactionId,
      lockPath,
      parent,
      runnerToken: 'runner-token',
      command: process.execPath,
      args: ['--input-type=module', '-e', businessScript],
      cwd: root,
      resultPath,
    })}\n`, { mode: 0o600 });

    const result = spawnSync(process.execPath, [RUNNER, '--job', jobPath], {
      cwd: root,
      encoding: 'utf8',
      timeout: 30_000,
      env: {
        ...process.env,
        TEST_LOCK_PATH: lockPath,
        TEST_MARKER_PATH: markerPath,
      },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(fs.readFileSync(resultPath, 'utf8')).status, 'PASS');
    assert.equal(fs.readFileSync(markerPath, 'utf8'), 'true');
    const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    assert.equal(lock.phase, 'FINISHED');
    assert.equal(lock.runner.state, 'EXITED');
    assert.equal(lock.child.state, 'EXITED');
    assert.equal(lock.child.groupAlive, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('controlled runner refuses to start a business command without a live parent identity', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-native-runner-parent-'));
  try {
    const transactionId = '77777777-7777-4777-8777-777777777777';
    const lockPath = path.join(root, 'native-task-convergence.lock');
    const jobPath = path.join(root, 'job.json');
    const resultPath = path.join(root, 'result.json');
    const markerPath = path.join(root, 'business-started');
    const parent = { pid: 2_147_483_647, startToken: 'dead-parent-token' };
    fs.writeFileSync(lockPath, `${JSON.stringify({
      schema: LOCK_SCHEMA,
      transactionId,
      hostname: os.hostname(),
      parent,
      runnerToken: 'runner-token',
      phase: 'PARENT_READY',
    })}\n`);
    const businessScript = "import fs from 'node:fs'; fs.writeFileSync(process.env.TEST_MARKER_PATH, 'started');";
    fs.writeFileSync(jobPath, `${JSON.stringify({
      schema: JOB_SCHEMA,
      transactionId,
      lockPath,
      parent,
      runnerToken: 'runner-token',
      command: process.execPath,
      args: ['--input-type=module', '-e', businessScript],
      cwd: root,
      resultPath,
    })}\n`, { mode: 0o600 });

    const result = spawnSync(process.execPath, [RUNNER, '--job', jobPath], {
      cwd: root,
      encoding: 'utf8',
      timeout: 30_000,
      env: { ...process.env, TEST_MARKER_PATH: markerPath },
    });
    assert.equal(result.status, 1);
    assert.equal(JSON.parse(fs.readFileSync(resultPath, 'utf8')).status, 'UNKNOWN');
    assert.equal(fs.existsSync(markerPath), false);
    assert.equal(JSON.parse(fs.readFileSync(lockPath, 'utf8')).phase, 'PARENT_READY');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('runner kills the business process group when its parent is SIGKILLed', async () => {
  if (process.platform === 'win32') return;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-native-runner-sigkill-'));
  let parent;
  try {
    const lockPath = path.join(root, 'native-task-convergence.lock');
    const jobPath = path.join(root, 'job.json');
    const resultPath = path.join(root, 'result.json');
    const parentPidPath = path.join(root, 'parent.pid');
    const childStartedPath = path.join(root, 'child.started');
    const businessMarkerPath = path.join(root, 'business-ran');
    const identityModule = pathToFileURL(path.resolve('cli/lib/process-identity.js')).href;
    const runnerPath = path.resolve('scripts/native-task-convergence-runner.js');
    const driverScript = [
      "import fs from 'node:fs';",
      "import path from 'node:path';",
      "import { spawnSync } from 'node:child_process';",
      `import { captureProcessIdentity } from ${JSON.stringify(identityModule)};`,
      "const root = process.env.TEST_ROOT;",
      "const lockPath = path.join(root, 'native-task-convergence.lock');",
      "const jobPath = path.join(root, 'job.json');",
      "const resultPath = path.join(root, 'result.json');",
      "const parent = captureProcessIdentity();",
      "const transactionId = '44444444-4444-4444-8444-444444444444';",
      "fs.writeFileSync(process.env.TEST_PARENT_PID_PATH, String(process.pid));",
      "fs.writeFileSync(lockPath, JSON.stringify({ schema: 'zylos.native-task-convergence-lock/v1', transactionId, hostname: process.env.TEST_HOSTNAME, parent, runnerToken: 'runner-token', phase: 'PARENT_READY' }));",
      "const businessScript = \"import fs from 'node:fs'; fs.writeFileSync(process.env.TEST_CHILD_STARTED_PATH, String(process.pid)); setTimeout(() => fs.writeFileSync(process.env.TEST_BUSINESS_MARKER_PATH, 'ran'), 5000);\";",
      "fs.writeFileSync(jobPath, JSON.stringify({ schema: 'zylos.native-task-convergence-runner-job/v1', transactionId, lockPath, parent, runnerToken: 'runner-token', command: process.execPath, args: ['--input-type=module', '-e', businessScript], cwd: root, resultPath }));",
      "spawnSync(process.execPath, [process.env.TEST_RUNNER_PATH, '--job', jobPath], { cwd: root, encoding: 'utf8', timeout: 30000 });",
    ].join(' ');
    parent = spawn(process.execPath, ['--input-type=module', '-e', driverScript], {
      cwd: root,
      env: {
        ...process.env,
        TEST_ROOT: root,
        TEST_RUNNER_PATH: runnerPath,
        TEST_PARENT_PID_PATH: parentPidPath,
        TEST_CHILD_STARTED_PATH: childStartedPath,
        TEST_BUSINESS_MARKER_PATH: businessMarkerPath,
        TEST_HOSTNAME: os.hostname(),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const waitFor = async (predicate, timeoutMs = 10_000) => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (predicate()) return;
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      throw new Error('timed out waiting for runner fixture');
    };
    await waitFor(() => fs.existsSync(parentPidPath));
    await waitFor(() => {
      try {
        const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
        return lock.runner?.pid && lock.child?.pid;
      } catch {
        return false;
      }
    });
    const parentClosed = parent.exitCode !== null || parent.signalCode !== null
      ? Promise.resolve()
      : new Promise(resolve => parent.once('close', resolve));
    parent.kill('SIGKILL');
    await waitFor(() => fs.existsSync(resultPath));
    await parentClosed;
    const result = JSON.parse(fs.readFileSync(resultPath, 'utf8'));
    assert.equal(result.status, 'UNKNOWN');
    assert.equal(result.groupAlive, false);
    assert.equal(fs.existsSync(businessMarkerPath), false);
    const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    assert.equal(lock.phase, 'CHILD_EXITED_UNKNOWN');
    assert.equal(lock.runner.state, 'EXITED');
    assert.equal(lock.child.groupAlive, false);
  } finally {
    if (parent && parent.exitCode === null) parent.kill('SIGKILL');
    fs.rmSync(root, { recursive: true, force: true });
  }
});
