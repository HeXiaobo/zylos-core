#!/usr/bin/env node

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  captureProcessIdentity,
  inspectProcessIdentity,
} from '../cli/lib/process-identity.js';

const CORE_SCHEMA = 'zylos.legacy-task-adoption/v1';
const FEISHU_SCHEMA = 'zylos.feishu-task-v2-legacy-adoption/v1';
const REPORT_SCHEMA = 'zylos.native-task-convergence-run/v1';
const STEP_RECEIPT_SCHEMA = 'zylos.native-task-convergence-step/v1';
const LOCK_SCHEMA = 'zylos.native-task-convergence-lock/v1';
const RUNNER_JOB_SCHEMA = 'zylos.native-task-convergence-runner-job/v1';
const AUTHORIZATION = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{2,255}$/;
const TRANSACTION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const FULL_SHA = /^[0-9a-f]{40}$/i;
const RUNNER_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'native-task-convergence-runner.js');

class ConvergenceError extends Error {
  constructor(message, code = 'CONVERGENCE_FAILED', cause) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'ConvergenceError';
    this.code = code;
  }
}

function requireText(value, field) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ConvergenceError(`${field} must be a non-empty string`, 'INVALID_ARGUMENT');
  }
  return value.trim();
}

function readJson(filePath, field, fsApi = fs) {
  try {
    return JSON.parse(fsApi.readFileSync(filePath, 'utf8'));
  } catch (cause) {
    throw new ConvergenceError(`${field} must be readable JSON`, 'INVALID_MANIFEST', cause);
  }
}

function sha256File(filePath, fsApi = fs) {
  return crypto.createHash('sha256').update(fsApi.readFileSync(filePath)).digest('hex');
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function sourceTreeSha256(root, fsApi = fs) {
  const hash = crypto.createHash('sha256');
  const visit = (current, relative = '') => {
    const entries = fsApi.readdirSync(current, { withFileTypes: true })
      .filter(entry => entry.name !== 'node_modules' && entry.name !== '.git')
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const child = path.join(current, entry.name);
      const childRelative = path.join(relative, entry.name).split(path.sep).join('/');
      const stat = fsApi.lstatSync(child);
      if (stat.isSymbolicLink()) {
        hash.update(`symlink\0${childRelative}\0${fsApi.readlinkSync(child)}\n`);
      } else if (stat.isDirectory()) {
        hash.update(`dir\0${childRelative}\0${stat.mode & 0o7777}\n`);
        visit(child, childRelative);
      } else if (stat.isFile()) {
        hash.update(`file\0${childRelative}\0${stat.size}\0${stat.mode & 0o7777}\n`);
        hash.update(fsApi.readFileSync(child));
      }
    }
  };
  visit(root);
  return hash.digest('hex');
}

function sourceIdentity({ dir, repo, commit, version }, fsApi = fs) {
  const resolvedDir = path.resolve(dir);
  let realPath;
  try {
    realPath = fsApi.realpathSync(resolvedDir);
  } catch (cause) {
    throw new ConvergenceError(`source directory is not readable: ${resolvedDir}`, 'SOURCE_BINDING_MISMATCH', cause);
  }
  const packagePath = path.join(resolvedDir, 'package.json');
  return {
    dir: resolvedDir,
    realPath,
    repo,
    commit,
    version,
    packageSha256: fsApi.existsSync(packagePath) ? sha256File(packagePath, fsApi) : null,
    treeSha256: sourceTreeSha256(resolvedDir, fsApi),
  };
}

function sourceIdentityEqual(left, right) {
  return Boolean(left && right)
    && ['dir', 'realPath', 'repo', 'commit', 'version', 'packageSha256', 'treeSha256']
      .every(field => left[field] === right[field]);
}

function commandIdentity(step) {
  const command = { command: step.command, args: [...step.args] };
  return { ...command, sha256: sha256(JSON.stringify(command)) };
}

function commandIdentityMatches(identity, step) {
  if (!identity || identity.command !== step.command || !Array.isArray(identity.args)) return false;
  const expected = commandIdentity(step);
  return identity.sha256 === expected.sha256
    && identity.sha256 === sha256(JSON.stringify({ command: identity.command, args: identity.args }));
}

function atomicWriteJson(filePath, value, fsApi = fs) {
  const temporary = `${filePath}.tmp-${process.pid}-${crypto.randomBytes(12).toString('hex')}`;
  const content = `${JSON.stringify(value, null, 2)}\n`;
  try {
    let fileHandle = null;
    try {
      fileHandle = fsApi.openSync(temporary, 'wx', 0o600);
      fsApi.writeFileSync(fileHandle, content, 'utf8');
      fsApi.fsyncSync(fileHandle);
    } finally {
      if (fileHandle !== null) fsApi.closeSync(fileHandle);
    }
    fsApi.renameSync(temporary, filePath);
    const directoryHandle = fsApi.openSync(path.dirname(filePath), 'r');
    try {
      fsApi.fsyncSync(directoryHandle);
    } finally {
      fsApi.closeSync(directoryHandle);
    }
  } catch (error) {
    try { fsApi.rmSync(temporary, { force: true }); } catch {}
    throw error;
  }
}

