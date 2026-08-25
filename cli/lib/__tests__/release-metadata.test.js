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

    assert.equal(pkg.version, '0.7.2-rc.1');
    assert.equal(lock.version, pkg.version);
    assert.equal(lock.packages[''].version, pkg.version);
    assert.equal(capabilities.release, pkg.version);
    assert.equal(pkg.repository.url, 'https://github.com/HeXiaobo/zylos-core.git');
  });
});
