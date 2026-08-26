import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

const ROOT = path.resolve(import.meta.dirname, '..', '..', '..');

describe('fork release metadata', () => {
  it('identifies the runtime-neutral release candidate consistently', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    const lock = JSON.parse(fs.readFileSync(path.join(ROOT, 'package-lock.json'), 'utf8'));
    const capabilities = JSON.parse(fs.readFileSync(path.join(ROOT, 'capabilities.json'), 'utf8'));

    assert.equal(pkg.version, '0.7.2-rc.8');
    assert.equal(lock.version, pkg.version);
    assert.equal(lock.packages[''].version, pkg.version);
    assert.equal(capabilities.release, pkg.version);
    assert.equal(capabilities.protocols['c4.outbound-delivery-id'], 1);
    assert.equal(capabilities.protocols['external-task-adapter'], 1);
    assert.equal(capabilities.protocols['task-reminder'], 1);
    assert.deepEqual(capabilities.runtimeModes['c4.runtime-turn-admission'], ['claude']);
    assert.equal(
      capabilities.runtimeModes['c4.assistant-response-stream'].codex,
      'explicit-c4-send',
    );
    assert.equal(pkg.repository.url, 'https://github.com/HeXiaobo/zylos-core.git');
  });
});
