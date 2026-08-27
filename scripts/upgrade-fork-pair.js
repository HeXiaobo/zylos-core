#!/usr/bin/env node
/**
 * Deterministic Core + Feishu fork upgrade orchestrator.
 *
 * This file intentionally uses only Node built-ins. The immutable bootstrap
 * downloads a Core archive by full commit SHA, then this orchestrator validates
 * both target archives and the live deployment before invoking either upgrade.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const CORE_REPO = 'HeXiaobo/zylos-core';
const FEISHU_REPO = 'HeXiaobo/zylos-feishu';
const FULL_SHA = /^[0-9a-f]{40}$/i;
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const MIN_AVAILABLE_KB = 5 * 1024 * 1024;
const CORE_BACKUP_PREFIX = 'zylos-core-backup-';
const CORE_BACKUP_RETAIN = 2;
const CORE_BACKUP_QUARANTINE_PREFIX = '.zylos-core-retention-quarantine-';
const CORE_BACKUP_RETENTION_LOCK = 'core-backup-retention.lock';
const CORE_BACKUP_OWNER_MARKER = '.zylos-core-backup-owner.json';

export function pathsReferToSameFile(leftPath, rightPath, fsApi = fs) {
  if (!leftPath || !rightPath) return false;
  try {
    const left = fsApi.statSync(leftPath);
    const right = fsApi.statSync(rightPath);
    return left.dev === right.dev && left.ino === right.ino;
  } catch {
    return false;
  }
}

const FEISHU_REQUIRED_CORE_PROTOCOLS = Object.freeze({
  'c4.reply': 2,
  'c4.reply.argv-compat': 1,
  'c4.assistant-response-stream': 3,
  'c4.outbound-delivery-id': 1,
  'work-intake': 1,
  'commitment-core': 1,
  'projection-outbox': 1,
  'external-task-adapter': 1,
  'native-task-conservation-inventory': 1,
  'task-reminder': 1,
});

const CORE_TARGET_PROTOCOLS = Object.freeze({
  ...FEISHU_REQUIRED_CORE_PROTOCOLS,
  'c4.reply.body-file': 1,
});

const FEISHU_TARGET_PROTOCOLS = Object.freeze({
  'feishu.native-task-conservation-gate': 1,
});

const CORE_ASSETS = Object.freeze([
  'skills/comm-bridge/scripts/c4-send.js',
  'skills/comm-bridge/scripts/c4-receive.js',
  'skills/comm-bridge/scripts/c4-dispatcher.js',
  'skills/comm-bridge/scripts/c4-response-stream-supervisor.js',
  'skills/activity-monitor/scripts/assistant-turn-binding.js',
  'scripts/upgrade-fork-pair.js',
  'scripts/upgrade-fork-pair.sh',
  'cli/lib/native-task-conservation-inventory.js',
]);

const FEISHU_ASSETS = Object.freeze([
  'src/index.js',
  'hooks/pre-upgrade.js',
  'hooks/post-upgrade.js',
  'scripts/native-task-closure-gate.js',
  'scripts/native-task-completion-gate.js',
  'scripts/native-task-conservation-gate.js',
  'src/lib/native-task-conservation-gate.js',
  'src/lib/native-task-conservation-remote.js',
  'src/lib/task-comment-worker.js',
  'src/lib/task-v2-projection.js',
]);

class HoldError extends Error {
  constructor(message, code = 'PRECHECK_FAILED') {
    super(message);
    this.name = 'HoldError';
    this.code = code;
  }
}

function readJson(filePath, fsApi = fs) {
  return JSON.parse(fsApi.readFileSync(filePath, 'utf8'));
}

function fileIsRegular(filePath, fsApi = fs) {
  try {
    return fsApi.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function validateAssets(root, assets, fsApi = fs) {
  return assets.filter((relativePath) => !fileIsRegular(path.join(root, relativePath), fsApi));
}

function validateProtocols(actual, required) {
  const errors = [];
  for (const [name, minimum] of Object.entries(required)) {
    const value = actual?.[name];
    if (!Number.isInteger(value) || value < minimum) {
      errors.push(`${name} requires >= ${minimum}, found ${value ?? 'missing'}`);
    }
  }
  return errors;
}

export function validatePinnedTarget({ coreSha, feishuSha, coreVersion, feishuVersion, agent } = {}) {
  if (!FULL_SHA.test(String(coreSha || ''))) {
    return { ok: false, error: 'core SHA must be a full immutable 40-hex commit' };
  }
  if (!FULL_SHA.test(String(feishuSha || ''))) {
    return { ok: false, error: 'Feishu SHA must be a full immutable 40-hex commit' };
  }
  if (!VERSION.test(String(coreVersion || ''))) {
    return { ok: false, error: 'Core expected version is missing or invalid' };
  }
  if (!VERSION.test(String(feishuVersion || ''))) {
    return { ok: false, error: 'Feishu expected version is missing or invalid' };
  }
  if (!String(agent || '').trim() || agent === 'unknown') {
    return { ok: false, error: 'agent identity is required' };
  }
  return { ok: true };
}

function canonicalAgentId(value) {
  const text = String(value || '').trim().toLowerCase();
  if (!text) return null;
  return text.startsWith('agent:') ? text : `agent:${text}`;
}

export function validateNativeTaskDeploymentIdentity({
  requestedAgent,
  agentId,
  defaultAssigneeId,
  appId,
  agentAppIds,
} = {}) {
  const expectedAgentId = canonicalAgentId(requestedAgent);
  const deploymentAgentId = canonicalAgentId(agentId);
  const normalizedDefault = defaultAssigneeId
    ? canonicalAgentId(defaultAssigneeId)
    : deploymentAgentId;
  const normalizedAppId = String(appId || '').trim();
  if (!expectedAgentId || !deploymentAgentId || expectedAgentId !== deploymentAgentId) {
    return {
      ok: false,
      error: `requested Agent ${expectedAgentId || '(missing)'} does not match ZYLOS_AGENT_ID ${deploymentAgentId || '(missing)'}`,
    };
  }
  if (normalizedDefault !== deploymentAgentId) {
    return {
      ok: false,
      error: `C4_WORK_INTAKE_DEFAULT_ASSIGNEE_ID ${normalizedDefault || '(missing)'} does not match ZYLOS_AGENT_ID ${deploymentAgentId}`,
    };
  }
  if (!normalizedAppId) {
    return { ok: false, error: 'FEISHU_APP_ID is required' };
  }
  let mappings;
  try {
    mappings = typeof agentAppIds === 'string' ? JSON.parse(agentAppIds) : agentAppIds;
  } catch (error) {
    return { ok: false, error: `FEISHU_TASK_V2_AGENT_APP_IDS is invalid JSON: ${error.message}` };
  }
  if (!mappings || typeof mappings !== 'object' || Array.isArray(mappings)) {
    return { ok: false, error: 'FEISHU_TASK_V2_AGENT_APP_IDS must be an object' };
  }
  if (String(mappings[deploymentAgentId] || '').trim() !== normalizedAppId) {
    return {
      ok: false,
      error: `FEISHU_TASK_V2_AGENT_APP_IDS must map ${deploymentAgentId} to FEISHU_APP_ID`,
    };
  }
  return {
    ok: true,
    identity: Object.freeze({ agentId: deploymentAgentId, appId: normalizedAppId }),
  };
}

export function validateCoreSource(root, expectedVersion, fsApi = fs) {
  try {
    const pkg = readJson(path.join(root, 'package.json'), fsApi);
    const capabilities = readJson(path.join(root, 'capabilities.json'), fsApi);
    const errors = [];
    if (pkg.name !== 'zylos') errors.push(`package name must be zylos, found ${pkg.name ?? 'missing'}`);
    if (pkg.version !== expectedVersion) {
      errors.push(`package version must be ${expectedVersion}, found ${pkg.version ?? 'missing'}`);
    }
    if (capabilities.product !== 'zylos-core') {
      errors.push(`capability product must be zylos-core, found ${capabilities.product ?? 'missing'}`);
    }
    if (capabilities.release !== expectedVersion) {
      errors.push(`capability release must be ${expectedVersion}, found ${capabilities.release ?? 'missing'}`);
    }
    errors.push(...validateProtocols(capabilities.protocols, CORE_TARGET_PROTOCOLS));
    const missing = validateAssets(root, CORE_ASSETS, fsApi);
    if (missing.length > 0) errors.push(`missing critical Core assets: ${missing.join(', ')}`);
    return errors.length === 0 ? { ok: true, package: pkg, capabilities } : {
      ok: false,
      error: errors.join('; '),
    };
  } catch (error) {
    return { ok: false, error: `invalid Core source: ${error.message}` };
  }
}

export function validateFeishuSource(root, expectedVersion, fsApi = fs) {
  try {
    const pkg = readJson(path.join(root, 'package.json'), fsApi);
    const capabilities = readJson(path.join(root, 'capabilities.json'), fsApi);
    const errors = [];
    if (pkg.name !== 'zylos-feishu') {
      errors.push(`package name must be zylos-feishu, found ${pkg.name ?? 'missing'}`);
    }
    if (pkg.version !== expectedVersion) {
      errors.push(`package version must be ${expectedVersion}, found ${pkg.version ?? 'missing'}`);
    }
    if (capabilities.product !== 'zylos-feishu') {
      errors.push(`capability product must be zylos-feishu, found ${capabilities.product ?? 'missing'}`);
    }
    if (capabilities.release !== expectedVersion) {
      errors.push(`capability release must be ${expectedVersion}, found ${capabilities.release ?? 'missing'}`);
    }
    errors.push(...validateProtocols(
      capabilities.requires?.['zylos-core']?.protocols,
      FEISHU_REQUIRED_CORE_PROTOCOLS,
    ));
    errors.push(...validateProtocols(capabilities.provides, FEISHU_TARGET_PROTOCOLS));
    const missing = validateAssets(root, FEISHU_ASSETS, fsApi);
    if (missing.length > 0) errors.push(`missing critical Feishu assets: ${missing.join(', ')}`);
    return errors.length === 0 ? { ok: true, package: pkg, capabilities } : {
      ok: false,
      error: errors.join('; '),
    };
  } catch (error) {
    return { ok: false, error: `invalid Feishu source: ${error.message}` };
  }
}

export function buildUpgradeCommands({
  nodePath,
  stagedCoreDir,
  installedCoreDir,
  coreSha,
  feishuSha,
}) {
  return {
    core: {
      command: nodePath,
      args: [
        path.join(stagedCoreDir, 'cli', 'zylos.js'),
        'upgrade', '--self', '--branch', coreSha, '--yes', '--json',
      ],
    },
    feishu: {
      command: nodePath,
      args: [
        path.join(installedCoreDir, 'cli', 'zylos.js'),
        'upgrade', 'feishu', '--branch', feishuSha,
        '--yes', '--skip-eval', '--json',
      ],
    },
  };
}

export function buildNativeTaskConservationCommand({
  nodePath,
  coreDir,
  feishuDir,
  timeoutMs = 90_000,
}) {
  return {
    command: nodePath,
    args: [
      path.join(feishuDir, 'scripts', 'native-task-conservation-gate.js'),
      '--core-inventory-command', nodePath,
      '--core-inventory-arg', path.join(coreDir, 'cli', 'lib', 'native-task-conservation-inventory.js'),
      '--timeout-ms', String(timeoutMs),
    ],
  };
}

function parseArgs(argv) {
  const result = { execute: false, dryRun: false, agent: 'unknown' };
  const valueFlags = new Map([
    ['--core-sha', 'coreSha'],
    ['--feishu-sha', 'feishuSha'],
    ['--core-version', 'coreVersion'],
    ['--feishu-version', 'feishuVersion'],
    ['--staged-core', 'stagedCoreDir'],
    ['--agent', 'agent'],
    ['--report-root', 'reportRoot'],
  ]);

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--execute') {
      result.execute = true;
      continue;
    }
    if (arg === '--dry-run') {
      result.dryRun = true;
      continue;
    }
    const key = valueFlags.get(arg);
    if (!key) throw new HoldError(`unknown option: ${arg}`, 'INVALID_ARGS');
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) {
      throw new HoldError(`${arg} requires a value`, 'INVALID_ARGS');
    }
    result[key] = value;
    index += 1;
  }

  if (result.execute === result.dryRun) {
    throw new HoldError('choose exactly one of --execute or --dry-run', 'INVALID_ARGS');
  }
  if (!result.stagedCoreDir) {
    throw new HoldError('--staged-core is required; use the immutable bootstrap', 'INVALID_ARGS');
  }
  return result;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    timeout: options.timeout ?? 120_000,
    cwd: options.cwd,
    env: options.env ?? process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return {
    status: result.status,
    signal: result.signal,
    stdout: String(result.stdout || ''),
    stderr: String(result.stderr || ''),
    error: result.error?.message ?? null,
  };
}

function requireSuccess(result, label, code = 'COMMAND_FAILED') {
  if (result.status === 0 && !result.error) return result;
  const detail = result.error
    || result.stderr.trim().split(/\r?\n/).find(Boolean)
    || result.stdout.trim().split(/\r?\n/).find(Boolean)
    || `exit ${result.status}`;
  throw new HoldError(`${label}: ${detail}`, code);
}

function parseJsonOutput(output) {
  const text = String(output || '').trim();
  try {
    return JSON.parse(text);
  } catch {
    for (let index = 0; index < text.length; index += 1) {
      if (text[index] !== '{' && text[index] !== '[') continue;
      try {
        return JSON.parse(text.slice(index));
      } catch {
        // Try the next possible boundary.
      }
    }
  }
  return null;
}

function atomicWriteJson(filePath, value, fsApi = fs) {
  const tempPath = `${filePath}.tmp-${process.pid}-${crypto.randomBytes(12).toString('hex')}`;
  const content = `${JSON.stringify(value, null, 2)}\n`;
  try {
    let fileHandle = null;
    try {
      fileHandle = fsApi.openSync(tempPath, 'wx', 0o600);
      fsApi.writeFileSync(fileHandle, content, 'utf8');
      fsApi.fsyncSync(fileHandle);
    } finally {
      if (fileHandle !== null) fsApi.closeSync(fileHandle);
    }
    fsApi.renameSync(tempPath, filePath);
    const directoryHandle = fsApi.openSync(path.dirname(filePath), 'r');
    try {
      fsApi.fsyncSync(directoryHandle);
    } finally {
      fsApi.closeSync(directoryHandle);
    }
  } catch (error) {
    try { fsApi.rmSync(tempPath, { force: true }); } catch {}
    throw error;
  }
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function signedDocument(payload) {
  return { ...payload, signature: sha256(JSON.stringify(payload)) };
}

function hasValidSignature(document) {
  if (!document || typeof document !== 'object' || typeof document.signature !== 'string') return false;
  const { signature, ...payload } = document;
  return signature === sha256(JSON.stringify(payload));
}

function hashFile(filePath) {
  if (!fileIsRegular(filePath)) return null;
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function persistedEnvValue(filePath, name) {
  let content;
  try {
    content = fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const match = line.match(/^([A-Z0-9_]+)\s*=\s*(.*)$/);
    if (match?.[1] !== name) continue;
    return match[2].trim().replace(/^(['"])(.*)\1$/, '$2');
  }
  return null;
}

function pm2Snapshot() {
  const result = requireSuccess(run('pm2', ['jlist']), 'PM2 inspection failed');
  const processes = parseJsonOutput(result.stdout);
  if (!Array.isArray(processes)) throw new HoldError('PM2 returned invalid JSON');
  return processes.map((proc) => ({
    name: proc.name,
    status: proc.pm2_env?.status ?? 'unknown',
    pid: proc.pid ?? null,
    execPath: proc.pm2_env?.pm_exec_path ?? null,
    restartTime: proc.pm2_env?.restart_time ?? null,
    unstableRestarts: proc.pm2_env?.unstable_restarts ?? null,
  })).sort((left, right) => String(left.name).localeCompare(String(right.name)));
}

export function validatePm2Snapshot(snapshot, { requireSupervisor = false } = {}) {
  const required = ['activity-monitor', 'c4-dispatcher', 'zylos-feishu'];
  if (requireSupervisor) required.push('c4-response-stream-supervisor');
  const errors = [];
  for (const name of required) {
    const proc = snapshot.find((candidate) => candidate.name === name);
    if (!proc || proc.status !== 'online') {
      errors.push(`${name} is not online`);
    }
  }
  for (const proc of snapshot) {
    if (proc.status !== 'online') continue;
    if (!proc.execPath || !fileIsRegular(proc.execPath)) {
      errors.push(
        `${proc.name} reports online but has no live executable at ${proc.execPath || '(unset)'}`,
      );
    }
  }
  return errors;
}

/**
 * Plan the one safe preflight repair needed after an older Core rollback.
 *
 * The repair is deliberately exact: the known target-only service name must
 * point at its canonical live path, that path must be absent in the restored
 * baseline, and the immutable target must contain the replacement entrypoint.
 * Anything else remains a HOLD for human diagnosis.
 */
