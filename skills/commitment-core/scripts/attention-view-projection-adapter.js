import os from 'node:os';
import path from 'node:path';

import { publishAttentionView } from './render-attention-view.js';

function defaultAttentionViewPath(env) {
  const zylosDir = env.ZYLOS_DIR || path.join(os.homedir(), 'zylos');
  return path.join(zylosDir, 'memory', 'task-attention.md');
}

function requireDeliveries(value) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new TypeError('deliveries must be a non-empty array');
  }
  for (const [index, delivery] of value.entries()) {
    if (!delivery || typeof delivery !== 'object' || Array.isArray(delivery)) {
      throw new TypeError(`deliveries[${index}] must be an object`);
    }
    if (delivery.projection !== 'attention') {
      throw new TypeError(`deliveries[${index}].projection must be attention`);
    }
  }
}

/**
 * Adapter at the local Attention projection seam.
 *
 * Atomic replacement makes a repeated batch publication safe after a process
 * exits between publish and acknowledge. Event payloads are only a wake-up
 * signal: the Adapter always rebuilds the current derived view from Core.
 */
export function createAttentionViewProjectionAdapter({
  core,
  outputPath,
  env = process.env,
  clock = () => new Date().toISOString(),
  publish = publishAttentionView,
} = {}) {
  if (!core || typeof core.query !== 'function') {
    throw new TypeError('core.query must be a function');
  }
  const destination = outputPath ?? defaultAttentionViewPath(env);
  if (typeof destination !== 'string' || destination.trim() === '') {
    throw new TypeError('outputPath must be a non-empty string');
  }
  if (typeof clock !== 'function') throw new TypeError('clock must be a function');
  if (typeof publish !== 'function') throw new TypeError('publish must be a function');

  function publishCurrent() {
    return publish({
      core,
      outputPath: destination,
      generatedAt: clock(),
    });
  }

  return Object.freeze({
    publishCurrent,
    publishBatch({ deliveries } = {}) {
      requireDeliveries(deliveries);
      return publishCurrent();
    },
  });
}
