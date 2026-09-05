#!/usr/bin/env node
import { BINDING_SCHEMA, verifyBinding } from './bind-report.mjs';

import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { GATE_VERSIONS, evidenceReferenceSha256 } from './evidence-reuse.mjs';
import { validateClosureRecord } from './release-transaction.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const mode = args[0] || 'inspect';
const SCHEMA_V1 = 'zylos.release-manifest/v1';
const SCHEMA_V2 = 'zylos.release-manifest/v2';
const PREFLIGHT_SCHEMA = 'zylos.agent-preflight/v1';
const EMPLOYEE_RUNTIME_REGISTRY_SCHEMA = 'zylos.employee-runtime-registry/v1';
const HXA_PROFILE_VERIFICATION_SCHEMA = 'zylos.hxa-org-profile-verification/v1';
const FULL_SHA = /^[0-9a-f]{40}$/;
const REPO = /^[^/\\\s]+\/[^/\\\s]+$/;
const COMPONENT_NAMES = ['core', 'feishu'];
const HXA_STAGES = ['check', 'dryRun', 'execute', 'provenance', 'canary'];
const STAGE_STATUSES = ['PASS', 'HOLD', 'NOT_RUN', 'NOT_APPLICABLE'];
const HXA_AGGREGATE_STATUSES = [...STAGE_STATUSES, 'PREPARED'];
const EVIDENCE_STATUSES = ['PASS', 'HOLD', 'NOT_RUN', 'UNKNOWN'];
const TARGET_MODE_GLOBAL = 'global';
const ROLLOUT_MODES = ['CANARY', 'FLEET'];
const DEPLOYMENT_STAGES = ['hxa', 'pair', 'final'];
const REUSE_DECISIONS = ['RUN', 'REUSED', 'NOT_APPLICABLE', 'HOLD'];
const PUBLICATION_AUTHORIZATION_SCHEMA = 'zylos.release-publication-authorization/v1';
const PUBLICATION_SCOPE = 'RELEASE_GLOBAL_BUNDLE';
const DEPLOYMENT_AUTHORIZATION_SCHEMA = 'zylos.release-deployment-authorization/v1';
const DEPLOYMENT_SCOPE = 'DEPLOY_GLOBAL_BUNDLE';
const SHA256 = /^[0-9a-f]{64}$/;
const PREFLIGHT_MAX_AGE_MS = 15 * 60 * 1000;
const PREFLIGHT_MAX_FUTURE_SKEW_MS = 5 * 60 * 1000;

if (!['inspect', 'publish', 'deploy'].includes(mode)) {
  console.error('Usage: node governance/agent-preflight.mjs [inspect|publish|deploy] [--stage hxa|pair|final] [--manifest PATH] [--receipt ABSOLUTE_PATH]');
  process.exit(64);
}

function option(name) {
  const index = args.indexOf(name);
  if (index >= 0) return args[index + 1];
  const prefix = `${name}=`;
  const inline = args.find(arg => arg.startsWith(prefix));
  return inline ? inline.slice(prefix.length) : undefined;
}

const requestedDeploymentStage = option('--stage');
const deploymentStage = mode === 'deploy' ? (requestedDeploymentStage || 'final') : null;
const requestedReceiptPath = option('--receipt');

if (args.includes('--receipt') && (!requestedReceiptPath || requestedReceiptPath.startsWith('--'))) {
  console.error('Usage: node governance/agent-preflight.mjs publish [--manifest PATH] [--receipt ABSOLUTE_PATH]');
  process.exit(64);
}

if (requestedReceiptPath !== undefined && mode !== 'publish') {
  console.error('Usage: node governance/agent-preflight.mjs publish [--manifest PATH] [--receipt ABSOLUTE_PATH]');
  process.exit(64);
}

if (requestedReceiptPath !== undefined && !path.isAbsolute(requestedReceiptPath)) {
  console.error('--receipt must be an absolute path');
  process.exit(64);
}

const receiptPath = requestedReceiptPath ? path.normalize(requestedReceiptPath) : null;

if (mode === 'deploy' && !DEPLOYMENT_STAGES.includes(deploymentStage)) {
  console.error(`Usage: node governance/agent-preflight.mjs deploy [--stage ${DEPLOYMENT_STAGES.join('|')}] [--manifest PATH]`);
  process.exit(64);
}

if (mode !== 'deploy' && requestedDeploymentStage !== undefined) {
  console.error(`Usage: node governance/agent-preflight.mjs ${mode} [--manifest PATH]`);
  process.exit(64);
}

const manifestPath = path.resolve(
  option('--manifest') ||
    process.env.ZYLOS_RELEASE_MANIFEST ||
    path.join(HERE, 'release-manifest.json'),
);

const failures = [];
const warnings = [];
let runtimeIdentity = null;
let runtimeIdentityVerification = null;

function requireValue(condition, message) {
  if (!condition) failures.push(message);
}

function readJson(filename) {
  try {
    return JSON.parse(fs.readFileSync(filename, 'utf8'));
  } catch (error) {
    failures.push(`cannot read JSON ${filename}: ${error.message}`);
    return null;
  }
}

function readEvidenceReport(filename) {
  try {
    return { value: JSON.parse(fs.readFileSync(filename, 'utf8')), error: null };
  } catch (error) {
    return { value: null, error };
  }
}