export function planPm2PreflightRepairs(snapshot, {
  zylosDir,
  stagedCoreDir,
  fsApi = fs,
} = {}) {
  if (!zylosDir || !stagedCoreDir) return [];
  const name = 'c4-response-stream-supervisor';
  const expectedLivePath = path.join(
    path.resolve(zylosDir),
    '.claude',
    'skills',
    'comm-bridge',
    'scripts',
    'c4-response-stream-supervisor.js',
  );
  const targetPath = path.join(
    path.resolve(stagedCoreDir),
    'skills',
    'comm-bridge',
    'scripts',
    'c4-response-stream-supervisor.js',
  );
  const proc = snapshot.find((candidate) => candidate.name === name);
  if (
    proc?.status !== 'online'
    || !proc.execPath
    || path.resolve(proc.execPath) !== expectedLivePath
    || fileIsRegular(expectedLivePath, fsApi)
    || !fileIsRegular(targetPath, fsApi)
  ) {
    return [];
  }
  return [{
    action: 'delete_rollback_orphan',
    name,
    execPath: expectedLivePath,
    targetPath,
  }];
}

function applyPm2PreflightRepairs(repairs) {
  const applied = [];
  for (const repair of repairs) {
    requireSuccess(
      run('pm2', ['delete', repair.name]),
      `failed to delete rollback orphan ${repair.name}`,
      'PREFLIGHT_REPAIR_FAILED',
    );
    applied.push({ ...repair, status: 'APPLIED' });
  }
  if (applied.length > 0) {
    requireSuccess(
      run('pm2', ['save']),
      'failed to persist repaired PM2 process list',
      'PREFLIGHT_REPAIR_FAILED',
    );
  }
  return applied;
}

