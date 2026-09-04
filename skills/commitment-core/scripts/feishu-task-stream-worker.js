#!/usr/bin/env node

import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { openCommitmentCore } from './core.js';
import { createFeishuTaskStreamAdapter } from './feishu-task-stream-adapter.js';
import { processProjectionBatch } from './projection-worker.js';

const PROJECTION = 'feishu-task-stream';
const REGISTRATION_ACTOR = 'commitment-feishu-task-stream';
const MAX_BATCH_SIZE = 100;
const MAX_LEASE_MS = 86_400_000;
const MAX_RETRY_AFTER_MS = 604_800_000;
const MAX_ATTEMPTS = 100;
const MIN_INTERVAL_MS = 250;
const MAX_INTERVAL_MS = 60_000;
const DEFAULT_BATCH_SIZE = 25;
const DEFAULT_LEASE_MS = 30_000;
const DEFAULT_RETRY_AFTER_MS = 5_000;
const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_INTERVAL_MS = 2_000;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DEFAULT_C4_DB = path.join(
  process.env.ZYLOS_DIR || path.join(os.homedir(), 'zylos'),
  'comm-bridge',
  'c4.db',
);
const DEFAULT_ASSISTANT_EVENT_SCRIPT = path.resolve(
  __dirname,
  '..', '..', 'comm-bridge', 'scripts', 'c4-assistant-event.js',
);

function requireBoundedInteger(value, field, max) {
  if (!Number.isSafeInteger(value) || value < 1 || value > max) {
    throw new TypeError(`${field} must be an integer between 1 and ${max}`);
  }
  return value;
}

function integerFromEnv(rawValue, field, fallback, max, min = 1) {
  if (rawValue === undefined || rawValue === '') return fallback;
  const value = Number(rawValue);
  requireBoundedInteger(value, field, max);
  if (value < min) throw new TypeError(`${field} must be an integer between ${min} and ${max}`);
  return value;
}

function sleepUntilNextCycle(intervalMs, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(finish, intervalMs);
    function finish() {
      clearTimeout(timer);
      signal?.removeEventListener('abort', finish);
      resolve();
    }
    signal?.addEventListener('abort', finish, { once: true });
  });
}

function errorDetail(error) {
  return [...(error?.stack || error?.message || String(error))].slice(0, 4096).join('');
}

function requireBootstrapPolicy(value) {
  if (value !== 'from_now' && value !== 'from_beginning') {
    throw new TypeError('bootstrapPolicy must be from_now or from_beginning');
  }
  return value;
}

export function initializeTaskStreamProjection({
  bootstrapPolicy,
  openCore = openCommitmentCore,
} = {}) {
  const normalizedPolicy = requireBootstrapPolicy(bootstrapPolicy);
  const core = openCore();
  try {
    return core.outbox.register({
      projection: PROJECTION,
      bootstrapPolicy: normalizedPolicy,
      actorId: REGISTRATION_ACTOR,
      idempotencyKey: `${REGISTRATION_ACTOR}:register:${normalizedPolicy}:v1`,
    });
  } finally {
    core.close();
  }
}

export async function runTaskStreamProjectionOnce({
  workerId,
  leaseMs,
  limit,
  retryAfterMs,
  maxAttempts,
  operationId = randomUUID(),
  c4DbPath = DEFAULT_C4_DB,
  assistantEventScript = DEFAULT_ASSISTANT_EVENT_SCRIPT,
  openCore = openCommitmentCore,
  adapterFactory = createFeishuTaskStreamAdapter,
  processBatch = processProjectionBatch,
} = {}) {
  if (typeof workerId !== 'string' || workerId.trim() === '') {
    throw new TypeError('workerId must be a non-empty string');
  }
  if (typeof operationId !== 'string' || operationId.trim() === '') {
    throw new TypeError('operationId must be a non-empty string');
  }
  requireBoundedInteger(leaseMs, 'leaseMs', MAX_LEASE_MS);
  requireBoundedInteger(limit, 'limit', MAX_BATCH_SIZE);
  requireBoundedInteger(retryAfterMs, 'retryAfterMs', MAX_RETRY_AFTER_MS);
  requireBoundedInteger(maxAttempts, 'maxAttempts', MAX_ATTEMPTS);

  const core = openCore();
  try {
    const adapter = adapterFactory({ core, c4DbPath, assistantEventScript });
    return await processBatch({
      core,
      projection: PROJECTION,
      workerId: workerId.trim(),
      leaseMs,
      limit,
      retryAfterMs,
      maxAttempts,
      operationId: operationId.trim(),
      adapter,
    });
  } finally {
    core.close();
  }
}

