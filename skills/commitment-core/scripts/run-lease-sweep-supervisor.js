#!/usr/bin/env node

import { openCommitmentCore } from './core.js';
import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEFAULT_RUN_SWEEP_BATCH_SIZE = 25;
export const DEFAULT_RUN_SWEEP_INTERVAL_MS = 2_000;
export const MAX_RUN_SWEEP_BATCH_SIZE = 100;
export const MIN_RUN_SWEEP_INTERVAL_MS = 250;
export const MAX_RUN_SWEEP_INTERVAL_MS = 60_000;
export const MIN_RUN_SWEEP_INSTANCE_LEASE_MS = 10_000;
export const MAX_RUN_SWEEP_INSTANCE_LEASE_MS = MAX_RUN_SWEEP_INTERVAL_MS * 3;

function systemClock() {
  return new Date().toISOString();
}

function sleepUntilNextSweep(intervalMs, signal) {
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

function positiveIntegerFromEnv(
  rawValue,
  name,
  fallback,
  { min = 1, max = Number.MAX_SAFE_INTEGER } = {},
) {
  if (rawValue === undefined || rawValue === '') return fallback;
  const value = Number(rawValue);
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${name} must be a positive integer`);
  }
  if (value < min || value > max) {
    throw new RangeError(`${name} must be between ${min} and ${max}`);
  }
  return value;
}

function requireBoundedInteger(value, name, min, max) {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new TypeError(`${name} must be an integer between ${min} and ${max}`);
  }
  return value;
}

function parseMode(argv) {
  if (argv.length === 0) return { once: false };
  if (argv.length === 1 && argv[0] === '--once') return { once: true };
  throw new TypeError(`usage: run-lease-sweep-supervisor.js [--once]`);
}

function defaultLeaseDbPath() {
  const zylosDir = process.env.ZYLOS_DIR || path.join(os.homedir(), 'zylos');
  return path.join(zylosDir, '.zylos', 'supervisor-leases.db');
}

function requireLeaseClock(clock) {
  const now = clock();
  if (!Number.isSafeInteger(now) || now < 0) {
    throw new TypeError('lease clock must return non-negative epoch milliseconds');
  }
  return now;
}

export function acquireRunSweepLease({
  dbPath = defaultLeaseDbPath(),
  ownerToken,
  clock = () => Date.now(),
  leaseMs,
} = {}) {
  if (typeof ownerToken !== 'string' || ownerToken.trim() === '') {
    throw new TypeError('ownerToken must be a non-empty string');
  }
  if ([...ownerToken].length > 256) {
    throw new TypeError('ownerToken must be at most 256 characters');
  }
  requireBoundedInteger(leaseMs, 'leaseMs', 1, MAX_RUN_SWEEP_INSTANCE_LEASE_MS);
  if (dbPath !== ':memory:') mkdirSync(path.dirname(dbPath), { recursive: true });

  const database = new Database(dbPath);
  database.pragma('busy_timeout = 5000');
  if (dbPath !== ':memory:') database.pragma('journal_mode = WAL');
  database.exec(`
    CREATE TABLE IF NOT EXISTS supervisor_leases (
      name TEXT PRIMARY KEY,
      owner_token TEXT NOT NULL,
      fencing_token INTEGER NOT NULL CHECK (fencing_token >= 1),
      lease_expires_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);

  const leaseName = 'commitment-run-lease-sweep';
  let lease;
  try {
    lease = database.transaction(() => {
      const now = requireLeaseClock(clock);
      const incumbent = database.prepare(`
        SELECT owner_token, fencing_token, lease_expires_at
        FROM supervisor_leases
        WHERE name = ?
      `).get(leaseName);
      if (incumbent && incumbent.lease_expires_at > now) {
        const error = new Error('commitment Run lease sweep is already running');
        error.code = 'ALREADY_RUNNING';
        throw error;
      }

      const fencingToken = incumbent ? incumbent.fencing_token + 1 : 1;
      const expiresAt = now + leaseMs;
      database.prepare(`
        INSERT INTO supervisor_leases (
          name, owner_token, fencing_token, lease_expires_at, updated_at
        ) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(name) DO UPDATE SET
          owner_token = excluded.owner_token,
          fencing_token = excluded.fencing_token,
          lease_expires_at = excluded.lease_expires_at,
          updated_at = excluded.updated_at
      `).run(leaseName, ownerToken, fencingToken, expiresAt, now);
      return { fencingToken, expiresAt };
    }).immediate();
  } catch (error) {
    database.close();
    throw error;
  }

  let closed = false;
  return Object.freeze({
    fencingToken: lease.fencingToken,
    renew() {
      if (closed) {
        const error = new Error('commitment Run lease sweep lease is closed');
        error.code = 'LEASE_LOST';
        throw error;
      }
      const now = requireLeaseClock(clock);
      const expiresAt = now + leaseMs;
      const renewed = database.prepare(`
        UPDATE supervisor_leases
        SET lease_expires_at = ?, updated_at = ?
        WHERE name = ? AND owner_token = ? AND fencing_token = ?
          AND lease_expires_at > ?
      `).run(
        expiresAt,
        now,
        leaseName,
        ownerToken,
        lease.fencingToken,
        now,
      );
      if (renewed.changes !== 1) {
        const error = new Error('commitment Run lease sweep lease ownership was lost');
        error.code = 'LEASE_LOST';
        throw error;
      }
      lease.expiresAt = expiresAt;
      return { fencingToken: lease.fencingToken, expiresAt };
    },
    release() {
      if (closed) return false;
      closed = true;
      try {
        const now = requireLeaseClock(clock);
        // Retain the row so fencing tokens remain monotonic across releases.
        const released = database.prepare(`
          UPDATE supervisor_leases
          SET lease_expires_at = ?, updated_at = ?
          WHERE name = ? AND owner_token = ? AND fencing_token = ?
        `).run(now, now, leaseName, ownerToken, lease.fencingToken);
        return released.changes === 1;
      } finally {
        database.close();
      }
    },
  });
}

export function runLeaseSweepOnce({
  limit,
  openCore = openCommitmentCore,
} = {}) {
  const core = openCore();
  try {
    return core.runs.sweepExpired({ limit });
  } finally {
    core.close();
  }
}

export async function superviseRunLeaseSweep({
  limit,
  intervalMs,
  signal,
  sweep = runLeaseSweepOnce,
  sleep = sleepUntilNextSweep,
  log = writeStructuredLog,
  clock = systemClock,
  renewLease = null,
} = {}) {
  requireBoundedInteger(limit, 'limit', 1, MAX_RUN_SWEEP_BATCH_SIZE);
  requireBoundedInteger(
    intervalMs,
    'intervalMs',
    MIN_RUN_SWEEP_INTERVAL_MS,
    MAX_RUN_SWEEP_INTERVAL_MS,
  );
  let cycles = 0;

  while (!signal?.aborted) {
    renewLease?.();
    cycles += 1;
    try {
      const summary = await sweep({ limit });
      log({
        event: 'commitment_run_lease_sweep',
        at: clock(),
        cycle: cycles,
        ...summary,
      });
    } catch (error) {
      log({
        event: 'commitment_run_lease_sweep_failed',
        at: clock(),
        cycle: cycles,
        error: errorDetail(error),
      });
    }
    if (!signal?.aborted) await sleep(intervalMs, signal);
  }

  const result = { cycles, stopReason: 'aborted' };
  log({
    event: 'commitment_run_lease_sweep_supervisor_stopped',
    at: clock(),
    ...result,
  });
  return result;
}

async function main() {
  const controller = new AbortController();
  const stop = () => controller.abort();
  let instanceLease = null;
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);

  try {
    const { once } = parseMode(process.argv.slice(2));
    const intervalMs = positiveIntegerFromEnv(
      process.env.COMMITMENT_RUN_SWEEP_INTERVAL_MS,
      'COMMITMENT_RUN_SWEEP_INTERVAL_MS',
      DEFAULT_RUN_SWEEP_INTERVAL_MS,
      { min: MIN_RUN_SWEEP_INTERVAL_MS, max: MAX_RUN_SWEEP_INTERVAL_MS },
    );
    const limit = positiveIntegerFromEnv(
      process.env.COMMITMENT_RUN_SWEEP_BATCH_SIZE,
      'COMMITMENT_RUN_SWEEP_BATCH_SIZE',
      DEFAULT_RUN_SWEEP_BATCH_SIZE,
      { max: MAX_RUN_SWEEP_BATCH_SIZE },
    );
    instanceLease = acquireRunSweepLease({
      ownerToken: `process:${process.pid}:${randomUUID()}`,
      leaseMs: Math.max(MIN_RUN_SWEEP_INSTANCE_LEASE_MS, intervalMs * 3),
    });
    writeStructuredLog({
      event: 'commitment_run_lease_sweep_supervisor_started',
      at: systemClock(),
      intervalMs,
      limit,
      once,
      fencingToken: instanceLease.fencingToken,
    });
    if (once) {
      writeStructuredLog({
        event: 'commitment_run_lease_sweep',
        at: systemClock(),
        cycle: 1,
        ...runLeaseSweepOnce({ limit }),
      });
    } else {
      await superviseRunLeaseSweep({
        intervalMs,
        limit,
        signal: controller.signal,
        renewLease: () => instanceLease.renew(),
      });
    }
  } catch (error) {
    writeStructuredLog({
      event: 'commitment_run_lease_sweep_supervisor_fatal',
      at: systemClock(),
      error: errorDetail(error),
    });
    process.exitCode = 1;
  } finally {
    instanceLease?.release();
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
  }
}

const isMainModule = process.argv[1]
  && fileURLToPath(import.meta.url) === process.argv[1];

if (isMainModule) await main();