function sha256File(filename) {
  return crypto.createHash('sha256').update(fs.readFileSync(filename)).digest('hex');
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function canonicalIsoTimestamp(value) {
  if (typeof value !== 'string') return false;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}

function freshIsoTimestamp(value, now = Date.now()) {
  if (!canonicalIsoTimestamp(value)) return false;
  const timestamp = Date.parse(value);
  return timestamp >= now - PREFLIGHT_MAX_AGE_MS && timestamp <= now + PREFLIGHT_MAX_FUTURE_SKEW_MS;
}

function isObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

function publicationAuthorizationCore(authorization) {
  return {
    schema: authorization?.schema,
    status: authorization?.status,
    releaseId: authorization?.releaseId,
    identity: authorization?.identity,
    authorizedBy: authorization?.authorizedBy,
    authorizationRef: authorization?.authorizationRef,
    authorizedAt: authorization?.authorizedAt,
    publicationAuthorized: authorization?.publicationAuthorized,
    scope: authorization?.scope,
    bundle: authorization?.bundle,
  };
}

function deploymentAuthorizationCore(authorization) {
  return {
    schema: authorization?.schema,
    status: authorization?.status,
    releaseId: authorization?.releaseId,
    identity: authorization?.identity,
    authorizedBy: authorization?.authorizedBy,
    authorizationRef: authorization?.authorizationRef,
    authorizedAt: authorization?.authorizedAt,
    deploymentAuthorized: authorization?.deploymentAuthorized,
    scope: authorization?.scope,
    bundle: authorization?.bundle,
  };
}

function git(repoPath, gitArgs) {
  return execFileSync('git', ['-C', repoPath, ...gitArgs], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function githubRepoFromOrigin(remoteUrl) {
  if (typeof remoteUrl !== 'string') return null;
  const https = remoteUrl.match(/^https:\/\/github\.com\/([^/\s]+)\/([^/\s]+?)(?:\.git)?$/);
  if (https) return `${https[1]}/${https[2]}`;
  const ssh = remoteUrl.match(/^git@github\.com:([^/\s]+)\/([^/\s]+?)(?:\.git)?$/);
  if (ssh) return `${ssh[1]}/${ssh[2]}`;
  return null;
}

function hxaProfileCliPath() {
  return process.env.ZYLOS_HXA_PROFILE_CLI ||
    path.join(os.homedir(), 'zylos', '.claude', 'skills', 'hxa-connect', 'scripts', 'cli.js');
}

function parseHxaProbeOutput(output) {
  // HXA 1.7.10 prints disabled-org notices before its JSON report. Accept only
  // that known notice; malformed reports and arbitrary stdout remain errors.
  const lines = String(output).trimStart().split(/\r?\n/);
  while (/^\[hxa-connect\] Org "[^"\r\n]+" disabled — skipping$/.test(lines[0] || '')) lines.shift();
  return JSON.parse(lines.join('\n'));
}

function invokeHxaJson(cliPath, cliArgs, label) {
  requireValue(fs.existsSync(cliPath), `deployment blocked: HXA identity probe is missing: ${cliPath}`);
  if (!fs.existsSync(cliPath)) return null;
  try {
    return parseHxaProbeOutput(
      execFileSync(process.execPath, [cliPath, ...cliArgs], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }),
    );
  } catch (error) {
    if (typeof error.stdout === 'string' && error.stdout.trim().length > 0) {
      try {
        return parseHxaProbeOutput(error.stdout);
      } catch {
        // Preserve the command failure below when stdout is not a JSON report.
      }
    }
    failures.push(`deployment blocked: ${label} failed: ${error.message}`);
    return null;
  }
}

function resolveRuntimeDeploymentIdentity() {
  const registryPath = path.resolve(
    process.env.ZYLOS_EMPLOYEE_RUNTIME_REGISTRY ||
      path.join(HERE, 'employee-runtime-registry.json'),
  );
  const registry = readJson(registryPath);
  if (!registry) return null;
  requireValue(
    registry.schema === EMPLOYEE_RUNTIME_REGISTRY_SCHEMA,
    `deployment blocked: employee runtime registry schema is invalid: ${registryPath}`,
  );
  const employees = registry.employees;
  requireValue(
    employees && typeof employees === 'object' && !Array.isArray(employees),
    'deployment blocked: employee runtime registry employees is invalid',
  );
  if (!employees || typeof employees !== 'object' || Array.isArray(employees)) return null;

  const actualHostname = os.hostname();
  for (const [employeeName, employee] of Object.entries(employees)) {
    requireValue(
      typeof employee?.host === 'string' && employee.host.trim().length > 0,
      `deployment blocked: registry identity ${employeeName}.host is required`,
    );
  }
  const matches = Object.entries(employees).filter(([, employee]) =>
    employee?.host === actualHostname,
  );
  requireValue(
    matches.length === 1,
    `deployment blocked: employee runtime registry must contain exactly one employee for runtime hostname ${actualHostname} (found ${matches.length})`,
  );
  if (matches.length !== 1) return null;

  const [employeeName, employee] = matches[0];
  const identity = employee.identity;
  requireValue(
    identity && typeof identity === 'object' && !Array.isArray(identity),
    `deployment blocked: registry identity ${employeeName}.identity is invalid`,
  );
  if (!identity || typeof identity !== 'object' || Array.isArray(identity)) return null;
  const deploymentOrgLabel = identity.deploymentOrgLabel;
  const deploymentProfileId = identity.deploymentProfileId;
  const expectedHostname = employee.host;
  const expectedProfileName = identity.profileName;
  requireValue(
    typeof expectedProfileName === 'string' && expectedProfileName.trim().length > 0,
    `deployment blocked: registry identity ${employeeName}.identity.profileName is required`,
  );
  requireValue(
    typeof deploymentOrgLabel === 'string' && deploymentOrgLabel.trim().length > 0,
    `deployment blocked: registry identity ${employeeName}.deploymentOrgLabel is required`,
  );
  requireValue(
    typeof deploymentProfileId === 'string' && deploymentProfileId.trim().length > 0,
    `deployment blocked: registry identity ${employeeName}.deploymentProfileId is required`,
  );
  requireValue(
    typeof expectedHostname === 'string' && expectedHostname.trim().length > 0,
    `deployment blocked: registry identity ${employeeName}.host is required`,
  );
  if (
    typeof deploymentOrgLabel !== 'string' || deploymentOrgLabel.trim().length === 0 ||
    typeof deploymentProfileId !== 'string' || deploymentProfileId.trim().length === 0 ||
    typeof expectedHostname !== 'string' || expectedHostname.trim().length === 0
  ) return null;

  const report = invokeHxaJson(
    hxaProfileCliPath(),
    [
      'profile-verify',
      '--org', deploymentOrgLabel,
      '--profile-id', deploymentProfileId,
      '--hostname', expectedHostname,
    ],
    'HXA org-scoped identity probe',
  );
  if (!report) return null;
  const verificationFailureCount = failures.length;
  requireValue(
    report.schema === HXA_PROFILE_VERIFICATION_SCHEMA,
    'deployment blocked: HXA org-scoped identity report schema is invalid',
  );
  requireValue(
    report.status === 'PASS',
    `deployment blocked: HXA org-scoped identity status=${report.status || 'missing'}`,
  );
  requireValue(
    report.org === deploymentOrgLabel,
    'deployment blocked: HXA org-scoped identity org does not match registry deploymentOrgLabel',
  );
  requireValue(
    report.expected?.profileId === deploymentProfileId,
    'deployment blocked: HXA org-scoped identity expected profile does not match registry deploymentProfileId',
  );
  requireValue(
    report.expected?.hostname === expectedHostname,
    'deployment blocked: HXA org-scoped identity expected hostname does not match registry host',
  );
  const expectedOrgId = report.expected?.orgId;
  const observedOrgId = report.observed?.orgId;
  requireValue(
    typeof expectedOrgId === 'string' && expectedOrgId.trim().length > 0,
    'deployment blocked: HXA org-scoped identity expected orgId is required',
  );
  requireValue(
    typeof observedOrgId === 'string' && observedOrgId.trim().length > 0,
    'deployment blocked: HXA org-scoped identity observed orgId is required',
  );
  requireValue(
    expectedOrgId === observedOrgId,
    'deployment blocked: HXA org-scoped identity expected/observed orgId mismatch',
  );
  const observedProfileName = report.observed?.profileName;
  const reportExpectedProfileName = report.expected?.profileName;
  requireValue(
    typeof reportExpectedProfileName === 'string' && reportExpectedProfileName.trim().length > 0,
    'deployment blocked: HXA org-scoped identity expected profile name is required',
  );
  requireValue(
    typeof observedProfileName === 'string' && observedProfileName.trim().length > 0,
    'deployment blocked: HXA org-scoped identity observed profile name is required',
  );
  requireValue(
    reportExpectedProfileName === observedProfileName,
    'deployment blocked: HXA org-scoped identity expected/observed profile name mismatch',
  );
  requireValue(
    reportExpectedProfileName === expectedProfileName,
    'deployment blocked: HXA org-scoped identity expected name does not match registry profile',
  );
  requireValue(
    report.observed?.profileId === deploymentProfileId,
    'deployment blocked: HXA org-scoped identity observed profile does not match registry deploymentProfileId',
  );
  requireValue(
    report.observed?.profileName === expectedProfileName,
    'deployment blocked: HXA org-scoped identity observed name does not match runtime profile',
  );
  requireValue(
    report.observed?.hostname === actualHostname,
    'deployment blocked: HXA org-scoped identity observed hostname does not match runtime hostname',
  );
  if (failures.length !== verificationFailureCount) return null;

  return {
    employeeName,
    profileName: expectedProfileName,
    registeredProfileId: identity.profileId,
    deploymentOrgLabel,
    deploymentProfileId,
    hostname: actualHostname,
  };
}

function componentVersion(component, versionKey) {
  if (versionKey === 'packageVersion') return component?.packageVersion;
  return component?.version;
}

function validateComponent(
  groupName,
  componentName,
  component,
  repoPath,
  {
    versionKey = 'version',
    packageName = null,
    sourcePolicy = null,
    cleanWorktreeRequired = false,
  } = {},
) {
  const label = `${groupName}.${componentName}`;
  requireValue(component && typeof component === 'object' && !Array.isArray(component), `${label} is missing`);
  if (!component || typeof component !== 'object' || Array.isArray(component)) return;

  requireValue(typeof component.repo === 'string' && REPO.test(component.repo), `${label}.repo is invalid`);
  const version = componentVersion(component, versionKey);
  requireValue(typeof version === 'string' && version.length > 0, `${label}.${versionKey} is invalid`);
  requireValue(FULL_SHA.test(component.sha || ''), `${label}.sha must be a full 40-character lowercase SHA`);
  requireValue(typeof component.branch === 'string' && component.branch.length > 0, `${label}.branch is invalid`);

  if (!repoPath || !fs.existsSync(repoPath) || !FULL_SHA.test(component.sha || '')) {
    failures.push(`${label} local repository is unavailable for immutable-source validation: ${repoPath || 'unset'}`);
    return;
  }

  try {
    git(repoPath, ['cat-file', '-e', `${component.sha}^{commit}`]);
    const pkg = JSON.parse(git(repoPath, ['show', `${component.sha}:package.json`]));
    requireValue(
      pkg.version === version,
      `${label} version mismatch: manifest=${version} source=${pkg.version || 'missing'}`,
    );
    if (packageName) {
      requireValue(
        pkg.name === packageName,
        `${label} package name mismatch: manifest=${packageName} source=${pkg.name || 'missing'}`,
      );
    }
    if (sourcePolicy) {
      const deployableBranch = sourcePolicy.deployableBranch;
      requireValue(component.branch === deployableBranch, `${label}.branch must be ${deployableBranch}`);
      const origin = git(repoPath, ['remote', 'get-url', 'origin']);
      const originRepo = githubRepoFromOrigin(origin);
      requireValue(originRepo !== null, `${label} origin must be an exact github.com repository URL`);
      requireValue(originRepo === component.repo, `${label} origin repo does not match manifest repo`);
      try {
        git(repoPath, ['merge-base', '--is-ancestor', component.sha, `origin/${deployableBranch}`]);
      } catch {
        failures.push(`${label}.sha is not published on origin/${deployableBranch}`);
      }
      if (cleanWorktreeRequired) {
        requireValue(git(repoPath, ['status', '--porcelain']).length === 0, `${label} local validation repository must be clean`);
      }
    }
  } catch (error) {
    failures.push(`${label} immutable-source validation failed: ${error.message}`);
  }
}

function targetFields(target, versionKey = 'version') {
  if (!target || typeof target !== 'object' || Array.isArray(target)) return null;
  const version = componentVersion(target, versionKey);
  return {
    repo: target.repo,
    sha: target.sha,
    version,
  };
}

function targetSummary(target, versionKey = 'version') {
  const fields = targetFields(target, versionKey);
  if (!fields) return null;
  if (versionKey === 'packageVersion') {
    return {
      repo: fields.repo,
      sha: fields.sha,
      packageVersion: fields.version,
    };
  }
  return fields;
}

function targetsEqual(actual, expected, versionKey = 'version') {
  const a = targetFields(actual, versionKey);
  const e = targetFields(expected, versionKey);
  return Boolean(
    a && e &&
      a.repo === e.repo &&
      a.sha === e.sha &&
      a.version === e.version,
  );
}

function validateTarget(label, target, expected, versionKey = 'version') {
  requireValue(target && typeof target === 'object' && !Array.isArray(target), `${label}.target is required`);
  if (!target || typeof target !== 'object' || Array.isArray(target)) return;
  const expectedVersion = componentVersion(expected, versionKey);
  requireValue(typeof target.repo === 'string' && REPO.test(target.repo), `${label}.target.repo is invalid`);
  requireValue(typeof componentVersion(target, versionKey) === 'string', `${label}.target.${versionKey} is invalid`);
  requireValue(FULL_SHA.test(target.sha || ''), `${label}.target.sha must be a full 40-character lowercase SHA`);
  requireValue(
    targetsEqual(target, expected, versionKey),
    `${label}.target does not match candidate ${expected?.repo || 'missing'}@${expected?.sha || 'missing'}:${expectedVersion || 'missing'}`,
  );
}

function validateEvidencePath(label, reportPath, { required = false } = {}) {
  if (reportPath === null || reportPath === undefined) {
    requireValue(!required, `${label}.report is required`);
    return null;
  }
  requireValue(typeof reportPath === 'string' && path.isAbsolute(reportPath), `${label}.report must be an absolute path`);
  if (typeof reportPath !== 'string' || !path.isAbsolute(reportPath)) return null;
  requireValue(fs.existsSync(reportPath), `${label}.report does not exist: ${reportPath}`);
  return reportPath;
}

function validateEvidenceReuse(manifest) {
  const reuse = manifest.evidenceReuse;
  if (reuse === undefined) return null;
  requireValue(reuse && typeof reuse === 'object' && !Array.isArray(reuse), 'evidenceReuse is invalid');
  if (!reuse || typeof reuse !== 'object' || Array.isArray(reuse)) return null;
  requireValue(reuse.policyVersion === 1, 'evidenceReuse.policyVersion must be 1');
  requireValue(
    reuse.environmentFingerprints && typeof reuse.environmentFingerprints === 'object' && !Array.isArray(reuse.environmentFingerprints),
    'evidenceReuse.environmentFingerprints is invalid',
  );
  const planPath = validateEvidencePath('evidenceReuse plan', reuse.plan, { required: true });
  requireValue(typeof reuse.sha256 === 'string' && /^[0-9a-f]{64}$/.test(reuse.sha256), 'evidenceReuse.sha256 is invalid');
  if (!planPath || typeof reuse.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(reuse.sha256)) return null;
  let actualHash;
  try {
    actualHash = sha256File(planPath);
  } catch (error) {
    failures.push(`evidenceReuse plan hash failed: ${error.message}`);
    return null;
  }
  requireValue(actualHash === reuse.sha256, 'evidenceReuse plan sha256 mismatch');
  if (actualHash !== reuse.sha256) return null;
  const plan = readJson(planPath);
  if (!plan) return null;
  requireValue(plan.schema === 'zylos.evidence-reuse-plan/v1', 'evidenceReuse plan schema is invalid');
  requireValue(plan.releaseId === manifest.releaseId, 'evidenceReuse plan releaseId does not match manifest');
  requireValue(plan.status === 'PASS', `evidenceReuse plan status must be PASS (found ${plan.status || 'missing'})`);
  requireValue(Array.isArray(plan.decisions), 'evidenceReuse plan decisions must be an array');
  if (!Array.isArray(plan.decisions)) return plan;
  const gates = new Set();
  const candidateInputs = {
    'source.core': targetFields(manifest.candidate?.core),
    'source.feishu': targetFields(manifest.candidate?.feishu),
    'source.hxa': targetFields(manifest.candidate?.hxa, 'packageVersion'),
    'pair.dryRun': {
      core: targetFields(manifest.candidate?.core),
      feishu: targetFields(manifest.candidate?.feishu),
    },
    'canary.functional': {
      core: targetFields(manifest.candidate?.core),
      feishu: targetFields(manifest.candidate?.feishu),
      hxa: targetFields(manifest.candidate?.hxa, 'packageVersion'),
    },
    'canary.hostSmoke': {
      core: targetFields(manifest.candidate?.core),
      feishu: targetFields(manifest.candidate?.feishu),
      hxa: targetFields(manifest.candidate?.hxa, 'packageVersion'),
    },
  };
  for (const decision of plan.decisions) {
    requireValue(decision && typeof decision === 'object' && !Array.isArray(decision), 'evidenceReuse decision is invalid');
    if (!decision || typeof decision !== 'object' || Array.isArray(decision)) continue;
    requireValue(typeof decision.gate === 'string' && decision.gate.length > 0, 'evidenceReuse decision gate is invalid');
    requireValue(
      typeof decision.gateVersion === 'string' && decision.gateVersion === GATE_VERSIONS[decision.gate],
      `evidenceReuse ${decision.gate || 'unknown'} gateVersion is invalid`,
    );
    requireValue(REUSE_DECISIONS.includes(decision.decision), `evidenceReuse ${decision.gate || 'unknown'} decision is invalid`);
    requireValue(!gates.has(decision.gate), `evidenceReuse duplicate gate: ${decision.gate || 'missing'}`);
    gates.add(decision.gate);
    requireValue(decision.decision !== 'HOLD', `evidenceReuse ${decision.gate || 'unknown'} is HOLD`);
    if (candidateInputs[decision.gate]) {
      requireValue(
        stableJson(decision.inputs) === stableJson(candidateInputs[decision.gate]),
        `evidenceReuse ${decision.gate} inputs do not match manifest candidate`,
      );
    }
    const expectedEnvironment = reuse.environmentFingerprints?.[decision.gate];
    if (expectedEnvironment !== undefined) {
      requireValue(
        decision.environmentFingerprint === expectedEnvironment,
        `evidenceReuse ${decision.gate} environment fingerprint does not match manifest`,
      );
    }
    if (decision.decision === 'REUSED') {
      const reportPath = validateEvidencePath(`evidenceReuse ${decision.gate}`, decision.report, { required: true });
      requireValue(
        typeof decision.environmentFingerprint === 'string' && /^sha256:[0-9a-f]{64}$/.test(decision.environmentFingerprint),
        `evidenceReuse ${decision.gate} environment fingerprint is invalid`,
      );
      requireValue(typeof decision.reportSha256 === 'string' && /^[0-9a-f]{64}$/.test(decision.reportSha256), `evidenceReuse ${decision.gate} reportSha256 is invalid`);
      requireValue(typeof decision.referenceSha256 === 'string' && /^[0-9a-f]{64}$/.test(decision.referenceSha256), `evidenceReuse ${decision.gate} referenceSha256 is invalid`);
      if (reportPath && typeof decision.reportSha256 === 'string' && /^[0-9a-f]{64}$/.test(decision.reportSha256)) {
        requireValue(sha256File(reportPath) === decision.reportSha256, `evidenceReuse ${decision.gate} report sha256 mismatch`);
        requireValue(
          evidenceReferenceSha256(decision) === decision.referenceSha256,
          `evidenceReuse ${decision.gate} reference sha256 mismatch`,
        );
      }
    }
  }
  return plan;
}

function validateStageStructure(label, stage, expectedTarget, versionKey = 'packageVersion') {
  requireValue(stage && typeof stage === 'object' && !Array.isArray(stage), `${label} is required`);
  if (!stage || typeof stage !== 'object' || Array.isArray(stage)) return;

  requireValue(STAGE_STATUSES.includes(stage.status), `${label}.status is invalid`);
  validateTarget(label, stage.target, expectedTarget, versionKey);
  const completed = stage.status === 'PASS' || stage.status === 'NOT_APPLICABLE';
  const reportPath = validateEvidencePath(`${label}`, stage.report, { required: completed });
  if (completed) {
    requireValue(typeof stage.executionId === 'string' && stage.executionId.length > 0, `${label}.executionId is required for completed evidence`);
  }
  if (stage.status === 'NOT_APPLICABLE') {
    requireValue(label.endsWith('.execute'), `${label}.NOT_APPLICABLE is allowed only for HXA execute`);
    requireValue(stage.result === 'ALREADY_AT_IMMUTABLE_TARGET', `${label}.result must be ALREADY_AT_IMMUTABLE_TARGET`);
  }
  if (label.endsWith('.dryRun')) {
    if (stage.status === 'PASS') {
      requireValue(stage.mode === 'dry-run', `${label}.mode must be dry-run for PASS`);
      requireValue(stage.result === 'PRECHECK_ONLY', `${label}.result must be PRECHECK_ONLY for PASS`);
    } else if (stage.mode !== undefined && stage.mode !== null) {
      requireValue(stage.mode === 'dry-run', `${label}.mode must be dry-run`);
    }
  }
  return reportPath;
}

function validateOwnerAuthorization(manifest) {
  const label = 'evidence.ownerAuthorization';
  const authorization = manifest.evidence?.ownerAuthorization;
  requireValue(
    authorization && typeof authorization === 'object' && !Array.isArray(authorization),
    `${label} is required for deployment`,
  );
  if (!authorization || typeof authorization !== 'object' || Array.isArray(authorization)) return null;

  requireValue(authorization.schema === DEPLOYMENT_AUTHORIZATION_SCHEMA, `deployment blocked: ${label}.schema must be ${DEPLOYMENT_AUTHORIZATION_SCHEMA}`);
  requireValue(authorization.status === 'PASS', `deployment blocked: ${label}.status=${authorization.status || 'missing'}`);
  requireValue(authorization.releaseId === manifest.releaseId, `deployment blocked: ${label}.releaseId does not match releaseId`);
  requireValue(authorization.identity === 'user', `deployment blocked: ${label}.identity must be user`);
  requireValue(
    typeof authorization.authorizedBy === 'string' && authorization.authorizedBy.trim().length > 0,
    `deployment blocked: ${label}.authorizedBy is required`,
  );
  requireValue(
    typeof authorization.authorizationRef === 'string' && authorization.authorizationRef.trim().length > 0,
    `deployment blocked: ${label}.authorizationRef is required`,
  );
  requireValue(canonicalIsoTimestamp(authorization.authorizedAt), `deployment blocked: ${label}.authorizedAt must be a canonical ISO timestamp`);
  requireValue(
    authorization.deploymentAuthorized === true,
    `deployment blocked: ${label}.deploymentAuthorized must be true`,
  );
  requireValue(authorization.scope === DEPLOYMENT_SCOPE, `deployment blocked: ${label}.scope must be exactly ${DEPLOYMENT_SCOPE}`);

  const bundle = authorization.bundle;
  requireValue(bundle && typeof bundle === 'object' && !Array.isArray(bundle), `deployment blocked: ${label}.bundle is required`);
  if (!bundle || typeof bundle !== 'object' || Array.isArray(bundle)) return null;
  requireValue(
    stableJson(Object.keys(bundle).sort()) === stableJson(['coreSha', 'feishuSha', 'hxaSha']),
    `deployment blocked: ${label}.bundle must contain exactly coreSha, feishuSha, and hxaSha`,
  );
  const expected = {
    coreSha: manifest.candidate?.core?.sha,
    feishuSha: manifest.candidate?.feishu?.sha,
    hxaSha: manifest.candidate?.hxa?.sha,
  };
  for (const [field, value] of Object.entries(expected)) {
    requireValue(
      bundle[field] === value,
      `deployment blocked: ${label}.bundle.${field} does not match candidate`,
    );
  }
  const reportPath = validateEvidencePath(label, authorization.report, { required: true });
  requireValue(
    typeof authorization.reportSha256 === 'string' && /^[0-9a-f]{64}$/.test(authorization.reportSha256),
    `deployment blocked: ${label}.reportSha256 is invalid`,
  );
  if (reportPath && /^[0-9a-f]{64}$/.test(authorization.reportSha256 || '')) {
    requireValue(sha256File(reportPath) === authorization.reportSha256, `deployment blocked: ${label}.reportSha256 mismatch`);
    const parsed = readEvidenceReport(reportPath);
    if (parsed.error) {
      failures.push(`deployment blocked: ${label}.report is not valid JSON: ${parsed.error.message}`);
    } else {
      requireValue(
        stableJson(deploymentAuthorizationCore(parsed.value)) === stableJson(deploymentAuthorizationCore(authorization)),
        `deployment blocked: ${label}.report body does not match authorization`,
      );
    }
  }
  return authorization;
}

function validatePublicationAuthorization(manifest) {
  const label = 'evidence.ownerAuthorization';
  const authorization = manifest.evidence?.ownerAuthorization;
  requireValue(
    authorization && typeof authorization === 'object' && !Array.isArray(authorization),
    `${label} is required for publication`,
  );
  if (!authorization || typeof authorization !== 'object' || Array.isArray(authorization)) return null;

  requireValue(authorization.schema === PUBLICATION_AUTHORIZATION_SCHEMA, `publication blocked: ${label}.schema must be ${PUBLICATION_AUTHORIZATION_SCHEMA}`);
  requireValue(authorization.status === 'PASS', `publication blocked: ${label}.status=${authorization.status || 'missing'}`);
  requireValue(authorization.releaseId === manifest.releaseId, `publication blocked: ${label}.releaseId does not match releaseId`);
  requireValue(authorization.identity === 'user', `publication blocked: ${label}.identity must be user`);
  requireValue(
    typeof authorization.authorizedBy === 'string' && authorization.authorizedBy.trim().length > 0,
    `publication blocked: ${label}.authorizedBy is required`,
  );
  requireValue(
    typeof authorization.authorizationRef === 'string' && authorization.authorizationRef.trim().length > 0,
    `publication blocked: ${label}.authorizationRef is required`,
  );
  requireValue(canonicalIsoTimestamp(authorization.authorizedAt), `publication blocked: ${label}.authorizedAt must be a canonical ISO timestamp`);
  requireValue(authorization.publicationAuthorized === true, `publication blocked: ${label}.publicationAuthorized must be true`);
  requireValue(authorization.scope === PUBLICATION_SCOPE, `publication blocked: ${label}.scope must be exactly ${PUBLICATION_SCOPE}`);

  const bundle = authorization.bundle;
  requireValue(bundle && typeof bundle === 'object' && !Array.isArray(bundle), `publication blocked: ${label}.bundle is required`);
  if (!bundle || typeof bundle !== 'object' || Array.isArray(bundle)) return null;
  requireValue(
    stableJson(Object.keys(bundle).sort()) === stableJson(['coreSha', 'feishuSha', 'hxaSha']),
    `publication blocked: ${label}.bundle must contain exactly coreSha, feishuSha, and hxaSha`,
  );
  const expected = {
    coreSha: manifest.candidate?.core?.sha,
    feishuSha: manifest.candidate?.feishu?.sha,
    hxaSha: manifest.candidate?.hxa?.sha,
  };
  for (const [field, value] of Object.entries(expected)) {
    requireValue(
      bundle[field] === value,
      `publication blocked: ${label}.bundle.${field} does not match candidate`,
    );
  }

  const reportPath = validateEvidencePath(label, authorization.report, { required: true });
  requireValue(
    typeof authorization.reportSha256 === 'string' && /^[0-9a-f]{64}$/.test(authorization.reportSha256),
    `publication blocked: ${label}.reportSha256 is invalid`,
  );
  if (reportPath && /^[0-9a-f]{64}$/.test(authorization.reportSha256 || '')) {
    requireValue(sha256File(reportPath) === authorization.reportSha256, `publication blocked: ${label}.reportSha256 mismatch`);
    const parsed = readEvidenceReport(reportPath);
    if (parsed.error) {
      failures.push(`publication blocked: ${label}.report is not valid JSON: ${parsed.error.message}`);
    } else {
      requireValue(
        stableJson(publicationAuthorizationCore(parsed.value)) === stableJson(publicationAuthorizationCore(authorization)),
        `publication blocked: ${label}.report body does not match authorization`,
      );
    }
  }
  return authorization;
}

function validateExactCandidateBundle(label, bundle, manifest) {
  const expected = {
    coreSha: manifest.candidate?.core?.sha,
    feishuSha: manifest.candidate?.feishu?.sha,
    hxaSha: manifest.candidate?.hxa?.sha,
  };
  requireValue(isObject(bundle), `${label} must be an object`);
  if (!isObject(bundle)) return;
  requireValue(
    stableJson(Object.keys(bundle).sort()) === stableJson(Object.keys(expected).sort()),
    `${label} must contain exactly coreSha, feishuSha, and hxaSha`,
  );
  for (const [field, expectedSha] of Object.entries(expected)) {
    requireValue(FULL_SHA.test(bundle[field] || ''), `${label}.${field} must be a full 40-character lowercase SHA`);
    requireValue(bundle[field] === expectedSha, `${label}.${field} does not match candidate`);
  }
}

/**
 * A workspace-publish receipt is emitted by the central gate and consumed by
 * both component v2 release gates. It is optional while first generating a
 * receipt, then mandatory to validate whenever the manifest binds one.
 */
function validateWorkspacePublishReceipt(manifest) {
  const label = 'evidence.workspacePublish';
  const envelope = manifest.evidence?.workspacePublish;
  if (envelope === undefined) return;

  requireValue(isObject(envelope), `${label} must be an object`);
  if (!isObject(envelope)) return;
  requireValue(
    stableJson(Object.keys(envelope).sort()) === stableJson(['receiptType', 'report', 'reportSha256']),
    `${label} must contain exactly receiptType, report, and reportSha256`,
  );
  requireValue(envelope.receiptType === 'workspace-publish', `${label}.receiptType must be workspace-publish`);
  const reportPath = validateEvidencePath(label, envelope.report, { required: true });
  requireValue(typeof envelope.reportSha256 === 'string' && SHA256.test(envelope.reportSha256), `${label}.reportSha256 is invalid`);
  if (!reportPath || !fs.existsSync(reportPath) || !SHA256.test(envelope.reportSha256 || '')) return;

  let actualHash;
  try {
    actualHash = sha256File(reportPath);
  } catch (error) {
    failures.push(`${label}.report hash failed: ${error.message}`);
    return;
  }
  requireValue(actualHash === envelope.reportSha256, `${label}.reportSha256 mismatch`);
  if (actualHash !== envelope.reportSha256) return;

  const parsed = readEvidenceReport(reportPath);
  if (parsed.error) {
    failures.push(`${label}.report is not valid JSON: ${parsed.error.message}`);
    return;
  }
  const receipt = parsed.value;
  requireValue(isObject(receipt), `${label}.report must be an object`);
  if (!isObject(receipt)) return;

  requireValue(receipt.schema === PREFLIGHT_SCHEMA, `${label}.report.schema must be ${PREFLIGHT_SCHEMA}`);
  requireValue(receipt.receiptType === 'workspace-publish', `${label}.report.receiptType must be workspace-publish`);
  requireValue(receipt.mode === 'publish', `${label}.report.mode must be publish`);
  requireValue(receipt.status === 'PASS', `${label}.report.status must be PASS`);
  requireValue(receipt.releaseId === manifest.releaseId, `${label}.report.releaseId must match manifest`);
  requireValue(receipt.releaseStatus === manifest.status, `${label}.report.releaseStatus must match manifest`);
  requireValue(receipt.targetMode === TARGET_MODE_GLOBAL, `${label}.report.targetMode must be global`);
  requireValue(receipt.gate === 'PUBLICATION', `${label}.report.gate must be PUBLICATION`);
  requireValue(receipt.deploymentStage === null, `${label}.report.deploymentStage must be null for publication`);
  requireValue(receipt.publicationAllowed === true, `${label}.report.publicationAllowed must be true`);
  requireValue(receipt.publicationAllowed === manifest.publicationAllowed, `${label}.report.publicationAllowed must match manifest`);
  requireValue(receipt.deploymentAllowed === manifest.deploymentAllowed, `${label}.report.deploymentAllowed must match manifest`);
  requireValue(isObject(receipt.dispositions), `${label}.report.dispositions must be an object`);
  if (isObject(receipt.dispositions)) {
    requireValue(
      stableJson(Object.keys(receipt.dispositions).sort()) === stableJson(['deploymentAllowed', 'publicationAllowed']),
      `${label}.report.dispositions must contain exactly publicationAllowed and deploymentAllowed`,
    );
    requireValue(
      receipt.dispositions.publicationAllowed === manifest.publicationAllowed,
      `${label}.report.dispositions.publicationAllowed must match manifest`,
    );
    requireValue(
      receipt.dispositions.deploymentAllowed === manifest.deploymentAllowed,
      `${label}.report.dispositions.deploymentAllowed must match manifest`,
    );
  }
  validateExactCandidateBundle(`${label}.report.candidateBundle`, receipt.candidateBundle, manifest);
  requireValue(freshIsoTimestamp(receipt.generatedAt), `${label}.report.generatedAt must be a fresh canonical ISO timestamp`);
}

const nativeRuntimeClaims = [];
function validateNativeBinding(report, manifest, kind) {
  if (report.schema !== BINDING_SCHEMA) return;
  try { nativeRuntimeClaims.push(verifyBinding(report, manifest, kind)); }
  catch (error) { failures.push(`deployment blocked: native report binding: ${error.message}`); }
}

function validateBoundReport(label, reportPath, manifest, executionId, expectedTarget, {
  dryRun = false,
  required = true,
} = {}) {
  const resolvedPath = validateEvidencePath(label, reportPath, { required });
  if (!resolvedPath) return null;
  const { value: report, error } = readEvidenceReport(resolvedPath);
  if (error) {
    failures.push(`deployment blocked: ${label}.report is not valid JSON: ${error.message}`);
    return null;
  }
  requireValue(
    report && typeof report === 'object' && !Array.isArray(report),
    `deployment blocked: ${label}.report is not an object`,
  );
  if (!report || typeof report !== 'object' || Array.isArray(report)) return null;
  validateNativeBinding(report, manifest, label.replace(/^evidence\./, ''));
  requireValue(report.status === 'PASS', `deployment blocked: ${label}.report.status=${report.status || 'missing'}`);
  requireValue(report.releaseId === manifest.releaseId, `deployment blocked: ${label}.report.releaseId does not match releaseId`);
  requireValue(report.executionId === executionId, `deployment blocked: ${label}.report.executionId does not match evidence executionId`);
  validateTarget(`${label}.report`, report.target, expectedTarget, expectedTarget?.packageVersion ? 'packageVersion' : 'version');
  if (dryRun) {
    requireValue(report.mode === 'dry-run', `deployment blocked: ${label}.report.mode must be dry-run`);
    requireValue(report.result === 'PRECHECK_ONLY', `deployment blocked: ${label}.report.result must be PRECHECK_ONLY`);
  }
  return report;
}

function validateHxaReports(manifest, evidence, stageNames) {
  for (const stageName of stageNames) {
    const stage = evidence?.[stageName];
    const report = validateBoundReport(
      `evidence.hxa.${stageName}`,
      stage?.report,
      manifest,
      evidence?.executionId,
      manifest.candidate?.hxa,
      { dryRun: stageName === 'dryRun' },
    );
    if (stageName === 'execute' && stage?.status === 'NOT_APPLICABLE' && report) {
      requireValue(
        report.result === 'ALREADY_AT_IMMUTABLE_TARGET',
        'deployment blocked: evidence.hxa.execute.report.result must be ALREADY_AT_IMMUTABLE_TARGET',
      );
    }
  }
}

function validatePreDeployCanary(manifest) {
  const label = 'evidence.preDeployCanary';
  const evidence = manifest.evidence?.preDeployCanary;
  requireValue(evidence && typeof evidence === 'object' && !Array.isArray(evidence), `${label} is required for HXA execution`);
  if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) return;
  requireValue(evidence.status === 'PASS', `deployment blocked: ${label}.status=${evidence.status || 'missing'}`);
  requireValue(evidence.releaseId === manifest.releaseId, `deployment blocked: ${label}.releaseId does not match releaseId`);
  requireValue(typeof evidence.executionId === 'string' && evidence.executionId.length > 0, `deployment blocked: ${label}.executionId is required`);
  const reportPath = validateEvidencePath(label, evidence.report, { required: true });
  if (!reportPath) return;
  const { value: report, error } = readEvidenceReport(reportPath);
  if (error) {
    failures.push(`deployment blocked: ${label}.report is not valid JSON: ${error.message}`);
    return;
  }
  requireValue(report && typeof report === 'object' && !Array.isArray(report), `deployment blocked: ${label}.report is not an object`);
  if (!report || typeof report !== 'object' || Array.isArray(report)) return;
  requireValue(report.status === 'PASS', `deployment blocked: ${label}.report.status=${report.status || 'missing'}`);
  requireValue(report.releaseId === manifest.releaseId, `deployment blocked: ${label}.report.releaseId does not match releaseId`);
  requireValue(report.executionId === evidence.executionId, `deployment blocked: ${label}.report.executionId does not match evidence executionId`);
}

function validateHxaEvidence(manifest) {
  const candidate = manifest.candidate?.hxa;
  const evidence = manifest.evidence?.hxa;
  requireValue(evidence && typeof evidence === 'object' && !Array.isArray(evidence), 'evidence.hxa is required');
  if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) return null;

  requireValue(evidence.releaseId === manifest.releaseId, 'evidence.hxa.releaseId must match releaseId');
  requireValue(HXA_AGGREGATE_STATUSES.includes(evidence.status), 'evidence.hxa.status is invalid');
  validateTarget('evidence.hxa', evidence.target, candidate, 'packageVersion');
  const hasPassStage = HXA_STAGES.some(stageName => ['PASS', 'NOT_APPLICABLE'].includes(evidence[stageName]?.status));
  if (hasPassStage || evidence.status === 'PASS') {
    requireValue(typeof evidence.executionId === 'string' && evidence.executionId.length > 0, 'evidence.hxa.executionId is required for PASS evidence');
  } else if (evidence.executionId !== null && evidence.executionId !== undefined) {
    requireValue(typeof evidence.executionId === 'string' && evidence.executionId.length > 0, 'evidence.hxa.executionId is invalid');
  }
  for (const stageName of HXA_STAGES) {
    const stage = evidence[stageName];
    validateStageStructure(`evidence.hxa.${stageName}`, stage, candidate, 'packageVersion');
    if (stage && typeof stage === 'object' && ['PASS', 'NOT_APPLICABLE'].includes(stage.status)) {
      requireValue(stage.executionId === evidence.executionId, `evidence.hxa.${stageName}.executionId must match evidence.hxa.executionId`);
    }
  }
  if (evidence.status === 'PASS') {
    for (const stageName of HXA_STAGES) {
      const allowed = stageName === 'execute' ? ['PASS', 'NOT_APPLICABLE'] : ['PASS'];
      requireValue(allowed.includes(evidence[stageName]?.status), `evidence.hxa.${stageName} must be ${allowed.join(' or ')} when evidence.hxa.status=PASS`);
    }
  }
  if (evidence.status === 'PREPARED') {
    for (const stageName of ['check', 'dryRun']) {
      requireValue(evidence[stageName]?.status === 'PASS', `evidence.hxa.${stageName} must be PASS when evidence.hxa.status=PREPARED`);
    }
    for (const stageName of ['execute', 'provenance', 'canary']) {
      requireValue(evidence[stageName]?.status === 'NOT_RUN', `evidence.hxa.${stageName} must be NOT_RUN when evidence.hxa.status=PREPARED`);
    }
  }

  const observedRuntime = evidence.provenance?.observedRuntime;
  if (observedRuntime !== undefined) {
    requireValue(observedRuntime && typeof observedRuntime === 'object' && !Array.isArray(observedRuntime), 'evidence.hxa.provenance.observedRuntime is invalid');
    if (observedRuntime && typeof observedRuntime === 'object' && !Array.isArray(observedRuntime)) {
      requireValue(typeof observedRuntime.repo === 'string', 'evidence.hxa.provenance.observedRuntime.repo is invalid');
      requireValue(typeof observedRuntime.packageVersion === 'string', 'evidence.hxa.provenance.observedRuntime.packageVersion is invalid');
      requireValue(typeof observedRuntime.sha === 'string', 'evidence.hxa.provenance.observedRuntime.sha is invalid');
      requireValue(typeof observedRuntime.sourceMarker === 'string', 'evidence.hxa.provenance.observedRuntime.sourceMarker is invalid');
      requireValue(EVIDENCE_STATUSES.includes(observedRuntime.status), 'evidence.hxa.provenance.observedRuntime.status is invalid');
      if (observedRuntime.status === 'PASS') {
        requireValue(FULL_SHA.test(observedRuntime.sha || ''), 'evidence.hxa.provenance.observedRuntime.sha must be a full SHA for PASS');
        requireValue(
          observedRuntime.sourceMarker.length > 0 && observedRuntime.sourceMarker !== 'MISSING',
          'evidence.hxa.provenance.observedRuntime.sourceMarker must be present for PASS',
        );
        requireValue(
          targetsEqual(observedRuntime, candidate, 'packageVersion'),
          'evidence.hxa.provenance.observedRuntime does not match candidate target',
        );
      }
    }
  }

  if (evidence.status === 'PASS') {
    requireValue(
      evidence.provenance?.observedRuntime?.status === 'PASS',
      'evidence.hxa.provenance.observedRuntime must be PASS when evidence.hxa.status=PASS',
    );
  }

  if (mode !== 'deploy') return evidence;
  if (deploymentStage === 'hxa') {
    if (evidence.status !== 'PREPARED') {
      failures.push(`deployment blocked: HXA execution gate requires evidence.hxa.status=PREPARED (found ${evidence.status || 'missing'})`);
      return evidence;
    }
    validateHxaReports(manifest, evidence, ['check', 'dryRun']);
    return evidence;
  }
  if (evidence.status !== 'PASS') {
    failures.push(`deployment blocked: evidence.hxa.status=${evidence.status || 'missing'}`);
    return evidence;
  }

  validateHxaReports(manifest, evidence, HXA_STAGES);
  return evidence;
}

