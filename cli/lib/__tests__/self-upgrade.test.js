import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

const {
  resolveCoreRepository,
  createFinalizeState,
  runSelfUpgrade,
  runSelfUpgradeFinalize,
  step0_verifyTargetCommunicationCompatibility,
  step1_backupCoreSkills,
  step5_syncCoreSkills,
  step13_verifyCommunicationContinuity,
  step14_commitSkillBaselines,
  step7_syncInstructions,
  rollbackSelf,
  resolveSelfUpgradeFinalizerTimeoutMs,
  step10_ensureCodexConfig,
} = await import('../self-upgrade.js');
const { generateMigrationHints, applyMigrationHints } = await import('../self-upgrade.js');
const { deployManifestTemplate } = await import('../runtime/tmux-env.js');
const { activateFreshSplitInstructions } = await import('../runtime/instruction-builder.js');

function fixtureZylosDir() {
  return path.resolve(process.env.ZYLOS_DIR || path.join(os.homedir(), 'zylos'));
}

function zylosHookPath(relativePath) {
  return path.join(fixtureZylosDir(), '.claude', relativePath).replaceAll('\\', '/');
}

function writeSplitPackage(pkgRoot) {
  const templatesDir = path.join(pkgRoot, 'templates');
  const runtimeDir = path.join(pkgRoot, 'cli', 'lib', 'runtime');
  fs.mkdirSync(templatesDir, { recursive: true });
  fs.mkdirSync(runtimeDir, { recursive: true });
  fs.writeFileSync(path.join(templatesDir, 'claude-system.md'), '# Claude system\n');
  fs.writeFileSync(path.join(templatesDir, 'codex-system.md'), '# Codex system\n');
  fs.writeFileSync(path.join(templatesDir, 'onboarding.md'), '# Onboarding\n');
  fs.copyFileSync(path.resolve('cli/lib/runtime/assembler.mjs'), path.join(runtimeDir, 'assembler.mjs'));
}

const TARGET_COMMUNICATION_ASSETS = [
  'skills/comm-bridge/scripts/c4-send.js',
  'skills/comm-bridge/scripts/c4-outbound-policy.js',
  'skills/comm-bridge/scripts/c4-receive.js',
  'skills/comm-bridge/scripts/c4-dispatcher.js',
  'skills/comm-bridge/scripts/c4-response-stream-supervisor.js',
  'skills/activity-monitor/scripts/assistant-turn-binding.js',
];

function writeTargetCommunicationAssets(root, assets = TARGET_COMMUNICATION_ASSETS) {
  for (const relativePath of assets) {
    const filePath = path.join(root, relativePath);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, '#!/usr/bin/env node\n');
  }
}

function emptyExactSkillsInventory(root = '/tmp/live-skills') {
  return {
    schemaVersion: 2,
    root,
    skills: [],
  };
}

describe('self-upgrade repository routing', () => {
  it('defaults fork builds to their own release repository', () => {
    assert.equal(resolveCoreRepository({
      processEnv: {},
      readEnv: () => new Map(),
    }), 'HeXiaobo/zylos-core');
  });

  it('loads the fork repository from the configured Zylos directory', () => {
    const zylosDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-core-repo-'));
    const alternateHome = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-core-home-'));
    fs.writeFileSync(
      path.join(zylosDir, '.env'),
      'ZYLOS_SELF_UPGRADE_REPO=HeXiaobo/zylos-core\n',
    );

    const moduleUrl = new URL('../self-upgrade.js', import.meta.url).href;
    const childEnv = {
      ...process.env,
      HOME: alternateHome,
      ZYLOS_DIR: zylosDir,
    };
    delete childEnv.ZYLOS_SELF_UPGRADE_REPO;
    const result = spawnSync(process.execPath, [
      '--input-type=module',
      '--eval',
      `import { CORE_REPO } from ${JSON.stringify(moduleUrl)}; process.stdout.write(CORE_REPO);`,
    ], {
      cwd: alternateHome,
      env: childEnv,
      encoding: 'utf8',
    });

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, 'HeXiaobo/zylos-core');
  });

  it('exports the configured fork repository for every core upgrade consumer', () => {
    const zylosDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-core-override-'));
    fs.writeFileSync(
      path.join(zylosDir, '.env'),
      'ZYLOS_SELF_UPGRADE_REPO=Other/core\n',
    );
    const moduleUrl = new URL('../self-upgrade.js', import.meta.url).href;
    const result = spawnSync(process.execPath, [
      '--input-type=module',
      '--eval',
      `import { CORE_REPO } from ${JSON.stringify(moduleUrl)}; process.stdout.write(CORE_REPO);`,
    ], {
      env: {
        ...process.env,
        ZYLOS_DIR: zylosDir,
        ZYLOS_SELF_UPGRADE_REPO: 'HeXiaobo/zylos-core',
      },
      encoding: 'utf8',
    });

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, 'HeXiaobo/zylos-core');
  });

  it('retains fork routing when persisted configuration is unreadable', () => {
    assert.equal(resolveCoreRepository({
      processEnv: {},
      readEnv: () => {
        throw new Error('permission denied');
      },
    }), 'HeXiaobo/zylos-core');
  });
});

describe('self-upgrade finalizer handoff', () => {
  it('never accepts a zero or undersized finalizer timeout budget', () => {
    assert.equal(resolveSelfUpgradeFinalizerTimeoutMs({
      ZYLOS_SELF_UPGRADE_FINALIZER_TIMEOUT_MS: '0',
    }), 900_000);
    assert.equal(resolveSelfUpgradeFinalizerTimeoutMs({
      ZYLOS_SELF_UPGRADE_FINALIZER_TIMEOUT_MS: '1',
    }), 180_000);
    assert.equal(resolveSelfUpgradeFinalizerTimeoutMs({
      ZYLOS_SELF_UPGRADE_FINALIZER_TIMEOUT_MS: '600000',
    }), 600_000);
  });

  it('serializes the state needed by the newly installed finalizer', () => {
    const preUpgradeSkillsInventory = emptyExactSkillsInventory();
    assert.deepEqual(createFinalizeState({
      tempDir: '/tmp/new-core',
      backupDir: '/tmp/backup',
      globalCoreDir: '/opt/node/lib/node_modules/zylos',
      servicesWereRunning: ['activity-monitor', 'c4-dispatcher'],
      cronServicesWereRunning: ['task-comment-bridge'],
      from: '0.4.12',
      to: '0.4.13',
      newVersion: '0.4.13',
      mode: 'merge',
      preUpgradeSkillsInventory,
    }), {
      schemaVersion: 1,
      tempDir: '/tmp/new-core',
      backupDir: '/tmp/backup',
      globalCoreDir: '/opt/node/lib/node_modules/zylos',
      servicesWereRunning: ['activity-monitor', 'c4-dispatcher'],
      cronServicesWereRunning: ['task-comment-bridge'],
      from: '0.4.12',
      to: '0.4.13',
      newVersion: '0.4.13',
      mode: 'merge',
      preUpgradeSkillsInventory,
    });
  });

  it('runs post-install steps with restored state and returns upgrade metadata', () => {
    const calls = [];
    const result = runSelfUpgradeFinalize({
      schemaVersion: 1,
      tempDir: '/tmp/new-core',
      backupDir: '/tmp/backup',
      globalCoreDir: '/opt/node/lib/node_modules/zylos',
      servicesStopped: ['activity-monitor'],
      servicesWereRunning: ['activity-monitor'],
      from: '0.4.12',
      to: '0.4.13',
      mode: 'merge',
      preUpgradeSkillsInventory: emptyExactSkillsInventory(),
    }, {
      steps: [
        (ctx) => {
          calls.push({
            tempDir: ctx.tempDir,
            backupDir: ctx.backupDir,
            globalCoreDir: ctx.globalCoreDir,
            servicesWereRunning: ctx.servicesWereRunning,
            mode: ctx.mode,
          });
          return { step: 5, name: 'sync_core_skills', status: 'done', message: 'ok' };
        },
      ],
    });

    assert.equal(result.success, true);
    assert.equal(result.from, '0.4.12');
    assert.equal(result.to, '0.4.13');
    assert.equal(result.backupDir, '/tmp/backup');
    assert.equal(result.steps.length, 1);
    assert.deepEqual(calls, [{
      tempDir: '/tmp/new-core',
      backupDir: '/tmp/backup',
      globalCoreDir: '/opt/node/lib/node_modules/zylos',
      servicesWereRunning: ['activity-monitor'],
      mode: 'merge',
    }]);
  });

  it('fails closed before post-install mutation for a legacy finalizer state without an exact skills manifest', () => {
    let postInstallStarted = false;
    let rollbackStarted = false;

    const result = runSelfUpgradeFinalize({
      schemaVersion: 1,
      tempDir: '/tmp/new-core',
      backupDir: '/tmp/backup',
      globalCoreDir: '/opt/node/lib/node_modules/zylos',
      servicesWereRunning: ['activity-monitor'],
      from: '0.7.2-rc.10',
      to: '0.7.2-rc.11',
      mode: 'merge',
    }, {
      steps: [() => {
        postInstallStarted = true;
        return { step: 5, name: 'sync_core_skills', status: 'done' };
      }],
      rollbackSelf: () => {
        rollbackStarted = true;
        return [];
      },
    });

    assert.equal(result.success, false);
    assert.equal(result.failedStep, 5);
    assert.match(result.error, /pre-mutation skills inventory/i);
    assert.equal(postInstallStarted, false);
    assert.equal(rollbackStarted, true);
  });

  it('rolls back when a post-install step fails', () => {
    const rollbackCalls = [];
    const result = runSelfUpgradeFinalize({
      schemaVersion: 1,
      tempDir: '/tmp/new-core',
      backupDir: '/tmp/backup',
      servicesWereRunning: ['activity-monitor'],
      from: '0.4.12',
      to: '0.4.13',
      preUpgradeSkillsInventory: emptyExactSkillsInventory(),
    }, {
      steps: [
        () => ({ step: 5, name: 'sync_core_skills', status: 'failed', error: 'sync failed' }),
      ],
      rollbackSelf: (ctx) => {
        rollbackCalls.push(ctx.backupDir);
        return [{ action: 'restore_core_skills', success: true }];
      },
    });

    assert.equal(result.success, false);
    assert.equal(result.failedStep, 5);
    assert.equal(result.error, 'sync failed');
    assert.deepEqual(rollbackCalls, ['/tmp/backup']);
    assert.deepEqual(result.rollback, {
      performed: true,
      steps: [{ action: 'restore_core_skills', success: true }],
    });
  });

  it('rolls back when the installed finalizer crashes before returning a result', () => {
    const rollbackCalls = [];
    const result = runSelfUpgrade({
      tempDir: '/tmp/new-core',
      newVersion: '0.4.13',
    }, {
      getCurrentVersion: () => ({ success: true, version: '0.4.12' }),
      preInstallSteps: [
        (ctx) => {
          ctx.backupDir = '/tmp/backup';
          ctx.servicesWereRunning = ['c4-dispatcher'];
          return { step: 1, name: 'backup_core_skills', status: 'done' };
        },
      ],
      runInstalledFinalizer: () => {
        throw new Error('finalizer crashed');
      },
      rollbackSelf: (ctx) => {
        rollbackCalls.push(ctx.backupDir);
        return [{ action: 'restore_core_skills', success: true }];
      },
    });

    assert.equal(result.success, false);
    assert.equal(result.failedStep, 5);
    assert.match(result.error, /finalizer crashed/);
    assert.deepEqual(rollbackCalls, ['/tmp/backup']);
    assert.equal(result.rollback.performed, true);
  });

  it('reports the real elapsed duration and bounded budget when the finalizer times out', () => {
    const moments = [1_000, 13_345];
    const timeout = new Error('spawnSync node ETIMEDOUT');
    timeout.code = 'ETIMEDOUT';

    const result = runSelfUpgrade({
      tempDir: '/tmp/new-core',
      newVersion: '0.4.13',
    }, {
      getCurrentVersion: () => ({ success: true, version: '0.4.12' }),
      preInstallSteps: [
        () => ({ step: 4, name: 'npm_install_global', status: 'done' }),
      ],
      now: () => moments.shift(),
      runInstalledFinalizer: (_ctx, { timeoutMs }) => {
        assert.equal(timeoutMs, 900_000);
        throw timeout;
      },
      rollbackSelf: () => [],
    });

    assert.equal(result.success, false);
    assert.equal(result.steps.at(-1).duration, 12_345);
    assert.match(result.error, /timed out after 900s/);
  });
});

