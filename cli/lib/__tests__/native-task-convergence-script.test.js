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
      pid: process.pid,
      hostname: os.hostname(),
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
      pid: 2_147_483_647,
      hostname: os.hostname(),
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
