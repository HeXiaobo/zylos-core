import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  sanitizePublicReasoningDelta,
  splitPublicReasoningText,
  stripPublicReasoningLines,
} from '../../comm-bridge/scripts/assistant-public-reasoning.js';

const CODEX_DIR = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
const CODEX_STATE_DB = path.join(CODEX_DIR, 'state_5.sqlite');
const CODEX_SESSIONS_DIR = path.join(CODEX_DIR, 'sessions');
const REQUEST_MARKER = /assistant request:\s*"([A-Za-z0-9][A-Za-z0-9._:-]*)"/;
const MAX_ROLLOUT_READ_BYTES = 1024 * 1024;

function readDirSafe(dir) {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

export function findActiveCodexRolloutPath({
  stateDb = CODEX_STATE_DB,
  sessionsDir = CODEX_SESSIONS_DIR,
} = {}) {
  try {
    const sql = [
      'SELECT rollout_path FROM threads',
      'WHERE archived = 0',
      'ORDER BY updated_at DESC',
      'LIMIT 1;',
    ].join(' ');
    const result = execFileSync('sqlite3', [stateDb, sql], {
      encoding: 'utf8',
      stdio: 'pipe',
      timeout: 5_000,
    }).trim();
    if (result && fs.existsSync(result)) return result;
  } catch {
    // Minimal servers may not have sqlite3; use the sessions tree instead.
  }

  let newestPath = null;
  let newestMtimeMs = 0;
  for (const year of readDirSafe(sessionsDir)) {
    for (const month of readDirSafe(path.join(sessionsDir, year))) {
      for (const day of readDirSafe(path.join(sessionsDir, year, month))) {
        const dayDir = path.join(sessionsDir, year, month, day);
        for (const file of readDirSafe(dayDir)) {
          if (!file.startsWith('rollout-') || !file.endsWith('.jsonl')) continue;
          const candidate = path.join(dayDir, file);
          try {
            const { mtimeMs } = fs.statSync(candidate);
            if (mtimeMs > newestMtimeMs) {
              newestMtimeMs = mtimeMs;
              newestPath = candidate;
            }
          } catch {
            // Ignore a file that disappeared during the scan.
          }
        }
      }
    }
  }
  return newestPath;
}

function messageText(payload) {
  if (!Array.isArray(payload?.content)) return '';
  return payload.content
    .filter(part => part && typeof part === 'object' && typeof part.text === 'string')
    .map(part => part.text)
    .join('');
}

function summaryTexts(payload) {
  if (!Array.isArray(payload?.summary)) return [];
  return payload.summary
    .map(part => {
      if (typeof part === 'string') return part;
      return typeof part?.text === 'string' ? part.text : '';
    })
    .filter(Boolean);
}

function eventKey(kind, recordKey, index = 0) {
  const digest = createHash('sha256')
    .update(`${kind}\0${recordKey}\0${index}`)
    .digest('hex')
    .slice(0, 32);
  return `codex:${kind}:${digest}`;
}

function loadState(stateFile) {
  try {
    const parsed = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    if (
      parsed?.version === 1
      && typeof parsed.rolloutPath === 'string'
      && Number.isSafeInteger(parsed.offset)
      && parsed.offset >= 0
    ) {
      return parsed;
    }
  } catch {
    // First start or corrupt best-effort state; initialize from the rollout.
  }
  return null;
}

function writeState(stateFile, state) {
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  const tempFile = `${stateFile}.${process.pid}.tmp`;
  fs.writeFileSync(tempFile, `${JSON.stringify(state)}\n`, 'utf8');
  fs.renameSync(tempFile, stateFile);
}

/**
 * Tail the active Codex rollout and map only documented/public UI events onto
 * the runtime-neutral assistant response stream. It deliberately never reads
 * reasoning.raw_content or reasoning.encrypted_content.
 */
export function createCodexResponseStreamAdapter({
  stateFile,
  resolveRolloutPath = findActiveCodexRolloutPath,
  responseStream,
  startAtEnd = true,
  log = () => {},
} = {}) {
  if (!stateFile) throw new TypeError('stateFile is required');
  if (!responseStream || typeof responseStream.execute !== 'function') {
    throw new TypeError('responseStream.execute is required');
  }

  let state = loadState(stateFile);

  if (!state) {
    const initialPath = resolveRolloutPath();
    if (initialPath) {
      try {
        const initialStat = fs.statSync(initialPath);
        state = {
          version: 1,
          rolloutPath: initialPath,
          offset: startAtEnd ? initialStat.size : 0,
          requestId: null,
        };
        writeState(stateFile, state);
      } catch {
        // The rollout may rotate between discovery and stat; retry on tick.
      }
    }
  }

  function initializeState(rolloutPath, stat) {
    if (state?.rolloutPath === rolloutPath) {
      if (state.offset > stat.size) state.offset = 0;
      return;
    }
    state = {
      version: 1,
      rolloutPath,
      // A different path appeared after this adapter started, so it is a new
      // Codex session and must be consumed from its first complete record.
      offset: 0,
      requestId: null,
    };
    writeState(stateFile, state);
  }

  function execute(command) {
    try {
      return responseStream.execute(command);
    } catch (error) {
      log(`Codex response stream ignored ${command.type}: ${error.message}`);
      return null;
    }
  }

  function processRecord(record, recordKey) {
    const payload = record?.payload;
    if (!payload || typeof payload !== 'object') return;

    if (record.type === 'response_item' && payload.type === 'message') {
      const text = messageText(payload);
      if (payload.role === 'user') {
        const requestId = text.match(REQUEST_MARKER)?.[1] || null;
        if (requestId) state.requestId = requestId;
        return;
      }
      if (payload.role !== 'assistant' || !state.requestId || !text) return;

      if (payload.phase === 'commentary') {
        const separated = splitPublicReasoningText(text);
        const notes = separated.publicReasoningDeltas.length > 0
          ? separated.publicReasoningDeltas
          : [text];
        for (const [index, note] of notes.entries()) {
          const delta = sanitizePublicReasoningDelta(note);
          if (!delta) continue;
          execute({
            type: 'AppendPublicReasoningDelta',
            requestId: state.requestId,
            delta,
            idempotencyKey: eventKey('commentary', recordKey, index),
          });
        }
        return;
      }

      if (payload.phase === 'final_answer') {
        const answer = stripPublicReasoningLines(text).trim();
        if (!answer) return;
        execute({
          type: 'AppendOutputDelta',
          requestId: state.requestId,
          delta: answer,
          idempotencyKey: eventKey('answer', recordKey),
        });
      }
      return;
    }

    if (
      record.type === 'response_item'
      && payload.type === 'reasoning'
      && state.requestId
    ) {
      for (const [index, summary] of summaryTexts(payload).entries()) {
        const delta = sanitizePublicReasoningDelta(summary);
        if (!delta) continue;
        execute({
          type: 'AppendPublicReasoningDelta',
          requestId: state.requestId,
          delta,
          idempotencyKey: eventKey('reasoning-summary', recordKey, index),
        });
      }
      return;
    }

    if (
      record.type === 'event_msg'
      && payload.type === 'task_complete'
      && state.requestId
    ) {
      const output = typeof payload.last_agent_message === 'string'
        ? stripPublicReasoningLines(payload.last_agent_message).trim()
        : '';
      const result = output
        ? execute({
          type: 'CompleteRun',
          requestId: state.requestId,
          output,
        })
        : execute({
          type: 'FailRun',
          requestId: state.requestId,
          code: 'RESPONSE_NOT_DELIVERED',
          retryable: true,
        });
      if (result !== null) state.requestId = null;
    }
  }

  return Object.freeze({
    tick() {
      const rolloutPath = resolveRolloutPath();
      if (!rolloutPath) return { processedRecords: 0, rolloutPath: null };

      let stat;
      try {
        stat = fs.statSync(rolloutPath);
      } catch {
        return { processedRecords: 0, rolloutPath: null };
      }
      initializeState(rolloutPath, stat);
      if (stat.size <= state.offset) {
        return { processedRecords: 0, rolloutPath };
      }

      const length = Math.min(stat.size - state.offset, MAX_ROLLOUT_READ_BYTES);
      const buffer = Buffer.alloc(length);
      const fd = fs.openSync(rolloutPath, 'r');
      try {
        fs.readSync(fd, buffer, 0, length, state.offset);
      } finally {
        fs.closeSync(fd);
      }
      const lastNewline = buffer.lastIndexOf(0x0A);
      if (lastNewline < 0) return { processedRecords: 0, rolloutPath };

      const complete = buffer.subarray(0, lastNewline + 1).toString('utf8');
      const lines = complete.split('\n');
      lines.pop();
      let lineOffset = state.offset;
      let processedRecords = 0;
      for (const line of lines) {
        const nextOffset = lineOffset + Buffer.byteLength(line, 'utf8') + 1;
        if (line.trim()) {
          try {
            processRecord(JSON.parse(line), `${path.basename(rolloutPath)}:${lineOffset}`);
            processedRecords += 1;
          } catch (error) {
            log(`Codex response stream skipped malformed rollout record: ${error.message}`);
          }
        }
        lineOffset = nextOffset;
      }
      state.offset += lastNewline + 1;
      writeState(stateFile, state);
      return { processedRecords, rolloutPath };
    },

    close() {
      responseStream.close?.();
    },
  });
}
