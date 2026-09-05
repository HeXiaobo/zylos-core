import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { compareVersions, selectTag, prepare } from '../../../tools/upgrade/prepare.mjs';
test('latest sorts RC numerically and stable outranks same-version RC', () => {
 assert.equal(selectTag(['v0.7.2-rc.9', 'v0.7.2-rc.28', 'v0.7.1']).version, '0.7.2-rc.28');
 assert.equal(selectTag(['v0.7.2-rc.28', 'v0.7.2']).version, '0.7.2');
 assert.equal(compareVersions('1.10.0', '1.9.99'), 1);
});
test('stable excludes prereleases and exact versions never fall back', () => {
 assert.equal(selectTag(['v1.0.0', 'v1.1.0-rc.2'], 'latest', 'stable').version, '1.0.0');
 assert.equal(selectTag(['v1.1.0-rc.2'], 'v1.1.0-rc.2').version, '1.1.0-rc.2');
 assert.throws(() => selectTag(['v1.0.0'], '1.1.0'), /No published tag/);
});
test('rejects ambiguous labels and mutable selectors', () => {
 assert.throws(() => selectTag(['1.0.0', 'v1.0.0']), /Ambiguous/);
 for (const ref of ['main', '--help', '1.0.0-rc.01']) assert.throws(() => selectTag([], ref), /Invalid version/);
});
test('ignores nonrelease tags and rejects unknown channels', () => {
 assert.equal(selectTag(['build-2026', 'v1.0.0', 'v01.2.3']).version, '1.0.0');
 assert.throws(() => selectTag(['v1.0.0'], 'latest', 'typo'), /Channel/);
});
test('cannot overwrite an existing transaction', () => {
 const out = fs.mkdtempSync(path.join(os.tmpdir(), 'upgrade-entry-test-'));
 const marker = path.join(out, 'RUNNING'); fs.writeFileSync(marker, 'keep');
 try {
  assert.throws(() => prepare({ '--out': out, '--authorization-ref': 'test' }), /EEXIST/);
  assert.equal(fs.readFileSync(marker, 'utf8'), 'keep');
 } finally { fs.rmSync(out, { recursive: true }); }
});
test('invalid inputs do not create output', () => {
 const root = fs.mkdtempSync(path.join(os.tmpdir(), 'upgrade-entry-input-')); const out = path.join(root, 'new');
 try {
  for (const overrides of [{ '--authorization-ref': '' }, { '--core': 'main' }, { '--channel': 'bad' }]) {
   assert.throws(() => prepare({ '--out': out, '--authorization-ref': 'test', ...overrides }));
   assert.equal(fs.existsSync(out), false);
  }
 } finally { fs.rmSync(root, { recursive: true }); }
});
