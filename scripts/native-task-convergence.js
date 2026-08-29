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

function atomicWriteJson(filePath, value, fsApi = fs) {
  const temporary = `${filePath}.${process.pid}.tmp`;
  fsApi.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fsApi.renameSync(temporary, filePath);
}

function parseArgs(argv) {
  const options = { plan: false, apply: false, authorization: null };
  const valueFlags = new Map([
    ['--core-manifest', 'coreManifest'],
    ['--feishu-manifest', 'feishuManifest'],
    ['--core-dir', 'coreDir'],
    ['--feishu-dir', 'feishuDir'],
    ['--report-dir', 'reportDir'],
    ['--authorization', 'authorization'],
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--plan' || argument === '--apply') {
      const key = argument.slice(2);
      if (options[key]) throw new ConvergenceError(`duplicate flag: ${argument}`, 'INVALID_ARGUMENT');
      options[key] = true;
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
}) {
  return {
    schema: STEP_RECEIPT_SCHEMA,
    transactionId,
    manifestSha256,
    step: step.name,
    command: { executable: step.command, args: step.args },
    attempt,
    status,
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

export function runNativeTaskConvergence({
  argv = process.argv.slice(2),
  env = process.env,
  fsApi = fs,
  spawn = spawnSync,
  stdout = process.stdout,
} = {}) {
  const options = parseArgs(argv);
  fsApi.mkdirSync(options.reportDir, { recursive: true });
  const summaryPath = path.join(options.reportDir, 'summary.json');
  const manifestSha256 = {
    core: sha256File(options.coreManifest, fsApi),
    feishu: sha256File(options.feishuManifest, fsApi),
  };
  const runtimeDir = path.resolve(env.ZYLOS_DIR || path.join(os.homedir(), 'zylos'));
  const runtimeHostname = os.hostname();
  const existingSummary = readOptionalJson(summaryPath, fsApi);
  const resumable = options.apply
    && existingSummary?.schema === REPORT_SCHEMA
    && existingSummary?.mode === 'apply'
    && TRANSACTION_ID.test(String(existingSummary.transactionId ?? ''))
    && existingSummary.manifests?.core?.sha256 === manifestSha256.core
    && existingSummary.manifests?.feishu?.sha256 === manifestSha256.feishu
    && existingSummary.authorization === options.authorization
    && existingSummary.runtime?.zylosDir === runtimeDir
    && existingSummary.runtime?.hostname === runtimeHostname
    && ['RUNNING', 'HOLD'].includes(existingSummary.status);
  if (existingSummary && !resumable) {
    throw new ConvergenceError(
      'report directory already contains evidence for a different or terminal transaction',
      'REPORT_IDENTITY_MISMATCH',
    );
  }
  const transactionId = resumable ? existingSummary.transactionId : crypto.randomUUID();
  const summary = {
    schema: REPORT_SCHEMA,
    transactionId,
    status: 'RUNNING',
    mode: options.apply ? 'apply' : 'plan',
    authorization: options.apply ? options.authorization : null,
    startedAt: resumable ? existingSummary.startedAt : new Date().toISOString(),
    resumedAt: resumable ? new Date().toISOString() : null,
    attempt: resumable ? Number(existingSummary.attempt || 1) + 1 : 1,
    resumePolicy: options.apply ? 'READBACK_THEN_IDEMPOTENT_REPLAY' : null,
    runtime: { zylosDir: runtimeDir, hostname: runtimeHostname },
    manifests: {
      core: { path: options.coreManifest, sha256: manifestSha256.core },
      feishu: { path: options.feishuManifest, sha256: manifestSha256.feishu },
    },
    steps: [],
  };
  let lockHandle = null;
  if (options.apply) {
    lockHandle = acquireApplyLock({ zylosDir: runtimeDir, transactionId, fsApi });
  }
  const controlledRunner = Boolean(options.apply && spawn === spawnSync);
  const childEnvironment = Object.fromEntries(
    Object.entries({ ...env, ZYLOS_DIR: runtimeDir })
      .filter(([key, value]) => typeof key === 'string' && typeof value === 'string'),
  );
  atomicWriteJson(summaryPath, summary, fsApi);
  try {
    const pair = validateConvergenceManifestPair({
      coreManifest: readJson(options.coreManifest, 'Core manifest', fsApi),
      feishuManifest: readJson(options.feishuManifest, 'Feishu manifest', fsApi),
    });
    if (!pair.ok) throw new ConvergenceError(pair.error, 'MANIFEST_PAIR_MISMATCH');
    summary.target = pair;
    const commands = buildNativeTaskConvergenceCommands({
      coreDir: options.coreDir,
      feishuDir: options.feishuDir,
      coreManifest: options.coreManifest,
      feishuManifest: options.feishuManifest,
      apply: options.apply,
    });
    const sequence = options.apply ? [...commands.plans, ...commands.apply] : commands.plans;
    for (const step of sequence) {
      const currentReceiptPath = path.join(options.reportDir, `${step.name}.receipt.json`);
      const previousReceipt = previousStepReceipt(options.reportDir, step.name, fsApi);
      const attempt = Number.isInteger(previousReceipt?.attempt) ? previousReceipt.attempt + 1 : 1;
      const receiptPath = path.join(options.reportDir, `${step.name}.attempt-${attempt}.receipt.json`);
      const startedAt = new Date().toISOString();
      const receiptBase = {
        transactionId,
        manifestSha256,
        step,
        attempt,
        startedAt,
      };
      const writeReceipt = value => {
        atomicWriteJson(receiptPath, value, fsApi);
        atomicWriteJson(currentReceiptPath, value, fsApi);
      };
      writeReceipt({
        ...commandReceipt({ ...receiptBase, status: 'ATTEMPTED' }),
        previousStatus: previousReceipt?.status ?? null,
      });
      writeReceipt({
        ...commandReceipt({ ...receiptBase, status: 'RUNNING' }),
        previousStatus: previousReceipt?.status ?? null,
      });
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
        writeReceipt(commandReceipt({
          ...receiptBase,
          status: 'PASS',
          finishedAt: new Date().toISOString(),
          exitCode: result.status,
          reportPath,
          reportSha256,
        }));
        summary.steps.push({
          name: step.name,
          receiptPath,
          currentReceiptPath,
          reportPath,
          reportSha256,
        });
        atomicWriteJson(summaryPath, summary, fsApi);
      } catch (error) {
        const uncertain = Boolean(result.error) || result.status === null;
        writeReceipt(commandReceipt({
          ...receiptBase,
          status: uncertain ? 'UNKNOWN' : 'HOLD',
          finishedAt: new Date().toISOString(),
          exitCode: result.status ?? null,
          error: error?.message ?? String(error),
        }));
        throw error;
      }
    }
    summary.status = 'PASS';
    summary.result = options.apply ? 'CONVERGENCE_APPLIED' : 'PLAN_COMPLETE';
  } catch (error) {
    summary.status = 'HOLD';
    summary.code = error?.code ?? 'CONVERGENCE_FAILED';
    summary.error = error?.message ?? String(error);
  }
  summary.finishedAt = new Date().toISOString();
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