function availableDiskKb(targetPath) {
  const result = requireSuccess(run('df', ['-Pk', targetPath]), 'disk inspection failed');
  const lines = result.stdout.trim().split(/\r?\n/);
  const fields = lines.at(-1)?.trim().split(/\s+/);
  const available = Number(fields?.[3]);
  if (!Number.isFinite(available)) throw new HoldError('could not parse available disk space');
  return available;
}

function coreBackupRoots({ homeDir = os.homedir(), tmpDir = os.tmpdir() } = {}) {
  return [...new Set([
    path.resolve(tmpDir),
    path.resolve(homeDir, 'tmp'),
  ])];
}

function inspectCoreBackupDir(candidatePath, { fsApi = fs, roots, expectedName } = {}) {
  const resolvedCandidate = path.resolve(candidatePath);
  const allowedRoots = roots ?? coreBackupRoots();
  const root = allowedRoots.find((candidateRoot) => path.dirname(resolvedCandidate) === candidateRoot);
  const candidateName = path.basename(resolvedCandidate);
  if (
    !root
    || (expectedName ? candidateName !== expectedName : !candidateName.startsWith(CORE_BACKUP_PREFIX))
  ) return null;
  try {
    const rootStat = fsApi.lstatSync(root);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) return null;
    const stat = fsApi.lstatSync(resolvedCandidate);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return null;
    const realRoot = fsApi.realpathSync(root);
    const realCandidate = fsApi.realpathSync(resolvedCandidate);
    if (fsApi.realpathSync(path.dirname(resolvedCandidate)) !== realRoot) return null;
    if (path.dirname(realCandidate) !== realRoot) return null;
    const corePackagePath = path.join(resolvedCandidate, 'core-package');
    const packagePath = path.join(resolvedCandidate, 'core-package', 'package.json');
    const skillsPath = path.join(resolvedCandidate, 'skills');
    const corePackageStat = fsApi.lstatSync(corePackagePath);
    const packageStat = fsApi.lstatSync(packagePath);
    const skillsStat = fsApi.lstatSync(skillsPath);
    if (!corePackageStat.isDirectory() || corePackageStat.isSymbolicLink()) return null;
    if (!packageStat.isFile() || packageStat.isSymbolicLink()) return null;
    if (!skillsStat.isDirectory() || skillsStat.isSymbolicLink()) return null;
    if (fsApi.realpathSync(corePackagePath) !== path.join(realCandidate, 'core-package')) return null;
    if (fsApi.realpathSync(packagePath) !== path.join(realCandidate, 'core-package', 'package.json')) return null;
    if (fsApi.realpathSync(skillsPath) !== path.join(realCandidate, 'skills')) return null;
    const pkg = readJson(packagePath, fsApi);
    if (pkg.name !== 'zylos' || !VERSION.test(pkg.version ?? '')) return null;
    return {
      path: resolvedCandidate,
      realPath: realCandidate,
      rootPath: root,
      rootRealPath: realRoot,
      name: candidateName,
      dev: stat.dev,
      ino: stat.ino,
      mtimeMs: stat.mtimeMs,
      version: pkg.version ?? null,
    };
  } catch {
    return null;
  }
}

function pairSummaryProof(summary, summaryPath) {
  const resolvedSummaryPath = path.resolve(summaryPath);
  if (
    summary?.schema !== 'zylos.fork-pair-upgrade/v1'
    || summary.status !== 'PASS'
    || summary.result !== 'UPGRADE_COMPLETE'
    || summary.coreUpgraded !== true
    || summary.feishuUpgraded !== true
    || summary.postcheck?.status !== 'PASS'
    || !FULL_SHA.test(summary.target?.core?.sha ?? '')
    || !VERSION.test(summary.target?.core?.version ?? '')
    || path.resolve(summary.reportDir ?? '') !== path.dirname(resolvedSummaryPath)
    || typeof summary.startedAt !== 'string'
    || typeof summary.finishedAt !== 'string'
  ) return null;
  return {
    kind: 'pair-summary',
    summaryPath: resolvedSummaryPath,
    reportDir: path.resolve(summary.reportDir),
    startedAt: summary.startedAt,
    finishedAt: summary.finishedAt,
    coreSha: summary.target.core.sha,
    coreVersion: summary.target.core.version,
    backupDir: path.resolve(summary.coreResult?.backupDir ?? ''),
  };
}

function verifyPairSummaryProof(proof, fsApi = fs) {
  try {
    const summaryStat = fsApi.lstatSync(proof.summaryPath);
    if (
      !summaryStat.isFile()
      || summaryStat.isSymbolicLink()
      || (typeof process.geteuid === 'function' && summaryStat.uid !== process.geteuid())
      || (summaryStat.mode & 0o022) !== 0
      || fsApi.realpathSync(proof.summaryPath) !== path.join(
        fsApi.realpathSync(path.dirname(proof.summaryPath)),
        path.basename(proof.summaryPath),
      )
    ) return false;
    const summary = readJson(proof.summaryPath, fsApi);
    const actual = pairSummaryProof(summary, proof.summaryPath);
    return actual && JSON.stringify(actual) === JSON.stringify(proof);
  } catch {
    return false;
  }
}

function ownerMarkerPayload(backup, proof, fsApi = fs) {
  const stat = fsApi.lstatSync(backup.path);
  const packagePath = path.join(backup.path, 'core-package', 'package.json');
  return {
    schema: 'zylos.core-backup-owner/v1',
    backup: {
      path: backup.path,
      realPath: backup.realPath,
      dev: stat.dev,
      ino: stat.ino,
      uid: stat.uid,
      gid: stat.gid,
      mode: stat.mode & 0o777,
      packageVersion: backup.version,
      packageSha256: sha256(fsApi.readFileSync(packagePath)),
    },
    proof,
  };
}

