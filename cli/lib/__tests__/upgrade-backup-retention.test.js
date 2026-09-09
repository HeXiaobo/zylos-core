import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-backup-retention-'));
process.env.ZYLOS_DIR = path.join(root, 'zylos');

const { cleanOldBackups } = await import(new URL('../upgrade.js', import.meta.url));

// Timestamps rendered by `new Date().toISOString().replace(/[:.]/g, '-')`.
const FRESH = '2026-09-05T08-42-36-749Z';
const OLDER_1 = '2026-09-04T10-00-00-000Z';
const OLDER_2 = '2026-08-30T09-54-00-000Z';
// An unrelated, manually created recovery snapshot: sorts AFTER any timestamp.
const MANUAL = 'card-readback-20260715-235223';

function seedBackups(skillDir, names) {
  for (const name of names) {
    const dir = path.join(skillDir, '.backup', name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'payload.txt'), name);
  }
}

test.after(() => fs.rmSync(root, { recursive: true, force: true }));

test('the just-created backup survives retention when an unrelated entry sorts after it (#72)', () => {
  const skillDir = path.join(root, 'fresh-vs-manual');
  seedBackups(skillDir, [FRESH, MANUAL]);

  cleanOldBackups(skillDir, path.join(skillDir, '.backup', FRESH));

  assert.equal(
    fs.existsSync(path.join(skillDir, '.backup', FRESH)),
    true,
    'the backup reported by this run must not be deleted',
  );
  assert.equal(
    fs.existsSync(path.join(skillDir, '.backup', MANUAL)),
    true,
    'manual snapshots are never managed by retention',
  );
});

test('older timestamped backups are removed and the newest kept', () => {
  const skillDir = path.join(root, 'newest-kept');
  seedBackups(skillDir, [OLDER_1, FRESH, OLDER_2]);

  cleanOldBackups(skillDir, path.join(skillDir, '.backup', FRESH));

  assert.equal(fs.existsSync(path.join(skillDir, '.backup', FRESH)), true);
  assert.equal(fs.existsSync(path.join(skillDir, '.backup', OLDER_1)), false);
  assert.equal(fs.existsSync(path.join(skillDir, '.backup', OLDER_2)), false);
});

test('without an explicit keep the newest timestamped backup is retained', () => {
  const skillDir = path.join(root, 'implicit-keep');
  seedBackups(skillDir, [OLDER_1, FRESH]);

  cleanOldBackups(skillDir);

  assert.equal(fs.existsSync(path.join(skillDir, '.backup', FRESH)), true);
  assert.equal(fs.existsSync(path.join(skillDir, '.backup', OLDER_1)), false);
});

test('a missing or non-directory backup root is ignored', () => {
  const skillDir = path.join(root, 'missing-root');
  assert.doesNotThrow(() => cleanOldBackups(skillDir));
  fs.mkdirSync(path.join(skillDir, '.backup'), { recursive: true });
  fs.writeFileSync(path.join(skillDir, '.backup', 'not-a-dir'), 'x');
  assert.doesNotThrow(() => cleanOldBackups(skillDir));
});
