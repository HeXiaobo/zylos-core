import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const LOCK_RETRY_MS = 10;
const LOCK_TIMEOUT_MS = 5_000;
const STALE_LOCK_MS = 30_000;
const STALE_STATE_MS = 60 * 60 * 1_000;

function pauseSync(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function digestFor(sessionId, messageId) {
  return createHash('sha256').update(`${sessionId}\0${messageId}`).digest('hex');
}

function atomicWrite(filePath, value) {
  const temporary = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, filePath);
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
      if (Date.now() >= deadline) throw new Error('MessageDisplay sequence lock timed out');
      pauseSync(LOCK_RETRY_MS);
    }
  }
}

function cleanupStaleStates(directory, nowMs) {
  try {
    for (const name of fs.readdirSync(directory)) {
      if (!name.endsWith('.json')) continue;
      const filePath = path.join(directory, name);
      try {
        if (nowMs - fs.statSync(filePath).mtimeMs > STALE_STATE_MS) fs.unlinkSync(filePath);
      } catch {
        // Best-effort cleanup; the owning invocation may be updating the file.
      }
    }
  } catch {
    // Directory creation below handles first use.
  }
}

/**
 * Persist and flush Claude MessageDisplay batches in their declared index
 * order. Claude may start multiple synchronous hook processes close enough
 * together that process scheduling reverses their SQLite writes.
 */
export function sequenceMessageDisplayBatch({
  directory,
  sessionId,
  messageId,
  batchIndex,
  final,
  delta,
  emit,
  nowMs = Date.now(),
}) {
  if (!directory) throw new TypeError('directory is required');
  if (typeof sessionId !== 'string' || !sessionId) throw new TypeError('sessionId is required');
  if (typeof messageId !== 'string' || !messageId) throw new TypeError('messageId is required');
  if (!Number.isSafeInteger(batchIndex) || batchIndex < 0) {
    throw new TypeError('batchIndex must be a non-negative integer');
  }
  if (typeof final !== 'boolean') throw new TypeError('final must be a boolean');
  if (typeof delta !== 'string' || delta.length === 0) throw new TypeError('delta is required');
  if (typeof emit !== 'function') throw new TypeError('emit is required');

  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  cleanupStaleStates(directory, nowMs);
  const digest = digestFor(sessionId, messageId);
  const stateFile = path.join(directory, `${digest}.json`);
  const release = acquireLock(path.join(directory, `${digest}.lock`));
  try {
    let state = null;
    try {
      state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    } catch {
      state = null;
    }
    if (
      !state
      || state.version !== 1
      || state.sessionId !== sessionId
      || state.messageId !== messageId
    ) {
      state = {
        version: 1,
        sessionId,
        messageId,
        nextIndex: 0,
        finalIndex: null,
        completedAt: null,
        batches: {},
      };
    }

    if (batchIndex < state.nextIndex) {
      return { emitted: 0, replayed: true, nextIndex: state.nextIndex };
    }
    const existing = state.batches[String(batchIndex)];
    if (existing && (existing.delta !== delta || existing.final !== final)) {
      throw new Error('MessageDisplay batch index belongs to different content');
    }
    state.batches[String(batchIndex)] = { delta, final };
    if (final) state.finalIndex = batchIndex;
    atomicWrite(stateFile, state);

    let emitted = 0;
    while (Object.hasOwn(state.batches, String(state.nextIndex))) {
      const index = state.nextIndex;
      const batch = state.batches[String(index)];
      emit({ index, delta: batch.delta, final: batch.final });
      delete state.batches[String(index)];
      state.nextIndex += 1;
      emitted += 1;
      atomicWrite(stateFile, state);
    }
    if (state.finalIndex !== null && state.nextIndex > state.finalIndex) {
      state.completedAt = nowMs;
      atomicWrite(stateFile, state);
    }
    return { emitted, replayed: false, nextIndex: state.nextIndex };
  } finally {
    release();
  }
}
