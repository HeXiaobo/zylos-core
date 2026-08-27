import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ZYLOS_DIR = process.env.ZYLOS_DIR || path.join(os.homedir(), 'zylos');
const MONITOR_DIR = path.join(ZYLOS_DIR, 'activity-monitor');
const TURN_BINDING_DIR = path.join(MONITOR_DIR, 'assistant-turn-bindings');
const TURN_BINDING_AUDIT_FILE = path.join(MONITOR_DIR, 'assistant-turn-binding-events.jsonl');
const LOCK_TIMEOUT_MS = 1_000;
const STALE_LOCK_MS = 30_000;

function pauseSync(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function acquireLock(lockPath) {
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  while (true) {
    try {
      const descriptor = fs.openSync(lockPath, 'wx', 0o600);
      fs.writeFileSync(descriptor, String(process.pid), 'utf8');
      return () => {
        try { fs.closeSync(descriptor); } catch {}
        try { fs.unlinkSync(lockPath); } catch {}
      };
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      try {
        if (Date.now() - fs.statSync(lockPath).mtimeMs > STALE_LOCK_MS) {
          fs.unlinkSync(lockPath);
          continue;
        }
      } catch (statError) {
        if (statError?.code === 'ENOENT') continue;
        throw statError;
      }
      if (Date.now() >= deadline) throw new Error('assistant turn binding lock timed out');
      pauseSync(5);
    }
  }
}

function turnBindingFile(sessionId) {
  const key = createHash('sha256').update(sessionId).digest('hex');
  return path.join(TURN_BINDING_DIR, `${key}.json`);
}

export function readAssistantTurnBinding(sessionId) {
  try {
    const parsed = JSON.parse(fs.readFileSync(turnBindingFile(sessionId), 'utf8'));
    if (
      parsed?.version === 1
      && parsed.sessionId === sessionId
      && ['bound', 'rejected', 'closed'].includes(parsed.mode)
      && (parsed.requestId === null || typeof parsed.requestId === 'string')
    ) {
      return parsed;
    }
  } catch {
    // Missing/corrupt best-effort state is handled as an unbound turn.
  }
  return null;
}

export function writeAssistantTurnBinding(sessionId, {
  mode,
  requestId = null,
  reason = null,
  nowMs = Date.now(),
  onAuditError = null,
} = {}) {
  fs.mkdirSync(TURN_BINDING_DIR, { recursive: true });
  const file = turnBindingFile(sessionId);
  const release = acquireLock(`${file}.lock`);
  try {
    const existing = readAssistantTurnBinding(sessionId);
    if (existing && existing.updatedAt > nowMs) return existing;
    if (
      existing
      && existing.updatedAt === nowMs
      && existing.mode === mode
      && existing.requestId === requestId
      && existing.reason === reason
    ) {
      return existing;
    }
    const temp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
    const state = {
      version: 1,
      sessionId,
      mode,
      requestId,
      reason,
      updatedAt: nowMs,
    };
    fs.writeFileSync(temp, `${JSON.stringify(state)}\n`, 'utf8');
    fs.renameSync(temp, file);
    try {
      fs.appendFileSync(TURN_BINDING_AUDIT_FILE, `${JSON.stringify(state)}\n`, 'utf8');
    } catch (error) {
      onAuditError?.(error);
    }
    return state;
  } finally {
    release();
  }
}
