#!/usr/bin/env node

import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import Database from 'better-sqlite3';

import { createAttentionViewProjectionAdapter } from './attention-view-projection-adapter.js';
import { openCommitmentCore } from './core.js';
import { processProjectionBatch } from './projection-worker.js';

export const DEFAULT_ATTENTION_PROJECTION_BATCH_SIZE = 25;
export const DEFAULT_ATTENTION_PROJECTION_INTERVAL_MS = 2_000;
export const DEFAULT_ATTENTION_PROJECTION_LEASE_MS = 30_000;
export const DEFAULT_ATTENTION_PROJECTION_RETRY_AFTER_MS = 5_000;
export const DEFAULT_ATTENTION_PROJECTION_MAX_ATTEMPTS = 5;
export const MAX_ATTENTION_PROJECTION_BATCH_SIZE = 100;
export const MIN_ATTENTION_PROJECTION_INTERVAL_MS = 250;
export const MAX_ATTENTION_PROJECTION_INTERVAL_MS = 60_000;
const MAX_LEASE_MS = 86_400_000;
const MAX_RETRY_AFTER_MS = 604_800_000;
const MAX_ATTEMPTS = 100;
const ATTENTION_SINGLETON_NAME = 'commitment-attention-projection';
const ATTENTION_SINGLETON_LEASE_MS = 30_000;
const ATTENTION_SINGLETON_HEARTBEAT_MS = 10_000;

function systemClock() {
  return new Date().toISOString();
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

function writeStructuredLog(event) {
  console.log(JSON.stringify(event));
}

function errorDetail(error) {
  return error?.stack || error?.message || String(error);
}

function requireBoundedInteger(value, name, min, max) {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new TypeError(`${name} must be an integer between ${min} and ${max}`);
  }
  return value;
}

function integerFromEnv(rawValue, name, fallback, min, max) {
  if (rawValue === undefined || rawValue === '') return fallback;
  const value = Number(rawValue);
  return requireBoundedInteger(value, name, min, max);
}

function parseMode(argv) {
  if (argv.length === 0) return { once: false };
  if (argv.length === 1 && argv[0] === '--once') return { once: true };
  throw new TypeError('usage: attention-projection-supervisor.js [--once]');
}

function defaultLeaseDbPath(env = process.env) {
  const zylosDir = env.ZYLOS_DIR || path.join(os.homedir(), 'zylos');
  return path.join(zylosDir, '.zylos', 'supervisor-leases.db');
}

function currentMilliseconds(clock) {
  const value = clock();
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError('singleton lease clock must return non-negative integer milliseconds');
  }
  return value;
}

export function acquireAttentionProjectionLease({
  dbPath = defaultLeaseDbPath(),
  ownerToken = randomUUID(),
  leaseMs = ATTENTION_SINGLETON_LEASE_MS,
  clock = Date.now,
} = {}) {
  requireBoundedInteger(leaseMs, 'singleton leaseMs', 1, MAX_LEASE_MS);
  if (typeof ownerToken !== 'string' || ownerToken.trim() === '') {
    throw new TypeError('singleton ownerToken must be a non-empty string');
  }
  mkdirSync(path.dirname(dbPath), { recursive: true });
  const database = new Database(dbPath);
  database.pragma('busy_timeout = 5000');
  database.pragma('journal_mode = WAL');
  database.exec(`
    CREATE TABLE IF NOT EXISTS commitment_supervisor_leases (
      name TEXT PRIMARY KEY,
      owner_token TEXT NOT NULL,
      lease_expires_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL
    )
  `);
  const acquire = database.prepare(`
    INSERT INTO commitment_supervisor_leases (
      name, owner_token, lease_expires_at_ms, updated_at_ms
    ) VALUES (?, ?, ?, ?)
    ON CONFLICT(name) DO UPDATE SET
      owner_token = excluded.owner_token,
      lease_expires_at_ms = excluded.lease_expires_at_ms,
      updated_at_ms = excluded.updated_at_ms
    WHERE commitment_supervisor_leases.lease_expires_at_ms <= ?
  `);
  const renew = database.prepare(`
    UPDATE commitment_supervisor_leases
    SET lease_expires_at_ms = ?, updated_at_ms = ?
    WHERE name = ? AND owner_token = ? AND lease_expires_at_ms > ?
  `);
  const release = database.prepare(`
    DELETE FROM commitment_supervisor_leases
    WHERE name = ? AND owner_token = ?
  `);

  try {
    const now = currentMilliseconds(clock);
    const expiresAt = now + leaseMs;
    const claimed = database.transaction(() => acquire.run(
      ATTENTION_SINGLETON_NAME,
      ownerToken,
      expiresAt,
      now,
      now,
    )).immediate();
    if (claimed.changes !== 1) {
      const alreadyRunning = new Error('Attention projection is already running');
      alreadyRunning.code = 'ALREADY_RUNNING';
      throw alreadyRunning;
    }
  } catch (error) {
    database.close();
    throw error;
  }

  let closed = false;
  return Object.freeze({
    renew() {
      if (closed) throw new Error('Attention projection singleton lease is closed');
      const now = currentMilliseconds(clock);
      const updated = renew.run(
        now + leaseMs,
        now,
        ATTENTION_SINGLETON_NAME,
        ownerToken,
        now,
      );
      if (updated.changes !== 1) {
        const leaseLost = new Error('Attention projection singleton lease was lost');
        leaseLost.code = 'SINGLETON_LEASE_LOST';
        throw leaseLost;
      }
    },
    release() {
      if (closed) return;
      closed = true;
      try {
        release.run(ATTENTION_SINGLETON_NAME, ownerToken);
      } finally {
        database.close();
      }
    },
  });
}

