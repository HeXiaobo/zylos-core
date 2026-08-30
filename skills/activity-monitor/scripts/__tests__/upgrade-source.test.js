import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import { resolveCoreRepository } from '../upgrade-source.js';

describe('activity-monitor core repository routing', () => {
  it('loads the fork repository from a nonstandard Zylos directory', () => {
    const zylosDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-monitor-repo-'));
    fs.writeFileSync(
      path.join(zylosDir, '.env'),
      'ZYLOS_SELF_UPGRADE_REPO="HeXiaobo/zylos-core"\n',
    );

    const repo = resolveCoreRepository({
      env: { ZYLOS_DIR: zylosDir },
    });

    assert.equal(repo, 'HeXiaobo/zylos-core');
  });

  it('lets the live process override persisted routing', () => {
    const zylosDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-monitor-override-'));
    fs.writeFileSync(
      path.join(zylosDir, '.env'),
      'ZYLOS_SELF_UPGRADE_REPO=Other/core\n',
    );

    const repo = resolveCoreRepository({
      env: {
        ZYLOS_DIR: zylosDir,
        ZYLOS_SELF_UPGRADE_REPO: 'HeXiaobo/zylos-core',
      },
    });

    assert.equal(repo, 'HeXiaobo/zylos-core');
  });

  it('retains fork routing when persisted configuration is absent', () => {
    const zylosDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-monitor-default-'));
    assert.equal(resolveCoreRepository({
      env: { ZYLOS_DIR: zylosDir },
    }), 'HeXiaobo/zylos-core');
  });
});
