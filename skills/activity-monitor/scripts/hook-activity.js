#!/usr/bin/env node
/**
 * Hook-based tool lifecycle recorder.
 *
 * Receives Claude Code hook events via stdin JSON and appends lifecycle
 * events to ~/zylos/activity-monitor/tool-events.jsonl. The activity monitor
 * merges this stream into foreground/background session state and derives the
 * external api-activity.json snapshot.
 *
 * Registered on: UserPromptSubmit, PreToolUse, PostToolUse,
 * PostToolUseFailure, MessageDisplay, Stop, Notification(idle_prompt).
 * UserPromptSubmit and MessageDisplay are synchronous for binding/ordering;
 * the remaining watchdog hooks are async.
 *
 * Scope: phase 1 watchdog tracks only the root Claude agent. Nested subagent
 * hook payloads carry agent_id and are ignored here because recovery actions
 * operate on the whole tmux pane, not on an individual subagent.
 *
 * Safety: writes are best-effort and fail-open. Hook failures must never
 * interfere with Claude.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { getClaudePid } from './claude-pid.js';
import { findMatchingToolRule, summarizeToolInput } from './tool-rules.js';
import { sequenceMessageDisplayBatch } from './message-display-sequencer.js';
import { openAssistantResponseStream } from '../../comm-bridge/scripts/assistant-response-stream.js';
import {
  sanitizePublicReasoningDelta,
  splitPublicReasoningText,
  stripPublicReasoningLines,
} from '../../comm-bridge/scripts/assistant-public-reasoning.js';

const ZYLOS_DIR = process.env.ZYLOS_DIR || path.join(os.homedir(), 'zylos');
const MONITOR_DIR = path.join(ZYLOS_DIR, 'activity-monitor');
const TOOL_EVENTS_FILE = path.join(MONITOR_DIR, 'tool-events.jsonl');
const HOOK_ERROR_LOG = path.join(MONITOR_DIR, 'hook-activity-errors.log');
const MESSAGE_DISPLAY_BUFFER_DIR = path.join(MONITOR_DIR, 'message-display-buffers');
const TURN_BINDING_DIR = path.join(MONITOR_DIR, 'assistant-turn-bindings');
const ASSISTANT_REQUEST_MARKER = /assistant request:\s*"([A-Za-z0-9][A-Za-z0-9._:-]*)"\s*$/;
const ANY_ASSISTANT_REQUEST_MARKER = /assistant request:\s*"/;

function appendError(message) {
  try {
    fs.appendFileSync(HOOK_ERROR_LOG, `${new Date().toISOString()} ${message}\n`, 'utf8');
  } catch {
    // Best-effort.
  }
}

function readToolUseId(hookData) {
  const raw = hookData?.tool_use_id;
  return typeof raw === 'string' && raw.trim() ? raw.trim() : null;
}

function hasMeaningfulToolInput(toolInput) {
  return Boolean(toolInput && typeof toolInput === 'object' && Object.keys(toolInput).length > 0);
}

function isSubagentHook(hookData) {
  return typeof hookData?.agent_id === 'string' && hookData.agent_id.trim().length > 0;
}

function assistantRequestIdFromPrompt(hookData) {
  const prompt = typeof hookData?.prompt === 'string'
    ? hookData.prompt
    : (typeof hookData?.user_prompt === 'string' ? hookData.user_prompt : '');
  return prompt.match(ASSISTANT_REQUEST_MARKER)?.[1] || null;
}

function promptContainsAssistantRequestMarker(hookData) {
  const prompt = typeof hookData?.prompt === 'string'
    ? hookData.prompt
    : (typeof hookData?.user_prompt === 'string' ? hookData.user_prompt : '');
  return ANY_ASSISTANT_REQUEST_MARKER.test(prompt);
}

function turnBindingFile(sessionId) {
  const key = createHash('sha256').update(sessionId).digest('hex');
  return path.join(TURN_BINDING_DIR, `${key}.json`);
}

function readTurnBinding(sessionId) {
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
    // A missing/corrupt best-effort state is handled as an unbound legacy hook.
  }
  return null;
}

function writeTurnBinding(sessionId, { mode, requestId = null, reason = null, nowMs = Date.now() }) {
  fs.mkdirSync(TURN_BINDING_DIR, { recursive: true });
  const file = turnBindingFile(sessionId);
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
  return state;
}

function bindingFromResult(sessionId, result, nowMs) {
  const requestId = result?.request?.requestId;
  if (typeof requestId === 'string' && requestId) {
    return writeTurnBinding(sessionId, { mode: 'bound', requestId, nowMs });
  }
  return writeTurnBinding(sessionId, {
    mode: 'rejected',
    reason: result?.conflict
      ? 'active_turn_conflict'
      : (result?.ambiguous ? 'ambiguous' : 'no_candidate'),
    nowMs,
  });
}

function bindPromptTurn(responseStream, record, hookData) {
  const requestId = assistantRequestIdFromPrompt(hookData);
  if (!requestId) {
    return writeTurnBinding(record.session_id, {
      mode: 'rejected',
      reason: promptContainsAssistantRequestMarker(hookData)
        ? 'non_terminal_marker'
        : 'missing_terminal_marker',
      nowMs: record.ts,
    });
  }
  try {
    const result = responseStream.execute({
      type: 'BindTurn',
      requestId,
      runtimeSessionId: record.session_id,
    });
    return bindingFromResult(record.session_id, result, record.ts);
  } catch (error) {
    appendError(`assistant_binding_rejected ${error?.code || 'invalid_request'}`);
    return writeTurnBinding(record.session_id, {
      mode: 'rejected',
      reason: error?.code || 'invalid_request',
      nowMs: record.ts,
    });
  }
}

function resolveTurnBinding(responseStream, record, { allowLegacyFallback = false } = {}) {
  const existing = readTurnBinding(record.session_id);
  if (existing) return existing.mode === 'bound' ? existing : null;
  if (!allowLegacyFallback) return null;
  try {
    const result = responseStream.execute({
      type: 'BindNextRun',
      runtimeSessionId: record.session_id,
    });
    const binding = bindingFromResult(record.session_id, result, record.ts);
    return binding.mode === 'bound' ? binding : null;
  } catch (error) {
    appendError(`assistant_binding_rejected ${error?.code || 'legacy_fallback_failed'}`);
    writeTurnBinding(record.session_id, {
      mode: 'rejected',
      reason: error?.code || 'legacy_fallback_failed',
      nowMs: record.ts,
    });
    return null;
  }
}

function buildToolEvent({ hookData, eventName, claudePid, nowMs }) {
  const sessionId = hookData.session_id || process.env.CLAUDE_SESSION_ID || null;
  if (!sessionId) return null;

  const toolName = hookData.tool_name || null;
  const toolInput = hookData.tool_input || {};
  const toolUseId = readToolUseId(hookData);
  const rule = toolName
    ? findMatchingToolRule({ runtimeId: 'claude', toolName, toolInput, config: {} })
    : null;

  const base = {
    ts: nowMs,
    pid: claudePid,
    session_id: sessionId,
    event: eventName,
  };

  if (toolName) {
    base.tool = toolName;
    if (hasMeaningfulToolInput(toolInput)) {
      base.summary = summarizeToolInput(toolName, toolInput);
    }
  }

  if (toolUseId) {
    base.event_id = toolUseId;
  } else if (eventName === 'pre_tool') {
    base.event_id = `evt_${nowMs}_${randomBytes(4).toString('hex')}`;
  }

  if (eventName === 'message_display') {
    if (typeof hookData.message_id === 'string' && hookData.message_id.trim()) {
      base.message_id = hookData.message_id.trim();
    }
    if (Number.isSafeInteger(hookData.index) && hookData.index >= 0) {
      base.batch_index = hookData.index;
    }
    if (typeof hookData.final === 'boolean') base.final = hookData.final;
  }

  if (eventName === 'pre_tool') {
    if (rule?.id) {
      base.rule_id = rule.id;
    }
  }

  return base;
}

function appendJsonLine(filePath, record) {
  fs.appendFileSync(filePath, `${JSON.stringify(record)}\n`, 'utf8');
}

export function emitAssistantLifecycle(record, { hookData = null } = {}) {
  if (!record?.session_id) return null;
  const responseStream = openAssistantResponseStream();
  try {
    if (record.event === 'prompt') {
      return bindPromptTurn(responseStream, record, hookData);
    }
    if (['pre_tool', 'post_tool', 'post_tool_failure'].includes(record.event)) {
      if (!record.tool) return null;
      // Older installations may omit UserPromptSubmit. In that case only the
      // first observed event may attempt the single-candidate compatibility
      // binding. A prompt-time rejection is sticky and can never fall back.
      const binding = resolveTurnBinding(responseStream, record, {
        allowLegacyFallback: true,
      });
      if (!binding) return null;
      const status = record.event === 'pre_tool'
        ? 'started'
        : (record.event === 'post_tool' ? 'completed' : 'failed');
      return responseStream.execute({
        type: 'ReportRequestToolProgress',
        requestId: binding.requestId,
        toolName: record.tool,
        status,
        // The Core maps tool identity to fixed public progress. Tool input and
        // the monitor's diagnostic summary are deliberately excluded, so
        // secrets, paths, queries, and hidden parameters never enter the
        // user-visible stream ledger.
        idempotencyKey: `hook:${record.event}:${record.event_id || record.ts}`,
      });
    }
    if (record.event === 'message_display') {
      const binding = resolveTurnBinding(responseStream, record, {
        allowLegacyFallback: true,
      });
      if (!binding) return null;
      const delta = hookData?.delta;
      if (typeof delta !== 'string' || delta.length === 0) return null;
      if (!record.message_id || !Number.isSafeInteger(record.batch_index)) return null;
      let result = null;
      sequenceMessageDisplayBatch({
        directory: MESSAGE_DISPLAY_BUFFER_DIR,
        sessionId: record.session_id,
        messageId: record.message_id,
        batchIndex: record.batch_index,
        final: record.final === true,
        delta,
        emit: batch => {
          const separated = splitPublicReasoningText(batch.delta);
          for (const [index, publicDelta] of separated.publicReasoningDeltas.entries()) {
            const safeDelta = sanitizePublicReasoningDelta(publicDelta);
            if (!safeDelta) continue;
            result = responseStream.execute({
              type: 'AppendPublicReasoningDelta',
              requestId: binding.requestId,
              delta: safeDelta,
              idempotencyKey: `display-reasoning:${record.message_id}:${batch.index}:${index}`,
            });
          }
          if (separated.answer.length > 0) {
            result = responseStream.execute({
              type: 'AppendOutputDelta',
              requestId: binding.requestId,
              delta: separated.answer,
              idempotencyKey: `display:${record.message_id}:${batch.index}`,
            });
          }
        },
      });
      return result;
    }
    if (record.event === 'stop') {
      const binding = resolveTurnBinding(responseStream, record);
      if (!binding) return null;
      let result;
      if (
        typeof hookData?.last_assistant_message === 'string'
        && hookData.last_assistant_message.trim()
      ) {
        const output = stripPublicReasoningLines(hookData.last_assistant_message).trim();
        if (!output) {
          result = responseStream.execute({
            type: 'FailRun',
            requestId: binding.requestId,
            code: 'RESPONSE_NOT_DELIVERED',
            retryable: true,
          });
        } else {
          result = responseStream.execute({
            type: 'CompleteRun',
            requestId: binding.requestId,
            output,
          });
        }
      } else {
        result = responseStream.execute({
          type: 'FailRun',
          requestId: binding.requestId,
          code: 'RESPONSE_NOT_DELIVERED',
          retryable: true,
        });
      }
      writeTurnBinding(record.session_id, {
        mode: 'closed',
        requestId: binding.requestId,
        reason: 'stop',
        nowMs: record.ts,
      });
      return result;
    }
    return null;
  } finally {
    responseStream.close();
  }
}

export function handleHookActivity(hookData, { nowMs = Date.now(), claudePid = getClaudePid() } = {}) {
  if (isSubagentHook(hookData)) return null;

  const hookEventName = hookData?.hook_event_name;

  let eventName = null;
  switch (hookEventName) {
    case 'UserPromptSubmit':
      eventName = 'prompt';
      break;
    case 'PreToolUse':
      eventName = 'pre_tool';
      break;
    case 'PostToolUse':
      eventName = 'post_tool';
      break;
    case 'PostToolUseFailure':
      eventName = 'post_tool_failure';
      break;
    case 'MessageDisplay':
      eventName = 'message_display';
      break;
    case 'Stop':
      eventName = 'stop';
      break;
    case 'Notification':
      eventName = 'idle';
      break;
    default:
      return null;
  }

  const record = buildToolEvent({ hookData, eventName, claudePid, nowMs });
  if (!record) return null;

  // Display batches feed the durable response stream only. They are not
  // watchdog activity facts and must not copy answer text into tool logs.
  if (record.event === 'message_display') {
    try {
      emitAssistantLifecycle(record, { hookData });
    } catch (err) {
      appendError(`assistant_stream ${err?.message || 'unknown_error'}`);
    }
    return record;
  }

  if (!fs.existsSync(MONITOR_DIR)) {
    fs.mkdirSync(MONITOR_DIR, { recursive: true });
  }
  appendJsonLine(TOOL_EVENTS_FILE, record);
  try {
    emitAssistantLifecycle(record, { hookData });
  } catch (err) {
    // Lifecycle projection is best-effort from a runtime hook.  It must never
    // block a prompt/tool, and stale-run recovery will close an orphaned card.
    appendError(`assistant_stream ${err?.message || 'unknown_error'}`);
  }
  return record;
}

if (process.env.HOOK_ACTIVITY_DISABLE_MAIN !== '1') {
  let input = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    input += chunk;
  });

  process.stdin.on('end', () => {
    try {
      const hookData = JSON.parse(input || '{}');
      handleHookActivity(hookData);
    } catch (err) {
      appendError(err?.message || 'unknown_error');
    }
  });
}
