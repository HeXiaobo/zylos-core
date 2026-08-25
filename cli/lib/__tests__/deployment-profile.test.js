import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';

import {
  loadMemoryGovernanceProfile,
  readProfileSelection,
} from '../../../skills/zylos-memory/scripts/deployment-profile.js';

const ROOT = path.resolve(import.meta.dirname, '..', '..', '..');
const PROFILE_ROOT = path.join(ROOT, 'skills', 'zylos-memory', 'profiles');
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
