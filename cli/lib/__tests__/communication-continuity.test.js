import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import { verifyCommunicationContinuity } from '../communication-continuity.js';

const C4_SEND_PATH = path.resolve('skills/comm-bridge/scripts/c4-send.js');

describe('communication continuity canary', () => {
  it('proves stdin and exact legacy reply calls preserve the message body', () => {
    const result = verifyCommunicationContinuity({ c4SendPath: C4_SEND_PATH });

    assert.equal(result.compatible, true, JSON.stringify(result));
    assert.deepEqual(result.checks.map(({ name, status }) => ({ name, status })), [
      { name: 'stdin_reply', status: 'passed' },
      { name: 'legacy_argv_reply', status: 'passed' },
    ]);
  });

  it('verifies legacy recovery through break-glass when strict policy is explicit', () => {
    const zylosDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-continuity-policy-'));
    try {
      fs.writeFileSync(path.join(zylosDir, '.env'), 'C4_STRICT_STDIN_ONLY=1\n');

      const result = verifyCommunicationContinuity({
        c4SendPath: C4_SEND_PATH,
        zylosDir,
      });

      assert.equal(result.compatible, true, JSON.stringify(result));
      assert.equal(result.checks[0].status, 'passed');
      assert.equal(result.checks[1].status, 'passed');
      assert.equal(result.checks[1].mode, 'break_glass');
    } finally {
      fs.rmSync(zylosDir, { recursive: true, force: true });
    }
  });

  it('fails when the deployed executable breaks the legacy recovery contract', () => {
    let call = 0;
    const result = verifyCommunicationContinuity({
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

      const result = verifyCommunicationContinuity({
        c4SendPath: C4_SEND_PATH,
        zylosDir,
      });

      assert.equal(result.compatible, true, JSON.stringify(result));
    } finally {
      fs.rmSync(zylosDir, { recursive: true, force: true });
    }
  });
});
