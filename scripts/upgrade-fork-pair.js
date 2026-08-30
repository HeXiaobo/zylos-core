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
  'skills/comm-bridge/scripts/c4-outbound-policy.js',
  'skills/comm-bridge/scripts/c4-receive.js',
  'skills/comm-bridge/scripts/c4-dispatcher.js',
  'skills/comm-bridge/scripts/c4-response-stream-supervisor.js',
  'skills/activity-monitor/scripts/assistant-turn-binding.js',
  'scripts/upgrade-fork-pair.js',
  'scripts/upgrade-fork-pair.sh',
  'scripts/native-task-convergence.js',
  'scripts/native-task-convergence-runner.js',
  'cli/lib/native-task-conservation-inventory.js',
  'skills/commitment-core/scripts/legacy-task-adoption.js',
]);

const FEISHU_ASSETS = Object.freeze([
  'src/index.js',
  'hooks/pre-upgrade.js',
  'hooks/post-upgrade.js',
  'scripts/native-task-closure-gate.js',
  'scripts/native-task-completion-gate.js',
  'scripts/native-task-conservation-gate.js',
  'scripts/task-v2-legacy-adoption-bootstrap.js',
  'src/lib/native-task-conservation-gate.js',
  'src/lib/native-task-conservation-remote.js',
  'src/lib/task-v2-legacy-adoption-bootstrap.js',
  'src/lib/task-v2-deployment-identity.js',
  'src/lib/task-v2-projection-worker.js',
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
  const mappingMissing = agentAppIds === undefined || agentAppIds === null || agentAppIds === '';
  if (mappingMissing) {
    mappings = { [deploymentAgentId]: normalizedAppId };
  } else {
    try {
      mappings = typeof agentAppIds === 'string' ? JSON.parse(agentAppIds) : agentAppIds;
    } catch (error) {
      return { ok: false, error: `FEISHU_TASK_V2_AGENT_APP_IDS is invalid JSON: ${error.message}` };
    }
    if (!mappings || typeof mappings !== 'object' || Array.isArray(mappings)) {
      return { ok: false, error: 'FEISHU_TASK_V2_AGENT_APP_IDS must be an object' };
    }
  }
  if (String(mappings[deploymentAgentId] || '').trim() !== normalizedAppId) {
    return {
      ok: false,
      error: `FEISHU_TASK_V2_AGENT_APP_IDS must map ${deploymentAgentId} to FEISHU_APP_ID`,
    };
  }
  return {
    ok: true,
    identity: Object.freeze({
      agentId: deploymentAgentId,
      appId: normalizedAppId,
      mappingSource: mappingMissing ? 'derived-single-agent' : 'explicit',
    }),
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

export function buildNativeTaskConvergenceCommand({
  nodePath,
  coreDir,
  feishuDir,
  coreManifest,
  feishuManifest,
  reportDir,
  apply = false,
  authorization,
  resume = false,
  transactionId,
  coreSource,
  feishuSource,
}) {
  const sourceArgs = (prefix, source) => source
    ? [
      `--${prefix}-source-repo`, source.repo,
      `--${prefix}-source-commit`, source.commit,
      `--${prefix}-source-version`, source.version,
    ]
    : [];
  return {
    command: nodePath,
    args: [
      path.join(coreDir, 'scripts', 'native-task-convergence.js'),
      apply ? '--apply' : '--plan',
      ...(resume ? ['--resume'] : []),
      '--core-manifest', path.resolve(coreManifest),
      '--feishu-manifest', path.resolve(feishuManifest),
      '--core-dir', coreDir,
      '--feishu-dir', feishuDir,
      '--report-dir', reportDir,
      ...(apply && authorization ? ['--authorization', authorization] : []),
      ...(transactionId ? ['--transaction-id', transactionId] : []),
      ...sourceArgs('core', coreSource),
      ...sourceArgs('feishu', feishuSource),
    ],
  };
}

export function parseForkPairArgs(argv) {
  const result = {
    execute: false,
    dryRun: false,
    repairOnly: false,
    resume: false,
    agent: 'unknown',
  };
  const valueFlags = new Map([
    ['--core-sha', 'coreSha'],
    ['--feishu-sha', 'feishuSha'],
    ['--core-version', 'coreVersion'],
    ['--feishu-version', 'feishuVersion'],
    ['--staged-core', 'stagedCoreDir'],
    ['--agent', 'agent'],
    ['--report-root', 'reportRoot'],
    ['--report-dir', 'reportDir'],
    ['--native-task-core-manifest', 'nativeTaskCoreManifest'],
    ['--native-task-feishu-manifest', 'nativeTaskFeishuManifest'],
    ['--native-task-repair-authorization', 'nativeTaskRepairAuthorization'],
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
    if (arg === '--repair-only') {
      result.repairOnly = true;
      continue;
    }
    if (arg === '--resume') {
      if (result.resume) throw new HoldError('duplicate option: --resume', 'INVALID_ARGS');
      result.resume = true;
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

  if ([result.execute, result.dryRun, result.repairOnly].filter(Boolean).length !== 1) {
    throw new HoldError(
      'choose exactly one of --execute, --dry-run, or --repair-only',
      'INVALID_ARGS',
    );
  }
  if (!result.stagedCoreDir) {
    throw new HoldError('--staged-core is required; use the immutable bootstrap', 'INVALID_ARGS');
  }
  const hasCoreManifest = Boolean(result.nativeTaskCoreManifest);
  const hasFeishuManifest = Boolean(result.nativeTaskFeishuManifest);
  if (hasCoreManifest !== hasFeishuManifest) {
    throw new HoldError(
      '--native-task-core-manifest and --native-task-feishu-manifest must be provided together',
      'INVALID_ARGS',
    );
  }
  if (result.nativeTaskRepairAuthorization && !hasCoreManifest) {
    throw new HoldError(
      '--native-task-repair-authorization requires both convergence manifests',
      'INVALID_ARGS',
    );
  }
  if ((result.execute || result.repairOnly) && hasCoreManifest && !result.nativeTaskRepairAuthorization) {
    throw new HoldError(
      'native Task convergence during execute requires --native-task-repair-authorization',
      'REPAIR_NOT_AUTHORIZED',
    );
  }
  if (result.dryRun && result.nativeTaskRepairAuthorization) {
    throw new HoldError(
      '--native-task-repair-authorization is valid only with --execute',
      'INVALID_ARGS',
    );
  }
  if (result.repairOnly && !hasCoreManifest) {
    throw new HoldError(
      '--repair-only requires both native Task convergence manifests',
      'INVALID_ARGS',
    );
  }
  if (result.resume && !result.reportDir) {
    throw new HoldError('--resume requires --report-dir so the same transaction can be reopened', 'INVALID_ARGS');
  }
  if (result.resume && result.dryRun) {
    throw new HoldError('--resume is valid only for an apply or repair-only transaction', 'INVALID_ARGS');
  }
  if (result.reportDir && result.reportRoot) {
    throw new HoldError('--report-dir cannot be combined with --report-root', 'INVALID_ARGS');
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

function commandIdentity(command) {
  const value = { command: command.command, args: [...command.args] };
  return { ...value, sha256: sha256(JSON.stringify(value)) };
}

function resumeNeutralCommandIdentity(command) {
  return commandIdentity({
    command: command.command,
    args: command.args.filter(argument => argument !== '--resume'),
  });
}

function commandIdentityMatches(identity, command) {
  if (!identity || identity.command !== command.command || !Array.isArray(identity.args)) return false;
  const expected = resumeNeutralCommandIdentity(command);
  return identity.sha256 === expected.sha256
    && identity.sha256 === sha256(JSON.stringify({ command: identity.command, args: identity.args }));
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

function sourceTreeSha256(root) {
  const hash = crypto.createHash('sha256');
  const visit = (current, relative = '') => {
    const entries = fs.readdirSync(current, { withFileTypes: true })
      .filter(entry => entry.name !== 'node_modules' && entry.name !== '.git')
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const child = path.join(current, entry.name);
      const childRelative = path.join(relative, entry.name).split(path.sep).join('/');
      const stat = fs.lstatSync(child);
      if (stat.isSymbolicLink()) {
        hash.update(`symlink\0${childRelative}\0${fs.readlinkSync(child)}\n`);
      } else if (stat.isDirectory()) {
        hash.update(`dir\0${childRelative}\0${stat.mode & 0o7777}\n`);
        visit(child, childRelative);
      } else if (stat.isFile()) {
        hash.update(`file\0${childRelative}\0${stat.size}\0${stat.mode & 0o7777}\n`);
        hash.update(fs.readFileSync(child));
      }
    }
  };
  visit(root);
  return hash.digest('hex');
}

function buildSourceIdentity(root, { repo, sha, version }) {
  const dir = path.resolve(root);
  let realPath;
  try {
    realPath = fs.realpathSync(dir);
  } catch (error) {
    throw new HoldError(`source directory is not readable: ${dir}`, 'INVALID_SOURCE_IDENTITY');
  }
  return {
    dir,
    realPath,
    repo,
    commit: sha,
    version,
    packageSha256: hashFile(path.join(dir, 'package.json')),
    treeSha256: sourceTreeSha256(dir),
  };
}

function sourceIdentityMatches(expected, actual) {
  return Boolean(expected && actual)
    && ['dir', 'realPath', 'repo', 'commit', 'version', 'packageSha256', 'treeSha256']
      .every(field => expected[field] === actual[field]);
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

const CORE_BACKUP_RETENTION_REPAIR_AUDIT_SCHEMA = 'zylos.core-backup-retention-repair/v1';

function pathIsWithin(rootPath, candidatePath) {
  const root = path.resolve(rootPath);
  const candidate = path.resolve(candidatePath);
  const relative = path.relative(root, candidate);
  return relative === ''
    || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}

function repairStatIdentity(stat, { includeTimes = false } = {}) {
  return {
    dev: stat.dev,
    ino: stat.ino,
    uid: stat.uid,
    gid: stat.gid,
    mode: stat.mode & 0o7777,
    ...(includeTimes ? {
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      ctimeMs: stat.ctimeMs,
    } : {}),
  };
}

function sameRepairStatIdentity(actual, expected, { includeTimes = false } = {}) {
  const fields = ['dev', 'ino', 'uid', 'gid', 'mode'];
  if (includeTimes) fields.push('size', 'mtimeMs', 'ctimeMs');
  return fields.every(field => actual[field] === expected[field]);
}

function retentionRepairAuthorizationPaths(authorization) {
  const retention = authorization?.retentionAuthorization ?? authorization;
  return {
    retention,
    paths: retention?.approvedDeletePaths
      ?? retention?.approvedPaths
      ?? authorization?.approvedDeletePaths
      ?? [],
    authorizedBy: retention?.authorizedBy
      ?? authorization?.authorizedBy
      ?? authorization?.identity
      ?? null,
  };
}

/**
 * Validate an explicit, exact-path retention repair authorization.
 *
 * The repair intentionally accepts no directory prefix, glob, basename, or
 * realpath alias. The path in the receipt must be the same path the owner
 * authorized. This is an authorization check only; the quarantine marker and
 * inode/device checks below still independently prove what can be unlinked.
 */
export function validateRetentionRepairAuthorization({ quarantinePath, authorization } = {}) {
  const requested = typeof quarantinePath === 'string' ? quarantinePath : '';
  if (!requested || !path.isAbsolute(requested) || path.resolve(requested) !== requested) {
    return { ok: false, error: 'retention repair requires an absolute, normalized quarantine path' };
  }
  const { retention, paths, authorizedBy } = retentionRepairAuthorizationPaths(authorization);
  if (authorization?.status && authorization.status !== 'PASS') {
    return { ok: false, error: `retention repair authorization status is ${authorization.status}` };
  }
  if (authorization?.deploymentAuthorized === false) {
    return { ok: false, error: 'retention repair authorization is not deployment-authorized' };
  }
  if (retention?.mustMatchExactly !== true) {
    return { ok: false, error: 'retention repair authorization must set mustMatchExactly=true' };
  }
  if (!Array.isArray(paths) || paths.length === 0) {
    return { ok: false, error: 'retention repair authorization has no approved delete paths' };
  }
  if (!paths.includes(requested) || paths.some(candidate => (
    typeof candidate !== 'string'
      || !path.isAbsolute(candidate)
      || path.resolve(candidate) !== candidate
  ))) {
    return { ok: false, error: 'quarantine path is not an explicitly approved exact path' };
  }
  if (typeof authorizedBy !== 'string' || !authorizedBy.trim()) {
    return { ok: false, error: 'retention repair authorization has no author identity' };
  }
  return {
    ok: true,
    approvedPath: requested,
    authorizedBy: authorizedBy.trim(),
  };
}

function validateRetentionRepairAuditPath(auditPath, quarantinePath, fsApi = fs) {
  const requested = typeof auditPath === 'string' ? auditPath : '';
  if (!requested || !path.isAbsolute(requested) || path.resolve(requested) !== requested) {
    throw new HoldError('retention repair requires an absolute, normalized audit path', 'RETENTION_REPAIR_AUDIT_INVALID');
  }
  if (pathIsWithin(quarantinePath, requested)) {
    throw new HoldError('retention repair audit path must be outside the quarantine', 'RETENTION_REPAIR_AUDIT_INVALID');
  }
  const parentPath = path.dirname(requested);
  const parentStat = fsApi.lstatSync(parentPath);
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) {
    throw new HoldError('retention repair audit parent must be a direct directory', 'RETENTION_REPAIR_AUDIT_INVALID');
  }
  const parentRealPath = fsApi.realpathSync(parentPath);
  const quarantineRealPath = fsApi.realpathSync(quarantinePath);
  if (pathIsWithin(quarantineRealPath, parentRealPath)) {
    throw new HoldError('retention repair audit path must resolve outside the quarantine', 'RETENTION_REPAIR_AUDIT_INVALID');
  }
  const existing = fsApi.lstatSync(requested, { throwIfNoEntry: false });
  if (existing && (existing.isSymbolicLink() || !existing.isFile())) {
    throw new HoldError('retention repair audit path must be a regular non-symlink file', 'RETENTION_REPAIR_AUDIT_INVALID');
  }
  return requested;
}

function repairGenerationIdentity(generation, fsApi = fs) {
  const rootStat = fsApi.lstatSync(generation.path);
  const objectsPath = path.join(generation.path, 'objects');
  const objectsStat = fsApi.lstatSync(objectsPath);
  const markerStat = fsApi.lstatSync(generation.markerPath);
  const expectedObjects = generation.marker.identity ?? {};
  if (
    rootStat.isSymbolicLink()
    || !rootStat.isDirectory()
    || !sameRepairStatIdentity(repairStatIdentity(rootStat), repairStatIdentity(generation.stat))
    || objectsStat.isSymbolicLink()
    || !objectsStat.isDirectory()
    || objectsStat.dev !== rootStat.dev
    || objectsStat.dev !== expectedObjects.objectsDev
    || objectsStat.ino !== expectedObjects.objectsIno
    || objectsStat.uid !== rootStat.uid
    || objectsStat.gid !== rootStat.gid
    || (objectsStat.mode & 0o777) !== expectedObjects.objectsMode
    || markerStat.isSymbolicLink()
    || !markerStat.isFile()
    || markerStat.dev !== rootStat.dev
    || markerStat.uid !== rootStat.uid
    || markerStat.gid !== rootStat.gid
    || (markerStat.mode & 0o777) !== 0o600
  ) {
    throw new HoldError('quarantine generation identity changed; refusing retention repair', 'RETENTION_REPAIR_IDENTITY_CHANGED');
  }
  return {
    root: repairStatIdentity(rootStat),
    objects: repairStatIdentity(objectsStat),
    marker: repairStatIdentity(markerStat, { includeTimes: true }),
  };
}

function isNpmBinSymlink(generationPath, candidatePath) {
  if (!pathIsWithin(generationPath, candidatePath)) return false;
  const relativeParts = path.relative(generationPath, candidatePath).split(path.sep);
  return relativeParts.length >= 4
    && relativeParts.at(-2) === '.bin'
    && relativeParts.at(-3) === 'node_modules'
    && relativeParts.at(-1) !== ''
    && relativeParts.at(-1) !== '.'
    && relativeParts.at(-1) !== '..';
}

function collectRetentionRepairLinks(generation, fsApi = fs) {
  const identity = repairGenerationIdentity(generation, fsApi);
  const pending = [generation.path];
  const directories = new Map();
  const links = [];
  while (pending.length > 0) {
    const current = pending.pop();
    const currentStat = fsApi.lstatSync(current);
    if (
      currentStat.isSymbolicLink()
      || !currentStat.isDirectory()
      || currentStat.dev !== identity.root.dev
      || !pathIsWithin(generation.path, current)
    ) {
      throw new HoldError(`retention repair found an unsafe directory: ${current}`, 'RETENTION_REPAIR_UNSAFE_TREE');
    }
    const currentIdentity = repairStatIdentity(currentStat);
    directories.set(current, currentIdentity);
    const names = fsApi.readdirSync(current);
    const afterReadStat = fsApi.lstatSync(current);
    if (!sameRepairStatIdentity(repairStatIdentity(afterReadStat), currentIdentity)) {
      throw new HoldError(`retention repair directory changed while scanning: ${current}`, 'RETENTION_REPAIR_RACE');
    }
    for (const name of names) {
      const child = path.join(current, name);
      if (!pathIsWithin(generation.path, child)) {
        throw new HoldError(`retention repair found an out-of-tree entry: ${child}`, 'RETENTION_REPAIR_UNSAFE_TREE');
      }
      const childStat = fsApi.lstatSync(child);
      if (childStat.dev !== identity.root.dev) {
        throw new HoldError(`retention repair found a cross-device entry: ${child}`, 'RETENTION_REPAIR_CROSS_DEVICE');
      }
      if (childStat.isSymbolicLink()) {
        if (!isNpmBinSymlink(generation.path, child)) {
          throw new HoldError(`retention repair found an unknown symlink: ${child}`, 'RETENTION_REPAIR_UNKNOWN_SYMLINK');
        }
        let target;
        try {
          // readlink reads link metadata only. Never stat or realpath the target.
          target = fsApi.readlinkSync(child);
        } catch (error) {
          throw new HoldError(`retention repair could not read symlink metadata: ${child}`, 'RETENTION_REPAIR_RACE');
        }
        links.push({
          path: child,
          relativePath: path.relative(generation.path, child).split(path.sep).join('/'),
          target,
          dev: childStat.dev,
          ino: childStat.ino,
          parentPath: current,
          parentIdentity: currentIdentity,
        });
      } else if (childStat.isDirectory()) {
        pending.push(child);
      }
    }
  }
  return { identity, directories, links };
}

function repairAuditBase({ quarantinePath, generation, authorization, auditPath, mode, links, identity }) {
  return {
    schema: CORE_BACKUP_RETENTION_REPAIR_AUDIT_SCHEMA,
    status: 'RUNNING',
    mode,
    result: 'REPAIR_PLANNED',
    quarantinePath,
    generation: {
      generationId: generation.marker.generationId,
      rootPath: generation.marker.rootPath,
      objectsPath: generation.marker.objectsPath,
      markerPath: generation.markerPath,
      status: generation.marker.status,
      identity,
    },
    authorization: {
      approvedPath: authorization.approvedPath,
      authorizedBy: authorization.authorizedBy,
      authorizationSha256: sha256(JSON.stringify(authorization.source)),
    },
    auditPath,
    links: links.map(link => ({
      path: link.path,
      relativePath: link.relativePath,
      target: link.target,
      dev: link.dev,
      ino: link.ino,
    })),
    actions: links.map(link => ({
      path: link.path,
      status: 'PLANNED',
    })),
    startedAt: new Date().toISOString(),
  };
}

function persistRetentionRepairAudit(audit, auditPath, fsApi = fs) {
  atomicWriteJson(auditPath, audit, fsApi);
}

function finishRetentionRepairAudit(audit, status, result, error = null) {
  audit.status = status;
  audit.result = result;
  audit.finishedAt = new Date().toISOString();
  if (error) audit.error = error;
  return audit;
}

/**
 * Repair only npm-generated `.bin` symlink entries in one explicitly
 * authorized, retired quarantine generation.
 *
 * `apply` defaults to false so callers must opt into unlinking. The target of
 * every symlink is intentionally never resolved or traversed; only the link
 * directory entry is unlinked after the quarantine generation, parent
 * directory, device, and inode identities are rechecked. Any unknown link,
 * mount, identity drift, or audit failure returns HOLD without proceeding.
 */
export function repairCoreBackupQuarantine({
  quarantinePath,
  authorization,
  auditPath,
  apply = false,
  fsApi = fs,
  homeDir = os.homedir(),
} = {}) {
  const authorizationCheck = validateRetentionRepairAuthorization({ quarantinePath, authorization });
  if (!authorizationCheck.ok) {
    return {
      status: 'HOLD',
      result: 'NO_MUTATION',
      code: 'RETENTION_REPAIR_NOT_AUTHORIZED',
      error: authorizationCheck.error,
    };
  }
  const normalizedQuarantinePath = authorizationCheck.approvedPath;
  let normalizedAuditPath;
  try {
    normalizedAuditPath = validateRetentionRepairAuditPath(auditPath, normalizedQuarantinePath, fsApi);
  } catch (error) {
    return {
      status: 'HOLD',
      result: 'NO_MUTATION',
      code: error.code || 'RETENTION_REPAIR_AUDIT_INVALID',
      error: error.message,
    };
  }

  let generation;
  let repairTree;
  try {
    const rootPath = path.dirname(normalizedQuarantinePath);
    const rootStat = fsApi.lstatSync(rootPath);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
      throw new HoldError('retention repair root is not a direct directory', 'RETENTION_REPAIR_UNSAFE_ROOT');
    }
    const rootRealPath = fsApi.realpathSync(rootPath);
    generation = inspectQuarantineGeneration(normalizedQuarantinePath, {
      fsApi,
      rootPath,
      rootRealPath,
    });
    if (!generation) {
      throw new HoldError('quarantine generation is unverified; refusing retention repair', 'RETENTION_REPAIR_UNVERIFIED');
    }
    repairTree = collectRetentionRepairLinks(generation, fsApi);
  } catch (error) {
    const minimalAudit = {
      schema: CORE_BACKUP_RETENTION_REPAIR_AUDIT_SCHEMA,
      status: 'HOLD',
      mode: apply ? 'apply' : 'dry-run',
      result: 'NO_MUTATION',
      code: error.code || 'RETENTION_REPAIR_FAILED',
      quarantinePath: normalizedQuarantinePath,
      auditPath: normalizedAuditPath,
      error: error.message,
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
    };
    try { persistRetentionRepairAudit(minimalAudit, normalizedAuditPath, fsApi); } catch {}
    return minimalAudit;
  }

  const auditAuthorization = {
    ...authorizationCheck,
    source: authorization,
  };
  const audit = repairAuditBase({
    quarantinePath: normalizedQuarantinePath,
    generation,
    authorization: auditAuthorization,
    auditPath: normalizedAuditPath,
    mode: apply ? 'apply' : 'dry-run',
    links: repairTree.links,
    identity: repairTree.identity,
  });
  try {
    persistRetentionRepairAudit(audit, normalizedAuditPath, fsApi);
  } catch (error) {
    return {
      ...finishRetentionRepairAudit(audit, 'HOLD', 'NO_MUTATION', error.message),
      code: 'RETENTION_REPAIR_AUDIT_WRITE_FAILED',
    };
  }

  if (!apply) {
    for (const action of audit.actions) action.status = 'WOULD_UNLINK';
    finishRetentionRepairAudit(
      audit,
      'PASS',
      audit.actions.length > 0 ? 'PRECHECK_ONLY' : 'NOOP',
    );
    try { persistRetentionRepairAudit(audit, normalizedAuditPath, fsApi); } catch (error) {
      return {
        ...audit,
        status: 'HOLD',
        result: 'AUDIT_WRITE_FAILED',
        error: error.message,
        code: 'RETENTION_REPAIR_AUDIT_WRITE_FAILED',
      };
    }
    return audit;
  }

  const lock = acquireCoreBackupRetentionLock(homeDir, fsApi);
  if (!lock) {
    finishRetentionRepairAudit(audit, 'HOLD', 'NO_MUTATION', 'Core backup retention is locked by another run');
    try { persistRetentionRepairAudit(audit, normalizedAuditPath, fsApi); } catch {}
    return { ...audit, code: 'RETENTION_REPAIR_LOCKED' };
  }

  try {
    // Re-scan after acquiring the lock. This closes the window between the
    // initial audit and the first unlink, and makes the planned set immutable.
    const rootPath = path.dirname(normalizedQuarantinePath);
    const rootRealPath = fsApi.realpathSync(rootPath);
    const recheckedGeneration = inspectQuarantineGeneration(normalizedQuarantinePath, {
      fsApi,
      rootPath,
      rootRealPath,
    });
    if (!recheckedGeneration) {
      throw new HoldError('quarantine generation changed before retention repair', 'RETENTION_REPAIR_IDENTITY_CHANGED');
    }
    const recheckedTree = collectRetentionRepairLinks(recheckedGeneration, fsApi);
    if (
      recheckedGeneration.stat.dev !== generation.stat.dev
      || recheckedGeneration.stat.ino !== generation.stat.ino
      || recheckedTree.links.length !== repairTree.links.length
      || recheckedTree.links.some((link, index) => (
        link.path !== repairTree.links[index].path
          || link.ino !== repairTree.links[index].ino
          || link.dev !== repairTree.links[index].dev
          || link.target !== repairTree.links[index].target
      ))
    ) {
      throw new HoldError('quarantine entries changed before retention repair', 'RETENTION_REPAIR_RACE');
    }

    for (const [index, planned] of repairTree.links.entries()) {
      const action = audit.actions[index];
      action.status = 'ATTEMPTED';
      action.attemptedAt = new Date().toISOString();
      persistRetentionRepairAudit(audit, normalizedAuditPath, fsApi);

      const currentIdentity = repairGenerationIdentity(recheckedGeneration, fsApi);
      if (
        !sameRepairStatIdentity(currentIdentity.root, repairTree.identity.root)
        || !sameRepairStatIdentity(currentIdentity.objects, repairTree.identity.objects)
        || !sameRepairStatIdentity(currentIdentity.marker, repairTree.identity.marker, { includeTimes: true })
      ) {
        throw new HoldError(`retention repair generation identity changed before unlink: ${planned.path}`, 'RETENTION_REPAIR_RACE');
      }
      const parentStat = fsApi.lstatSync(planned.parentPath);
      const linkStat = fsApi.lstatSync(planned.path);
      if (
        parentStat.isSymbolicLink()
        || !parentStat.isDirectory()
        || !sameRepairStatIdentity(repairStatIdentity(parentStat), planned.parentIdentity)
        || !linkStat.isSymbolicLink()
        || linkStat.dev !== planned.dev
        || linkStat.ino !== planned.ino
        || !pathIsWithin(normalizedQuarantinePath, planned.path)
      ) {
        throw new HoldError(`retention repair identity changed before unlink: ${planned.path}`, 'RETENTION_REPAIR_RACE');
      }
      // unlinkSync removes the directory entry and never follows a symlink.
      fsApi.unlinkSync(planned.path);
      fsyncDirectory(planned.parentPath, fsApi);
      const after = fsApi.lstatSync(planned.path, { throwIfNoEntry: false });
      if (after) {
        action.status = 'RACE_DETECTED';
        throw new HoldError(`retention repair found a replacement after unlink: ${planned.path}`, 'RETENTION_REPAIR_RACE');
      }
      action.status = 'UNLINKED';
      action.finishedAt = new Date().toISOString();
      persistRetentionRepairAudit(audit, normalizedAuditPath, fsApi);
    }

    const finalGeneration = inspectQuarantineGeneration(normalizedQuarantinePath, {
      fsApi,
      rootPath: path.dirname(normalizedQuarantinePath),
      rootRealPath: fsApi.realpathSync(path.dirname(normalizedQuarantinePath)),
    });
    if (!finalGeneration) {
      throw new HoldError('quarantine generation became unverifiable after retention repair', 'RETENTION_REPAIR_IDENTITY_CHANGED');
    }
    const finalTree = collectRetentionRepairLinks(finalGeneration, fsApi);
    if (finalTree.links.length > 0) {
      throw new HoldError('retention repair left symlink entries behind', 'RETENTION_REPAIR_INCOMPLETE');
    }
    finishRetentionRepairAudit(
      audit,
      'PASS',
      audit.actions.length > 0 ? 'REPAIRED' : 'NOOP',
    );
    persistRetentionRepairAudit(audit, normalizedAuditPath, fsApi);
    return audit;
  } catch (error) {
    finishRetentionRepairAudit(audit, 'HOLD', 'PARTIAL_HOLD', error.message);
    try { persistRetentionRepairAudit(audit, normalizedAuditPath, fsApi); } catch {}
    return { ...audit, code: error.code || 'RETENTION_REPAIR_FAILED' };
  } finally {
    releaseCoreBackupRetentionLock(lock, fsApi);
  }
}

export function repairCoreBackupRetention(options) {
  return repairCoreBackupQuarantine(options);
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

function copyImmutableSource(source, destination) {
  const sourceDir = path.resolve(source);
  const destinationDir = path.resolve(destination);
  if (sourceDir === destinationDir) return destinationDir;
  if (fs.existsSync(destinationDir)) {
    throw new HoldError(
      `persistent staged source already exists at ${destinationDir}; resume the recorded transaction`,
      'SOURCE_TRANSACTION_CONFLICT',
    );
  }
  fs.cpSync(sourceDir, destinationDir, {
    recursive: true,
    force: false,
    errorOnExist: true,
    dereference: false,
    filter(candidate) {
      const base = path.basename(candidate);
      return base !== 'node_modules' && base !== '.git';
    },
  });
  return destinationDir;
}

function ensureFeishuRuntimeDependencies(stagedFeishuDir, liveNodeModules) {
  const target = path.join(stagedFeishuDir, 'node_modules');
  let liveRealPath;
  try {
    liveRealPath = fs.realpathSync(liveNodeModules);
  } catch {
    throw new HoldError(
      `target Feishu preflight cannot reuse live runtime dependencies: ${liveNodeModules}`,
      'INVALID_FEISHU_SOURCE',
    );
  }
  if (fs.existsSync(target) || fs.lstatSync(target, { throwIfNoEntry: false })) {
    let targetRealPath;
    try { targetRealPath = fs.realpathSync(target); } catch {
      throw new HoldError(`staged Feishu node_modules is not readable: ${target}`, 'INVALID_FEISHU_SOURCE');
    }
    if (targetRealPath !== liveRealPath) {
      throw new HoldError(
        `staged Feishu node_modules is bound to ${targetRealPath}, expected ${liveRealPath}`,
        'SOURCE_BINDING_MISMATCH',
      );
    }
    return target;
  }
  fs.symlinkSync(liveNodeModules, target, 'dir');
  return target;
}

export function ensureCommitmentCoreRuntimeDependencies(stagedCoreDir, liveNodeModules) {
  const packageDir = path.join(stagedCoreDir, 'skills', 'commitment-core');
  const target = path.join(packageDir, 'node_modules');
  let packageJson;
  let packageLock;
  let liveRealPath;
  try {
    packageJson = readJson(path.join(packageDir, 'package.json'));
    packageLock = readJson(path.join(packageDir, 'package-lock.json'));
    liveRealPath = fs.realpathSync(liveNodeModules);
  } catch {
    throw new HoldError(
      `target Commitment Core convergence cannot reuse live runtime dependencies: ${liveNodeModules}`,
      'INVALID_CORE_SOURCE',
    );
  }

  const dependencies = Object.keys(packageJson.dependencies || {}).sort();
  if (dependencies.length === 0) {
    throw new HoldError(
      'target Commitment Core convergence package has no declared runtime dependencies',
      'INVALID_CORE_SOURCE',
    );
  }
  for (const dependency of dependencies) {
    const lockedVersion = packageLock.packages?.[`node_modules/${dependency}`]?.version;
    let livePackage;
    try {
      livePackage = readJson(path.join(liveRealPath, ...dependency.split('/'), 'package.json'));
    } catch {
      throw new HoldError(
        `live Commitment Core dependency is missing: ${dependency}`,
        'SOURCE_BINDING_MISMATCH',
      );
    }
    if (!lockedVersion || livePackage.version !== lockedVersion) {
      throw new HoldError(
        `live Commitment Core dependency ${dependency}@${livePackage.version || 'missing'} does not match target lockfile ${lockedVersion || 'missing'}`,
        'SOURCE_BINDING_MISMATCH',
      );
    }
  }

  if (fs.existsSync(target) || fs.lstatSync(target, { throwIfNoEntry: false })) {
    let targetRealPath;
    try { targetRealPath = fs.realpathSync(target); } catch {
      throw new HoldError(`staged Commitment Core node_modules is not readable: ${target}`, 'INVALID_CORE_SOURCE');
    }
    if (targetRealPath !== liveRealPath) {
      throw new HoldError(
        `staged Commitment Core node_modules is bound to ${targetRealPath}, expected ${liveRealPath}`,
        'SOURCE_BINDING_MISMATCH',
      );
    }
    return target;
  }
  fs.symlinkSync(liveNodeModules, target, 'dir');
  return target;
}

export function preparePersistentStagedSources({
  args,
  reportDir,
  summary,
  zylosDir,
  resume = false,
  copySource = copyImmutableSource,
  stageArchive = stageImmutableArchive,
  persistProgress,
}) {
  const root = path.join(reportDir, 'staged-sources');
  const coreDir = path.join(root, 'core');
  const feishuDir = path.join(root, 'feishu');
  const archivePath = path.join(root, 'feishu.tar.gz');
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });

  if (resume) {
    const persisted = summary?.stagedSources;
    if (
      !persisted
      || path.resolve(persisted.root || '') !== path.resolve(root)
      || path.resolve(persisted.coreDir || '') !== path.resolve(coreDir)
      || path.resolve(persisted.feishuDir || '') !== path.resolve(feishuDir)
      || path.resolve(persisted.archivePath || '') !== path.resolve(archivePath)
    ) {
      throw new HoldError('resume staged source paths do not match the transaction', 'SOURCE_BINDING_MISMATCH');
    }
    if (!fs.existsSync(coreDir) || !fs.existsSync(feishuDir)) {
      throw new HoldError('resume requires the original staged source trees to remain present', 'SOURCE_BINDING_MISMATCH');
    }
    if (!fileIsRegular(archivePath)) {
      throw new HoldError('resume requires the immutable Feishu source archive to remain present', 'SOURCE_BINDING_MISMATCH');
    }
  } else {
    copySource(args.stagedCoreDir, coreDir);
    persistProgress?.({ root, coreDir, feishuDir, archivePath: null, stage: 'core' });
    stageArchive(FEISHU_REPO, args.feishuSha, feishuDir);
    persistProgress?.({ root, coreDir, feishuDir, archivePath, stage: 'feishu' });
  }

  const liveFeishuDir = path.join(zylosDir, '.claude', 'skills', 'feishu');
  ensureFeishuRuntimeDependencies(feishuDir, path.join(liveFeishuDir, 'node_modules'));
  if (args.nativeTaskCoreManifest) {
    const liveCommitmentCoreDir = path.join(zylosDir, '.claude', 'skills', 'commitment-core');
    ensureCommitmentCoreRuntimeDependencies(
      coreDir,
      path.join(liveCommitmentCoreDir, 'node_modules'),
    );
  }
  const core = buildSourceIdentity(coreDir, {
    repo: CORE_REPO,
    sha: args.coreSha,
    version: args.coreVersion,
  });
  const feishu = buildSourceIdentity(feishuDir, {
    repo: FEISHU_REPO,
    sha: args.feishuSha,
    version: args.feishuVersion,
  });
  if (resume && (
    !sourceIdentityMatches(summary.sources?.core, core)
    || !sourceIdentityMatches(summary.sources?.feishu, feishu)
  )) {
    throw new HoldError('resume staged source content or immutable commit does not match the transaction', 'SOURCE_BINDING_MISMATCH');
  }
  return {
    root,
    coreDir,
    feishuDir,
    archivePath,
    core,
    feishu,
  };
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

function loadNativeTaskDeploymentIdentity({ zylosDir, requestedAgent }) {
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
  return { configured, identity: identity.identity };
}

export function buildNativeTaskConservationEnv({
  baseEnv = process.env,
  zylosDir,
  identity,
  defaultAssigneeId,
  agentAppIds,
} = {}) {
  const gateEnv = {
    ...baseEnv,
    ZYLOS_DIR: zylosDir,
    ZYLOS_AGENT_ID: identity.agentId,
    FEISHU_APP_ID: identity.appId,
    ...(defaultAssigneeId
      ? { C4_WORK_INTAKE_DEFAULT_ASSIGNEE_ID: defaultAssigneeId }
      : {}),
  };
  if (agentAppIds === undefined || agentAppIds === null || agentAppIds === '') {
    delete gateEnv.FEISHU_TASK_V2_AGENT_APP_IDS;
  } else {
    gateEnv.FEISHU_TASK_V2_AGENT_APP_IDS = agentAppIds;
  }
  return gateEnv;
}

function runNativeTaskConservationGate({
  coreDir,
  feishuDir,
  zylosDir,
  requestedAgent,
  reportPath,
}) {
  const { configured, identity } = loadNativeTaskDeploymentIdentity({
    zylosDir,
    requestedAgent,
  });
  const command = buildNativeTaskConservationCommand({
    nodePath: process.execPath,
    coreDir,
    feishuDir,
  });
  const gateEnv = buildNativeTaskConservationEnv({
    zylosDir,
    identity,
    defaultAssigneeId: configured.defaultAssigneeId,
    agentAppIds: configured.agentAppIds,
  });
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
    || report.deployment?.agentId !== identity.agentId
    || report.deployment?.appId !== identity.appId
    || report.inventory?.core?.schema !== 'zylos.native-task-core-inventory/v1'
    || report.inventory?.core?.snapshot?.stable !== true
    || report.inventory?.core?.identity?.agentId !== identity.agentId
    || report.inventory?.remote?.identity?.kind !== 'app'
    || report.inventory?.remote?.identity?.appId !== identity.appId
  ) {
    throw new HoldError(
      'native task conservation returned an invalid or mismatched PASS report',
      'NATIVE_TASK_CONSERVATION_FAILED',
    );
  }
  return report;
}

function runNativeTaskConvergenceWorkflow({
  coreDir,
  feishuDir,
  zylosDir,
  coreManifest,
  feishuManifest,
  reportDir,
  apply,
  authorization,
  resume = false,
  transactionId,
  coreSource,
  feishuSource,
}) {
  const command = buildNativeTaskConvergenceCommand({
    nodePath: process.execPath,
    coreDir,
    feishuDir,
    coreManifest,
    feishuManifest,
    reportDir,
    apply,
    authorization,
    resume,
    transactionId,
    coreSource,
    feishuSource,
  });
  const result = run(command.command, command.args, {
    cwd: coreDir,
    env: { ...process.env, ZYLOS_DIR: zylosDir },
    timeout: 600_000,
  });
  const report = parseJsonOutput(result.stdout);
  if (result.status !== 0 || result.error || report?.status !== 'PASS') {
    throw new HoldError(
      `native task convergence ${apply ? 'apply' : 'plan'} failed: ${report?.code ?? result.error ?? result.stderr.trim() ?? 'invalid report'}`,
      'NATIVE_TASK_CONVERGENCE_FAILED',
    );
  }
  if (
    report.schema !== 'zylos.native-task-convergence-run/v1'
    || report.mode !== (apply ? 'apply' : 'plan')
    || (apply && report.authorization !== authorization)
    || (transactionId && report.transactionId !== transactionId)
    || (coreSource && !sourceIdentityMatches(report.sources?.core, coreSource))
    || (feishuSource && !sourceIdentityMatches(report.sources?.feishu, feishuSource))
  ) {
    throw new HoldError(
      'native task convergence returned an invalid or mismatched PASS report',
      'NATIVE_TASK_CONVERGENCE_FAILED',
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

function pairTransactionMode(args) {
  return args.execute ? 'execute' : args.repairOnly ? 'repair-only' : 'dry-run';
}

function createPairTransactionSummary(args, reportDir) {
  return {
    schema: 'zylos.fork-pair-upgrade/v1',
    status: 'RUNNING',
    mode: pairTransactionMode(args),
    agent: args.agent,
    transactionId: crypto.randomUUID(),
    startedAt: new Date().toISOString(),
    target: {
      core: { repo: CORE_REPO, sha: args.coreSha, version: args.coreVersion },
      feishu: { repo: FEISHU_REPO, sha: args.feishuSha, version: args.feishuVersion },
    },
    reportDir,
    coreUpgraded: false,
    feishuUpgraded: false,
  };
}

export function validatePairResumeSummary(summary, args, reportDir) {
  if (!summary || summary.schema !== 'zylos.fork-pair-upgrade/v1') {
    throw new HoldError('resume requires a fork-pair transaction summary', 'RESUME_STATE_MISSING');
  }
  if (!summary.transactionId || typeof summary.transactionId !== 'string') {
    throw new HoldError('resume transaction has no durable transaction id', 'SOURCE_BINDING_MISMATCH');
  }
  if (path.resolve(summary.reportDir || '') !== path.resolve(reportDir)) {
    throw new HoldError('resume report directory does not match the transaction', 'SOURCE_BINDING_MISMATCH');
  }
  if (summary.mode !== pairTransactionMode(args) || summary.agent !== args.agent) {
    throw new HoldError('resume mode or Agent does not match the transaction', 'SOURCE_BINDING_MISMATCH');
  }
  if (
    summary.target?.core?.repo !== CORE_REPO
    || summary.target?.core?.sha !== args.coreSha
    || summary.target?.core?.version !== args.coreVersion
    || summary.target?.feishu?.repo !== FEISHU_REPO
    || summary.target?.feishu?.sha !== args.feishuSha
    || summary.target?.feishu?.version !== args.feishuVersion
  ) {
    throw new HoldError('resume immutable pair target does not match the transaction', 'SOURCE_BINDING_MISMATCH');
  }
  const hasNativeTaskInputs = Boolean(args.nativeTaskCoreManifest);
  if (hasNativeTaskInputs !== Boolean(summary.nativeTaskInputs)
    || (hasNativeTaskInputs && (
      summary.nativeTaskInputs?.coreManifest !== path.resolve(args.nativeTaskCoreManifest)
      || summary.nativeTaskInputs?.feishuManifest !== path.resolve(args.nativeTaskFeishuManifest)
      || summary.nativeTaskInputs?.authorization !== args.nativeTaskRepairAuthorization
      || summary.nativeTaskInputs?.transactionId !== summary.transactionId
      || !summary.nativeTaskInputs?.coreDir
      || !summary.nativeTaskInputs?.feishuDir
      || !summary.nativeTaskInputs?.reportDir
      || !summary.nativeTaskInputs?.commandIdentity?.sha256
    ))) {
    throw new HoldError('resume native Task inputs do not match the transaction', 'SOURCE_BINDING_MISMATCH');
  }
  if (!['RUNNING', 'HOLD'].includes(summary.status)) {
    throw new HoldError('fork-pair transaction is already complete', 'TRANSACTION_COMPLETE');
  }
  return summary;
}

export function runForkPairUpgrade(argv = process.argv.slice(2)) {
  let args;
  try {
    args = parseForkPairArgs(argv);
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
  const reportDir = args.reportDir
    ? path.resolve(args.reportDir)
    : makeReportDir(zylosDir, args.reportRoot);
  fs.mkdirSync(reportDir, { recursive: true, mode: 0o700 });
  const summaryPath = path.join(reportDir, 'summary.json');
  let summary;
  if (args.resume) {
    try {
      summary = validatePairResumeSummary(readJson(summaryPath), args, reportDir);
    } catch (error) {
      process.stdout.write(`${JSON.stringify({
        status: 'HOLD',
        code: error.code || 'RESUME_STATE_MISSING',
        error: error.message,
        reportDir,
      }, null, 2)}\n`);
      return 1;
    }
    summary.resumeCount = Number(summary.resumeCount || 0) + 1;
    summary.resumedAt = new Date().toISOString();
    summary.status = 'RUNNING';
    delete summary.finishedAt;
    atomicWriteJson(summaryPath, summary);
  } else {
    if (fs.existsSync(summaryPath)) {
      process.stdout.write(`${JSON.stringify({
        status: 'HOLD',
        code: 'REPORT_TRANSACTION_CONFLICT',
        error: `report transaction already exists at ${reportDir}; use --resume`,
        reportDir,
      }, null, 2)}\n`);
      return 1;
    }
    summary = createPairTransactionSummary(args, reportDir);
    if (args.nativeTaskCoreManifest) {
      summary.nativeTaskInputs = {
        coreManifest: path.resolve(args.nativeTaskCoreManifest),
        feishuManifest: path.resolve(args.nativeTaskFeishuManifest),
        authorization: args.nativeTaskRepairAuthorization,
        transactionId: summary.transactionId,
      };
    }
    atomicWriteJson(summaryPath, summary);
  }
  const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-fork-pair-upgrade-'));

  try {
    const stagedSources = preparePersistentStagedSources({
      args,
      reportDir,
      summary,
      zylosDir,
      resume: args.resume,
      persistProgress: progress => {
        summary.stagedSources = progress;
        atomicWriteJson(summaryPath, summary);
      },
    });
    const stagedCoreDir = stagedSources.coreDir;
    const stagedFeishuDir = stagedSources.feishuDir;
    const coreSource = validateCoreSource(stagedCoreDir, args.coreVersion);
    if (!coreSource.ok) throw new HoldError(coreSource.error, 'INVALID_CORE_SOURCE');

    const feishuSource = validateFeishuSource(stagedFeishuDir, args.feishuVersion);
    if (!feishuSource.ok) throw new HoldError(feishuSource.error, 'INVALID_FEISHU_SOURCE');
    const liveFeishuDir = path.join(zylosDir, '.claude', 'skills', 'feishu');
    summary.sources = { core: stagedSources.core, feishu: stagedSources.feishu };
    summary.stagedSources = {
      root: stagedSources.root,
      coreDir: stagedSources.coreDir,
      feishuDir: stagedSources.feishuDir,
      archivePath: stagedSources.archivePath,
    };
    if (args.nativeTaskCoreManifest) {
      const nativeTaskReportDir = path.join(reportDir, 'native-task-convergence');
      const nativeTaskCommand = buildNativeTaskConvergenceCommand({
        nodePath: process.execPath,
        coreDir: stagedCoreDir,
        feishuDir: stagedFeishuDir,
        coreManifest: args.nativeTaskCoreManifest,
        feishuManifest: args.nativeTaskFeishuManifest,
        reportDir: nativeTaskReportDir,
        apply: args.execute || args.repairOnly,
        authorization: args.nativeTaskRepairAuthorization,
        transactionId: summary.transactionId,
        resume: args.resume,
        coreSource: stagedSources.core,
        feishuSource: stagedSources.feishu,
      });
      const nativeTaskInputs = {
        ...(summary.nativeTaskInputs || {}),
        coreManifest: path.resolve(args.nativeTaskCoreManifest),
        feishuManifest: path.resolve(args.nativeTaskFeishuManifest),
        authorization: args.nativeTaskRepairAuthorization,
        coreDir: stagedCoreDir,
        feishuDir: stagedFeishuDir,
        reportDir: nativeTaskReportDir,
        sources: { core: stagedSources.core, feishu: stagedSources.feishu },
        commandIdentity: resumeNeutralCommandIdentity(nativeTaskCommand),
      };
      if (args.resume && summary.nativeTaskInputs?.commandIdentity) {
        if (!commandIdentityMatches(summary.nativeTaskInputs.commandIdentity, nativeTaskCommand)) {
          throw new HoldError('resume native Task command identity does not match the transaction', 'SOURCE_BINDING_MISMATCH');
        }
      }
      summary.nativeTaskInputs = nativeTaskInputs;
    }
    atomicWriteJson(summaryPath, summary);

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

    if (args.nativeTaskCoreManifest) {
      // Resolve the requested Agent/App before any convergence mutation. The
      // workflow then performs both plans before its explicitly authorized
      // remote-marker -> Core-link -> status-repair apply sequence.
      loadNativeTaskDeploymentIdentity({
        zylosDir,
        requestedAgent: args.agent,
      });
      summary.nativeTaskConvergence = runNativeTaskConvergenceWorkflow({
        coreDir: stagedCoreDir,
        feishuDir: stagedFeishuDir,
        zylosDir,
        coreManifest: args.nativeTaskCoreManifest,
        feishuManifest: args.nativeTaskFeishuManifest,
        reportDir: path.join(reportDir, 'native-task-convergence'),
        apply: args.execute || args.repairOnly,
        authorization: args.nativeTaskRepairAuthorization,
        resume: args.resume,
        transactionId: summary.transactionId,
        coreSource: stagedSources.core,
        feishuSource: stagedSources.feishu,
      });
      atomicWriteJson(summaryPath, summary);
    } else {
      summary.nativeTaskConvergence = {
        status: 'NOT_REQUESTED',
        mode: args.execute || args.repairOnly ? 'apply' : 'plan',
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

    if (args.repairOnly) {
      summary.status = 'PASS';
      summary.result = 'NATIVE_TASK_CONVERGENCE_COMPLETE';
      summary.finishedAt = new Date().toISOString();
      atomicWriteJson(summaryPath, summary);
      process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
      return 0;
    }

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
