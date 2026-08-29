#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  captureProcessIdentity,
  inspectProcessIdentity,
  readProcessStartToken,
} from '../cli/lib/process-identity.js';

const JOB_SCHEMA = 'zylos.native-task-convergence-runner-job/v1';
const RESULT_SCHEMA = 'zylos.native-task-convergence-runner-result/v1';
const LOCK_SCHEMA = 'zylos.native-task-convergence-lock/v1';
const TRANSACTION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const POLL_MS = 50;
const TERMINATE_GRACE_MS = 2_000;
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

class RunnerError extends Error {
  constructor(message, code = 'RUNNER_FAILED', cause) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'RunnerError';
    this.code = code;
  }
}

function atomicWriteJson(filePath, value) {
  const temporary = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  fs.renameSync(temporary, filePath);
}

function readJson(filePath, field) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (cause) {
    throw new RunnerError(`${field} must be readable JSON`, 'INVALID_RUNNER_JOB', cause);
  }
}

function requireText(value, field) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new RunnerError(`${field} must be a non-empty string`, 'INVALID_RUNNER_JOB');
  }
  return value.trim();
}

function requireIdentity(value, field) {
  if (
    !value
    || typeof value !== 'object'
    || !Number.isSafeInteger(value.pid)
    || value.pid <= 0
    || typeof value.startToken !== 'string'
    || value.startToken.length === 0
  ) {
    throw new RunnerError(`${field} must contain a process pid and start token`, 'INVALID_RUNNER_JOB');
  }
  return { pid: value.pid, startToken: value.startToken };
}

function validateJob(rawJob) {
  if (!rawJob || typeof rawJob !== 'object' || Array.isArray(rawJob)) {
    throw new RunnerError('runner job must be an object', 'INVALID_RUNNER_JOB');
  }
  if (rawJob.schema !== JOB_SCHEMA) {
    throw new RunnerError(`runner job schema must be ${JOB_SCHEMA}`, 'INVALID_RUNNER_JOB');
  }
  const transactionId = requireText(rawJob.transactionId, 'transactionId');
  if (!TRANSACTION_ID.test(transactionId)) {
    throw new RunnerError('transactionId must be a UUID', 'INVALID_RUNNER_JOB');
  }
  const lockPath = path.resolve(requireText(rawJob.lockPath, 'lockPath'));
  const resultPath = path.resolve(requireText(rawJob.resultPath, 'resultPath'));
  const command = requireText(rawJob.command, 'command');
  const args = Array.isArray(rawJob.args) && rawJob.args.every(value => typeof value === 'string')
    ? [...rawJob.args]
    : null;
  if (!args) throw new RunnerError('args must be an array of strings', 'INVALID_RUNNER_JOB');
  const cwd = path.resolve(requireText(rawJob.cwd, 'cwd'));
  const parent = requireIdentity(rawJob.parent, 'parent');
  const runnerToken = requireText(rawJob.runnerToken, 'runnerToken');
  const env = rawJob.env && typeof rawJob.env === 'object' && !Array.isArray(rawJob.env)
    ? { ...rawJob.env }
    : null;
  if (!env || Object.entries(env).some(([key, value]) => (
    typeof key !== 'string' || typeof value !== 'string'
  ))) {
    throw new RunnerError('env must be an object of strings', 'INVALID_RUNNER_JOB');
  }
  const timeoutMs = rawJob.timeoutMs === undefined ? 180_000 : Number(rawJob.timeoutMs);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 1_200_000) {
    throw new RunnerError('timeoutMs must be a positive bounded integer', 'INVALID_RUNNER_JOB');
  }
  return {
    schema: JOB_SCHEMA,
    transactionId,
    lockPath,
    resultPath,
    command,
    args,
    cwd,
    env,
    parent,
    runnerToken,
    timeoutMs,
  };
}

function readLock(lockPath) {
  let stat;
  try {
    stat = fs.lstatSync(lockPath);
  } catch (cause) {
    throw new RunnerError('native Task convergence lock is unreadable', 'LOCK_FAILED', cause);
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new RunnerError('native Task convergence lock is not a regular file', 'LOCK_FAILED');
  }
  const lock = readJson(lockPath, 'native Task convergence lock');
  if (
    !lock
    || lock.schema !== LOCK_SCHEMA
    || typeof lock.transactionId !== 'string'
    || !TRANSACTION_ID.test(lock.transactionId)
    || !lock.parent
    || !Number.isSafeInteger(lock.parent.pid)
    || lock.parent.pid <= 0
    || typeof lock.parent.startToken !== 'string'
    || lock.parent.startToken.length === 0
    || typeof lock.hostname !== 'string'
    || typeof lock.runnerToken !== 'string'
  ) {
    throw new RunnerError('native Task convergence lock owner is invalid', 'LOCK_FAILED');
  }
  return lock;
}

function sameIdentity(left, right) {
  return left?.pid === right?.pid && left?.startToken === right?.startToken;
}

