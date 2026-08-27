import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

const POSTINSTALL = path.resolve('scripts/postinstall.js');
const INSTALL_SCRIPT = path.resolve('scripts/install.sh');

function runPostinstallWithSentinel(extraEnv = {}) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-postinstall-isolation-'));
  const zylosDir = path.join(tmpDir, 'zylos');
  const settingsPath = path.join(zylosDir, '.claude', 'settings.json');
  const original = '{"sentinel":"keep"}\n';
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.writeFileSync(settingsPath, original);

  const env = {
    ...process.env,
    HOME: tmpDir,
    ZYLOS_DIR: zylosDir,
    ...extraEnv,
  };
  delete env.CI;
  const result = spawnSync(process.execPath, [POSTINSTALL], {
    cwd: path.resolve('.'),
    env,
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.readFileSync(settingsPath, 'utf8'), original);
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

describe('self-upgrade bootstrap postinstall isolation', () => {
  it('performs zero live writes when ZYLOS_SKIP_POSTINSTALL is set', () => {
    runPostinstallWithSentinel({
      ZYLOS_SKIP_POSTINSTALL: '1',
    });
  });

  it('performs zero live writes for a local target bootstrap without special flags', () => {
    runPostinstallWithSentinel({ npm_config_global: 'false' });
  });

  it('makes every shell bootstrap install suppress npm lifecycle scripts', () => {
    const installs = fs.readFileSync(INSTALL_SCRIPT, 'utf8')
      .split('\n')
      .filter((line) => /npm install -g --install-links/.test(line));

    assert.ok(installs.length > 0);
    assert.equal(installs.every((line) => line.includes('--ignore-scripts')), true);
  });
});
