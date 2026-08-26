import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

function linuxStartToken(pid) {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const afterCommand = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/);
    const startTicks = afterCommand[19];
    return startTicks ? `proc:${startTicks}` : null;
  } catch {
    return null;
  }
}

function psStartToken(pid) {
  try {
    const started = execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 2000,
    }).trim().replace(/\s+/g, ' ');
    return started ? `ps:${started}` : null;
  } catch {
    return null;
  }
}

export function readProcessStartToken(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  return linuxStartToken(pid) || psStartToken(pid);
}

export function captureProcessIdentity(pid = process.pid) {
  const startToken = readProcessStartToken(pid);
  if (!startToken) {
    throw new Error(`cannot establish process start identity for PID ${pid}`);
  }
  return { pid, startToken };
}

export function inspectProcessIdentity(identity) {
  if (
    !identity
    || !Number.isSafeInteger(identity.pid)
    || identity.pid <= 0
    || typeof identity.startToken !== 'string'
    || identity.startToken.length === 0
  ) {
    return { state: 'UNKNOWN', reason: 'invalid_identity' };
  }

  const currentStartToken = readProcessStartToken(identity.pid);
  if (currentStartToken) {
    return currentStartToken === identity.startToken
      ? { state: 'ALIVE', reason: 'matching_process_start' }
      : { state: 'DEAD', reason: 'pid_reused' };
  }

  try {
    process.kill(identity.pid, 0);
    return { state: 'UNKNOWN', reason: 'live_pid_without_start_token' };
  } catch (err) {
    return err?.code === 'ESRCH'
      ? { state: 'DEAD', reason: 'process_not_found' }
      : { state: 'UNKNOWN', reason: 'process_status_unavailable' };
  }
}
