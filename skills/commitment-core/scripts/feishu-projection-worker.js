#!/usr/bin/env node

import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { openCommitmentCore } from './core.js';
import { createFeishuTaskProjectionAdapter } from './feishu-task-projection.js';
import { processProjectionBatch } from './projection-worker.js';

const PROJECTION = 'feishu';
const REGISTRATION_ACTOR = 'commitment-feishu-projection';
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

export function initializeFeishuProjection({
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

export async function runFeishuProjectionOnce({
  workerId,
  leaseMs,
  limit,
  retryAfterMs,
  maxAttempts,
  operationId = randomUUID(),
  publisher,
  resolveTarget,
  openCore = openCommitmentCore,
  adapterFactory = createFeishuTaskProjectionAdapter,
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
    const adapter = adapterFactory({ core, publisher, resolveTarget });
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

export async function superviseFeishuProjection({
  workerId,
  leaseMs,
  limit,
  retryAfterMs,
  maxAttempts,
  intervalMs,
  publisher,
  resolveTarget,
  signal,
  runOnce = runFeishuProjectionOnce,
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
        publisher,
        resolveTarget,
        operationId: `${prefix.trim()}:${cycles}`,
      });
      log({
        event: 'commitment_feishu_projection',
        at: clock(),
        cycle: cycles,
        ...summary,
      });
    } catch (error) {
      log({
        event: 'commitment_feishu_projection_failed',
        at: clock(),
        cycle: cycles,
        error: errorDetail(error),
      });
    }
    if (!signal?.aborted) await sleep(intervalMs, signal);
  }

  const result = { cycles, stopReason: 'aborted' };
  log({
    event: 'commitment_feishu_projection_supervisor_stopped',
    at: clock(),
    ...result,
  });
  return result;
}

/**
 * Runtime assembly seam. The selected local module owns Feishu SDK setup and
 * credentials; Commitment Core only receives the narrow publisher Interface.
 */
export async function loadFeishuProjectionRuntime({
  modulePath,
  cwd = process.cwd(),
  importModule = (specifier) => import(specifier),
} = {}) {
  if (typeof modulePath !== 'string' || modulePath.trim() === '') {
    throw new TypeError('modulePath must be a non-empty string');
  }
  if (typeof cwd !== 'string' || cwd.trim() === '') {
    throw new TypeError('cwd must be a non-empty string');
  }
  if (typeof importModule !== 'function') throw new TypeError('importModule must be a function');
  const absolutePath = path.resolve(cwd, modulePath.trim());
  const loaded = await importModule(pathToFileURL(absolutePath).href);
  if (typeof loaded?.createFeishuProjectionRuntime !== 'function') {
    throw new TypeError('runtime module must export createFeishuProjectionRuntime');
  }
  const runtime = await loaded.createFeishuProjectionRuntime();
  if (!runtime || typeof runtime !== 'object' || Array.isArray(runtime)) {
    throw new TypeError('Feishu projection runtime must be an object');
  }
  if (typeof runtime.publisher?.createTask !== 'function'
      || typeof runtime.publisher?.updateTask !== 'function') {
    throw new TypeError('runtime publisher must provide createTask and updateTask');
  }
  if (runtime.resolveTarget !== undefined && typeof runtime.resolveTarget !== 'function') {
    throw new TypeError('runtime resolveTarget must be a function when provided');
  }
  return Object.freeze({
    publisher: runtime.publisher,
    ...(runtime.resolveTarget ? { resolveTarget: runtime.resolveTarget } : {}),
  });
}

function usageError() {
  return new TypeError(
    'usage: feishu-projection-worker.js register --bootstrap-policy <from_now|from_beginning>\n'
      + '   or: feishu-projection-worker.js run --runtime-module <path> [--once]',
  );
}

function parseCliArgs(args) {
  if (args.length === 3 && args[0] === 'register' && args[1] === '--bootstrap-policy') {
    return { command: 'register', bootstrapPolicy: requireBootstrapPolicy(args[2]) };
  }
  if (args[0] === 'run') {
    let modulePath;
    let once = false;
    for (let index = 1; index < args.length; index += 1) {
      const flag = args[index];
      if (flag === '--once' && !once) {
        once = true;
        continue;
      }
      if (flag === '--runtime-module' && modulePath === undefined && args[index + 1]) {
        modulePath = args[index + 1];
        index += 1;
        continue;
      }
      throw usageError();
    }
    if (typeof modulePath !== 'string' || modulePath.trim() === '') throw usageError();
    return { command: 'run', modulePath, once };
  }
  throw usageError();
}

export async function runFeishuProjectionWorkerCli({
  args = process.argv.slice(2),
  env = process.env,
  initialize = initializeFeishuProjection,
  loadRuntime = loadFeishuProjectionRuntime,
  runOnce = runFeishuProjectionOnce,
  supervise = superviseFeishuProjection,
  signal,
  stdout = process.stdout,
} = {}) {
  const command = parseCliArgs(args);
  if (command.command === 'register') {
    const result = initialize({ bootstrapPolicy: command.bootstrapPolicy });
    stdout.write(`${JSON.stringify(result)}\n`);
    return result;
  }
  const runtime = await loadRuntime({ modulePath: command.modulePath });
  const cycleOptions = {
    workerId: env.COMMITMENT_FEISHU_PROJECTION_WORKER_ID
      || `feishu-projection:${os.hostname()}:${process.pid}`,
    limit: integerFromEnv(
      env.COMMITMENT_FEISHU_PROJECTION_BATCH_SIZE,
      'COMMITMENT_FEISHU_PROJECTION_BATCH_SIZE',
      DEFAULT_BATCH_SIZE,
      MAX_BATCH_SIZE,
    ),
    leaseMs: integerFromEnv(
      env.COMMITMENT_FEISHU_PROJECTION_LEASE_MS,
      'COMMITMENT_FEISHU_PROJECTION_LEASE_MS',
      DEFAULT_LEASE_MS,
      MAX_LEASE_MS,
    ),
    retryAfterMs: integerFromEnv(
      env.COMMITMENT_FEISHU_PROJECTION_RETRY_AFTER_MS,
      'COMMITMENT_FEISHU_PROJECTION_RETRY_AFTER_MS',
      DEFAULT_RETRY_AFTER_MS,
      MAX_RETRY_AFTER_MS,
    ),
    maxAttempts: integerFromEnv(
      env.COMMITMENT_FEISHU_PROJECTION_MAX_ATTEMPTS,
      'COMMITMENT_FEISHU_PROJECTION_MAX_ATTEMPTS',
      DEFAULT_MAX_ATTEMPTS,
      MAX_ATTEMPTS,
    ),
    publisher: runtime.publisher,
    resolveTarget: runtime.resolveTarget,
  };
  if (command.once) {
    const result = await runOnce(cycleOptions);
    stdout.write(`${JSON.stringify(result)}\n`);
    return result;
  }
  const intervalMs = integerFromEnv(
    env.COMMITMENT_FEISHU_PROJECTION_INTERVAL_MS,
    'COMMITMENT_FEISHU_PROJECTION_INTERVAL_MS',
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
const shouldAutostart = process.env.COMMITMENT_FEISHU_PROJECTION_AUTOSTART === '1'
  || isMainModule;

if (shouldAutostart) {
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    await runFeishuProjectionWorkerCli({ signal: controller.signal });
  } catch (error) {
    const code = error?.code ? `${error.code}: ` : '';
    process.stderr.write(`feishu-projection-worker: ${code}${error.message}\n`);
    process.exitCode = 1;
  } finally {
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
  }
}