function parseArgs(argv) {
  const options = {
    plan: false,
    apply: false,
    resume: false,
    authorization: null,
    transactionId: null,
    coreSourceRepo: null,
    coreSourceCommit: null,
    coreSourceVersion: null,
    feishuSourceRepo: null,
    feishuSourceCommit: null,
    feishuSourceVersion: null,
  };
  const valueFlags = new Map([
    ['--core-manifest', 'coreManifest'],
    ['--feishu-manifest', 'feishuManifest'],
    ['--core-dir', 'coreDir'],
    ['--feishu-dir', 'feishuDir'],
    ['--report-dir', 'reportDir'],
    ['--authorization', 'authorization'],
    ['--transaction-id', 'transactionId'],
    ['--core-source-repo', 'coreSourceRepo'],
    ['--core-source-commit', 'coreSourceCommit'],
    ['--core-source-version', 'coreSourceVersion'],
    ['--feishu-source-repo', 'feishuSourceRepo'],
    ['--feishu-source-commit', 'feishuSourceCommit'],
    ['--feishu-source-version', 'feishuSourceVersion'],
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--plan' || argument === '--apply') {
      const key = argument.slice(2);
      if (options[key]) throw new ConvergenceError(`duplicate flag: ${argument}`, 'INVALID_ARGUMENT');
      options[key] = true;
      continue;
    }
    if (argument === '--resume') {
      if (options.resume) throw new ConvergenceError(`duplicate flag: ${argument}`, 'INVALID_ARGUMENT');
      options.resume = true;
      continue;
    }
    const key = valueFlags.get(argument);
    if (!key) throw new ConvergenceError(`unknown option: ${argument}`, 'INVALID_ARGUMENT');
    if (options[key] !== undefined && options[key] !== null) {
      throw new ConvergenceError(`duplicate flag: ${argument}`, 'INVALID_ARGUMENT');
    }
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) {
      throw new ConvergenceError(`${argument} requires a value`, 'INVALID_ARGUMENT');
    }
    options[key] = requireText(value, argument);
    index += 1;
  }
  if (options.plan === options.apply) {
    throw new ConvergenceError('choose exactly one of --plan or --apply', 'INVALID_ARGUMENT');
  }
  for (const field of ['coreManifest', 'feishuManifest', 'coreDir', 'feishuDir', 'reportDir']) {
    if (!options[field]) throw new ConvergenceError(`--${field.replace(/[A-Z]/g, value => `-${value.toLowerCase()}`)} is required`, 'INVALID_ARGUMENT');
    options[field] = path.resolve(options[field]);
  }
  if (options.apply && !AUTHORIZATION.test(String(options.authorization ?? ''))) {
    throw new ConvergenceError('--apply requires a stable --authorization receipt id', 'REPAIR_NOT_AUTHORIZED');
  }
  if (options.plan && options.authorization !== null) {
    throw new ConvergenceError('--authorization is valid only with --apply', 'INVALID_ARGUMENT');
  }
  if (options.resume && !options.apply) {
    throw new ConvergenceError('--resume is valid only with --apply', 'INVALID_ARGUMENT');
  }
  if (options.transactionId !== null && !TRANSACTION_ID.test(options.transactionId)) {
    throw new ConvergenceError('--transaction-id must be a UUID', 'INVALID_ARGUMENT');
  }
  for (const prefix of ['core', 'feishu']) {
    const fields = [`${prefix}SourceRepo`, `${prefix}SourceCommit`, `${prefix}SourceVersion`];
    const supplied = fields.filter(field => options[field] !== null);
    if (supplied.length > 0 && supplied.length !== fields.length) {
      throw new ConvergenceError(
        `--${prefix}-source-repo, --${prefix}-source-commit, and --${prefix}-source-version must be provided together`,
        'INVALID_ARGUMENT',
      );
    }
    if (options[`${prefix}SourceCommit`] !== null && !FULL_SHA.test(options[`${prefix}SourceCommit`])) {
      throw new ConvergenceError(`--${prefix}-source-commit must be a full immutable 40-hex commit`, 'INVALID_ARGUMENT');
    }
  }
  if (options.resume && (
    options.coreSourceCommit === null
    || options.feishuSourceCommit === null
    || options.transactionId === null
  )) {
    throw new ConvergenceError(
      '--resume requires both exact source identities and --transaction-id',
      'SOURCE_BINDING_MISMATCH',
    );
  }
  return options;
}

function requireRecord(value, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ConvergenceError(`${field} must be an object`, 'INVALID_MANIFEST');
  }
  return value;
}

/** Ensure the independently parsed Core and Feishu manifests name one exact set. */
export function validateConvergenceManifestPair({ coreManifest, feishuManifest } = {}) {
  const core = requireRecord(coreManifest, 'Core manifest');
  const feishu = requireRecord(feishuManifest, 'Feishu manifest');
  if (core.schema !== CORE_SCHEMA || feishu.schema !== FEISHU_SCHEMA) {
    return { ok: false, error: 'unsupported Core or Feishu adoption manifest schema' };
  }
  if (!Array.isArray(core.entries) || !Array.isArray(feishu.entries) || core.entries.length === 0) {
    return { ok: false, error: 'adoption manifests must contain non-empty entries' };
  }
  if (core.entries.length !== feishu.entries.length) {
    return { ok: false, error: 'Core and Feishu adoption manifests have different entry counts' };
  }
  const corePairs = core.entries.map((entry) => `${entry?.externalId}\0${entry?.taskId}`).sort();
  const feishuPairs = feishu.entries.map((entry) => `${entry?.taskGuid}\0${entry?.coreTaskId}`).sort();
  if (corePairs.some((pair, index) => pair !== feishuPairs[index])) {
    return { ok: false, error: 'Core externalId/taskId pairs do not exactly match Feishu taskGuid/coreTaskId pairs' };
  }
  return {
    ok: true,
    appId: feishu.appId,
    entries: corePairs.map(pair => {
      const [taskGuid, coreTaskId] = pair.split('\0');
      return { taskGuid, coreTaskId };
    }),
  };
}

export function buildNativeTaskConvergenceCommands({
  nodePath = process.execPath,
  coreDir,
  feishuDir,
  coreManifest,
  feishuManifest,
  apply = false,
  resume = false,
  transactionId,
  coreSource,
  feishuSource,
} = {}) {
  const coreArgs = [
    path.join(coreDir, 'skills', 'commitment-core', 'scripts', 'legacy-task-adoption.js'),
    '--manifest', coreManifest,
    '--json',
    ...(apply ? ['--commit'] : []),
  ];
  const feishuArgs = [
    path.join(feishuDir, 'scripts', 'task-v2-legacy-adoption-bootstrap.js'),
    '--manifest', feishuManifest,
    ...(apply ? ['--commit'] : []),
  ];
  const reconciliationArgs = [
    path.join(feishuDir, 'src', 'lib', 'task-v2-projection-worker.js'),
    'reconcile',
    ...(apply ? ['--repair-status'] : []),
  ];
  return {
    plans: [
      { name: 'core-plan', command: nodePath, args: coreArgs.filter(value => value !== '--commit') },
      { name: 'feishu-plan', command: nodePath, args: feishuArgs.filter(value => value !== '--commit') },
      { name: 'status-plan', command: nodePath, args: reconciliationArgs.filter(value => value !== '--repair-status') },
    ],
    apply: [
      // Mark the exact remote Task first; a Core commit can then be safely replayed.
      { name: 'feishu-apply', command: nodePath, args: feishuArgs },
      { name: 'core-apply', command: nodePath, args: coreArgs },
      { name: 'status-apply', command: nodePath, args: reconciliationArgs },
      // The repair command reports the pre-repair snapshot. A fresh readback is
      // the only authoritative proof that the status drift actually closed.
      { name: 'status-verify', command: nodePath, args: reconciliationArgs.filter(value => value !== '--repair-status') },
    ],
    resume,
    transactionId: transactionId ?? null,
    sources: { core: coreSource ?? null, feishu: feishuSource ?? null },
  };
}

