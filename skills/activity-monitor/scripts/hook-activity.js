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
 * UserPromptSubmit, PreToolUse, MessageDisplay, Stop, and idle Notification
 * are synchronous turn boundaries; tool completion watchdog hooks remain async.
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
import { randomBytes } from 'node:crypto';
import { getClaudePid } from './claude-pid.js';
import { findMatchingToolRule, summarizeToolInput } from './tool-rules.js';
import { sequenceMessageDisplayBatch } from './message-display-sequencer.js';
import {
  readAssistantTurnBinding,
  writeAssistantTurnBinding,
} from './assistant-turn-binding.js';
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
const ASSISTANT_REQUEST_MARKER = /assistant request:\s*"([A-Za-z0-9][A-Za-z0-9._:-]*)"\s*$/;
const ANY_ASSISTANT_REQUEST_MARKER = /assistant request:\s*"/;
// Capture observation time before an async hook can be delayed on stdin or
// scheduling. Both the durable admission and lifecycle reducer use it to
// reject events older than the current prompt generation.
const HOOK_PROCESS_OBSERVED_AT_MS = Date.now();

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

function readTurnBinding(sessionId) {
  return readAssistantTurnBinding(sessionId);
}

function writeTurnBinding(sessionId, { mode, requestId = null, reason = null, nowMs = Date.now() }) {
  return writeAssistantTurnBinding(sessionId, {
    mode,
    requestId,
    reason,
    nowMs,
    onAuditError(error) {
      appendError(`assistant_binding_audit ${error?.message || 'append_failed'}`);
    },
  });
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

function rejectTurnBinding(responseStream, record, reason) {
  try {
    responseStream.rejectRuntimeTurnBinding({
      runtimeSessionId: record.session_id,
      reason,
      observedAtMs: record.ts,
    });
  } catch (error) {
    appendError(`assistant_binding_rejection_persist ${error?.message || 'failed'}`);
  }
  return writeTurnBinding(record.session_id, {
    mode: 'rejected',
    reason,
    nowMs: record.ts,
  });
}

function bindPromptTurn(responseStream, record, hookData) {
  const requestId = assistantRequestIdFromPrompt(hookData);
  if (!requestId) {
    return rejectTurnBinding(
      responseStream,
      record,
      promptContainsAssistantRequestMarker(hookData)
        ? 'non_terminal_marker'
        : 'missing_terminal_marker',
    );
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
    return rejectTurnBinding(responseStream, record, error?.code || 'invalid_request');
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
    if (binding.mode !== 'bound') {
      rejectTurnBinding(responseStream, record, binding.reason || 'legacy_fallback_unbound');
    }
    return binding.mode === 'bound' ? binding : null;
  } catch (error) {
    appendError(`assistant_binding_rejected ${error?.code || 'legacy_fallback_failed'}`);
    rejectTurnBinding(responseStream, record, error?.code || 'legacy_fallback_failed');
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
      const admission = responseStream.startRuntimeTurn({
        runtimeSessionId: record.session_id,
        observedAtMs: record.ts,
      });
      if (admission.reason === 'runtime_session_conflict') {
        appendError('runtime_turn_admission prompt_session_conflict');
      }
      if (['runtime_session_conflict', 'runtime_turn_observation_stale'].includes(admission.reason)) {
        return null;
      }
      return bindPromptTurn(responseStream, record, hookData);
    }
    if (['pre_tool', 'post_tool', 'post_tool_failure'].includes(record.event)) {
      if (!record.tool) return null;
      // UserPromptSubmit is the canonical turn boundary. PreToolUse is the
      // synchronous compatibility boundary for older installs that missed the
      // prompt hook. Async completion hooks must never promote a newly queued
      // admission: they can arrive after the prior turn's Stop.
      const admission = record.event === 'pre_tool'
        ? responseStream.startRuntimeTurn({
          runtimeSessionId: record.session_id,
          observedAtMs: record.ts,
        })
        : responseStream.touchRuntimeTurn({
          runtimeSessionId: record.session_id,
          observedAtMs: record.ts,
        });
      if (admission.reason === 'runtime_session_conflict') {
        appendError('runtime_turn_admission tool_session_conflict');
        return null;
      }
      if (['runtime_session_conflict', 'runtime_turn_not_started', 'runtime_turn_observation_stale']
        .includes(admission.reason)) return null;
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
      const activityId = `hook:${record.event}:${record.event_id || record.ts}`;
      return responseStream.execute({
        type: 'ReportRequestToolProgress',
        requestId: binding.requestId,
        runtimeSessionId: record.session_id,
        observedAtMs: record.ts,
        activityId,
        toolName: record.tool,
        status,
        // The Core maps tool identity to fixed public progress. Tool input and
        // the monitor's diagnostic summary are deliberately excluded, so
        // secrets, paths, queries, and hidden parameters never enter the
        // user-visible stream ledger.
        idempotencyKey: activityId,
      });
    }
    if (record.event === 'message_display') {
      const admission = responseStream.touchRuntimeTurn({
        runtimeSessionId: record.session_id,
        observedAtMs: record.ts,
      });
      if (admission.reason === 'runtime_session_conflict') {
        appendError('runtime_turn_admission display_session_conflict');
        return null;
      }
      if (['runtime_session_conflict', 'runtime_turn_not_started', 'runtime_turn_observation_stale']
        .includes(admission.reason)) return null;
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
        observedAtMs: record.ts,
        emit: batch => {
          const separated = splitPublicReasoningText(batch.delta);
          const activityId = `display-activity:${record.message_id}:${batch.index}`;
          const runtimeScope = Number.isSafeInteger(batch.observedAtMs)
            ? {
              runtimeSessionId: record.session_id,
              observedAtMs: batch.observedAtMs,
              activityId,
            }
            : {};
          for (const [index, publicDelta] of separated.publicReasoningDeltas.entries()) {
            const safeDelta = sanitizePublicReasoningDelta(publicDelta);
            if (!safeDelta) continue;
            result = responseStream.execute({
              type: 'AppendPublicReasoningDelta',
              requestId: binding.requestId,
              delta: safeDelta,
              idempotencyKey: `display-reasoning:${record.message_id}:${batch.index}:${index}`,
              ...runtimeScope,
            });
          }
          if (separated.answer.length > 0) {
            result = responseStream.execute({
              type: 'AppendOutputDelta',
              requestId: binding.requestId,
              delta: separated.answer,
              idempotencyKey: `display:${record.message_id}:${batch.index}`,
              ...runtimeScope,
            });
          }
          if (batch.final === true && Number.isSafeInteger(batch.observedAtMs)) {
            responseStream.execute({
              type: 'MarkFinalOutputCandidate',
              requestId: binding.requestId,
              runtimeSessionId: record.session_id,
              messageId: record.message_id,
              observedAtMs: batch.observedAtMs,
              activityId,
            });
          }
        },
      });
      return result;
    }
    if (record.event === 'idle') {
      const admission = responseStream.touchRuntimeTurn({
        runtimeSessionId: record.session_id,
        observedAtMs: record.ts,
      });
      if (admission.reason === 'runtime_session_conflict') {
        appendError('runtime_turn_admission idle_session_conflict');
      }
      return null;
    }
    if (record.event === 'stop') {
      const binding = resolveTurnBinding(responseStream, record);
      const finalization = { requestId: binding?.requestId || null };
      const lastMessage = typeof hookData?.last_assistant_message === 'string'
        ? hookData.last_assistant_message
        : '';
      const output = stripPublicReasoningLines(lastMessage).trim();
      if (output) {
        finalization.output = output;
      } else {
        finalization.failureCode = 'RESPONSE_NOT_DELIVERED';
        finalization.retryable = true;
      }
      const admission = responseStream.finishRuntimeTurn({
        runtimeSessionId: record.session_id,
        reason: 'stop',
        observedAtMs: record.ts,
        ...finalization,
      });
      if (admission.reason === 'no_active_admission' && binding) {
        const legacyResult = Object.hasOwn(finalization, 'output')
          ? responseStream.execute({
            type: 'CompleteRun',
            requestId: binding.requestId,
            output: finalization.output,
          })
          : responseStream.execute({
            type: 'FailRun',
            requestId: binding.requestId,
            code: finalization.failureCode,
            retryable: finalization.retryable,
          });
        writeTurnBinding(record.session_id, {
          mode: 'closed',
          requestId: binding.requestId,
          reason: 'legacy_stop_without_admission',
          nowMs: record.ts,
        });
        return legacyResult;
      }
      if (admission.reason === 'runtime_session_conflict') {
        appendError('runtime_turn_admission stop_session_conflict');
        return null;
      }
      if (['runtime_turn_not_started', 'runtime_turn_observation_stale']
        .includes(admission.reason)) {
        appendError(`runtime_turn_admission stop_${admission.reason}`);
        return null;
      }
      if (admission.reason === 'runtime_request_conflict') {
        appendError('runtime_turn_admission stop_runtime_request_conflict');
        return null;
      }
      const closedRequestId = admission.request?.requestId || binding?.requestId || null;
      if (closedRequestId && admission.finished) {
        writeTurnBinding(record.session_id, {
          mode: 'closed',
          requestId: closedRequestId,
          reason: 'stop',
          nowMs: record.ts,
        });
        responseStream.ackRuntimeTurnBindingProjection({
          admissionId: admission.admission.admissionId,
        });
      }
      return admission;
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
  // Close the durable turn before publishing an idle/Stop fact. Otherwise the
  // dispatcher can observe idle first and a delayed Stop can target the next
  // admission in the same long-lived runtime session.
  if (record.event === 'stop') {
    try {
      emitAssistantLifecycle(record, { hookData });
    } catch (err) {
      appendError(`assistant_stream ${err?.message || 'unknown_error'}`);
    }
    appendJsonLine(TOOL_EVENTS_FILE, record);
    return record;
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
      handleHookActivity(hookData, { nowMs: HOOK_PROCESS_OBSERVED_AT_MS });
    } catch (err) {
      appendError(err?.message || 'unknown_error');
    }
  });
}
