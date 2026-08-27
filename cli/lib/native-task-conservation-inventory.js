#!/usr/bin/env node

import path from 'node:path';
import crypto from 'node:crypto';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { loadCommitmentCore } from '../commands/task.js';

const ACTIVE_STATES = ['ready', 'in_progress', 'review'];

function fingerprint(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function collectSnapshot(core) {
  const tasks = [];
  const seenTaskIds = new Set();
  const seenCursors = new Set();
  let cursor;
  do {
    const page = core.query({
      limit: 100,
      ...(cursor ? { cursor } : {}),
    });
    if (!Array.isArray(page)) throw new TypeError('Commitment Core task page must be an array');
    for (const task of page) {
      if (!task?.id || !task?.updatedAt) {
        throw new TypeError('Commitment Core task page contains a malformed task');
      }
      if (seenTaskIds.has(task.id)) {
        throw new TypeError(`Commitment Core task pagination repeated ${task.id}`);
      }
      seenTaskIds.add(task.id);
      tasks.push(task);
    }
    if (page.length < 100) break;
    const last = page.at(-1);
    const cursorKey = `${last.updatedAt}\u0000${last.id}`;
    if (seenCursors.has(cursorKey)) {
      throw new TypeError('Commitment Core task pagination repeated a cursor');
    }
    seenCursors.add(cursorKey);
    cursor = { updatedAt: last.updatedAt, taskId: last.id };
  } while (true);

  const externalLinks = tasks.flatMap((task) => {
    const links = core.externalLinks.query({
      taskId: task.id,
      backend: 'feishu-task-v2',
      limit: 100,
    });
    if (!Array.isArray(links)) {
      throw new TypeError(`Commitment Core external links for ${task.id} must be an array`);
    }
    return links;
  });
  return { tasks, externalLinks };
}

/**
 * Read current Task and Feishu-v2 external-link state only through Commitment
 * Core's public Interfaces. The cursor loop makes the inventory independent of
 * the ordinary CLI's display limit.
 */
export async function collectNativeTaskConservationInventory({
  openCore,
  loadCore = loadCommitmentCore,
  agentId = process.env.ZYLOS_AGENT_ID,
} = {}) {
  const normalizedAgentId = String(agentId || '').trim();
  if (!normalizedAgentId) {
    const error = new Error('ZYLOS_AGENT_ID is required for native-task inventory');
    error.code = 'DEPLOYMENT_IDENTITY_INVALID';
    throw error;
  }
  const openCommitmentCore = openCore ?? await loadCore();
  const core = openCommitmentCore();
  try {
    const first = collectSnapshot(core);
    const second = collectSnapshot(core);
    const firstFingerprint = fingerprint(first);
    const secondFingerprint = fingerprint(second);
    if (firstFingerprint !== secondFingerprint) {
      const error = new Error('Commitment Core changed during native-task inventory');
      error.code = 'SNAPSHOT_UNSTABLE';
      throw error;
    }
    return Object.freeze({
      schema: 'zylos.native-task-core-inventory/v1',
      capturedAt: new Date().toISOString(),
      snapshot: {
        stable: true,
        strategy: 'double-read-fingerprint',
        fingerprint: secondFingerprint,
      },
      identity: { agentId: normalizedAgentId },
      activeStates: [...ACTIVE_STATES],
      tasks: second.tasks,
      externalLinks: second.externalLinks,
    });
  } finally {
    core.close();
  }
}

async function main() {
  try {
    const result = await collectNativeTaskConservationInventory();
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(`${error?.code || 'NATIVE_TASK_INVENTORY_FAILED'}: ${error?.message || error}\n`);
    process.exitCode = 1;
  }
}

export function pathsReferToSameFile(left, right) {
  try {
    return realpathSync(left) === realpathSync(right);
  } catch {
    return path.resolve(left) === path.resolve(right);
  }
}

const isMain = process.argv[1]
  && pathsReferToSameFile(process.argv[1], fileURLToPath(import.meta.url));
if (isMain) await main();
