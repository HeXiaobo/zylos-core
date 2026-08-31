import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import {
  buildUpgradeCommands,
  buildNativeTaskConservationCommand,
  buildNativeTaskConservationEnv,
  buildNativeTaskConvergenceCommand,
  executeCoreBackupRetention,
  ensureCommitmentCoreRuntimeDependencies,
  repairCoreBackupQuarantine,
  repairCoreBackupRetention,
  preparePersistentStagedSources,
  validatePairResumeSummary,
  planCoreBackupRetention,
  planPm2PreflightRepairs,
  pathsReferToSameFile as upgradePathsReferToSameFile,
  parseForkPairArgs,
  validateCoreSource,
  validateFeishuSource,
  validateNativeTaskDeploymentIdentity,
  validatePm2Snapshot,
  validatePinnedTarget,
  validateRetentionRepairAuthorization,
} from '../../../scripts/upgrade-fork-pair.js';
import {
  buildHxaProbeCommands,
  pathsReferToSameFile as hxaPathsReferToSameFile,
  validateHxaPm2Process,
  validateHxaRegistryEntry,
  validateHxaSource,
  validatePinnedHxaRecoveryTarget,
} from '../../../scripts/restore-hxa-connect.js';
import {
  SS_BLOCKER_TARGETS,
  pathsReferToSameFile as blockerPathsReferToSameFile,
  validatePinnedBlockerRecoveryTarget,
  validateRequiredComponentPm2,
  validateRequiredComponentRegistry,
  validateRequiredComponentSource,
} from '../../../scripts/restore-ss-upgrade-blockers.js';

const CORE_SHA = '0123456789abcdef0123456789abcdef01234567';
const FEISHU_SHA = '89abcdef0123456789abcdef0123456789abcdef';

function writeCoreFixture(root) {
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({
    name: 'zylos',
    version: '0.7.2-rc.5',
  }));
  fs.writeFileSync(path.join(root, 'capabilities.json'), JSON.stringify({
    schemaVersion: 1,
    product: 'zylos-core',
    release: '0.7.2-rc.5',
    protocols: {
      'c4.reply': 2,
      'c4.reply.argv-compat': 1,
      'c4.reply.body-file': 1,
      'c4.assistant-response-stream': 3,
      'c4.outbound-delivery-id': 1,
      'work-intake': 1,
      'commitment-core': 1,
      'projection-outbox': 1,
      'external-task-adapter': 1,
      'native-task-conservation-inventory': 1,
      'task-reminder': 1,
    },
  }));
  for (const relativePath of [
    'skills/comm-bridge/scripts/c4-send.js',
    'skills/comm-bridge/scripts/c4-outbound-policy.js',
    'skills/comm-bridge/scripts/c4-receive.js',
    'skills/comm-bridge/scripts/c4-dispatcher.js',
    'skills/comm-bridge/scripts/c4-response-stream-supervisor.js',
    'skills/activity-monitor/scripts/assistant-turn-binding.js',
    'scripts/upgrade-fork-pair.js',
    'scripts/upgrade-fork-pair.sh',
    'scripts/native-task-convergence.js',
    'scripts/native-task-convergence-runner.js',
    'cli/lib/native-task-conservation-inventory.js',
    'skills/commitment-core/scripts/legacy-task-adoption.js',
  ]) {
    const filePath = path.join(root, relativePath);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, '#!/usr/bin/env node\n');
  }
}

function writeFeishuFixture(root) {
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({
    name: 'zylos-feishu',
    version: '0.3.7-rc.5',
  }));
  fs.writeFileSync(path.join(root, 'capabilities.json'), JSON.stringify({
    schemaVersion: 1,
    product: 'zylos-feishu',
    release: '0.3.7-rc.5',
    provides: {
      'feishu.native-task-conservation-gate': 1,
    },
    requires: {
      'zylos-core': {
        protocols: {
          'c4.reply': 2,
          'c4.reply.argv-compat': 1,
          'c4.assistant-response-stream': 3,
          'c4.outbound-delivery-id': 1,
          'work-intake': 1,
          'commitment-core': 1,
          'projection-outbox': 1,
          'external-task-adapter': 1,
          'native-task-conservation-inventory': 1,
          'task-reminder': 1,
        },
      },
    },
  }));
  for (const relativePath of [
    'src/index.js',
    'hooks/pre-upgrade.js',
    'hooks/post-upgrade.js',
    'scripts/native-task-closure-gate.js',
    'scripts/native-task-completion-gate.js',
    'scripts/native-task-conservation-gate.js',
    'scripts/task-v2-legacy-adoption-bootstrap.js',
    'src/lib/native-task-conservation-gate.js',
    'src/lib/native-task-conservation-remote.js',
    'src/lib/task-v2-legacy-adoption-bootstrap.js',
    'src/lib/task-v2-deployment-identity.js',
    'src/lib/task-v2-projection-worker.js',
    'src/lib/task-comment-worker.js',
    'src/lib/task-v2-projection.js',
  ]) {
    const filePath = path.join(root, relativePath);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, '#!/usr/bin/env node\n');
  }
}

