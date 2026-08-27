import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-upgrade-capabilities-'));
process.env.ZYLOS_DIR = path.join(root, 'zylos');
const { runUpgrade } = await import(new URL('../upgrade.js', import.meta.url));

test.after(() => fs.rmSync(root, { recursive: true, force: true }));

test('component upgrade rejects incompatible target capabilities before stopping or backing up', () => {
  const skillDir = path.join(process.env.ZYLOS_DIR, '.claude', 'skills', 'feishu');
  const targetDir = path.join(root, 'target-feishu');
  fs.mkdirSync(skillDir, { recursive: true });
  fs.mkdirSync(targetDir, { recursive: true });
  fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '---\nname: feishu\nversion: 0.3.5\n---\n');
  fs.writeFileSync(path.join(targetDir, 'capabilities.json'), JSON.stringify({
    schemaVersion: 1,
    product: 'zylos-feishu',
    requires: {
      'zylos-core': {
        schemaVersion: 1,
        protocols: { 'c4.reply': 3 },
      },
    },
  }));

  const result = runUpgrade('feishu', {
    tempDir: targetDir,
    newVersion: '0.3.8',
  });

  assert.equal(result.success, false);
  assert.equal(result.failedStep, 0);
  assert.match(result.error, /c4\.reply requires >= 3, found 2/);
  assert.equal(result.steps[0].name, 'verify_capabilities');
  assert.equal(fs.existsSync(path.join(skillDir, '.backup')), false);
});