function assertParentAlive(job) {
  const state = inspectProcessIdentity(job.parent);
  if (state.state === 'ALIVE') return state;
  throw new RunnerError(
    state.state === 'UNKNOWN'
      ? `parent process identity is UNKNOWN: ${state.reason}`
      : `parent process is not alive: ${state.reason}`,
    state.state === 'UNKNOWN' ? 'PARENT_IDENTITY_UNKNOWN' : 'PARENT_NOT_ALIVE',
  );
}

function updateLock(job, update) {
  const current = readLock(job.lockPath);
  if (current.transactionId !== job.transactionId) {
    throw new RunnerError('native Task convergence lock transaction changed', 'LOCK_OWNERSHIP_LOST');
  }
  if (!sameIdentity(current.parent, job.parent) || current.runnerToken !== job.runnerToken) {
    throw new RunnerError('native Task convergence lock parent ownership changed', 'LOCK_OWNERSHIP_LOST');
  }
  const next = update({ ...current });
  atomicWriteJson(job.lockPath, next);
  return next;
}

function processGroupStatus(pgid) {
  if (!Number.isSafeInteger(pgid) || pgid <= 0) return { state: 'UNKNOWN', reason: 'invalid_process_group' };
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

function signalProcessGroup(childPid, signal) {
  try {
    if (process.platform === 'win32') process.kill(childPid, signal);
    else process.kill(-childPid, signal);
    return { state: 'SIGNALLED' };
  } catch (error) {
    if (error?.code === 'ESRCH') return { state: 'DEAD' };
    return { state: 'UNKNOWN', reason: error?.code || error?.message || 'signal_failed' };
  }
}

function delay(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

async function waitForProcessGroupExit(pgid, timeoutMs = TERMINATE_GRACE_MS) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    const state = processGroupStatus(pgid);
    if (state.state !== 'ALIVE') return state;
    await delay(POLL_MS);
  }
  return processGroupStatus(pgid);
}

function appendOutput(current, chunk) {
  const text = String(chunk);
  if (current.length >= MAX_OUTPUT_BYTES) return current;
  return `${current}${text}`.slice(0, MAX_OUTPUT_BYTES);
}

function terminalLockUpdate(job, { child, childIdentity, childState, groupAlive, exitCode, signal, error, phase }) {
  return updateLock(job, lock => ({
    ...lock,
    phase,
    runner: {
      ...lock.runner,
      state: 'EXITED',
      finishedAt: new Date().toISOString(),
      exitCode,
      signal,
      error: error || null,
    },
    child: {
      ...(lock.child || {}),
      pid: child?.pid ?? lock.child?.pid ?? null,
      startToken: childIdentity?.startToken ?? lock.child?.startToken ?? null,
      pgid: lock.child?.pgid ?? child?.pid ?? null,
      state: childState,
      groupAlive,
      exitCode,
      signal,
      finishedAt: new Date().toISOString(),
    },
  }));
}