function validatePairEvidence(manifest, { deploy = false, requireDryRun = false } = {}) {
  const evidence = manifest.evidence?.pairReport;
  if (manifest.schema === SCHEMA_V1) {
    if (!deploy) return null;
    requireValue(typeof evidence === 'string' && evidence.length > 0, 'deployment blocked: pairReport is missing');
    return null;
  }

  requireValue(evidence && typeof evidence === 'object' && !Array.isArray(evidence), 'evidence.pairReport is required');
  if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) return null;
  requireValue(STAGE_STATUSES.includes(evidence.status), 'evidence.pairReport.status is invalid');
  const pairTarget = evidence.target;
  requireValue(pairTarget && typeof pairTarget === 'object' && !Array.isArray(pairTarget), 'evidence.pairReport.target is required');
  if (pairTarget && typeof pairTarget === 'object' && !Array.isArray(pairTarget)) {
    const pairTargetKeys = Object.keys(pairTarget).sort();
    requireValue(
      pairTargetKeys.length === COMPONENT_NAMES.length &&
        COMPONENT_NAMES.every(componentName => pairTargetKeys.includes(componentName)),
      'evidence.pairReport.target must contain exactly Core and Feishu; HXA is not a pair component',
    );
    for (const componentName of COMPONENT_NAMES) {
      validateTarget(`evidence.pairReport.target.${componentName}`, pairTarget[componentName], manifest.candidate?.[componentName], 'version');
    }
  }
  const reportPath = validateEvidencePath('evidence.pairReport', evidence.report, { required: deploy || requireDryRun });
  if (evidence.status === 'PASS') {
    requireValue(typeof evidence.executionId === 'string' && evidence.executionId.length > 0, 'evidence.pairReport.executionId is required for PASS');
  }
  if (evidence.status === 'PASS' && (deploy || requireDryRun) && reportPath) {
    const { value: report, error } = readEvidenceReport(reportPath);
    if (error) {
      failures.push(`deployment blocked: evidence.pairReport.report is not valid JSON: ${error.message}`);
    } else if (!report || typeof report !== 'object' || Array.isArray(report)) {
      failures.push('deployment blocked: evidence.pairReport.report is not an object');
    } else {
      validateNativeBinding(report, manifest, 'pair.dryRun');
      requireValue(report.status === 'PASS', `deployment blocked: pairReport.status=${report.status || 'missing'}`);
      requireValue(report.releaseId === manifest.releaseId, 'deployment blocked: pairReport.releaseId does not match releaseId');
      requireValue(report.executionId === evidence.executionId, 'deployment blocked: pairReport.executionId does not match evidence.pairReport.executionId');
      requireValue(report.mode === 'dry-run', 'deployment blocked: pairReport.report.mode must be dry-run');
      requireValue(report.result === 'PRECHECK_ONLY', 'deployment blocked: pairReport.report.result must be PRECHECK_ONLY');
      const reportTargetKeys = Object.keys(report.target || {}).sort();
      requireValue(
        reportTargetKeys.length === COMPONENT_NAMES.length &&
          COMPONENT_NAMES.every(componentName => reportTargetKeys.includes(componentName)),
        'deployment blocked: pairReport.report.target must contain exactly Core and Feishu; HXA is not a pair component',
      );
      for (const componentName of COMPONENT_NAMES) {
        validateTarget(`evidence.pairReport.report.target.${componentName}`, report.target?.[componentName], manifest.candidate?.[componentName], 'version');
      }
    }
  }
  return evidence;
}

