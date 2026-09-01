import { describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  classifyBranch,
  probeLocalIdentity,
  runGovernance,
  validateNoVersionMetadataChanges,
  validateDeploymentReadiness,
  validateReleaseManifest,
  validateReleaseMetadata,
} from '../scripts/agent-governance-check.js';

let tempRoot;

function writeFile(root, relativePath, content) {
  const fullPath = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content, 'utf8');
}

function writeJson(root, relativePath, value) {
  writeFile(root, relativePath, `${JSON.stringify(value, null, 2)}\n`);
}

function git(root, args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
}

function makeFixture({ withCapabilities = true, withSkillVersion = true } = {}) {
  const root = fs.mkdtempSync(path.join(tempRoot, 'repo-'));
  writeJson(root, 'package.json', {
    name: 'demo-core',
    version: '1.2.3',
    repository: { type: 'git', url: 'https://github.com/Acme/demo-core.git' },
  });
  writeJson(root, 'package-lock.json', {
    name: 'demo-core',
    version: '1.2.3',
    lockfileVersion: 3,
    packages: { '': { name: 'demo-core', version: '1.2.3' } },
  });
  if (withCapabilities) {
    writeJson(root, 'capabilities.json', {
      schemaVersion: 1,
      product: 'demo-core',
      release: '1.2.3',
      protocols: { 'example.protocol': 1 },
    });
  }
  const skillVersion = withSkillVersion ? 'version: 1.2.3\n' : '';
  writeFile(root, 'skills/demo/SKILL.md', `---\nname: demo\n${skillVersion}description: Demo skill\n---\n\n# Demo\n`);
  git(root, ['init', '-b', 'main']);
  git(root, ['config', 'user.email', 'governance-test@example.invalid']);
  git(root, ['config', 'user.name', 'Governance Test']);
  git(root, ['add', '.']);
  git(root, ['commit', '-m', 'fixture']);
  return { root, baseSha: git(root, ['rev-parse', 'HEAD']) };
}

beforeEach(() => {
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-agent-governance-'));
});

