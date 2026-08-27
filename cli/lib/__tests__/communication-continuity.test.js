import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import { verifyCommunicationContinuity } from '../communication-continuity.js';

const C4_SEND_PATH = path.resolve('skills/comm-bridge/scripts/c4-send.js');
const C4_RECEIVE_PATH = path.resolve('skills/comm-bridge/scripts/c4-receive.js');
const STRICT_C4_SEND_FIXTURE = path.resolve(
  'cli/lib/__tests__/fixtures/strict-c4-send.js',
);
const WORK_INTAKE_ENV = Object.freeze({
  ZYLOS_AGENT_ID: 'agent:continuity-canary',
});

function verify(options = {}) {
  return verifyCommunicationContinuity({
    workIntakeEnv: WORK_INTAKE_ENV,
    ...options,
  });
}

describe('communication continuity canary', () => {
  it('proves stdin and exact legacy reply calls preserve the message body', () => {
    const result = verify({ c4SendPath: C4_SEND_PATH });

    assert.equal(result.compatible, true, JSON.stringify(result));
    assert.deepEqual(result.checks.map(({ name, status }) => ({ name, status })), [
      { name: 'stdin_reply', status: 'passed' },
      { name: 'legacy_argv_reply', status: 'passed' },
      { name: 'inbound_receive', status: 'passed' },
      { name: 'inbound_persistence', status: 'passed' },
      { name: 'work_intake_default_assignee', status: 'passed' },
    ]);
  });

  it('fails closed when the deployed receive entrypoint is missing', () => {
    const result = verify({
      c4SendPath: C4_SEND_PATH,
      c4ReceivePath: `${C4_RECEIVE_PATH}.missing`,
    });

    assert.equal(result.compatible, false);
    assert.match(result.error, /inbound_receive/);
    assert.match(result.error, /not found/);
  });

  it('uses only safe body transports and proves argv is policy-rejected when strict policy is explicit', () => {
    const zylosDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-continuity-policy-'));
    try {
      fs.writeFileSync(path.join(zylosDir, '.env'), 'C4_STRICT_STDIN_ONLY=1\n');

      const result = verify({
        c4SendPath: C4_SEND_PATH,
        zylosDir,
        spawnSyncFn: (_command, args, options) => {
          assert.notEqual(options.env.C4_LEGACY_ARG_MODE, '1');
          const outputPath = options.env.C4_CANARY_OUTPUT;
          const bodyFileArg = args.find((arg) => arg.startsWith('--body-file='));
          if (options.input !== undefined) {
            fs.writeFileSync(outputPath, JSON.stringify([args[2], options.input]));
            return { status: 0, stdout: '', stderr: '' };
          }
          if (bodyFileArg) {
            const body = fs.readFileSync(bodyFileArg.slice('--body-file='.length), 'utf8');
            fs.writeFileSync(outputPath, JSON.stringify([args[2], body]));
            return { status: 0, stdout: '', stderr: '' };
          }
          return {
            status: 2,
            stdout: '',
            stderr: '[c4-send] arg-mode disabled: pass the message via stdin/heredoc, not as a CLI argument.',
          };
        },
      });

      assert.equal(result.compatible, true, JSON.stringify(result));
      assert.deepEqual(result.checks.map(({ name, status, mode }) => ({ name, status, mode })), [
        { name: 'stdin_reply', status: 'passed', mode: undefined },
        { name: 'body_file_reply', status: 'passed', mode: undefined },
        { name: 'legacy_argv_reply', status: 'passed', mode: 'strict_rejection' },
        { name: 'inbound_receive', status: 'passed', mode: undefined },
        { name: 'inbound_persistence', status: 'passed', mode: undefined },
        { name: 'work_intake_default_assignee', status: 'passed', mode: undefined },
      ]);
    } finally {
      fs.rmSync(zylosDir, { recursive: true, force: true });
    }
  });

  it('passes a real safe-only CLI process without enabling an argv break-glass', () => {
    const zylosDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-continuity-policy-'));
    try {
      fs.writeFileSync(path.join(zylosDir, '.env'), 'C4_STRICT_STDIN_ONLY=1\n');

      const result = verify({
        c4SendPath: STRICT_C4_SEND_FIXTURE,
        c4ReceivePath: C4_RECEIVE_PATH,
        c4DbPath: path.resolve('skills/comm-bridge/scripts/c4-db.js'),
        zylosDir,
      });

      assert.equal(result.compatible, true, JSON.stringify(result));
      assert.deepEqual(result.checks.map(({ name, status, mode }) => ({ name, status, mode })), [
        { name: 'stdin_reply', status: 'passed', mode: undefined },
        { name: 'body_file_reply', status: 'passed', mode: undefined },
        { name: 'legacy_argv_reply', status: 'passed', mode: 'strict_rejection' },
        { name: 'inbound_receive', status: 'passed', mode: undefined },
        { name: 'inbound_persistence', status: 'passed', mode: undefined },
        { name: 'work_intake_default_assignee', status: 'passed', mode: undefined },
      ]);
    } finally {
      fs.rmSync(zylosDir, { recursive: true, force: true });
    }
  });

  it('fails strict policy verification when rejected argv still produced a delivery', () => {
    const zylosDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-continuity-policy-'));
    let call = 0;
    try {
      fs.writeFileSync(path.join(zylosDir, '.env'), 'C4_STRICT_STDIN_ONLY=1\n');
      const result = verify({
        c4SendPath: C4_SEND_PATH,
        zylosDir,
        spawnSyncFn: (_command, args, options) => {
          call += 1;
          if (call <= 2) {
            const bodyFileArg = args.find((arg) => arg.startsWith('--body-file='));
            const body = options.input
              ?? fs.readFileSync(bodyFileArg.slice('--body-file='.length), 'utf8');
            fs.writeFileSync(options.env.C4_CANARY_OUTPUT, JSON.stringify([args[2], body]));
            return { status: 0, stdout: '', stderr: '' };
          }
          fs.writeFileSync(options.env.C4_CANARY_OUTPUT, JSON.stringify([args[2], args[3]]));
          return {
            status: 2,
            stdout: '',
            stderr: '[c4-send] arg-mode disabled by strict stdin-only policy: pass the message via stdin/heredoc.',
          };
        },
      });

      assert.equal(result.compatible, false);
      assert.match(result.error, /legacy_argv_reply/);
    } finally {
      fs.rmSync(zylosDir, { recursive: true, force: true });
    }
  });

  it('does not accept an arbitrary argv failure as the strict policy rejection', () => {
    const zylosDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-continuity-policy-'));
    let call = 0;
    try {
      fs.writeFileSync(path.join(zylosDir, '.env'), 'C4_STRICT_STDIN_ONLY=1\n');
      const result = verify({
        c4SendPath: C4_SEND_PATH,
        zylosDir,
        spawnSyncFn: (_command, args, options) => {
          call += 1;
          if (call <= 2) {
            const bodyFileArg = args.find((arg) => arg.startsWith('--body-file='));
            const body = options.input
              ?? fs.readFileSync(bodyFileArg.slice('--body-file='.length), 'utf8');
            fs.writeFileSync(options.env.C4_CANARY_OUTPUT, JSON.stringify([args[2], body]));
            return { status: 0, stdout: '', stderr: '' };
          }
          return {
            status: 2,
            stdout: '',
            stderr: [
              'permission denied',
              '[c4-send] arg-mode disabled: pass the message via stdin/heredoc, not as a CLI argument.',
            ].join('\n'),
          };
        },
      });

      assert.equal(result.compatible, false);
      assert.match(result.error, /legacy_argv_reply: permission denied/);
    } finally {
      fs.rmSync(zylosDir, { recursive: true, force: true });
    }
  });

  it('fails when the deployed executable breaks the legacy recovery contract', () => {
    let call = 0;
    const result = verify({
      c4SendPath: C4_SEND_PATH,
      spawnSyncFn: (_command, args, options) => {
        call += 1;
        if (call === 1) {
          fs.writeFileSync(
            options.env.C4_CANARY_OUTPUT,
            JSON.stringify([args[2], options.input]),
          );
          return { status: 0, stdout: '', stderr: '' };
        }
        return { status: 2, stdout: '', stderr: 'legacy contract removed' };
      },
    });

    assert.equal(result.compatible, false);
    assert.equal(result.checks[0].status, 'passed');
    assert.equal(result.checks[1].status, 'failed');
    assert.match(result.error, /legacy_argv_reply/);
  });

  it('honors the break-glass override when strict policy is present', () => {
    const zylosDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-continuity-policy-'));
    try {
      fs.writeFileSync(
        path.join(zylosDir, '.env'),
        'C4_STRICT_STDIN_ONLY=1\nC4_LEGACY_ARG_MODE=1\n',
      );

      const result = verify({
        c4SendPath: C4_SEND_PATH,
        zylosDir,
      });

      assert.equal(result.compatible, true, JSON.stringify(result));
    } finally {
      fs.rmSync(zylosDir, { recursive: true, force: true });
    }
  });

  it('fails closed when a managed deployment has no WorkIntake Agent identity', () => {
    const result = verifyCommunicationContinuity({
      c4SendPath: C4_SEND_PATH,
      workIntakeEnv: {},
    });

    assert.equal(result.compatible, false);
    assert.match(result.error, /work_intake_default_assignee/);
    assert.match(result.error, /ZYLOS_AGENT_ID or ZYLOS_AGENT_PROFILE/);
  });
});
