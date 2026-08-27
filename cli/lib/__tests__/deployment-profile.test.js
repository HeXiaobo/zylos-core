import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, it } from 'node:test';

import {
  createMemorySyncProfileDirective,
  loadMemoryGovernanceProfile,
  readProfileSelection,
  writeProfileSelection,
} from '../../../skills/zylos-memory/scripts/deployment-profile.js';

const ROOT = path.resolve(import.meta.dirname, '..', '..', '..');
const PROFILE_ROOT = path.join(ROOT, 'skills', 'zylos-memory', 'profiles');
const PROFILE_SCRIPT = path.join(
  ROOT,
  'skills',
  'zylos-memory',
  'scripts',
  'deployment-profile.js',
);
const temporaryDirectories = [];

function createZylosDir(config) {
  const zylosDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-profile-'));
  temporaryDirectories.push(zylosDir);
  if (config !== undefined) {
    const configDir = path.join(zylosDir, '.zylos');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(
      path.join(configDir, 'config.json'),
      `${JSON.stringify(config, null, 2)}\n`,
    );
  }
  return zylosDir;
}

afterEach(() => {
  for (const dir of temporaryDirectories.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('Agent and Deployment Profile selection', () => {
  it('loads no deployment-specific memory governance by default', () => {
    const zylosDir = createZylosDir();

    assert.deepEqual(readProfileSelection({ zylosDir, env: {} }), {
      agent: null,
      deployment: null,
    });
    assert.equal(
      loadMemoryGovernanceProfile({ zylosDir, env: {}, profileRoot: PROFILE_ROOT }),
      null,
    );
  });

  it('fails closed when config.json exists but is malformed', () => {
    const zylosDir = createZylosDir();
    const configDir = path.join(zylosDir, '.zylos');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, 'config.json'), '{broken json');

    assert.throws(
      () => readProfileSelection({ zylosDir, env: {} }),
      /cannot parse Zylos profile configuration/,
    );
  });

  it('fails closed when config.json cannot be read as a file', () => {
    const zylosDir = createZylosDir();
    fs.mkdirSync(path.join(zylosDir, '.zylos', 'config.json'), { recursive: true });

    assert.throws(
      () => readProfileSelection({ zylosDir, env: {} }),
      /cannot read Zylos profile configuration/,
    );
  });

  it('fails closed when config.json is a dangling symlink rather than absent', () => {
    const zylosDir = createZylosDir();
    const configDir = path.join(zylosDir, '.zylos');
    fs.mkdirSync(configDir, { recursive: true });
    fs.symlinkSync(
      path.join(zylosDir, 'missing-config-target.json'),
      path.join(configDir, 'config.json'),
    );

    assert.throws(
      () => readProfileSelection({ zylosDir, env: {} }),
      /cannot read Zylos profile configuration/,
    );
  });

  it('does not treat an Agent Profile as a Deployment Profile', () => {
    const zylosDir = createZylosDir({ profiles: { agent: 'mylos' } });

    assert.deepEqual(readProfileSelection({ zylosDir, env: {} }), {
      agent: 'mylos',
      deployment: null,
    });
    assert.equal(
      loadMemoryGovernanceProfile({ zylosDir, env: {}, profileRoot: PROFILE_ROOT }),
      null,
    );
  });

  it('loads 3AI governance only after explicit Deployment Profile opt-in', () => {
    const zylosDir = createZylosDir({
      profiles: { agent: 'mylos', deployment: '3ai' },
    });

    const profile = loadMemoryGovernanceProfile({
      zylosDir,
      env: {},
      profileRoot: PROFILE_ROOT,
    });

    assert.equal(profile.id, '3ai');
    assert.equal(profile.agentProfile, 'mylos');
    assert.match(profile.content, /3AI Memory Governance Profile/);
    assert.match(profile.content, /Commitment gate/);
    assert.match(profile.content, /Anti-Recurrence Gates/);
  });

  it('mechanically resolves selected governance into a verifiable Memory Sync directive', () => {
    const zylosDir = createZylosDir({
      profiles: { agent: 'mylos', deployment: '3ai' },
    });

    const directive = createMemorySyncProfileDirective({
      zylosDir,
      env: {},
      profileRoot: PROFILE_ROOT,
    });

    assert.match(directive, /Deployment Profile "3ai"/);
    assert.match(directive, /Agent Profile "mylos"/);
    assert.match(directive, /memory-governance\.md/);
    assert.match(directive, /sha256 [a-f0-9]{64}/);
    assert.match(directive, /must read that exact file and verify its sha256/);
    const expectedDigest = crypto.createHash('sha256').update(fs.readFileSync(
      path.join(PROFILE_ROOT, '3ai', 'memory-governance.md'),
    )).digest('hex');
    assert.match(directive, new RegExp(`sha256 ${expectedDigest}`));
  });

  it('allows a hosting platform to select the Deployment Profile via env', () => {
    const zylosDir = createZylosDir({ profiles: { deployment: 'default' } });

    const profile = loadMemoryGovernanceProfile({
      zylosDir,
      env: { ZYLOS_DEPLOYMENT_PROFILE: '3ai', ZYLOS_AGENT_PROFILE: 'coco-agent-26' },
      profileRoot: PROFILE_ROOT,
    });

    assert.equal(profile.id, '3ai');
    assert.equal(profile.agentProfile, 'coco-agent-26');
  });

  it('treats an explicitly blank runtime selector as disabling config fallback', () => {
    const zylosDir = createZylosDir({
      profiles: { agent: 'mylos', deployment: '3ai' },
    });

    assert.deepEqual(readProfileSelection({
      zylosDir,
      env: {
        ZYLOS_AGENT_PROFILE: '',
        ZYLOS_DEPLOYMENT_PROFILE: '   ',
      },
    }), {
      agent: null,
      deployment: null,
    });
  });

  it('writes nested profile selection without overwriting unrelated configuration', () => {
    const zylosDir = createZylosDir({
      llm: { provider: 'openai', model: 'gpt-5' },
      profiles: { existingExtension: { enabled: true }, agent: 'old-agent' },
    });

    const selection = writeProfileSelection({
      zylosDir,
      agent: 'yueran',
      deployment: '3ai',
    });

    assert.deepEqual(selection, { agent: 'yueran', deployment: '3ai' });
    assert.deepEqual(
      JSON.parse(fs.readFileSync(path.join(zylosDir, '.zylos', 'config.json'), 'utf8')),
      {
        llm: { provider: 'openai', model: 'gpt-5' },
        profiles: {
          existingExtension: { enabled: true },
          agent: 'yueran',
          deployment: '3ai',
        },
      },
    );
  });

  it('provides a pre-upgrade CLI that safely opts an existing deployment in', () => {
    const zylosDir = createZylosDir({ existing: { keep: true } });

    const result = spawnSync(process.execPath, [
      PROFILE_SCRIPT,
      'set',
      '--agent', 'yueran',
      '--deployment', '3ai',
    ], {
      encoding: 'utf8',
      env: { ...process.env, ZYLOS_DIR: zylosDir },
    });

    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {
      agent: 'yueran',
      deployment: '3ai',
    });
    const config = JSON.parse(
      fs.readFileSync(path.join(zylosDir, '.zylos', 'config.json'), 'utf8'),
    );
    assert.deepEqual(config.existing, { keep: true });
    assert.deepEqual(config.profiles, {
      agent: 'yueran',
      deployment: '3ai',
    });
  });

  it('fails closed for unknown or path-like profile identifiers', () => {
    const unknownDir = createZylosDir({ profiles: { deployment: 'unknown' } });
    const traversalDir = createZylosDir({ profiles: { deployment: '../3ai' } });

    assert.throws(
      () => loadMemoryGovernanceProfile({
        zylosDir: unknownDir,
        env: {},
        profileRoot: PROFILE_ROOT,
      }),
      /unknown Deployment Profile "unknown"/,
    );
    assert.throws(
      () => loadMemoryGovernanceProfile({
        zylosDir: traversalDir,
        env: {},
        profileRoot: PROFILE_ROOT,
      }),
      /invalid Deployment Profile identifier/,
    );
  });

  it('refuses a governance file symlink that escapes the bundled profile root', () => {
    const zylosDir = createZylosDir({ profiles: { deployment: 'outside' } });
    const profileRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-profile-root-'));
    const outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-profile-outside-'));
    temporaryDirectories.push(profileRoot, outsideRoot);
    fs.mkdirSync(path.join(profileRoot, 'outside'), { recursive: true });
    const outsideFile = path.join(outsideRoot, 'memory-governance.md');
    fs.writeFileSync(outsideFile, '# Untrusted outside policy\n');
    fs.symlinkSync(outsideFile, path.join(profileRoot, 'outside', 'memory-governance.md'));

    assert.throws(
      () => loadMemoryGovernanceProfile({ zylosDir, env: {}, profileRoot }),
      /unknown Deployment Profile "outside"/,
    );
  });

  it('keeps branded governance out of the default memory skill', () => {
    const defaultSkill = fs.readFileSync(
      path.join(ROOT, 'skills', 'zylos-memory', 'SKILL.md'),
      'utf8',
    );

    assert.doesNotMatch(defaultSkill, /3ai-shared/i);
    assert.doesNotMatch(defaultSkill, /Mylos/);
    assert.doesNotMatch(defaultSkill, /veda/);
  });
});
