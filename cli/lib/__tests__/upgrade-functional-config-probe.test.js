import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

// The probe that computes `functionalConfigSha256` travels with the repository,
// not only inside a published release's notes. A host that has this repository
// can therefore derive the same descriptor the published qualification used.
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const PROBE = path.join(ROOT, 'tools/upgrade/functional-config-probe.mjs');

function run(args) {
  try {
    return { status: 0, stdout: execFileSync(process.execPath, [PROBE, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) };
  } catch (error) {
    return { status: error.status, stdout: error.stdout || '', stderr: error.stderr || '' };
  }
}

test('the repository carries the authoritative functional-config probe consumers must run', () => {
  const source = fs.readFileSync(PROBE, 'utf8');
  assert.match(source, /'zylos\.functional-config\/v3'/, 'descriptor schema is the one the published fingerprints use');
  assert.match(source, /'zylos\.qualified-config-probe\/v3'/);
  assert.match(source, /readOnly: true/);
  // A released digest can only be reproduced when the consumer runs this exact
  // descriptor shape, so the schema must not drift silently.
  assert.match(source, /finalDeliveryMode: hxaFinalDelivery\.mode/);
  const help = run(['--help']);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /--zylos-dir DIR --core-source DIR --feishu-source DIR/);
  assert.match(help.stdout, /--runtime claude\|codex/);
  const missing = run([]);
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /Missing --zylos-dir/);
});

test('the upgrade documentation points consumers at the repository probe', () => {
  const upgrade = fs.readFileSync(path.join(ROOT, 'UPGRADE.md'), 'utf8');
  assert.match(upgrade, /tools\/upgrade\/functional-config-probe\.mjs/);
  const publish = fs.readFileSync(path.join(ROOT, 'tools/upgrade/PUBLISH.md'), 'utf8');
  assert.match(publish, /tools\/upgrade\/functional-config-probe\.mjs/);
  assert.match(publish, /do not paste/i);
});