function claimCurrentBackupOwnership(currentBackupDir, summary, summaryPath, {
  fsApi = fs,
  roots,
} = {}) {
  const backup = inspectCoreBackupDir(currentBackupDir, { fsApi, roots });
  const proof = pairSummaryProof(summary, summaryPath);
  if (!backup || !proof || proof.backupDir !== backup.path || !verifyPairSummaryProof(proof, fsApi)) {
    return null;
  }
  const markerPath = path.join(backup.path, CORE_BACKUP_OWNER_MARKER);
  atomicWriteJson(markerPath, signedDocument(ownerMarkerPayload(backup, proof, fsApi)), fsApi);
  return inspectOwnedCoreBackup(backup.path, { fsApi, roots });
}

function inspectOwnedCoreBackup(candidatePath, { fsApi = fs, roots } = {}) {
  const backup = inspectCoreBackupDir(candidatePath, { fsApi, roots });
  if (!backup) return null;
  try {
    const markerPath = path.join(backup.path, CORE_BACKUP_OWNER_MARKER);
    const backupStat = fsApi.lstatSync(backup.path);
    const markerStat = fsApi.lstatSync(markerPath);
    if (
      !markerStat.isFile()
      || markerStat.isSymbolicLink()
      || (markerStat.mode & 0o777) !== 0o600
      || markerStat.uid !== backupStat.uid
      || markerStat.gid !== backupStat.gid
      || (typeof process.geteuid === 'function' && backupStat.uid !== process.geteuid())
      || (typeof process.getegid === 'function' && backupStat.gid !== process.getegid())
      || (backupStat.mode & 0o022) !== 0
      || fsApi.realpathSync(markerPath) !== path.join(backup.realPath, CORE_BACKUP_OWNER_MARKER)
    ) return null;
    const marker = readJson(markerPath, fsApi);
    if (!hasValidSignature(marker) || marker.schema !== 'zylos.core-backup-owner/v1') return null;
    const expected = ownerMarkerPayload(backup, marker.proof, fsApi);
    if (JSON.stringify(expected) !== JSON.stringify((({ signature, ...payload }) => payload)(marker))) {
      return null;
    }
    if (!verifyPairSummaryProof(marker.proof, fsApi)) return null;
    return { ...backup, ownership: marker };
  } catch {
    return null;
  }
}

function pathExistsByLstat(targetPath, fsApi = fs) {
  try {
    fsApi.lstatSync(targetPath);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

export function planCoreBackupRetention({
  currentBackupDir,
  retain = CORE_BACKUP_RETAIN,
  fsApi = fs,
  homeDir = os.homedir(),
  tmpDir = os.tmpdir(),
} = {}) {
  if (!Number.isSafeInteger(retain) || retain < CORE_BACKUP_RETAIN || retain > 10) {
    throw new TypeError('Core backup retention must be between 2 and 10');
  }
  const roots = coreBackupRoots({ homeDir, tmpDir });
  const current = currentBackupDir
    ? inspectOwnedCoreBackup(currentBackupDir, { fsApi, roots })
    : null;
  if (!current) {
    return {
      status: 'SKIPPED',
      reason: 'current successful Core backup is missing or not owned by the upgrader',
      retained: [],
      candidates: [],
    };
  }

  const byPath = new Map([[current.path, current]]);
  for (const root of roots) {
    let entries = [];
    try {
      entries = fsApi.readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.name.startsWith(CORE_BACKUP_PREFIX)) continue;
      const inspected = inspectOwnedCoreBackup(path.join(root, entry.name), { fsApi, roots });
      if (inspected) byPath.set(inspected.path, inspected);
    }
  }

  const ordered = [...byPath.values()].sort((left, right) => (
    right.mtimeMs - left.mtimeMs || right.name.localeCompare(left.name)
  ));
  const retained = [current];
  for (const candidate of ordered) {
    if (retained.length >= retain) break;
    if (candidate.path !== current.path) retained.push(candidate);
  }
  const retainedPaths = new Set(retained.map(({ path: backupPath }) => backupPath));
  return {
    status: 'PLANNED',
    retained,
    candidates: ordered
      .filter(candidate => !retainedPaths.has(candidate.path))
      .map(candidate => ({ ...candidate })),
  };
}

function retentionLockPath(homeDir) {
  return path.join(path.resolve(homeDir), '.zylos', 'locks', CORE_BACKUP_RETENTION_LOCK);
}

function acquireCoreBackupRetentionLock(homeDir, fsApi = fs) {
  const lockPath = retentionLockPath(homeDir);
  const lockRoot = path.dirname(lockPath);
  fsApi.mkdirSync(lockRoot, { recursive: true, mode: 0o700 });
  try {
    fsApi.mkdirSync(lockPath, { mode: 0o700 });
  } catch (error) {
    if (error?.code === 'EEXIST') return null;
    throw error;
  }
  const token = crypto.randomBytes(24).toString('hex');
  const ownerPath = path.join(lockPath, 'owner.json');
  try {
    atomicWriteJson(ownerPath, {
      schema: 'zylos.core-backup-retention-lock/v1',
      token,
      pid: process.pid,
      acquiredAt: new Date().toISOString(),
    }, fsApi);
    return { path: lockPath, ownerPath, token };
  } catch (error) {
    try { fsApi.rmSync(lockPath, { recursive: true, force: true }); } catch {}
    throw error;
  }
}

function releaseCoreBackupRetentionLock(lock, fsApi = fs) {
  if (!lock) return;
  const owner = readJson(lock.ownerPath, fsApi);
  if (owner.token !== lock.token || owner.pid !== process.pid) {
    throw new Error('Core backup retention lock ownership changed before release');
  }
  fsApi.rmSync(lock.ownerPath, { force: false });
  fsApi.rmdirSync(lock.path);
  const parentHandle = fsApi.openSync(path.dirname(lock.path), 'r');
  try {
    fsApi.fsyncSync(parentHandle);
  } finally {
    fsApi.closeSync(parentHandle);
  }
}

function randomQuarantineName() {
  return `${CORE_BACKUP_QUARANTINE_PREFIX}${crypto.randomBytes(24).toString('hex')}`;
}

function fsyncDirectory(directoryPath, fsApi = fs) {
  const handle = fsApi.openSync(directoryPath, 'r');
  try {
    fsApi.fsyncSync(handle);
  } finally {
    fsApi.closeSync(handle);
  }
}

function prepareQuarantineGenerations(plan, createdBy) {
  const byRoot = new Map();
  for (const candidate of plan.candidates) {
    let generation = byRoot.get(candidate.rootPath);
    if (!generation) {
      const generationPath = path.join(candidate.rootPath, randomQuarantineName());
      generation = {
        schema: 'zylos.core-backup-quarantine/v1',
        generationId: crypto.randomBytes(24).toString('hex'),
        rootPath: candidate.rootPath,
        rootRealPath: candidate.rootRealPath,
        path: generationPath,
        objectsPath: path.join(generationPath, 'objects'),
        markerPath: path.join(generationPath, 'retention.json'),
        status: 'PLANNED',
        moveIntent: null,
        moved: [],
        items: [],
        createdBy,
        identity: null,
      };
      byRoot.set(candidate.rootPath, generation);
    }
    const quarantinePath = path.join(
      generation.objectsPath,
      crypto.randomBytes(24).toString('hex'),
    );
    const item = { ...candidate, quarantinePath };
    generation.items.push(item);
  }
  return [...byRoot.values()];
}

function quarantineMarker(generation) {
  return signedDocument({
    schema: generation.schema,
    generationId: generation.generationId,
    rootPath: generation.rootPath,
    rootRealPath: generation.rootRealPath,
    path: generation.path,
    objectsPath: generation.objectsPath,
    status: generation.status,
    moveIntent: generation.moveIntent,
    moved: generation.moved,
    items: generation.items,
    createdBy: generation.createdBy,
    identity: generation.identity,
  });
}

function createPrivateQuarantine(generation, fsApi = fs) {
  const rootStat = fsApi.lstatSync(generation.rootPath);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error(`quarantine root is not a direct directory: ${generation.rootPath}`);
  }
  if (fsApi.realpathSync(generation.rootPath) !== generation.rootRealPath) {
    throw new Error(`quarantine root identity changed: ${generation.rootPath}`);
  }
  fsApi.mkdirSync(generation.path, { mode: 0o700 });
  fsApi.chmodSync(generation.path, 0o700);
  fsApi.mkdirSync(generation.objectsPath, { mode: 0o700 });
  fsApi.chmodSync(generation.objectsPath, 0o700);
  const generationStat = fsApi.lstatSync(generation.path);
  const objectsStat = fsApi.lstatSync(generation.objectsPath);
  generation.identity = {
    dev: generationStat.dev,
    ino: generationStat.ino,
    uid: generationStat.uid,
    gid: generationStat.gid,
    mode: generationStat.mode & 0o777,
    objectsDev: objectsStat.dev,
    objectsIno: objectsStat.ino,
    objectsMode: objectsStat.mode & 0o777,
  };
  atomicWriteJson(generation.markerPath, quarantineMarker(generation), fsApi);
  fsyncDirectory(generation.rootPath, fsApi);
}

