import { describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
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

function sha256File(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function runGovernanceCli(root, mode, manifestPath) {
  const result = spawnSync(
    process.execPath,
    [
      'scripts/agent-governance-check.js',
      '--root', root,
      '--mode', mode,
      '--manifest', manifestPath,
      '--json',
    ],
    { cwd: path.resolve(import.meta.dirname, '..'), encoding: 'utf8' },
  );
  let report;
  try {
    report = JSON.parse(result.stdout);
  } catch (error) {
    throw new Error(`governance CLI did not return JSON: ${error.message}\n${result.stdout}\n${result.stderr}`);
  }
  return { ...result, report };
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
  const baseSha = git(root, ['rev-parse', 'HEAD']);
  git(root, ['remote', 'add', 'origin', 'https://github.com/HeXiaobo/zylos-core.git']);
  git(root, ['update-ref', 'refs/remotes/origin/main', baseSha]);
  return { root, baseSha };
}

function bindV2OwnerAuthorizationReport(manifest, fileName = 'owner-authorization.json') {
  const authorization = manifest.evidence.ownerAuthorization;
  const report = { ...authorization };
  delete report.report;
  delete report.reportSha256;
  const reportPath = path.join(tempRoot, fileName);
  writeJson(tempRoot, fileName, report);
  authorization.report = reportPath;
  authorization.reportSha256 = sha256File(reportPath);
  return manifest;
}

function bindV2PreflightReceipt(manifest, mode, fileName = `${mode}-preflight.json`) {
  const isDeploy = mode === 'deploy';
  const report = {
    schema: 'zylos.agent-preflight/v1',
    receiptType: isDeploy ? 'workspace-deploy' : 'workspace-publish',
    releaseId: manifest.releaseId,
    releaseStatus: manifest.status,
    mode,
    gate: isDeploy ? 'FINALIZE' : 'PUBLICATION',
    deploymentStage: isDeploy ? 'final' : null,
    status: 'PASS',
    deploymentAllowed: manifest.deploymentAllowed,
    publicationAllowed: manifest.publicationAllowed,
    targetMode: 'global',
    candidateBundle: {
      coreSha: manifest.candidate.core.sha,
      feishuSha: manifest.candidate.feishu.sha,
      hxaSha: manifest.candidate.hxa.sha,
    },
    dispositions: {
      publicationAllowed: manifest.publicationAllowed,
      deploymentAllowed: manifest.deploymentAllowed,
    },
    generatedAt: new Date().toISOString(),
  };
  if (isDeploy) {
    report.runtimeTarget = {
      agent: 'test-agent',
      profileId: 'test-profile',
      hostname: 'test-host',
      deploymentOrgLabel: 'zylos',
      deploymentProfileId: 'test-profile',
      identityObservedAt: new Date().toISOString(),
    };
  }
  const reportPath = path.join(tempRoot, fileName);
  writeJson(tempRoot, fileName, report);
  manifest.evidence[isDeploy ? 'globalPreflight' : 'workspacePublish'] = {
    receiptType: report.receiptType,
    report: reportPath,
    reportSha256: sha256File(reportPath),
  };
  return manifest;
}

function writeRuntimeIdentityFixture({
  hostname = 'test-host',
  agent = 'test-agent',
  profileId = 'test-profile',
  deploymentOrgLabel = 'zylos',
} = {}) {
  const registryPath = path.join(tempRoot, 'employee-runtime-registry.json');
  writeJson(tempRoot, 'employee-runtime-registry.json', {
    schema: 'zylos.employee-runtime-registry/v1',
    updatedAt: new Date().toISOString(),
    employees: {
      [agent]: {
        host: hostname,
        identity: {
          profileId,
          profileName: agent,
          deploymentProfileId: profileId,
          deploymentOrgLabel,
        },
      },
    },
  });
  const probePath = path.join(tempRoot, 'profile-verify.mjs');
  writeFile(tempRoot, 'profile-verify.mjs', `
const args = process.argv.slice(2);
const value = (flag) => args[args.indexOf(flag) + 1];
const org = value('--org');
const profileId = value('--profile-id');
const hostname = value('--hostname');
const profileName = ${JSON.stringify(agent)};
const observedAt = new Date().toISOString();
console.log(JSON.stringify({
  schema: 'zylos.hxa-org-profile-verification/v1',
  status: 'PASS',
  org,
  expected: { orgId: 'org-test', profileId, profileName, hostname },
  observed: { orgId: 'org-test', profileId, profileName, hostname, observedAt },
}));
`);
  return { registryPath, probePath, hostname, agent, profileId, deploymentOrgLabel };
}

function makeGlobalV2Manifest(fixture, {
  status = 'HOLD',
  deploymentAllowed = false,
  publicationAllowed = true,
} = {}) {
  const feishuSha = 'b'.repeat(40);
  const hxaSha = 'c'.repeat(40);
  const isDeploy = deploymentAllowed === true && publicationAllowed === false;
  const releaseId = 'demo-global-1.2.3-01';
  const manifest = {
    schema: 'zylos.release-manifest/v2',
    releaseId,
    status,
    deploymentAllowed,
    publicationAllowed,
    holdReasons: status === 'HOLD' ? ['publication pending deployment decision'] : [],
    candidate: {
      core: {
        repo: 'HeXiaobo/zylos-core',
        branch: 'main',
        version: '1.2.3',
        sha: fixture.baseSha,
      },
      feishu: {
        repo: 'HeXiaobo/zylos-feishu',
        branch: 'main',
        version: '2.3.4',
        sha: feishuSha,
      },
      hxa: {
        repo: 'HeXiaobo/zylos-hxa-connect',
        branch: 'main',
        packageVersion: '3.4.5',
        sha: hxaSha,
      },
    },
    sourcePolicy: {
      deployableBranch: 'main',
      immutableFullShaOnly: true,
      featureReleaseArchiveBranchesAreHistoryOnly: true,
    },
    deploymentContract: {
      targetMode: 'global',
      pairComponents: ['core', 'feishu'],
      hxaRequired: true,
      immutableFullShaOnly: true,
      cleanWorktreeRequired: true,
      dryRunRequired: true,
      pairReportRequired: true,
      canaryRequired: true,
    },
    evidence: {
      ownerAuthorization: {
        schema: isDeploy ? 'zylos.release-deployment-authorization/v1' : 'zylos.release-publication-authorization/v1',
        status: 'PASS',
        releaseId,
        identity: 'user',
        authorizedBy: 'owner@example.invalid',
        authorizationRef: `task:${releaseId}`,
        authorizedAt: new Date().toISOString(),
        ...(isDeploy ? { deploymentAuthorized: true, scope: 'DEPLOY_GLOBAL_BUNDLE' } : { publicationAuthorized: true, scope: 'RELEASE_GLOBAL_BUNDLE' }),
        bundle: {
          coreSha: fixture.baseSha,
          feishuSha,
          hxaSha,
        },
      },
      pairReport: { status: 'PASS' },
      canary: 'PASS',
      hxa: { status: 'PASS' },
      hxaProvenance: 'PASS',
    },
  };
  bindV2OwnerAuthorizationReport(manifest);
  bindV2PreflightReceipt(manifest, isDeploy ? 'deploy' : 'publish');
  return manifest;
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
    writeJson(tempRoot, 'global-v2-release-manifest.json', makeGlobalV2Manifest(fixture));

    const result = runGovernance({
      root: fixture.root,
      mode: 'release',
      manifestPath,
      identityProbePath: path.join(tempRoot, 'probe-must-not-be-called.mjs'),
    });

    expect(result.ok).toBe(true);
    expect(result.manifest).toMatchObject({
      releaseId: 'demo-global-1.2.3-01',
      status: 'HOLD',
      deploymentAllowed: false,
    });
  });

  test('uses the typed deploy receipt identity instead of a per-agent v2 manifest target', () => {
    const fixture = makeFixture();
    const manifestPath = path.join(tempRoot, 'global-v2-deploy-manifest.json');
    writeJson(tempRoot, 'global-v2-deploy-manifest.json', makeGlobalV2Manifest(fixture, {
      status: 'READY',
      deploymentAllowed: true,
      publicationAllowed: false,
    }));

    const result = runGovernance({
      root: fixture.root,
      mode: 'deploy',
      manifestPath,
      identityProbePath: path.join(tempRoot, 'deploy-probe-missing.mjs'),
    });

    expect(result.ok).toBe(false);
    expect(result.errors.join('\n')).not.toMatch(/target\.(agent|profileId|hostname) is required/);
    expect(result.errors.join('\n')).toMatch(/employee runtime registry|profile verification|runtimeTarget/);
  });

  test('accepts a global v2 deploy receipt only after registry and HXA verification agree', () => {
    const fixture = makeFixture();
    const identity = writeRuntimeIdentityFixture();
    const manifestPath = path.join(tempRoot, 'global-v2-deploy-verified.json');
    writeJson(tempRoot, 'global-v2-deploy-verified.json', makeGlobalV2Manifest(fixture, {
      status: 'READY',
      deploymentAllowed: true,
      publicationAllowed: false,
    }));

    const result = runGovernance({
      root: fixture.root,
      mode: 'deploy',
      manifestPath,
      identityProbePath: identity.probePath,
      localHostname: identity.hostname,
      env: { ZYLOS_EMPLOYEE_RUNTIME_REGISTRY: identity.registryPath },
    });

    expect(result.ok).toBe(true);
  });

  test('uses only candidate.core for v2 and rejects stable or top-level fallbacks', () => {
    const fixture = makeFixture();
    const manifestPath = path.join(tempRoot, 'global-v2-missing-candidate-core.json');
    const manifest = makeGlobalV2Manifest(fixture);
    delete manifest.candidate.core;
    manifest.stable = {
      core: {
        repo: 'Acme/demo-core',
        branch: 'main',
        version: '1.2.3',
        sha: fixture.baseSha,
      },
    };
    manifest.core = manifest.stable.core;
    writeJson(tempRoot, 'global-v2-missing-candidate-core.json', manifest);

    const result = runGovernance({
      root: fixture.root,
      mode: 'release',
      manifestPath,
      identityProbePath: path.join(tempRoot, 'probe-must-not-be-called.mjs'),
    });

    expect(result.ok).toBe(false);
    expect(result.errors.join('\n')).toMatch(/candidate\.core is required/);
  });

  test('public CLI fails closed when v2 candidate.core is replaced by a legacy fallback', () => {
    const fixture = makeFixture();
    const manifestPath = path.join(tempRoot, 'global-v2-cli-fallback.json');
    const manifest = makeGlobalV2Manifest(fixture);
    const candidate = manifest.candidate.core;
    delete manifest.candidate.core;
    manifest.stable = { core: candidate };
    manifest.core = candidate;
    writeJson(tempRoot, 'global-v2-cli-fallback.json', manifest);

    const result = runGovernanceCli(fixture.root, 'release', manifestPath);

    expect(result.status).toBe(1);
    expect(result.report.ok).toBe(false);
    expect(result.report.errors.join('\n')).toMatch(/no zylos-core component entry|candidate\.core is required/);
  });

  test('release mode requires publication permission and permits a held non-deployable v2 root', () => {
    const fixture = makeFixture();
    const manifestPath = path.join(tempRoot, 'global-v2-publication-permission.json');
    const manifest = makeGlobalV2Manifest(fixture, {
      status: 'HOLD',
      deploymentAllowed: false,
      publicationAllowed: false,
    });
    writeJson(tempRoot, 'global-v2-publication-permission.json', manifest);

    const blocked = runGovernance({
      root: fixture.root,
      mode: 'release',
      manifestPath,
      identityProbePath: path.join(tempRoot, 'probe-must-not-be-called.mjs'),
    });
    expect(blocked.ok).toBe(false);
    expect(blocked.errors.join('\n')).toMatch(/publicationAllowed.*true/);

    manifest.publicationAllowed = true;
    manifest.deploymentAllowed = true;
    writeJson(tempRoot, 'global-v2-publication-permission.json', manifest);
    const invalidHeldDeployment = runGovernance({
      root: fixture.root,
      mode: 'release',
      manifestPath,
      identityProbePath: path.join(tempRoot, 'probe-must-not-be-called.mjs'),
    });
    expect(invalidHeldDeployment.ok).toBe(false);
    expect(invalidHeldDeployment.errors.join('\n')).toMatch(/deploymentAllowed=true.*READY|Publication HOLD.*false/);
  });

  test('uses root status and permissions for v2 instead of candidate overrides', () => {
    const fixture = makeFixture();
    const manifestPath = path.join(tempRoot, 'global-v2-root-permissions.json');
    const manifest = makeGlobalV2Manifest(fixture, {
      status: 'CANCELLED',
      deploymentAllowed: false,
      publicationAllowed: false,
    });
    manifest.candidate.core.status = 'READY';
    manifest.candidate.core.deploymentAllowed = true;
    manifest.candidate.core.publicationAllowed = true;
    writeJson(tempRoot, 'global-v2-root-permissions.json', manifest);

    const result = runGovernance({
      root: fixture.root,
      mode: 'release',
      manifestPath,
      identityProbePath: path.join(tempRoot, 'probe-must-not-be-called.mjs'),
    });

    expect(result.ok).toBe(false);
    expect(result.errors.join('\n')).toMatch(/publicationAllowed.*true|CANCELLED|status HOLD or READY/);
  });

  test('requires the exact global deployment contract for v2 publication', () => {
    const fixture = makeFixture();
    const manifestPath = path.join(tempRoot, 'global-v2-invalid-contract.json');
    const manifest = makeGlobalV2Manifest(fixture);
    manifest.deploymentContract = {
      targetMode: 'per-agent',
      pairComponents: ['feishu', 'core', 'hxa'],
      hxaRequired: false,
    };
    writeJson(tempRoot, 'global-v2-invalid-contract.json', manifest);

    const result = runGovernance({
      root: fixture.root,
      mode: 'release',
      manifestPath,
      identityProbePath: path.join(tempRoot, 'probe-must-not-be-called.mjs'),
    });

    expect(result.ok).toBe(false);
    expect(result.errors.join('\n')).toMatch(/targetMode.*global/);
    expect(result.errors.join('\n')).toMatch(/pairComponents.*core.*feishu/);
    expect(result.errors.join('\n')).toMatch(/hxaRequired.*true/);
  });

  test.each(['immutableFullShaOnly', 'cleanWorktreeRequired', 'dryRunRequired', 'pairReportRequired', 'canaryRequired'])('requires deploymentContract.%s', (field) => {
    const fixture = makeFixture();
    const manifestPath = path.join(tempRoot, `global-v2-missing-${field}.json`);
    const manifest = makeGlobalV2Manifest(fixture);
    delete manifest.deploymentContract[field];
    writeJson(tempRoot, `global-v2-missing-${field}.json`, manifest);

    const result = runGovernance({
      root: fixture.root,
      mode: 'release',
      manifestPath,
      identityProbePath: path.join(tempRoot, 'probe-do-not-run.mjs'),
    });

    expect(result.ok).toBe(false);
    expect(result.errors.join('\n')).toMatch(new RegExp(`deploymentContract\\.${field}.*true`));
  });

  test('requires owner publication authorization and an exact three-repository bundle', () => {
    const fixture = makeFixture();
    const manifestPath = path.join(tempRoot, 'global-v2-invalid-owner-authorization.json');
    const manifest = makeGlobalV2Manifest(fixture);
    manifest.evidence.ownerAuthorization = {
      status: 'HOLD',
      identity: 'agent',
      publicationAuthorized: false,
      scope: 'LOCAL_ONLY',
      bundle: {
        coreSha: 'd'.repeat(40),
        feishuSha: 'not-a-sha',
        hxaSha: 'e'.repeat(40),
      },
    };
    writeJson(tempRoot, 'global-v2-invalid-owner-authorization.json', manifest);

    const result = runGovernance({
      root: fixture.root,
      mode: 'release',
      manifestPath,
      identityProbePath: path.join(tempRoot, 'probe-must-not-be-called.mjs'),
    });

    expect(result.ok).toBe(false);
    expect(result.errors.join('\n')).toMatch(/ownerAuthorization.*status.*PASS/);
    expect(result.errors.join('\n')).toMatch(/ownerAuthorization.*identity.*user/);
    expect(result.errors.join('\n')).toMatch(/publicationAuthorized.*true/);
    expect(result.errors.join('\n')).toMatch(/scope.*RELEASE_GLOBAL_BUNDLE/i);
    expect(result.errors.join('\n')).toMatch(/bundle\.coreSha.*does not match candidate/);
    expect(result.errors.join('\n')).toMatch(/bundle\.feishuSha.*full.*SHA/);
  });

  test('requires the publication authorization schema and report binding', () => {
    const fixture = makeFixture();
    const manifestPath = path.join(tempRoot, 'global-v2-owner-schema.json');
    const manifest = makeGlobalV2Manifest(fixture);
    delete manifest.evidence.ownerAuthorization.schema;
    writeJson(tempRoot, 'global-v2-owner-schema.json', manifest);

    const result = runGovernance({
      root: fixture.root,
      mode: 'release',
      manifestPath,
      identityProbePath: path.join(tempRoot, 'probe-must-not-be-called.mjs'),
    });

    expect(result.ok).toBe(false);
    expect(result.errors.join('\n')).toMatch(/ownerAuthorization\.schema.*zylos\.release-publication-authorization\/v1/);
  });

  test('uses an independent deployment authorization schema and scope', () => {
    const fixture = makeFixture();
    const manifestPath = path.join(tempRoot, 'global-v2-deploy-owner-schema.json');
    const manifest = makeGlobalV2Manifest(fixture, {
      status: 'READY',
      deploymentAllowed: true,
      publicationAllowed: false,
    });
    manifest.evidence.ownerAuthorization.schema = 'zylos.release-publication-authorization/v1';
    writeJson(tempRoot, 'global-v2-deploy-owner-schema.json', manifest);

    const result = runGovernance({
      root: fixture.root,
      mode: 'deploy',
      manifestPath,
      identityProbePath: path.join(tempRoot, 'probe-do-not-run.mjs'),
    });

    expect(result.ok).toBe(false);
    expect(result.errors.join('\n')).toMatch(/ownerAuthorization\.schema.*zylos\.release-deployment-authorization\/v1/);
  });

  test('rejects an authorization report whose body no longer matches the manifest evidence', () => {
    const fixture = makeFixture();
    const manifestPath = path.join(tempRoot, 'global-v2-owner-report-tampered.json');
    const manifest = makeGlobalV2Manifest(fixture);
    manifest.evidence.ownerAuthorization.authorizedBy = 'different-owner@example.invalid';
    writeJson(tempRoot, 'global-v2-owner-report-tampered.json', manifest);

    const result = runGovernance({
      root: fixture.root,
      mode: 'release',
      manifestPath,
      identityProbePath: path.join(tempRoot, 'probe-do-not-run.mjs'),
    });

    expect(result.ok).toBe(false);
    expect(result.errors.join('\n')).toMatch(/ownerAuthorization\.report body does not match authorization/);
  });

  test('requires a typed, release-bound workspace publication receipt', () => {
    const fixture = makeFixture();
    const manifestPath = path.join(tempRoot, 'global-v2-publish-receipt.json');
    const manifest = makeGlobalV2Manifest(fixture);
    const receiptPath = manifest.evidence.workspacePublish.report;
    const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
    delete receipt.dispositions;
    writeJson(tempRoot, path.basename(receiptPath), receipt);
    manifest.evidence.workspacePublish.reportSha256 = sha256File(receiptPath);
    writeJson(tempRoot, 'global-v2-publish-receipt.json', manifest);

    const result = runGovernance({
      root: fixture.root,
      mode: 'release',
      manifestPath,
      identityProbePath: path.join(tempRoot, 'probe-do-not-run.mjs'),
    });

    expect(result.ok).toBe(false);
    expect(result.errors.join('\n')).toMatch(/workspacePublish\.report\.dispositions/);
  });

  test('requires publication deploymentStage to be present and exactly null', () => {
    const fixture = makeFixture();
    const manifestPath = path.join(tempRoot, 'global-v2-publish-stage.json');
    const manifest = makeGlobalV2Manifest(fixture);
    const receiptPath = manifest.evidence.workspacePublish.report;
    const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
    delete receipt.deploymentStage;
    writeJson(tempRoot, path.basename(receiptPath), receipt);
    manifest.evidence.workspacePublish.reportSha256 = sha256File(receiptPath);
    writeJson(tempRoot, 'global-v2-publish-stage.json', manifest);

    const result = runGovernance({
      root: fixture.root,
      mode: 'release',
      manifestPath,
      identityProbePath: path.join(tempRoot, 'probe-do-not-run.mjs'),
    });

    expect(result.ok).toBe(false);
    expect(result.errors.join('\n')).toMatch(/workspacePublish\.report\.deploymentStage.*null/);
  });

  test('binds the publication receipt to the root release status and exact envelope shape', () => {
    const fixture = makeFixture();
    const manifestPath = path.join(tempRoot, 'global-v2-publish-receipt-binding.json');
    const manifest = makeGlobalV2Manifest(fixture);
    const receiptPath = manifest.evidence.workspacePublish.report;
    const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
    delete receipt.releaseStatus;
    writeJson(tempRoot, path.basename(receiptPath), receipt);
    manifest.evidence.workspacePublish.reportSha256 = sha256File(receiptPath);
    manifest.evidence.workspacePublish.unexpected = true;
    writeJson(tempRoot, 'global-v2-publish-receipt-binding.json', manifest);

    const result = runGovernance({
      root: fixture.root,
      mode: 'release',
      manifestPath,
      identityProbePath: path.join(tempRoot, 'probe-do-not-run.mjs'),
    });

    expect(result.ok).toBe(false);
    expect(result.errors.join('\n')).toMatch(/workspacePublish.*exactly receiptType, report, and reportSha256/);
    expect(result.errors.join('\n')).toMatch(/workspacePublish\.report\.releaseStatus.*match/);
  });

  test('requires a fresh runtime-bound global deployment receipt', () => {
    const fixture = makeFixture();
    const manifest = makeGlobalV2Manifest(fixture, {
      status: 'READY',
      deploymentAllowed: true,
      publicationAllowed: false,
    });
    const receiptPath = manifest.evidence.globalPreflight.report;
    const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
    delete receipt.runtimeTarget.identityObservedAt;
    writeJson(tempRoot, path.basename(receiptPath), receipt);
    manifest.evidence.globalPreflight.reportSha256 = sha256File(receiptPath);
    const result = validateDeploymentReadiness({
      ...manifest,
      evidence: {
        ...manifest.evidence,
        pairReport: { status: 'PASS' },
        canary: 'PASS',
        hxa: { status: 'PASS' },
      },
    });

    expect(result.join('\n')).toMatch(/globalPreflight\.report\.runtimeTarget\.identityObservedAt/);
  });

  test('rejects a fresh-looking deploy identity that disagrees with trusted registry and HXA verification', () => {
    const fixture = makeFixture();
    const identity = writeRuntimeIdentityFixture();
    const manifestPath = path.join(tempRoot, 'global-v2-deploy-forged-identity.json');
    const manifest = makeGlobalV2Manifest(fixture, {
      status: 'READY',
      deploymentAllowed: true,
      publicationAllowed: false,
    });
    const receiptPath = manifest.evidence.globalPreflight.report;
    const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
    receipt.runtimeTarget.agent = 'forged-agent';
    writeJson(tempRoot, path.basename(receiptPath), receipt);
    manifest.evidence.globalPreflight.reportSha256 = sha256File(receiptPath);
    writeJson(tempRoot, 'global-v2-deploy-forged-identity.json', manifest);

    const result = runGovernance({
      root: fixture.root,
      mode: 'deploy',
      manifestPath,
      identityProbePath: identity.probePath,
      localHostname: identity.hostname,
      env: { ZYLOS_EMPLOYEE_RUNTIME_REGISTRY: identity.registryPath },
    });

    expect(result.ok).toBe(false);
    expect(result.errors.join('\n')).toMatch(/runtimeTarget\.agent.*registry|registry.*runtimeTarget\.agent/);
  });

  test('requires immutable main source policy and strict candidate identity fields', () => {
    const fixture = makeFixture();
    const manifestPath = path.join(tempRoot, 'global-v2-invalid-source-policy.json');
    const manifest = makeGlobalV2Manifest(fixture);
    manifest.sourcePolicy = {
      deployableBranch: 'release/1.2.3',
      immutableFullShaOnly: false,
      featureReleaseArchiveBranchesAreHistoryOnly: false,
    };
    manifest.candidate.core.branch = 'codex/unpublished-candidate';
    manifest.candidate.core.sha = manifest.candidate.core.sha.toUpperCase();
    writeJson(tempRoot, 'global-v2-invalid-source-policy.json', manifest);

    const result = runGovernance({
      root: fixture.root,
      mode: 'release',
      manifestPath,
      identityProbePath: path.join(tempRoot, 'probe-must-not-be-called.mjs'),
    });

    expect(result.ok).toBe(false);
    expect(result.errors.join('\n')).toMatch(/sourcePolicy\.deployableBranch.*main/);
    expect(result.errors.join('\n')).toMatch(/immutableFullShaOnly.*true/);
    expect(result.errors.join('\n')).toMatch(/featureReleaseArchiveBranchesAreHistoryOnly.*true/);
    expect(result.errors.join('\n')).toMatch(/candidate\.core\.sha.*lowercase/);
    expect(result.errors.join('\n')).toMatch(/candidate\.core.*branch.*current branch|manifest branch/);
  });

  test('does not allow a CI branch value to override the real symbolic-ref in release mode', () => {
    const fixture = makeFixture();
    const manifestPath = path.join(tempRoot, 'global-v2-branch-authority.json');
    writeJson(tempRoot, 'global-v2-branch-authority.json', makeGlobalV2Manifest(fixture));

    const result = runGovernance({
      root: fixture.root,
      mode: 'release',
      branch: 'release/forged',
      env: { GITHUB_REF_NAME: 'release/forged' },
      manifestPath,
      identityProbePath: path.join(tempRoot, 'probe-do-not-run.mjs'),
    });

    expect(result.branch).toBe('main');
    expect(result.ok).toBe(false);
    expect(result.errors.join('\n')).toMatch(/CI branch ref .*does not match actual symbolic-ref\/HEAD main/);
  });

  test('does not fall back to package repository metadata when v2 origin is missing', () => {
    const fixture = makeFixture();
    git(fixture.root, ['remote', 'remove', 'origin']);
    const manifestPath = path.join(tempRoot, 'global-v2-missing-origin.json');
    writeJson(tempRoot, 'global-v2-missing-origin.json', makeGlobalV2Manifest(fixture));

    const result = runGovernance({
      root: fixture.root,
      mode: 'release',
      manifestPath,
      identityProbePath: path.join(tempRoot, 'probe-do-not-run.mjs'),
    });

    expect(result.ok).toBe(false);
    expect(result.errors.join('\n')).toMatch(/origin.*GitHub repository HeXiaobo\/zylos-core/);
  });

  test('requires every origin URL to identify exactly the Core fork', () => {
    const fixture = makeFixture();
    git(fixture.root, ['config', '--add', 'remote.origin.url', 'https://evil.example/HeXiaobo/zylos-core.git']);
    const manifestPath = path.join(tempRoot, 'global-v2-mixed-origin.json');
    writeJson(tempRoot, 'global-v2-mixed-origin.json', makeGlobalV2Manifest(fixture));

    const result = runGovernance({
      root: fixture.root,
      mode: 'release',
      manifestPath,
      identityProbePath: path.join(tempRoot, 'probe-do-not-run.mjs'),
    });

    expect(result.ok).toBe(false);
    expect(result.errors.join('\n')).toMatch(/origin.*all|origin.*exact|does not identify GitHub repository/);
  });

  test('requires the candidate SHA to be an ancestor of origin/main', () => {
    const fixture = makeFixture();
    const emptyTree = execFileSync('git', ['mktree'], {
      cwd: fixture.root,
      input: '',
      encoding: 'utf8',
    }).trim();
    const unrelatedSha = execFileSync('git', ['commit-tree', emptyTree, '-m', 'unrelated origin head'], {
      cwd: fixture.root,
      encoding: 'utf8',
    }).trim();
    git(fixture.root, ['update-ref', 'refs/remotes/origin/main', unrelatedSha]);
    const manifestPath = path.join(tempRoot, 'global-v2-non-ancestor.json');
    writeJson(tempRoot, 'global-v2-non-ancestor.json', makeGlobalV2Manifest(fixture));

    const result = runGovernance({
      root: fixture.root,
      mode: 'release',
      manifestPath,
      identityProbePath: path.join(tempRoot, 'probe-do-not-run.mjs'),
    });

    expect(result.ok).toBe(false);
    expect(result.errors.join('\n')).toMatch(/must be an ancestor of origin\/main/);
  });

  test('requires every v2 candidate component to use the deployable branch', () => {
    const fixture = makeFixture();
    const manifestPath = path.join(tempRoot, 'global-v2-component-branch.json');
    const manifest = makeGlobalV2Manifest(fixture);
    manifest.candidate.feishu.branch = 'codex/unpublished-candidate';
    writeJson(tempRoot, 'global-v2-component-branch.json', manifest);

    const result = runGovernance({
      root: fixture.root,
      mode: 'release',
      manifestPath,
      identityProbePath: path.join(tempRoot, 'probe-must-not-be-called.mjs'),
    });

    expect(result.ok).toBe(false);
    expect(result.errors.join('\n')).toMatch(/candidate\.feishu branch.*deployable branch/);
  });

  test('rejects a v2 candidate branch ref instead of normalizing it into main', () => {
    const fixture = makeFixture();
    const manifestPath = path.join(tempRoot, 'global-v2-branch-ref.json');
    const manifest = makeGlobalV2Manifest(fixture);
    manifest.candidate.core.branch = 'refs/heads/main';
    writeJson(tempRoot, 'global-v2-branch-ref.json', manifest);

    const result = runGovernance({
      root: fixture.root,
      mode: 'release',
      manifestPath,
      identityProbePath: path.join(tempRoot, 'probe-must-not-be-called.mjs'),
    });

    expect(result.ok).toBe(false);
    expect(result.errors.join('\n')).toMatch(/candidate\.core branch.*deployable branch/);
  });

  test('rejects a non-GitHub repository URL even when its path matches', () => {
    const fixture = makeFixture();
    const manifestPath = path.join(tempRoot, 'global-v2-evil-repository.json');
    const manifest = makeGlobalV2Manifest(fixture);
    manifest.candidate.core.repo = 'https://evil.example/Acme/demo-core.git';
    writeJson(tempRoot, 'global-v2-evil-repository.json', manifest);

    const result = runGovernance({
      root: fixture.root,
      mode: 'release',
      manifestPath,
      identityProbePath: path.join(tempRoot, 'probe-must-not-be-called.mjs'),
    });

    expect(result.ok).toBe(false);
    expect(result.errors.join('\n')).toMatch(/repo.*does not exactly match HeXiaobo\/zylos-core|GitHub/);
  });

  test('rejects SSH candidate repository URLs carrying credentials', () => {
    const fixture = makeFixture();
    const manifestPath = path.join(tempRoot, 'global-v2-credentialed-repo.json');
    const manifest = makeGlobalV2Manifest(fixture);
    manifest.candidate.core.repo = 'ssh://git:password@github.com/HeXiaobo/zylos-core.git';
    writeJson(tempRoot, 'global-v2-credentialed-repo.json', manifest);

    const result = runGovernance({
      root: fixture.root,
      mode: 'release',
      manifestPath,
      identityProbePath: path.join(tempRoot, 'probe-do-not-run.mjs'),
    });

    expect(result.ok).toBe(false);
    expect(result.errors.join('\n')).toMatch(/candidate\.core\.repo.*repository|GitHub/);
  });

  test('rejects a manifest whose lexical path is inside the repository even when its symlink resolves outside', () => {
    const fixture = makeFixture();
    const outsideManifest = path.join(tempRoot, 'global-v2-symlink-target.json');
    writeJson(tempRoot, 'global-v2-symlink-target.json', makeGlobalV2Manifest(fixture));
    const linkPath = path.join(fixture.root, 'manifest-link.json');
    fs.symlinkSync(outsideManifest, linkPath);

    const result = runGovernance({
      root: fixture.root,
      mode: 'release',
      manifestPath: linkPath,
      identityProbePath: path.join(tempRoot, 'probe-do-not-run.mjs'),
    });

    expect(result.ok).toBe(false);
    expect(result.errors.join('\n')).toMatch(/outside the repository|self-reference|lexical path/);
  });

  test('rejects a v2 manifest when the repository origin is a non-GitHub lookalike', () => {
    const fixture = makeFixture();
    git(fixture.root, ['remote', 'set-url', 'origin', 'https://evil.example/Acme/demo-core.git']);
    const manifestPath = path.join(tempRoot, 'global-v2-evil-origin.json');
    writeJson(tempRoot, 'global-v2-evil-origin.json', makeGlobalV2Manifest(fixture));

    const result = runGovernance({
      root: fixture.root,
      mode: 'release',
      manifestPath,
      identityProbePath: path.join(tempRoot, 'probe-must-not-be-called.mjs'),
    });

    expect(result.ok).toBe(false);
    expect(result.errors.join('\n')).toMatch(/origin.*GitHub repository/);
  });

  test('does not probe HXA identity for a malformed v2 release target', () => {
    const fixture = makeFixture();
    const manifestPath = path.join(tempRoot, 'global-v2-invalid-target.json');
    const manifest = makeGlobalV2Manifest(fixture);
    manifest.target = { agent: 'ss', profileId: 'profile-ss', hostname: 'host-ss' };
    writeJson(tempRoot, 'global-v2-invalid-target.json', manifest);

    const result = runGovernance({
      root: fixture.root,
      mode: 'release',
      manifestPath,
      identityProbePath: path.join(tempRoot, 'probe-do-not-run.mjs'),
    });

    expect(result.ok).toBe(false);
    expect(result.errors.join('\n')).toMatch(/must not contain a per-agent target/);
    expect(result.errors.join('\n')).not.toMatch(/identity probe required/);
  });

  test('requires both publication and deployment permissions to be false for CANCELLED v2 manifests', () => {
    const fixture = makeFixture();
    const manifestPath = path.join(tempRoot, 'global-v2-cancelled-permissions.json');
    const manifest = makeGlobalV2Manifest(fixture, {
      status: 'CANCELLED',
      deploymentAllowed: true,
      publicationAllowed: true,
    });
    writeJson(tempRoot, 'global-v2-cancelled-permissions.json', manifest);

    const releaseResult = runGovernance({
      root: fixture.root,
      mode: 'release',
      manifestPath,
      identityProbePath: path.join(tempRoot, 'probe-must-not-be-called.mjs'),
    });
    const deployResult = runGovernance({
      root: fixture.root,
      mode: 'deploy',
      manifestPath,
      identityProbePath: path.join(tempRoot, 'deploy-probe-missing.mjs'),
    });

    expect(releaseResult.ok).toBe(false);
    expect(deployResult.ok).toBe(false);
    expect(`${releaseResult.errors.join('\n')}\n${deployResult.errors.join('\n')}`).toMatch(/CANCELLED.*publicationAllowed=false/);
    expect(`${releaseResult.errors.join('\n')}\n${deployResult.errors.join('\n')}`).toMatch(/CANCELLED.*deploymentAllowed=false/);
  });

  test('deploy mode still requires READY and deploymentAllowed=true for v2', () => {
    const fixture = makeFixture();
    const manifestPath = path.join(tempRoot, 'global-v2-deploy-state.json');
    writeJson(tempRoot, 'global-v2-deploy-state.json', makeGlobalV2Manifest(fixture, {
      status: 'HOLD',
      deploymentAllowed: false,
      publicationAllowed: true,
    }));

    const result = validateReleaseManifest({
      root: fixture.root,
      manifestPath,
      sha: fixture.baseSha,
      version: '1.2.3',
      branch: 'main',
      packageName: 'demo-core',
      repository: 'Acme/demo-core',
      mode: 'deploy',
    });

    expect(result.ok).toBe(false);
    expect(result.errors.join('\n')).toMatch(/status=READY/);
    expect(result.errors.join('\n')).toMatch(/deploymentAllowed=true/);
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

  test('accepts the v2 structured pair report for deploy readiness', () => {
    const fixture = makeFixture();
    const identity = writeRuntimeIdentityFixture({
      hostname: os.hostname(),
    });
    const manifest = makeGlobalV2Manifest(fixture, {
      status: 'READY',
      deploymentAllowed: true,
      publicationAllowed: true,
    });
    manifest.evidence.pairReport = { status: 'PASS' };
    manifest.evidence.canary = 'PASS';
    manifest.evidence.hxa = { status: 'PASS' };
    bindV2PreflightReceipt(manifest, 'deploy');
    const receiptPath = manifest.evidence.globalPreflight.report;
    const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
    receipt.runtimeTarget = {
      agent: identity.agent,
      profileId: identity.profileId,
      hostname: identity.hostname,
      deploymentOrgLabel: identity.deploymentOrgLabel,
      deploymentProfileId: identity.profileId,
      identityObservedAt: new Date().toISOString(),
    };
    writeJson(tempRoot, path.basename(receiptPath), receipt);
    manifest.evidence.globalPreflight.reportSha256 = sha256File(receiptPath);
    expect(validateDeploymentReadiness(manifest, {
      root: fixture.root,
      identityProbePath: identity.probePath,
      localHostname: identity.hostname,
      env: { ZYLOS_EMPLOYEE_RUNTIME_REGISTRY: identity.registryPath },
    })).toEqual([]);
  });
});
