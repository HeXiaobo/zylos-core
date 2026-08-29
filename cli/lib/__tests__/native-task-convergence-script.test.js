import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  buildNativeTaskConvergenceCommands,
  runNativeTaskConvergence,
  validateConvergenceManifestPair,
} from '../../../scripts/native-task-convergence.js';
import { captureProcessIdentity } from '../process-identity.js';

function manifests() {
  return {
    core: {
      schema: 'zylos.legacy-task-adoption/v1',
      entries: [{
        idempotencyKey: 'adopt:guid-one',
        externalId: 'guid-one',
        taskId: 'core-one',
        task: { title: 'one', ownerId: 'agent:ss', assigneeId: 'agent:ss' },
      }],
    },
    feishu: {
      schema: 'zylos.feishu-task-v2-legacy-adoption/v1',
      appId: 'cli_ss',
      entries: [{ taskGuid: 'guid-one', coreTaskId: 'core-one', coreTaskVersion: 1 }],
    },
  };
}

function reconciliationReport(consistent = false) {
  return {
    consistent,
    missing: [],
    unexpected: [],
    stateMismatches: [],
    duplicateKeys: [],
    missingLinks: [],
    linkMismatches: [],
    reminderDrifts: [],
    repairs: [],
  };
}

function writeScript(filePath, source) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, source);
}

const CORE_SOURCE_SHA = 'a'.repeat(40);
const FEISHU_SOURCE_SHA = 'b'.repeat(40);

test('manifest pair accepts only an exact GUID/Core id bijection', () => {
  const value = manifests();
  assert.deepEqual(validateConvergenceManifestPair({
    coreManifest: value.core,
    feishuManifest: value.feishu,
  }), {
    ok: true,
    appId: 'cli_ss',
    entries: [{ taskGuid: 'guid-one', coreTaskId: 'core-one' }],
  });

  value.feishu.entries[0].coreTaskId = 'core-other';
  assert.equal(validateConvergenceManifestPair({
    coreManifest: value.core,
    feishuManifest: value.feishu,
  }).ok, false);
});

test('apply command order plans first, then marks remote, commits Core, and repairs status', () => {
  const commands = buildNativeTaskConvergenceCommands({
    nodePath: '/usr/bin/node',
    coreDir: '/opt/core',
    feishuDir: '/opt/feishu',
    coreManifest: '/evidence/core.json',
    feishuManifest: '/evidence/feishu.json',
    apply: true,
  });
  assert.deepEqual(commands.plans.map(step => step.name), [
    'core-plan', 'feishu-plan', 'status-plan',
  ]);
  assert.deepEqual(commands.apply.map(step => step.name), [
    'feishu-apply', 'core-apply', 'status-apply', 'status-verify',
  ]);
  assert.equal(commands.plans.some(step => step.args.includes('--commit')), false);
  assert.equal(commands.plans.some(step => step.args.includes('--repair-status')), false);
  assert.equal(commands.apply[0].args.includes('--commit'), true);
  assert.equal(commands.apply[1].args.includes('--commit'), true);
  assert.equal(commands.apply[2].args.includes('--repair-status'), true);
  assert.equal(commands.apply[3].args.includes('--repair-status'), false);
});