function parseJsonOutput(result, name) {
  if (result.error || result.status !== 0) {
    throw new ConvergenceError(
      `${name} failed: ${result.error?.message ?? result.stderr?.trim() ?? `exit ${result.status}`}`,
      'CONVERGENCE_STEP_FAILED',
      result.error,
    );
  }
  try {
    return JSON.parse(result.stdout.trim());
  } catch (cause) {
    throw new ConvergenceError(`${name} returned invalid JSON`, 'INVALID_STEP_REPORT', cause);
  }
}

function validateStepReport(name, report) {
  if (name.startsWith('core-') && report?.failed !== 0) {
    throw new ConvergenceError(`${name} reported ${report?.failed ?? 'unknown'} failures`, 'CONVERGENCE_STEP_HOLD');
  }
  if (name.startsWith('feishu-') && report?.status !== 'PASS') {
    throw new ConvergenceError(`${name} did not PASS`, 'CONVERGENCE_STEP_HOLD');
  }
  if (name.startsWith('status-') && (!report || typeof report !== 'object')) {
    throw new ConvergenceError(`${name} returned no reconciliation report`, 'INVALID_STEP_REPORT');
  }
  if (name === 'status-verify' && report.consistent !== true) {
    throw new ConvergenceError('status repair readback is not consistent', 'CONVERGENCE_STEP_HOLD');
  }
  if (name === 'status-verify') {
    for (const field of [
      'missing',
      'unexpected',
      'stateMismatches',
      'duplicateKeys',
      'missingLinks',
      'linkMismatches',
      'reminderDrifts',
    ]) {
      if (!Array.isArray(report[field])) {
        throw new ConvergenceError(`status repair readback omitted ${field}`, 'INVALID_STEP_REPORT');
      }
      if (report[field].length > 0) {
        throw new ConvergenceError(`status repair readback retained ${field}`, 'CONVERGENCE_STEP_HOLD');
      }
    }
  }
}

function buildSourceIdentities(options, fsApi = fs) {
  const hasCore = options.coreSourceCommit !== null;
  const hasFeishu = options.feishuSourceCommit !== null;
  if (!hasCore && !hasFeishu) return null;
  if (!hasCore || !hasFeishu) {
    throw new ConvergenceError('both exact Core and Feishu source identities are required', 'SOURCE_BINDING_MISMATCH');
  }
  return {
    core: sourceIdentity({
      dir: options.coreDir,
      repo: options.coreSourceRepo,
      commit: options.coreSourceCommit,
      version: options.coreSourceVersion,
    }, fsApi),
    feishu: sourceIdentity({
      dir: options.feishuDir,
      repo: options.feishuSourceRepo,
      commit: options.feishuSourceCommit,
      version: options.feishuSourceVersion,
    }, fsApi),
  };
}

function manifestHashIdentity(manifests) {
  return {
    core: manifests.core.sha256,
    feishu: manifests.feishu.sha256,
  };
}

function canonicalReceiptPath(reportDir, stepName) {
  return path.join(reportDir, 'receipts', `${stepName}.json`);
}

function writeCanonicalStepReceipt({
  reportDir,
  step,
  state,
  transactionId,
  manifests,
  sources,
  fsApi = fs,
  details = {},
  now = () => new Date().toISOString(),
}) {
  const filePath = canonicalReceiptPath(reportDir, step.name);
  fsApi.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const previous = readOptionalJson(filePath, fsApi);
  const attempt = state === 'attempted'
    ? Number(previous?.attempt || 0) + 1
    : Number(previous?.attempt || 1);
  const event = {
    state,
    attempt,
    at: now(),
    ...details,
  };
  const receipt = {
    schema: 'zylos.native-task-convergence-step-receipt/v1',
    transactionId,
    step: step.name,
    attempt,
    state,
    status: state.toUpperCase(),
    manifestHashes: manifestHashIdentity(manifests),
    manifestSha256: manifestHashIdentity(manifests),
    sources,
    commandIdentity: commandIdentity(step),
    command: { executable: step.command, args: [...step.args] },
    history: [...(Array.isArray(previous?.history) ? previous.history : []), event],
    ...details,
  };
  atomicWriteJson(filePath, receipt, fsApi);
  return receipt;
}

