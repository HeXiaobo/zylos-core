import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

const ROOT = path.resolve(import.meta.dirname, '..', '..', '..');
const CLI = path.join(ROOT, 'cli', 'zylos.js');

describe('zylos capabilities', () => {
  it('publishes the Core protocol contract as stable JSON', () => {
    const result = spawnSync(process.execPath, [CLI, 'capabilities', '--json'], {
      cwd: ROOT,
      encoding: 'utf8',
    });

    assert.equal(result.status, 0, result.stderr);
    const actual = JSON.parse(result.stdout);
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

    assert.equal(actual.schemaVersion, 1);
    assert.equal(actual.product, 'zylos-core');
    assert.equal(actual.release, pkg.version);
    assert.deepEqual(actual.protocols, {
      'c4.reply': 2,
      'c4.reply.argv-compat': 1,
      'c4.assistant-response-stream': 2,
      'c4.outbound-delivery-id': 1,
      'work-intake': 1,
      'commitment-core': 1,
      'external-task-adapter': 1,
      'projection-outbox': 1,
    });
  });
});