export async function superviseTaskStreamProjection({
  workerId,
  leaseMs,
  limit,
  retryAfterMs,
  maxAttempts,
  intervalMs,
  c4DbPath = DEFAULT_C4_DB,
  assistantEventScript = DEFAULT_ASSISTANT_EVENT_SCRIPT,
  signal,
  runOnce = runTaskStreamProjectionOnce,
  initialize = initializeTaskStreamProjection,
  operationIdFactory = randomUUID,
  sleep = sleepUntilNextCycle,
  log = (event) => console.log(JSON.stringify(event)),
  clock = () => new Date().toISOString(),
} = {}) {
  requireBoundedInteger(intervalMs, 'intervalMs', MAX_INTERVAL_MS);
  if (intervalMs < MIN_INTERVAL_MS) {
    throw new TypeError(`intervalMs must be an integer between ${MIN_INTERVAL_MS} and ${MAX_INTERVAL_MS}`);
  }
  if (typeof operationIdFactory !== 'function') {
    throw new TypeError('operationIdFactory must be a function');
  }
  const prefix = operationIdFactory();
  if (typeof prefix !== 'string' || prefix.trim() === '') {
    throw new TypeError('operationIdFactory must return a non-empty string');
  }

  // Self-register on boot (idempotent) so the supervisor needs no separate
  // register step; from_now means only tasks created after rollout stream.
  try {
    initialize({ bootstrapPolicy: 'from_now' });
  } catch (error) {
    log({
      event: 'commitment_feishu_task_stream_register_failed',
      at: clock(),
      error: errorDetail(error),
    });
  }

  let cycles = 0;
  while (!signal?.aborted) {
    cycles += 1;
    try {
      const summary = await runOnce({
        workerId,
        leaseMs,
        limit,
        retryAfterMs,
        maxAttempts,
        c4DbPath,
        assistantEventScript,
        operationId: `${prefix.trim()}:${cycles}`,
      });
      log({ event: 'commitment_feishu_task_stream', at: clock(), cycle: cycles, ...summary });
    } catch (error) {
      log({
        event: 'commitment_feishu_task_stream_failed',
        at: clock(),
        cycle: cycles,
        error: errorDetail(error),
      });
    }
    if (!signal?.aborted) await sleep(intervalMs, signal);
  }

  const result = { cycles, stopReason: 'aborted' };
  log({ event: 'commitment_feishu_task_stream_supervisor_stopped', at: clock(), ...result });
  return result;
}

function usageError() {
  return new TypeError(
    'usage: feishu-task-stream-worker.js register --bootstrap-policy <from_now|from_beginning>\n'
      + '   or: feishu-task-stream-worker.js run [--once]',
  );
}

function parseCliArgs(args) {
  if (args.length >= 1 && args[0] === 'register') {
    let bootstrapPolicy;
    for (let index = 1; index < args.length; index += 1) {
      if (args[index] === '--bootstrap-policy' && args[index + 1]) {
        bootstrapPolicy = args[index + 1];
        index += 1;
        continue;
      }
      throw usageError();
    }
    return { command: 'register', bootstrapPolicy: requireBootstrapPolicy(bootstrapPolicy) };
  }
  if (args[0] === 'run' || args.length === 0) {
    let once = false;
    for (let index = 1; index < args.length; index += 1) {
      if (args[index] === '--once' && !once) {
        once = true;
        continue;
      }
      throw usageError();
    }
    return { command: 'run', once };
  }
  throw usageError();
}

