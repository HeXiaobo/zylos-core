import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import {
  buildUpgradeCommands,
  validateCoreSource,
  validatePinnedTarget,
} from '../../../scripts/upgrade-fork-pair.js';

const CORE_SHA = '0123456789abcdef0123456789abcdef01234567';
const FEISHU_SHA = '89abcdef0123456789abcdef0123456789abcdef';

function writeCoreFixture(root) {
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({
    name: 'zylos',
    version: '0.7.2-rc.5',
  }));
  fs.writeFileSync(path.join(root, 'capabilities.json'), JSON.stringify({
    schemaVersion: 1,
    product: 'zylos-core',
    release: '0.7.2-rc.5',
    protocols: {
      'c4.reply': 2,
      'c4.reply.argv-compat': 1,
      'external-task-adapter': 1,
      'task-reminder': 1,
    },
  }));
  for (const relativePath of [
    'skills/comm-bridge/scripts/c4-send.js',
    'skills/comm-bridge/scripts/c4-receive.js',
    'skills/comm-bridge/scripts/c4-dispatcher.js',
    'skills/comm-bridge/scripts/c4-response-stream-supervisor.js',
    'scripts/upgrade-fork-pair.js',
    'scripts/upgrade-fork-pair.sh',
  ]) {
    const filePath = path.join(root, relativePath);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, '#!/usr/bin/env node\n');
  }
}

describe('fork-pair upgrade target contract', () => {
  it('accepts a complete pinned Core source fixture', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-upgrade-source-'));
    try {
      writeCoreFixture(root);

      assert.equal(validateCoreSource(root, '0.7.2-rc.5').ok, true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('accepts only immutable full commit SHAs and exact expected versions', () => {
    assert.deepEqual(validatePinnedTarget({
      coreSha: CORE_SHA,
      feishuSha: FEISHU_SHA,
      coreVersion: '0.7.2-rc.5',
      feishuVersion: '0.3.7-rc.5',
      agent: 'ss',
    }), { ok: true });

    const branch = validatePinnedTarget({
      coreSha: 'codex/native-task-upgrade-closure',
      feishuSha: FEISHU_SHA,
      coreVersion: '0.7.2-rc.5',
      feishuVersion: '0.3.7-rc.5',
      agent: 'ss',
    });
    assert.equal(branch.ok, false);
    assert.match(branch.error, /core SHA/);

    const missingAgent = validatePinnedTarget({
      coreSha: CORE_SHA,
      feishuSha: FEISHU_SHA,
      coreVersion: '0.7.2-rc.5',
      feishuVersion: '0.3.7-rc.5',
    });
    assert.equal(missingAgent.ok, false);
    assert.match(missingAgent.error, /agent identity/);
  });

  it('fails source validation when an immutable Core archive lacks c4-receive', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-upgrade-source-'));
    try {
      writeCoreFixture(root);
      fs.rmSync(path.join(root, 'skills/comm-bridge/scripts/c4-receive.js'));

      const result = validateCoreSource(root, '0.7.2-rc.5');

      assert.equal(result.ok, false);
      assert.match(result.error, /c4-receive\.js/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('builds both mutations from exact SHAs with no movable branch ref', () => {
    const commands = buildUpgradeCommands({
      nodePath: '/usr/bin/node',
      stagedCoreDir: '/tmp/core',
      installedCoreDir: '/opt/zylos',
      coreSha: CORE_SHA,
      feishuSha: FEISHU_SHA,
    });

    assert.deepEqual(commands.core, {
      command: '/usr/bin/node',
      args: [
        '/tmp/core/cli/zylos.js', 'upgrade', '--self', '--branch', CORE_SHA,
        '--yes', '--json',
      ],
    });
    assert.deepEqual(commands.feishu, {
      command: '/usr/bin/node',
      args: [
        '/opt/zylos/cli/zylos.js', 'upgrade', 'feishu', '--branch', FEISHU_SHA,
        '--yes', '--skip-eval', '--json',
      ],
    });
  });
});