function inspectQuarantinedBackup(candidatePath, generation, fsApi = fs) {
  try {
    const generationRealPath = fsApi.realpathSync(generation.path);
    const objectsRealPath = fsApi.realpathSync(generation.objectsPath);
    if (path.dirname(objectsRealPath) !== generationRealPath) return null;
    const stat = fsApi.lstatSync(candidatePath);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return null;
    const realCandidate = fsApi.realpathSync(candidatePath);
    if (path.dirname(realCandidate) !== objectsRealPath) return null;
    const corePackagePath = path.join(candidatePath, 'core-package');
    const packagePath = path.join(corePackagePath, 'package.json');
    const skillsPath = path.join(candidatePath, 'skills');
    for (const [entryPath, kind] of [
      [corePackagePath, 'directory'],
      [packagePath, 'file'],
      [skillsPath, 'directory'],
    ]) {
      const entryStat = fsApi.lstatSync(entryPath);
      if (entryStat.isSymbolicLink()) return null;
      if (kind === 'directory' && !entryStat.isDirectory()) return null;
      if (kind === 'file' && !entryStat.isFile()) return null;
      if (fsApi.realpathSync(entryPath) !== path.join(realCandidate, path.relative(candidatePath, entryPath))) {
        return null;
      }
    }
    const pkg = readJson(packagePath, fsApi);
    if (pkg.name !== 'zylos' || !VERSION.test(pkg.version ?? '')) return null;
    return { path: candidatePath, realPath: realCandidate, dev: stat.dev, ino: stat.ino, mtimeMs: stat.mtimeMs };
  } catch {
    return null;
  }
}

function publicGeneration(generation) {
  return {
    generationId: generation.generationId,
    rootPath: generation.rootPath,
    path: generation.path,
    markerPath: generation.markerPath,
    status: generation.status,
    moveIntent: generation.moveIntent,
    moved: generation.moved,
    items: generation.items,
    createdBy: generation.createdBy,
    identity: generation.identity,
  };
}

function inspectQuarantineGeneration(generationPath, { fsApi = fs, rootPath, rootRealPath } = {}) {
  try {
    const resolvedPath = path.resolve(generationPath);
    if (
      path.dirname(resolvedPath) !== rootPath
      || !path.basename(resolvedPath).startsWith(CORE_BACKUP_QUARANTINE_PREFIX)
    ) return null;
    const stat = fsApi.lstatSync(resolvedPath);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o700) return null;
    const realPath = fsApi.realpathSync(resolvedPath);
    if (path.dirname(realPath) !== rootRealPath) return null;
    const objectsPath = path.join(resolvedPath, 'objects');
    const objectsStat = fsApi.lstatSync(objectsPath);
    if (
      !objectsStat.isDirectory()
      || objectsStat.isSymbolicLink()
      || objectsStat.dev !== stat.dev
      || (objectsStat.mode & 0o777) !== 0o700
      || fsApi.realpathSync(objectsPath) !== path.join(realPath, 'objects')
    ) return null;
    const markerPath = path.join(resolvedPath, 'retention.json');
    const markerStat = fsApi.lstatSync(markerPath);
    if (
      !markerStat.isFile()
      || markerStat.isSymbolicLink()
      || markerStat.uid !== stat.uid
      || markerStat.gid !== stat.gid
      || (markerStat.mode & 0o777) !== 0o600
      || fsApi.realpathSync(markerPath) !== path.join(realPath, 'retention.json')
    ) return null;
    const marker = readJson(markerPath, fsApi);
    if (
      !hasValidSignature(marker)
      || marker.schema !== 'zylos.core-backup-quarantine/v1'
      || marker.rootPath !== rootPath
      || marker.rootRealPath !== rootRealPath
      || marker.path !== resolvedPath
      || marker.objectsPath !== objectsPath
      || marker.status !== 'GC_PENDING'
      || marker.moveIntent !== null
      || !verifyPairSummaryProof(marker.createdBy, fsApi)
      || marker.identity?.dev !== stat.dev
      || marker.identity?.ino !== stat.ino
      || marker.identity?.uid !== stat.uid
      || marker.identity?.gid !== stat.gid
      || marker.identity?.mode !== (stat.mode & 0o777)
      || marker.identity?.objectsDev !== objectsStat.dev
      || marker.identity?.objectsIno !== objectsStat.ino
      || marker.identity?.objectsMode !== (objectsStat.mode & 0o777)
    ) return null;
    for (const moved of marker.moved ?? []) {
      const inspected = inspectQuarantinedBackup(moved.quarantinePath, {
        path: resolvedPath,
        objectsPath,
      }, fsApi);
      if (!inspected || inspected.dev !== moved.dev || inspected.ino !== moved.ino) return null;
    }
    return { path: resolvedPath, realPath, stat, marker, markerPath };
  } catch {
    return null;
  }
}

function assertSafeRecursiveTree(targetPath, expectedDev, fsApi = fs) {
  const pending = [targetPath];
  while (pending.length > 0) {
    const entryPath = pending.pop();
    const entryStat = fsApi.lstatSync(entryPath);
    if (entryStat.isSymbolicLink()) throw new Error(`refusing symlink in retired quarantine: ${entryPath}`);
    if (entryStat.dev !== expectedDev) throw new Error(`refusing cross-device mount in retired quarantine: ${entryPath}`);
    if (!entryStat.isDirectory()) continue;
    for (const name of fsApi.readdirSync(entryPath)) pending.push(path.join(entryPath, name));
  }
}

function gcPriorQuarantines({ roots, currentProof, fsApi = fs, persistProgress = () => {} }) {
  const removed = [];
  const residual = [];
  const current = [];
  for (const rootPath of roots) {
    let rootStat;
    let rootRealPath;
    let entries;
    try {
      rootStat = fsApi.lstatSync(rootPath);
      rootRealPath = fsApi.realpathSync(rootPath);
      entries = fsApi.readdirSync(rootPath, { withFileTypes: true });
    } catch {
      continue;
    }
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) continue;
    for (const entry of entries) {
      if (!entry.name.startsWith(CORE_BACKUP_QUARANTINE_PREFIX)) continue;
      const generationPath = path.join(rootPath, entry.name);
      const generation = inspectQuarantineGeneration(generationPath, { fsApi, rootPath, rootRealPath });
      if (!generation) {
        residual.push({ path: generationPath, reason: 'unverified quarantine generation; fail closed' });
        continue;
      }
      const creator = generation.marker.createdBy;
      if (creator.summaryPath === currentProof.summaryPath) {
        current.push(generation);
        continue;
      }
      if (Date.parse(currentProof.startedAt) <= Date.parse(creator.finishedAt)) {
        residual.push({ path: generationPath, reason: 'no later successful pair upgrade proves GC eligibility' });
        continue;
      }
      try {
        persistProgress({
          status: 'GC_PLANNED',
          generation: generation.path,
          identity: { dev: generation.stat.dev, ino: generation.stat.ino },
        });
        assertSafeRecursiveTree(generation.path, generation.stat.dev, fsApi);
        const rechecked = inspectQuarantineGeneration(generation.path, { fsApi, rootPath, rootRealPath });
        if (!rechecked || rechecked.stat.dev !== generation.stat.dev || rechecked.stat.ino !== generation.stat.ino) {
          throw new Error('quarantine generation identity changed before GC');
        }
        fsApi.rmSync(generation.path, { recursive: true, force: false });
        const rootHandle = fsApi.openSync(rootPath, 'r');
        try { fsApi.fsyncSync(rootHandle); } finally { fsApi.closeSync(rootHandle); }
        removed.push(...generation.marker.moved.map(item => ({ ...item, generationPath: generation.path })));
      } catch (error) {
        residual.push({ path: generation.path, reason: error.message });
      }
    }
  }
  return { removed, residual, current };
}