describe('self-upgrade communication continuity gate', () => {
  it('accepts a target that declares rolling reply compatibility', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-core-target-'));
    try {
      fs.writeFileSync(path.join(tempDir, 'capabilities.json'), JSON.stringify({
        schemaVersion: 1,
        product: 'zylos-core',
        protocols: { 'c4.reply.argv-compat': 1, 'c4.reply.body-file': 1 },
      }));
      writeTargetCommunicationAssets(tempDir);

      const result = step0_verifyTargetCommunicationCompatibility({ tempDir });

      assert.equal(result.status, 'done');
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('rejects a target without rolling reply compatibility before mutation', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-core-target-'));
    try {
      fs.writeFileSync(path.join(tempDir, 'capabilities.json'), JSON.stringify({
        schemaVersion: 1,
        product: 'zylos-core',
        protocols: { 'c4.reply': 2 },
      }));

      const result = step0_verifyTargetCommunicationCompatibility({ tempDir });

      assert.equal(result.status, 'failed');
      assert.match(result.error, /c4\.reply\.argv-compat requires >= 1, found missing/);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('rejects a target without the safe body-file reply transport before mutation', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-core-target-'));
    try {
      fs.writeFileSync(path.join(tempDir, 'capabilities.json'), JSON.stringify({
        schemaVersion: 1,
        product: 'zylos-core',
        protocols: { 'c4.reply.argv-compat': 1 },
      }));
      writeTargetCommunicationAssets(tempDir);

      const result = step0_verifyTargetCommunicationCompatibility({ tempDir });

      assert.equal(result.status, 'failed');
      assert.match(result.error, /c4\.reply\.body-file requires >= 1, found missing/);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('rejects a target that omits a critical receive entrypoint before mutation', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-core-target-'));
    try {
      fs.writeFileSync(path.join(tempDir, 'capabilities.json'), JSON.stringify({
        schemaVersion: 1,
        product: 'zylos-core',
        protocols: { 'c4.reply.argv-compat': 1, 'c4.reply.body-file': 1 },
      }));
      writeTargetCommunicationAssets(
        tempDir,
        TARGET_COMMUNICATION_ASSETS.filter((asset) => !asset.endsWith('/c4-receive.js')),
      );

      const result = step0_verifyTargetCommunicationCompatibility({ tempDir });

      assert.equal(result.status, 'failed');
      assert.match(result.error, /c4-receive\.js/);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('rejects a skill sync that leaves a critical receive entrypoint undeployed', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-core-sync-target-'));
    const zylosDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-core-sync-live-'));
    const skillsDir = path.join(zylosDir, '.claude', 'skills');
    try {
      writeTargetCommunicationAssets(tempDir);
      const result = step5_syncCoreSkills({ tempDir, mode: 'merge' }, {
        zylosDir,
        skillsDir,
        syncCoreSkills: () => ({
          synced: [], added: [], merged: [], deleted: [], preserved: [],
          conflicts: [], errors: [], pendingBaselines: [],
        }),
      });

      assert.equal(result.status, 'failed');
      assert.match(result.error, /c4-receive\.js/);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
      fs.rmSync(zylosDir, { recursive: true, force: true });
    }
  });

  it('passes a strict runtime when safe transports and argv rejection are verified', () => {
    const result = step13_verifyCommunicationContinuity({}, {
      verify: () => ({
        compatible: true,
        checks: [
          { name: 'stdin_reply', status: 'passed' },
          { name: 'body_file_reply', status: 'passed' },
          { name: 'legacy_argv_reply', status: 'passed', mode: 'strict_rejection' },
        ],
      }),
    });

    assert.equal(result.status, 'done');
    assert.equal(result.message, 'stdin_reply, body_file_reply, legacy_argv_reply');
  });

  it('fails the upgrade when a reply contract is broken', () => {
    const result = step13_verifyCommunicationContinuity({}, {
      verify: () => ({
        compatible: false,
        checks: [
          { name: 'stdin_reply', status: 'passed' },
          { name: 'legacy_argv_reply', status: 'failed' },
        ],
        error: 'legacy_argv_reply exited 2',
      }),
    });

    assert.equal(result.status, 'failed');
    assert.match(result.error, /legacy_argv_reply exited 2/);
  });
});

describe('step10_ensureCodexConfig', () => {
  it('skips codex config write when non-codex runtime has no codex state', () => {
    const result = step10_ensureCodexConfig({
      cfg: { runtime: 'claude' },
      codexDir: '/tmp/fake-codex-none',
      existsSync: () => false,
      writeConfig: () => {
        throw new Error('should not be called');
      }
    });

    assert.equal(result.status, 'skipped');
    assert.equal(result.message, 'codex not in use');
  });

  it('treats codex config write failure as best-effort outside codex runtime', () => {
    const result = step10_ensureCodexConfig({
      cfg: { runtime: 'claude' },
      codexDir: '/tmp/fake-codex',
      existsSync: () => true,
      writeConfig: () => false
    });

    assert.equal(result.status, 'skipped');
    assert.match(result.message, /warning: failed to refresh codex config outside codex runtime/);
  });

  it('still fails when codex runtime cannot write codex config', () => {
    const result = step10_ensureCodexConfig({
      cfg: { runtime: 'codex' },
      codexDir: '/tmp/fake-codex',
      existsSync: () => true,
      writeConfig: () => false
    });

    assert.equal(result.status, 'failed');
    assert.equal(result.error, 'failed to write codex config');
  });
});

// These cases require a globally installed Core package that the test resolves
// from `npm ls -g` (or `ZYLOS_DIR`). Hosted CI runners have no such install,
// so the suite is opt-in via ZYLOS_E2E_SELF_UPGRADE=1.
const E2E_SELF_UPGRADE = process.env.ZYLOS_E2E_SELF_UPGRADE === '1';
const e2eDescribe = E2E_SELF_UPGRADE ? describe : describe.skip;

e2eDescribe('self-upgrade backup and rollback', () => {
  it('fails before live mutation when the transaction backup omits an existing top-level skill', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-self-upgrade-incomplete-skills-backup-'));
    const skillsDir = path.join(tmpDir, 'live-skills');
    const targetDir = path.join(tmpDir, 'target');
    const backupDir = path.join(tmpDir, 'backup');
    let mutationStarted = false;
    let capturedContext = null;

    fs.mkdirSync(path.join(skillsDir, 'core-skill'), { recursive: true });
    fs.mkdirSync(path.join(skillsDir, 'foreign-skill', 'scripts'), { recursive: true });
    fs.mkdirSync(path.join(skillsDir, 'foreign-skill', 'node_modules', 'fixture'), { recursive: true });
    fs.mkdirSync(path.join(skillsDir, 'foreign-skill', '.backup', 'old'), { recursive: true });
    fs.mkdirSync(path.join(targetDir, 'skills', 'core-skill'), { recursive: true });
    fs.writeFileSync(path.join(skillsDir, 'core-skill', 'SKILL.md'), '# Core\n');
    fs.writeFileSync(path.join(skillsDir, 'foreign-skill', 'SKILL.md'), [
      '---',
      'name: foreign-skill',
      'lifecycle:',
      '  service:',
      '    entry: scripts/server.js',
      '---',
      '',
    ].join('\n'));
    fs.writeFileSync(path.join(skillsDir, 'foreign-skill', 'scripts', 'server.js'), 'old server\n');
    fs.writeFileSync(path.join(skillsDir, 'foreign-skill', 'node_modules', 'fixture', 'index.js'), 'ignored\n');
    fs.writeFileSync(path.join(skillsDir, 'foreign-skill', '.backup', 'old', 'server.js'), 'ignored\n');

    const result = runSelfUpgrade({ tempDir: targetDir, newVersion: '0.7.2-rc.11' }, {
      getCurrentVersion: () => ({ success: true, version: '0.7.2-rc.10' }),
      preInstallSteps: [
        (ctx) => {
          capturedContext = ctx;
          return step1_backupCoreSkills(ctx, {
            zylosDir: path.join(tmpDir, 'zylos'),
            skillsDir,
            backupDir,
            copyTree: (src, dest, options) => {
              if (src !== skillsDir) {
                fs.cpSync(src, dest, { recursive: true });
                return;
              }
              fs.mkdirSync(path.join(dest, 'core-skill'), { recursive: true });
              fs.copyFileSync(
                path.join(src, 'core-skill', 'SKILL.md'),
                path.join(dest, 'core-skill', 'SKILL.md'),
              );
              assert.deepEqual(options, { excludes: ['node_modules'] });
          },
          installedCoreSkillsDir: path.join(targetDir, 'skills'),
        });
        },
        () => {
          mutationStarted = true;
          return { step: 4, name: 'npm_install_global', status: 'done' };
        },
      ],
      runInstalledFinalizer: () => ({ success: true, steps: [] }),
      rollbackSelf: () => [],
    });

    assert.equal(result.success, false);
    assert.equal(result.failedStep, 1);
    assert.match(result.error, /backup.*foreign-skill/i);
    assert.equal(mutationStarted, false);
    assert.deepEqual(
      capturedContext.preUpgradeSkillsInventory.skills.map(({ name }) => name),
      ['core-skill', 'foreign-skill'],
    );
    assert.equal(
      capturedContext.preUpgradeSkillsInventory.skills.find(({ name }) => name === 'foreign-skill')
        .declaredScripts[0].path,
      'scripts/server.js',
    );
    assert.equal(
      capturedContext.preUpgradeSkillsInventory.skills.find(({ name }) => name === 'foreign-skill')
        .fileCount,
      2,
    );

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('fails before live mutation when a same-shape skills backup has corrupted bytes', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-self-upgrade-corrupt-skills-backup-'));
    const skillsDir = path.join(tmpDir, 'live-skills');
    const targetDir = path.join(tmpDir, 'target');
    const backupDir = path.join(tmpDir, 'backup');
    const skillDir = path.join(skillsDir, 'foreign-skill');

    fs.mkdirSync(skillDir, { recursive: true });
    fs.mkdirSync(path.join(targetDir, 'skills', 'core-skill'), { recursive: true });
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '# Foreign\n');
    fs.writeFileSync(path.join(skillDir, 'local-config.json'), '{"keep":true}\n');

    const result = step1_backupCoreSkills({ tempDir: targetDir }, {
      zylosDir: path.join(tmpDir, 'zylos'),
      skillsDir,
      backupDir,
      copyTree: (src, dest) => {
        fs.cpSync(src, dest, { recursive: true });
        fs.writeFileSync(path.join(dest, 'foreign-skill', 'local-config.json'), '{"keep":FAIL}\n');
      },
    });

    assert.equal(result.status, 'failed');
    assert.match(result.error, /backup.*foreign-skill.*local-config\.json.*sha256/i);

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('fails and rolls back when Core sync deletes a foreign skill directory', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-self-upgrade-foreign-skill-delete-'));
    const liveRoot = path.join(tmpDir, 'live');
    const skillsDir = path.join(liveRoot, 'skills');
    const targetDir = path.join(tmpDir, 'target');
    const backupDir = path.join(tmpDir, 'backup');
    const foreignSkillDir = path.join(skillsDir, 'foreign-skill');

    writeTargetCommunicationAssets(liveRoot);
    writeTargetCommunicationAssets(targetDir);
    fs.mkdirSync(path.join(foreignSkillDir, 'scripts'), { recursive: true });
    fs.writeFileSync(path.join(foreignSkillDir, 'SKILL.md'), [
      '---',
      'name: foreign-skill',
      'lifecycle:',
      '  service:',
      '    entry: scripts/server.js',
      '---',
      '',
    ].join('\n'));
    fs.writeFileSync(path.join(foreignSkillDir, 'scripts', 'server.js'), 'foreign server\n');
    fs.writeFileSync(path.join(foreignSkillDir, 'local-config.json'), '{"keep":true}\n');

    const backupContext = {
      tempDir: targetDir,
      newVersion: '0.7.2-rc.11',
      mode: 'merge',
      servicesWereRunning: [],
      cronServicesWereRunning: [],
      from: '0.7.2-rc.10',
      to: '0.7.2-rc.11',
    };
    const backup = step1_backupCoreSkills(backupContext, {
      zylosDir: liveRoot,
      skillsDir,
      backupDir,
      installedCoreSkillsDir: path.join(targetDir, 'skills'),
    });
    assert.equal(backup.status, 'done');
    assert.equal(
      backupContext.preUpgradeSkillsInventory.skills
        .find(({ name }) => name === 'foreign-skill').ownedByTarget,
      false,
    );

    const result = runSelfUpgradeFinalize(createFinalizeState(backupContext), {
      steps: [
        (ctx) => step5_syncCoreSkills(ctx, {
          zylosDir: liveRoot,
          skillsDir,
          syncCoreSkills: () => {
            fs.rmSync(foreignSkillDir, { recursive: true, force: true });
            return {
              synced: [], added: [], merged: [], deleted: [], preserved: [],
              conflicts: [], errors: [], pendingBaselines: [],
            };
          },
        }),
      ],
      rollbackSelf: (ctx) => rollbackSelf(ctx, {
        zylosDir: liveRoot,
        skillsDir,
      }),
    });

    assert.equal(result.success, false);
    assert.equal(result.failedStep, 5);
    assert.match(result.error, /foreign-skill.*top-level directory missing/i);
    assert.equal(result.rollback.performed, true);
    assert.equal(fs.readFileSync(path.join(foreignSkillDir, 'scripts', 'server.js'), 'utf8'), 'foreign server\n');

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('fails and rolls back when a foreign declared script is replaced without reducing file counts', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-self-upgrade-foreign-script-delete-'));
    const liveRoot = path.join(tmpDir, 'live');
    const skillsDir = path.join(liveRoot, 'skills');
    const targetDir = path.join(tmpDir, 'target');
    const backupDir = path.join(tmpDir, 'backup');
    const foreignSkillDir = path.join(skillsDir, 'foreign-skill');
    const declaredScript = path.join(foreignSkillDir, 'scripts', 'server.js');
    const replacementScript = path.join(foreignSkillDir, 'scripts', 'replacement.js');

    writeTargetCommunicationAssets(liveRoot);
    writeTargetCommunicationAssets(targetDir);
    fs.mkdirSync(path.dirname(declaredScript), { recursive: true });
    fs.writeFileSync(path.join(foreignSkillDir, 'SKILL.md'), [
      '---',
      'name: foreign-skill',
      'lifecycle:',
      '  service:',
      '    entry: scripts/server.js',
      '---',
      '',
    ].join('\n'));
    fs.writeFileSync(declaredScript, 'foreign server\n');

    const backupContext = {
      tempDir: targetDir,
      newVersion: '0.7.2-rc.11',
      mode: 'merge',
      servicesWereRunning: [],
      cronServicesWereRunning: [],
      from: '0.7.2-rc.10',
      to: '0.7.2-rc.11',
    };
    assert.equal(step1_backupCoreSkills(backupContext, {
      zylosDir: liveRoot,
      skillsDir,
      backupDir,
      installedCoreSkillsDir: path.join(targetDir, 'skills'),
    }).status, 'done');

    const result = runSelfUpgradeFinalize(createFinalizeState(backupContext), {
      steps: [
        (ctx) => step5_syncCoreSkills(ctx, {
          zylosDir: liveRoot,
          skillsDir,
          syncCoreSkills: () => {
            fs.rmSync(declaredScript);
            fs.writeFileSync(replacementScript, 'replacement\n');
            return {
              synced: [], added: [], merged: [], deleted: [], preserved: [],
              conflicts: [], errors: [], pendingBaselines: [],
            };
          },
        }),
      ],
      rollbackSelf: (ctx) => rollbackSelf(ctx, {
        zylosDir: liveRoot,
        skillsDir,
      }),
    });

    assert.equal(result.success, false);
    assert.match(result.error, /foreign-skill.*declared script missing.*scripts\/server\.js/i);
    assert.equal(fs.readFileSync(declaredScript, 'utf8'), 'foreign server\n');
    assert.equal(fs.existsSync(replacementScript), false);

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('rejects a foreign skill file-count collapse even when the directory and critical paths remain', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-self-upgrade-foreign-file-collapse-'));
    const skillsDir = path.join(tmpDir, 'live-skills');
    const targetDir = path.join(tmpDir, 'target');
    const backupDir = path.join(tmpDir, 'backup');
    const foreignSkillDir = path.join(skillsDir, 'foreign-skill');

    fs.mkdirSync(path.join(foreignSkillDir, 'scripts'), { recursive: true });
    fs.mkdirSync(path.join(targetDir, 'skills', 'core-skill'), { recursive: true });
    fs.writeFileSync(path.join(foreignSkillDir, 'SKILL.md'), '# Foreign\n');
    fs.writeFileSync(path.join(foreignSkillDir, 'scripts', 'server.js'), 'server\n');
    fs.writeFileSync(path.join(foreignSkillDir, 'local-config.json'), '{"keep":true}\n');

    const ctx = { tempDir: targetDir, mode: 'merge' };
    assert.equal(step1_backupCoreSkills(ctx, {
      zylosDir: path.join(tmpDir, 'zylos'),
      skillsDir,
      backupDir,
    }).status, 'done');

    fs.rmSync(path.join(foreignSkillDir, 'local-config.json'));
    const result = step14_commitSkillBaselines(ctx, { skillsDir });

    assert.equal(result.status, 'failed');
    assert.match(result.error, /foreign-skill.*file count collapsed from 3 to 2/i);

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('rejects a one-for-one replacement of an undeclared foreign skill file', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-self-upgrade-foreign-file-replacement-'));
    const skillsDir = path.join(tmpDir, 'live-skills');
    const targetDir = path.join(tmpDir, 'target');
    const foreignSkillDir = path.join(skillsDir, 'foreign-skill');

    fs.mkdirSync(path.join(foreignSkillDir, 'scripts'), { recursive: true });
    fs.mkdirSync(path.join(targetDir, 'skills', 'core-skill'), { recursive: true });
    fs.writeFileSync(path.join(foreignSkillDir, 'SKILL.md'), '# Foreign\n');
    fs.writeFileSync(path.join(foreignSkillDir, 'scripts', 'server.js'), 'server\n');
    fs.writeFileSync(path.join(foreignSkillDir, 'local-config.json'), '{"keep":true}\n');

    const ctx = { tempDir: targetDir, mode: 'merge' };
    assert.equal(step1_backupCoreSkills(ctx, {
      zylosDir: path.join(tmpDir, 'zylos'),
      skillsDir,
      backupDir: path.join(tmpDir, 'backup'),
    }).status, 'done');

    fs.rmSync(path.join(foreignSkillDir, 'local-config.json'));
    fs.writeFileSync(path.join(foreignSkillDir, 'replacement.json'), '{"junk":true}\n');
    const result = step14_commitSkillBaselines(ctx, { skillsDir });

    assert.equal(result.status, 'failed');
    assert.match(result.error, /foreign-skill.*entry missing.*local-config\.json/i);

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('allows target-owned skill changes while preserving an unchanged foreign skill', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-self-upgrade-owned-skill-change-'));
    const liveRoot = path.join(tmpDir, 'live');
    const skillsDir = path.join(liveRoot, 'skills');
    const targetDir = path.join(tmpDir, 'target');
    const coreSkillDir = path.join(skillsDir, 'core-skill');
    const foreignSkillDir = path.join(skillsDir, 'foreign-skill');

    writeTargetCommunicationAssets(liveRoot);
    writeTargetCommunicationAssets(targetDir);
    fs.mkdirSync(coreSkillDir, { recursive: true });
    fs.mkdirSync(path.join(targetDir, 'skills', 'core-skill'), { recursive: true });
    fs.mkdirSync(path.join(foreignSkillDir, 'scripts'), { recursive: true });
    fs.writeFileSync(path.join(coreSkillDir, 'SKILL.md'), '# Core\n');
    fs.writeFileSync(path.join(coreSkillDir, 'retired.js'), 'retired\n');
    fs.writeFileSync(path.join(foreignSkillDir, 'SKILL.md'), '# Foreign\n');
    fs.writeFileSync(path.join(foreignSkillDir, 'scripts', 'server.js'), 'foreign server\n');

    const ctx = { tempDir: targetDir, mode: 'merge' };
    assert.equal(step1_backupCoreSkills(ctx, {
      zylosDir: liveRoot,
      skillsDir,
      backupDir: path.join(tmpDir, 'backup'),
      installedCoreSkillsDir: path.join(targetDir, 'skills'),
    }).status, 'done');

    const result = step5_syncCoreSkills(ctx, {
      zylosDir: liveRoot,
      skillsDir,
      syncCoreSkills: () => {
        fs.rmSync(path.join(coreSkillDir, 'retired.js'));
        return {
          synced: ['core-skill'], added: [], merged: [], deleted: ['core-skill/retired.js'], preserved: [],
          conflicts: [], errors: [], pendingBaselines: [],
        };
      },
    });

    assert.equal(result.status, 'done');
    assert.equal(fs.readFileSync(path.join(foreignSkillDir, 'scripts', 'server.js'), 'utf8'), 'foreign server\n');

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('fails closed instead of backing up the bootstrap source when the global package cannot be resolved', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-self-upgrade-package-missing-'));
    const coreDir = path.join(tmpDir, 'target-bootstrap-source');
    const backupDir = path.join(tmpDir, 'backup');
    fs.mkdirSync(coreDir, { recursive: true });
    fs.writeFileSync(path.join(coreDir, 'package.json'), '{"name":"zylos","version":"0.7.2-rc.1"}\n');

    const result = step1_backupCoreSkills({ coreDir }, {
      zylosDir: path.join(tmpDir, 'zylos'),
      skillsDir: path.join(tmpDir, 'skills'),
      backupDir,
      resolveInstalledCorePackageDir: () => null,
    });

    assert.equal(result.status, 'failed');
    assert.match(result.error, /global Core package not found/);
    assert.equal(fs.existsSync(path.join(backupDir, 'core-package')), false);

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('restores the complete global Core package after any later upgrade failure', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-self-upgrade-package-rollback-'));
    const zylosDir = path.join(tmpDir, 'zylos');
    const skillsDir = path.join(tmpDir, 'skills');
    const coreDir = path.join(tmpDir, 'global', 'node_modules', 'zylos');
    const backupDir = path.join(tmpDir, 'backup');

    fs.mkdirSync(path.join(coreDir, 'cli'), { recursive: true });
    fs.mkdirSync(path.join(coreDir, 'node_modules', 'fixture-dep'), { recursive: true });
    fs.mkdirSync(skillsDir, { recursive: true });
    fs.writeFileSync(path.join(coreDir, 'package.json'), '{"name":"zylos","version":"0.7.0"}\n');
    fs.writeFileSync(path.join(coreDir, 'cli', 'zylos.js'), 'old cli\n');
    fs.writeFileSync(path.join(coreDir, 'node_modules', 'fixture-dep', 'index.js'), 'old dep\n');

    const ctx = { coreDir };
    const backup = step1_backupCoreSkills(ctx, {
      zylosDir,
      skillsDir,
      backupDir,
      corePackageDir: coreDir,
    });
    assert.equal(backup.status, 'done');

    fs.writeFileSync(path.join(coreDir, 'package.json'), '{"name":"zylos","version":"0.7.2-rc.1"}\n');
    fs.writeFileSync(path.join(coreDir, 'cli', 'zylos.js'), 'new cli\n');
    fs.rmSync(path.join(coreDir, 'node_modules', 'fixture-dep'), { recursive: true, force: true });
    fs.writeFileSync(path.join(coreDir, 'new-release-only.js'), 'new only\n');

    const results = rollbackSelf({ ...ctx, backupDir, servicesWereRunning: [] }, {
      zylosDir,
      skillsDir,
      corePackageDir: coreDir,
    });

    assert.equal(JSON.parse(fs.readFileSync(path.join(coreDir, 'package.json'), 'utf8')).version, '0.7.0');
    assert.equal(fs.readFileSync(path.join(coreDir, 'cli', 'zylos.js'), 'utf8'), 'old cli\n');
    assert.equal(fs.readFileSync(path.join(coreDir, 'node_modules', 'fixture-dep', 'index.js'), 'utf8'), 'old dep\n');
    assert.equal(fs.existsSync(path.join(coreDir, 'new-release-only.js')), false);
    assert.equal(results.some((item) => item.action === 'restore_global_core_package' && item.success), true);

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('restores the global package when npm install fails after partial mutation', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-self-upgrade-install-rollback-'));
    const zylosDir = path.join(tmpDir, 'zylos');
    const skillsDir = path.join(tmpDir, 'skills');
    const coreDir = path.join(tmpDir, 'global', 'node_modules', 'zylos');
    const backupDir = path.join(tmpDir, 'backup');
    fs.mkdirSync(coreDir, { recursive: true });
    fs.mkdirSync(skillsDir, { recursive: true });
    fs.writeFileSync(path.join(coreDir, 'package.json'), '{"name":"zylos","version":"0.7.0"}\n');

    const result = runSelfUpgrade({ tempDir: tmpDir, newVersion: '0.7.2-rc.2' }, {
      getCurrentVersion: () => ({ success: true, version: '0.7.0' }),
      preInstallSteps: [
        (ctx) => step1_backupCoreSkills(ctx, {
          zylosDir,
          skillsDir,
          backupDir,
          corePackageDir: coreDir,
        }),
        () => {
          fs.writeFileSync(path.join(coreDir, 'package.json'), '{"name":"zylos","version":"partial"}\n');
          fs.writeFileSync(path.join(coreDir, 'partial-only.js'), 'partial\n');
          return { step: 4, name: 'npm_install_global', status: 'failed', error: 'injected partial install' };
        },
      ],
      rollbackSelf: (ctx) => rollbackSelf(ctx, {
        zylosDir,
        skillsDir,
        corePackageDir: coreDir,
      }),
    });

    assert.equal(result.success, false);
    assert.equal(result.failedStep, 4);
    assert.equal(JSON.parse(fs.readFileSync(path.join(coreDir, 'package.json'), 'utf8')).version, '0.7.0');
    assert.equal(fs.existsSync(path.join(coreDir, 'partial-only.js')), false);
    assert.equal(result.rollback.steps.some((item) => item.action === 'restore_global_core_package' && item.success), true);

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('backs up the deployed core ecosystem file', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-self-upgrade-backup-'));
    const zylosDir = path.join(tmpDir, 'zylos');
    const skillsDir = path.join(tmpDir, 'skills');
    const backupDir = path.join(tmpDir, 'backup');

    fs.mkdirSync(path.join(zylosDir, 'pm2'), { recursive: true });
    fs.mkdirSync(skillsDir, { recursive: true });
    fs.writeFileSync(path.join(zylosDir, 'pm2', 'ecosystem.config.cjs'), 'module.exports = { apps: ["old"] };\n', 'utf8');

    const ctx = {};
    const result = step1_backupCoreSkills(ctx, {
      zylosDir,
      skillsDir,
      backupDir,
    });

    assert.equal(result.status, 'done');
    assert.equal(
      fs.readFileSync(path.join(backupDir, 'pm2', 'ecosystem.config.cjs'), 'utf8'),
      'module.exports = { apps: ["old"] };\n'
    );

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('backs up real skill contents when the skills root is a symlink', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-self-upgrade-symlink-backup-'));
    const zylosDir = path.join(tmpDir, 'zylos');
    const realSkillsDir = path.join(tmpDir, 'real-skills');
    const skillsDir = path.join(zylosDir, '.claude', 'skills');
    const backupDir = path.join(tmpDir, 'backup');

    fs.mkdirSync(path.dirname(skillsDir), { recursive: true });
    fs.mkdirSync(path.join(realSkillsDir, 'activity-monitor'), { recursive: true });
    fs.mkdirSync(path.join(realSkillsDir, 'lark'), { recursive: true });
    fs.writeFileSync(path.join(realSkillsDir, 'activity-monitor', 'SKILL.md'), '# Activity Monitor\n', 'utf8');
    fs.writeFileSync(path.join(realSkillsDir, 'lark', 'SKILL.md'), '# Lark\n', 'utf8');
    fs.symlinkSync(realSkillsDir, skillsDir);

    const ctx = {};
    const result = step1_backupCoreSkills(ctx, {
      zylosDir,
      skillsDir,
      backupDir,
    });

    assert.equal(result.status, 'done');
    assert.equal(fs.lstatSync(path.join(backupDir, 'skills')).isDirectory(), true);
    assert.equal(fs.lstatSync(path.join(backupDir, 'skills')).isSymbolicLink(), false);
    assert.equal(fs.readFileSync(path.join(backupDir, 'skills', 'activity-monitor', 'SKILL.md'), 'utf8'), '# Activity Monitor\n');
    assert.equal(fs.readFileSync(path.join(backupDir, 'skills', 'lark', 'SKILL.md'), 'utf8'), '# Lark\n');

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('restores the backed-up ecosystem before restarting services', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-self-upgrade-rollback-'));
    const zylosDir = path.join(tmpDir, 'zylos');
    const skillsDir = path.join(tmpDir, 'skills');
    const backupDir = path.join(tmpDir, 'backup');
    const ecosystemPath = path.join(zylosDir, 'pm2', 'ecosystem.config.cjs');

    fs.mkdirSync(path.join(backupDir, 'pm2'), { recursive: true });
    fs.mkdirSync(path.join(zylosDir, 'pm2'), { recursive: true });
    fs.mkdirSync(skillsDir, { recursive: true });
    fs.writeFileSync(path.join(backupDir, 'pm2', 'ecosystem.config.cjs'), 'module.exports = { apps: ["restored"] };\n', 'utf8');
    fs.writeFileSync(ecosystemPath, 'module.exports = { apps: ["broken-new"] };\n', 'utf8');

    const restartCalls = [];
    const results = rollbackSelf({
      backupDir,
      servicesWereRunning: ['activity-monitor'],
    }, {
      zylosDir,
      skillsDir,
      ecosystemPath,
      restartManagedProcess: (name, opts) => {
        restartCalls.push({
          name,
          opts,
          ecosystemContent: fs.readFileSync(opts.ecosystemPath, 'utf8'),
        });
      },
    });

    assert.equal(
      fs.readFileSync(ecosystemPath, 'utf8'),
      'module.exports = { apps: ["restored"] };\n'
    );
    assert.deepStrictEqual(restartCalls, [{
      name: 'activity-monitor',
      opts: { ecosystemPath, stdio: 'pipe', fallbackToPlainRestartOnError: true },
      ecosystemContent: 'module.exports = { apps: ["restored"] };\n',
    }]);
    assert.equal(results.some((item) => item.action === 'restore_pm2_ecosystem' && item.success), true);

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('removes target-only services introduced by a failed upgrade before saving rollback state', () => {
    const calls = [];

    const results = rollbackSelf({
      servicesWereRunning: ['activity-monitor'],
      servicesStartedByUpgrade: [
        'c4-response-stream-supervisor',
        'activity-monitor',
        'c4-response-stream-supervisor',
      ],
    }, {
      restartManagedProcess: (name) => calls.push(`restart:${name}`),
      removeManagedProcess: (name) => calls.push(`remove:${name}`),
      savePm2: () => calls.push('save'),
    });

    assert.deepStrictEqual(calls, [
      'remove:c4-response-stream-supervisor',
      'restart:activity-monitor',
      'save',
    ]);
    assert.equal(results.some((item) =>
      item.action === 'remove_target_only_c4-response-stream-supervisor' && item.success
    ), true);
    assert.equal(results.some((item) => item.action === 'save_pm2_rollback_state' && item.success), true);
  });

  it('saves rollback state after reactivating baseline services', () => {
    const calls = [];

    const results = rollbackSelf({
      servicesWereRunning: ['activity-monitor'],
      servicesStartedByUpgrade: [],
    }, {
      restartManagedProcess: (name) => calls.push(`restart:${name}`),
      savePm2: () => calls.push('save'),
    });

    assert.deepStrictEqual(calls, [
      'restart:activity-monitor',
      'save',
    ]);
    assert.equal(results.some((item) =>
      item.action === 'save_pm2_rollback_state' && item.success
    ), true);
  });

  it('reactivates a baseline cron one-shot with its preserved PM2 definition during rollback', () => {
    const calls = [];

    rollbackSelf({
      servicesWereRunning: ['task-comment-bridge', 'activity-monitor'],
      cronServicesWereRunning: ['task-comment-bridge'],
    }, {
      restartScheduledProcess: (name) => calls.push(`cron:${name}`),
      restartManagedProcess: (name) => calls.push(`daemon:${name}`),
    });

    assert.deepStrictEqual(calls, [
      'cron:task-comment-bridge',
      'daemon:activity-monitor',
    ]);
  });

  it('restores component daemons from their preserved PM2 definition during rollback', () => {
    const calls = [];

    rollbackSelf({
      servicesWereRunning: ['zylos-feishu-task-projection', 'activity-monitor'],
    }, {
      coreEcosystemServiceNames: ['activity-monitor'],
      restartExistingProcess: (name) => calls.push(`component:${name}`),
      restartManagedProcess: (name) => calls.push(`core:${name}`),
    });

    assert.deepStrictEqual(calls, [
      'component:zylos-feishu-task-projection',
      'core:activity-monitor',
    ]);
  });

  it('falls back to plain restart when the backup has no ecosystem file', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-self-upgrade-rollback-fallback-'));
    const zylosDir = path.join(tmpDir, 'zylos');
    const skillsDir = path.join(tmpDir, 'skills');
    const backupDir = path.join(tmpDir, 'backup');
    const ecosystemPath = path.join(zylosDir, 'pm2', 'ecosystem.config.cjs');

    fs.mkdirSync(backupDir, { recursive: true });
    fs.mkdirSync(path.join(zylosDir, 'pm2'), { recursive: true });
    fs.mkdirSync(skillsDir, { recursive: true });

    const restartCalls = [];
    const results = rollbackSelf({
      backupDir,
      servicesWereRunning: ['activity-monitor'],
    }, {
      zylosDir,
      skillsDir,
      ecosystemPath,
      restartManagedProcess: (name, opts) => {
        restartCalls.push({ name, opts });
      },
    });

    assert.deepStrictEqual(restartCalls, [{
      name: 'activity-monitor',
      opts: { ecosystemPath, stdio: 'pipe', fallbackToPlainRestartOnError: true },
    }]);
    assert.equal(results.some((item) => item.action === 'restart_activity-monitor' && item.success), true);

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});

describe('Claude model migration hints', () => {
  it('adds a model backfill hint when the installed settings omit model', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-model-hints-'));
    const templatesDir = path.join(tmpDir, 'templates');
    const zylosDir = path.join(tmpDir, 'zylos');

    fs.mkdirSync(path.join(templatesDir, '.claude'), { recursive: true });
    fs.mkdirSync(path.join(zylosDir, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(templatesDir, '.claude', 'settings.json'), JSON.stringify({ model: 'claude-opus-4-6' }), 'utf8');
    fs.writeFileSync(path.join(zylosDir, '.claude', 'settings.json'), JSON.stringify({ hooks: {} }), 'utf8');

    const hints = generateMigrationHints(templatesDir, { zylosDir });
    assert.deepEqual(
      hints.filter((hint) => hint.type === 'model_backfill'),
      [{ type: 'model_backfill', value: 'claude-opus-4-6' }]
    );

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('downgrades 1m model in hint when threshold is above 30', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-model-guard-'));
    const templatesDir = path.join(tmpDir, 'templates');
    const zylosDir = path.join(tmpDir, 'zylos');

    fs.mkdirSync(path.join(templatesDir, '.claude'), { recursive: true });
    fs.mkdirSync(path.join(zylosDir, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(templatesDir, '.claude', 'settings.json'), JSON.stringify({ model: 'opus[1m]' }), 'utf8');
    fs.writeFileSync(path.join(zylosDir, '.claude', 'settings.json'), JSON.stringify({ hooks: {} }), 'utf8');

    const hints = generateMigrationHints(templatesDir, {
      zylosDir,
      getConfig: () => ({ new_session_threshold: 70 }),
    });
    assert.deepEqual(
      hints.filter((hint) => hint.type === 'model_backfill'),
      [{ type: 'model_backfill', value: 'opus' }]
    );

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('does not add a model backfill hint when the user already configured model', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-model-nohint-'));
    const templatesDir = path.join(tmpDir, 'templates');
    const zylosDir = path.join(tmpDir, 'zylos');

    fs.mkdirSync(path.join(templatesDir, '.claude'), { recursive: true });
    fs.mkdirSync(path.join(zylosDir, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(templatesDir, '.claude', 'settings.json'), JSON.stringify({ model: 'claude-opus-4-6' }), 'utf8');
    fs.writeFileSync(path.join(zylosDir, '.claude', 'settings.json'), JSON.stringify({ model: 'sonnet' }), 'utf8');

    const hints = generateMigrationHints(templatesDir, { zylosDir });
    assert.equal(hints.some((hint) => hint.type === 'model_backfill'), false);

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('backfills model during applyMigrationHints only when the field is absent', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-model-apply-'));
    const zylosDir = path.join(tmpDir, 'zylos');
    const settingsPath = path.join(zylosDir, '.claude', 'settings.json');

    fs.mkdirSync(path.join(zylosDir, '.claude'), { recursive: true });
    fs.writeFileSync(settingsPath, JSON.stringify({ hooks: {} }) + '\n', 'utf8');

    const result = applyMigrationHints([{ type: 'model_backfill', value: 'claude-opus-4-6' }], { zylosDir });
    const updated = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    assert.equal(result.applied, 1);
    assert.equal(updated.model, 'claude-opus-4-6');

    fs.writeFileSync(settingsPath, JSON.stringify({ model: 'sonnet' }) + '\n', 'utf8');
    const preserved = applyMigrationHints([{ type: 'model_backfill', value: 'claude-opus-4-6' }], { zylosDir });
    const preservedSettings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    assert.equal(preserved.applied, 0);
    assert.equal(preservedSettings.model, 'sonnet');

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});

describe('Boolean setting migration hints (autoMemoryEnabled, autoDreamEnabled)', () => {
  it('adds setting_backfill hints when installed settings omit them', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-setting-hints-'));
    const templatesDir = path.join(tmpDir, 'templates');
    const zylosDir = path.join(tmpDir, 'zylos');

    fs.mkdirSync(path.join(templatesDir, '.claude'), { recursive: true });
    fs.mkdirSync(path.join(zylosDir, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(templatesDir, '.claude', 'settings.json'),
      JSON.stringify({ autoMemoryEnabled: false, autoDreamEnabled: false }), 'utf8');
    fs.writeFileSync(path.join(zylosDir, '.claude', 'settings.json'),
      JSON.stringify({ hooks: {} }), 'utf8');

    const hints = generateMigrationHints(templatesDir, { zylosDir });
    const settingHints = hints.filter((h) => h.type === 'setting_backfill');
    assert.equal(settingHints.length, 2);
    assert.deepEqual(settingHints[0], { type: 'setting_backfill', key: 'autoMemoryEnabled', value: false });
    assert.deepEqual(settingHints[1], { type: 'setting_backfill', key: 'autoDreamEnabled', value: false });

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('does not add hints when user already configured the settings', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-setting-nohint-'));
    const templatesDir = path.join(tmpDir, 'templates');
    const zylosDir = path.join(tmpDir, 'zylos');

    fs.mkdirSync(path.join(templatesDir, '.claude'), { recursive: true });
    fs.mkdirSync(path.join(zylosDir, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(templatesDir, '.claude', 'settings.json'),
      JSON.stringify({ autoMemoryEnabled: false, autoDreamEnabled: false }), 'utf8');
    fs.writeFileSync(path.join(zylosDir, '.claude', 'settings.json'),
      JSON.stringify({ autoMemoryEnabled: true, autoDreamEnabled: true }), 'utf8');

    const hints = generateMigrationHints(templatesDir, { zylosDir });
    assert.equal(hints.some((h) => h.type === 'setting_backfill'), false);

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('backfills settings during applyMigrationHints only when absent', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-setting-apply-'));
    const zylosDir = path.join(tmpDir, 'zylos');
    const settingsPath = path.join(zylosDir, '.claude', 'settings.json');

    fs.mkdirSync(path.join(zylosDir, '.claude'), { recursive: true });
    fs.writeFileSync(settingsPath, JSON.stringify({ hooks: {} }) + '\n', 'utf8');

    const result = applyMigrationHints([
      { type: 'setting_backfill', key: 'autoMemoryEnabled', value: false },
      { type: 'setting_backfill', key: 'autoDreamEnabled', value: false },
    ], { zylosDir });
    const updated = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    assert.equal(result.applied, 2);
    assert.equal(updated.autoMemoryEnabled, false);
    assert.equal(updated.autoDreamEnabled, false);

    // User-configured values should be preserved
    fs.writeFileSync(settingsPath, JSON.stringify({ autoMemoryEnabled: true, autoDreamEnabled: true }) + '\n', 'utf8');
    const preserved = applyMigrationHints([
      { type: 'setting_backfill', key: 'autoMemoryEnabled', value: false },
      { type: 'setting_backfill', key: 'autoDreamEnabled', value: false },
    ], { zylosDir });
    const preservedSettings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    assert.equal(preserved.applied, 0);
    assert.equal(preservedSettings.autoMemoryEnabled, true);
    assert.equal(preservedSettings.autoDreamEnabled, true);

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});

describe('self-upgrade hook migration hints', () => {
  function writeSettingsPair({ templateSettings, installedSettings }) {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-hook-hints-'));
    const templatesDir = path.join(tmpDir, 'templates');
    const zylosDir = path.join(tmpDir, 'zylos');
    fs.mkdirSync(path.join(templatesDir, '.claude'), { recursive: true });
    fs.mkdirSync(path.join(zylosDir, '.claude'), { recursive: true });
    fs.writeFileSync(
      path.join(templatesDir, '.claude', 'settings.json'),
      JSON.stringify(templateSettings),
      'utf8'
    );
    fs.writeFileSync(
      path.join(zylosDir, '.claude', 'settings.json'),
      JSON.stringify(installedSettings),
      'utf8'
    );
    return { tmpDir, templatesDir, zylosDir };
  }

  it('generates removed_hook for retired core SessionStart hooks absent from the template', () => {
    const { tmpDir, templatesDir, zylosDir } = writeSettingsPair({
      templateSettings: {
        hooks: {
          SessionStart: [{
            matcher: 'startup',
            hooks: [{
              type: 'command',
              command: 'node ~/zylos/.claude/skills/activity-monitor/scripts/session-start-orchestrator.js',
              timeout: 20000,
            }],
          }],
        },
      },
      installedSettings: {
        hooks: {
          SessionStart: [{
            matcher: 'startup',
            hooks: [{
              type: 'command',
              command: `node ${zylosHookPath('skills/zylos-memory/scripts/session-start-inject.js')}`,
              timeout: 10000,
            }],
          }],
        },
      },
    });

    const hints = generateMigrationHints(templatesDir, { zylosDir });

    assert.ok(hints.some(hint =>
      hint.type === 'removed_hook' &&
      hint.command.includes('session-start-inject.js')
    ));
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('does not generate removed_hook for custom or non-command hooks', () => {
    const { tmpDir, templatesDir, zylosDir } = writeSettingsPair({
      templateSettings: {
        hooks: {
          SessionStart: [{
            matcher: 'startup',
            hooks: [{
              type: 'command',
              command: 'node ~/zylos/.claude/skills/activity-monitor/scripts/session-start-orchestrator.js',
              timeout: 20000,
            }],
          }],
        },
      },
      installedSettings: {
        hooks: {
          SessionStart: [{
            matcher: 'startup',
            hooks: [
              { type: 'command', command: 'node /custom/session-start.js', timeout: 5000 },
              { type: 'prompt', prompt: 'keep me' },
            ],
          }],
        },
      },
    });

    const hints = generateMigrationHints(templatesDir, { zylosDir });

    assert.equal(hints.some(hint => hint.type === 'removed_hook'), false);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('matches modified hooks by canonical script key during hint generation and apply', () => {
    const { tmpDir, templatesDir, zylosDir } = writeSettingsPair({
      templateSettings: {
        hooks: {
          SessionStart: [{
            matcher: 'startup',
            hooks: [{
              type: 'command',
              command: 'node ~/zylos/.claude/skills/activity-monitor/scripts/session-start-orchestrator.js',
              timeout: 20000,
            }],
          }],
        },
      },
      installedSettings: {
        hooks: {
          SessionStart: [{
            matcher: 'startup',
            hooks: [{
              type: 'command',
              command: `node ${zylosHookPath('skills/activity-monitor/scripts/session-start-orchestrator.js')}`,
              timeout: 10000,
            }],
          }],
        },
      },
    });

    const hints = generateMigrationHints(templatesDir, { zylosDir });
    const modified = hints.find(hint => hint.type === 'modified_hook');

    assert.ok(modified);
    assert.equal(modified.timeout, 20000);

    const result = applyMigrationHints(hints, { zylosDir });
    const updated = JSON.parse(fs.readFileSync(path.join(zylosDir, '.claude', 'settings.json'), 'utf8'));

    assert.equal(result.errors.length, 0);
    assert.equal(updated.hooks.SessionStart[0].hooks[0].command, 'node ~/zylos/.claude/skills/activity-monitor/scripts/session-start-orchestrator.js');
    assert.equal(updated.hooks.SessionStart[0].hooks[0].timeout, 20000);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('removes hooks by canonical script key during applyMigrationHints', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-hook-apply-'));
    const zylosDir = path.join(tmpDir, 'zylos');
    const settingsPath = path.join(zylosDir, '.claude', 'settings.json');

    fs.mkdirSync(path.join(zylosDir, '.claude'), { recursive: true });
    fs.writeFileSync(settingsPath, JSON.stringify({
      hooks: {
        SessionStart: [{
          matcher: 'startup',
          hooks: [{
            type: 'command',
            command: `node ${zylosHookPath('skills/zylos-memory/scripts/session-start-inject.js')}`,
            timeout: 10000,
          }],
        }],
      },
    }) + '\n', 'utf8');

    const result = applyMigrationHints([{
      type: 'removed_hook',
      event: 'SessionStart',
      command: 'node ~/zylos/.claude/skills/zylos-memory/scripts/session-start-inject.js',
      timeout: 10000,
    }], { zylosDir });
    const updated = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));

    assert.equal(result.applied, 1);
    assert.equal(updated.hooks, undefined);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});

describe('step7 manifest deploy (real step7_syncInstructions)', () => {
  it('uses the split-era step name when the new package has no templates', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-step7-no-templates-'));
    const result = step7_syncInstructions({ tempDir: tmpDir, zylosDir: path.join(tmpDir, 'zylos') });
    assert.equal(result.status, 'skipped');
    assert.equal(result.name, 'sync_instructions');
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('fails loudly before asset deployment when a legacy migration fails', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-step7-legacy-fail-'));
    const zylosDir = path.join(tmpDir, 'zylos');
    const pkgRoot = path.join(tmpDir, 'pkg');
    writeSplitPackage(pkgRoot);
    fs.mkdirSync(zylosDir, { recursive: true });
    fs.writeFileSync(path.join(zylosDir, 'CLAUDE.md'), 'legacy bytes\n');
    const result = step7_syncInstructions({ tempDir: pkgRoot, zylosDir, packageRoot: pkgRoot }, {
      runMigrations() { throw new Error('injected migration failure'); },
    });
    assert.equal(result.status, 'failed');
    assert.match(result.error, /injected migration failure/);
    assert.equal(fs.readFileSync(path.join(zylosDir, 'CLAUDE.md'), 'utf8'), 'legacy bytes\n');
    assert.equal(fs.existsSync(path.join(zylosDir, '.zylos', 'instructions')), false);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('refreshes both generated files when split mode is already active', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-step7-active-'));
    const zylosDir = path.join(tmpDir, 'zylos');
    const pkgRoot = path.join(tmpDir, 'pkg');
    writeSplitPackage(pkgRoot);
    fs.writeFileSync(path.join(pkgRoot, 'templates', 'ZYLOS.md'), 'user seed\n');
    activateFreshSplitInstructions({
      zylosDir,
      templatesDir: path.join(pkgRoot, 'templates'),
      assemblerSource: path.join(pkgRoot, 'cli', 'lib', 'runtime', 'assembler.mjs'),
    });
    fs.writeFileSync(path.join(pkgRoot, 'templates', 'claude-system.md'), '# Claude system v2\n');
    fs.writeFileSync(path.join(pkgRoot, 'templates', 'codex-system.md'), '# Codex system v2\n');

    const result = step7_syncInstructions({ tempDir: pkgRoot, zylosDir, packageRoot: pkgRoot });
    assert.equal(result.status, 'done');
    assert.match(result.message, /refreshed atomically/);
    assert.match(fs.readFileSync(path.join(zylosDir, 'CLAUDE.md'), 'utf8'), /Claude system v2/);
    assert.match(fs.readFileSync(path.join(zylosDir, 'AGENTS.md'), 'utf8'), /Codex system v2/);
    assert.ok(fs.existsSync(path.join(zylosDir, '.zylos', 'instructions', 'meta.json')));
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns before all v2 instruction work for a future format version', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-step7-future-'));
    const zylosDir = path.join(tmpDir, 'zylos');
    const pkgRoot = path.join(tmpDir, 'pkg');
    writeSplitPackage(pkgRoot);
    fs.mkdirSync(path.join(zylosDir, '.zylos', 'instructions'), { recursive: true });
    fs.writeFileSync(path.join(zylosDir, 'ZYLOS.md'), 'future user bytes\n');
    fs.writeFileSync(path.join(zylosDir, 'CLAUDE.md'), 'future claude bytes\n');
    fs.writeFileSync(path.join(zylosDir, 'AGENTS.md'), 'future codex bytes\n');
    fs.writeFileSync(path.join(zylosDir, '.zylos', 'instructions', 'meta.json'), '{"version":99}\n');
    fs.writeFileSync(path.join(zylosDir, '.zylos', 'instructions', 'future.asset'), 'future asset bytes\n');
    fs.mkdirSync(path.join(zylosDir, 'custom-hooks', 'session-start'), { recursive: true });
    fs.writeFileSync(path.join(zylosDir, 'custom-hooks', 'session-start', '90-migration-prompt.md'), 'future prompt bytes\n');
    fs.writeFileSync(path.join(zylosDir, '.zylos', 'instruction-format-version'), '3\n');
    const instructionFiles = [
      'ZYLOS.md',
      'CLAUDE.md',
      'AGENTS.md',
      '.zylos/instructions/meta.json',
      '.zylos/instructions/future.asset',
      'custom-hooks/session-start/90-migration-prompt.md',
      '.zylos/instruction-format-version',
    ];
    const before = new Map(instructionFiles.map(file => [file, fs.readFileSync(path.join(zylosDir, file))]));
    let refreshed = false;

    const result = step7_syncInstructions({ tempDir: pkgRoot, zylosDir, packageRoot: pkgRoot }, {
      refreshSplitInstructions() { refreshed = true; throw new Error('must not run'); },
    });

    assert.equal(result.status, 'done');
    assert.match(result.message, /future instruction format version 3/);
    assert.equal(refreshed, false);
    for (const [file, bytes] of before) {
      assert.deepEqual(fs.readFileSync(path.join(zylosDir, file)), bytes, file);
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns before legacy instruction migration when a future format omits ZYLOS.md', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-step7-future-no-zylos-'));
    const zylosDir = path.join(tmpDir, 'zylos');
    const pkgRoot = path.join(tmpDir, 'pkg');
    writeSplitPackage(pkgRoot);
    fs.mkdirSync(path.join(zylosDir, '.zylos'), { recursive: true });
    fs.writeFileSync(path.join(zylosDir, 'CLAUDE.md'), 'future-owned instruction bytes\n');
    fs.writeFileSync(path.join(zylosDir, '.zylos', 'instruction-format-version'), '3\n');
    const before = fs.readFileSync(path.join(zylosDir, 'CLAUDE.md'));
    let legacyMigrationRan = false;

    const result = step7_syncInstructions({ tempDir: pkgRoot, zylosDir, packageRoot: pkgRoot }, {
      runMigrations() { legacyMigrationRan = true; throw new Error('must not run'); },
      refreshSplitInstructions() { throw new Error('must not run'); },
    });

    assert.equal(result.status, 'done');
    assert.match(result.message, /future instruction format version 3/);
    assert.equal(legacyMigrationRan, false);
    assert.equal(fs.existsSync(path.join(zylosDir, 'ZYLOS.md')), false);
    assert.deepEqual(fs.readFileSync(path.join(zylosDir, 'CLAUDE.md')), before);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('backfills version and removes a stale prompt for active split instructions', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-step7-backfill-'));
    const zylosDir = path.join(tmpDir, 'zylos');
    const pkgRoot = path.join(tmpDir, 'pkg');
    writeSplitPackage(pkgRoot);
    fs.mkdirSync(path.join(zylosDir, '.zylos'), { recursive: true });
    fs.writeFileSync(path.join(zylosDir, 'ZYLOS.md'), 'legacy\n');
    const promptPath = path.join(zylosDir, 'custom-hooks', 'session-start', '90-migration-prompt.md');
    fs.mkdirSync(path.dirname(promptPath), { recursive: true });
    fs.writeFileSync(promptPath, 'stale prompt\n');
    let versionWrites = 0;

    const result = step7_syncInstructions({ tempDir: pkgRoot, zylosDir, packageRoot: pkgRoot }, {
      refreshSplitInstructions: () => ({ active: true, pendingMigration: false }),
      writeInstructionFormatVersion: () => { versionWrites++; },
    });

    assert.equal(result.status, 'done');
    assert.equal(versionWrites, 1);
    assert.match(result.message, /backfilled to 2/);
    assert.equal(fs.existsSync(promptPath), false);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('keeps active refresh successful when stale prompt cleanup fails', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-step7-cleanup-fail-'));
    const zylosDir = path.join(tmpDir, 'zylos');
    const pkgRoot = path.join(tmpDir, 'pkg');
    writeSplitPackage(pkgRoot);
    fs.mkdirSync(path.join(zylosDir, '.zylos'), { recursive: true });
    fs.writeFileSync(path.join(zylosDir, 'ZYLOS.md'), 'legacy\n');
    fs.writeFileSync(path.join(zylosDir, '.zylos', 'instruction-format-version'), '2\n');
    fs.mkdirSync(path.join(zylosDir, 'custom-hooks', 'session-start'), { recursive: true });
    fs.writeFileSync(path.join(zylosDir, 'custom-hooks', 'session-start', '90-migration-prompt.md'), 'stale\n');
    const warnings = [];

    const result = step7_syncInstructions({ tempDir: pkgRoot, zylosDir, packageRoot: pkgRoot }, {
      refreshSplitInstructions: () => ({ active: true, pendingMigration: false }),
      cleanupMigrationPrompt: () => ({ removed: false, error: new Error('unlink fault') }),
      warn: warning => warnings.push(warning),
    });

    assert.equal(result.status, 'done');
    assert.match(result.message, /cleanup pending/);
    assert.equal(warnings.length, 1);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('writes a C-class prompt and reports its path', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-step7-c-'));
    const zylosDir = path.join(tmpDir, 'zylos');
    const pkgRoot = path.join(tmpDir, 'pkg');
    writeSplitPackage(pkgRoot);
    fs.mkdirSync(zylosDir, { recursive: true });
    fs.writeFileSync(path.join(zylosDir, 'ZYLOS.md'), 'custom legacy\n');
    const promptPath = path.join(zylosDir, 'custom-hooks', 'session-start', '90-migration-prompt.md');
    let promptArgs;

    const result = step7_syncInstructions({ tempDir: pkgRoot, zylosDir, packageRoot: pkgRoot }, {
      refreshSplitInstructions: () => ({ active: false, pendingMigration: true }),
      loadInstructionCatalog: () => [],
      classifyInstructionBaseline: () => ({ classification: 'C', candidates: [] }),
      writeMigrationPrompt: args => { promptArgs = args; return { filePath: promptPath }; },
    });

    assert.equal(result.status, 'done');
    assert.match(result.message, /classification C/);
    assert.match(result.message, new RegExp(promptPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.match(promptArgs.originalSha256, /^[a-f0-9]{64}$/);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns manual C-class guidance when the prompt write fails', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-step7-c-fail-'));
    const zylosDir = path.join(tmpDir, 'zylos');
    const pkgRoot = path.join(tmpDir, 'pkg');
    writeSplitPackage(pkgRoot);
    fs.mkdirSync(zylosDir, { recursive: true });
    fs.writeFileSync(path.join(zylosDir, 'ZYLOS.md'), 'custom legacy\n');

    const result = step7_syncInstructions({ tempDir: pkgRoot, zylosDir, packageRoot: pkgRoot }, {
      refreshSplitInstructions: () => ({ active: false, pendingMigration: true }),
      loadInstructionCatalog: () => [],
      classifyInstructionBaseline: () => ({ classification: 'C', candidates: [] }),
      writeMigrationPrompt: () => { throw new Error('rename fault'); },
      warn: () => {},
    });

    assert.equal(result.status, 'done');
    assert.match(result.message, /PENDING MIGRATION/);
    assert.match(result.message, /prompt write failed/);
    assert.doesNotMatch(result.message, /agent prompt:/);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('separates A verification from seed materialization and branches on migrated', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-step7-a-'));
    const zylosDir = path.join(tmpDir, 'zylos');
    const pkgRoot = path.join(tmpDir, 'pkg');
    writeSplitPackage(pkgRoot);
    fs.writeFileSync(path.join(pkgRoot, 'templates', 'ZYLOS.md'), 'new seed\n');
    fs.mkdirSync(zylosDir, { recursive: true });
    fs.writeFileSync(path.join(zylosDir, 'ZYLOS.md'), 'known baseline\n');
    const analysis = { classification: 'A', strippedContent: 'known baseline\n', matched: { sha256: 'known' } };
    const conservation = { ok: true, matched: analysis.matched };
    let verifyArgs;
    let engineArgs;

    const result = step7_syncInstructions({ tempDir: pkgRoot, zylosDir, packageRoot: pkgRoot }, {
      readInstructionFormatVersion: () => ({ valid: true, exists: true, version: 2 }),
      refreshSplitInstructions: () => ({ active: false, pendingMigration: true }),
      loadInstructionCatalog: () => [analysis.matched],
      classifyInstructionBaseline: () => analysis,
      verifyInstructionConservation: args => { verifyArgs = args; return conservation; },
      executeMigrationApply: args => {
        engineArgs = args;
        return { migrated: false, fatal: false, backupPath: '/backup/path', error: new Error('transaction fault') };
      },
    });

    assert.equal(verifyArgs.userContent, '');
    assert.equal(engineArgs.userContent, 'new seed\n');
    assert.equal(engineArgs.conservation, conservation);
    assert.match(result.message, /PENDING MIGRATION/);
    assert.match(result.message, /transaction fault/);
    assert.match(result.message, /backup: \/backup\/path/);
    assert.match(result.message, /version 2 exists but split marker is missing/);

    const success = step7_syncInstructions({ tempDir: pkgRoot, zylosDir, packageRoot: pkgRoot }, {
      readInstructionFormatVersion: () => ({ valid: true, exists: true, version: 2 }),
      refreshSplitInstructions: () => ({ active: false, pendingMigration: true }),
      loadInstructionCatalog: () => [analysis.matched],
      classifyInstructionBaseline: () => analysis,
      verifyInstructionConservation: () => conservation,
      executeMigrationApply: () => ({ migrated: true, backupPath: '/backup/path', versionWritten: true, a3Pending: false }),
    });
    assert.equal(success.status, 'done');
    assert.match(success.message, /migrated automatically/);
    assert.doesNotMatch(success.message, /PENDING MIGRATION/);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('auto-migrates an A-class fixture end-to-end with the new package catalog', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-step7-a-real-'));
    const zylosDir = path.join(tmpDir, 'zylos');
    const pkgRoot = path.join(tmpDir, 'pkg');
    fs.mkdirSync(path.join(pkgRoot, 'cli', 'lib', 'runtime'), { recursive: true });
    fs.mkdirSync(path.join(pkgRoot, 'data', 'instruction-baselines'), { recursive: true });
    fs.cpSync(path.resolve('templates'), path.join(pkgRoot, 'templates'), { recursive: true });
    fs.copyFileSync(
      path.resolve('cli/lib/runtime/assembler.mjs'),
      path.join(pkgRoot, 'cli', 'lib', 'runtime', 'assembler.mjs'),
    );
    fs.copyFileSync(
      path.resolve('data/instruction-baselines/manifest.json'),
      path.join(pkgRoot, 'data', 'instruction-baselines', 'manifest.json'),
    );
    const catalog = JSON.parse(fs.readFileSync(path.resolve('data/instruction-baselines/manifest.json'), 'utf8'));
    const legacyBaseline = Buffer.from(catalog.entries[0].contentBase64, 'base64').toString('utf8');
    fs.mkdirSync(zylosDir, { recursive: true });
    fs.writeFileSync(path.join(zylosDir, 'ZYLOS.md'), legacyBaseline);
    fs.writeFileSync(path.join(zylosDir, 'CLAUDE.md'), legacyBaseline);
    fs.writeFileSync(path.join(zylosDir, 'AGENTS.md'), legacyBaseline);

    const result = step7_syncInstructions({ tempDir: pkgRoot, zylosDir, packageRoot: pkgRoot });

    assert.equal(result.status, 'done');
    assert.match(result.message, /migrated automatically \(classification A\)/);
    assert.equal(
      fs.readFileSync(path.join(zylosDir, 'ZYLOS.md'), 'utf8'),
      fs.readFileSync(path.join(pkgRoot, 'templates', 'ZYLOS.md'), 'utf8'),
    );
    assert.equal(fs.readFileSync(path.join(zylosDir, '.zylos', 'instruction-format-version'), 'utf8'), '2\n');
    assert.ok(fs.existsSync(path.join(zylosDir, '.zylos', 'instructions', 'meta.json')));
    assert.match(result.message, /backup:/);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('creates manifest from tempDir template when missing, message includes manifest: created', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-step7-'));
    const zylosDir = path.join(tmpDir, 'zylos');
    const templatesDir = path.join(tmpDir, 'pkg', 'templates');
    fs.mkdirSync(path.join(zylosDir, '.zylos'), { recursive: true });
    writeSplitPackage(path.join(tmpDir, 'pkg'));
    fs.writeFileSync(path.join(templatesDir, 'runtime-env.manifest.example'), 'env TZ\n');
    fs.writeFileSync(path.join(zylosDir, 'ZYLOS.md'), '# Core\n');

    const manifestDest = path.join(zylosDir, '.zylos', 'runtime-env.manifest');
    assert.ok(!fs.existsSync(manifestDest));

    const result = step7_syncInstructions({
      tempDir: path.join(tmpDir, 'pkg'),
      zylosDir,
      packageRoot: path.join(tmpDir, 'no-fallback'),
    });

    assert.equal(result.step, 7);
    assert.equal(result.name, 'sync_instructions');
    assert.equal(result.status, 'done');
    assert.ok(result.message.includes('manifest: created'));
    assert.ok(fs.existsSync(manifestDest));
    assert.equal(fs.readFileSync(manifestDest, 'utf8'), 'env TZ\n');

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('does not overwrite existing manifest, message includes manifest: exists', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-step7-'));
    const zylosDir = path.join(tmpDir, 'zylos');
    const templatesDir = path.join(tmpDir, 'pkg', 'templates');
    fs.mkdirSync(path.join(zylosDir, '.zylos'), { recursive: true });
    writeSplitPackage(path.join(tmpDir, 'pkg'));
    fs.writeFileSync(path.join(templatesDir, 'runtime-env.manifest.example'), 'env NEW\n');
    fs.writeFileSync(path.join(zylosDir, '.zylos', 'runtime-env.manifest'), 'env CUSTOM\n');
    fs.writeFileSync(path.join(zylosDir, 'ZYLOS.md'), '# Core\n');

    const result = step7_syncInstructions({
      tempDir: path.join(tmpDir, 'pkg'),
      zylosDir,
      packageRoot: path.join(tmpDir, 'no-fallback'),
    });

    assert.ok(result.message.includes('manifest: exists'));
    assert.equal(
      fs.readFileSync(path.join(zylosDir, '.zylos', 'runtime-env.manifest'), 'utf8'),
      'env CUSTOM\n',
    );

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('falls back to packageRoot template when tempDir template is missing', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-step7-'));
    const zylosDir = path.join(tmpDir, 'zylos');
    const templatesDir = path.join(tmpDir, 'pkg', 'templates');
    const pkgRoot = path.join(tmpDir, 'installed-pkg');
    const pkgTemplates = path.join(pkgRoot, 'templates');
    fs.mkdirSync(path.join(zylosDir, '.zylos'), { recursive: true });
    writeSplitPackage(path.join(tmpDir, 'pkg'));
    fs.mkdirSync(pkgTemplates, { recursive: true });
    fs.writeFileSync(path.join(pkgTemplates, 'runtime-env.manifest.example'), 'env FALLBACK\n');
    fs.writeFileSync(path.join(zylosDir, 'ZYLOS.md'), '# Core\n');

    const result = step7_syncInstructions({
      tempDir: path.join(tmpDir, 'pkg'),
      zylosDir,
      packageRoot: pkgRoot,
    });

    assert.ok(result.message.includes('manifest: created'));
    const manifestDest = path.join(zylosDir, '.zylos', 'runtime-env.manifest');
    assert.ok(fs.existsSync(manifestDest));
    assert.equal(fs.readFileSync(manifestDest, 'utf8'), 'env FALLBACK\n');

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('reports template_missing when both tempDir and packageRoot templates are absent', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-step7-'));
    const zylosDir = path.join(tmpDir, 'zylos');
    const templatesDir = path.join(tmpDir, 'pkg', 'templates');
    fs.mkdirSync(path.join(zylosDir, '.zylos'), { recursive: true });
    writeSplitPackage(path.join(tmpDir, 'pkg'));
    fs.writeFileSync(path.join(zylosDir, 'ZYLOS.md'), '# Core\n');

    const result = step7_syncInstructions({
      tempDir: path.join(tmpDir, 'pkg'),
      zylosDir,
      packageRoot: path.join(tmpDir, 'no-such-pkg'),
    });

    assert.ok(result.message.includes('manifest: template_missing'));
    assert.ok(!fs.existsSync(path.join(zylosDir, '.zylos', 'runtime-env.manifest')));

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('works end-to-end through runSelfUpgradeFinalize with real POST_INSTALL_STEPS', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-step7-'));
    const zylosDir = path.join(tmpDir, 'zylos');
    const templatesDir = path.join(tmpDir, 'pkg', 'templates');
    fs.mkdirSync(path.join(zylosDir, '.zylos'), { recursive: true });
    writeSplitPackage(path.join(tmpDir, 'pkg'));
    fs.writeFileSync(path.join(templatesDir, 'runtime-env.manifest.example'), 'env TZ\n');
    fs.writeFileSync(path.join(zylosDir, 'ZYLOS.md'), '# Core\n');

    const wrappedStep7 = (ctx) => step7_syncInstructions({ ...ctx, zylosDir, packageRoot: path.join(tmpDir, 'no-fallback') });

    const result = runSelfUpgradeFinalize({
      schemaVersion: 1,
      tempDir: path.join(tmpDir, 'pkg'),
      from: '0.4.12',
      to: '0.4.13',
      preUpgradeSkillsInventory: emptyExactSkillsInventory(),
    }, { steps: [wrappedStep7] });

    assert.equal(result.success, true);
    const step7Result = result.steps.find(s => s.step === 7);
    assert.ok(step7Result);
    assert.ok(step7Result.message.includes('manifest: created'));
    assert.ok(step7Result.message.includes('PENDING MIGRATION'));
    assert.ok(fs.existsSync(path.join(zylosDir, '.zylos', 'runtime-env.manifest')));

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});