function hasV2Fields(manifest) {
  return Boolean(
    manifest.stable?.hxa ||
      manifest.candidate?.hxa ||
      manifest.localValidationRepos?.hxa ||
      manifest.deploymentContract?.hxaRequired !== undefined ||
      manifest.deploymentContract?.pairComponents !== undefined ||
      manifest.evidence?.hxa ||
      manifest.evidence?.preDeployCanary ||
      (manifest.evidence?.pairReport && typeof manifest.evidence.pairReport === 'object'),
  );
}

const manifest = readJson(manifestPath);
let hxaEvidence = null;
let evidenceReusePlan = null;

if (manifest) {
  const supportedSchema = manifest.schema === SCHEMA_V1 || manifest.schema === SCHEMA_V2;
  requireValue(supportedSchema, 'unsupported manifest schema');
  requireValue(typeof manifest.releaseId === 'string' && manifest.releaseId.length > 0, 'releaseId is required');
  requireValue(['HOLD', 'READY', 'DEPLOYED', 'ROLLED_BACK', 'CANCELLED'].includes(manifest.status), 'status is invalid');
  requireValue(typeof manifest.deploymentAllowed === 'boolean', 'deploymentAllowed must be boolean');
  if (manifest.publicationAllowed !== undefined) {
    requireValue(typeof manifest.publicationAllowed === 'boolean', 'publicationAllowed must be boolean');
  }
  const publicationAllowed = manifest.publicationAllowed === true;
  requireValue(Array.isArray(manifest.holdReasons), 'holdReasons must be an array');
  requireValue(manifest.localValidationRepos && typeof manifest.localValidationRepos === 'object', 'localValidationRepos is required');
  requireValue(manifest.target === undefined, 'global release manifest must not contain a per-agent target');
  evidenceReusePlan = validateEvidenceReuse(manifest);

  const v2SourceOptions = manifest.schema === SCHEMA_V2
    ? {
        sourcePolicy: manifest.sourcePolicy,
        cleanWorktreeRequired: manifest.deploymentContract?.cleanWorktreeRequired === true,
      }
    : {};

  for (const groupName of ['stable', 'candidate']) {
    for (const componentName of COMPONENT_NAMES) {
      validateComponent(
        groupName,
        componentName,
        manifest[groupName]?.[componentName],
        manifest.localValidationRepos?.[componentName],
        v2SourceOptions,
      );
    }
  }

  if (manifest.schema === SCHEMA_V1) {
    requireValue(!hasV2Fields(manifest), 'HXA-enabled fields require zylos.release-manifest/v2');
  }

  if (manifest.schema === SCHEMA_V2) {
    requireValue(manifest.sourcePolicy && typeof manifest.sourcePolicy === 'object' && !Array.isArray(manifest.sourcePolicy), 'sourcePolicy is required for v2');
    requireValue(manifest.sourcePolicy?.deployableBranch === 'main', 'v2 sourcePolicy.deployableBranch must be main');
    requireValue(manifest.sourcePolicy?.immutableFullShaOnly === true, 'v2 sourcePolicy.immutableFullShaOnly must be true');
    requireValue(
      manifest.sourcePolicy?.featureReleaseArchiveBranchesAreHistoryOnly === true,
      'v2 sourcePolicy.featureReleaseArchiveBranchesAreHistoryOnly must be true',
    );
    requireValue(manifest.deploymentContract && typeof manifest.deploymentContract === 'object', 'deploymentContract is required for v2');
    requireValue(
      manifest.deploymentContract?.targetMode === TARGET_MODE_GLOBAL,
      `v2 deploymentContract.targetMode must be ${TARGET_MODE_GLOBAL}`,
    );
    if (manifest.deploymentContract?.rolloutMode !== undefined) {
      requireValue(
        ROLLOUT_MODES.includes(manifest.deploymentContract.rolloutMode),
        `v2 deploymentContract.rolloutMode must be ${ROLLOUT_MODES.join(' or ')}`,
      );
    }
    requireValue(manifest.deploymentContract?.hxaRequired === true, 'v2 deploymentContract.hxaRequired must be true');
    requireValue(manifest.deploymentContract?.immutableFullShaOnly === true, 'v2 deploymentContract.immutableFullShaOnly must be true');
    requireValue(manifest.deploymentContract?.cleanWorktreeRequired === true, 'v2 deploymentContract.cleanWorktreeRequired must be true');
    requireValue(manifest.deploymentContract?.dryRunRequired === true, 'v2 deploymentContract.dryRunRequired must be true');
    requireValue(manifest.deploymentContract?.pairReportRequired === true, 'v2 deploymentContract.pairReportRequired must be true');
    requireValue(manifest.deploymentContract?.canaryRequired === true, 'v2 deploymentContract.canaryRequired must be true');
    requireValue(
      Array.isArray(manifest.deploymentContract?.pairComponents) &&
        manifest.deploymentContract.pairComponents.length === 2 &&
        manifest.deploymentContract.pairComponents[0] === 'core' &&
        manifest.deploymentContract.pairComponents[1] === 'feishu',
      "v2 deploymentContract.pairComponents must be exactly ['core','feishu']",
    );
    for (const groupName of ['stable', 'candidate']) {
      validateComponent(
        groupName,
        'hxa',
        manifest[groupName]?.hxa,
        manifest.localValidationRepos?.hxa,
        {
          versionKey: 'packageVersion',
          packageName: 'zylos-hxa-connect',
          ...v2SourceOptions,
        },
      );
    }
    validatePairEvidence(manifest, { deploy: false });
    hxaEvidence = validateHxaEvidence(manifest);
  }

  if (manifest.status === 'READY' && manifest.holdReasons.length > 0) {
    failures.push('READY manifest must not contain holdReasons');
  }
  if (manifest.deploymentAllowed && manifest.status !== 'READY') {
    failures.push('deploymentAllowed=true requires status=READY');
  }
  if (manifest.status === 'READY' && manifest.deploymentAllowed === true && publicationAllowed) {
    failures.push('READY deployment manifest must have publicationAllowed=false');
  }

  if (manifest.status === 'CANCELLED') {
    requireValue(publicationAllowed === false, 'CANCELLED manifest must have publicationAllowed=false');
  }

  if (publicationAllowed) {
    requireValue(manifest.schema === SCHEMA_V2, 'publicationAllowed=true requires manifest schema v2');
    requireValue(['HOLD', 'READY'].includes(manifest.status), 'publicationAllowed=true requires status=HOLD or READY');
    if (manifest.status === 'HOLD') {
      requireValue(manifest.deploymentAllowed === false, 'publication HOLD must have deploymentAllowed=false');
    }
    validatePublicationAuthorization(manifest);
  }

  if (manifest.status === 'CANCELLED') {
    requireValue(manifest.deploymentAllowed === false, 'CANCELLED manifest must have deploymentAllowed=false');
    const closure = validateClosureRecord(manifest.transactionClosure, { manifest, manifestPath });
    for (const failure of closure.failures) failures.push(`cancelled release closure invalid: ${failure}`);
  }

  if (mode === 'deploy') {
    requireValue(manifest.status === 'READY', `deployment blocked: status=${manifest.status}`);
    requireValue(manifest.deploymentAllowed === true, 'deployment blocked: deploymentAllowed is not true');
    if (manifest.schema === SCHEMA_V1) {
      requireValue(deploymentStage === 'final', 'deployment blocked: staged HXA/pair gates require manifest schema v2');
      requireValue(manifest.evidence?.canary === 'PASS', `deployment blocked: canary=${manifest.evidence?.canary || 'missing'}`);
      requireValue(manifest.evidence?.hxaProvenance === 'PASS', `deployment blocked: hxaProvenance=${manifest.evidence?.hxaProvenance || 'missing'}`);
      validatePairEvidence(manifest, { deploy: true });
    } else {
      validateOwnerAuthorization(manifest);
      const pairEvidence = manifest.evidence?.pairReport;
      requireValue(pairEvidence?.status === 'PASS', `deployment blocked: pairReport.status=${pairEvidence?.status || 'missing'}`);
      if (deploymentStage === 'hxa') {
        validatePairEvidence(manifest, { requireDryRun: true });
        validatePreDeployCanary(manifest);
      } else if (deploymentStage === 'pair') {
        validatePairEvidence(manifest, { deploy: true });
        validatePreDeployCanary(manifest);
        requireValue(
          hxaEvidence?.status === 'PASS',
          `deployment blocked: pair execution requires evidence.hxa.status=PASS (found ${hxaEvidence?.status || 'missing'})`,
        );
      } else {
        validatePairEvidence(manifest, { deploy: true });
        validatePreDeployCanary(manifest);
        requireValue(manifest.evidence?.canary === 'PASS', `deployment blocked: canary=${manifest.evidence?.canary || 'missing'}`);
      }
    }
    if (manifest.status === 'READY' && manifest.deploymentAllowed === true) {
      runtimeIdentityVerification = resolveRuntimeDeploymentIdentity();
      if (runtimeIdentityVerification) {
        runtimeIdentity = {
          name: runtimeIdentityVerification.profileName,
          id: runtimeIdentityVerification.registeredProfileId || runtimeIdentityVerification.deploymentProfileId,
        };
      }
    }
  } else if (mode === 'publish') {
    requireValue(publicationAllowed === true, 'publication blocked: publicationAllowed is not true');
    if (publicationAllowed) {
      validatePublicationAuthorization(manifest);
      validateWorkspacePublishReceipt(manifest);
    }
  } else if (manifest.status !== 'READY' || manifest.deploymentAllowed !== true) {
    warnings.push(`release ${manifest.releaseId} is ${manifest.status}; deployment remains blocked`);
  }
}