function applyCoreBackupRetention(plan, {
  fsApi = fs,
  persistProgress = () => {},
  currentProof,
  roots = [],
} = {}) {
  if (plan?.status !== 'PLANNED') {
    return { ...plan, removed: [], quarantined: [], skipped: [], generations: [] };
  }
  const retainedPaths = new Set(plan.retained.map(({ path: backupPath }) => backupPath));
  const candidateRoots = [...new Set(plan.retained.concat(plan.candidates).map(({ path: backupPath }) => (
    path.dirname(backupPath)
  )))];
  const gc = gcPriorQuarantines({ roots, currentProof, fsApi, persistProgress });
  if (gc.residual.length > 0 || gc.current.length > 0) {
    return {
      status: gc.residual.length > 0 ? 'WARN' : 'GC_PENDING',
      retained: plan.retained,
      candidates: plan.candidates,
      removed: gc.removed,
      quarantined: [],
      skipped: gc.residual,
      generations: gc.current.map(item => item.marker),
    };
  }
  const generations = prepareQuarantineGenerations(plan, currentProof);
  const quarantined = [];
  const skipped = [];
  for (const generation of generations) {
    try {
      createPrivateQuarantine(generation, fsApi);
      persistProgress({
        status: 'PLANNED',
        retained: plan.retained,
        candidates: plan.candidates,
        removed: gc.removed,
        quarantined,
        skipped,
        generations: generations.map(publicGeneration),
      });
    } catch (error) {
      skipped.push(...generation.items.map(candidate => ({ ...candidate, reason: error.message })));
      continue;
    }

    for (const candidate of generation.items) {
      const inspected = inspectOwnedCoreBackup(candidate.path, { fsApi, roots: candidateRoots });
      if (
        !inspected
        || retainedPaths.has(inspected.path)
        || inspected.realPath !== candidate.realPath
        || inspected.rootRealPath !== candidate.rootRealPath
        || inspected.name !== candidate.name
        || inspected.dev !== candidate.dev
        || inspected.ino !== candidate.ino
        || inspected.mtimeMs !== candidate.mtimeMs
      ) {
        skipped.push({ ...candidate, reason: 'backup changed after retention planning' });
        continue;
      }
      try {
        generation.moveIntent = {
          sourcePath: candidate.path,
          quarantinePath: candidate.quarantinePath,
          dev: candidate.dev,
          ino: candidate.ino,
        };
        atomicWriteJson(generation.markerPath, quarantineMarker(generation), fsApi);
        persistProgress({
          status: 'PLANNED',
          retained: plan.retained,
          candidates: plan.candidates,
          removed: gc.removed,
          quarantined,
          skipped,
          generations: generations.map(publicGeneration),
        });
        if (pathExistsByLstat(candidate.quarantinePath, fsApi)) {
          throw new Error('random quarantine destination already exists');
        }
        fsApi.renameSync(inspected.path, candidate.quarantinePath);
        fsyncDirectory(candidate.rootPath, fsApi);
        fsyncDirectory(generation.objectsPath, fsApi);
        const moved = inspectQuarantinedBackup(candidate.quarantinePath, generation, fsApi);
        if (
          !moved
          || moved.dev !== candidate.dev
          || moved.ino !== candidate.ino
          || moved.mtimeMs !== candidate.mtimeMs
        ) {
          throw new Error('quarantined backup identity changed after rename');
        }
        const movedRecord = { ...candidate, quarantinedAt: new Date().toISOString() };
        quarantined.push(movedRecord);
        generation.moved.push(movedRecord);
        generation.moveIntent = null;
        generation.status = 'GC_PENDING';
        atomicWriteJson(generation.markerPath, quarantineMarker(generation), fsApi);
        persistProgress({
          status: 'GC_PENDING',
          retained: plan.retained,
          candidates: plan.candidates,
          removed: gc.removed,
          quarantined,
          skipped,
          generations: generations.map(publicGeneration),
        });
      } catch (error) {
        skipped.push({ ...candidate, reason: error.message });
      }
    }
  }
  return {
    status: skipped.length > 0 ? 'WARN' : quarantined.length > 0 ? 'GC_PENDING' : 'PASS',
    retained: plan.retained,
    candidates: plan.candidates,
    removed: gc.removed,
    quarantined,
    skipped,
    generations: generations.map(publicGeneration),
  };
}

export function executeCoreBackupRetention({
  currentBackupDir,
  retain = CORE_BACKUP_RETAIN,
  fsApi = fs,
  homeDir = os.homedir(),
  tmpDir = os.tmpdir(),
  summary,
  summaryPath,
} = {}) {
  if (!summary || typeof summary !== 'object' || !summaryPath) {
    throw new TypeError('Core backup retention requires a summary audit destination');
  }
  const lock = acquireCoreBackupRetentionLock(homeDir, fsApi);
  if (!lock) {
    const result = {
      status: 'WARN',
      reason: 'Core backup retention is locked by another run',
      retained: [],
      candidates: [],
      removed: [],
      quarantined: [],
      skipped: [],
      generations: [],
    };
    summary.backupRetention = result;
    atomicWriteJson(summaryPath, summary, fsApi);
    return result;
  }
  try {
    atomicWriteJson(summaryPath, summary, fsApi);
    const roots = coreBackupRoots({ homeDir, tmpDir });
    const currentProof = pairSummaryProof(summary, summaryPath);
    if (!claimCurrentBackupOwnership(currentBackupDir, summary, summaryPath, { fsApi, roots })) {
      const result = {
        status: 'SKIPPED',
        reason: 'current Core backup is not bound to this successful pair summary',
        retained: [],
        candidates: [],
        removed: [],
        quarantined: [],
        skipped: [],
        generations: [],
      };
      summary.backupRetention = result;
      atomicWriteJson(summaryPath, summary, fsApi);
      return result;
    }
    const plan = planCoreBackupRetention({
      currentBackupDir,
      retain,
      fsApi,
      homeDir,
      tmpDir,
    });
    summary.backupRetention = {
      ...plan,
      removed: [],
      quarantined: [],
      skipped: [],
      generations: [],
    };
    atomicWriteJson(summaryPath, summary, fsApi);
    const result = applyCoreBackupRetention(plan, {
      fsApi,
      currentProof,
      roots,
      persistProgress: (progress) => {
        summary.backupRetention = progress.status === 'GC_PLANNED'
          ? { ...summary.backupRetention, gcIntent: progress }
          : progress;
        atomicWriteJson(summaryPath, summary, fsApi);
      },
    });
    summary.backupRetention = result;
    atomicWriteJson(summaryPath, summary, fsApi);
    return result;
  } finally {
    releaseCoreBackupRetentionLock(lock, fsApi);
  }
}

function stageImmutableArchive(repo, sha, destination) {
  const archivePath = path.join(path.dirname(destination), `${path.basename(destination)}.tar.gz`);
  fs.mkdirSync(destination, { recursive: true });
  requireSuccess(run('curl', [
    '-fsSL', '--retry', '2', '--retry-all-errors',
    '--output', archivePath,
    `https://github.com/${repo}/archive/${sha}.tar.gz`,
  ], { timeout: 120_000 }), `download ${repo}@${sha} failed`);
  requireSuccess(run('tar', [
    'xzf', archivePath, '-C', destination, '--strip-components=1',
  ], { timeout: 120_000 }), `extract ${repo}@${sha} failed`);
  return archivePath;
}