test('public workflow is write-free in plan mode and emits hash-addressed evidence', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-convergence-plan-'));
  try {
    const value = manifests();
    const coreManifest = path.join(root, 'core.json');
    const feishuManifest = path.join(root, 'feishu.json');
    const reportDir = path.join(root, 'report');
    fs.writeFileSync(coreManifest, JSON.stringify(value.core));
    fs.writeFileSync(feishuManifest, JSON.stringify(value.feishu));
    const calls = [];
    const spawn = (_command, args) => {
      calls.push(args);
      const script = args[0];
      if (script.endsWith('legacy-task-adoption.js')) {
        return { status: 0, stdout: JSON.stringify({ failed: 0, mode: 'plan', writes: false }), stderr: '' };
      }
      if (script.endsWith('task-v2-legacy-adoption-bootstrap.js')) {
        return { status: 0, stdout: JSON.stringify({ status: 'PASS', mode: 'plan', writes: false }), stderr: '' };
      }
      return { status: 0, stdout: JSON.stringify(reconciliationReport()), stderr: '' };
    };
    let output = '';
    const report = runNativeTaskConvergence({
      argv: [
        '--plan',
        '--core-manifest', coreManifest,
        '--feishu-manifest', feishuManifest,
        '--core-dir', path.join(root, 'core'),
        '--feishu-dir', path.join(root, 'feishu'),
        '--report-dir', reportDir,
      ],
      spawn,
      stdout: { write(value) { output += value; } },
    });
    assert.equal(report.status, 'PASS');
    assert.equal(report.result, 'PLAN_COMPLETE');
    assert.deepEqual(report.steps.map(step => step.name), [
      'core-plan', 'feishu-plan', 'status-plan',
    ]);
    assert.equal(calls.some(args => args.includes('--commit')), false);
    assert.equal(calls.some(args => args.includes('--repair-status')), false);
    assert.match(report.steps[0].reportSha256, /^[0-9a-f]{64}$/);
    assert.equal(JSON.parse(output).status, 'PASS');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('apply requires authorization and stops before Core mutation when remote apply fails', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-convergence-apply-'));
  try {
    const value = manifests();
    const coreManifest = path.join(root, 'core.json');
    const feishuManifest = path.join(root, 'feishu.json');
    fs.writeFileSync(coreManifest, JSON.stringify(value.core));
    fs.writeFileSync(feishuManifest, JSON.stringify(value.feishu));
    const baseArgs = [
      '--apply',
      '--core-manifest', coreManifest,
      '--feishu-manifest', feishuManifest,
      '--core-dir', path.join(root, 'core'),
      '--feishu-dir', path.join(root, 'feishu'),
      '--report-dir', path.join(root, 'report'),
    ];
    assert.throws(
      () => runNativeTaskConvergence({ argv: baseArgs, stdout: { write() {} } }),
      error => error.code === 'REPAIR_NOT_AUTHORIZED',
    );

    const calls = [];
    const spawn = (_command, args) => {
      const name = args[0];
      calls.push([name, [...args]]);
      if (args.includes('--commit') && name.endsWith('task-v2-legacy-adoption-bootstrap.js')) {
        return { status: 1, stdout: JSON.stringify({ status: 'HOLD' }), stderr: 'remote refused' };
      }
      if (name.endsWith('legacy-task-adoption.js')) {
        return { status: 0, stdout: JSON.stringify({ failed: 0 }), stderr: '' };
      }
      if (name.endsWith('task-v2-legacy-adoption-bootstrap.js')) {
        return { status: 0, stdout: JSON.stringify({ status: 'PASS' }), stderr: '' };
      }
      return { status: 0, stdout: JSON.stringify(reconciliationReport()), stderr: '' };
    };
    const report = runNativeTaskConvergence({
      argv: [...baseArgs, '--authorization', 'owner-issue-25'],
      env: { ZYLOS_DIR: root },
      spawn,
      stdout: { write() {} },
    });
    assert.equal(report.status, 'HOLD');
    assert.equal(report.code, 'CONVERGENCE_STEP_FAILED');
    const coreCommits = calls.filter(([name, args]) => (
      name.endsWith('legacy-task-adoption.js') && args.includes('--commit')
    ));
    assert.equal(coreCommits.length, 0);
    const receipt = JSON.parse(fs.readFileSync(path.join(root, 'report', 'feishu-apply.receipt.json')));
    assert.equal(receipt.status, 'HOLD');
    assert.equal(receipt.transactionId, report.transactionId);
    assert.equal(fs.existsSync(path.join(root, '.zylos', 'locks', 'native-task-convergence.lock')), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('status repair must pass a fresh consistency readback', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-convergence-status-'));
  try {
    const value = manifests();
    const coreManifest = path.join(root, 'core.json');
    const feishuManifest = path.join(root, 'feishu.json');
    const reportDir = path.join(root, 'report');
    fs.writeFileSync(coreManifest, JSON.stringify(value.core));
    fs.writeFileSync(feishuManifest, JSON.stringify(value.feishu));
    const spawn = (_command, args) => {
      const script = args[0];
      if (script.endsWith('legacy-task-adoption.js')) {
        return { status: 0, stdout: JSON.stringify({ failed: 0 }), stderr: '' };
      }
      if (script.endsWith('task-v2-legacy-adoption-bootstrap.js')) {
        return { status: 0, stdout: JSON.stringify({ status: 'PASS' }), stderr: '' };
      }
      return { status: 0, stdout: JSON.stringify(reconciliationReport()), stderr: '' };
    };
    const report = runNativeTaskConvergence({
      argv: [
        '--apply',
        '--authorization', 'owner-issue-25',
        '--core-manifest', coreManifest,
        '--feishu-manifest', feishuManifest,
        '--core-dir', path.join(root, 'core'),
        '--feishu-dir', path.join(root, 'feishu'),
        '--report-dir', reportDir,
      ],
      env: { ZYLOS_DIR: root },
      spawn,
      stdout: { write() {} },
    });
    assert.equal(report.status, 'HOLD');
    assert.equal(report.code, 'CONVERGENCE_STEP_HOLD');
    const receipt = JSON.parse(fs.readFileSync(path.join(reportDir, 'status-verify.receipt.json')));
    assert.equal(receipt.status, 'HOLD');
    assert.match(receipt.error, /not consistent/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('apply runs every business step under the controlled runner and verifies terminal lock state', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-convergence-runner-'));
  try {
    const value = manifests();
    const coreManifest = path.join(root, 'core.json');
    const feishuManifest = path.join(root, 'feishu.json');
    const reportDir = path.join(root, 'report');
    const lockPath = path.join(root, '.zylos', 'locks', 'native-task-convergence.lock');
    const markerPath = path.join(root, 'runner-seen.json');
    fs.writeFileSync(coreManifest, JSON.stringify(value.core));
    fs.writeFileSync(feishuManifest, JSON.stringify(value.feishu));
    const stepSource = `
      import fs from 'node:fs';
      const lock = JSON.parse(fs.readFileSync(process.env.TEST_LOCK_PATH, 'utf8'));
      fs.writeFileSync(process.env.TEST_RUNNER_SEEN_PATH, JSON.stringify({ phase: lock.phase, runner: lock.runner, child: lock.child }));
      console.log(JSON.stringify({ failed: 0, status: 'PASS', consistent: true, missing: [], unexpected: [], stateMismatches: [], duplicateKeys: [], missingLinks: [], linkMismatches: [], reminderDrifts: [], repairs: [] }));
    `;
    writeScript(path.join(root, 'core', 'skills', 'commitment-core', 'scripts', 'legacy-task-adoption.js'), stepSource);
    writeScript(path.join(root, 'feishu', 'scripts', 'task-v2-legacy-adoption-bootstrap.js'), stepSource);
    writeScript(path.join(root, 'feishu', 'src', 'lib', 'task-v2-projection-worker.js'), stepSource);
    const report = runNativeTaskConvergence({
      argv: [
        '--apply',
        '--authorization', 'owner-issue-25',
        '--core-manifest', coreManifest,
        '--feishu-manifest', feishuManifest,
        '--core-dir', path.join(root, 'core'),
        '--feishu-dir', path.join(root, 'feishu'),
        '--report-dir', reportDir,
      ],
      env: {
        ...process.env,
        ZYLOS_DIR: root,
        TEST_LOCK_PATH: lockPath,
        TEST_RUNNER_SEEN_PATH: markerPath,
        TEST_PRIVATE_CREDENTIAL: 'must-not-be-persisted',
      },
      stdout: { write() {} },
    });
    assert.equal(report.status, 'PASS');
    assert.equal(fs.existsSync(lockPath), false);
    assert.equal(fs.readdirSync(reportDir).some(name => name.endsWith('.runner-result.json')), true);
    const runnerJob = fs.readFileSync(
      path.join(reportDir, '.core-plan.attempt-1.runner-job.json'),
      'utf8',
    );
    assert.doesNotMatch(runnerJob, /TEST_PRIVATE_CREDENTIAL|must-not-be-persisted/);
    const marker = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
    assert.equal(marker.phase, 'CHILD_RUNNING');
    assert.ok(marker.runner?.pid > 0);
    assert.ok(marker.runner?.startToken);
    assert.equal(marker.runner.state, 'READY');
    assert.ok(marker.child?.pid > 0);
    assert.ok(marker.child?.startToken);
    assert.equal(marker.child.state, 'RUNNING');
    assert.equal(marker.child.groupAlive, true);
    const terminal = JSON.parse(fs.readFileSync(
      path.join(reportDir, '.core-plan.attempt-1.runner-result.json'),
      'utf8',
    ));
    assert.equal(terminal.runner.state, 'EXITED');
    assert.equal(terminal.child.state, 'EXITED');
    assert.equal(terminal.child.groupAlive, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a RUNNING step receipt resumes with readback plans and idempotent replay', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-convergence-resume-'));
  try {
    const value = manifests();
    const coreManifest = path.join(root, 'core.json');
    const feishuManifest = path.join(root, 'feishu.json');
    const reportDir = path.join(root, 'report');
    fs.writeFileSync(coreManifest, JSON.stringify(value.core));
    fs.writeFileSync(feishuManifest, JSON.stringify(value.feishu));
    const argv = [
      '--apply',
      '--authorization', 'owner-issue-25',
      '--core-manifest', coreManifest,
      '--feishu-manifest', feishuManifest,
      '--core-dir', path.join(root, 'core'),
      '--feishu-dir', path.join(root, 'feishu'),
      '--report-dir', reportDir,
    ];
    let firstFeishuApply = true;
    const interruptedSpawn = (_command, args) => {
      const script = args[0];
      if (args.includes('--commit') && script.endsWith('task-v2-legacy-adoption-bootstrap.js') && firstFeishuApply) {
        firstFeishuApply = false;
        throw new Error('simulated process interruption');
      }
      if (script.endsWith('legacy-task-adoption.js')) return { status: 0, stdout: JSON.stringify({ failed: 0 }), stderr: '' };
      if (script.endsWith('task-v2-legacy-adoption-bootstrap.js')) return { status: 0, stdout: JSON.stringify({ status: 'PASS' }), stderr: '' };
      return { status: 0, stdout: JSON.stringify(reconciliationReport()), stderr: '' };
    };
    const first = runNativeTaskConvergence({
      argv,
      env: { ZYLOS_DIR: root },
      spawn: interruptedSpawn,
      stdout: { write() {} },
    });
    assert.equal(first.status, 'HOLD');
    assert.equal(JSON.parse(fs.readFileSync(path.join(reportDir, 'feishu-apply.receipt.json'))).status, 'RUNNING');

    const calls = [];
    let statusReadCount = 0;
    const replaySpawn = (_command, args) => {
      calls.push([...args]);
      const script = args[0];
      if (script.endsWith('legacy-task-adoption.js')) return { status: 0, stdout: JSON.stringify({ failed: 0 }), stderr: '' };
      if (script.endsWith('task-v2-legacy-adoption-bootstrap.js')) return { status: 0, stdout: JSON.stringify({ status: 'PASS' }), stderr: '' };
      statusReadCount += 1;
      return { status: 0, stdout: JSON.stringify(reconciliationReport(statusReadCount >= 3)), stderr: '' };
    };
    const resumed = runNativeTaskConvergence({
      argv,
      env: { ZYLOS_DIR: root },
      spawn: replaySpawn,
      stdout: { write() {} },
    });
    assert.equal(resumed.status, 'PASS');
    assert.equal(resumed.transactionId, first.transactionId);
    assert.equal(resumed.attempt, 2);
    assert.deepEqual(resumed.steps.slice(0, 3).map(step => step.name), [
      'core-plan', 'feishu-plan', 'status-plan',
    ]);
    assert.equal(calls.some(args => args.includes('--commit')), true);
    const receipt = JSON.parse(fs.readFileSync(path.join(reportDir, 'feishu-apply.receipt.json')));
    assert.equal(receipt.status, 'PASS');
    assert.equal(receipt.attempt, 2);
    const interruptedReceipt = JSON.parse(fs.readFileSync(path.join(reportDir, 'feishu-apply.attempt-1.receipt.json')));
    const replayReceipt = JSON.parse(fs.readFileSync(path.join(reportDir, 'feishu-apply.attempt-2.receipt.json')));
    assert.equal(interruptedReceipt.status, 'RUNNING');
    assert.equal(interruptedReceipt.attempt, 1);
    assert.equal(replayReceipt.status, 'PASS');
    assert.equal(replayReceipt.attempt, 2);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a live repair transaction lock blocks concurrent apply', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-convergence-lock-'));
  try {
    const value = manifests();
    const coreManifest = path.join(root, 'core.json');
    const feishuManifest = path.join(root, 'feishu.json');
    const reportDir = path.join(root, 'report');
    const lockDir = path.join(root, '.zylos', 'locks');
    fs.mkdirSync(lockDir, { recursive: true });
    fs.writeFileSync(coreManifest, JSON.stringify(value.core));
    fs.writeFileSync(feishuManifest, JSON.stringify(value.feishu));
    fs.writeFileSync(path.join(lockDir, 'native-task-convergence.lock'), JSON.stringify({
      schema: 'zylos.native-task-convergence-lock/v1',
      transactionId: '11111111-1111-4111-8111-111111111111',
      hostname: os.hostname(),
      pid: process.pid,
      parent: captureProcessIdentity(),
      runnerToken: 'live-runner-token',
      phase: 'PARENT_READY',
      runner: null,
      child: null,
      acquiredAt: new Date().toISOString(),
    }));
    assert.throws(
      () => runNativeTaskConvergence({
        argv: [
          '--apply',
          '--authorization', 'owner-issue-25',
          '--core-manifest', coreManifest,
          '--feishu-manifest', feishuManifest,
          '--core-dir', path.join(root, 'core'),
          '--feishu-dir', path.join(root, 'feishu'),
          '--report-dir', reportDir,
        ],
        env: { ZYLOS_DIR: root },
        stdout: { write() {} },
      }),
      error => error.code === 'LOCK_HELD',
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('an active stale lock without a persisted child fails closed for safe recovery', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-convergence-recovery-lock-'));
  try {
    const value = manifests();
    const coreManifest = path.join(root, 'core.json');
    const feishuManifest = path.join(root, 'feishu.json');
    const reportDir = path.join(root, 'report');
    const lockDir = path.join(root, '.zylos', 'locks');
    const staleTransactionId = '55555555-5555-4555-8555-555555555555';
    fs.mkdirSync(lockDir, { recursive: true });
    fs.writeFileSync(coreManifest, JSON.stringify(value.core));
    fs.writeFileSync(feishuManifest, JSON.stringify(value.feishu));
    fs.writeFileSync(path.join(lockDir, 'native-task-convergence.lock'), JSON.stringify({
      schema: 'zylos.native-task-convergence-lock/v1',
      transactionId: staleTransactionId,
      hostname: os.hostname(),
      pid: 2_147_483_647,
      parent: { pid: 2_147_483_647, startToken: 'dead-parent-token' },
      runnerToken: 'stale-runner-token',
      phase: 'CHILD_RUNNING',
      runner: { pid: 2_147_483_646, startToken: 'dead-runner-token' },
      child: null,
      acquiredAt: new Date(0).toISOString(),
    }));
    assert.throws(
      () => runNativeTaskConvergence({
        argv: [
          '--apply',
          '--authorization', 'owner-issue-25',
          '--core-manifest', coreManifest,
          '--feishu-manifest', feishuManifest,
          '--core-dir', path.join(root, 'core'),
          '--feishu-dir', path.join(root, 'feishu'),
          '--report-dir', reportDir,
        ],
        env: { ZYLOS_DIR: root },
        stdout: { write() {} },
      }),
      error => error.code === 'LOCK_RECOVERY_REQUIRED',
    );
    assert.equal(fs.existsSync(path.join(lockDir, 'native-task-convergence.lock')), true);
    assert.equal(fs.readdirSync(lockDir).some(name => name.includes('.stale.')), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a terminal UNKNOWN lock is reclaimable only after runner, child, and group are proven dead', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-convergence-unknown-recovery-'));
  try {
    const value = manifests();
    const coreManifest = path.join(root, 'core.json');
    const feishuManifest = path.join(root, 'feishu.json');
    const reportDir = path.join(root, 'report');
    const lockDir = path.join(root, '.zylos', 'locks');
    const staleTransactionId = '66666666-6666-4666-8666-666666666666';
    fs.mkdirSync(lockDir, { recursive: true });
    fs.writeFileSync(coreManifest, JSON.stringify(value.core));
    fs.writeFileSync(feishuManifest, JSON.stringify(value.feishu));
    fs.writeFileSync(path.join(lockDir, 'native-task-convergence.lock'), JSON.stringify({
      schema: 'zylos.native-task-convergence-lock/v1',
      transactionId: staleTransactionId,
      hostname: os.hostname(),
      pid: 2_147_483_647,
      parent: { pid: 2_147_483_647, startToken: 'dead-parent-token' },
      runnerToken: 'stale-runner-token',
      phase: 'CHILD_EXITED_UNKNOWN',
      runner: { pid: 2_147_483_646, startToken: 'dead-runner-token', state: 'EXITED' },
      child: {
        pid: 2_147_483_645,
        startToken: 'dead-child-token',
        pgid: 2_147_483_645,
        state: 'UNKNOWN',
        groupAlive: null,
      },
      acquiredAt: new Date(0).toISOString(),
    }));
    const spawn = (_command, args) => {
      const script = args[0];
      if (script.endsWith('legacy-task-adoption.js')) return { status: 0, stdout: JSON.stringify({ failed: 0 }), stderr: '' };
      if (script.endsWith('task-v2-legacy-adoption-bootstrap.js')) return { status: 0, stdout: JSON.stringify({ status: 'PASS' }), stderr: '' };
      return { status: 0, stdout: JSON.stringify(reconciliationReport(true)), stderr: '' };
    };
    const report = runNativeTaskConvergence({
      argv: [
        '--apply',
        '--authorization', 'owner-issue-25',
        '--core-manifest', coreManifest,
        '--feishu-manifest', feishuManifest,
        '--core-dir', path.join(root, 'core'),
        '--feishu-dir', path.join(root, 'feishu'),
        '--report-dir', reportDir,
      ],
      env: { ZYLOS_DIR: root },
      spawn,
      stdout: { write() {} },
    });
    assert.equal(report.status, 'PASS');
    assert.equal(fs.existsSync(path.join(lockDir, 'native-task-convergence.lock')), false);
    assert.equal(fs.readdirSync(lockDir).some(name => (
      name.startsWith(`native-task-convergence.lock.stale.${staleTransactionId}.`)
    )), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a dead local lock is retained as stale evidence before safe resume', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-convergence-stale-lock-'));
  try {
    const value = manifests();
    const coreManifest = path.join(root, 'core.json');
    const feishuManifest = path.join(root, 'feishu.json');
    const reportDir = path.join(root, 'report');
    const lockDir = path.join(root, '.zylos', 'locks');
    const staleTransactionId = '22222222-2222-4222-8222-222222222222';
    fs.mkdirSync(lockDir, { recursive: true });
    fs.writeFileSync(coreManifest, JSON.stringify(value.core));
    fs.writeFileSync(feishuManifest, JSON.stringify(value.feishu));
    fs.writeFileSync(path.join(lockDir, 'native-task-convergence.lock'), JSON.stringify({
      schema: 'zylos.native-task-convergence-lock/v1',
      transactionId: staleTransactionId,
      hostname: os.hostname(),
      pid: 2_147_483_647,
      parent: { pid: 2_147_483_647, startToken: 'dead-parent-token' },
      runnerToken: 'stale-runner-token',
      phase: 'PARENT_READY',
      runner: null,
      child: null,
      acquiredAt: new Date(0).toISOString(),
    }));
    const spawn = (_command, args) => {
      const script = args[0];
      if (script.endsWith('legacy-task-adoption.js')) return { status: 0, stdout: JSON.stringify({ failed: 0 }), stderr: '' };
      if (script.endsWith('task-v2-legacy-adoption-bootstrap.js')) return { status: 0, stdout: JSON.stringify({ status: 'PASS' }), stderr: '' };
      return { status: 0, stdout: JSON.stringify(reconciliationReport(true)), stderr: '' };
    };
    const report = runNativeTaskConvergence({
      argv: [
        '--apply',
        '--authorization', 'owner-issue-25',
        '--core-manifest', coreManifest,
        '--feishu-manifest', feishuManifest,
        '--core-dir', path.join(root, 'core'),
        '--feishu-dir', path.join(root, 'feishu'),
        '--report-dir', reportDir,
      ],
      env: { ZYLOS_DIR: root },
      spawn,
      stdout: { write() {} },
    });
    assert.equal(report.status, 'PASS');
    assert.equal(fs.existsSync(path.join(lockDir, 'native-task-convergence.lock')), false);
    assert.equal(fs.readdirSync(lockDir).some(name => (
      name.startsWith(`native-task-convergence.lock.stale.${staleTransactionId}.`)
    )), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function sourceBoundArgs({
  root,
  coreDir,
  feishuDir,
  reportDir,
  transactionId = '33333333-3333-4333-8333-333333333333',
} = {}) {
  const value = manifests();
  const coreManifest = path.join(root, 'core.json');
  const feishuManifest = path.join(root, 'feishu.json');
  fs.writeFileSync(coreManifest, JSON.stringify(value.core));
  fs.writeFileSync(feishuManifest, JSON.stringify(value.feishu));
  return [
    '--apply',
    '--core-manifest', coreManifest,
    '--feishu-manifest', feishuManifest,
    '--core-dir', coreDir,
    '--feishu-dir', feishuDir,
    '--report-dir', reportDir,
    '--authorization', 'owner-issue-25',
    '--transaction-id', transactionId,
    '--core-source-repo', 'HeXiaobo/zylos-core',
    '--core-source-commit', CORE_SOURCE_SHA,
    '--core-source-version', '0.7.2-rc.16',
    '--feishu-source-repo', 'HeXiaobo/zylos-feishu',
    '--feishu-source-commit', FEISHU_SOURCE_SHA,
    '--feishu-source-version', '0.3.7-rc.8',
  ];
}

function sourceBoundSpawn(_command, args) {
  const script = args[0];
  if (script.endsWith('legacy-task-adoption.js')) {
    return { status: 0, stdout: JSON.stringify({ failed: 0 }), stderr: '' };
  }
  if (script.endsWith('task-v2-legacy-adoption-bootstrap.js')) {
    return { status: 0, stdout: JSON.stringify({ status: 'PASS' }), stderr: '' };
  }
  return { status: 0, stdout: JSON.stringify(reconciliationReport(true)), stderr: '' };
}

test('source-bound resume rejects a changed source directory before spawning work', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-convergence-source-binding-'));
  try {
    const coreDir = path.join(root, 'core');
    const feishuDir = path.join(root, 'feishu');
    const reportDir = path.join(root, 'report');
    fs.mkdirSync(coreDir);
    fs.mkdirSync(feishuDir);
    const args = sourceBoundArgs({ root, coreDir, feishuDir, reportDir });
    const first = runNativeTaskConvergence({
      argv: args,
      env: { ZYLOS_DIR: root },
      spawn: sourceBoundSpawn,
      stdout: { write() {} },
    });
    assert.equal(first.status, 'PASS');
    assert.equal(first.sources.core.dir, path.resolve(coreDir));
    assert.equal(first.sources.feishu.dir, path.resolve(feishuDir));
    assert.ok(first.steps.every(step => step.commandIdentity?.sha256));
    const receipt = JSON.parse(fs.readFileSync(path.join(reportDir, 'receipts', 'core-plan.json'), 'utf8'));
    assert.equal(receipt.transactionId, first.transactionId);
    assert.deepEqual(receipt.sources, first.sources);

    const changedCoreDir = path.join(root, 'different-core');
    fs.mkdirSync(changedCoreDir);
    const changedArgs = [...args];
    changedArgs[changedArgs.indexOf('--core-dir') + 1] = changedCoreDir;
    let resumedCalls = 0;
    const resumed = runNativeTaskConvergence({
      argv: [...changedArgs, '--resume'],
      env: { ZYLOS_DIR: root },
      spawn() {
        resumedCalls += 1;
        return sourceBoundSpawn(...arguments);
      },
      stdout: { write() {} },
    });
    assert.equal(resumed.status, 'HOLD');
    assert.equal(resumed.code, 'SOURCE_BINDING_MISMATCH');
    assert.equal(resumedCalls, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('source-bound resume rejects a tampered canonical receipt command identity', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-convergence-receipt-binding-'));
  try {
    const coreDir = path.join(root, 'core');
    const feishuDir = path.join(root, 'feishu');
    const reportDir = path.join(root, 'report');
    fs.mkdirSync(coreDir);
    fs.mkdirSync(feishuDir);
    const args = sourceBoundArgs({
      root,
      coreDir,
      feishuDir,
      reportDir,
      transactionId: '44444444-4444-4444-8444-444444444444',
    });
    assert.equal(runNativeTaskConvergence({
      argv: args,
      env: { ZYLOS_DIR: root },
      spawn: sourceBoundSpawn,
      stdout: { write() {} },
    }).status, 'PASS');
    const receiptPath = path.join(reportDir, 'receipts', 'core-plan.json');
    const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
    receipt.commandIdentity.args = ['/tmp/attacker.js'];
    fs.writeFileSync(receiptPath, `${JSON.stringify(receipt)}\n`);
    const resumed = runNativeTaskConvergence({
      argv: [...args, '--resume'],
      env: { ZYLOS_DIR: root },
      spawn() {
        throw new Error('spawn must not run after receipt identity failure');
      },
      stdout: { write() {} },
    });
    assert.equal(resumed.status, 'HOLD');
    assert.equal(resumed.code, 'SOURCE_BINDING_MISMATCH');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('source-bound resume rejects a staged source tree changed behind the same path', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-convergence-tree-binding-'));
  try {
    const coreDir = path.join(root, 'core');
    const feishuDir = path.join(root, 'feishu');
    const reportDir = path.join(root, 'report');
    fs.mkdirSync(coreDir);
    fs.mkdirSync(feishuDir);
    fs.writeFileSync(path.join(coreDir, 'source.js'), 'original\n');
    fs.writeFileSync(path.join(feishuDir, 'source.js'), 'original\n');
    const args = sourceBoundArgs({
      root,
      coreDir,
      feishuDir,
      reportDir,
      transactionId: '55555555-5555-4555-8555-555555555555',
    });
    assert.equal(runNativeTaskConvergence({
      argv: args,
      env: { ZYLOS_DIR: root },
      spawn: sourceBoundSpawn,
      stdout: { write() {} },
    }).status, 'PASS');
    fs.writeFileSync(path.join(coreDir, 'source.js'), 'tampered\n');
    const resumed = runNativeTaskConvergence({
      argv: [...args, '--resume'],
      env: { ZYLOS_DIR: root },
      spawn() {
        throw new Error('spawn must not run after source tree tampering');
      },
      stdout: { write() {} },
    });
    assert.equal(resumed.status, 'HOLD');
    assert.equal(resumed.code, 'SOURCE_BINDING_MISMATCH');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('source-bound resume reopens the same failed transaction and appends canonical history', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-convergence-source-resume-'));
  try {
    const coreDir = path.join(root, 'core');
    const feishuDir = path.join(root, 'feishu');
    const reportDir = path.join(root, 'report');
    fs.mkdirSync(coreDir);
    fs.mkdirSync(feishuDir);
    const args = sourceBoundArgs({
      root,
      coreDir,
      feishuDir,
      reportDir,
      transactionId: '66666666-6666-4666-8666-666666666666',
    });
    let failRemote = true;
    const spawn = (_command, stepArgs) => {
      const script = stepArgs[0];
      if (failRemote && stepArgs.includes('--commit') && script.endsWith('task-v2-legacy-adoption-bootstrap.js')) {
        return { status: 1, stdout: JSON.stringify({ status: 'HOLD' }), stderr: 'remote failure' };
      }
      return sourceBoundSpawn(_command, stepArgs);
    };
    const failed = runNativeTaskConvergence({
      argv: args,
      env: { ZYLOS_DIR: root },
      spawn,
      stdout: { write() {} },
    });
    assert.equal(failed.status, 'HOLD');
    assert.equal(failed.transactionId, '66666666-6666-4666-8666-666666666666');
    const before = JSON.parse(fs.readFileSync(path.join(reportDir, 'receipts', 'core-plan.json'), 'utf8'));
    assert.equal(before.state, 'pass');
    failRemote = false;
    const resumed = runNativeTaskConvergence({
      argv: [...args, '--resume'],
      env: { ZYLOS_DIR: root },
      spawn,
      stdout: { write() {} },
    });
    assert.equal(resumed.status, 'PASS');
    assert.equal(resumed.transactionId, failed.transactionId);
    assert.equal(resumed.resumeCount, 1);
    const after = JSON.parse(fs.readFileSync(path.join(reportDir, 'receipts', 'core-plan.json'), 'utf8'));
    assert.equal(after.attempt, 2);
    assert.equal(after.history.filter(item => item.state === 'attempted').length, 2);
    assert.equal(after.sources.core.commit, CORE_SOURCE_SHA);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
