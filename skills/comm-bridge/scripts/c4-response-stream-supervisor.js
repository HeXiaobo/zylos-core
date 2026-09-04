#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

import { SKILLS_DIR, writeHealthMarker } from './c4-config.js';
import { openAssistantResponseStream } from './assistant-response-stream.js';

const DEFAULT_POLL_MS = 250;
const DEFAULT_STALE_SECONDS = 15 * 60;
const DEFAULT_BATCH_SIZE = 100;
const DEFAULT_MAX_ATTEMPTS = 5;

function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function sleep(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

function groupDeliveries(deliveries) {
  const groups = new Map();
  for (const delivery of deliveries) {
    const key = `${delivery.route.channel}\u0000${delivery.event.requestId}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(delivery);
  }
  return [...groups.values()].map(group => group.sort(
    (left, right) => left.event.sequence - right.event.sequence,
  ));
}

function deliverToAdapter(adapterPath, payload, { signal } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('node', [adapterPath], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: process.env,
      signal,
    });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', chunk => {
      if (stderr.length < 16_384) stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', code => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(stderr.trim() || `stream adapter exited ${code}`));
    });
    child.stdin.end(`${JSON.stringify(payload)}\n`);
  });
}

function deliverWithinDeadline(deliver, adapterPath, payload, timeoutMs) {
  const controller = new AbortController();
  let timeout = null;
  const deadline = new Promise((_, reject) => {
    timeout = setTimeout(() => {
      controller.abort();
      const error = new Error(`response stream adapter timed out after ${timeoutMs}ms`);
      error.code = 'ASSISTANT_ADAPTER_TIMEOUT';
      reject(error);
    }, timeoutMs);
  });
  return Promise.race([
    Promise.resolve().then(() => deliver(adapterPath, payload, { signal: controller.signal })),
    deadline,
  ]).finally(() => clearTimeout(timeout));
}

export function createAssistantResponseDeliveryWorker({
  responseStream = openAssistantResponseStream(),
  adapterForChannel = channel => path.join(SKILLS_DIR, channel, 'scripts', 'stream.js'),
  adapterExists = fs.existsSync,
  deliver = deliverToAdapter,
  clock = () => Math.floor(Date.now() / 1000),
  batchSize = DEFAULT_BATCH_SIZE,
  staleSeconds = DEFAULT_STALE_SECONDS,
  maxAttempts = DEFAULT_MAX_ATTEMPTS,
  retryDelaySeconds = 2,
  deliveryTimeoutMs = 30_000,
  logger = console,
} = {}) {
  if (!Number.isSafeInteger(deliveryTimeoutMs) || deliveryTimeoutMs < 1) {
    throw new TypeError('deliveryTimeoutMs must be a positive integer');
  }
  return Object.freeze({
    async drainOnce() {
      const expired = responseStream.execute({
        type: 'ExpireStaleRuns',
        staleBefore: clock() - staleSeconds,
      }).events.length;
      const deliveries = responseStream.claimDeliveries({ limit: batchSize });
      const groups = groupDeliveries(deliveries);
      let acknowledged = 0;
      let retried = 0;
      let deadLettered = 0;

      for (const group of groups) {
        const [{ route, event }] = group;
        const adapterPath = adapterForChannel(route.channel);
        try {
          if (!adapterExists(adapterPath)) {
            throw new Error(`response stream adapter not found for channel ${route.channel}`);
          }
          await deliverWithinDeadline(deliver, adapterPath, {
            schemaVersion: 1,
            requestId: event.requestId,
            route,
            events: group.map(item => item.event),
          }, deliveryTimeoutMs);
          const results = responseStream.acknowledgeDeliveries(group.map(item => ({
            deliveryId: item.deliveryId,
            leaseToken: item.leaseToken,
          })));
          acknowledged += results.filter(item => item.acknowledged).length;
        } catch (err) {
          const results = responseStream.retryDeliveries(group.map(item => ({
            deliveryId: item.deliveryId,
            leaseToken: item.leaseToken,
            error: err?.message || 'stream adapter failed',
          })), { maxAttempts, delaySeconds: retryDelaySeconds });
          retried += results.filter(item => item.status === 'pending').length;
          deadLettered += results.filter(item => item.status === 'dead_letter').length;
          logger.warn?.('assistant response stream delivery failed', {
            channel: route.channel,
            requestId: event.requestId,
            error: err?.message || String(err),
          });
        }
      }

      return {
        expired,
        claimed: deliveries.length,
        groups: groups.length,
        acknowledged,
        retried,
        deadLettered,
      };
    },
    close() {
      responseStream.close();
    },
  });
}

let shuttingDown = false;

export const DEFAULT_CONSECUTIVE_FAILURE_LIMIT = 20;

/**
 * Delivery loop extracted from main() so the failure policy is testable.
 * Issue #54: per-drain errors used to be swallowed forever, so a worker whose
 * database never initialized stayed "fake alive" while pm2 reported healthy.
 * A sustained failure streak now stops the loop; main() exits non-zero and
 * pm2 surfaces the broken deployment.
 */
export async function runAssistantResponseDeliveryLoop({
  worker,
  pollMs,
  sleep: sleepFn = sleep,
  shouldContinue,
  failureLimit = DEFAULT_CONSECUTIVE_FAILURE_LIMIT,
  logger = console,
  onFirstSuccess = null,
}) {
  let consecutiveFailures = 0;
  let firstSuccessReported = false;
  while (shouldContinue()) {
    try {
      const result = await worker.drainOnce();
      consecutiveFailures = 0;
      if (!firstSuccessReported) {
        firstSuccessReported = true;
        try {
          onFirstSuccess?.();
        } catch (err) {
          logger.error?.(`[C4] Response stream health marker write failed: ${err?.message || err}`);
        }
      }
      if (result.claimed > 0 || result.expired > 0) {
        logger.log(`[C4] Response stream drain ${JSON.stringify(result)}`);
      }
    } catch (err) {
      consecutiveFailures += 1;
      logger.error(`[C4] Response stream supervisor error (${consecutiveFailures}/${failureLimit}): ${err.stack || err.message}`);
      if (Number.isInteger(failureLimit) && failureLimit > 0 && consecutiveFailures >= failureLimit) {
        return { stopReason: 'consecutive_failures', consecutiveFailures };
      }
    }
    if (shouldContinue()) await sleepFn(pollMs);
  }
  return { stopReason: 'stopped' };
}

async function main() {
  const pollMs = positiveInteger(process.env.C4_RESPONSE_STREAM_POLL_MS, DEFAULT_POLL_MS);
  // The stream opens its database eagerly at worker creation: an init failure
  // throws out of main() and exits non-zero, so pm2 restarts instead of the
  // supervisor idling without a working database.
  const worker = createAssistantResponseDeliveryWorker({
    batchSize: positiveInteger(process.env.C4_RESPONSE_STREAM_BATCH_SIZE, DEFAULT_BATCH_SIZE),
    staleSeconds: positiveInteger(process.env.C4_RESPONSE_STREAM_STALE_SECONDS, DEFAULT_STALE_SECONDS),
    maxAttempts: positiveInteger(process.env.C4_RESPONSE_STREAM_MAX_ATTEMPTS, DEFAULT_MAX_ATTEMPTS),
    deliveryTimeoutMs: positiveInteger(process.env.C4_RESPONSE_STREAM_DELIVERY_TIMEOUT_MS, 30_000),
  });
  const shutdown = () => { shuttingDown = true; };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  console.log('[C4] Assistant response stream supervisor started');
  const result = await runAssistantResponseDeliveryLoop({
    worker,
    pollMs,
    shouldContinue: () => !shuttingDown,
    onFirstSuccess: () => writeHealthMarker('c4-response-stream-supervisor'),
  });
  if (result.stopReason === 'consecutive_failures') {
    process.exitCode = 1;
  }
  worker.close();
}

if (process.env.C4_RESPONSE_STREAM_AUTOSTART === '1') {
  main();
}
