import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const { restartServicesWithDeps } = await import('../../commands/service.js');

describe('restartServicesWithDeps', () => {
  it('routes every service through the managed online postcondition before saving', () => {
    const managedCalls = [];
    const execCalls = [];
    const messages = [];

    const ok = restartServicesWithDeps({
      restartManagedProcessFn: (name, opts) => {
        managedCalls.push({ name, opts });
      },
      getCoreEcosystemPathFn: () => '/tmp/ecosystem.config.cjs',
      execSyncFn: (cmd, opts) => execCalls.push({ cmd, opts }),
      logSuccess: (msg) => messages.push(msg),
      logError: (msg) => messages.push(msg),
    });

    assert.equal(ok, true);
    assert.deepStrictEqual(
      managedCalls.map((call) => call.name),
      [
        'activity-monitor',
        'scheduler',
        'c4-dispatcher',
        'c4-intake-supervisor',
        'c4-response-stream-supervisor',
        'web-console',
      ],
    );
    assert.equal(managedCalls.every((call) =>
      call.opts.ecosystemPath === '/tmp/ecosystem.config.cjs'
      && call.opts.stdio === 'inherit'
      && call.opts.fallbackToPlainRestartOnError === true
    ), true);
    assert.deepStrictEqual(execCalls, [{
      cmd: 'pm2 save 2>/dev/null',
      opts: { stdio: 'inherit' },
    }]);
    assert.equal(messages.some((msg) => String(msg).includes('Services restarted')), true);
  });

  it('keeps the prior PM2 dump when a later service fails its postcondition', () => {
    const execCalls = [];
    const messages = [];

    const ok = restartServicesWithDeps({
      restartManagedProcessFn: (name) => {
        if (name === 'web-console') {
          throw new Error('fallback failed');
        }
      },
      getCoreEcosystemPathFn: () => '/tmp/ecosystem.config.cjs',
      execSyncFn: (cmd, opts) => execCalls.push({ cmd, opts }),
      logSuccess: (msg) => messages.push(msg),
      logError: (msg) => messages.push(msg),
    });

    assert.equal(ok, false);
    assert.deepStrictEqual(execCalls, []);
    assert.equal(messages.some((msg) => String(msg).includes('Failed to restart services')), true);
  });
});