function readOptionalJson(filePath, fsApi = fs) {
  try {
    return JSON.parse(fsApi.readFileSync(filePath, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw new ConvergenceError(`existing evidence is unreadable: ${filePath}`, 'INVALID_STEP_REPORT', error);
  }
}

function processGroupStatus(pgid) {
  if (!Number.isSafeInteger(pgid) || pgid <= 0) {
    return { state: 'UNKNOWN', reason: 'invalid_process_group' };
  }
  if (process.platform === 'win32') {
    return { state: 'UNKNOWN', reason: 'process_group_probe_unsupported' };
  }
  try {
    process.kill(-pgid, 0);
    return { state: 'ALIVE', reason: 'matching_process_group' };
  } catch (error) {
    if (error?.code === 'ESRCH') return { state: 'DEAD', reason: 'process_group_not_found' };
    return { state: 'UNKNOWN', reason: error?.code || 'process_group_probe_failed' };
  }
}

function isProcessIdentity(value) {
  return Boolean(
    value
    && Number.isSafeInteger(value.pid)
    && value.pid > 0
    && typeof value.startToken === 'string'
    && value.startToken.length > 0,
  );
}

function sameProcessIdentity(left, right) {
  return isProcessIdentity(left)
    && isProcessIdentity(right)
    && left.pid === right.pid
    && left.startToken === right.startToken;
}

function requireLockIdentity(value, field) {
  if (!isProcessIdentity(value)) {
    throw new ConvergenceError(`${field} must contain a process pid and start token`, 'LOCK_FAILED');
  }
  return { pid: value.pid, startToken: value.startToken };
}

function requireLockOwner(lock) {
  if (
    !lock
    || lock.schema !== LOCK_SCHEMA
    || !TRANSACTION_ID.test(String(lock.transactionId ?? ''))
    || typeof lock.hostname !== 'string'
    || typeof lock.runnerToken !== 'string'
    || lock.runnerToken.trim() === ''
    || typeof lock.phase !== 'string'
  ) {
    throw new ConvergenceError('native Task convergence lock owner is invalid', 'LOCK_FAILED');
  }
  requireLockIdentity(lock.parent, 'native Task convergence lock parent');
  if (lock.runner !== null && lock.runner !== undefined) {
    requireLockIdentity(lock.runner, 'native Task convergence lock runner');
  }
  if (lock.child !== null && lock.child !== undefined) {
    requireLockIdentity(lock.child, 'native Task convergence lock child');
    if (process.platform !== 'win32' && (!Number.isSafeInteger(lock.child.pgid) || lock.child.pgid <= 0)) {
      throw new ConvergenceError('native Task convergence lock child process group is invalid', 'LOCK_FAILED');
    }
    if (process.platform === 'win32' && lock.child.pgid !== null && (!Number.isSafeInteger(lock.child.pgid) || lock.child.pgid <= 0)) {
      throw new ConvergenceError('native Task convergence lock child process group is invalid', 'LOCK_FAILED');
    }
  }
  return lock;
}

function readLockFile(lockPath, fsApi = fs) {
  let stat;
  try {
    stat = fsApi.lstatSync(lockPath);
  } catch (cause) {
    throw new ConvergenceError('cannot inspect native Task convergence lock', 'LOCK_FAILED', cause);
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new ConvergenceError('native Task convergence lock is not a regular file', 'LOCK_FAILED');
  }
  let lock;
  try {
    lock = readOptionalJson(lockPath, fsApi);
  } catch (error) {
    throw new ConvergenceError('native Task convergence lock is unreadable', 'LOCK_FAILED', error);
  }
  if (!lock) throw new ConvergenceError('native Task convergence lock is unreadable', 'LOCK_FAILED');
  return requireLockOwner(lock);
}

function inspectStoredIdentity(identity, field) {
  const state = inspectProcessIdentity(identity);
  if (state.state === 'UNKNOWN') {
    throw new ConvergenceError(
      `${field} process identity is UNKNOWN: ${state.reason}`,
      'LOCK_RECOVERY_REQUIRED',
    );
  }
  return state;
}

function rejectLiveOrUnknown(state, field) {
  if (state.state === 'ALIVE') {
    throw new ConvergenceError(`${field} is still alive`, 'LOCK_HELD');
  }
  if (state.state === 'UNKNOWN') {
    throw new ConvergenceError(`${field} identity is UNKNOWN: ${state.reason}`, 'LOCK_RECOVERY_REQUIRED');
  }
}

const ACTIVE_LOCK_PHASES = new Set(['RUNNER_STARTING', 'CHILD_STARTING', 'CHILD_RUNNING']);
const TERMINAL_LOCK_PHASES = new Set([
  'FINISHED',
  'STEP_FAILED',
  'RUNNER_FAILED',
  'CHILD_EXITED_UNKNOWN',
  'DIRECT_ADAPTER_FINISHED',
  'DIRECT_ADAPTER_FAILED',
]);

function verifyStaleLockCanBeReclaimed(existing, processGroupProbe = processGroupStatus) {
  const parentState = inspectStoredIdentity(existing.parent, 'native Task convergence lock parent');
  rejectLiveOrUnknown(parentState, 'native Task convergence lock parent');

  // A runner-starting lock is intentionally ambiguous: the runner may have
  // been spawned but not had a chance to persist its own identity yet.
  if (existing.phase === 'RUNNER_STARTING' && !existing.runner) {
    throw new ConvergenceError(
      'native Task convergence runner start is unverified; recovery is required',
      'LOCK_RECOVERY_REQUIRED',
    );
  }
  if (!TERMINAL_LOCK_PHASES.has(existing.phase) && existing.phase !== 'PARENT_READY' && !ACTIVE_LOCK_PHASES.has(existing.phase)) {
    throw new ConvergenceError(
      `native Task convergence lock phase ${existing.phase} is not recoverable`,
      'LOCK_RECOVERY_REQUIRED',
    );
  }
  if (ACTIVE_LOCK_PHASES.has(existing.phase) && !existing.runner) {
    throw new ConvergenceError(
      `native Task convergence lock phase ${existing.phase} has no runner identity`,
      'LOCK_RECOVERY_REQUIRED',
    );
  }

  if (existing.runner) {
    const runnerState = inspectStoredIdentity(existing.runner, 'native Task convergence lock runner');
    rejectLiveOrUnknown(runnerState, 'native Task convergence lock runner');
  }

  const child = existing.child;
  if (ACTIVE_LOCK_PHASES.has(existing.phase) && existing.phase !== 'RUNNER_STARTING' && !child) {
    throw new ConvergenceError(
      `native Task convergence lock phase ${existing.phase} has no child identity`,
      'LOCK_RECOVERY_REQUIRED',
    );
  }
  if (child) {
    const childState = inspectStoredIdentity(child, 'native Task convergence lock child');
    rejectLiveOrUnknown(childState, 'native Task convergence lock child');
    const groupState = processGroupProbe(child.pgid);
    rejectLiveOrUnknown(groupState, 'native Task convergence child process group');
  }
}

function updateApplyLock(handle, update, fsApi = fs) {
  const current = readLockFile(handle.lockPath, fsApi);
  if (
    current.transactionId !== handle.transactionId
    || !sameProcessIdentity(current.parent, handle.parent)
    || current.runnerToken !== handle.runnerToken
  ) {
    throw new ConvergenceError('native Task convergence lock ownership was lost', 'LOCK_OWNERSHIP_LOST');
  }
  const next = requireLockOwner(update({ ...current }));
  atomicWriteJson(handle.lockPath, next, fsApi);
  return next;
}

function releaseApplyLock(handle, fsApi = fs) {
  const existing = readLockFile(handle.lockPath, fsApi);
  if (
    existing.transactionId !== handle.transactionId
    || !sameProcessIdentity(existing.parent, handle.parent)
    || existing.runnerToken !== handle.runnerToken
  ) {
    throw new ConvergenceError('native Task convergence lock ownership was lost', 'LOCK_RELEASE_FAILED');
  }
  const ownerState = inspectStoredIdentity(existing.parent, 'native Task convergence lock parent');
  if (ownerState.state !== 'ALIVE') {
    throw new ConvergenceError('native Task convergence lock parent is not alive', 'LOCK_RELEASE_FAILED');
  }

  const noWorkStarted = existing.phase === 'PARENT_READY' && !existing.runner && !existing.child;
  const directAdapterFinished = existing.phase === 'DIRECT_ADAPTER_FINISHED'
    || existing.phase === 'DIRECT_ADAPTER_FAILED';
  if (!noWorkStarted && !directAdapterFinished && !TERMINAL_LOCK_PHASES.has(existing.phase)) {
    throw new ConvergenceError(
      `native Task convergence lock is not terminal (${existing.phase})`,
      'LOCK_RELEASE_FAILED',
    );
  }
  if (existing.phase === 'CHILD_EXITED_UNKNOWN') {
    throw new ConvergenceError(
      'native Task convergence step outcome is UNKNOWN; retain lock for verified recovery',
      'LOCK_RELEASE_FAILED',
    );
  }
  if (existing.runner) {
    const runnerState = inspectStoredIdentity(existing.runner, 'native Task convergence lock runner');
    if (runnerState.state !== 'DEAD' || existing.runner.state !== 'EXITED') {
      throw new ConvergenceError('native Task convergence runner has not exited cleanly', 'LOCK_RELEASE_FAILED');
    }
  }
  if (existing.child) {
    const childState = inspectStoredIdentity(existing.child, 'native Task convergence lock child');
    if (childState.state !== 'DEAD' || existing.child.state !== 'EXITED') {
      throw new ConvergenceError('native Task convergence child has not exited cleanly', 'LOCK_RELEASE_FAILED');
    }
    const groupState = processGroupStatus(existing.child.pgid);
    if (groupState.state !== 'DEAD' || existing.child.groupAlive !== false) {
      throw new ConvergenceError('native Task convergence child process group is not fully exited', 'LOCK_RELEASE_FAILED');
    }
  }

  // Re-read immediately before unlinking so a replacement lock cannot be
  // removed after a concurrent recovery attempt.
  const current = readLockFile(handle.lockPath, fsApi);
  if (
    current.transactionId !== handle.transactionId
    || !sameProcessIdentity(current.parent, handle.parent)
    || current.runnerToken !== handle.runnerToken
  ) {
    throw new ConvergenceError('native Task convergence lock changed before release', 'LOCK_RELEASE_FAILED');
  }
  fsApi.unlinkSync(handle.lockPath);
}

function acquireApplyLock({ zylosDir, transactionId, fsApi = fs, hostname = os.hostname() }) {
  const lockDir = path.join(zylosDir, '.zylos', 'locks');
  const lockPath = path.join(lockDir, 'native-task-convergence.lock');
  fsApi.mkdirSync(lockDir, { recursive: true, mode: 0o700 });
  let parent;
  try {
    parent = captureProcessIdentity();
  } catch (cause) {
    throw new ConvergenceError('cannot establish parent process-start identity', 'LOCK_FAILED', cause);
  }
  const owner = {
    schema: LOCK_SCHEMA,
    transactionId,
    hostname,
    pid: parent.pid,
    parent,
    runnerToken: crypto.randomUUID(),
    phase: 'PARENT_READY',
    runner: null,
    child: null,
    acquiredAt: new Date().toISOString(),
  };
  const create = () => fsApi.writeFileSync(
    lockPath,
    `${JSON.stringify(owner, null, 2)}\n`,
    { encoding: 'utf8', mode: 0o600, flag: 'wx' },
  );
  try {
    create();
  } catch (error) {
    if (error?.code !== 'EEXIST') {
      throw new ConvergenceError('cannot acquire native Task convergence lock', 'LOCK_FAILED', error);
    }
    const existing = readLockFile(lockPath, fsApi);
    if (existing.hostname !== hostname) {
      throw new ConvergenceError(
        `native Task convergence lock belongs to host ${existing.hostname}`,
        'LOCK_HELD',
      );
    }
    try {
      verifyStaleLockCanBeReclaimed(existing);
    } catch (error) {
      if (error?.code === 'LOCK_HELD' || error?.code === 'LOCK_RECOVERY_REQUIRED') throw error;
      throw new ConvergenceError('native Task convergence stale lock cannot be verified', 'LOCK_FAILED', error);
    }
    const stalePath = `${lockPath}.stale.${existing.transactionId}.${Date.now()}.${process.pid}`;
    try {
      fsApi.renameSync(lockPath, stalePath);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw new ConvergenceError('cannot retain stale native Task lock', 'LOCK_FAILED', error);
    }
    try {
      create();
    } catch (error) {
      if (error?.code === 'EEXIST') {
        throw new ConvergenceError(
          'native Task convergence lock was acquired concurrently',
          'LOCK_HELD',
          error,
        );
      }
      throw new ConvergenceError('cannot acquire native Task convergence lock', 'LOCK_FAILED', error);
    }
  }
  return {
    transactionId,
    lockPath,
    parent,
    runnerToken: owner.runnerToken,
    release() {
      releaseApplyLock(this, fsApi);
    },
  };
}

function markDirectAdapterTerminal(handle, status, fsApi = fs) {
  updateApplyLock(handle, current => ({
    ...current,
    phase: status === 'PASS' ? 'DIRECT_ADAPTER_FINISHED' : 'DIRECT_ADAPTER_FAILED',
    runner: null,
    // Test adapters return synchronously and do not expose a child process.
    // Keep the child slot empty so the production lock verifier never treats
    // an adapter-only marker as an unverified process identity.
    child: null,
  }), fsApi);
}

function runnerResultAsSpawnResult(result, transactionId) {
  if (
    !result
    || typeof result !== 'object'
    || result.schema !== 'zylos.native-task-convergence-runner-result/v1'
    || result.transactionId !== transactionId
  ) {
    return {
      status: null,
      stdout: '',
      stderr: '',
      error: new Error('controlled runner returned no result'),
    };
  }
  if (result.status === 'PASS') {
    return {
      status: 0,
      stdout: result.stdout || '',
      stderr: result.stderr || '',
      error: null,
    };
  }
  if (result.status === 'HOLD') {
    return {
      status: 1,
      stdout: result.stdout || '',
      stderr: result.stderr || '',
      // A non-zero business exit is deterministic HOLD, not an uncertain
      // runner failure. The existing parser will preserve stderr/exit code.
      error: null,
    };
  }
  return {
    status: null,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    error: new Error(result.error || 'controlled runner outcome is UNKNOWN'),
  };
}

function runControlledStep({
  step,
  attempt,
  reportDir,
  runtimeDir,
  environment,
  lockHandle,
  fsApi = fs,
}) {
  const jobPath = path.join(reportDir, `.${step.name}.attempt-${attempt}.runner-job.json`);
  const resultPath = path.join(reportDir, `.${step.name}.attempt-${attempt}.runner-result.json`);
  const job = {
    schema: RUNNER_JOB_SCHEMA,
    transactionId: lockHandle.transactionId,
    lockPath: lockHandle.lockPath,
    resultPath,
    command: step.command,
    args: step.args,
    cwd: process.cwd(),
    parent: lockHandle.parent,
    runnerToken: lockHandle.runnerToken,
    timeoutMs: 180_000,
  };
  if (fsApi.existsSync(jobPath) || fsApi.existsSync(resultPath)) {
    throw new ConvergenceError(
      `controlled runner evidence already exists for ${step.name} attempt ${attempt}`,
      'RUNNER_EVIDENCE_COLLISION',
    );
  }
  updateApplyLock(lockHandle, current => ({
    ...current,
    // Keep the lock safely reclaimable until the runner has persisted its own
    // process identity. If the parent dies before spawn, no business process
    // exists; if a runner was spawned, a replacement lock makes its ownership
    // check fail before it can start the business command.
    phase: 'PARENT_READY',
    step: { name: step.name, command: step.command, args: step.args, attempt },
    runner: null,
    child: null,
  }), fsApi);
  atomicWriteJson(jobPath, job, fsApi);
  const invocation = spawnSync(process.execPath, [RUNNER_PATH, '--job', jobPath], {
    cwd: process.cwd(),
    env: environment,
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
  });
  const runnerResult = readOptionalJson(resultPath, fsApi);
  if (!runnerResult) {
    const details = invocation.error?.message
      || invocation.stderr?.trim()
      || `controlled runner exited with status ${invocation.status}`;
    return {
      status: null,
      stdout: '',
      stderr: invocation.stderr || '',
      error: new Error(details),
    };
  }
  return runnerResultAsSpawnResult(runnerResult, lockHandle.transactionId);
}

function commandReceipt({
  transactionId,
  manifestSha256,
  step,
  attempt,
  status,
  startedAt,
  finishedAt = null,
  exitCode = null,
  reportPath = null,
  reportSha256 = null,
  error = null,
  sources = null,
}) {
  return {
    schema: STEP_RECEIPT_SCHEMA,
    transactionId,
    manifestSha256,
    step: step.name,
    command: { executable: step.command, args: step.args },
    commandIdentity: commandIdentity(step),
    attempt,
    status,
    manifestHashes: manifestSha256,
    sources,
    attemptedAt: startedAt,
    startedAt,
    finishedAt,
    exitCode,
    reportPath,
    reportSha256,
    error,
  };
}

function previousStepReceipt(reportDir, stepName, fsApi = fs) {
  const prefix = `${stepName}.attempt-`;
  const attempts = fsApi.readdirSync(reportDir)
    .filter(name => name.startsWith(prefix) && name.endsWith('.receipt.json'))
    .map(name => ({
      name,
      attempt: Number(name.slice(prefix.length, -'.receipt.json'.length)),
    }))
    .filter(entry => Number.isInteger(entry.attempt) && entry.attempt > 0)
    .sort((left, right) => right.attempt - left.attempt);
  if (attempts.length === 0) return null;
  return readOptionalJson(path.join(reportDir, attempts[0].name), fsApi);
}

function assertResumeIdentity({ summary, options, manifests, sources, sequence, fsApi = fs }) {
  if (!summary || summary.schema !== REPORT_SCHEMA) {
    throw new ConvergenceError('resume requires a native convergence summary', 'RESUME_STATE_MISSING');
  }
  if (summary.mode !== 'apply' || summary.authorization !== options.authorization) {
    throw new ConvergenceError('resume authorization or mode does not match the transaction', 'SOURCE_BINDING_MISMATCH');
  }
  if (summary.transactionId !== options.transactionId) {
    throw new ConvergenceError('resume transaction id does not match the durable summary', 'SOURCE_BINDING_MISMATCH');
  }
  if (
    summary.manifests?.core?.path !== options.coreManifest
    || summary.manifests?.feishu?.path !== options.feishuManifest
    || summary.manifests?.core?.sha256 !== manifests.core.sha256
    || summary.manifests?.feishu?.sha256 !== manifests.feishu.sha256
  ) {
    throw new ConvergenceError('resume manifest identity does not match the transaction', 'SOURCE_BINDING_MISMATCH');
  }
  if (!sourceIdentityEqual(summary.sources?.core, sources?.core)
    || !sourceIdentityEqual(summary.sources?.feishu, sources?.feishu)) {
    throw new ConvergenceError('resume source directory or immutable commit does not match the transaction', 'SOURCE_BINDING_MISMATCH');
  }
  const expectedCommandIdentities = sequence.map(commandIdentity);
  if (
    summary.invocation?.coreDir !== options.coreDir
    || summary.invocation?.feishuDir !== options.feishuDir
    || !Array.isArray(summary.invocation?.commandIdentities)
    || summary.invocation.commandIdentities.length !== expectedCommandIdentities.length
    || summary.invocation.commandIdentities.some((identity, index) => !commandIdentityMatches(identity, sequence[index]))
  ) {
    throw new ConvergenceError('resume invocation command identity does not match the transaction', 'SOURCE_BINDING_MISMATCH');
  }
  const stepsByName = new Map(sequence.map(step => [step.name, step]));
  for (const step of summary.steps || []) {
    const currentStep = stepsByName.get(step.name);
    if (!currentStep || !commandIdentityMatches(step.commandIdentity, currentStep)) {
      throw new ConvergenceError(`resume command identity does not match ${step.name}`, 'SOURCE_BINDING_MISMATCH');
    }
  }
  const receiptDir = path.join(options.reportDir, 'receipts');
  if (fsApi.existsSync(receiptDir)) {
    for (const entry of fsApi.readdirSync(receiptDir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      const receipt = readOptionalJson(path.join(receiptDir, entry.name), fsApi);
      const currentStep = stepsByName.get(receipt?.step);
      const receiptHashes = receipt?.manifestHashes ?? receipt?.manifestSha256;
      if (!currentStep
        || receipt.transactionId !== summary.transactionId
        || JSON.stringify(receiptHashes) !== JSON.stringify(manifestHashIdentity(manifests))
        || !sourceIdentityEqual(receipt.sources?.core, sources?.core)
        || !sourceIdentityEqual(receipt.sources?.feishu, sources?.feishu)
        || !commandIdentityMatches(receipt.commandIdentity, currentStep)) {
        throw new ConvergenceError(`resume receipt identity does not match ${receipt?.step || entry.name}`, 'SOURCE_BINDING_MISMATCH');
      }
    }
  }
  if (summary.status === 'PASS') return { complete: true };
  if (!['RUNNING', 'HOLD'].includes(summary.status)) {
    throw new ConvergenceError('native convergence transaction has an invalid terminal state', 'RESUME_STATE_INVALID');
  }
  return { complete: false };
}

function recordStepSummary(summary, value) {
  const index = summary.steps.findIndex(step => step.name === value.name);
  if (index === -1) summary.steps.push(value);
  else summary.steps[index] = value;
}

export function runNativeTaskConvergence({
  argv = process.argv.slice(2),
  env = process.env,
  fsApi = fs,
  spawn = spawnSync,
  stdout = process.stdout,
  now = () => new Date().toISOString(),
} = {}) {
  const options = parseArgs(argv);
  fsApi.mkdirSync(options.reportDir, { recursive: true });
  const summaryPath = path.join(options.reportDir, 'summary.json');
  const manifests = {
    core: { path: options.coreManifest, sha256: sha256File(options.coreManifest, fsApi) },
    feishu: { path: options.feishuManifest, sha256: sha256File(options.feishuManifest, fsApi) },
  };
  const manifestSha256 = manifestHashIdentity(manifests);
  const sources = buildSourceIdentities(options, fsApi);
  const runtimeDir = path.resolve(env.ZYLOS_DIR || path.join(os.homedir(), 'zylos'));
  const runtimeHostname = os.hostname();
  const existingSummary = readOptionalJson(summaryPath, fsApi);
  const explicitResume = options.resume;
  const existingSourcesMatch = !existingSummary
    || (existingSummary.sources == null && sources == null)
    || (sourceIdentityEqual(existingSummary.sources?.core, sources?.core)
      && sourceIdentityEqual(existingSummary.sources?.feishu, sources?.feishu));
  const existingTransactionMatch = !existingSummary
    || options.transactionId === null
    || existingSummary.transactionId === options.transactionId;
  const resumable = !explicitResume
    && options.apply
    && existingSummary?.schema === REPORT_SCHEMA
    && existingSummary?.mode === 'apply'
    && TRANSACTION_ID.test(String(existingSummary.transactionId ?? ''))
    && existingSummary.manifests?.core?.sha256 === manifestSha256.core
    && existingSummary.manifests?.feishu?.sha256 === manifestSha256.feishu
    && existingSummary.authorization === options.authorization
    && existingSummary.runtime?.zylosDir === runtimeDir
    && existingSummary.runtime?.hostname === runtimeHostname
    && ['RUNNING', 'HOLD'].includes(existingSummary.status)
    && existingSourcesMatch
    && existingTransactionMatch;
  if (explicitResume && !existingSummary) {
    const hold = {
      schema: REPORT_SCHEMA,
      status: 'HOLD',
      transactionId: options.transactionId,
      code: 'RESUME_STATE_MISSING',
      error: 'resume requires a native convergence summary',
      reportDir: options.reportDir,
    };
    stdout.write(`${JSON.stringify(hold)}\n`);
    return hold;
  }
  if (existingSummary && !explicitResume && !resumable) {
    throw new ConvergenceError(
      'report directory already contains evidence for a different or terminal transaction',
      'REPORT_IDENTITY_MISMATCH',
    );
  }
  const transactionId = explicitResume
    ? options.transactionId
    : resumable
      ? existingSummary.transactionId
      : options.transactionId ?? crypto.randomUUID();
  const commands = buildNativeTaskConvergenceCommands({
    coreDir: options.coreDir,
    feishuDir: options.feishuDir,
    coreManifest: options.coreManifest,
    feishuManifest: options.feishuManifest,
    apply: options.apply,
    resume: options.resume,
    transactionId,
    coreSource: sources?.core,
    feishuSource: sources?.feishu,
  });
  const sequence = options.apply ? [...commands.plans, ...commands.apply] : commands.plans;
  let summary = explicitResume ? existingSummary : {
    schema: REPORT_SCHEMA,
    transactionId,
    status: 'RUNNING',
    mode: options.apply ? 'apply' : 'plan',
    authorization: options.apply ? options.authorization : null,
    startedAt: resumable ? existingSummary.startedAt : now(),
    resumedAt: resumable ? now() : null,
    attempt: resumable ? Number(existingSummary.attempt || 1) + 1 : 1,
    resumeCount: resumable ? Number(existingSummary.resumeCount || 0) + 1 : 0,
    resumePolicy: options.apply ? 'READBACK_THEN_IDEMPOTENT_REPLAY' : null,
    runtime: { zylosDir: runtimeDir, hostname: runtimeHostname },
    manifests,
    sources,
    invocation: {
      coreDir: options.coreDir,
      feishuDir: options.feishuDir,
      commandIdentities: sequence.map(commandIdentity),
    },
    steps: [],
  };
  let lockHandle = null;
  if (!explicitResume && options.apply) {
    lockHandle = acquireApplyLock({ zylosDir: runtimeDir, transactionId, fsApi });
  }
  const controlledRunner = Boolean(options.apply && spawn === spawnSync);
  const childEnvironment = Object.fromEntries(
    Object.entries({ ...env, ZYLOS_DIR: runtimeDir })
      .filter(([key, value]) => typeof key === 'string' && typeof value === 'string'),
  );
  try {
    if (explicitResume) {
      let resumeState;
      try {
        resumeState = assertResumeIdentity({ summary, options, manifests, sources, sequence, fsApi });
      } catch (error) {
        const hold = {
          ...summary,
          status: 'HOLD',
          code: error?.code ?? 'SOURCE_BINDING_MISMATCH',
          error: error?.message ?? String(error),
        };
        stdout.write(`${JSON.stringify(hold)}\n`);
        return hold;
      }
      if (resumeState.complete) {
        stdout.write(`${JSON.stringify(summary)}\n`);
        return summary;
      }
      summary.resumeCount = Number(summary.resumeCount || 0) + 1;
      summary.resumedAt = now();
      summary.status = 'RUNNING';
      delete summary.finishedAt;
      summary.steps = [];
    } else if (resumable && existingSummary.sources) {
      assertResumeIdentity({
        summary: existingSummary,
        options: { ...options, transactionId },
        manifests,
        sources,
        sequence,
        fsApi,
      });
    }

    if (explicitResume && options.apply) {
      lockHandle = acquireApplyLock({ zylosDir: runtimeDir, transactionId, fsApi });
    }
    atomicWriteJson(summaryPath, summary, fsApi);

    const pair = validateConvergenceManifestPair({
      coreManifest: readJson(options.coreManifest, 'Core manifest', fsApi),
      feishuManifest: readJson(options.feishuManifest, 'Feishu manifest', fsApi),
    });
    if (!pair.ok) throw new ConvergenceError(pair.error, 'MANIFEST_PAIR_MISMATCH');
    summary.target = pair;
    summary.manifests = manifests;
    summary.sources = sources;
    summary.invocation = {
      coreDir: options.coreDir,
      feishuDir: options.feishuDir,
      commandIdentities: sequence.map(commandIdentity),
    };
    atomicWriteJson(summaryPath, summary, fsApi);

    for (const step of sequence) {
      const currentReceiptPath = path.join(options.reportDir, `${step.name}.receipt.json`);
      const previousReceipt = previousStepReceipt(options.reportDir, step.name, fsApi);
      const attempt = Number.isInteger(previousReceipt?.attempt) ? previousReceipt.attempt + 1 : 1;
      const receiptPath = path.join(options.reportDir, `${step.name}.attempt-${attempt}.receipt.json`);
      const startedAt = now();
      const receiptBase = {
        transactionId,
        manifestSha256,
        step,
        attempt,
        startedAt,
        sources,
      };
      const writeReceipt = value => {
        atomicWriteJson(receiptPath, value, fsApi);
        atomicWriteJson(currentReceiptPath, value, fsApi);
      };
      const writeCanonical = (state, details = {}) => {
        if (options.apply) {
          writeCanonicalStepReceipt({
            reportDir: options.reportDir,
            step,
            state,
            transactionId,
            manifests,
            sources,
            fsApi,
            details,
            now,
          });
        }
      };
      writeReceipt({
        ...commandReceipt({ ...receiptBase, status: 'ATTEMPTED' }),
        previousStatus: previousReceipt?.status ?? null,
      });
      writeCanonical('attempted');
      writeReceipt({
        ...commandReceipt({ ...receiptBase, status: 'RUNNING' }),
        previousStatus: previousReceipt?.status ?? null,
      });
      writeCanonical('running', { startedAt: now() });
      let result;
      try {
        result = controlledRunner
          ? runControlledStep({
            step,
            attempt,
            reportDir: options.reportDir,
            runtimeDir,
            environment: childEnvironment,
            lockHandle,
            fsApi,
          })
          : spawn(step.command, step.args, {
            env: childEnvironment,
            encoding: 'utf8',
            timeout: 180_000,
            maxBuffer: 8 * 1024 * 1024,
          });
      } catch (error) {
        writeCanonical('unknown', {
          error: error?.message ?? String(error),
          signal: error?.signal ?? null,
          finishedAt: now(),
        });
        if (lockHandle && !controlledRunner) {
          try { markDirectAdapterTerminal(lockHandle, 'HOLD', fsApi); } catch {}
        }
        throw error;
      }
      if (lockHandle && !controlledRunner) {
        markDirectAdapterTerminal(lockHandle, result.status === 0 ? 'PASS' : 'HOLD', fsApi);
      }
      try {
        const report = parseJsonOutput(result, step.name);
        validateStepReport(step.name, report);
        const reportPath = path.join(options.reportDir, `${step.name}.json`);
        atomicWriteJson(reportPath, report, fsApi);
        const reportSha256 = sha256File(reportPath, fsApi);
        const details = {
          exitCode: result.status,
          signal: result.signal ?? null,
          reportPath,
          reportSha256,
          finishedAt: now(),
        };
        writeReceipt(commandReceipt({
          ...receiptBase,
          status: 'PASS',
          ...details,
        }));
        writeCanonical('pass', details);
        recordStepSummary(summary, {
          name: step.name,
          receiptPath,
          currentReceiptPath,
          canonicalReceiptPath: canonicalReceiptPath(options.reportDir, step.name),
          reportPath,
          reportSha256,
          commandIdentity: commandIdentity(step),
        });
        atomicWriteJson(summaryPath, summary, fsApi);
      } catch (error) {
        const uncertain = Boolean(result.error) || result.status === null || Boolean(result.signal);
        const details = {
          exitCode: result.status ?? null,
          signal: result.signal ?? null,
          error: error?.message ?? String(error),
          finishedAt: now(),
        };
        writeReceipt(commandReceipt({
          ...receiptBase,
          status: uncertain ? 'UNKNOWN' : 'HOLD',
          ...details,
        }));
        writeCanonical(uncertain ? 'unknown' : 'hold', details);
        throw error;
      }
    }
    summary.status = 'PASS';
    summary.result = options.apply ? 'CONVERGENCE_APPLIED' : 'PLAN_COMPLETE';
  } catch (error) {
    if (['LOCK_HELD', 'LOCK_FAILED', 'LOCK_RECOVERY_REQUIRED', 'LOCK_OWNERSHIP_LOST'].includes(error?.code)) {
      throw error;
    }
    summary.status = 'HOLD';
    summary.code = error?.code ?? 'CONVERGENCE_FAILED';
    summary.error = error?.message ?? String(error);
  }
  summary.finishedAt = now();
  atomicWriteJson(summaryPath, summary, fsApi);
  if (lockHandle) {
    try {
      lockHandle.release();
    } catch (error) {
      summary.status = 'HOLD';
      summary.code = 'LOCK_RELEASE_FAILED';
      summary.error = `cannot release native Task convergence lock: ${error?.message ?? String(error)}`;
      atomicWriteJson(summaryPath, summary, fsApi);
    }
  }
  stdout.write(`${JSON.stringify(summary)}\n`);
  return summary;
}

const isMain = process.argv[1]
  && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  try {
    const report = runNativeTaskConvergence();
    process.exitCode = report.status === 'PASS' ? 0 : 1;
  } catch (error) {
    process.stderr.write(`${JSON.stringify({
      schema: 'zylos.native-task-convergence-run/error-v1',
      status: 'HOLD',
      code: error?.code ?? 'INVALID_ARGUMENT',
      error: error?.message ?? String(error),
    })}\n`);
    process.exitCode = error?.code === 'INVALID_ARGUMENT' || error?.code === 'INVALID_MANIFEST' ? 2 : 1;
  }
}
