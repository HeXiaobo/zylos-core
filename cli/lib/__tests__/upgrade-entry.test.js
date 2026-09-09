import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { compareVersions, prepare } from '../../../tools/upgrade/prepare.mjs';
test('semantic ordering handles numeric RCs and stable versions', () => {
 assert.equal(compareVersions('0.7.2-rc.28', '0.7.2-rc.9'), 1);
 assert.equal(compareVersions('0.7.2', '0.7.2-rc.28'), 1);
 assert.equal(compareVersions('1.10.0', '1.9.99'), 1);
});
test('cannot overwrite an existing transaction', () => {
 const out = fs.mkdtempSync(path.join(os.tmpdir(), 'upgrade-entry-test-'));
 const marker = path.join(out, 'RUNNING'); fs.writeFileSync(marker, 'keep');
 try {
  assert.throws(() => prepare({ '--only': 'all', '--out': out, '--authorization-ref': 'test' }), /EEXIST/);
  assert.equal(fs.readFileSync(marker, 'utf8'), 'keep');
 } finally { fs.rmSync(out, { recursive: true }); }
});
test('invalid inputs do not create output', () => {
 const root = fs.mkdtempSync(path.join(os.tmpdir(), 'upgrade-entry-input-')); const out = path.join(root, 'new');
 try {
  for (const overrides of [{ '--authorization-ref': '' }, { '--core': 'main' }, { '--channel': 'bad' }]) {
   assert.throws(() => prepare({ '--only': 'all', '--out': out, '--authorization-ref': 'test', ...overrides }));
   assert.equal(fs.existsSync(out), false);
  }
 } finally { fs.rmSync(root, { recursive: true }); }
});