for (const claim of nativeRuntimeClaims) {
  requireValue(claim.agent === runtimeIdentity?.name, 'deployment blocked: native report agent differs from fresh runtime identity');
  if (claim.profileId) requireValue(claim.profileId === runtimeIdentityVerification?.deploymentProfileId, 'deployment blocked: native report profile differs from fresh runtime identity');
  if (claim.hostname) requireValue(claim.hostname === os.hostname(), 'deployment blocked: native report hostname differs from current host');
}

const result = {
  schema: PREFLIGHT_SCHEMA,
  receiptType: mode === 'publish' ? 'workspace-publish' : null,
  mode,
  manifest: manifestPath,
  releaseId: manifest?.releaseId || null,
  releaseStatus: manifest?.status || null,
  deploymentAllowed: manifest?.deploymentAllowed ?? null,
  publicationAllowed: manifest?.publicationAllowed === true,
  targetMode: manifest?.deploymentContract?.targetMode || null,
  deploymentStage,
  deploymentPhase: manifest?.evidence?.hxa?.status === 'PREPARED'
    ? 'PREPARED'
    : manifest?.evidence?.hxa?.status === 'PASS'
      ? (manifest?.evidence?.canary === 'PASS' ? 'COMPLETE' : 'HXA_COMPLETE')
      : (manifest?.status || null),
  gate: mode === 'deploy'
    ? { hxa: 'HXA_EXECUTE', pair: 'CORE_FEISHU_EXECUTE', final: 'FINALIZE' }[deploymentStage]
    : mode === 'publish' ? 'PUBLICATION' : null,
  nextStage: mode === 'deploy'
    ? { hxa: 'PAIR', pair: 'FINAL', final: null }[deploymentStage]
    : null,
  runtimeTarget: runtimeIdentity
    ? {
        agent: runtimeIdentity.name,
        profileId: runtimeIdentityVerification?.deploymentProfileId || runtimeIdentity.id,
        hostname: os.hostname(),
        ...(runtimeIdentityVerification
          ? {
              deploymentOrgLabel: runtimeIdentityVerification.deploymentOrgLabel,
              deploymentProfileId: runtimeIdentityVerification.deploymentProfileId,
              ...(runtimeIdentity.id !== runtimeIdentityVerification.deploymentProfileId
                ? { discoveredProfileId: runtimeIdentity.id }
                : {}),
            }
          : {}),
      }
    : null,
  dispositions: {
    publicationAllowed: manifest?.publicationAllowed === true,
    deploymentAllowed: manifest?.deploymentAllowed === true,
  },
  candidateBundle: manifest?.schema === SCHEMA_V2
    ? {
        coreSha: manifest.candidate?.core?.sha,
        feishuSha: manifest.candidate?.feishu?.sha,
        hxaSha: manifest.candidate?.hxa?.sha,
      }
    : null,
  generatedAt: new Date().toISOString(),
  hxa: hxaEvidence
    ? {
        status: hxaEvidence.status || null,
        target: targetSummary(hxaEvidence.target, 'packageVersion'),
      }
    : null,
  evidenceReuse: evidenceReusePlan
    ? {
        status: evidenceReusePlan.status || null,
        decisions: evidenceReusePlan.decisions?.map(decision => ({
          gate: decision.gate,
          decision: decision.decision,
        })) || [],
      }
    : null,
  status: failures.length === 0 ? 'PASS' : 'HOLD',
  failures,
  warnings,
};

if (mode === 'publish' && receiptPath && result.status === 'PASS') {
  try {
    fs.writeFileSync(receiptPath, `${JSON.stringify(result, null, 2)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    });
    result.workspacePublish = {
      receiptType: 'workspace-publish',
      report: receiptPath,
      reportSha256: sha256File(receiptPath),
    };
  } catch (error) {
    result.status = 'HOLD';
    result.failures.push(`cannot write workspace publish receipt ${receiptPath}: ${error.message}`);
  }
}

console.log(JSON.stringify(result, null, 2));
process.exit(failures.length === 0 ? 0 : 2);