function commandEvidence(result) {
  return {
    status: result.status,
    signal: result.signal,
    error: result.error,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

function verifyUpgradeResult(result, label) {
  requireSuccess(result, `${label} process failed`, 'UPGRADE_FAILED');
  const payload = parseJsonOutput(result.stdout);
  if (!payload || payload.success !== true) {
    throw new HoldError(
      `${label} reported failure: ${payload?.error || 'invalid JSON result'}`,
      'UPGRADE_FAILED',
    );
  }
  return payload;
}

function runCommunicationCanary(installedCoreDir, zylosDir) {
  const moduleUrl = pathToFileURL(path.join(
    installedCoreDir,
    'cli',
    'lib',
    'communication-continuity.js',
  )).href;
  const skillsDir = path.join(zylosDir, '.claude', 'skills', 'comm-bridge', 'scripts');
  const expression = [
    `import { verifyCommunicationContinuity } from ${JSON.stringify(moduleUrl)};`,
    `const result = verifyCommunicationContinuity({`,
    `c4SendPath:${JSON.stringify(path.join(skillsDir, 'c4-send.js'))},`,
    `c4ReceivePath:${JSON.stringify(path.join(skillsDir, 'c4-receive.js'))},`,
    `c4DbPath:${JSON.stringify(path.join(skillsDir, 'c4-db.js'))},`,
    `zylosDir:${JSON.stringify(zylosDir)}});`,
    `process.stdout.write(JSON.stringify(result));`,
    `if (!result.compatible) process.exitCode = 1;`,
  ].join('');
  const result = requireSuccess(run(process.execPath, [
    '--input-type=module', '--eval', expression,
  ], { timeout: 30_000 }), 'communication canary failed', 'POSTCHECK_FAILED');
  const payload = parseJsonOutput(result.stdout);
  if (!payload?.compatible) throw new HoldError('communication canary returned invalid result');
  return payload;
}

function runNativeTaskConservationGate({
  coreDir,
  feishuDir,
  zylosDir,
  requestedAgent,
  reportPath,
}) {
  const envPath = path.join(zylosDir, '.env');
  const configured = {
    requestedAgent,
    agentId: persistedEnvValue(envPath, 'ZYLOS_AGENT_ID'),
    defaultAssigneeId: persistedEnvValue(envPath, 'C4_WORK_INTAKE_DEFAULT_ASSIGNEE_ID'),
    appId: persistedEnvValue(envPath, 'FEISHU_APP_ID'),
    agentAppIds: persistedEnvValue(envPath, 'FEISHU_TASK_V2_AGENT_APP_IDS'),
  };
  const identity = validateNativeTaskDeploymentIdentity(configured);
  if (!identity.ok) {
    throw new HoldError(
      `native task deployment identity is invalid: ${identity.error}`,
      'NATIVE_TASK_CONSERVATION_FAILED',
    );
  }
  const command = buildNativeTaskConservationCommand({
    nodePath: process.execPath,
    coreDir,
    feishuDir,
  });
  const gateEnv = {
    ...process.env,
    ZYLOS_DIR: zylosDir,
    ZYLOS_AGENT_ID: identity.identity.agentId,
    FEISHU_APP_ID: identity.identity.appId,
    FEISHU_TASK_V2_AGENT_APP_IDS: configured.agentAppIds,
    ...(configured.defaultAssigneeId
      ? { C4_WORK_INTAKE_DEFAULT_ASSIGNEE_ID: configured.defaultAssigneeId }
      : {}),
  };
  const gateRun = run(command.command, command.args, {
    env: gateEnv,
    cwd: feishuDir,
    timeout: 120_000,
  });
  const report = parseJsonOutput(gateRun.status === 2 ? gateRun.stderr : gateRun.stdout) ?? {
    schema: 'zylos.native-task-conservation-gate/error-v1',
    passed: false,
    failureCodes: ['INVALID_GATE_OUTPUT'],
    error: {
      message: gateRun.error
        || gateRun.stderr.trim()
        || gateRun.stdout.trim()
        || `gate exited ${gateRun.status}`,
    },
  };
  atomicWriteJson(reportPath, report);
  if (gateRun.status !== 0 || gateRun.error) {
    throw new HoldError(
      `native task conservation failed: ${(report.failureCodes || ['GATE_RUNTIME_ERROR']).join(', ')}`,
      'NATIVE_TASK_CONSERVATION_FAILED',
    );
  }
  if (
    report.schema !== 'zylos.native-task-conservation-gate/v1'
    || report.passed !== true
    || report.deployment?.agentId !== identity.identity.agentId
    || report.deployment?.appId !== identity.identity.appId
    || report.inventory?.core?.schema !== 'zylos.native-task-core-inventory/v1'
    || report.inventory?.core?.snapshot?.stable !== true
    || report.inventory?.core?.identity?.agentId !== identity.identity.agentId
    || report.inventory?.remote?.identity?.kind !== 'app'
    || report.inventory?.remote?.identity?.appId !== identity.identity.appId
  ) {
    throw new HoldError(
      'native task conservation returned an invalid or mismatched PASS report',
      'NATIVE_TASK_CONSERVATION_FAILED',
    );
  }
  return report;
}

function makeReportDir(zylosDir, explicitRoot) {
  const root = explicitRoot
    ? path.resolve(explicitRoot)
    : path.join(zylosDir, '.zylos', 'upgrade-reports');
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const reportDir = path.join(root, `fork-pair-${timestamp}`);
  fs.mkdirSync(reportDir, { recursive: true });
  return reportDir;
}

export function runForkPairUpgrade(argv = process.argv.slice(2)) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (error) {
    const output = { status: 'HOLD', code: error.code || 'INVALID_ARGS', error: error.message };
    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
    return 1;
  }

  const targetCheck = validatePinnedTarget(args);
  if (!targetCheck.ok) {
    process.stdout.write(`${JSON.stringify({
      status: 'HOLD',
      code: 'INVALID_TARGET',
      error: targetCheck.error,
    }, null, 2)}\n`);
    return 1;
  }

  const zylosDir = path.resolve(process.env.ZYLOS_DIR || path.join(os.homedir(), 'zylos'));
  const reportDir = makeReportDir(zylosDir, args.reportRoot);
  const summaryPath = path.join(reportDir, 'summary.json');
  const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-fork-pair-upgrade-'));
  const summary = {
    schema: 'zylos.fork-pair-upgrade/v1',
    status: 'RUNNING',
    mode: args.execute ? 'execute' : 'dry-run',
    agent: args.agent,
    startedAt: new Date().toISOString(),
    target: {
      core: { repo: CORE_REPO, sha: args.coreSha, version: args.coreVersion },
      feishu: { repo: FEISHU_REPO, sha: args.feishuSha, version: args.feishuVersion },
    },
    reportDir,
    coreUpgraded: false,
    feishuUpgraded: false,
  };
  atomicWriteJson(summaryPath, summary);

  try {
    const stagedCoreDir = path.resolve(args.stagedCoreDir);
    const coreSource = validateCoreSource(stagedCoreDir, args.coreVersion);
    if (!coreSource.ok) throw new HoldError(coreSource.error, 'INVALID_CORE_SOURCE');

    const stagedFeishuDir = path.join(scratchDir, 'feishu');
    stageImmutableArchive(FEISHU_REPO, args.feishuSha, stagedFeishuDir);
    const feishuSource = validateFeishuSource(stagedFeishuDir, args.feishuVersion);
    if (!feishuSource.ok) throw new HoldError(feishuSource.error, 'INVALID_FEISHU_SOURCE');
    const liveFeishuDir = path.join(zylosDir, '.claude', 'skills', 'feishu');
    const liveFeishuNodeModules = path.join(liveFeishuDir, 'node_modules');
    try {
      if (!fs.statSync(liveFeishuNodeModules).isDirectory()) throw new Error('not a directory');
      fs.symlinkSync(liveFeishuNodeModules, path.join(stagedFeishuDir, 'node_modules'), 'dir');
    } catch (error) {
      throw new HoldError(
        `target Feishu preflight cannot reuse live runtime dependencies: ${error.message}`,
        'INVALID_FEISHU_SOURCE',
      );
    }

    const envPath = path.join(zylosDir, '.env');
    const persistedCoreRepo = persistedEnvValue(envPath, 'ZYLOS_SELF_UPGRADE_REPO');
    if (persistedCoreRepo !== CORE_REPO) {
      throw new HoldError(
        `persisted ZYLOS_SELF_UPGRADE_REPO must be ${CORE_REPO}, found ${persistedCoreRepo ?? 'missing'}`,
        'FORK_ROUTING_INVALID',
      );
    }
    const componentsPath = path.join(zylosDir, '.zylos', 'components.json');
    const components = readJson(componentsPath);
    if (components.feishu?.repo !== FEISHU_REPO) {
      throw new HoldError(
        `Feishu component repo must be ${FEISHU_REPO}, found ${components.feishu?.repo ?? 'missing'}`,
        'FORK_ROUTING_INVALID',
      );
    }

    const liveReceive = path.join(
      zylosDir,
      '.claude',
      'skills',
      'comm-bridge',
      'scripts',
      'c4-receive.js',
    );
    if (!fileIsRegular(liveReceive)) {
      throw new HoldError(`live receive entrypoint missing before upgrade: ${liveReceive}`);
    }

    const diskAvailableKb = availableDiskKb(zylosDir);
    if (diskAvailableKb < MIN_AVAILABLE_KB) {
      throw new HoldError(
        `available disk ${diskAvailableKb} KiB is below required ${MIN_AVAILABLE_KB} KiB`,
        'DISK_LOW',
      );
    }
    let beforePm2 = pm2Snapshot();
    const plannedPm2Repairs = planPm2PreflightRepairs(beforePm2, {
      zylosDir,
      stagedCoreDir,
    });
    const repairNames = new Set(plannedPm2Repairs.map((repair) => repair.name));
    const beforePm2Errors = validatePm2Snapshot(
      beforePm2.filter((proc) => !repairNames.has(proc.name)),
    );
    if (beforePm2Errors.length > 0) throw new HoldError(beforePm2Errors.join('; '));

    if (plannedPm2Repairs.length > 0 && args.execute) {
      const applied = applyPm2PreflightRepairs(plannedPm2Repairs);
      beforePm2 = pm2Snapshot();
      const repairVerificationErrors = validatePm2Snapshot(beforePm2);
      for (const repair of plannedPm2Repairs) {
        if (beforePm2.some((proc) => proc.name === repair.name)) {
          repairVerificationErrors.push(`${repair.name} still exists after rollback-orphan repair`);
        }
      }
      if (repairVerificationErrors.length > 0) {
        throw new HoldError(
          repairVerificationErrors.join('; '),
          'PREFLIGHT_REPAIR_FAILED',
        );
      }
      summary.preflightRepairs = { status: 'PASS', applied };
    } else {
      summary.preflightRepairs = {
        status: plannedPm2Repairs.length > 0 ? 'WOULD_APPLY' : 'NOT_REQUIRED',
        planned: plannedPm2Repairs,
      };
    }

    const nativeTaskConservation = runNativeTaskConservationGate({
      coreDir: stagedCoreDir,
      feishuDir: stagedFeishuDir,
      zylosDir,
      requestedAgent: args.agent,
      reportPath: path.join(reportDir, 'native-task-conservation-preflight.json'),
    });

    summary.preflight = {
      status: 'PASS',
      diskAvailableKb,
      coreSourceVersion: coreSource.package.version,
      feishuSourceVersion: feishuSource.package.version,
      persistedCoreRepo,
      persistedFeishuRepo: components.feishu.repo,
      hashes: {
        env: hashFile(envPath),
        components: hashFile(componentsPath),
        feishuConfig: hashFile(path.join(zylosDir, 'components', 'feishu', 'config.json')),
        c4Database: hashFile(path.join(zylosDir, 'comm-bridge', 'c4.db')),
      },
      pm2: beforePm2,
      nativeTaskConservation,
    };
    atomicWriteJson(summaryPath, summary);

    if (args.dryRun) {
      summary.status = 'PASS';
      summary.result = 'PRECHECK_ONLY';
      summary.finishedAt = new Date().toISOString();
      atomicWriteJson(summaryPath, summary);
      process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
      return 0;
    }

    requireSuccess(run('npm', [
      'install', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund',
    ], {
      cwd: stagedCoreDir,
      timeout: 300_000,
    }), 'staged Core dependency install failed');

    const npmRootResult = requireSuccess(run('npm', ['root', '-g']), 'global npm root lookup failed');
    const installedCoreDir = path.join(npmRootResult.stdout.trim(), 'zylos');
    const commands = buildUpgradeCommands({
      nodePath: process.execPath,
      stagedCoreDir,
      installedCoreDir,
      coreSha: args.coreSha,
      feishuSha: args.feishuSha,
    });
    const upgradeEnv = {
      ...process.env,
      ZYLOS_DIR: zylosDir,
      ZYLOS_SELF_UPGRADE_REPO: CORE_REPO,
    };

    const coreResult = run(commands.core.command, commands.core.args, {
      env: upgradeEnv,
      timeout: 1_200_000,
    });
    fs.writeFileSync(
      path.join(reportDir, 'core-upgrade.json'),
      `${JSON.stringify(commandEvidence(coreResult), null, 2)}\n`,
      { mode: 0o600 },
    );
    summary.coreResult = verifyUpgradeResult(coreResult, 'Core upgrade');
    summary.coreUpgraded = true;
    atomicWriteJson(summaryPath, summary);

    const installedCore = validateCoreSource(installedCoreDir, args.coreVersion);
    if (!installedCore.ok) {
      throw new HoldError(installedCore.error, 'POSTCHECK_FAILED');
    }

    const feishuResult = run(commands.feishu.command, commands.feishu.args, {
      env: upgradeEnv,
      timeout: 1_200_000,
    });
    fs.writeFileSync(
      path.join(reportDir, 'feishu-upgrade.json'),
      `${JSON.stringify(commandEvidence(feishuResult), null, 2)}\n`,
      { mode: 0o600 },
    );
    summary.feishuResult = verifyUpgradeResult(feishuResult, 'Feishu upgrade');
    summary.feishuUpgraded = true;
    atomicWriteJson(summaryPath, summary);

    const liveFeishu = validateFeishuSource(liveFeishuDir, args.feishuVersion);
    if (!liveFeishu.ok) throw new HoldError(liveFeishu.error, 'POSTCHECK_FAILED');

    const afterPm2 = pm2Snapshot();
    const afterPm2Errors = validatePm2Snapshot(afterPm2, { requireSupervisor: true });
    if (afterPm2Errors.length > 0) {
      throw new HoldError(afterPm2Errors.join('; '), 'POSTCHECK_FAILED');
    }
    const communication = runCommunicationCanary(installedCoreDir, zylosDir);
    const nativeTaskConservationPostcheck = runNativeTaskConservationGate({
      coreDir: installedCoreDir,
      feishuDir: liveFeishuDir,
      zylosDir,
      requestedAgent: args.agent,
      reportPath: path.join(reportDir, 'native-task-conservation.json'),
    });

    summary.postcheck = {
      status: 'PASS',
      coreVersion: installedCore.package.version,
      feishuVersion: liveFeishu.package.version,
      communication,
      nativeTaskConservation: nativeTaskConservationPostcheck,
      hashes: {
        env: hashFile(envPath),
        components: hashFile(componentsPath),
        feishuConfig: hashFile(path.join(zylosDir, 'components', 'feishu', 'config.json')),
        c4Database: hashFile(path.join(zylosDir, 'comm-bridge', 'c4.db')),
      },
      pm2: afterPm2,
    };
    summary.status = 'PASS';
    summary.result = 'UPGRADE_COMPLETE';
    summary.finishedAt = new Date().toISOString();
    atomicWriteJson(summaryPath, summary);
    try {
      executeCoreBackupRetention({
        currentBackupDir: summary.coreResult.backupDir,
        summary,
        summaryPath,
      });
    } catch (error) {
      summary.backupRetention = {
        status: 'WARN',
        retained: [],
        removed: [],
        skipped: [],
        error: error.message,
      };
    }
    atomicWriteJson(summaryPath, summary);
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    return 0;
  } catch (error) {
    summary.status = 'HOLD';
    summary.code = error.code || 'UNEXPECTED_ERROR';
    summary.error = error.message;
    summary.result = summary.coreUpgraded && summary.feishuUpgraded
      ? 'UPGRADED_UNVERIFIED'
      : summary.coreUpgraded
        ? 'CORE_UPGRADED_FEISHU_ROLLED_BACK_OR_UNCHANGED'
        : 'NO_VERIFIED_PAIR_UPGRADE';
    summary.finishedAt = new Date().toISOString();
    atomicWriteJson(summaryPath, summary);
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    return 1;
  } finally {
    fs.rmSync(scratchDir, { recursive: true, force: true });
  }
}

const isMain = pathsReferToSameFile(process.argv[1], fileURLToPath(import.meta.url));
if (isMain) process.exitCode = runForkPairUpgrade();
