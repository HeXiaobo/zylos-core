import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import {
  buildUpgradeCommands,
  executeCoreBackupRetention,
  planCoreBackupRetention,
  planPm2PreflightRepairs,
  pathsReferToSameFile as upgradePathsReferToSameFile,
  validateCoreSource,
  validateFeishuSource,
  validatePm2Snapshot,
  validatePinnedTarget,
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
      'task-reminder': 1,
    },
  }));
  for (const relativePath of [
    'skills/comm-bridge/scripts/c4-send.js',
    'skills/comm-bridge/scripts/c4-receive.js',
    'skills/comm-bridge/scripts/c4-dispatcher.js',
    'skills/comm-bridge/scripts/c4-response-stream-supervisor.js',
    'skills/activity-monitor/scripts/assistant-turn-binding.js',
    'scripts/upgrade-fork-pair.js',
    'scripts/upgrade-fork-pair.sh',
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
                fs.rmSync(old, { recursive: true });
                writeCoreBackup(root, path.basename(old), '0.7.2-rc.5', plannedMtime);
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
