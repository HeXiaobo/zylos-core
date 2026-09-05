import { bindReport } from '../../../tools/upgrade/governance/bind-report.mjs';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const HERE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../tools/upgrade/governance');
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'promotion-test-'));
const DEFAULT_RUNTIME_REGISTRY = path.join(tempRoot, 'registry.json');
fs.writeFileSync(DEFAULT_RUNTIME_REGISTRY, JSON.stringify({ schema: 'zylos.employee-runtime-registry/v1', employees: {
'any-agent': { host: os.hostname(), identity: { profileName: 'any-agent', profileId: 'profile-any-agent', deploymentProfileId: 'profile-any-agent', deploymentOrgLabel: 'default' } } } }));
after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));
function writeManifest(name, manifest) {
  const filename = path.join(tempRoot, `${name}.json`);
  fs.writeFileSync(filename, JSON.stringify(manifest));
  return filename;
}

function writeEvidence(name, value) {
  const filename = path.join(tempRoot, `${name}.json`);
  fs.writeFileSync(filename, JSON.stringify(value));
  return filename;
}

function writeGitSource(name, { packageName, version, origin }) {
  const repo = path.join(tempRoot, `git-source-${name}`);
  fs.mkdirSync(repo, { recursive: true });
  spawnSync('git', ['init', '-b', 'main', repo], { encoding: 'utf8' });
  fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ name: packageName, version }));
  spawnSync('git', ['-C', repo, 'add', 'package.json'], { encoding: 'utf8' });
  spawnSync('git', ['-C', repo, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-m', 'fixture'], { encoding: 'utf8' });
  const sha = spawnSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim();
  spawnSync('git', ['-C', repo, 'remote', 'add', 'origin', origin], { encoding: 'utf8' });
  spawnSync('git', ['-C', repo, 'update-ref', 'refs/remotes/origin/main', sha], { encoding: 'utf8' });
  return { repo, sha };
}

function sha256(filename) {
  return crypto.createHash('sha256').update(fs.readFileSync(filename)).digest('hex');
}

function attachDeploymentAuthorization(manifest, name = `deployment-authorization-${crypto.randomUUID()}`) {
  const authorization = {
    schema: 'zylos.release-deployment-authorization/v1',
    status: 'PASS',
    releaseId: manifest.releaseId,
    identity: 'user',
    authorizedBy: 'hexiaobo',
    authorizationRef: 'codex-user-message-deploy-fixture',
    authorizedAt: '2026-09-02T06:30:00.000Z',
    deploymentAuthorized: true,
    scope: 'DEPLOY_GLOBAL_BUNDLE',
    bundle: {
      coreSha: manifest.candidate.core.sha,
      feishuSha: manifest.candidate.feishu.sha,
      hxaSha: manifest.candidate.hxa.sha,
    },
  };
  const report = writeEvidence(name, authorization);
  manifest.evidence.ownerAuthorization = {
    ...authorization,
    report,
    reportSha256: sha256(report),
  };
  return { report, authorization };
}

function writeIdentityCli() {
  return writeOrgScopedIdentityCli({
    name: 'any-agent',
    id: 'profile-any-agent',
    orgId: 'org-default',
  });
}

function writeOrgScopedIdentityCli({
  name,
  id,
  orgId,
  verifiedId = id,
  verifiedOrgId = orgId,
  verifiedName = name,
  expectedOrgId = verifiedOrgId,
  expectedProfileName = verifiedName,
  observedOrgId = verifiedOrgId,
  observedProfileName = verifiedName,
  invocationLog = null,
  profileInvocationLog = null,
}) {
  const filename = path.join(tempRoot, `identity-cli-${name}.mjs`);
  const profile = JSON.stringify({ name, id, org_id: orgId });
  const verification = JSON.stringify({
    verifiedId,
    verifiedOrgId,
    verifiedName,
    expectedOrgId,
    expectedProfileName,
    observedOrgId,
    observedProfileName,
  });
  const logPath = JSON.stringify(invocationLog);
  fs.writeFileSync(filename, `
import fs from 'node:fs';
import os from 'node:os';

const profile = ${profile};
const verification = ${verification};
const invocationLog = ${logPath};
const profileInvocationLog = ${JSON.stringify(profileInvocationLog)};
const args = process.argv.slice(2);

if (args[0] !== 'profile-verify') {
  if (profileInvocationLog) fs.appendFileSync(profileInvocationLog, JSON.stringify(args) + '\\n');
  console.log(JSON.stringify(profile));
} else {
  const flag = (name) => {
    const index = args.indexOf(name);
    return index >= 0 ? args[index + 1] : undefined;
  };
  const org = flag('--org');
  const expectedProfileId = flag('--profile-id');
  const expectedHostname = flag('--hostname');
  if (invocationLog) fs.appendFileSync(invocationLog, JSON.stringify(args) + '\\n');
  const failures = [];
  if (org !== 'default') failures.push('ORG_MISMATCH');
  if (expectedProfileId !== verification.verifiedId) failures.push('PROFILE_ID_MISMATCH');
  if (expectedHostname !== os.hostname()) failures.push('HOSTNAME_MISMATCH');
  const report = {
    schema: 'zylos.hxa-org-profile-verification/v1',
    status: failures.length === 0 ? 'PASS' : 'HOLD',
    org,
    expected: {
      profileId: expectedProfileId,
      profileName: verification.expectedProfileName,
      orgId: verification.expectedOrgId,
      hostname: expectedHostname,
    },
    observed: {
      profileId: verification.verifiedId,
      profileName: verification.observedProfileName,
      orgId: verification.observedOrgId,
      hostname: os.hostname(),
      observedAt: '2026-08-29T00:00:00.000Z',
    },
    failures,
  };
  console.log(JSON.stringify(report));
  if (failures.length > 0) process.exitCode = 2;
}
`);
  return filename;
}

const targets = {}, repos = {};
for (const name of ['core', 'feishu', 'hxa']) {
 const repo = `HeXiaobo/zylos-${name === 'hxa' ? 'hxa-connect' : name}`;
 const fixture = writeGitSource(name, { packageName: name === 'core' ? 'zylos' : `zylos-${name === 'hxa' ? 'hxa-connect' : name}`, version: '1.0.0', origin: `https://github.com/${repo}.git` });
 targets[name] = { repo, branch: 'main', sha: fixture.sha, [name === 'hxa' ? 'packageVersion' : 'version']: '1.0.0' }; repos[name] = fixture.repo;
}
function hxaTarget() { return targets.hxa; }
function makeV2Manifest() {
 const manifest = { schema: 'zylos.release-manifest/v2', releaseId: 'synthetic-promotion-test', owner: 'HeXiaobo',
 status: 'HOLD', deploymentAllowed: false, publicationAllowed: false, holdReasons: ['PREPARATION_PENDING'],
 sourcePolicy: { deployableBranch: 'main', immutableFullShaOnly: true, featureReleaseArchiveBranchesAreHistoryOnly: true },
 candidate: targets, stable: targets, localValidationRepos: repos,
 deploymentContract: { targetMode: 'global', rolloutMode: 'CANARY', immutableFullShaOnly: true, cleanWorktreeRequired: true, dryRunRequired: true, pairReportRequired: true, canaryRequired: true, pairComponents: ['core','feishu'], hxaRequired: true },
 evidence: { hxa: { releaseId: 'synthetic-promotion-test', target: hxaTarget() } } };
 for (const stage of ['check','dryRun','execute','provenance','canary']) manifest.evidence.hxa[stage] = { target: hxaTarget() };
 attachDeploymentAuthorization(manifest); return manifest;
}
function makePassV2Manifest() {
  const manifest = makeV2Manifest();
  const hxaExecutionId = 'hxa-execution-001';
  const pairExecutionId = 'pair-execution-001';
  manifest.evidence.hxa.provenance.observedRuntime = {
    repo: hxaTarget().repo,
    packageVersion: hxaTarget().packageVersion,
    sha: hxaTarget().sha,
    sourceMarker: '.zylos-source.json',
    status: 'PASS',
  };
  const pairTarget = {
    core: manifest.candidate.core,
    feishu: manifest.candidate.feishu,
  };
  const pairReport = {
    schema: 'zylos.fork-pair-upgrade/v1',
    status: 'PASS',
    mode: 'dry-run',
    result: 'PRECHECK_ONLY',
    releaseId: manifest.releaseId,
    executionId: pairExecutionId,
    target: pairTarget,
  };
  manifest.evidence.pairReport = {
    status: 'PASS',
    report: writeEvidence('pair-pass', pairReport),
    executionId: pairExecutionId,
    target: pairTarget,
  };
  manifest.evidence.hxa.status = 'PASS';
  manifest.evidence.hxa.executionId = hxaExecutionId;
  for (const stageName of ['check', 'dryRun', 'execute', 'provenance', 'canary']) {
    const stage = manifest.evidence.hxa[stageName];
    stage.status = 'PASS';
    stage.executionId = hxaExecutionId;
    if (stageName === 'dryRun') {
      stage.mode = 'dry-run';
      stage.result = 'PRECHECK_ONLY';
    }
    stage.report = writeEvidence(`hxa-${stageName}-pass`, {
      schema: 'zylos.hxa-upgrade/v1',
      status: 'PASS',
      mode: stageName === 'dryRun' ? 'dry-run' : stageName,
      result: stageName === 'dryRun' ? 'PRECHECK_ONLY' : 'PASS',
      releaseId: manifest.releaseId,
      executionId: hxaExecutionId,
      target: hxaTarget(),
    });
  }
  manifest.evidence.canary = 'PASS';
  manifest.evidence.preDeployCanary = {
    status: 'PASS',
    releaseId: manifest.releaseId,
    executionId: 'pre-deploy-canary-complete-001',
    report: writeEvidence('pre-deploy-canary-complete', {
      schema: 'zylos.pre-deploy-canary/v1',
      status: 'PASS',
      releaseId: manifest.releaseId,
      executionId: 'pre-deploy-canary-complete-001',
    }),
  };
  manifest.status = 'READY';
  manifest.deploymentAllowed = true;
  manifest.holdReasons = [];
  return manifest;
}

describe('local promotion through the real deployment gate', () => {
  function promote(manifestPath, runtime, identityCli) {
    return spawnSync(process.execPath, [path.join(HERE, 'promote-release.mjs'),
      '--manifest', manifestPath, '--zylos-dir', runtime, '--stage', 'pair'], {
      encoding: 'utf8', env: { ...process.env,
        ZYLOS_EMPLOYEE_RUNTIME_REGISTRY: DEFAULT_RUNTIME_REGISTRY,
        ZYLOS_HXA_PROFILE_CLI: identityCli },
    });
  }
  it('promotes a fully evidenced HOLD without publication authority', () => {
    const manifest = makePassV2Manifest();
    manifest.status = 'HOLD'; manifest.deploymentAllowed = false;
    manifest.publicationAllowed = false; manifest.holdReasons = ['PREPARATION_PENDING'];
    const filename = writeManifest('promotion-ready', manifest);
    const runtime = fs.mkdtempSync(path.join(tempRoot, 'runtime-'));
    const result = promote(filename, runtime, writeIdentityCli());
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const promoted = JSON.parse(fs.readFileSync(filename));
    assert.equal(promoted.status, 'READY');
    assert.equal(promoted.deploymentAllowed, true);
    assert.equal(promoted.publicationAllowed, false);
    assert.deepEqual(promoted.candidate, manifest.candidate);
    assert.deepEqual(promoted.evidence, manifest.evidence);
    const receipt = JSON.parse(fs.readFileSync(JSON.parse(result.stdout).report));
    assert.equal(receipt.gate.status, 'PASS');
    assert.equal(receipt.before.status, 'HOLD');
  });
  for (const scenario of ['valid native reports', 'tampered raw', 'wrong native agent', 'wrong native profile']) {
    it(`checks native bindings against raw files and fresh identity: ${scenario}`, () => {
      const manifest = makePassV2Manifest();
      manifest.status = 'HOLD'; manifest.deploymentAllowed = false;
      const rawPair = writeEvidence('native-pair', { schema: 'zylos.fork-pair-upgrade/v1', status: 'PASS', mode: 'dry-run', result: 'PRECHECK_ONLY', transactionId: 'native-pair-uuid', agent: scenario === 'wrong native agent' ? 'another-agent' : 'any-agent', target: { core: manifest.candidate.core, feishu: manifest.candidate.feishu } });
      manifest.evidence.pairReport.report = writeEvidence('bound-pair', bindReport({ manifest, rawPath: rawPair, kind: 'pair.dryRun', executionId: manifest.evidence.pairReport.executionId }));
      for (const stage of ['dryRun','execute']) {
        const raw = writeEvidence(`native-hxa-${stage}`, { schema: 'zylos.hxa-upgrade-preflight/v1', status: 'PASS', mode: stage === 'dryRun' ? 'dry-run' : 'execute', result: stage === 'dryRun' ? 'PRECHECK_ONLY' : 'EXECUTE_COMPLETE', executionId: `native-hxa-${stage}-uuid`, releaseId: manifest.releaseId, target: { repo: targets.hxa.repo, sha: targets.hxa.sha, version: targets.hxa.packageVersion, agent: 'any-agent', profileId: scenario === 'wrong native profile' ? 'wrong-profile' : 'profile-any-agent', hostname: os.hostname() } });
        manifest.evidence.hxa[stage].report = writeEvidence(`bound-hxa-${stage}`, bindReport({ manifest, rawPath: raw, kind: `hxa.${stage}`, executionId: manifest.evidence.hxa.executionId }));
      }
      if (scenario === 'tampered raw') fs.appendFileSync(rawPair, '\n');
      const filename = writeManifest(`native-promotion-${scenario}`, manifest);
      const runtime = fs.mkdtempSync(path.join(tempRoot, 'runtime-'));
      const before = fs.readFileSync(filename, 'utf8');
      const result = promote(filename, runtime, writeIdentityCli());
      if (scenario === 'valid native reports') assert.equal(result.status, 0, result.stdout + result.stderr);
      else {
        assert.equal(result.status, 2, result.stdout + result.stderr);
        assert.match(result.stderr, /native report/);
        assert.equal(fs.readFileSync(filename, 'utf8'), before);
      }
    });
  }
  for (const failure of ['missing evidence', 'runtime lock', 'RUNNING', 'identity mismatch']) {
    it(`leaves the original untouched for ${failure}`, () => {
      const manifest = makePassV2Manifest();
      manifest.status = 'HOLD'; manifest.deploymentAllowed = false;
      if (failure === 'missing evidence') manifest.evidence.preDeployCanary.status = 'NOT_RUN';
      if (failure === 'RUNNING') manifest.evidence.pairExecute = { status: 'RUNNING', executionId: 'live' };
      const filename = writeManifest(`promotion-reject-${failure}`, manifest);
      const runtime = fs.mkdtempSync(path.join(tempRoot, 'runtime-'));
      if (failure === 'runtime lock') {
        fs.mkdirSync(path.join(runtime, '.zylos/locks/busy.lock'), { recursive: true });
      }
      const before = fs.readFileSync(filename, 'utf8');
      const result = promote(filename, runtime, failure === 'identity mismatch' ? writeOrgScopedIdentityCli({ name: 'wrong', id: 'wrong', orgId: 'wrong' }) : writeIdentityCli());
      assert.equal(result.status, 2, result.stdout + result.stderr);
      assert.match(result.stderr, { 'missing evidence': /preDeployCanary/, 'runtime lock': /concurrent runtime lock/, 'RUNNING': /RUNNING transaction/, 'identity mismatch': /identity|profile/i }[failure]);
      assert.equal(fs.readFileSync(filename, 'utf8'), before);
    });
  }
});
