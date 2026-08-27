import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

const { rollback, step7_runPostUpgradeHook, step8_startService } = await import('../upgrade.js');
const {
  step3_stopCoreServices,
  step11_startCoreServices,
  step12_verifyServices,
} = await import('../self-upgrade.js');
const { restartRuntimeServices } = await import('../../commands/runtime.js');

function makeSkillDir(frontmatter) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-upgrade-hook-'));
  const skillDir = path.join(tmpDir, 'demo');
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(path.join(skillDir, 'SKILL.md'), `---\nname: demo\n${frontmatter}---\n`, 'utf8');
  return { tmpDir, skillDir };
}

describe('step7_runPostUpgradeHook', () => {
  it('skips when no post-upgrade hook is declared', () => {
    const { tmpDir, skillDir } = makeSkillDir('');

    try {
      const result = step7_runPostUpgradeHook({ component: 'demo', skillDir }, {
        spawnSync: () => {
          throw new Error('should not run hook');
        },
      });

      assert.equal(result.status, 'skipped');
      assert.equal(result.message, 'no post-upgrade hook');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('fails closed when the declared hook file is missing', () => {
    const { tmpDir, skillDir } = makeSkillDir('lifecycle:\n  hooks:\n    post-upgrade: hooks/post-upgrade.js\n');

    try {
      const result = step7_runPostUpgradeHook({ component: 'demo', skillDir });

      assert.equal(result.status, 'failed');
      assert.equal(result.error, 'Hook not found: hooks/post-upgrade.js');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('runs an existing hook and returns captured output', () => {
    const { tmpDir, skillDir } = makeSkillDir('lifecycle:\n  hooks:\n    post-upgrade: hooks/post-upgrade.js\n');
    const hookPath = path.join(skillDir, 'hooks', 'post-upgrade.js');
    fs.mkdirSync(path.dirname(hookPath), { recursive: true });
    fs.writeFileSync(hookPath, 'console.log("ok");\n', 'utf8');
    const stdoutWrites = [];
    const stderrWrites = [];

    try {
      const result = step7_runPostUpgradeHook({ component: 'demo', skillDir, jsonOutput: false }, {
        spawnSync: (cmd, args, opts) => {
          assert.equal(cmd, process.execPath);
          assert.deepEqual(args, [hookPath]);
          assert.equal(opts.cwd, skillDir);
          assert.deepEqual(opts.stdio, ['ignore', 'pipe', 'pipe']);
          return { status: 0, stdout: 'hook stdout\n', stderr: 'hook stderr\n' };
        },
        stdout: { write: (value) => stdoutWrites.push(value) },
        stderr: { write: (value) => stderrWrites.push(value) },
      });

      assert.equal(result.status, 'done');
      assert.equal(result.message, 'hooks/post-upgrade.js');
      assert.deepEqual(result.output, { stdout: 'hook stdout\n', stderr: 'hook stderr\n' });
      assert.deepEqual(stdoutWrites, ['hook stdout\n']);
      assert.deepEqual(stderrWrites, ['hook stderr\n']);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('treats a failing hook as fatal and keeps diagnostics', () => {
    const { tmpDir, skillDir } = makeSkillDir('lifecycle:\n  hooks:\n    post-upgrade: hooks/post-upgrade.js\n');
    const hookPath = path.join(skillDir, 'hooks', 'post-upgrade.js');
    fs.mkdirSync(path.dirname(hookPath), { recursive: true });
    fs.writeFileSync(hookPath, 'process.exit(1);\n', 'utf8');

    try {
      const result = step7_runPostUpgradeHook({ component: 'demo', skillDir, jsonOutput: true }, {
        spawnSync: () => ({ status: 1, stdout: 'before fail\n', stderr: 'bad things\n' }),
      });

      assert.equal(result.status, 'failed');
      assert.match(result.error, /post-upgrade hook failed/);
      assert.match(result.error, /bad things/);
      assert.deepEqual(result.output, { stdout: 'before fail\n', stderr: 'bad things\n' });
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('does not replay hook output when jsonOutput is enabled', () => {
    const { tmpDir, skillDir } = makeSkillDir('lifecycle:\n  hooks:\n    post-upgrade: hooks/post-upgrade.js\n');
    const hookPath = path.join(skillDir, 'hooks', 'post-upgrade.js');
    fs.mkdirSync(path.dirname(hookPath), { recursive: true });
    fs.writeFileSync(hookPath, 'console.log("json safe");\n', 'utf8');
    const stdoutWrites = [];
    const stderrWrites = [];

    try {
      const result = step7_runPostUpgradeHook({ component: 'demo', skillDir, jsonOutput: true }, {
        spawnSync: () => ({ status: 0, stdout: 'hook stdout\n', stderr: 'hook stderr\n' }),
        stdout: { write: (value) => stdoutWrites.push(value) },
        stderr: { write: (value) => stderrWrites.push(value) },
      });

      assert.equal(result.status, 'done');
      assert.deepEqual(result.output, { stdout: 'hook stdout\n', stderr: 'hook stderr\n' });
      assert.deepEqual(stdoutWrites, []);
      assert.deepEqual(stderrWrites, []);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('fails closed for hook paths that escape the skill directory', () => {
    const { tmpDir, skillDir } = makeSkillDir('lifecycle:\n  hooks:\n    post-upgrade: ../outside.js\n');

    try {
      const result = step7_runPostUpgradeHook({ component: 'demo', skillDir }, {
        existsSync: () => true,
        spawnSync: () => {
          throw new Error('should not run hook');
        },
      });

      assert.equal(result.status, 'failed');
      assert.match(result.error, /escapes component directory/);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('fails closed for hook symlinks that resolve outside the skill directory', () => {
    const { tmpDir, skillDir } = makeSkillDir('lifecycle:\n  hooks:\n    post-upgrade: hooks/outside.js\n');
    const outsideHook = path.join(tmpDir, 'outside.js');
    const hookPath = path.join(skillDir, 'hooks', 'outside.js');
    fs.mkdirSync(path.dirname(hookPath), { recursive: true });
    fs.writeFileSync(outsideHook, 'console.log("outside");\n', 'utf8');
    fs.symlinkSync(outsideHook, hookPath);

    try {
      const result = step7_runPostUpgradeHook({ component: 'demo', skillDir }, {
        spawnSync: () => {
          throw new Error('should not run hook');
        },
      });

      assert.equal(result.status, 'failed');
      assert.match(result.error, /escapes component directory/);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('step8_startService', () => {
  it('retries deleted services through ecosystem restart instead of pm2 start <name>', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-upgrade-step8-'));
    const skillDir = path.join(tmpDir, 'demo');
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), `---\nname: demo\nlifecycle:\n  service:\n    name: zylos-demo\n---\n`, 'utf8');
    fs.writeFileSync(path.join(skillDir, 'ecosystem.config.cjs'), 'module.exports = { apps: [] };\n', 'utf8');

    const calls = [];
    let restartAttempts = 0;
    const result = step8_startService({
      component: 'demo',
      skillDir,
      serviceWasRunning: true,
    }, {
      restartManagedProcess: (name, opts) => {
        restartAttempts += 1;
        calls.push({ type: 'managed', name, opts });
        if (restartAttempts === 1) throw new Error('process missing');
      },
      execSync: (cmd) => {
        calls.push({ type: 'exec', cmd });
      },
      existsSync: (file) => file === path.join(skillDir, 'ecosystem.config.cjs'),
    });

    assert.equal(result.status, 'done');
    assert.equal(calls.filter((call) => call.type === 'managed' && call.name === 'zylos-demo').length, 2);
    assert.equal(calls.some((call) => call.type === 'exec' && call.cmd === 'pm2 start zylos-demo 2>/dev/null'), false);

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('persists the PM2 dump (save: true) on a normal upgrade restart (#1696)', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-upgrade-step8-save-'));
    const skillDir = path.join(tmpDir, 'demo');
    const ecosystemPath = path.join(skillDir, 'ecosystem.config.cjs');
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), `---\nname: demo\nlifecycle:\n  service:\n    name: zylos-demo\n---\n`, 'utf8');
    fs.writeFileSync(ecosystemPath, 'module.exports = { apps: [] };\n', 'utf8');

    const calls = [];
    const result = step8_startService({
      component: 'demo',
      skillDir,
      serviceWasRunning: true,
    }, {
      restartManagedProcess: (name, opts) => {
        calls.push({ name, opts });
      },
      existsSync: (file) => file === ecosystemPath,
    });

    assert.equal(result.status, 'done');
    assert.deepStrictEqual(calls, [{
      name: 'zylos-demo',
      opts: { ecosystemPath, stdio: 'pipe', save: true },
    }]);

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('persists the PM2 dump (save: true) when restarting from ecosystem after the process disappeared (#1696)', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-upgrade-step8-fallback-save-'));
    const skillDir = path.join(tmpDir, 'demo');
    const ecosystemPath = path.join(skillDir, 'ecosystem.config.cjs');
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), `---\nname: demo\nlifecycle:\n  service:\n    name: zylos-demo\n---\n`, 'utf8');
    fs.writeFileSync(ecosystemPath, 'module.exports = { apps: [] };\n', 'utf8');

    const restartCalls = [];
    let restartAttempts = 0;
    const result = step8_startService({
      component: 'demo',
      skillDir,
      serviceWasRunning: true,
    }, {
      restartManagedProcess: (name, opts) => {
        restartAttempts += 1;
        restartCalls.push({ name, opts });
        if (restartAttempts === 1) throw new Error('process missing');
      },
      execSync: () => {},
      existsSync: (file) => file === ecosystemPath,
    });

    assert.equal(result.status, 'done');
    assert.deepStrictEqual(restartCalls, [
      { name: 'zylos-demo', opts: { ecosystemPath, stdio: 'pipe', save: true } },
      { name: 'zylos-demo', opts: { ecosystemPath, stdio: 'pipe', save: true } },
    ]);

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('fails a component restart when ecosystem start is a zero-exit no-op', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-upgrade-step8-noop-'));
    const skillDir = path.join(tmpDir, 'demo');
    const binDir = path.join(tmpDir, 'bin');
    const ecosystemPath = path.join(skillDir, 'ecosystem.config.cjs');
    const logPath = path.join(tmpDir, 'pm2.log');
    const statePath = path.join(tmpDir, 'worker.status');
    const pm2Path = path.join(binDir, 'pm2');
    const originalPath = process.env.PATH;

    fs.mkdirSync(skillDir, { recursive: true });
    fs.mkdirSync(binDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), `---\nname: demo\nlifecycle:\n  service:\n    name: zylos-demo\n---\n`, 'utf8');
    fs.writeFileSync(ecosystemPath, 'module.exports = { apps: [] };\n', 'utf8');
    fs.writeFileSync(statePath, 'stopped\n', 'utf8');
    fs.writeFileSync(pm2Path, `#!/bin/sh\necho "$@" >> "${logPath}"\nif [ "$1" = "delete" ]; then echo missing > "${statePath}"; fi\nif [ "$1" = "jlist" ]; then status=$(cat "${statePath}"); if [ "$status" = "missing" ]; then echo '[]'; else echo "[{\\"name\\":\\"zylos-demo\\",\\"pm_id\\":31,\\"pm2_env\\":{\\"status\\":\\"$status\\"}}]"; fi; fi\n`, { mode: 0o755 });
    process.env.PATH = `${binDir}:${originalPath}`;

    try {
      const result = step8_startService({
        component: 'demo',
        skillDir,
        serviceWasRunning: true,
      });

      const log = fs.readFileSync(logPath, 'utf8');
      assert.equal(result.status, 'failed');
      assert.equal((log.match(/^start .*--only zylos-demo/gm) || []).length, 2);
      assert.match(log, /^delete zylos-demo$/m);
      assert.doesNotMatch(log, /^save$/m);
    } finally {
      process.env.PATH = originalPath;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('component upgrade rollback', () => {
  it('restores from skillDir/.backup/<timestamp> and preserves backup metadata', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-upgrade-rollback-'));
    const skillDir = path.join(tmpDir, 'skills', 'demo');
    const backupDir = path.join(skillDir, '.backup', 'run-1');

    fs.mkdirSync(backupDir, { recursive: true });
    fs.mkdirSync(path.join(skillDir, '.zylos'), { recursive: true });
    fs.mkdirSync(path.join(skillDir, 'node_modules'), { recursive: true });
    fs.writeFileSync(path.join(backupDir, 'SKILL.md'), 'old\n', 'utf8');
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), 'broken\n', 'utf8');
    fs.writeFileSync(path.join(skillDir, 'new-file.txt'), 'remove\n', 'utf8');
    fs.writeFileSync(path.join(skillDir, '.zylos', 'manifest.json'), '{}\n', 'utf8');
    fs.writeFileSync(path.join(skillDir, '.zylos', 'other-metadata.json'), 'keep\n', 'utf8');
    fs.writeFileSync(path.join(skillDir, 'node_modules', 'keep.txt'), 'deps\n', 'utf8');

    const results = rollback({
      backupDir,
      skillDir,
      serviceWasRunning: false,
    });

    assert.equal(results.some((item) => item.action === 'restore_files' && item.success), true);
    assert.equal(fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf8'), 'old\n');
    assert.equal(fs.existsSync(path.join(skillDir, 'new-file.txt')), false);
    assert.equal(fs.readFileSync(path.join(skillDir, '.backup', 'run-1', 'SKILL.md'), 'utf8'), 'old\n');
    assert.equal(fs.readFileSync(path.join(skillDir, 'node_modules', 'keep.txt'), 'utf8'), 'deps\n');
    // #715 commit-boundary contract: rollback never touches .zylos because
    // the outer pipeline commits the new baseline only after every failing
    // step has succeeded. The pre-upgrade baseline and other metadata stay.
    assert.equal(results.some((item) => item.action === 'restore_baseline'), false);
    assert.equal(fs.readFileSync(path.join(skillDir, '.zylos', 'manifest.json'), 'utf8'), '{}\n');
    assert.equal(fs.readFileSync(path.join(skillDir, '.zylos', 'other-metadata.json'), 'utf8'), 'keep\n');

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('persists the PM2 dump (save: true) when restarting the service after rollback (#1696)', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-upgrade-rollback-save-'));
    const skillDir = path.join(tmpDir, 'skills', 'demo');
    const ecosystemPath = path.join(skillDir, 'ecosystem.config.cjs');
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), `---\nname: demo\nlifecycle:\n  service:\n    name: zylos-demo\n---\n`, 'utf8');

    const calls = [];
    const results = rollback({
      skillDir,
      serviceWasRunning: true,
    }, {
      restartManagedProcess: (name, opts) => {
        calls.push({ name, opts });
      },
    });

    assert.equal(results.some((item) => item.action === 'restart_service' && item.success), true);
    assert.deepStrictEqual(calls, [{
      name: 'zylos-demo',
      opts: { ecosystemPath, stdio: 'pipe', save: true },
    }]);

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('restores the previous component Caddy routes before restarting service', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-upgrade-rollback-caddy-'));
    const skillDir = path.join(tmpDir, 'skills', 'demo');
    const backupDir = path.join(skillDir, '.backup', 'run-1');
    const oldRoutes = [{ path: '/old', type: 'reverse_proxy', target: 'localhost:3000' }];
    fs.mkdirSync(backupDir, { recursive: true });
    fs.writeFileSync(
      path.join(backupDir, 'SKILL.md'),
      `---\nname: demo\nhttp_routes:\n  - path: /old\n    type: reverse_proxy\n    target: localhost:3000\n---\n`,
      'utf8',
    );
    fs.writeFileSync(
      path.join(skillDir, 'SKILL.md'),
      `---\nname: demo\nhttp_routes:\n  - path: /new\n    type: reverse_proxy\n    target: localhost:4000\n---\n`,
      'utf8',
    );
    const calls = [];

    const results = rollback({
      component: 'demo',
      backupDir,
      skillDir,
      dataDir: path.join(tmpDir, 'components', 'demo'),
      dataDirExisted: false,
      backupComplete: true,
      caddyChanged: true,
      serviceWasRunning: false,
    }, {
      applyCaddyRoutes: (component, routes) => {
        calls.push({ component, routes });
        return { success: true, action: 'updated' };
      },
      removeCaddyRoutes: () => {
        throw new Error('old release has routes, should apply them');
      },
    });

    assert.deepEqual(calls, [{ component: 'demo', routes: oldRoutes }]);
    assert.equal(results.some(item => item.action === 'restore_caddy_routes' && item.success), true);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});

describe('step3_stopCoreServices', () => {
  it('records PM2 cron one-shots separately from long-running daemons', () => {
    const stopped = [];
    const ctx = {
      servicesWereRunning: [],
      servicesStopped: [],
      cronServicesWereRunning: [],
    };

    const result = step3_stopCoreServices(ctx, {
      getSkillsServices: () => [{
        name: 'task-comment-bridge',
        status: 'online',
        autorestart: false,
        cronRestart: '*/3 * * * *',
      }, {
        name: 'c4-dispatcher',
        status: 'online',
        autorestart: true,
        cronRestart: null,
      }],
      stopService: (name) => stopped.push(name),
    });

    assert.equal(result.status, 'done');
    assert.deepStrictEqual(stopped, ['task-comment-bridge', 'c4-dispatcher']);
    assert.deepStrictEqual(ctx.servicesWereRunning, ['task-comment-bridge', 'c4-dispatcher']);
    assert.deepStrictEqual(ctx.cronServicesWereRunning, ['task-comment-bridge']);
  });
});

describe('step11_startCoreServices', () => {
  it('restarts component daemons from their preserved PM2 definition', () => {
    const calls = [];
    const result = step11_startCoreServices({
      tempDir: null,
      servicesWereRunning: ['zylos-feishu-task-projection', 'c4-dispatcher'],
      cronServicesWereRunning: [],
    }, {
      fs: {
        existsSync: () => false,
        mkdirSync: () => {},
        copyFileSync: () => {},
      },
      requiredCoreServices: [],
      coreEcosystemServiceNames: ['c4-dispatcher'],
      restartExistingProcess: (name) => calls.push(`component:${name}`),
      restartManagedProcess: (name) => calls.push(`core:${name}`),
      execSync: (cmd) => calls.push(`exec:${cmd}`),
    });

    assert.equal(result.status, 'done');
    assert.deepStrictEqual(calls, [
      'component:zylos-feishu-task-projection',
      'core:c4-dispatcher',
      'exec:pm2 save 2>/dev/null',
    ]);
  });

  it('reactivates cron one-shots through their preserved PM2 definition', () => {
    const calls = [];
    const result = step11_startCoreServices({
      tempDir: null,
      servicesWereRunning: ['task-comment-bridge', 'c4-dispatcher'],
      cronServicesWereRunning: ['task-comment-bridge'],
    }, {
      fs: {
        existsSync: () => false,
        mkdirSync: () => {},
        copyFileSync: () => {},
      },
      requiredCoreServices: [],
      restartScheduledProcess: (name) => calls.push(`cron:${name}`),
      restartManagedProcess: (name) => calls.push(`daemon:${name}`),
      execSync: (cmd) => calls.push(`exec:${cmd}`),
    });

    assert.equal(result.status, 'done');
    assert.deepStrictEqual(calls, [
      'cron:task-comment-bridge',
      'daemon:c4-dispatcher',
      'exec:pm2 save 2>/dev/null',
    ]);
  });

  it('starts a newly introduced required Core service that is absent from PM2', () => {
    const calls = [];
    const ctx = {
      tempDir: null,
      servicesWereRunning: ['c4-dispatcher'],
      servicesExpectedAfterUpgrade: [],
      servicesStartedByUpgrade: [],
    };
    const result = step11_startCoreServices(ctx, {
      fs: {
        existsSync: () => true,
        mkdirSync: () => {},
        copyFileSync: () => {},
      },
      skillsDir: '/tmp/skills',
      ecosystemPath: '/tmp/core-ecosystem.config.cjs',
      getPm2ProcessNames: () => ['c4-dispatcher'],
      restartManagedProcess: (name, opts) => calls.push({ name, opts }),
      execSync: (cmd) => calls.push({ type: 'exec', cmd }),
    });

    assert.equal(result.status, 'done');
    assert.deepEqual(ctx.servicesStartedByUpgrade, ['c4-response-stream-supervisor']);
    assert.deepEqual(ctx.servicesExpectedAfterUpgrade, [
      'c4-dispatcher',
      'c4-response-stream-supervisor',
    ]);
    assert.deepEqual(calls.filter(call => call.name).map(call => call.name), [
      'c4-dispatcher',
      'c4-response-stream-supervisor',
    ]);
  });

  it('preserves a required Core service that is explicitly stopped in PM2', () => {
    const calls = [];
    const ctx = {
      tempDir: null,
      servicesWereRunning: ['c4-dispatcher'],
      servicesExpectedAfterUpgrade: [],
      servicesStartedByUpgrade: [],
    };
    const result = step11_startCoreServices(ctx, {
      fs: {
        existsSync: () => true,
        mkdirSync: () => {},
        copyFileSync: () => {},
      },
      skillsDir: '/tmp/skills',
      ecosystemPath: '/tmp/core-ecosystem.config.cjs',
      getPm2ProcessNames: () => ['c4-dispatcher', 'c4-response-stream-supervisor'],
      restartManagedProcess: (name, opts) => calls.push({ name, opts }),
      execSync: (cmd) => calls.push({ type: 'exec', cmd }),
    });

    assert.equal(result.status, 'done');
    assert.deepEqual(ctx.servicesStartedByUpgrade, []);
    assert.deepEqual(ctx.servicesExpectedAfterUpgrade, ['c4-dispatcher']);
    assert.deepEqual(calls.filter(call => call.name).map(call => call.name), ['c4-dispatcher']);
  });

  it('passes the core ecosystem path instead of null when no template is available yet', () => {
    const calls = [];
    const result = step11_startCoreServices({
      tempDir: null,
      servicesWereRunning: ['activity-monitor'],
    }, {
      fs: {
        existsSync: () => false,
        mkdirSync: () => {},
        copyFileSync: () => {},
      },
      ecosystemPath: '/tmp/core-ecosystem.config.cjs',
      restartManagedProcess: (name, opts) => {
        calls.push({ name, opts });
      },
      verifyActivityMonitorEnv: () => true,
      execSync: (cmd) => calls.push({ type: 'exec', cmd }),
    });

    assert.equal(result.status, 'done');
    assert.deepStrictEqual(calls, [{
      name: 'activity-monitor',
      opts: {
        ecosystemPath: '/tmp/core-ecosystem.config.cjs',
        stdio: 'pipe',
        fallbackToPlainRestartOnError: true,
      },
    }, {
      type: 'exec',
      cmd: 'pm2 save 2>/dev/null',
    }]);
  });

  it('uses the module default restart helper when no restart dep is injected', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-step11-default-'));
    const binDir = path.join(tmpDir, 'bin');
    const logPath = path.join(tmpDir, 'pm2.log');
    const ecosystemPath = path.join(tmpDir, 'ecosystem.config.cjs');
    const pm2Path = path.join(binDir, 'pm2');
    const originalPath = process.env.PATH;

    fs.mkdirSync(binDir, { recursive: true });
    fs.writeFileSync(ecosystemPath, 'module.exports = { apps: [] };\n', 'utf8');
    fs.writeFileSync(pm2Path, `#!/bin/sh\necho "$@" >> "${logPath}"\nif [ "$1" = "jlist" ]; then echo '[{"name":"activity-monitor","pm_id":3,"pm2_env":{"status":"online","ZYLOS_PACKAGE_ROOT":"${tmpDir}"}}]'; fi\n`, { mode: 0o755 });

    process.env.PATH = `${binDir}:${originalPath}`;

    try {
      const result = step11_startCoreServices({
        tempDir: null,
        servicesWereRunning: ['activity-monitor'],
      }, {
        fs: {
          existsSync: (file) => file === ecosystemPath,
          mkdirSync: () => {},
          copyFileSync: () => {},
        },
        ecosystemPath,
      });

      assert.equal(result.status, 'done');
      assert.match(fs.readFileSync(logPath, 'utf8'), /start .*ecosystem\.config\.cjs.*--only activity-monitor/);
      assert.match(fs.readFileSync(logPath, 'utf8'), /--update-env/);
      assert.match(fs.readFileSync(logPath, 'utf8'), /^jlist$/m);
      assert.doesNotMatch(fs.readFileSync(logPath, 'utf8'), /^env activity-monitor$/m);
      assert.match(fs.readFileSync(logPath, 'utf8'), /save/);
    } finally {
      process.env.PATH = originalPath;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('reactivates a stopped worker that is not declared by the core ecosystem', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-step11-component-worker-'));
    const binDir = path.join(tmpDir, 'bin');
    const logPath = path.join(tmpDir, 'pm2.log');
    const statePath = path.join(tmpDir, 'worker.status');
    const ecosystemPath = path.join(tmpDir, 'ecosystem.config.cjs');
    const pm2Path = path.join(binDir, 'pm2');
    const originalPath = process.env.PATH;

    fs.mkdirSync(binDir, { recursive: true });
    fs.writeFileSync(ecosystemPath, 'module.exports = { apps: [] };\n', 'utf8');
    fs.writeFileSync(statePath, 'stopped\n', 'utf8');
    fs.writeFileSync(pm2Path, `#!/bin/sh\necho "$@" >> "${logPath}"\nif [ "$1" = "restart" ] && [ "$2" = "zylos-feishu-task-comments" ]; then echo online > "${statePath}"; fi\nif [ "$1" = "jlist" ]; then status=$(cat "${statePath}"); echo "[{\\"name\\":\\"zylos-feishu-task-comments\\",\\"pm_id\\":30,\\"pm2_env\\":{\\"status\\":\\"$status\\"}}]"; fi\n`, { mode: 0o755 });

    process.env.PATH = `${binDir}:${originalPath}`;

    try {
      const result = step11_startCoreServices({
        tempDir: null,
        servicesWereRunning: ['zylos-feishu-task-comments'],
        cronServicesWereRunning: [],
      }, {
        fs: {
          existsSync: (file) => file === ecosystemPath,
          mkdirSync: () => {},
          copyFileSync: () => {},
        },
        ecosystemPath,
        requiredCoreServices: [],
      });

      const log = fs.readFileSync(logPath, 'utf8');
      assert.equal(result.status, 'done');
      assert.doesNotMatch(log, /start .*ecosystem\.config\.cjs.*--only zylos-feishu-task-comments/);
      assert.equal((log.match(/^jlist$/gm) || []).length, 0);
      assert.match(log, /^restart zylos-feishu-task-comments --update-env$/m);
      assert.match(log, /^save$/m);
      assert.equal(fs.readFileSync(statePath, 'utf8').trim(), 'online');
    } finally {
      process.env.PATH = originalPath;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('fails before saving when pm2 jlist lacks activity-monitor package-root env', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-step11-jlist-missing-'));
    const binDir = path.join(tmpDir, 'bin');
    const logPath = path.join(tmpDir, 'pm2.log');
    const ecosystemPath = path.join(tmpDir, 'ecosystem.config.cjs');
    const pm2Path = path.join(binDir, 'pm2');
    const originalPath = process.env.PATH;

    fs.mkdirSync(binDir, { recursive: true });
    fs.writeFileSync(ecosystemPath, 'module.exports = { apps: [] };\n', 'utf8');
    fs.writeFileSync(pm2Path, `#!/bin/sh\necho "$@" >> "${logPath}"\nif [ "$1" = "jlist" ]; then echo '[{"name":"activity-monitor","pm_id":3,"pm2_env":{"status":"online"}}]'; fi\n`, { mode: 0o755 });

    process.env.PATH = `${binDir}:${originalPath}`;

    try {
      const result = step11_startCoreServices({
        tempDir: null,
        servicesWereRunning: ['activity-monitor'],
      }, {
        fs: {
          existsSync: (file) => file === ecosystemPath,
          mkdirSync: () => {},
          copyFileSync: () => {},
        },
        ecosystemPath,
      });

      assert.equal(result.status, 'failed');
      assert.match(result.error, /ZYLOS_PACKAGE_ROOT/);
      assert.match(fs.readFileSync(logPath, 'utf8'), /^jlist$/m);
      assert.doesNotMatch(fs.readFileSync(logPath, 'utf8'), /^save$/m);
    } finally {
      process.env.PATH = originalPath;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('fails before saving when activity-monitor restarts without refreshed package-root env', () => {
    const calls = [];
    const result = step11_startCoreServices({
      tempDir: null,
      servicesWereRunning: ['activity-monitor'],
    }, {
      fs: {
        existsSync: () => false,
        mkdirSync: () => {},
        copyFileSync: () => {},
      },
      ecosystemPath: '/tmp/core-ecosystem.config.cjs',
      restartManagedProcess: (name, opts) => {
        calls.push({ name, opts });
      },
      verifyActivityMonitorEnv: () => false,
      execSync: (cmd) => calls.push({ type: 'exec', cmd }),
    });

    assert.equal(result.status, 'failed');
    assert.match(result.error, /ZYLOS_PACKAGE_ROOT/);
    assert.equal(calls.some(call => call.type === 'exec' && call.cmd === 'pm2 save 2>/dev/null'), false);
  });
});

describe('step12_verifyServices', () => {
  it('verifies services introduced during the upgrade as well as previously running services', () => {
    const commands = [];
    const result = step12_verifyServices({
      servicesWereRunning: ['c4-dispatcher'],
      servicesExpectedAfterUpgrade: ['c4-dispatcher', 'c4-response-stream-supervisor'],
    }, {
      skillsDir: '/tmp/skills',
      fs: {
        statSync: () => ({ isFile: () => true }),
      },
      execSync: (cmd) => {
        commands.push(cmd);
        if (cmd.startsWith('pm2 jlist')) {
          return JSON.stringify([
            {
              name: 'c4-dispatcher',
              pm2_env: {
                status: 'online',
                pm_exec_path: '/tmp/skills/comm-bridge/scripts/c4-dispatcher.js',
              },
            },
            {
              name: 'c4-response-stream-supervisor',
              pm2_env: {
                status: 'online',
                pm_exec_path: '/tmp/skills/comm-bridge/scripts/c4-response-stream-supervisor.js',
              },
            },
          ]);
        }
        return '';
      },
    });

    assert.equal(result.status, 'done');
    assert.equal(commands.some(cmd => cmd.startsWith('pm2 jlist')), true);
  });

  it('rejects a PM2 process that is online but points at a missing script', () => {
    const result = step12_verifyServices({
      servicesWereRunning: ['c4-response-stream-supervisor'],
      servicesExpectedAfterUpgrade: ['c4-response-stream-supervisor'],
    }, {
      skillsDir: '/tmp/zylos-missing-skills',
      execSync: (cmd) => {
        if (cmd.startsWith('pm2 jlist')) {
          return JSON.stringify([{
            name: 'c4-response-stream-supervisor',
            pm2_env: {
              status: 'online',
              pm_exec_path: '/tmp/zylos-missing-skills/comm-bridge/scripts/c4-response-stream-supervisor.js',
            },
          }]);
        }
        return '';
      },
    });

    assert.equal(result.status, 'failed');
    assert.match(result.error, /missing executable/);
  });

  it('accepts a healthy cron one-shot while it is normally stopped between runs', () => {
    const result = step12_verifyServices({
      servicesWereRunning: ['task-comment-bridge'],
      servicesExpectedAfterUpgrade: ['task-comment-bridge'],
    }, {
      fs: {
        statSync: () => ({ isFile: () => true }),
      },
      execSync: (cmd) => {
        if (cmd.startsWith('pm2 jlist')) {
          return JSON.stringify([{
            name: 'task-comment-bridge',
            pm2_env: {
              status: 'stopped',
              pm_exec_path: '/tmp/skills/task-comment-bridge.js',
              autorestart: false,
              cron_restart: '*/3 * * * *',
              unstable_restarts: 0,
              exit_code: 0,
            },
          }]);
        }
        return '';
      },
    });

    assert.equal(result.status, 'done');
  });

  it('still rejects a stopped cron one-shot whose executable disappeared', () => {
    const result = step12_verifyServices({
      servicesWereRunning: ['task-comment-bridge'],
      servicesExpectedAfterUpgrade: ['task-comment-bridge'],
    }, {
      fs: {
        statSync: () => {
          throw new Error('missing');
        },
      },
      execSync: (cmd) => {
        if (cmd.startsWith('pm2 jlist')) {
          return JSON.stringify([{
            name: 'task-comment-bridge',
            pm2_env: {
              status: 'stopped',
              pm_exec_path: '/tmp/skills/missing-task-comment-bridge.js',
              autorestart: false,
              cron_restart: '*/3 * * * *',
              unstable_restarts: 0,
              exit_code: 0,
            },
          }]);
        }
        return '';
      },
    });

    assert.equal(result.status, 'failed');
    assert.match(result.error, /missing executable/);
  });
});

describe('restartRuntimeServices', () => {
  it('falls back to plain restart when the core ecosystem file is missing', () => {
    const calls = [];

    restartRuntimeServices({
      services: ['activity-monitor'],
      ecosystemPath: '/missing/core-ecosystem.config.cjs',
      restartManagedProcessFn: (name, opts) => {
        calls.push({ name, opts });
      },
      logSuccess: () => {},
      logWarning: () => {},
    });

    assert.deepStrictEqual(calls, [{
      name: 'activity-monitor',
      opts: {
        ecosystemPath: '/missing/core-ecosystem.config.cjs',
        stdio: 'pipe',
        fallbackToPlainRestartOnError: true,
      },
    }]);
  });
});
