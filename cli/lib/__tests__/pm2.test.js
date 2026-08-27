import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createPm2Helpers } from '../pm2.js';

describe('PM2 ecosystem restart helpers', () => {
  it('restarts all named services through ecosystem config', () => {
    const calls = [];
    const { restartFromEcosystem } = createPm2Helpers({
      exists: (file) => file === '/tmp/ecosystem.config.cjs',
      exec: (cmd, opts) => calls.push({ cmd, opts }),
    });

    restartFromEcosystem(['activity-monitor', 'c4-dispatcher'], {
      ecosystemPath: '/tmp/ecosystem.config.cjs',
      stdio: 'inherit',
      save: true,
    });

    assert.deepStrictEqual(calls, [
      {
        cmd: 'pm2 start "/tmp/ecosystem.config.cjs" --only "activity-monitor" --update-env 2>/dev/null',
        opts: { stdio: 'inherit' },
      },
      {
        cmd: 'pm2 start "/tmp/ecosystem.config.cjs" --only "c4-dispatcher" --update-env 2>/dev/null',
        opts: { stdio: 'inherit' },
      },
      {
        cmd: 'pm2 save 2>/dev/null',
        opts: { stdio: 'inherit' },
      },
    ]);
  });

  it('throws when ecosystem restart is requested without a valid config file', () => {
    const { restartFromEcosystem } = createPm2Helpers({
      exists: () => false,
      exec: () => {
        throw new Error('should not execute');
      },
    });

    assert.throws(
      () => restartFromEcosystem(['activity-monitor'], { ecosystemPath: '/missing/ecosystem.config.cjs' }),
      /ecosystem config not found/
    );
  });

  it('uses ecosystem restart for managed processes when config exists', () => {
    const calls = [];
    const { restartManagedProcess } = createPm2Helpers({
      exists: (file) => file === '/tmp/component-ecosystem.config.cjs',
      inspectProcessStatus: () => 'online',
      exec: (cmd, opts) => calls.push({ cmd, opts }),
    });

    restartManagedProcess('zylos-wecom', {
      ecosystemPath: '/tmp/component-ecosystem.config.cjs',
      stdio: 'pipe',
    });

    assert.deepStrictEqual(calls, [
      {
        cmd: 'pm2 start "/tmp/component-ecosystem.config.cjs" --only "zylos-wecom" --update-env 2>/dev/null',
        opts: { stdio: 'pipe' },
      },
    ]);
  });

  it('falls back to plain restart only when no ecosystem config exists', () => {
    const calls = [];
    const { restartManagedProcess } = createPm2Helpers({
      exists: () => false,
      inspectProcessStatus: () => 'online',
      exec: (cmd, opts) => calls.push({ cmd, opts }),
    });

    restartManagedProcess('zylos-custom', {
      ecosystemPath: '/missing/component-ecosystem.config.cjs',
      stdio: 'pipe',
      save: true,
    });

    assert.deepStrictEqual(calls, [
      {
        cmd: 'pm2 restart "zylos-custom" 2>/dev/null',
        opts: { stdio: 'pipe' },
      },
      {
        cmd: 'pm2 save 2>/dev/null',
        opts: { stdio: 'pipe' },
      },
    ]);
  });

  it('verifies recovery when ecosystem restart first errors and then becomes a no-op', () => {
    const calls = [];
    let startAttempts = 0;
    let statusReads = 0;
    const { restartManagedProcess } = createPm2Helpers({
      exists: (file) => file === '/tmp/core-ecosystem.config.cjs',
      inspectProcessStatus: () => {
        statusReads += 1;
        return statusReads === 1 ? 'stopped' : 'online';
      },
      exec: (cmd, opts) => {
        calls.push({ cmd, opts });
        if (cmd.includes('pm2 start "/tmp/core-ecosystem.config.cjs"')) {
          startAttempts += 1;
        }
        if (cmd.includes('pm2 start "/tmp/core-ecosystem.config.cjs"') && startAttempts === 1) {
          throw new Error('bad ecosystem');
        }
      },
    });

    restartManagedProcess('activity-monitor', {
      ecosystemPath: '/tmp/core-ecosystem.config.cjs',
      stdio: 'inherit',
      fallbackToPlainRestartOnError: true,
      save: true,
    });

    assert.deepStrictEqual(calls, [
      {
        cmd: 'pm2 start "/tmp/core-ecosystem.config.cjs" --only "activity-monitor" --update-env 2>/dev/null',
        opts: { stdio: 'inherit' },
      },
      {
        cmd: 'pm2 delete "activity-monitor" 2>/dev/null',
        opts: { stdio: 'inherit' },
      },
      {
        cmd: 'pm2 start "/tmp/core-ecosystem.config.cjs" --only "activity-monitor" --update-env 2>/dev/null',
        opts: { stdio: 'inherit' },
      },
      {
        cmd: 'pm2 restart "activity-monitor" 2>/dev/null',
        opts: { stdio: 'inherit' },
      },
      {
        cmd: 'pm2 save 2>/dev/null',
        opts: { stdio: 'inherit' },
      },
    ]);
    assert.equal(statusReads, 2);
  });

  it('falls back to the cached PM2 definition when ecosystem --only is a no-op', () => {
    const calls = [];
    let statusReads = 0;
    const { restartManagedProcess } = createPm2Helpers({
      exists: (file) => file === '/tmp/core-ecosystem.config.cjs',
      inspectProcessStatus: () => {
        statusReads += 1;
        return statusReads === 1 ? 'stopped' : 'online';
      },
      exec: (cmd, opts) => calls.push({ cmd, opts }),
    });

    restartManagedProcess('zylos-feishu-task-comments', {
      ecosystemPath: '/tmp/core-ecosystem.config.cjs',
      stdio: 'pipe',
      fallbackToPlainRestartOnError: true,
      save: true,
    });

    assert.deepStrictEqual(calls, [
      {
        cmd: 'pm2 start "/tmp/core-ecosystem.config.cjs" --only "zylos-feishu-task-comments" --update-env 2>/dev/null',
        opts: { stdio: 'pipe' },
      },
      {
        cmd: 'pm2 restart "zylos-feishu-task-comments" 2>/dev/null',
        opts: { stdio: 'pipe' },
      },
      {
        cmd: 'pm2 save 2>/dev/null',
        opts: { stdio: 'pipe' },
      },
    ]);
    assert.equal(statusReads, 2);
  });

  it('fails when the cached restart still leaves the process stopped', () => {
    const { restartManagedProcess } = createPm2Helpers({
      exists: () => true,
      inspectProcessStatus: () => 'stopped',
      exec: () => {},
    });

    assert.throws(
      () => restartManagedProcess('zylos-feishu-task-comments', {
        ecosystemPath: '/tmp/core-ecosystem.config.cjs',
        fallbackToPlainRestartOnError: true,
      }),
      /is stopped after cached restart/
    );
  });

  it('propagates a cached restart failure when the process is missing', () => {
    const { restartManagedProcess } = createPm2Helpers({
      exists: () => true,
      inspectProcessStatus: () => null,
      exec: (cmd) => {
        if (cmd.startsWith('pm2 restart')) throw new Error('unknown process');
      },
    });

    assert.throws(
      () => restartManagedProcess('zylos-feishu-task-comments', {
        ecosystemPath: '/tmp/core-ecosystem.config.cjs',
        fallbackToPlainRestartOnError: true,
      }),
      /unknown process/
    );
  });

  it('fails closed when the PM2 postcondition cannot be inspected', () => {
    const { restartManagedProcess } = createPm2Helpers({
      exists: () => true,
      inspectProcessStatus: () => {
        throw new Error('jlist unavailable');
      },
      exec: () => {},
    });

    assert.throws(
      () => restartManagedProcess('zylos-feishu-task-comments', {
        ecosystemPath: '/tmp/core-ecosystem.config.cjs',
        fallbackToPlainRestartOnError: true,
      }),
      /jlist unavailable/
    );
  });

  it('does not save when a plain restart without an ecosystem remains stopped', () => {
    const calls = [];
    const { restartManagedProcess } = createPm2Helpers({
      exists: () => false,
      inspectProcessStatus: () => 'stopped',
      exec: (cmd) => calls.push(cmd),
    });

    assert.throws(
      () => restartManagedProcess('zylos-feishu-task-comments', {
        ecosystemPath: '/missing/core-ecosystem.config.cjs',
        save: true,
      }),
      /is stopped after restart/
    );
    assert.deepStrictEqual(calls, [
      'pm2 restart "zylos-feishu-task-comments" 2>/dev/null',
    ]);
  });

  it('does not save a component ecosystem no-op when cached fallback is disabled', () => {
    const calls = [];
    const { restartManagedProcess } = createPm2Helpers({
      exists: () => true,
      inspectProcessStatus: () => 'stopped',
      exec: (cmd) => calls.push(cmd),
    });

    assert.throws(
      () => restartManagedProcess('zylos-feishu', {
        ecosystemPath: '/tmp/component-ecosystem.config.cjs',
        save: true,
      }),
      /is stopped after ecosystem restart/
    );
    assert.deepStrictEqual(calls, [
      'pm2 start "/tmp/component-ecosystem.config.cjs" --only "zylos-feishu" --update-env 2>/dev/null',
    ]);
  });
});
