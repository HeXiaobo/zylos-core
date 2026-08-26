import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import {
  buildUpgradeCommands,
  validateCoreSource,
  validatePm2Snapshot,
  validatePinnedTarget,
} from '../../../scripts/upgrade-fork-pair.js';
import {
  buildHxaProbeCommands,
  validateHxaPm2Process,
  validateHxaRegistryEntry,
  validateHxaSource,
  validatePinnedHxaRecoveryTarget,
} from '../../../scripts/restore-hxa-connect.js';

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

  it('holds before mutation when any online PM2 process has no real executable', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-upgrade-pm2-'));
    try {
      const livePath = path.join(root, 'live.js');
      fs.writeFileSync(livePath, '#!/usr/bin/env node\n');
      const snapshot = [
        { name: 'activity-monitor', status: 'online', execPath: livePath },
        { name: 'c4-dispatcher', status: 'online', execPath: livePath },
        { name: 'zylos-feishu', status: 'online', execPath: livePath },
        {
          name: 'zylos-wechat',
          status: 'online',
          execPath: path.join(root, 'missing-wechat.js'),
        },
      ];

      assert.deepEqual(validatePm2Snapshot(snapshot), [
        `zylos-wechat reports online but has no live executable at ${path.join(root, 'missing-wechat.js')}`,
      ]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('pinned HXA recovery contract', () => {
  it('accepts only the SS agent and an immutable Core script SHA', () => {
    assert.deepEqual(validatePinnedHxaRecoveryTarget({
      coreSha: CORE_SHA,
      agent: 'ss',
    }), { ok: true });
    assert.equal(validatePinnedHxaRecoveryTarget({
      coreSha: 'main',
      agent: 'ss',
    }).ok, false);
    assert.equal(validatePinnedHxaRecoveryTarget({
      coreSha: CORE_SHA,
      agent: 'other',
    }).ok, false);
  });

  it('requires the exact HXA 1.7.3 package and runtime files', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-hxa-source-'));
    try {
      fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({
        name: 'zylos-hxa-connect',
        version: '1.7.3',
      }));
      for (const relativePath of [
        'SKILL.md',
        'src/bot.js',
        'scripts/cli.js',
        'ecosystem.config.cjs',
      ]) {
        const filePath = path.join(root, relativePath);
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, 'fixture\n');
      }

      assert.equal(validateHxaSource(root).ok, true);
      fs.rmSync(path.join(root, 'src', 'bot.js'));
      assert.match(validateHxaSource(root).error, /src\/bot\.js/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('accepts the historic upstream route but rejects version and path drift', () => {
    const zylosDir = '/home/cocoai/zylos';
    const valid = {
      version: '1.7.3',
      repo: 'coco-xyz/zylos-hxa-connect',
      skillDir: `${zylosDir}/.claude/skills/hxa-connect`,
      dataDir: `${zylosDir}/components/hxa-connect`,
    };
    assert.equal(validateHxaRegistryEntry(valid, zylosDir).ok, true);
    assert.equal(validateHxaRegistryEntry({ ...valid, version: '1.7.2' }, zylosDir).ok, false);
    assert.equal(validateHxaRegistryEntry({ ...valid, dataDir: '/tmp/wrong' }, zylosDir).ok, false);
  });

  it('rejects PM2 fake-online state and executable drift', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-hxa-pm2-'));
    try {
      const entry = path.join(root, 'src', 'bot.js');
      fs.mkdirSync(path.dirname(entry), { recursive: true });
      fs.writeFileSync(entry, 'fixture\n');
      assert.equal(validateHxaPm2Process({
        status: 'online',
        pid: 123,
        execPath: entry,
      }, entry).ok, true);
      assert.equal(validateHxaPm2Process({
        status: 'online',
        pid: null,
        execPath: entry,
      }, entry).ok, false);
      assert.equal(validateHxaPm2Process({
        status: 'online',
        pid: 123,
        execPath: path.join(root, 'wrong.js'),
      }, entry).ok, false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('lets the HXA CLI select the configured default org for live probes', () => {
    assert.deepEqual(buildHxaProbeCommands('/opt/hxa/scripts/cli.js'), [
      { name: 'profile', args: ['/opt/hxa/scripts/cli.js', 'profile'] },
      { name: 'peers', args: ['/opt/hxa/scripts/cli.js', 'peers'] },
    ]);
  });
});