async function runJob(job) {
  const lock = readLock(job.lockPath);
  if (lock.transactionId !== job.transactionId || !sameIdentity(lock.parent, job.parent)) {
    throw new RunnerError('runner job does not match the native Task lock', 'LOCK_OWNERSHIP_LOST');
  }
  if (lock.runnerToken !== job.runnerToken) {
    throw new RunnerError('runner job token does not match the native Task lock', 'LOCK_OWNERSHIP_LOST');
  }
  const runnerIdentity = captureProcessIdentity();
  assertParentAlive(job);
  updateLock(job, current => ({
    ...current,
    phase: 'RUNNER_READY',
    runner: {
      pid: runnerIdentity.pid,
      startToken: runnerIdentity.startToken,
      state: 'READY',
      startedAt: new Date().toISOString(),
    },
    child: null,
  }));
  // The lock update is the parent confirmation. A second identity probe closes
  // the small race where the parent dies between the update and spawn.
  assertParentAlive(job);
  updateLock(job, current => ({
    ...current,
    phase: 'CHILD_STARTING',
  }));

  let child;
  try {
    child = spawn(job.command, job.args, {
      cwd: job.cwd,
      env: job.env,
      detached: process.platform !== 'win32',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (cause) {
    updateLock(job, current => ({
      ...current,
      phase: 'RUNNER_FAILED',
      runner: {
        ...current.runner,
        state: 'EXITED',
        finishedAt: new Date().toISOString(),
        error: cause?.message || String(cause),
      },
      child: null,
    }));
    throw new RunnerError(`business command could not start: ${cause?.message || String(cause)}`, 'BUSINESS_START_FAILED', cause);
  }

  let childIdentity = null;
  const childStartToken = readProcessStartToken(child.pid);
  if (childStartToken) childIdentity = { pid: child.pid, startToken: childStartToken };
  updateLock(job, current => ({
    ...current,
    phase: 'CHILD_RUNNING',
    child: {
      pid: child.pid,
      startToken: childIdentity?.startToken ?? null,
      pgid: process.platform === 'win32' ? null : child.pid,
      state: 'RUNNING',
      startedAt: new Date().toISOString(),
      groupAlive: process.platform === 'win32' ? null : true,
    },
  }));

  let stdout = '';
  let stderr = '';
  child.stdout?.on('data', chunk => { stdout = appendOutput(stdout, chunk); });
  child.stderr?.on('data', chunk => { stderr = appendOutput(stderr, chunk); });

  let parentFailure = null;
  let timeout = false;
  let termination = null;
  const requestTermination = (reason) => {
    if (termination) return termination;
    termination = (async () => {
      signalProcessGroup(child.pid, 'SIGTERM');
      await delay(TERMINATE_GRACE_MS);
      const state = processGroupStatus(process.platform === 'win32' ? child.pid : child.pid);
      if (state.state === 'ALIVE') signalProcessGroup(child.pid, 'SIGKILL');
      return reason;
    })();
    return termination;
  };
  const close = new Promise(resolve => {
    child.once('error', error => resolve({ code: null, signal: null, error }));
    child.once('close', (code, signal) => resolve({ code, signal, error: null }));
  });
  const parentPoller = setInterval(() => {
    const state = inspectProcessIdentity(job.parent);
    if (state.state !== 'ALIVE' && !parentFailure) {
      parentFailure = state;
      void requestTermination(`parent process became ${state.state}: ${state.reason}`);
    }
  }, POLL_MS);
  const timeoutTimer = setTimeout(() => {
    timeout = true;
    void requestTermination(`business command exceeded ${job.timeoutMs}ms`);
  }, job.timeoutMs);
  const outcome = await close;
  clearInterval(parentPoller);
  clearTimeout(timeoutTimer);
  if (termination) await termination;

  const pgid = process.platform === 'win32' ? child.pid : child.pid;
  let group = await waitForProcessGroupExit(pgid);
  if (group.state === 'ALIVE') {
    signalProcessGroup(child.pid, 'SIGKILL');
    group = await waitForProcessGroupExit(pgid);
  }
  const error = parentFailure
    ? `parent process became ${parentFailure.state}: ${parentFailure.reason}`
    : timeout
      ? `business command exceeded ${job.timeoutMs}ms`
      : outcome.error?.message || null;
  const unknown = Boolean(parentFailure) || timeout || Boolean(outcome.error) || group.state === 'UNKNOWN';
  const phase = unknown
    ? 'CHILD_EXITED_UNKNOWN'
    : outcome.code === 0 ? 'FINISHED' : 'STEP_FAILED';
  const childState = group.state === 'DEAD' && !unknown ? 'EXITED' : 'UNKNOWN';
  const lockAfter = terminalLockUpdate(job, {
    child,
    childIdentity,
    childState,
    groupAlive: group.state === 'ALIVE' ? true : group.state === 'UNKNOWN' ? null : false,
    exitCode: outcome.code,
    signal: outcome.signal,
    error,
    phase,
  });
  return {
    schema: RESULT_SCHEMA,
    transactionId: job.transactionId,
    status: unknown ? 'UNKNOWN' : outcome.code === 0 ? 'PASS' : 'HOLD',
    exitCode: outcome.code,
    signal: outcome.signal,
    stdout,
    stderr,
    error,
    groupAlive: lockAfter.child?.groupAlive ?? null,
    runner: lockAfter.runner,
    child: lockAfter.child,
  };
}

function parseJobArgv(argv) {
  if (argv.length !== 2 || argv[0] !== '--job') {
    throw new RunnerError('usage: native-task-convergence-runner.js --job <job.json>', 'INVALID_RUNNER_JOB');
  }
  return path.resolve(requireText(argv[1], '--job'));
}

export async function runNativeTaskConvergenceRunner({ job } = {}) {
  const normalized = validateJob(job);
  return runJob(normalized);
}

const isMain = process.argv[1]
  && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  let job = null;
  try {
    const jobPath = parseJobArgv(process.argv.slice(2));
    job = validateJob(readJson(jobPath, 'runner job'));
    const result = await runJob(job);
    atomicWriteJson(job.resultPath, result);
    process.stdout.write(`${JSON.stringify(result)}\n`);
    process.exitCode = result.status === 'PASS' || result.status === 'HOLD' ? 0 : 1;
  } catch (error) {
    const result = {
      schema: RESULT_SCHEMA,
      transactionId: job?.transactionId ?? null,
      status: 'UNKNOWN',
      exitCode: null,
      signal: null,
      stdout: '',
      stderr: '',
      error: error?.message ?? String(error),
      code: error?.code ?? 'RUNNER_FAILED',
      groupAlive: null,
    };
    if (job?.resultPath) {
      try { atomicWriteJson(job.resultPath, result); } catch {}
    }
    process.stderr.write(`${JSON.stringify(result)}\n`);
    process.exitCode = 1;
  }
}