export async function runTaskStreamProjectionWorkerCli({
  args = process.argv.slice(2),
  env = process.env,
  initialize = initializeTaskStreamProjection,
  runOnce = runTaskStreamProjectionOnce,
  supervise = superviseTaskStreamProjection,
  signal,
  stdout = process.stdout,
} = {}) {
  const command = parseCliArgs(args);
  if (command.command === 'register') {
    const result = initialize({ bootstrapPolicy: command.bootstrapPolicy });
    stdout.write(`${JSON.stringify(result)}\n`);
    return result;
  }
  const c4DbPath = env.ZYLOS_C4_DB_PATH || DEFAULT_C4_DB;
  const assistantEventScript = env.ZYLOS_C4_ASSISTANT_EVENT_SCRIPT || DEFAULT_ASSISTANT_EVENT_SCRIPT;
  const cycleOptions = {
    workerId: env.COMMITMENT_FEISHU_TASK_STREAM_WORKER_ID
      || `feishu-task-stream:${os.hostname()}:${process.pid}`,
    limit: integerFromEnv(
      env.COMMITMENT_FEISHU_TASK_STREAM_BATCH_SIZE,
      'COMMITMENT_FEISHU_TASK_STREAM_BATCH_SIZE',
      DEFAULT_BATCH_SIZE,
      MAX_BATCH_SIZE,
    ),
    leaseMs: integerFromEnv(
      env.COMMITMENT_FEISHU_TASK_STREAM_LEASE_MS,
      'COMMITMENT_FEISHU_TASK_STREAM_LEASE_MS',
      DEFAULT_LEASE_MS,
      MAX_LEASE_MS,
    ),
    retryAfterMs: integerFromEnv(
      env.COMMITMENT_FEISHU_TASK_STREAM_RETRY_AFTER_MS,
      'COMMITMENT_FEISHU_TASK_STREAM_RETRY_AFTER_MS',
      DEFAULT_RETRY_AFTER_MS,
      MAX_RETRY_AFTER_MS,
    ),
    maxAttempts: integerFromEnv(
      env.COMMITMENT_FEISHU_TASK_STREAM_MAX_ATTEMPTS,
      'COMMITMENT_FEISHU_TASK_STREAM_MAX_ATTEMPTS',
      DEFAULT_MAX_ATTEMPTS,
      MAX_ATTEMPTS,
    ),
    c4DbPath,
    assistantEventScript,
  };
  if (command.once) {
    const result = await runOnce(cycleOptions);
    stdout.write(`${JSON.stringify(result)}\n`);
    return result;
  }
  const intervalMs = integerFromEnv(
    env.COMMITMENT_FEISHU_TASK_STREAM_INTERVAL_MS,
    'COMMITMENT_FEISHU_TASK_STREAM_INTERVAL_MS',
    DEFAULT_INTERVAL_MS,
    MAX_INTERVAL_MS,
    MIN_INTERVAL_MS,
  );
  return supervise({
    ...cycleOptions,
    intervalMs,
    signal,
    log(event) { stdout.write(`${JSON.stringify(event)}\n`); },
  });
}

const isMainModule = process.argv[1]
  && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
const shouldAutostart = process.env.COMMITMENT_FEISHU_TASK_STREAM_AUTOSTART === '1'
  || isMainModule;

if (shouldAutostart) {
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    await runTaskStreamProjectionWorkerCli({ signal: controller.signal });
  } catch (error) {
    const code = error?.code ? `${error.code}: ` : '';
    process.stderr.write(`feishu-task-stream-worker: ${code}${error.message}\n`);
    process.exitCode = 1;
  } finally {
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
  }
}

// Reference kept for path resolution parity with feishu-projection-worker.
void pathToFileURL;
