#!/usr/bin/env node

import { openCommitmentCore } from './core.js';
import {
  mkdirSync,
  readlinkSync,
  symlinkSync,
  unlinkSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEFAULT_RUN_SWEEP_BATCH_SIZE = 25;
export const DEFAULT_RUN_SWEEP_INTERVAL_MS = 2_000;
export const MAX_RUN_SWEEP_BATCH_SIZE = 100;
export const MIN_RUN_SWEEP_INTERVAL_MS = 250;
export const MAX_RUN_SWEEP_INTERVAL_MS = 60_000;

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

function defaultLockPath() {
  const zylosDir = process.env.ZYLOS_DIR || path.join(os.homedir(), 'zylos');
  return path.join(zylosDir, '.zylos', 'commitment-run-lease-sweep.lock');
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === 'ESRCH') return false;
    if (error?.code === 'EPERM') return true;
    throw error;
  }
}

function acquireSingleInstance(lockPath = defaultLockPath()) {
  mkdirSync(path.dirname(lockPath), { recursive: true });
  const token = `pid:${process.pid}`;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      symlinkSync(token, lockPath);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        try {
          if (readlinkSync(lockPath) === token) unlinkSync(lockPath);
        } catch (error) {
          if (error?.code !== 'ENOENT') throw error;
        }
      };
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      let incumbentToken;
      try {
        incumbentToken = readlinkSync(lockPath);
      } catch (readError) {
        if (readError?.code !== 'ENOENT') throw readError;
        continue;
      }
      const match = /^pid:([1-9]\d*)$/.exec(incumbentToken);
      if (match && processIsAlive(Number(match[1]))) {
        const alreadyRunning = new Error(
          `commitment Run lease sweep is already running as pid ${match[1]}`,
        );
        alreadyRunning.code = 'ALREADY_RUNNING';
        throw alreadyRunning;
      }
      unlinkSync(lockPath);
    }
  }

  throw new Error('could not acquire commitment Run lease sweep instance lock');
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
  let releaseInstance = null;
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
    releaseInstance = acquireSingleInstance();
    writeStructuredLog({
      event: 'commitment_run_lease_sweep_supervisor_started',
      at: systemClock(),
      intervalMs,
      limit,
      once,
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
    releaseInstance?.();
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
  }
}

const isMainModule = process.argv[1]
  && fileURLToPath(import.meta.url) === process.argv[1];

if (isMainModule) await main();
