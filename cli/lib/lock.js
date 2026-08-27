/**
 * File-based lock utilities for component upgrades.
 *
 * A lock is owned by a process identity (pid + process-start token) and a
 * random ownership token. Age alone is never enough to reclaim a lock: a
 * live owner may legitimately run longer than LOCK_TIMEOUT_MS.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { LOCKS_DIR } from './config.js';

export const LOCK_TIMEOUT_MS = 10 * 60 * 1000; // informational compatibility constant

const activeTokens = new Map();

function ensureLocksDir() {
  if (fs.existsSync(LOCKS_DIR)) {
    const stat = fs.lstatSync(LOCKS_DIR);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error('locks directory is not a real directory');
    }
    return;
  }
  fs.mkdirSync(LOCKS_DIR, { recursive: true });
}

function getLockPath(component) {
  return path.join(LOCKS_DIR, `${component}.lock`);
}

function isProcessRunning(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

/**
 * Return a PID-reuse-resistant process identity where the host exposes one.
 * Linux's /proc starttime is authoritative. macOS/other hosts use the
 * absolute ps executable without a shell; a missing token is fail-closed.
 */
function processStartToken(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  if (process.platform === 'linux') {
    try {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
      const closingParen = stat.lastIndexOf(')');
      if (closingParen < 0) return null;
      const fields = stat.slice(closingParen + 1).trim().split(/\s+/);
      // fields[0] is state (#3); starttime is field #22 => index 19 here.
      return fields[19] ? `linux:${fields[19]}` : null;
    } catch {
      return null;
    }
  }
  for (const command of ['/bin/ps', '/usr/bin/ps']) {
    try {
      const result = spawnSync(command, ['-p', String(pid), '-o', 'lstart='], {
        encoding: 'utf8',
        shell: false,
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 5000,
      });
      if (result.status === 0 && String(result.stdout || '').trim()) {
        return `ps:${String(result.stdout).trim()}`;
      }
    } catch {
      // Try the next trusted system path.
    }
  }
  return null;
}

const SELF_PROCESS_START = processStartToken(process.pid);

function parseLock(lockPath) {
  let data;
  try {
    data = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
  } catch (error) {
    return { valid: false, error: `lock is unreadable: ${error.message}` };
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { valid: false, error: 'lock is not an object' };
  }
  if (!Number.isInteger(data.pid) || data.pid <= 0 || !Number.isSafeInteger(data.timestamp)) {
    return { valid: false, error: 'lock owner or timestamp is invalid' };
  }
  const token = typeof data.token === 'string' ? data.token : null;
  const processStart = typeof data.processStart === 'string' ? data.processStart : null;
  return { valid: true, data, token, processStart };
}

function ownerState(lock) {
  if (!isProcessRunning(lock.pid)) return 'dead';
  const currentStart = processStartToken(lock.pid);
  if (!currentStart || !lock.processStart) return 'unknown';
  return currentStart === lock.processStart ? 'live' : 'reused';
}

function removeReclaimableLock(lockPath, lock) {
  const state = ownerState(lock);
  // A dead process or a PID that has demonstrably been reused is safe to
  // reclaim. A live/unknown owner is never removed because of age.
  if (state === 'dead' || state === 'reused') {
    try {
      fs.unlinkSync(lockPath);
      return true;
    } catch (error) {
      if (error?.code === 'ENOENT') return true;
      return false;
    }
  }
  return false;
}

/**
 * Acquire a lock for a component.
 * @param {string} component
 * @returns {{ success: boolean, error?: string, existingPid?: number, token?: string }}
 */
export function acquireLock(component) {
  try {
    ensureLocksDir();
  } catch (error) {
    return { success: false, error: `Failed to prepare locks directory: ${error.message}` };
  }
  const lockPath = getLockPath(component);

  if (fs.existsSync(lockPath)) {
    const parsed = parseLock(lockPath);
    if (!parsed.valid) {
      // Do not delete malformed evidence. It may represent an owner whose
      // identity cannot be safely inspected.
      return { success: false, error: `Component "${component}" lock cannot be verified: ${parsed.error}` };
    }
    const state = ownerState(parsed.data);
    if (state === 'live' || state === 'unknown') {
      return {
        success: false,
        error: `Component "${component}" is being upgraded by PID ${parsed.data.pid}`,
        existingPid: parsed.data.pid,
      };
    }
    if (!removeReclaimableLock(lockPath, parsed.data) && fs.existsSync(lockPath)) {
      return { success: false, error: `Component "${component}" lock could not be reclaimed safely`, existingPid: parsed.data.pid };
    }
  }

  const token = crypto.randomUUID();
  const lockData = {
    pid: process.pid,
    timestamp: Date.now(),
    component,
    token,
    processStart: SELF_PROCESS_START,
    owner: { pid: process.pid, processStart: SELF_PROCESS_START },
  };
  try {
    fs.writeFileSync(lockPath, JSON.stringify(lockData, null, 2), { flag: 'wx', mode: 0o600 });
    activeTokens.set(component, token);
    return { success: true, token };
  } catch (error) {
    if (error?.code === 'EEXIST') {
      return { success: false, error: `Component "${component}" lock acquired by another process` };
    }
    return { success: false, error: `Failed to create lock: ${error.message}` };
  }
}

/** Release a lock only when its token and process identity still match. */
export function releaseLock(component) {
  const lockPath = getLockPath(component);
  if (!fs.existsSync(lockPath)) {
    activeTokens.delete(component);
    return { success: true };
  }

  const parsed = parseLock(lockPath);
  if (!parsed.valid) return { success: false, error: parsed.error };
  if (parsed.data.pid !== process.pid) {
    return { success: false, error: `Lock owned by different process (PID ${parsed.data.pid})` };
  }
  if (!SELF_PROCESS_START || parsed.processStart !== SELF_PROCESS_START) {
    return { success: false, error: 'Lock owner process-start identity does not match' };
  }
  const expectedToken = activeTokens.get(component);
  if (!expectedToken || parsed.token !== expectedToken) {
    return { success: false, error: 'Lock ownership token does not match' };
  }

  // Re-read immediately before unlinking to avoid removing a replacement
  // lock created after a race.
  const current = parseLock(lockPath);
  if (!current.valid || current.token !== expectedToken || current.data.pid !== process.pid) {
    return { success: false, error: 'Lock changed before release' };
  }
  try {
    fs.unlinkSync(lockPath);
    activeTokens.delete(component);
    return { success: true };
  } catch (error) {
    return { success: false, error: `Failed to release lock: ${error.message}` };
  }
}

/**
 * Check whether a component is currently locked. Stale files are reported as
 * reclaimable but are not removed by this read-only operation.
 */
export function isLocked(component) {
  const lockPath = getLockPath(component);
  if (!fs.existsSync(lockPath)) return { locked: false };
  const parsed = parseLock(lockPath);
  if (!parsed.valid) return { locked: true, error: parsed.error };
  const age = Math.max(0, Date.now() - parsed.data.timestamp);
  const state = ownerState(parsed.data);
  if (state === 'dead' || state === 'reused') {
    return { locked: false, pid: parsed.data.pid, age, reclaimable: true };
  }
  return {
    locked: true,
    pid: parsed.data.pid,
    age,
    ownerState: state,
    tokenVerified: Boolean(parsed.token),
  };
}
