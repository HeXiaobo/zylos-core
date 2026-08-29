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
    'feishu-apply', 'core-apply', 'status-apply',
  ]);
  assert.equal(commands.plans.some(step => step.args.includes('--commit')), false);
  assert.equal(commands.plans.some(step => step.args.includes('--repair-status')), false);
  assert.equal(commands.apply[0].args.includes('--commit'), true);
  assert.equal(commands.apply[1].args.includes('--commit'), true);
  assert.equal(commands.apply[2].args.includes('--repair-status'), true);
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
      return { status: 0, stdout: JSON.stringify({ consistent: false, repairs: [] }), stderr: '' };
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
      return { status: 0, stdout: JSON.stringify({ consistent: false, repairs: [] }), stderr: '' };
    };
    const report = runNativeTaskConvergence({
      argv: [...baseArgs, '--authorization', 'owner-issue-25'],
      spawn,
      stdout: { write() {} },
    });
    assert.equal(report.status, 'HOLD');
    assert.equal(report.code, 'CONVERGENCE_STEP_FAILED');
    const coreCommits = calls.filter(([name, args]) => (
      name.endsWith('legacy-task-adoption.js') && args.includes('--commit')
    ));
    assert.equal(coreCommits.length, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