function assertCycleOptions({ leaseMs, limit, retryAfterMs, maxAttempts, intervalMs }) {
  requireBoundedInteger(limit, 'limit', 1, MAX_ATTENTION_PROJECTION_BATCH_SIZE);
  requireBoundedInteger(leaseMs, 'leaseMs', 1, MAX_LEASE_MS);
  requireBoundedInteger(retryAfterMs, 'retryAfterMs', 1, MAX_RETRY_AFTER_MS);
  requireBoundedInteger(maxAttempts, 'maxAttempts', 1, MAX_ATTEMPTS);
  if (intervalMs !== undefined) {
    requireBoundedInteger(
      intervalMs,
      'intervalMs',
      MIN_ATTENTION_PROJECTION_INTERVAL_MS,
      MAX_ATTENTION_PROJECTION_INTERVAL_MS,
    );
  }
}

export async function initializeAttentionProjection({
  outputPath,
  openCore = openCommitmentCore,
  adapterFactory = createAttentionViewProjectionAdapter,
} = {}) {
  const core = openCore();
  try {
    let registration = null;
    if (typeof core.outbox?.register === 'function') {
      registration = core.outbox.register({
        projection: 'attention',
        bootstrapPolicy: 'from_now',
        actorId: 'commitment-attention-projection',
        idempotencyKey: 'commitment-attention-projection:register:from-now:v1',
      });
    }
    const publication = await adapterFactory({ core, outputPath }).publishCurrent();
    return { registration, publication };
  } finally {
    core.close();
  }
}

export async function runAttentionProjectionOnce({
  workerId,
  leaseMs,
  limit,
  retryAfterMs,
  maxAttempts,
  outputPath,
  operationId = randomUUID(),
  openCore = openCommitmentCore,
  processBatch = processProjectionBatch,
  adapterFactory = createAttentionViewProjectionAdapter,
} = {}) {
  assertCycleOptions({ leaseMs, limit, retryAfterMs, maxAttempts });
  const core = openCore();
  try {
    return await processBatch({
      core,
      projection: 'attention',
      workerId,
      leaseMs,
      limit,
      retryAfterMs,
      maxAttempts,
      operationId,
      adapter: adapterFactory({ core, outputPath }),
    });
  } finally {
    core.close();
  }
}

export async function superviseAttentionProjection({
  workerId,
  leaseMs,
  limit,
  retryAfterMs,
  maxAttempts,
  outputPath,
  intervalMs,
  signal,
  runOnce = runAttentionProjectionOnce,
  operationIdFactory = randomUUID,
  sleep = sleepUntilNextCycle,
  log = writeStructuredLog,
  clock = systemClock,
} = {}) {
  assertCycleOptions({ leaseMs, limit, retryAfterMs, maxAttempts, intervalMs });
  if (typeof operationIdFactory !== 'function') {
    throw new TypeError('operationIdFactory must be a function');
  }
  const supervisorOperationPrefix = operationIdFactory();
  if (typeof supervisorOperationPrefix !== 'string' || supervisorOperationPrefix.trim() === '') {
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
        outputPath,
        operationId: `${supervisorOperationPrefix}:${cycles}`,
      });
      log({
        event: 'commitment_attention_projection',
        at: clock(),
        cycle: cycles,
        ...summary,
      });
    } catch (error) {
      log({
        event: 'commitment_attention_projection_failed',
        at: clock(),
        cycle: cycles,
        error: errorDetail(error),
      });
    }
    if (!signal?.aborted) await sleep(intervalMs, signal);
  }

  const result = { cycles, stopReason: 'aborted' };
  log({
    event: 'commitment_attention_projection_supervisor_stopped',
    at: clock(),
    ...result,
  });
  return result;
}