describe('fork-pair upgrade target contract', () => {
  it('recognizes a bootstrap entrypoint reached through a filesystem path alias', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-main-module-alias-'));
    try {
      const realDir = path.join(root, 'real');
      const aliasDir = path.join(root, 'alias');
      fs.mkdirSync(realDir);
      fs.writeFileSync(path.join(realDir, 'entry.js'), '#!/usr/bin/env node\n');
      fs.symlinkSync(realDir, aliasDir);
      const realPath = path.join(realDir, 'entry.js');
      const aliasPath = path.join(aliasDir, 'entry.js');

      assert.equal(upgradePathsReferToSameFile(aliasPath, realPath), true);
      assert.equal(hxaPathsReferToSameFile(aliasPath, realPath), true);
      assert.equal(blockerPathsReferToSameFile(aliasPath, realPath), true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  function writeCoreBackup(root, name, version, mtimeMs) {
    const backupDir = path.join(root, name);
    fs.mkdirSync(path.join(backupDir, 'core-package'), { recursive: true });
    fs.mkdirSync(path.join(backupDir, 'skills'), { recursive: true });
    fs.writeFileSync(path.join(backupDir, 'core-package', 'package.json'), JSON.stringify({
      name: 'zylos',
      version,
    }));
    const instant = new Date(mtimeMs);
    fs.utimesSync(backupDir, instant, instant);
    return backupDir;
  }

  function verifiedPairSummary(backupDir, summaryPath, {
    startedAt = '2026-08-27T00:00:00.000Z',
    finishedAt = '2026-08-27T00:01:00.000Z',
    coreVersion = '0.7.2-rc.11',
    coreSha = 'a'.repeat(40),
  } = {}) {
    return {
      schema: 'zylos.fork-pair-upgrade/v1',
      status: 'PASS',
      result: 'UPGRADE_COMPLETE',
      startedAt,
      finishedAt,
      reportDir: path.dirname(summaryPath),
      coreUpgraded: true,
      feishuUpgraded: true,
      target: {
        core: { repo: 'HeXiaobo/zylos-core', sha: coreSha, version: coreVersion },
        feishu: { repo: 'HeXiaobo/zylos-feishu', sha: 'b'.repeat(40), version: '0.3.2-rc.5' },
      },
      coreResult: { backupDir },
      postcheck: { status: 'PASS', coreVersion },
    };
  }

  function runVerifiedRetention(root, backupDir, sequence, fsApi = fs, retain = 2) {
    const reportDir = path.join(root, `report-${sequence}`);
    fs.mkdirSync(reportDir, { recursive: true });
    const summaryPath = path.join(reportDir, 'summary.json');
    const minute = String(sequence).padStart(2, '0');
    const summary = verifiedPairSummary(backupDir, summaryPath, {
      startedAt: `2026-08-27T00:${minute}:00.000Z`,
      finishedAt: `2026-08-27T00:${minute}:30.000Z`,
      coreSha: sequence.toString(16).padStart(40, '0'),
    });
    return executeCoreBackupRetention({
      currentBackupDir: backupDir,
      tmpDir: root,
      homeDir: path.join(root, 'home'),
      summary,
      summaryPath,
      fsApi,
      retain,
    });
  }

  function retentionRepairAuthorization(quarantinePath) {
    return {
      schema: 'zylos.owner-authorization/v1',
      status: 'PASS',
      identity: 'user',
      deploymentAuthorized: true,
      retentionAuthorization: {
        approvedDeletePaths: [quarantinePath],
        mustMatchExactly: true,
        authorizedBy: 'user',
      },
    };
  }

  it('accepts a complete pinned Core source fixture', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-upgrade-source-'));
    try {
      writeCoreFixture(root);

      assert.equal(validateCoreSource(root, '0.7.2-rc.5').ok, true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('accepts only immutable full commit SHAs and exact expected versions', () => {
    assert.deepEqual(validatePinnedTarget({
      coreSha: CORE_SHA,
      feishuSha: FEISHU_SHA,
      coreVersion: '0.7.2-rc.5',
      feishuVersion: '0.3.7-rc.5',
      agent: 'ss',
    }), { ok: true });

    const branch = validatePinnedTarget({
      coreSha: 'codex/native-task-upgrade-closure',
      feishuSha: FEISHU_SHA,
      coreVersion: '0.7.2-rc.5',
      feishuVersion: '0.3.7-rc.5',
      agent: 'ss',
    });
    assert.equal(branch.ok, false);
    assert.match(branch.error, /core SHA/);

    const missingAgent = validatePinnedTarget({
      coreSha: CORE_SHA,
      feishuSha: FEISHU_SHA,
      coreVersion: '0.7.2-rc.5',
      feishuVersion: '0.3.7-rc.5',
    });
    assert.equal(missingAgent.ok, false);
    assert.match(missingAgent.error, /agent identity/);
  });

  it('requires explicit manifests and authorization for a repair-only transaction', () => {
    const common = [
      '--core-sha', CORE_SHA,
      '--feishu-sha', FEISHU_SHA,
      '--core-version', '0.7.2-rc.5',
      '--feishu-version', '0.3.7-rc.5',
      '--staged-core', '/tmp/core',
      '--agent', 'ss',
    ];
    assert.throws(
      () => parseForkPairArgs(['--repair-only', ...common]),
      error => error.code === 'INVALID_ARGS' && /requires both/.test(error.message),
    );
    assert.throws(
      () => parseForkPairArgs([
        '--repair-only', ...common,
        '--native-task-core-manifest', '/evidence/core.json',
        '--native-task-feishu-manifest', '/evidence/feishu.json',
      ]),
      error => error.code === 'REPAIR_NOT_AUTHORIZED',
    );
    const parsed = parseForkPairArgs([
      '--repair-only', ...common,
      '--native-task-core-manifest', '/evidence/core.json',
      '--native-task-feishu-manifest', '/evidence/feishu.json',
      '--native-task-repair-authorization', 'owner-issue-25',
    ]);
    assert.equal(parsed.repairOnly, true);
    assert.equal(parsed.execute, false);
    assert.equal(parsed.nativeTaskRepairAuthorization, 'owner-issue-25');
  });

  it('binds the requested Agent, WorkIntake assignee, and Feishu App mapping', () => {
    assert.deepEqual(validateNativeTaskDeploymentIdentity({
      requestedAgent: 'yueran',
      agentId: 'agent:yueran',
      defaultAssigneeId: 'agent:yueran',
      appId: 'cli_yueran',
      agentAppIds: '{"agent:yueran":"cli_yueran"}',
    }), {
      ok: true,
      identity: {
        agentId: 'agent:yueran',
        appId: 'cli_yueran',
        mappingSource: 'explicit',
      },
    });

    assert.deepEqual(validateNativeTaskDeploymentIdentity({
      requestedAgent: 'veda',
      agentId: 'agent:veda',
      defaultAssigneeId: 'agent:veda',
      appId: 'cli_veda',
      agentAppIds: undefined,
    }), {
      ok: true,
      identity: {
        agentId: 'agent:veda',
        appId: 'cli_veda',
        mappingSource: 'derived-single-agent',
      },
    });

    assert.equal(validateNativeTaskDeploymentIdentity({
      requestedAgent: 'ss',
      agentId: 'agent:yueran',
      appId: 'cli_yueran',
      agentAppIds: { 'agent:yueran': 'cli_yueran' },
    }).ok, false);
    assert.equal(validateNativeTaskDeploymentIdentity({
      requestedAgent: 'yueran',
      agentId: 'agent:yueran',
      defaultAssigneeId: 'agent:ss',
      appId: 'cli_yueran',
      agentAppIds: { 'agent:yueran': 'cli_yueran' },
    }).ok, false);
    assert.equal(validateNativeTaskDeploymentIdentity({
      requestedAgent: 'yueran',
      agentId: 'agent:yueran',
      appId: 'cli_yueran',
      agentAppIds: { 'agent:yueran': 'cli_other' },
    }).ok, false);
  });

  it('omits a missing App mapping from the real conservation child environment', () => {
    const probe = (env) => spawnSync(process.execPath, [
      '-e',
      "process.stdout.write(JSON.stringify({ hasMapping: Object.hasOwn(process.env, 'FEISHU_TASK_V2_AGENT_APP_IDS'), mapping: process.env.FEISHU_TASK_V2_AGENT_APP_IDS ?? null }))",
    ], { env, encoding: 'utf8' });
    const baseEnv = {
      ...process.env,
      FEISHU_TASK_V2_AGENT_APP_IDS: 'stale-inherited-value',
    };

    const missing = probe(buildNativeTaskConservationEnv({
      baseEnv,
      zylosDir: '/runtime/zylos',
      identity: { agentId: 'agent:veda', appId: 'cli_veda' },
      defaultAssigneeId: 'agent:veda',
      agentAppIds: null,
    }));
    assert.equal(missing.status, 0, missing.stderr);
    assert.deepEqual(JSON.parse(missing.stdout), {
      hasMapping: false,
      mapping: null,
    });

    const explicitValue = '{"agent:veda":"cli_veda"}';
    const explicit = probe(buildNativeTaskConservationEnv({
      baseEnv,
      zylosDir: '/runtime/zylos',
      identity: { agentId: 'agent:veda', appId: 'cli_veda' },
      defaultAssigneeId: 'agent:veda',
      agentAppIds: explicitValue,
    }));
    assert.equal(explicit.status, 0, explicit.stderr);
    assert.deepEqual(JSON.parse(explicit.stdout), {
      hasMapping: true,
      mapping: explicitValue,
    });
  });

  it('fails source validation when an immutable Core archive lacks c4-receive', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-upgrade-source-'));
    try {
      writeCoreFixture(root);
      fs.rmSync(path.join(root, 'skills/comm-bridge/scripts/c4-receive.js'));

      const result = validateCoreSource(root, '0.7.2-rc.5');

      assert.equal(result.ok, false);
      assert.match(result.error, /c4-receive\.js/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('fails source validation when an immutable Core archive lacks the convergence runner', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-upgrade-source-'));
    try {
      writeCoreFixture(root);
      fs.rmSync(path.join(root, 'scripts/native-task-convergence-runner.js'));

      const result = validateCoreSource(root, '0.7.2-rc.5');

      assert.equal(result.ok, false);
      assert.match(result.error, /native-task-convergence-runner\.js/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('fails source validation when an immutable Core archive lacks the outbound policy module', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-upgrade-source-'));
    try {
      writeCoreFixture(root);
      fs.rmSync(path.join(root, 'skills/comm-bridge/scripts/c4-outbound-policy.js'));

      const result = validateCoreSource(root, '0.7.2-rc.5');

      assert.equal(result.ok, false);
      assert.match(result.error, /c4-outbound-policy\.js/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('fails source validation when the shared binding projector is missing', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-upgrade-source-'));
    try {
      writeCoreFixture(root);
      fs.rmSync(path.join(root, 'skills/activity-monitor/scripts/assistant-turn-binding.js'));

      const result = validateCoreSource(root, '0.7.2-rc.5');

      assert.equal(result.ok, false);
      assert.match(result.error, /assistant-turn-binding\.js/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('fails source validation when the immutable Core archive omits the body-file reply contract', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-upgrade-source-'));
    try {
      writeCoreFixture(root);
      const capabilitiesPath = path.join(root, 'capabilities.json');
      const capabilities = JSON.parse(fs.readFileSync(capabilitiesPath, 'utf8'));
      delete capabilities.protocols['c4.reply.body-file'];
      fs.writeFileSync(capabilitiesPath, JSON.stringify(capabilities));

      const result = validateCoreSource(root, '0.7.2-rc.5');

      assert.equal(result.ok, false);
      assert.match(result.error, /c4\.reply\.body-file requires >= 1, found missing/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('fails source validation when the Core archive omits runtime-turn admission', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-upgrade-source-'));
    try {
      writeCoreFixture(root);
      const capabilitiesPath = path.join(root, 'capabilities.json');
      const capabilities = JSON.parse(fs.readFileSync(capabilitiesPath, 'utf8'));
      delete capabilities.protocols['c4.assistant-response-stream'];
      fs.writeFileSync(capabilitiesPath, JSON.stringify(capabilities));

      const result = validateCoreSource(root, '0.7.2-rc.5');

      assert.equal(result.ok, false);
      assert.match(result.error, /c4\.assistant-response-stream requires >= 3, found missing/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('does not require a Core-provided body-file capability from the Feishu source', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-upgrade-feishu-source-'));
    try {
      writeFeishuFixture(root);

      assert.deepEqual(validateFeishuSource(root, '0.3.7-rc.5').ok, true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('builds both mutations from exact SHAs with no movable branch ref', () => {
    const commands = buildUpgradeCommands({
      nodePath: '/usr/bin/node',
      stagedCoreDir: '/tmp/core',
      installedCoreDir: '/opt/zylos',
      coreSha: CORE_SHA,
      feishuSha: FEISHU_SHA,
    });

    assert.deepEqual(commands.core, {
      command: '/usr/bin/node',
      args: [
        '/tmp/core/cli/zylos.js', 'upgrade', '--self', '--branch', CORE_SHA,
        '--yes', '--json',
      ],
    });
    assert.deepEqual(commands.feishu, {
      command: '/usr/bin/node',
      args: [
        '/opt/zylos/cli/zylos.js', 'upgrade', 'feishu', '--branch', FEISHU_SHA,
        '--yes', '--skip-eval', '--json',
      ],
    });
  });

  it('builds the Feishu conservation gate around the public Core inventory', () => {
    const command = buildNativeTaskConservationCommand({
      nodePath: '/usr/bin/node',
      coreDir: '/opt/zylos',
      feishuDir: '/opt/zylos-feishu',
    });

    assert.deepEqual(command, {
      command: '/usr/bin/node',
      args: [
        '/opt/zylos-feishu/scripts/native-task-conservation-gate.js',
        '--core-inventory-command', '/usr/bin/node',
        '--core-inventory-arg', '/opt/zylos/cli/lib/native-task-conservation-inventory.js',
        '--timeout-ms', '90000',
      ],
    });
  });

  it('builds an explicitly authorized native Task convergence apply from exact manifests', () => {
    const command = buildNativeTaskConvergenceCommand({
      nodePath: '/usr/bin/node',
      coreDir: '/opt/core',
      feishuDir: '/opt/feishu',
      coreManifest: '/evidence/core.json',
      feishuManifest: '/evidence/feishu.json',
      reportDir: '/evidence/report',
      apply: true,
      authorization: 'owner-issue-25',
    });
    assert.deepEqual(command, {
      command: '/usr/bin/node',
      args: [
        '/opt/core/scripts/native-task-convergence.js',
        '--apply',
        '--core-manifest', '/evidence/core.json',
        '--feishu-manifest', '/evidence/feishu.json',
        '--core-dir', '/opt/core',
        '--feishu-dir', '/opt/feishu',
        '--report-dir', '/evidence/report',
        '--authorization', 'owner-issue-25',
      ],
    });
  });

  it('accepts an explicit report transaction for a repair resume', () => {
    const parsed = parseForkPairArgs([
      '--repair-only',
      '--resume',
      '--report-dir', '/evidence/fork-pair-transaction',
      '--core-sha', CORE_SHA,
      '--feishu-sha', FEISHU_SHA,
      '--core-version', '0.7.2-rc.5',
      '--feishu-version', '0.3.7-rc.5',
      '--staged-core', '/tmp/core',
      '--agent', 'ss',
      '--native-task-core-manifest', '/evidence/core.json',
      '--native-task-feishu-manifest', '/evidence/feishu.json',
      '--native-task-repair-authorization', 'owner-issue-25',
    ]);
    assert.equal(parsed.resume, true);
    assert.equal(parsed.reportDir, '/evidence/fork-pair-transaction');
  });

  it('holds resume when the immutable pair target changes', () => {
    const args = {
      repairOnly: true,
      execute: false,
      dryRun: false,
      resume: true,
      agent: 'ss',
      coreSha: CORE_SHA,
      feishuSha: FEISHU_SHA,
      coreVersion: '0.7.2-rc.5',
      feishuVersion: '0.3.7-rc.5',
      nativeTaskCoreManifest: '/evidence/core.json',
      nativeTaskFeishuManifest: '/evidence/feishu.json',
      nativeTaskRepairAuthorization: 'owner-issue-25',
    };
    const summary = {
      schema: 'zylos.fork-pair-upgrade/v1',
      status: 'HOLD',
      mode: 'repair-only',
      agent: 'ss',
      transactionId: 'txn-issue-25',
      reportDir: '/evidence/fork-pair-transaction',
      target: {
        core: { repo: 'HeXiaobo/zylos-core', sha: CORE_SHA, version: '0.7.2-rc.5' },
        feishu: { repo: 'HeXiaobo/zylos-feishu', sha: FEISHU_SHA, version: '0.3.7-rc.5' },
      },
      nativeTaskInputs: {
        coreManifest: '/evidence/core.json',
        feishuManifest: '/evidence/feishu.json',
        authorization: 'owner-issue-25',
      },
    };
    assert.throws(
      () => validatePairResumeSummary({
        ...summary,
        target: {
          ...summary.target,
          core: { ...summary.target.core, sha: 'c'.repeat(40) },
        },
      }, args, '/evidence/fork-pair-transaction'),
      error => error.code === 'SOURCE_BINDING_MISMATCH',
    );
  });

  it('binds convergence resume commands to the transaction and both immutable sources', () => {
    const command = buildNativeTaskConvergenceCommand({
      nodePath: '/usr/bin/node',
      coreDir: '/evidence/staged/core',
      feishuDir: '/evidence/staged/feishu',
      coreManifest: '/evidence/core.json',
      feishuManifest: '/evidence/feishu.json',
      reportDir: '/evidence/fork-pair-transaction/native-task-convergence',
      apply: true,
      resume: true,
      authorization: 'owner-issue-25',
      transactionId: 'txn-issue-25',
      coreSource: {
        repo: 'HeXiaobo/zylos-core',
        commit: CORE_SHA,
        version: '0.7.2-rc.5',
      },
      feishuSource: {
        repo: 'HeXiaobo/zylos-feishu',
        commit: FEISHU_SHA,
        version: '0.3.7-rc.5',
      },
    });
    assert.deepEqual(command.args, [
      '/evidence/staged/core/scripts/native-task-convergence.js',
      '--apply',
      '--resume',
      '--core-manifest', '/evidence/core.json',
      '--feishu-manifest', '/evidence/feishu.json',
      '--core-dir', '/evidence/staged/core',
      '--feishu-dir', '/evidence/staged/feishu',
      '--report-dir', '/evidence/fork-pair-transaction/native-task-convergence',
      '--authorization', 'owner-issue-25',
      '--transaction-id', 'txn-issue-25',
      '--core-source-repo', 'HeXiaobo/zylos-core',
      '--core-source-commit', CORE_SHA,
      '--core-source-version', '0.7.2-rc.5',
      '--feishu-source-repo', 'HeXiaobo/zylos-feishu',
      '--feishu-source-commit', FEISHU_SHA,
      '--feishu-source-version', '0.3.7-rc.5',
    ]);
  });

  it('persists staged Core and Feishu sources under the report transaction for later resume', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-fork-pair-staged-sources-'));
    try {
      const inputCore = path.join(root, 'input-core');
      const reportDir = path.join(root, 'report');
      const zylosDir = path.join(root, 'zylos');
      const liveNodeModules = path.join(zylosDir, '.claude', 'skills', 'feishu', 'node_modules');
      fs.mkdirSync(inputCore, { recursive: true });
      writeCoreFixture(inputCore);
      fs.mkdirSync(liveNodeModules, { recursive: true });
      const args = {
        stagedCoreDir: inputCore,
        coreSha: CORE_SHA,
        coreVersion: '0.7.2-rc.5',
        feishuSha: FEISHU_SHA,
        feishuVersion: '0.3.7-rc.5',
      };
      const result = preparePersistentStagedSources({
        args,
        reportDir,
        zylosDir,
        stageArchive(_repo, _sha, destination) {
          fs.mkdirSync(destination, { recursive: true });
          fs.writeFileSync(path.join(destination, 'package.json'), JSON.stringify({
            name: 'zylos-feishu',
            version: '0.3.7-rc.5',
          }));
          fs.writeFileSync(path.join(path.dirname(destination), 'feishu.tar.gz'), 'immutable archive');
          return path.join(path.dirname(destination), 'feishu.tar.gz');
        },
      });

      assert.equal(result.coreDir, path.join(reportDir, 'staged-sources', 'core'));
      assert.equal(result.feishuDir, path.join(reportDir, 'staged-sources', 'feishu'));
      assert.equal(fs.existsSync(result.coreDir), true);
      assert.equal(fs.existsSync(result.feishuDir), true);
      assert.equal(fs.existsSync(result.archivePath), true);
      assert.equal(fs.realpathSync(path.join(result.feishuDir, 'node_modules')), fs.realpathSync(liveNodeModules));
      assert.equal(fs.existsSync(path.join(inputCore, 'package.json')), true);

      const resumed = preparePersistentStagedSources({
        args,
        reportDir,
        zylosDir,
        summary: {
          stagedSources: {
            root: result.root,
            coreDir: result.coreDir,
            feishuDir: result.feishuDir,
            archivePath: result.archivePath,
          },
          sources: { core: result.core, feishu: result.feishu },
        },
        resume: true,
      });
      assert.equal(resumed.coreDir, result.coreDir);
      assert.equal(resumed.feishuDir, result.feishuDir);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('binds exact live Commitment Core dependencies when native Task convergence is requested', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-fork-pair-core-dependencies-'));
    try {
      const inputCore = path.join(root, 'input-core');
      const reportDir = path.join(root, 'report');
      const zylosDir = path.join(root, 'zylos');
      const liveFeishuNodeModules = path.join(zylosDir, '.claude', 'skills', 'feishu', 'node_modules');
      const liveCoreNodeModules = path.join(zylosDir, '.claude', 'skills', 'commitment-core', 'node_modules');
      fs.mkdirSync(inputCore, { recursive: true });
      writeCoreFixture(inputCore);
      const coreSkillDir = path.join(inputCore, 'skills', 'commitment-core');
      fs.writeFileSync(path.join(coreSkillDir, 'package.json'), JSON.stringify({
        name: 'zylos-commitment-core',
        version: '0.1.0',
        dependencies: { 'better-sqlite3': '^12.6.2' },
      }));
      fs.writeFileSync(path.join(coreSkillDir, 'package-lock.json'), JSON.stringify({
        name: 'zylos-commitment-core',
        version: '0.1.0',
        lockfileVersion: 3,
        packages: {
          '': {
            name: 'zylos-commitment-core',
            version: '0.1.0',
            dependencies: { 'better-sqlite3': '^12.6.2' },
          },
          'node_modules/better-sqlite3': { version: '12.11.1' },
        },
      }));
      fs.mkdirSync(liveFeishuNodeModules, { recursive: true });
      fs.mkdirSync(path.join(liveCoreNodeModules, 'better-sqlite3'), { recursive: true });
      fs.writeFileSync(
        path.join(liveCoreNodeModules, 'better-sqlite3', 'package.json'),
        JSON.stringify({ name: 'better-sqlite3', version: '12.11.1' }),
      );
      const args = {
        stagedCoreDir: inputCore,
        coreSha: CORE_SHA,
        coreVersion: '0.7.2-rc.5',
        feishuSha: FEISHU_SHA,
        feishuVersion: '0.3.7-rc.5',
        nativeTaskCoreManifest: '/evidence/core.json',
      };
      const result = preparePersistentStagedSources({
        args,
        reportDir,
        zylosDir,
        stageArchive(_repo, _sha, destination) {
          fs.mkdirSync(destination, { recursive: true });
          fs.writeFileSync(path.join(destination, 'package.json'), JSON.stringify({
            name: 'zylos-feishu',
            version: '0.3.7-rc.5',
          }));
          fs.writeFileSync(path.join(path.dirname(destination), 'feishu.tar.gz'), 'immutable archive');
          return path.join(path.dirname(destination), 'feishu.tar.gz');
        },
      });

      assert.equal(
        fs.realpathSync(path.join(result.coreDir, 'skills', 'commitment-core', 'node_modules')),
        fs.realpathSync(liveCoreNodeModules),
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('holds when live Commitment Core dependencies differ from the immutable target lockfile', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-fork-pair-core-dependency-mismatch-'));
    try {
      const stagedCoreDir = path.join(root, 'staged-core');
      const packageDir = path.join(stagedCoreDir, 'skills', 'commitment-core');
      const liveNodeModules = path.join(root, 'live-node-modules');
      fs.mkdirSync(path.join(liveNodeModules, 'better-sqlite3'), { recursive: true });
      fs.mkdirSync(packageDir, { recursive: true });
      fs.writeFileSync(path.join(packageDir, 'package.json'), JSON.stringify({
        name: 'zylos-commitment-core',
        version: '0.1.0',
        dependencies: { 'better-sqlite3': '^12.6.2' },
      }));
      fs.writeFileSync(path.join(packageDir, 'package-lock.json'), JSON.stringify({
        packages: {
          'node_modules/better-sqlite3': { version: '12.11.1' },
        },
      }));
      fs.writeFileSync(
        path.join(liveNodeModules, 'better-sqlite3', 'package.json'),
        JSON.stringify({ name: 'better-sqlite3', version: '12.10.0' }),
      );

      assert.throws(
        () => ensureCommitmentCoreRuntimeDependencies(stagedCoreDir, liveNodeModules),
        error => error.code === 'SOURCE_BINDING_MISMATCH'
          && /12\.10\.0.*12\.11\.1/.test(error.message),
      );
      assert.equal(fs.existsSync(path.join(packageDir, 'node_modules')), false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('holds before mutation when any online PM2 process has no real executable', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-upgrade-pm2-'));
    try {
      const livePath = path.join(root, 'live.js');
      fs.writeFileSync(livePath, '#!/usr/bin/env node\n');
      const snapshot = [
        { name: 'activity-monitor', status: 'online', execPath: livePath },
        { name: 'c4-dispatcher', status: 'online', execPath: livePath },
        { name: 'zylos-feishu', status: 'online', execPath: livePath },
        {
          name: 'zylos-wechat',
          status: 'online',
          execPath: path.join(root, 'missing-wechat.js'),
        },
      ];

      assert.deepEqual(validatePm2Snapshot(snapshot), [
        `zylos-wechat reports online but has no live executable at ${path.join(root, 'missing-wechat.js')}`,
      ]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('repairs only the exact rollback orphan that exists in the pinned target', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-upgrade-orphan-'));
    try {
      const zylosDir = path.join(root, 'zylos');
      const stagedCoreDir = path.join(root, 'target');
      const expectedLivePath = path.join(
        zylosDir,
        '.claude',
        'skills',
        'comm-bridge',
        'scripts',
        'c4-response-stream-supervisor.js',
      );
      const targetPath = path.join(
        stagedCoreDir,
        'skills',
        'comm-bridge',
        'scripts',
        'c4-response-stream-supervisor.js',
      );
      fs.mkdirSync(path.dirname(targetPath), { recursive: true });
      fs.writeFileSync(targetPath, '#!/usr/bin/env node\n');

      assert.deepStrictEqual(planPm2PreflightRepairs([{
        name: 'c4-response-stream-supervisor',
        status: 'online',
        execPath: expectedLivePath,
      }], { zylosDir, stagedCoreDir }), [{
        action: 'delete_rollback_orphan',
        name: 'c4-response-stream-supervisor',
        execPath: expectedLivePath,
        targetPath,
      }]);

      assert.deepStrictEqual(planPm2PreflightRepairs([{
        name: 'c4-response-stream-supervisor',
        status: 'online',
        execPath: path.join(root, 'unexpected.js'),
      }], { zylosDir, stagedCoreDir }), []);

      fs.mkdirSync(path.dirname(expectedLivePath), { recursive: true });
      fs.writeFileSync(expectedLivePath, '#!/usr/bin/env node\n');
      assert.deepStrictEqual(planPm2PreflightRepairs([{
        name: 'c4-response-stream-supervisor',
        status: 'online',
        execPath: expectedLivePath,
      }], { zylosDir, stagedCoreDir }), []);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('serializes concurrent retention runs so they cannot prune each other current backup', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-core-retention-concurrent-'));
    try {
      const firstCurrent = writeCoreBackup(root, 'zylos-core-backup-a', '0.7.2-rc.5', 1);
      const secondCurrent = writeCoreBackup(root, 'zylos-core-backup-c', '0.7.2-rc.9', 2);
      const newest = writeCoreBackup(root, 'zylos-core-backup-b', '0.7.2-rc.10', 3);
      runVerifiedRetention(root, firstCurrent, 1, fs, 10);
      runVerifiedRetention(root, secondCurrent, 2, fs, 10);
      runVerifiedRetention(root, newest, 3, fs, 10);
      const firstReport = path.join(root, 'report-4');
      const secondReport = path.join(root, 'report-5');
      fs.mkdirSync(firstReport);
      fs.mkdirSync(secondReport);
      const firstSummaryPath = path.join(firstReport, 'summary.json');
      const secondSummaryPath = path.join(secondReport, 'summary.json');
      const firstSummary = verifiedPairSummary(firstCurrent, firstSummaryPath, {
        startedAt: '2026-08-27T00:04:00.000Z',
        finishedAt: '2026-08-27T00:04:30.000Z',
        coreSha: '4'.padStart(40, '0'),
      });
      const secondSummary = verifiedPairSummary(secondCurrent, secondSummaryPath, {
        startedAt: '2026-08-27T00:05:00.000Z',
        finishedAt: '2026-08-27T00:05:30.000Z',
        coreSha: '5'.padStart(40, '0'),
      });
      let nestedResult = null;
      let injected = false;
      const fsApi = new Proxy(fs, {
        get(target, property) {
          if (property !== 'renameSync') return Reflect.get(target, property);
          return (source, destination) => {
            const renamed = fs.renameSync(source, destination);
            if (!injected && destination === firstSummaryPath) {
              injected = true;
              nestedResult = executeCoreBackupRetention({
                currentBackupDir: secondCurrent,
                tmpDir: root,
                homeDir: path.join(root, 'home'),
                summary: secondSummary,
                summaryPath: secondSummaryPath,
              });
            }
            return renamed;
          };
        },
      });

      const result = executeCoreBackupRetention({
        currentBackupDir: firstCurrent,
        tmpDir: root,
        homeDir: path.join(root, 'home'),
        summary: firstSummary,
        summaryPath: firstSummaryPath,
        fsApi,
      });

      assert.equal(result.status, 'GC_PENDING');
      assert.equal(nestedResult.status, 'WARN');
      assert.match(nestedResult.reason, /locked/i);
      assert.equal(fs.existsSync(firstCurrent), true);
      assert.equal(result.quarantined.length, 1);
      assert.equal(fs.existsSync(result.quarantined[0].path), false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('never adopts a name-only lookalike without a successful pair ownership proof', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-core-retention-owned-'));
    try {
      const lookalike = writeCoreBackup(root, 'zylos-core-backup-lookalike', '0.7.2-rc.5', 1);
      const current = writeCoreBackup(root, 'zylos-core-backup-current', '0.7.2-rc.11', 2);
      const summaryPath = path.join(root, 'summary.json');
      const summary = verifiedPairSummary(current, summaryPath);
      const result = executeCoreBackupRetention({
        currentBackupDir: current,
        tmpDir: root,
        homeDir: path.join(root, 'home'),
        summary,
        summaryPath,
      });

      assert.equal(result.status, 'PASS');
      assert.deepEqual(result.retained.map(item => item.path), [current]);
      assert.deepEqual(result.candidates, []);
      assert.equal(fs.existsSync(lookalike), true);
      assert.equal(fs.existsSync(path.join(current, '.zylos-core-backup-owner.json')), true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects an ownership marker whose mode or signed identity is altered', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-core-retention-owner-marker-'));
    try {
      const current = writeCoreBackup(root, 'zylos-core-backup-current', '0.7.2-rc.11', 1);
      runVerifiedRetention(root, current, 1);
      const markerPath = path.join(current, '.zylos-core-backup-owner.json');
      fs.chmodSync(markerPath, 0o644);
      assert.equal(planCoreBackupRetention({
        currentBackupDir: current,
        tmpDir: root,
        homeDir: path.join(root, 'home'),
      }).status, 'SKIPPED');

      fs.chmodSync(markerPath, 0o600);
      const marker = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
      marker.backup.ino += 1;
      fs.writeFileSync(markerPath, `${JSON.stringify(marker)}\n`, { mode: 0o600 });
      assert.equal(planCoreBackupRetention({
        currentBackupDir: current,
        tmpDir: root,
        homeDir: path.join(root, 'home'),
      }).status, 'SKIPPED');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('deletes only a prior successful quarantine generation and leaves one new GC_PENDING generation', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-core-retention-generations-'));
    try {
      const first = writeCoreBackup(root, 'zylos-core-backup-a', '0.7.2-rc.5', 1);
      assert.equal(runVerifiedRetention(root, first, 1).status, 'PASS');
      const second = writeCoreBackup(root, 'zylos-core-backup-b', '0.7.2-rc.9', 2);
      assert.equal(runVerifiedRetention(root, second, 2).status, 'PASS');
      const third = writeCoreBackup(root, 'zylos-core-backup-c', '0.7.2-rc.10', 3);
      const firstQuarantine = runVerifiedRetention(root, third, 3);
      assert.equal(firstQuarantine.status, 'GC_PENDING');
      assert.equal(firstQuarantine.quarantined[0].path, first);
      assert.equal(fs.existsSync(first), false);

      const fourth = writeCoreBackup(root, 'zylos-core-backup-d', '0.7.2-rc.11', 4);
      const secondQuarantine = runVerifiedRetention(root, fourth, 4);
      assert.equal(secondQuarantine.status, 'GC_PENDING');
      assert.deepEqual(secondQuarantine.removed.map(item => item.path), [first]);
      assert.equal(fs.existsSync(second), false);
      assert.equal(fs.existsSync(third), true);
      assert.equal(fs.existsSync(fourth), true);
      assert.equal(fs.existsSync(firstQuarantine.quarantined[0].quarantinePath), false);
      const generations = fs.readdirSync(root)
        .filter(name => name.startsWith('.zylos-core-retention-quarantine-'));
      assert.equal(generations.length, 1);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('fails closed before recursive GC when a retired quarantine contains a symlink', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-core-retention-symlink-'));
    try {
      const first = writeCoreBackup(root, 'zylos-core-backup-a', '0.7.2-rc.5', 1);
      runVerifiedRetention(root, first, 1);
      const second = writeCoreBackup(root, 'zylos-core-backup-b', '0.7.2-rc.9', 2);
      runVerifiedRetention(root, second, 2);
      const third = writeCoreBackup(root, 'zylos-core-backup-c', '0.7.2-rc.10', 3);
      const pending = runVerifiedRetention(root, third, 3);
      const retiredPath = pending.quarantined[0].quarantinePath;
      fs.symlinkSync(root, path.join(retiredPath, 'nested-link'), 'dir');

      const fourth = writeCoreBackup(root, 'zylos-core-backup-d', '0.7.2-rc.11', 4);
      const result = runVerifiedRetention(root, fourth, 4);

      assert.equal(result.status, 'WARN');
      assert.match(result.skipped[0].reason, /symlink/);
      assert.equal(fs.existsSync(pending.generations[0].path), true);
      assert.equal(fs.existsSync(second), true);
      assert.equal(fs.existsSync(third), true);
      assert.equal(fs.existsSync(fourth), true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('fails closed before recursive GC when a nested entry crosses devices', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-core-retention-mount-'));
    try {
      const first = writeCoreBackup(root, 'zylos-core-backup-a', '0.7.2-rc.5', 1);
      runVerifiedRetention(root, first, 1);
      const second = writeCoreBackup(root, 'zylos-core-backup-b', '0.7.2-rc.9', 2);
      runVerifiedRetention(root, second, 2);
      const third = writeCoreBackup(root, 'zylos-core-backup-c', '0.7.2-rc.10', 3);
      const pending = runVerifiedRetention(root, third, 3);
      const mountPath = path.join(pending.quarantined[0].quarantinePath, 'simulated-mount');
      fs.mkdirSync(mountPath);
      const fsApi = new Proxy(fs, {
        get(target, property) {
          if (property !== 'lstatSync') return Reflect.get(target, property);
          return (targetPath, ...args) => {
            const stat = fs.lstatSync(targetPath, ...args);
            if (targetPath !== mountPath) return stat;
            return new Proxy(stat, {
              get(statTarget, statProperty) {
                if (statProperty === 'dev') return statTarget.dev + 1;
                return Reflect.get(statTarget, statProperty);
              },
            });
          };
        },
      });

      const fourth = writeCoreBackup(root, 'zylos-core-backup-d', '0.7.2-rc.11', 4);
      const result = runVerifiedRetention(root, fourth, 4, fsApi);

      assert.equal(result.status, 'WARN');
      assert.match(result.skipped[0].reason, /cross-device/);
      assert.equal(fs.existsSync(pending.generations[0].path), true);
      assert.equal(fs.existsSync(second), true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('unlinks only authorized npm .bin symlinks without touching their targets and writes an audit', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-core-retention-repair-'));
    try {
      const first = writeCoreBackup(root, 'zylos-core-backup-a', '0.7.2-rc.5', 1);
      runVerifiedRetention(root, first, 1);
      const second = writeCoreBackup(root, 'zylos-core-backup-b', '0.7.2-rc.9', 2);
      runVerifiedRetention(root, second, 2);
      const third = writeCoreBackup(root, 'zylos-core-backup-c', '0.7.2-rc.10', 3);
      const pending = runVerifiedRetention(root, third, 3);
      const quarantinePath = pending.generations[0].path;
      const objectPath = pending.quarantined[0].quarantinePath;
      const binPath = path.join(objectPath, 'core-package', 'node_modules', '.bin');
      fs.mkdirSync(binPath, { recursive: true });
      const outsideTarget = path.join(root, 'outside-target.js');
      fs.writeFileSync(outsideTarget, 'must remain\n');
      const linkPath = path.join(binPath, 'external-tool');
      fs.symlinkSync(outsideTarget, linkPath);
      const auditPath = path.join(root, 'retention-repair.json');

      const result = repairCoreBackupRetention({
        quarantinePath,
        authorization: retentionRepairAuthorization(quarantinePath),
        auditPath,
        apply: true,
        homeDir: path.join(root, 'home'),
      });

      assert.equal(result.status, 'PASS');
      assert.equal(result.result, 'REPAIRED');
      assert.equal(result.actions[0].status, 'UNLINKED');
      assert.equal(fs.lstatSync(linkPath, { throwIfNoEntry: false }), undefined);
      assert.equal(fs.readFileSync(outsideTarget, 'utf8'), 'must remain\n');
      assert.equal(fs.lstatSync(quarantinePath).isDirectory(), true);
      const audit = JSON.parse(fs.readFileSync(auditPath, 'utf8'));
      assert.equal(audit.schema, 'zylos.core-backup-retention-repair/v1');
      assert.equal(audit.status, 'PASS');
      assert.equal(audit.result, 'REPAIRED');
      assert.equal(audit.links[0].target, outsideTarget);
      assert.equal(audit.authorization.approvedPath, quarantinePath);
      assert.equal(audit.actions[0].status, 'UNLINKED');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('fails closed without mutation for an unknown symlink even with exact authorization', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-core-retention-repair-unknown-'));
    try {
      const first = writeCoreBackup(root, 'zylos-core-backup-a', '0.7.2-rc.5', 1);
      runVerifiedRetention(root, first, 1);
      const second = writeCoreBackup(root, 'zylos-core-backup-b', '0.7.2-rc.9', 2);
      runVerifiedRetention(root, second, 2);
      const third = writeCoreBackup(root, 'zylos-core-backup-c', '0.7.2-rc.10', 3);
      const pending = runVerifiedRetention(root, third, 3);
      const quarantinePath = pending.generations[0].path;
      const objectPath = pending.quarantined[0].quarantinePath;
      const outsideTarget = path.join(root, 'outside-target');
      fs.writeFileSync(outsideTarget, 'must remain');
      const unknownLink = path.join(objectPath, 'unexpected-link');
      fs.symlinkSync(outsideTarget, unknownLink);
      const auditPath = path.join(root, 'unknown-repair.json');

      const result = repairCoreBackupQuarantine({
        quarantinePath,
        authorization: retentionRepairAuthorization(quarantinePath),
        auditPath,
        apply: true,
        homeDir: path.join(root, 'home'),
      });

      assert.equal(result.status, 'HOLD');
      assert.equal(result.code, 'RETENTION_REPAIR_UNKNOWN_SYMLINK');
      assert.equal(fs.lstatSync(unknownLink).isSymbolicLink(), true);
      assert.equal(fs.readFileSync(outsideTarget, 'utf8'), 'must remain');
      assert.equal(JSON.parse(fs.readFileSync(auditPath, 'utf8')).status, 'HOLD');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('fails closed without mutation when a nested repair entry crosses devices', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-core-retention-repair-mount-'));
    try {
      const first = writeCoreBackup(root, 'zylos-core-backup-a', '0.7.2-rc.5', 1);
      runVerifiedRetention(root, first, 1);
      const second = writeCoreBackup(root, 'zylos-core-backup-b', '0.7.2-rc.9', 2);
      runVerifiedRetention(root, second, 2);
      const third = writeCoreBackup(root, 'zylos-core-backup-c', '0.7.2-rc.10', 3);
      const pending = runVerifiedRetention(root, third, 3);
      const quarantinePath = pending.generations[0].path;
      const objectPath = pending.quarantined[0].quarantinePath;
      const binPath = path.join(objectPath, 'core-package', 'node_modules', '.bin');
      fs.mkdirSync(binPath, { recursive: true });
      const outsideTarget = path.join(root, 'outside-target');
      fs.writeFileSync(outsideTarget, 'must remain');
      const linkPath = path.join(binPath, 'external-tool');
      fs.symlinkSync(outsideTarget, linkPath);
      const mountPath = path.join(objectPath, 'core-package', 'simulated-mount');
      fs.mkdirSync(mountPath);
      const fsApi = new Proxy(fs, {
        get(target, property) {
          if (property !== 'lstatSync') return Reflect.get(target, property);
          return (targetPath, ...args) => {
            const stat = fs.lstatSync(targetPath, ...args);
            if (targetPath !== mountPath) return stat;
            return new Proxy(stat, {
              get(statTarget, statProperty) {
                if (statProperty === 'dev') return statTarget.dev + 1;
                return Reflect.get(statTarget, statProperty);
              },
            });
          };
        },
      });
      const auditPath = path.join(root, 'mount-repair.json');

      const result = repairCoreBackupQuarantine({
        quarantinePath,
        authorization: retentionRepairAuthorization(quarantinePath),
        auditPath,
        apply: true,
        fsApi,
        homeDir: path.join(root, 'home'),
      });

      assert.equal(result.status, 'HOLD');
      assert.equal(result.code, 'RETENTION_REPAIR_CROSS_DEVICE');
      assert.equal(fs.lstatSync(linkPath).isSymbolicLink(), true);
      assert.equal(fs.readFileSync(outsideTarget, 'utf8'), 'must remain');
      assert.equal(JSON.parse(fs.readFileSync(auditPath, 'utf8')).status, 'HOLD');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('fails closed and records a race when a symlink is replaced during unlink', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-core-retention-repair-race-'));
    try {
      const first = writeCoreBackup(root, 'zylos-core-backup-a', '0.7.2-rc.5', 1);
      runVerifiedRetention(root, first, 1);
      const second = writeCoreBackup(root, 'zylos-core-backup-b', '0.7.2-rc.9', 2);
      runVerifiedRetention(root, second, 2);
      const third = writeCoreBackup(root, 'zylos-core-backup-c', '0.7.2-rc.10', 3);
      const pending = runVerifiedRetention(root, third, 3);
      const quarantinePath = pending.generations[0].path;
      const objectPath = pending.quarantined[0].quarantinePath;
      const binPath = path.join(objectPath, 'core-package', 'node_modules', '.bin');
      fs.mkdirSync(binPath, { recursive: true });
      const outsideTarget = path.join(root, 'outside-target');
      fs.writeFileSync(outsideTarget, 'must remain');
      const linkPath = path.join(binPath, 'external-tool');
      fs.symlinkSync(outsideTarget, linkPath);
      let raced = false;
      const fsApi = new Proxy(fs, {
        get(target, property) {
          if (property !== 'unlinkSync') return Reflect.get(target, property);
          return targetPath => {
            fs.unlinkSync(targetPath);
            if (!raced) {
              raced = true;
              fs.writeFileSync(targetPath, 'replacement');
            }
          };
        },
      });
      const auditPath = path.join(root, 'race-repair.json');

      const result = repairCoreBackupQuarantine({
        quarantinePath,
        authorization: retentionRepairAuthorization(quarantinePath),
        auditPath,
        apply: true,
        fsApi,
        homeDir: path.join(root, 'home'),
      });

      assert.equal(result.status, 'HOLD');
      assert.equal(result.code, 'RETENTION_REPAIR_RACE');
      assert.equal(fs.readFileSync(linkPath, 'utf8'), 'replacement');
      assert.equal(fs.readFileSync(outsideTarget, 'utf8'), 'must remain');
      const audit = JSON.parse(fs.readFileSync(auditPath, 'utf8'));
      assert.equal(audit.status, 'HOLD');
      assert.equal(audit.actions[0].status, 'RACE_DETECTED');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('reports residual GC after partial deletion without touching current or prior backups', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-core-retention-partial-gc-'));
    try {
      const first = writeCoreBackup(root, 'zylos-core-backup-a', '0.7.2-rc.5', 1);
      runVerifiedRetention(root, first, 1);
      const second = writeCoreBackup(root, 'zylos-core-backup-b', '0.7.2-rc.9', 2);
      runVerifiedRetention(root, second, 2);
      const third = writeCoreBackup(root, 'zylos-core-backup-c', '0.7.2-rc.10', 3);
      const pending = runVerifiedRetention(root, third, 3);
      const generationPath = pending.generations[0].path;
      const retiredPackage = path.join(
        pending.quarantined[0].quarantinePath,
        'core-package',
        'package.json',
      );
      const fsApi = new Proxy(fs, {
        get(target, property) {
          if (property !== 'rmSync') return Reflect.get(target, property);
          return (targetPath, options) => {
            if (targetPath === generationPath) {
              fs.rmSync(retiredPackage);
              throw new Error('injected partial GC failure');
            }
            return fs.rmSync(targetPath, options);
          };
        },
      });

      const fourth = writeCoreBackup(root, 'zylos-core-backup-d', '0.7.2-rc.11', 4);
      const result = runVerifiedRetention(root, fourth, 4, fsApi);

      assert.equal(result.status, 'WARN');
      assert.match(result.skipped[0].reason, /partial GC failure/);
      assert.equal(fs.existsSync(generationPath), true);
      assert.equal(fs.existsSync(second), true);
      assert.equal(fs.existsSync(third), true);
      assert.equal(fs.existsSync(fourth), true);
      assert.equal(fs.readdirSync(root).filter(name => name.startsWith('.zylos-core-retention-quarantine-')).length, 1);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('atomically records the planned retention audit before quarantining an old backup', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-core-retention-'));
    try {
      const old = writeCoreBackup(root, 'zylos-core-backup-2026-08-26T18-01-27-874Z', '0.7.2-rc.5', 1);
      runVerifiedRetention(root, old, 1);
      const previous = writeCoreBackup(root, 'zylos-core-backup-2026-08-26T20-38-52-743Z', '0.7.2-rc.9', 2);
      runVerifiedRetention(root, previous, 2);
      const current = writeCoreBackup(root, 'zylos-core-backup-2026-08-26T21-45-46-257Z', '0.7.2-rc.10', 3);
      const reportDir = path.join(root, 'report-3');
      fs.mkdirSync(reportDir);
      const summaryPath = path.join(reportDir, 'summary.json');
      const summary = verifiedPairSummary(current, summaryPath, {
        startedAt: '2026-08-27T00:03:00.000Z',
        finishedAt: '2026-08-27T00:03:30.000Z',
        coreSha: '3'.padStart(40, '0'),
      });
      let observedPlannedAudit = false;
      let fsyncCount = 0;
      const fsApi = new Proxy(fs, {
        get(target, property) {
          if (property === 'fsyncSync') return (...args) => { fsyncCount += 1; return fs.fsyncSync(...args); };
          if (property !== 'renameSync') return Reflect.get(target, property);
          return (source, destination) => {
            if (source === old) {
              const persisted = JSON.parse(fs.readFileSync(summaryPath, 'utf8'));
              assert.equal(persisted.backupRetention.status, 'PLANNED');
              assert.deepEqual(
                persisted.backupRetention.candidates.map(item => item.path),
                [old],
              );
              const [generation] = persisted.backupRetention.generations;
              assert.equal(generation.moveIntent.sourcePath, old);
              assert.equal(destination, generation.moveIntent.quarantinePath);
              assert.equal(path.dirname(path.dirname(destination)), generation.path);
              assert.match(path.basename(generation.path), /^\.zylos-core-retention-quarantine-[0-9a-f]{48}$/);
              observedPlannedAudit = true;
            }
            return fs.renameSync(source, destination);
          };
        },
      });
      const result = executeCoreBackupRetention({
        currentBackupDir: current,
        tmpDir: root,
        homeDir: path.join(root, 'home'),
        summary,
        summaryPath,
        fsApi,
      });

      assert.equal(result.status, 'GC_PENDING');
      assert.equal(observedPlannedAudit, true);
      assert.ok(fsyncCount >= 6);
      assert.equal(JSON.parse(fs.readFileSync(summaryPath, 'utf8')).backupRetention.status, 'GC_PENDING');
      assert.equal(fs.existsSync(old), false);
      assert.equal(fs.existsSync(previous), true);
      assert.equal(fs.existsSync(current), true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('durably records every quarantine rename and the terminal GC_PENDING state', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-core-retention-audit-'));
    try {
      const first = writeCoreBackup(root, 'zylos-core-backup-a', '0.7.2-rc.5', 1);
      runVerifiedRetention(root, first, 1, fs, 10);
      const second = writeCoreBackup(root, 'zylos-core-backup-b', '0.7.2-rc.9', 2);
      runVerifiedRetention(root, second, 2, fs, 10);
      const third = writeCoreBackup(root, 'zylos-core-backup-c', '0.7.2-rc.10', 3);
      runVerifiedRetention(root, third, 3, fs, 10);
      const current = writeCoreBackup(root, 'zylos-core-backup-d', '0.7.2-rc.11', 4);
      const ownedSources = new Set([first, second, third]);
      let observedRenames = 0;
      let fsyncCount = 0;
      const reportDir = path.join(root, 'report-4');
      fs.mkdirSync(reportDir);
      const summaryPath = path.join(reportDir, 'summary.json');
      const summary = verifiedPairSummary(current, summaryPath, {
        startedAt: '2026-08-27T00:04:00.000Z',
        finishedAt: '2026-08-27T00:04:30.000Z',
        coreSha: '4'.padStart(40, '0'),
      });
      const fsApi = new Proxy(fs, {
        get(target, property) {
          if (property === 'fsyncSync') return (...args) => { fsyncCount += 1; return fs.fsyncSync(...args); };
          if (property !== 'renameSync') return Reflect.get(target, property);
          return (source, destination) => {
            if (ownedSources.has(source)) {
              const persisted = JSON.parse(fs.readFileSync(summaryPath, 'utf8'));
              const generation = persisted.backupRetention.generations[0];
              assert.equal(persisted.backupRetention.status, 'PLANNED');
              assert.equal(generation.moveIntent.sourcePath, source);
              assert.equal(generation.moveIntent.quarantinePath, destination);
              observedRenames += 1;
            }
            return fs.renameSync(source, destination);
          };
        },
      });

      const result = executeCoreBackupRetention({
        currentBackupDir: current,
        tmpDir: root,
        homeDir: path.join(root, 'home'),
        summary,
        summaryPath,
        fsApi,
      });

      assert.equal(result.status, 'GC_PENDING');
      assert.equal(result.quarantined.length, 2);
      assert.equal(observedRenames, 2);
      assert.ok(fsyncCount >= 12);
      const terminal = JSON.parse(fs.readFileSync(summaryPath, 'utf8'));
      assert.equal(terminal.backupRetention.status, 'GC_PENDING');
      assert.equal(terminal.backupRetention.quarantined.length, 2);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('does not move or delete a backup when the planned audit cannot be committed', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-core-retention-'));
    try {
      const old = writeCoreBackup(root, 'zylos-core-backup-2026-08-26T18-01-27-874Z', '0.7.2-rc.5', 1);
      runVerifiedRetention(root, old, 1);
      const previous = writeCoreBackup(root, 'zylos-core-backup-2026-08-26T20-38-52-743Z', '0.7.2-rc.9', 2);
      runVerifiedRetention(root, previous, 2);
      const current = writeCoreBackup(root, 'zylos-core-backup-2026-08-26T21-45-46-257Z', '0.7.2-rc.10', 3);
      const summaryPath = path.join(root, 'summary.json');
      const summary = verifiedPairSummary(current, summaryPath);
      const fsApi = new Proxy(fs, {
        get(target, property) {
          if (property !== 'renameSync') return Reflect.get(target, property);
          return (source, destination) => {
            if (destination === summaryPath) throw new Error('injected audit commit failure');
            return fs.renameSync(source, destination);
          };
        },
      });
      assert.throws(
        () => executeCoreBackupRetention({
          currentBackupDir: current,
          tmpDir: root,
          homeDir: path.join(root, 'home'),
          summary,
          summaryPath,
          fsApi,
        }),
        /injected audit commit failure/,
      );
      assert.equal(fs.existsSync(old), true);
      assert.equal(fs.existsSync(previous), true);
      assert.equal(fs.existsSync(current), true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('never hard-deletes a backup in the same run that quarantines it', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-core-retention-'));
    try {
      const old = writeCoreBackup(root, 'zylos-core-backup-2026-08-26T18-01-27-874Z', '0.7.2-rc.5', 1);
      runVerifiedRetention(root, old, 1);
      const previous = writeCoreBackup(root, 'zylos-core-backup-2026-08-26T20-38-52-743Z', '0.7.2-rc.9', 2);
      runVerifiedRetention(root, previous, 2);
      const current = writeCoreBackup(root, 'zylos-core-backup-2026-08-26T21-45-46-257Z', '0.7.2-rc.10', 3);
      let recursiveDeletes = 0;
      const fsApi = new Proxy(fs, {
        get(target, property) {
          if (property !== 'rmSync') return Reflect.get(target, property);
          return (targetPath, options) => {
            if (options?.recursive && path.basename(targetPath).startsWith('.zylos-core-retention-quarantine-')) {
              recursiveDeletes += 1;
            }
            return fs.rmSync(targetPath, options);
          };
        },
      });
      const result = runVerifiedRetention(root, current, 3, fsApi);

      assert.equal(result.status, 'GC_PENDING');
      assert.equal(result.removed.length, 0);
      assert.equal(recursiveDeletes, 0);
      assert.equal(fs.existsSync(old), false);
      assert.equal(fs.existsSync(result.quarantined[0].quarantinePath), true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('does not delete a replacement raced into place immediately before quarantine', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-core-retention-'));
    try {
      const old = writeCoreBackup(root, 'zylos-core-backup-2026-08-26T18-01-27-874Z', '0.7.2-rc.5', 1);
      runVerifiedRetention(root, old, 1);
      const previous = writeCoreBackup(root, 'zylos-core-backup-2026-08-26T20-38-52-743Z', '0.7.2-rc.9', 2);
      runVerifiedRetention(root, previous, 2);
      const current = writeCoreBackup(root, 'zylos-core-backup-2026-08-26T21-45-46-257Z', '0.7.2-rc.10', 3);
      const displaced = path.join(root, 'displaced-planned-backup');
      let raced = false;
      const fsApi = new Proxy(fs, {
        get(target, property) {
          if (property !== 'renameSync') return Reflect.get(target, property);
          return (source, destination) => {
            if (source === old && !raced) {
              raced = true;
              fs.renameSync(old, displaced);
              writeCoreBackup(root, path.basename(old), '0.7.2-rc.5', fs.lstatSync(displaced).mtimeMs);
            }
            return fs.renameSync(source, destination);
          };
        },
      });

      const result = runVerifiedRetention(root, current, 3, fsApi);

      assert.equal(result.status, 'WARN');
      assert.equal(result.removed.length, 0);
      assert.match(result.skipped[0].reason, /identity changed/);
      assert.equal(fs.existsSync(displaced), true);
      assert.equal(fs.existsSync(result.generations[0].moveIntent.quarantinePath), true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('never prunes backups after a changed path or an unowned current backup', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-core-retention-'));
    try {
      const old = writeCoreBackup(root, 'zylos-core-backup-2026-08-26T18-01-27-874Z', '0.7.2-rc.5', 1);
      runVerifiedRetention(root, old, 1);
      const previous = writeCoreBackup(root, 'zylos-core-backup-2026-08-26T20-38-52-743Z', '0.7.2-rc.9', 2);
      runVerifiedRetention(root, previous, 2);
      const current = writeCoreBackup(root, 'zylos-core-backup-2026-08-26T21-45-46-257Z', '0.7.2-rc.10', 3);
      const unowned = path.join(root, 'zylos-core-backup-empty');
      fs.mkdirSync(unowned);

      assert.equal(planCoreBackupRetention({
        currentBackupDir: unowned,
        tmpDir: root,
        homeDir: path.join(root, 'home'),
      }).status, 'SKIPPED');

      const reportDir = path.join(root, 'report-3');
      fs.mkdirSync(reportDir);
      const summaryPath = path.join(reportDir, 'summary.json');
      const summary = verifiedPairSummary(current, summaryPath, {
        startedAt: '2026-08-27T00:03:00.000Z',
        finishedAt: '2026-08-27T00:03:30.000Z',
        coreSha: '3'.padStart(40, '0'),
      });
      const changed = new Date(4);
      let injected = false;
      const fsApi = new Proxy(fs, {
        get(target, property) {
          if (property !== 'renameSync') return Reflect.get(target, property);
          return (source, destination) => {
            fs.renameSync(source, destination);
            if (destination === summaryPath && !injected) {
              const persisted = JSON.parse(fs.readFileSync(summaryPath, 'utf8'));
              if (persisted.backupRetention?.status === 'PLANNED') {
                injected = true;
                fs.utimesSync(old, changed, changed);
              }
            }
          };
        },
      });
      const result = executeCoreBackupRetention({
        currentBackupDir: current,
        tmpDir: root,
        homeDir: path.join(root, 'home'),
        summary,
        summaryPath,
        fsApi,
      });

      assert.equal(result.status, 'WARN');
      assert.equal(result.removed.length, 0);
      assert.equal(result.skipped.length, 1);
      assert.equal(fs.existsSync(old), true);
      assert.equal(fs.existsSync(previous), true);
      assert.equal(fs.existsSync(current), true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('never prunes a same-path same-mtime backup whose inode changed after planning', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-core-retention-'));
    try {
      const old = writeCoreBackup(root, 'zylos-core-backup-2026-08-26T18-01-27-874Z', '0.7.2-rc.5', 1);
      runVerifiedRetention(root, old, 1);
      const previous = writeCoreBackup(root, 'zylos-core-backup-2026-08-26T20-38-52-743Z', '0.7.2-rc.9', 2);
      runVerifiedRetention(root, previous, 2);
      const current = writeCoreBackup(root, 'zylos-core-backup-2026-08-26T21-45-46-257Z', '0.7.2-rc.10', 3);
      const plannedMtime = fs.lstatSync(old).mtimeMs;
      const plannedIno = fs.lstatSync(old).ino;
      const reportDir = path.join(root, 'report-3');
      fs.mkdirSync(reportDir);
      const summaryPath = path.join(reportDir, 'summary.json');
      const summary = verifiedPairSummary(current, summaryPath, {
        startedAt: '2026-08-27T00:03:00.000Z',
        finishedAt: '2026-08-27T00:03:30.000Z',
        coreSha: '3'.padStart(40, '0'),
      });
      let injected = false;
      const fsApi = new Proxy(fs, {
        get(target, property) {
          if (property !== 'renameSync') return Reflect.get(target, property);
          return (source, destination) => {
            fs.renameSync(source, destination);
            if (destination === summaryPath && !injected) {
              const persisted = JSON.parse(fs.readFileSync(summaryPath, 'utf8'));
              if (persisted.backupRetention?.status === 'PLANNED') {
                injected = true;
                // Build the replacement under a temporary name while the old
                // tree still exists, then swap by rename. Creating the
                // replacement only after rmSync is not portable: ext4 can
                // hand back the just-freed inode number, which would make
                // the recreated backup indistinguishable by inode.
                const replacementName = `${path.basename(old)}.replacement`;
                writeCoreBackup(root, replacementName, '0.7.2-rc.5', plannedMtime);
                fs.rmSync(old, { recursive: true });
                fs.renameSync(path.join(root, replacementName), old);
              }
            }
          };
        },
      });

      const result = executeCoreBackupRetention({
        currentBackupDir: current,
        tmpDir: root,
        homeDir: path.join(root, 'home'),
        summary,
        summaryPath,
        fsApi,
      });

      assert.equal(result.status, 'WARN');
      assert.equal(result.removed.length, 0);
      assert.equal(result.skipped.length, 1);
      assert.notEqual(fs.lstatSync(old).ino, plannedIno);
      assert.equal(fs.existsSync(old), true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects a backup whose zylos package signature is reached through a symlink', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-core-retention-'));
    try {
      const current = writeCoreBackup(root, 'zylos-core-backup-2026-08-26T21-45-46-257Z', '0.7.2-rc.10', 3);
      const externalPackage = path.join(root, 'external-package.json');
      fs.writeFileSync(externalPackage, JSON.stringify({ name: 'zylos', version: '0.7.2-rc.10' }));
      const packagePath = path.join(current, 'core-package', 'package.json');
      fs.rmSync(packagePath);
      fs.symlinkSync(externalPackage, packagePath);

      const plan = planCoreBackupRetention({
        currentBackupDir: current,
        tmpDir: root,
        homeDir: path.join(root, 'home'),
      });

      assert.equal(plan.status, 'SKIPPED');
      assert.equal(fs.existsSync(current), true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects backups below nested or symlinked tmp roots', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-core-retention-'));
    try {
      const nestedRoot = path.join(root, 'nested');
      fs.mkdirSync(nestedRoot);
      const nested = writeCoreBackup(nestedRoot, 'zylos-core-backup-nested', '0.7.2-rc.10', 1);
      assert.equal(planCoreBackupRetention({
        currentBackupDir: nested,
        tmpDir: root,
        homeDir: path.join(root, 'home'),
      }).status, 'SKIPPED');

      const actualRoot = path.join(root, 'actual-tmp');
      fs.mkdirSync(actualRoot);
      const current = writeCoreBackup(actualRoot, 'zylos-core-backup-current', '0.7.2-rc.10', 2);
      const linkedRoot = path.join(root, 'linked-tmp');
      fs.symlinkSync(actualRoot, linkedRoot, 'dir');
      assert.equal(planCoreBackupRetention({
        currentBackupDir: path.join(linkedRoot, path.basename(current)),
        tmpDir: linkedRoot,
        homeDir: path.join(root, 'home'),
      }).status, 'SKIPPED');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects a backup whose skills signature is a symlink', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-core-retention-'));
    try {
      const current = writeCoreBackup(root, 'zylos-core-backup-current', '0.7.2-rc.10', 1);
      const externalSkills = path.join(root, 'external-skills');
      fs.mkdirSync(externalSkills);
      const skillsPath = path.join(current, 'skills');
      fs.rmSync(skillsPath, { recursive: true });
      fs.symlinkSync(externalSkills, skillsPath, 'dir');

      assert.equal(planCoreBackupRetention({
        currentBackupDir: current,
        tmpDir: root,
        homeDir: path.join(root, 'home'),
      }).status, 'SKIPPED');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('does not allow retention below current plus latest prior', () => {
    assert.throws(
      () => planCoreBackupRetention({ retain: 1 }),
      /between 2 and 10/,
    );
  });

  it('requires an exact normalized quarantine path in the retention authorization', () => {
    const quarantinePath = path.join(os.tmpdir(), '.zylos-core-retention-quarantine-test');
    const authorization = retentionRepairAuthorization(quarantinePath);
    assert.deepEqual(
      validateRetentionRepairAuthorization({ quarantinePath, authorization }),
      { ok: true, approvedPath: quarantinePath, authorizedBy: 'user' },
    );
    assert.equal(validateRetentionRepairAuthorization({
      quarantinePath: `${quarantinePath}/..`,
      authorization,
    }).ok, false);
    assert.equal(validateRetentionRepairAuthorization({
      quarantinePath,
      authorization: {
        ...authorization,
        retentionAuthorization: {
          ...authorization.retentionAuthorization,
          mustMatchExactly: false,
        },
      },
    }).ok, false);
  });
});

describe('pinned HXA recovery contract', () => {
  it('accepts only the SS agent and an immutable Core script SHA', () => {
    assert.deepEqual(validatePinnedHxaRecoveryTarget({
      coreSha: CORE_SHA,
      agent: 'ss',
    }), { ok: true });
    assert.equal(validatePinnedHxaRecoveryTarget({
      coreSha: 'main',
      agent: 'ss',
    }).ok, false);
    assert.equal(validatePinnedHxaRecoveryTarget({
      coreSha: CORE_SHA,
      agent: 'other',
    }).ok, false);
  });

  it('requires the exact HXA 1.7.3 package and runtime files', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-hxa-source-'));
    try {
      fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({
        name: 'zylos-hxa-connect',
        version: '1.7.3',
      }));
      for (const relativePath of [
        'SKILL.md',
        'src/bot.js',
        'scripts/cli.js',
        'ecosystem.config.cjs',
      ]) {
        const filePath = path.join(root, relativePath);
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, 'fixture\n');
      }

      assert.equal(validateHxaSource(root).ok, true);
      fs.rmSync(path.join(root, 'src', 'bot.js'));
      assert.match(validateHxaSource(root).error, /src\/bot\.js/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('accepts the historic upstream route but rejects version and path drift', () => {
    const zylosDir = '/home/cocoai/zylos';
    const valid = {
      version: '1.7.3',
      repo: 'coco-xyz/zylos-hxa-connect',
      skillDir: `${zylosDir}/.claude/skills/hxa-connect`,
      dataDir: `${zylosDir}/components/hxa-connect`,
    };
    assert.equal(validateHxaRegistryEntry(valid, zylosDir).ok, true);
    assert.equal(validateHxaRegistryEntry({ ...valid, version: '1.7.2' }, zylosDir).ok, false);
    assert.equal(validateHxaRegistryEntry({ ...valid, dataDir: '/tmp/wrong' }, zylosDir).ok, false);
  });

  it('rejects PM2 fake-online state and executable drift', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-hxa-pm2-'));
    try {
      const entry = path.join(root, 'src', 'bot.js');
      fs.mkdirSync(path.dirname(entry), { recursive: true });
      fs.writeFileSync(entry, 'fixture\n');
      assert.equal(validateHxaPm2Process({
        status: 'online',
        pid: 123,
        execPath: entry,
      }, entry).ok, true);
      assert.equal(validateHxaPm2Process({
        status: 'online',
        pid: null,
        execPath: entry,
      }, entry).ok, false);
      assert.equal(validateHxaPm2Process({
        status: 'online',
        pid: 123,
        execPath: path.join(root, 'wrong.js'),
      }, entry).ok, false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('lets the HXA CLI select the configured default org for live probes', () => {
    assert.deepEqual(buildHxaProbeCommands('/opt/hxa/scripts/cli.js'), [
      { name: 'profile', args: ['/opt/hxa/scripts/cli.js', 'profile'] },
      { name: 'peers', args: ['/opt/hxa/scripts/cli.js', 'peers'] },
    ]);
  });
});

describe('SS upgrade-blocker recovery contract', () => {
  it('pins the exact historic WeChat and WeCom releases', () => {
    assert.deepEqual(SS_BLOCKER_TARGETS.map((target) => ({
      component: target.component,
      version: target.version,
      sha: target.sha,
    })), [
      {
        component: 'wechat',
        version: '0.3.2',
        sha: '67f5142b92e0d67563ac00e3c9e245350e58b280',
      },
      {
        component: 'wecom',
        version: '0.1.5',
        sha: '781a51f957ee38bdfa48939b4e3d1c52d70f0722',
      },
    ]);
    assert.equal(validatePinnedBlockerRecoveryTarget({
      coreSha: CORE_SHA,
      agent: 'ss',
    }).ok, true);
    assert.equal(validatePinnedBlockerRecoveryTarget({
      coreSha: 'main',
      agent: 'ss',
    }).ok, false);
  });

  for (const target of SS_BLOCKER_TARGETS) {
    it(`validates the exact ${target.component} archive, registry, and PM2 entry`, () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), `zylos-${target.component}-`));
      try {
        fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({
          name: target.packageName,
          version: target.version,
        }));
        for (const relativePath of ['SKILL.md', target.entry, 'ecosystem.config.cjs']) {
          const filePath = path.join(root, relativePath);
          fs.mkdirSync(path.dirname(filePath), { recursive: true });
          fs.writeFileSync(filePath, 'fixture\n');
        }
        assert.equal(validateRequiredComponentSource(root, target).ok, true);

        const zylosDir = '/home/cocoai/zylos';
        assert.equal(validateRequiredComponentRegistry({
          repo: target.repo,
          version: target.version,
          skillDir: `${zylosDir}/.claude/skills/${target.component}`,
          dataDir: `${zylosDir}/components/${target.component}`,
        }, target, zylosDir).ok, true);
        assert.equal(validateRequiredComponentRegistry({
          repo: target.repo,
          version: 'wrong',
        }, target, zylosDir).ok, false);

        const expectedExecPath = path.join(root, target.entry);
        assert.equal(validateRequiredComponentPm2({
          status: 'online',
          pid: 456,
          execPath: expectedExecPath,
        }, target, expectedExecPath).ok, true);
        assert.equal(validateRequiredComponentPm2({
          status: 'online',
          pid: null,
          execPath: expectedExecPath,
        }, target, expectedExecPath).ok, false);
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    });
  }
});