afterEach(() => {
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

describe('classifyBranch', () => {
  test.each([
    ['main', 'main', true],
    ['release/1.2.3', 'release', true],
    ['codex/agent-governance', 'feature', false],
    ['feat/123-add-gate', 'feature', false],
    ['wip/local-snapshot', 'wip', false],
    ['archive/old-candidate', 'archive', false],
  ])('%s is classified as %s', (branch, kind, releaseAllowed) => {
    expect(classifyBranch(branch)).toMatchObject({ name: branch, kind, releaseAllowed });
  });

  test('rejects an unclassified branch instead of treating it as releaseable', () => {
    expect(classifyBranch('agent-governance')).toMatchObject({ kind: 'unknown', releaseAllowed: false });
  });
});

describe('release metadata validation', () => {
  test('accepts matching package, lock, capabilities, and SKILL metadata', () => {
    const fixture = makeFixture();
    expect(validateReleaseMetadata({ root: fixture.root })).toMatchObject({ ok: true, version: '1.2.3' });
  });

  test('rejects a package-lock version drift', () => {
    const fixture = makeFixture();
    const lockPath = path.join(fixture.root, 'package-lock.json');
    const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    lock.packages[''].version = '1.2.4';
    fs.writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
    expect(validateReleaseMetadata({ root: fixture.root })).toMatchObject({ ok: false });
    expect(validateReleaseMetadata({ root: fixture.root }).errors.join('\n')).toMatch(/does not match/);
  });

  test('rejects capability and SKILL release metadata drift', () => {
    const fixture = makeFixture();
    const capabilitiesPath = path.join(fixture.root, 'capabilities.json');
    const capabilities = JSON.parse(fs.readFileSync(capabilitiesPath, 'utf8'));
    capabilities.release = '1.2.4';
    fs.writeFileSync(capabilitiesPath, `${JSON.stringify(capabilities, null, 2)}\n`);
    const skillPath = path.join(fixture.root, 'skills', 'demo', 'SKILL.md');
    fs.writeFileSync(skillPath, fs.readFileSync(skillPath, 'utf8').replace('version: 1.2.3', 'version: 1.2.4'));
    const result = validateReleaseMetadata({ root: fixture.root });
    expect(result.ok).toBe(false);
    expect(result.errors.join('\n')).toMatch(/capabilities\.json.*1\.2\.4|SKILL\.md.*1\.2\.4/);
  });
});

describe('feature branch version gate', () => {
  test('allows implementation changes that keep release metadata stable', () => {
    const fixture = makeFixture();
    writeFile(fixture.root, 'src/change.js', 'export const changed = true;\n');
    expect(validateNoVersionMetadataChanges({
      root: fixture.root,
      baseSha: fixture.baseSha,
      branch: 'codex/implementation',
    })).toMatchObject({ ok: true });
  });

  test('rejects a feature-branch package version bump relative to base', () => {
    const fixture = makeFixture();
    const packagePath = path.join(fixture.root, 'package.json');
    const packageJson = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
    packageJson.version = '1.2.4';
    fs.writeFileSync(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`);
    const result = validateNoVersionMetadataChanges({
      root: fixture.root,
      baseSha: fixture.baseSha,
      branch: 'feat/bump-version',
    });
    expect(result.ok).toBe(false);
    expect(result.errors.join('\n')).toMatch(/package\.json/);
  });

  test('rejects a SKILL frontmatter version change while allowing body edits', () => {
    const fixture = makeFixture();
    const skillPath = path.join(fixture.root, 'skills', 'demo', 'SKILL.md');
    fs.writeFileSync(skillPath, fs.readFileSync(skillPath, 'utf8').replace('version: 1.2.3', 'version: 1.2.4'));
    const result = validateNoVersionMetadataChanges({ root: fixture.root, baseSha: fixture.baseSha, branch: 'codex/skill-change' });
    expect(result.ok).toBe(false);
    expect(result.errors.join('\n')).toMatch(/SKILL\.md/);
  });
});

describe('external release manifest gate', () => {
  test('accepts a global v2 release manifest without probing a per-agent identity', () => {
    const fixture = makeFixture();
    const manifestPath = path.join(tempRoot, 'global-v2-release-manifest.json');
    writeJson(tempRoot, 'global-v2-release-manifest.json', {
      schema: 'zylos.release-manifest/v2',
      releaseId: 'demo-global-1.2.3-01',
      status: 'READY',
      deploymentAllowed: true,
      candidate: {
        core: {
          repo: 'Acme/demo-core',
          branch: 'main',
          version: '1.2.3',
          sha: fixture.baseSha,
        },
      },
      deploymentContract: { targetMode: 'global' },
    });

    const result = runGovernance({
      root: fixture.root,
      mode: 'release',
      manifestPath,
      identityProbePath: path.join(tempRoot, 'probe-must-not-be-called.mjs'),
    });

    expect(result.ok).toBe(true);
    expect(result.manifest).toMatchObject({
      releaseId: 'demo-global-1.2.3-01',
      status: 'READY',
      deploymentAllowed: true,
    });
  });

  test('keeps the deploy gate identity requirement for a global v2 manifest', () => {
    const fixture = makeFixture();
    const manifestPath = path.join(tempRoot, 'global-v2-deploy-manifest.json');
    writeJson(tempRoot, 'global-v2-deploy-manifest.json', {
      schema: 'zylos.release-manifest/v2',
      releaseId: 'demo-global-1.2.3-02',
      status: 'READY',
      deploymentAllowed: true,
      candidate: {
        core: {
          repo: 'Acme/demo-core',
          branch: 'main',
          version: '1.2.3',
          sha: fixture.baseSha,
        },
      },
      deploymentContract: { targetMode: 'global' },
    });

    const result = runGovernance({
      root: fixture.root,
      mode: 'deploy',
      manifestPath,
      identityProbePath: path.join(tempRoot, 'deploy-probe-missing.mjs'),
    });

    expect(result.ok).toBe(false);
    expect(result.errors.join('\n')).toMatch(/target\.agent|required|identity probe/);
  });

  test('uses a fresh HXA profile probe instead of trusting a command-line agent label', () => {
    const probePath = path.join(tempRoot, 'profile-cli.mjs');
    writeFile(tempRoot, 'profile-cli.mjs', `if (process.argv[2] !== 'profile') process.exit(2); console.log(${JSON.stringify(JSON.stringify({ name: 'ss', id: 'profile-ss' }))});\n`);
    expect(probeLocalIdentity({ probePath })).toMatchObject({ ok: true, identity: { name: 'ss', id: 'profile-ss' } });
  });

  test('accepts a READY manifest pinned to the current full SHA', () => {
    const fixture = makeFixture();
    const manifestPath = path.join(tempRoot, 'release-manifest.json');
    writeJson(tempRoot, 'release-manifest.json', {
      releaseId: 'demo-1.2.3-01',
      status: 'READY',
      deploymentAllowed: true,
      repo: 'Acme/demo-core',
      branch: 'release/1.2.3',
      version: '1.2.3',
      sha: fixture.baseSha,
      target: { agent: 'ss', profileId: 'profile-ss', hostname: 'host-ss' },
    });
    expect(validateReleaseManifest({
      root: fixture.root,
      manifestPath,
      sha: fixture.baseSha,
      version: '1.2.3',
      branch: 'release/1.2.3',
      repository: 'Acme/demo-core',
      localIdentity: { name: 'ss', id: 'profile-ss' },
      localHostname: 'host-ss',
    })).toMatchObject({ ok: true, releaseId: 'demo-1.2.3-01' });
  });

  test('requires READY and deploymentAllowed for release/deploy actions', () => {
    const fixture = makeFixture();
    const manifestPath = path.join(tempRoot, 'not-ready.json');
    writeJson(tempRoot, 'not-ready.json', {
      releaseId: 'demo-1.2.3-01',
      status: 'FROZEN',
      deploymentAllowed: false,
      repo: 'Acme/demo-core',
      branch: 'release/1.2.3',
      version: '1.2.3',
      sha: fixture.baseSha,
      target: { agent: 'ss', profileId: 'profile-ss', hostname: 'host-ss' },
    });
    const result = validateReleaseManifest({ root: fixture.root, manifestPath, sha: fixture.baseSha, version: '1.2.3', branch: 'release/1.2.3', repository: 'Acme/demo-core', localIdentity: { name: 'ss', id: 'profile-ss' }, localHostname: 'host-ss' });
    expect(result.ok).toBe(false);
    expect(result.errors.join('\n')).toMatch(/READY|deploymentAllowed/);
  });

  test('rejects a manifest stored inside the repository', () => {
    const fixture = makeFixture();
    const manifestPath = path.join(fixture.root, 'release-manifest.json');
    writeJson(fixture.root, 'release-manifest.json', {
      releaseId: 'demo-1.2.3-01', status: 'READY', deploymentAllowed: true,
      repo: 'Acme/demo-core', branch: 'release/1.2.3', version: '1.2.3', sha: fixture.baseSha,
      target: { agent: 'ss', profileId: 'profile-ss', hostname: 'host-ss' },
    });
    const result = validateReleaseManifest({ root: fixture.root, manifestPath, sha: fixture.baseSha, version: '1.2.3', branch: 'release/1.2.3', repository: 'Acme/demo-core' });
    expect(result.ok).toBe(false);
    expect(result.errors.join('\n')).toMatch(/outside the repository|self-reference/);
  });

  test('holds before deploy when the fresh identity differs from the manifest target', () => {
    const fixture = makeFixture();
    const manifestPath = path.join(tempRoot, 'identity-mismatch.json');
    const probePath = path.join(tempRoot, 'yueran-profile-cli.mjs');
    writeFile(tempRoot, 'yueran-profile-cli.mjs', `if (process.argv[2] !== 'profile') process.exit(2); console.log(${JSON.stringify(JSON.stringify({ name: 'yueran', id: 'profile-yueran' }))});\n`);
    writeJson(tempRoot, 'identity-mismatch.json', {
      releaseId: 'demo-1.2.3-01',
      status: 'READY',
      deploymentAllowed: true,
      repo: 'Acme/demo-core',
      branch: 'release/1.2.3',
      version: '1.2.3',
      sha: fixture.baseSha,
      target: { agent: 'ss', profileId: 'profile-ss', hostname: 'host-ss' },
    });
    const result = validateReleaseManifest({
      root: fixture.root,
      manifestPath,
      sha: fixture.baseSha,
      version: '1.2.3',
      branch: 'release/1.2.3',
      repository: 'Acme/demo-core',
      identityProbePath: probePath,
      localHostname: 'host-ss',
    });
    expect(result.ok).toBe(false);
    expect(result.errors.join('\n')).toMatch(/target agent ss.*yueran|target profileId/);
  });

  test('rejects a repository with the right slug but the wrong owner', () => {
    const fixture = makeFixture();
    const manifestPath = path.join(tempRoot, 'wrong-owner.json');
    writeJson(tempRoot, 'wrong-owner.json', {
      releaseId: 'demo-1.2.3-01',
      status: 'READY',
      deploymentAllowed: true,
      repo: 'OtherOwner/demo-core',
      branch: 'release/1.2.3',
      version: '1.2.3',
      sha: fixture.baseSha,
      target: { agent: 'ss', profileId: 'profile-ss', hostname: 'host-ss' },
    });
    const result = validateReleaseManifest({
      root: fixture.root,
      manifestPath,
      sha: fixture.baseSha,
      version: '1.2.3',
      branch: 'release/1.2.3',
      repository: 'Acme/demo-core',
      localIdentity: { name: 'ss', id: 'profile-ss' },
      localHostname: 'host-ss',
    });
    expect(result.ok).toBe(false);
    expect(result.errors.join('\n')).toMatch(/does not exactly match Acme\/demo-core/);
  });

  test('deploy readiness requires pair report, canary, and provenance evidence', () => {
    expect(validateDeploymentReadiness({ evidence: {} }).join('\n')).toMatch(/pairReport|canary=PASS|hxaProvenance=PASS/);
    expect(validateDeploymentReadiness({
      evidence: { pairReport: '/reports/pair.json', canary: 'PASS', hxaProvenance: 'PASS' },
    })).toEqual([]);
  });
});