async function main() {
  const controller = new AbortController();
  const stop = () => controller.abort();
  let singletonLease = null;
  let singletonHeartbeat = null;
  let singletonFailure = null;
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);

  try {
    const { once } = parseMode(process.argv.slice(2));
    const intervalMs = integerFromEnv(
      process.env.COMMITMENT_ATTENTION_PROJECTION_INTERVAL_MS,
      'COMMITMENT_ATTENTION_PROJECTION_INTERVAL_MS',
      DEFAULT_ATTENTION_PROJECTION_INTERVAL_MS,
      MIN_ATTENTION_PROJECTION_INTERVAL_MS,
      MAX_ATTENTION_PROJECTION_INTERVAL_MS,
    );
    const limit = integerFromEnv(
      process.env.COMMITMENT_ATTENTION_PROJECTION_BATCH_SIZE,
      'COMMITMENT_ATTENTION_PROJECTION_BATCH_SIZE',
      DEFAULT_ATTENTION_PROJECTION_BATCH_SIZE,
      1,
      MAX_ATTENTION_PROJECTION_BATCH_SIZE,
    );
    const leaseMs = integerFromEnv(
      process.env.COMMITMENT_ATTENTION_PROJECTION_LEASE_MS,
      'COMMITMENT_ATTENTION_PROJECTION_LEASE_MS',
      DEFAULT_ATTENTION_PROJECTION_LEASE_MS,
      1,
      MAX_LEASE_MS,
    );
    const retryAfterMs = integerFromEnv(
      process.env.COMMITMENT_ATTENTION_PROJECTION_RETRY_AFTER_MS,
      'COMMITMENT_ATTENTION_PROJECTION_RETRY_AFTER_MS',
      DEFAULT_ATTENTION_PROJECTION_RETRY_AFTER_MS,
      1,
      MAX_RETRY_AFTER_MS,
    );
    const maxAttempts = integerFromEnv(
      process.env.COMMITMENT_ATTENTION_PROJECTION_MAX_ATTEMPTS,
      'COMMITMENT_ATTENTION_PROJECTION_MAX_ATTEMPTS',
      DEFAULT_ATTENTION_PROJECTION_MAX_ATTEMPTS,
      1,
      MAX_ATTEMPTS,
    );
    const workerId = process.env.COMMITMENT_ATTENTION_PROJECTION_WORKER_ID
      || `attention-projection:${os.hostname()}:${process.pid}`;
    const outputPath = process.env.COMMITMENT_ATTENTION_VIEW_PATH || undefined;
    singletonLease = acquireAttentionProjectionLease();
    singletonHeartbeat = setInterval(() => {
      try {
        singletonLease.renew();
      } catch (error) {
        singletonFailure = error;
        controller.abort();
      }
    }, ATTENTION_SINGLETON_HEARTBEAT_MS);
    singletonHeartbeat.unref();
    writeStructuredLog({
      event: 'commitment_attention_projection_supervisor_started',
      at: systemClock(),
      workerId,
      intervalMs,
      limit,
      leaseMs,
      retryAfterMs,
      maxAttempts,
      once,
    });
    const cycleOptions = {
      workerId,
      leaseMs,
      limit,
      retryAfterMs,
      maxAttempts,
      outputPath,
    };
    await initializeAttentionProjection({ outputPath });
    if (once) {
      writeStructuredLog({
        event: 'commitment_attention_projection',
        at: systemClock(),
        cycle: 1,
        ...await runAttentionProjectionOnce(cycleOptions),
      });
    } else {
      await superviseAttentionProjection({
        ...cycleOptions,
        intervalMs,
        signal: controller.signal,
      });
    }
    if (singletonFailure) throw singletonFailure;
  } catch (error) {
    writeStructuredLog({
      event: 'commitment_attention_projection_supervisor_fatal',
      at: systemClock(),
      error: errorDetail(error),
    });
    process.exitCode = 1;
  } finally {
    if (singletonHeartbeat) clearInterval(singletonHeartbeat);
    singletonLease?.release();
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
  }
}

const isMainModule = process.argv[1]
  && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);

if (isMainModule) await main();
