import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const SHA = '0123456789abcdef0123456789abcdef01234567';
const CLI = path.join(import.meta.dirname, '..', '..', 'zylos.js');

test('generic component dry-run rejects instead of entering the mutating upgrade flow', () => {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-component-dry-run-'));
  const zylosDir = path.join(fixtureRoot, 'zylos-home');
  const component = 'demo';

  try {
    const child = spawnSync(process.execPath, [
      CLI,
      'upgrade',
      component,
      '--repo', 'owner/demo',
      '--branch', SHA,
      '--dry-run',
      '--json',
    ], {
      cwd: fixtureRoot,
      env: { ...process.env, ZYLOS_DIR: zylosDir },
      encoding: 'utf8',
      timeout: 30000,
    });

    assert.notEqual(child.status, 0, `stdout:\n${child.stdout}\nstderr:\n${child.stderr}`);
    const output = JSON.parse(child.stdout);
    assert.equal(output.error, 'dry_run_unsupported');
    assert.equal(output.success, false);
    assert.equal(output.component, component);
    assert.match(output.message, /dry-run.*supported/i);
    assert.equal(fs.existsSync(zylosDir), false);
  } finally {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});
