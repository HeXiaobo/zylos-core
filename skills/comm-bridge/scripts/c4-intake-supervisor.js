#!/usr/bin/env node

import { runCommitmentIntakeWorkerOnce } from './c4-intake-worker.js';
import { writeHealthMarker } from './c4-config.js';
import { isMainModule } from './main-module.js';

export const DEFAULT_INTAKE_BATCH_SIZE = 25;
export const DEFAULT_INTAKE_INTERVAL_MS = 2_000;
export const MAX_INTAKE_BATCH_SIZE = 100;
export const MIN_INTAKE_INTERVAL_MS = 250;
export const MAX_INTAKE_INTERVAL_MS = 60_000;
export const DEFAULT_CONSECUTIVE_FAILURE_LIMIT = 20;

function systemClock() {
  return new Date().toISOString();
}

function sleepUntilNextDrain(intervalMs, signal) {
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

function positiveIntegerFromEnv(rawValue, name, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
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

export function drainCommitmentIntake({
  maxItems,
  runOnce = runCommitmentIntakeWorkerOnce,
} = {}) {
  if (!Number.isInteger(maxItems) || maxItems < 1) {
    throw new TypeError('maxItems must be a positive integer');
  }
  const summary = {
    attempted: 0,
    completed: 0,
    retried: 0,
    failed: 0,
    stopReason: 'limit',
  };

  while (summary.attempted < maxItems) {
    const outcome = runOnce();
    if (outcome.status === 'idle') {
      summary.stopReason = 'idle';
      break;
    }
    if (!['completed', 'pending', 'failed'].includes(outcome.status)) {
      throw new Error(`unknown commitment intake worker status: ${outcome.status}`);
    }
    summary.attempted += 1;
    if (outcome.status === 'completed') summary.completed += 1;
    if (outcome.status === 'pending') summary.retried += 1;
    if (outcome.status === 'failed') summary.failed += 1;
  }

  return summary;
}

export async function superviseCommitmentIntake({
  maxItems,
  intervalMs,
  signal,
  drain = drainCommitmentIntake,
  sleep = sleepUntilNextDrain,
  log = writeStructuredLog,
  clock = systemClock,
  failureLimit = DEFAULT_CONSECUTIVE_FAILURE_LIMIT,
  onFirstSuccess = null,
} = {}) {
  let cycles = 0;
  let consecutiveFailures = 0;
  let firstSuccessReported = false;

  while (!signal?.aborted) {
    cycles += 1;
    try {
      const summary = await drain({ maxItems });
      consecutiveFailures = 0;
      if (!firstSuccessReported) {
        firstSuccessReported = true;
        try {
          onFirstSuccess?.();
        } catch (error) {
          log({
            event: 'commitment_intake_health_marker_failed',
            at: clock(),
            error: errorDetail(error),
          });
        }
      }
      log({
        event: 'commitment_intake_drain',
        at: clock(),
        cycle: cycles,
        ...summary,
      });
    } catch (error) {
      consecutiveFailures += 1;
      log({
        event: 'commitment_intake_drain_failed',
        at: clock(),
        cycle: cycles,
        consecutiveFailures,
        failureLimit,
        error: errorDetail(error),
      });
      // Issue #54: per-cycle errors used to be swallowed forever, so a worker
      // whose schema init kept failing stayed "fake alive" for hours while
      // pm2 and the activity monitor reported healthy. A sustained failure
      // streak is a broken deployment, not a busy database — stop the loop so
      // the supervisor exits non-zero and pm2 surfaces it.
      if (Number.isInteger(failureLimit) && failureLimit > 0 && consecutiveFailures >= failureLimit) {
        const result = { cycles, stopReason: 'consecutive_failures', consecutiveFailures };
        log({
          event: 'commitment_intake_supervisor_fatal',
          at: clock(),
          ...result,
        });
        return result;
      }
    }
    if (!signal?.aborted) await sleep(intervalMs, signal);
  }

  const result = { cycles, stopReason: 'aborted' };
  log({
    event: 'commitment_intake_supervisor_stopped',
    at: clock(),
    ...result,
  });
  return result;
}

async function main() {
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);

  try {
    const intervalMs = positiveIntegerFromEnv(
      process.env.C4_INTAKE_INTERVAL_MS,
      'C4_INTAKE_INTERVAL_MS',
      DEFAULT_INTAKE_INTERVAL_MS,
      { min: MIN_INTAKE_INTERVAL_MS, max: MAX_INTAKE_INTERVAL_MS },
    );
    const maxItems = positiveIntegerFromEnv(
      process.env.C4_INTAKE_BATCH_SIZE,
      'C4_INTAKE_BATCH_SIZE',
      DEFAULT_INTAKE_BATCH_SIZE,
      { max: MAX_INTAKE_BATCH_SIZE },
    );
    writeStructuredLog({
      event: 'commitment_intake_supervisor_started',
      at: systemClock(),
      intervalMs,
      maxItems,
    });
    const result = await superviseCommitmentIntake({
      intervalMs,
      maxItems,
      signal: controller.signal,
      failureLimit: positiveIntegerFromEnv(
        process.env.C4_INTAKE_FAILURE_LIMIT,
        'C4_INTAKE_FAILURE_LIMIT',
        DEFAULT_CONSECUTIVE_FAILURE_LIMIT,
      ),
      onFirstSuccess: () => writeHealthMarker('c4-intake-supervisor'),
    });
    if (result?.stopReason === 'consecutive_failures') {
      process.exitCode = 1;
    }
  } catch (error) {
    writeStructuredLog({
      event: 'commitment_intake_supervisor_fatal',
      at: systemClock(),
      error: errorDetail(error),
    });
    process.exitCode = 1;
  } finally {
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
  }
}

const shouldAutostart = process.env.C4_INTAKE_SUPERVISOR_AUTOSTART === '1'
  || isMainModule(import.meta.url, process.argv[1]);

if (shouldAutostart) await main();
