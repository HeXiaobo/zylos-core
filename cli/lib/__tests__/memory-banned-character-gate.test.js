import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const document = fs.readFileSync(new URL('../../../skills/zylos-memory/profiles/3ai/memory-governance.md', import.meta.url), 'utf8');
const scanner = document.match(/ZYLOS_7B_CODEPOINTS="<hex-code-point> \[<hex-code-point> \.\.\.\]" node -e '([\s\S]*?)\n   '/)?.[1];
assert.ok(scanner, 'run the scanner shipped in the governance instructions');

function runGate(t, { content = 'safe', fault = null, codepoints = '58' } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-memory-gate-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const memoryDir = path.join(directory, 'zylos', 'memory');
  fs.mkdirSync(memoryDir, { recursive: true });
  const file = path.join(memoryDir, 'entry.md');
  fs.writeFileSync(file, content);
  // Fault injection makes access errors deterministic even when CI runs as root.
  const method = fault === 'directory' ? 'readdirSync' : 'readFileSync';
  const faultPath = fault === 'directory' ? memoryDir : file;
  const prefix = `require('os').homedir = () => ${JSON.stringify(directory)};\n`
    + (fault ? `const original = require('fs').${method};
      require('fs').${method} = function(p, ...args) {
        if (p === ${JSON.stringify(faultPath)}) throw new Error('EACCES: test read refused');
        return original.call(this, p, ...args);
      };\n` : '');
  return spawnSync(process.execPath, ['-e', prefix + scanner], {
    encoding: 'utf8', env: { ...process.env, ZYLOS_7B_CODEPOINTS: codepoints },
  });
}

test('a complete clean memory scan passes', t => {
  const result = runGate(t);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /0 hits \(positive control passed\)/);
});

test('a readable banned character fails with a violation', t => {
  const result = runGate(t, { content: 'contains X' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /1 file\(s\) with hits/);
});

for (const fault of ['file', 'directory']) {
  test(`an unreadable ${fault} fails the scan instead of reporting zero hits`, t => {
    const result = runGate(t, { content: 'contains X', fault });
    assert.equal(result.status, 3);
    assert.match(result.stderr, /7b FAIL — memory scan incomplete:.*EACCES/);
    assert.doesNotMatch(result.stdout, /0 hits/);
  });
}

test('an absent banned-character list remains a loud failure', t => {
  const result = runGate(t, { codepoints: '' });
  assert.equal(result.status, 3);
  assert.match(result.stderr, /7b NOT EXECUTED/);
  assert.doesNotMatch(result.stdout, /0 hits/);
});
