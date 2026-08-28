#!/usr/bin/env node
/**
 * C4 Communication Bridge - Receive Interface
 * Receives messages from external channels and queues them for Claude
 */

import path from 'path';
import fs from 'fs';
import net from 'net';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import {
  clearStatusNoticeCooldownReservation,
  insertConversation,
  openCommitmentIntakeQueue,
  close,
  reserveStatusNoticeCooldown
} from './c4-db.js';
import { validateChannel, validateEndpoint } from './c4-validate.js';
import { parseTaskEnvelopeJson } from './c4-task-envelope.js';
import { persistTaskBeforeRoute } from './c4-task-intake.js';
import { openAssistantResponseStream } from './assistant-response-stream.js';
import {
  completeWorkIntakeConfirmationEffect,
  parseWorkIntakeConfirmationEffectJson,
  parseWorkIntakeConfirmationJson,
  queueConfirmedWorkIntakeChat,
  recordWorkIntakeDecision,
  recordWorkIntakeConfirmation,
  resolveWorkIntakeConfirmation,
} from './c4-work-intake-confirmations.js';
import { createWorkIntakeConfirmationCapability } from '../../work-intake/scripts/confirmation-capability.js';
import { classify } from '../../work-intake/index.js';
import { parseInboundEnvelopeJson } from '../../work-intake/scripts/inbound-envelope.js';
import { toCommitmentEnvelope } from '../../work-intake/scripts/commitment-adapter.js';
import { workIntakeProfileFromEnv } from './c4-work-intake-profile.js';
import {
  AGENT_STATUS_FILE,
  ACTIVITY_MONITOR_DIR
} from './c4-config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const AM_SOCKET_PATH = path.join(ACTIVITY_MONITOR_DIR, 'am.sock');
const ROUTER_IPC_TIMEOUT_MS = 30000;
const STATUS_NOTICE_COOLDOWN_SECONDS = Number.parseInt(process.env.C4_STATUS_NOTICE_COOLDOWN_SECONDS || '600', 10);

function classifyWorkIntake(envelope) {
  return classify(envelope, workIntakeProfileFromEnv());
}

function printUsage() {
  console.log('Usage: node c4-receive.js --channel <channel> [--endpoint <endpoint_id>] [--priority <1-3>] [--no-reply] [--block-queue-until-idle] [--task-envelope-json <json> | --work-intake-envelope-json <json> | --work-intake-confirmation-json <json> | --work-intake-confirmation-effect-json <json>] [--assistant-request-id <id> --assistant-source-id <id>] [--json] --content "<message>"');
  console.log('');
  console.log('Options:');
  console.log('  --no-reply       Mark as not needing a reply target (use for system messages)');
  console.log('  --block-queue-until-idle');
  console.log('                   Wait for sustained idle, then block subsequent dispatch until execution settles');
  console.log('                   Legacy alias: --require-idle');
  console.log('  --task-envelope-json <json>');
  console.log('                   Atomically persist a normalized task envelope with the message');
  console.log('  --work-intake-envelope-json <json>');
  console.log('                   Classify a channel-neutral InboundEnvelope before routing');
  console.log('  --work-intake-confirmation-json <json>');
  console.log('                   Resolve one persisted WorkIntake confirmation choice');
  console.log('  --work-intake-confirmation-effect-json <json>');
  console.log('                   Acknowledge durable delivery of an external confirmation effect');
  console.log('  --assistant-request-id <id> --assistant-source-id <id>');
  console.log('                   Open a durable response stream for an ordinary chat message');
  console.log('  --json           Output structured JSON');
  console.log('');
  console.log('Priority levels:');
  console.log('  1 = Urgent (system messages)');
  console.log('  2 = High (important user messages)');
  console.log('  3 = Normal (default)');
}

function parseArgs(args) {
  const result = {
    channel: null,
    endpoint: null,
    content: null,
    priority: 3,
    noReply: false,
    requireIdle: false,
    json: false,
    taskEnvelopeJson: null,
    workIntakeEnvelopeJson: null,
    workIntakeConfirmationJson: null,
    workIntakeConfirmationEffectJson: null,
    assistantRequestId: null,
    assistantSourceId: null,
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--channel':
        result.channel = args[++i];
        break;
      case '--endpoint':
        result.endpoint = args[++i];
        break;
      case '--priority':
        result.priority = parseInt(args[++i], 10);
        break;
      case '--no-reply':
        result.noReply = true;
        break;
      case '--require-idle':
      case '--block-queue-until-idle':
        result.requireIdle = true;
        break;
      case '--json':
        result.json = true;
        break;
      case '--content':
        result.content = args[++i];
        break;
      case '--task-envelope-json':
        result.taskEnvelopeJson = args[++i];
        break;
      case '--work-intake-envelope-json':
        result.workIntakeEnvelopeJson = args[++i];
        break;
      case '--work-intake-confirmation-json':
        result.workIntakeConfirmationJson = args[++i];
        break;
      case '--work-intake-confirmation-effect-json':
        result.workIntakeConfirmationEffectJson = args[++i];
        break;
      case '--assistant-request-id':
        result.assistantRequestId = args[++i];
        break;
      case '--assistant-source-id':
        result.assistantSourceId = args[++i];
        break;
      default:
        if (args[i].startsWith('--')) {
          return { error: `Unknown option: ${args[i]}` };
        }
        return { error: `Unexpected argument: ${args[i]}` };
    }
  }

  return result;
}

function readHealthStatusFile() {
  try {
    if (!fs.existsSync(AGENT_STATUS_FILE)) {
      return { health: 'ok' };
    }
    let status = null;
    let lastErr = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        status = JSON.parse(fs.readFileSync(AGENT_STATUS_FILE, 'utf8'));
        break;
      } catch (err) {
        lastErr = err;
      }
    }
    if (!status && lastErr) throw lastErr;
    if (status && typeof status.health === 'string') {
      return status;
    }
    return { health: 'ok' };
  } catch {
    // Fail-open by design: status read failures do not block intake.
    return { health: 'ok' };
  }
}

function publicHealth(health) {
  if (health === 'ok' || health === 'rate_limited' || health === 'auth_failed') {
    return health;
  }
  return 'unavailable';
}

function buildFallbackMessage(status) {
  const health = publicHealth(status.health);
  if (health === 'rate_limited') {
    const resetInfo = status.rate_limit_reset ? ` I should be back around ${status.rate_limit_reset}.` : ' I should be back within an hour.';
    return `I've hit my usage limit.${resetInfo} Please send your message again after I'm back!`;
  }
  if (health === 'auth_failed') {
    return "I'm having authentication issues — please check the API credentials.";
  }
  return "I'm temporarily unavailable but should be back shortly. Please try again in a moment!";
}

function fallbackFileRoute() {
  const status = readHealthStatusFile();
  const health = publicHealth(status?.health);
  if (!status || typeof status.health !== 'string' || health === 'ok') {
    return { recovered: true, health: 'ok', fallback: true };
  }
  return {
    recovered: false,
    health,
    reason: status.unavailable_reason || health,
    userMessage: buildFallbackMessage(status),
    fallback: true
  };
}

function ipcRoute(request) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(AM_SOCKET_PATH);
    let data = '';
    let settled = false;

    function settle(fn, value) {
      if (settled) return;
      settled = true;
      socket.destroy();
      fn(value);
    }

    function tryParseResponse(force = false) {
      const newlineIndex = data.indexOf('\n');
      if (newlineIndex === -1 && !force) return;
      const raw = newlineIndex === -1 ? data : data.slice(0, newlineIndex);
      try {
        settle(resolve, JSON.parse(raw));
      } catch {
        settle(reject, new Error('IPC response parse error'));
      }
    }

    socket.setTimeout(ROUTER_IPC_TIMEOUT_MS);
    socket.on('connect', () => {
      socket.write(`${JSON.stringify(request)}\n`);
    });
    socket.on('data', (chunk) => {
      data += chunk;
      tryParseResponse();
    });
    socket.on('end', () => {
      tryParseResponse(true);
    });
    socket.on('timeout', () => {
      settle(reject, new Error('IPC timeout'));
    });
    socket.on('error', (err) => settle(reject, err));
  });
}

function isValidRouteDecision(decision, noReply) {
  if (!decision || typeof decision.recovered !== 'boolean') return false;
  if (decision.recovered) return true;
  if (typeof decision.health !== 'string') return false;
  if (noReply) return true;
  return typeof decision.userMessage === 'string' && decision.userMessage.length > 0;
}

async function queryRoute(channel, endpoint, noReply) {
  try {
    const decision = await ipcRoute({
      version: 1,
      type: 'route',
      requestId: `${process.pid}-${Date.now()}`,
      channel,
      endpoint,
      noReply,
      receivedAt: Date.now()
    });
    if (!isValidRouteDecision(decision, noReply)) {
      throw new Error('IPC response invalid route decision');
    }
    return decision;
  } catch {
    return fallbackFileRoute();
  }
}

function emitSuccess(json, recordId, action = 'queued', details = {}) {
  if (json) {
    console.log(JSON.stringify({ ok: true, action, id: recordId, ...details }));
    return;
  }
  if (action === 'queued') {
    console.log(`[C4] Message queued (id=${recordId})`);
  } else {
    console.log(`[C4] Message handled (id=${recordId}, action=${action})`);
  }
}

function emitError(json, code, message, exitCode = 1) {
  if (json) {
    console.log(JSON.stringify({
      ok: false,
      error: { code, message }
    }));
  } else {
    console.error(`Error: ${message}`);
  }
  process.exit(exitCode);
}

function sendUnhealthyMessage(channel, endpoint, message) {
  const args = [path.join(__dirname, 'c4-send.js'), channel];
  if (endpoint) args.push(endpoint);
  const result = spawnSync('node', args, {
    input: message,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe']
  });
  return result;
}

function normalizeStatusEndpoint(endpoint) {
  if (!endpoint) return '';
  // Group status-notice cooldowns by stable conversation root, not by each
  // incoming message/request id. This keeps thread-specific cooldowns while
  // suppressing repeated notices within the same root conversation.
  return endpoint.replace(/\|(msg|req|parent):[^|]+/g, '');
}

function statusNoticeType(route) {
  return publicHealth(route?.health);
}

function statusNoticeReason(route) {
  return String(route?.reason || statusNoticeType(route) || 'default');
}

function statusNoticeCooldownKey(channel, endpoint, route) {
  return [
    channel || 'unknown',
    normalizeStatusEndpoint(endpoint),
    statusNoticeType(route),
    statusNoticeReason(route)
  ].join('::');
}

function reserveStatusNoticeCooldownForRoute(channel, endpoint, route, now = Math.floor(Date.now() / 1000)) {
  const key = statusNoticeCooldownKey(channel, endpoint, route);
  const ttl = Number.isFinite(STATUS_NOTICE_COOLDOWN_SECONDS) && STATUS_NOTICE_COOLDOWN_SECONDS > 0
    ? STATUS_NOTICE_COOLDOWN_SECONDS
    : 600;
  return reserveStatusNoticeCooldown({
    cooldownKey: key,
    channel,
    endpoint: normalizeStatusEndpoint(endpoint),
    statusType: statusNoticeType(route),
    reason: statusNoticeReason(route),
    ttl,
    now
  });
}

function clearStatusNoticeCooldownReservationForRoute(key, reservedAt) {
  try {
    clearStatusNoticeCooldownReservation(key, reservedAt);
  } catch (err) {
    console.error(`[C4] Warning: failed to clear status cooldown reservation (${err.message})`);
  }
}

async function main() {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.error) {
    const asJson = process.argv.slice(2).includes('--json');
    emitError(asJson, 'INVALID_ARGS', parsed.error);
  }

  const {
    channel: rawChannel,
    endpoint: rawEndpoint,
    content: rawContent,
    priority,
    noReply,
    requireIdle,
    json,
    taskEnvelopeJson,
    workIntakeEnvelopeJson,
    workIntakeConfirmationJson,
    workIntakeConfirmationEffectJson,
    assistantRequestId,
    assistantSourceId,
  } = parsed;
  let channel = rawChannel;
  let endpoint = rawEndpoint;
  let content = rawContent;
  let taskEnvelope = null;
  let workIntakeEnvelope = null;
  let workIntakeDecision = null;
  let workIntakeDecisionReplayed = false;
  let workIntakeConfirmation = null;

  if ([
    taskEnvelopeJson,
    workIntakeEnvelopeJson,
    workIntakeConfirmationJson,
    workIntakeConfirmationEffectJson,
  ]
    .filter((value) => value !== null).length > 1) {
    emitError(json, 'INVALID_ARGS', 'task and WorkIntake protocols are mutually exclusive');
  }

  if (workIntakeConfirmationEffectJson !== null) {
    try {
      const request = parseWorkIntakeConfirmationEffectJson(workIntakeConfirmationEffectJson);
      const capabilitySecret = process.env.C4_WORK_INTAKE_CAPABILITY_SECRET;
      if (!capabilitySecret) {
        const error = new Error('C4_WORK_INTAKE_CAPABILITY_SECRET is required');
        error.code = 'INVALID_CONFIRMATION_CAPABILITY';
        throw error;
      }
      createWorkIntakeConfirmationCapability({ secret: capabilitySecret }).verify({
        token: request.capability,
        sourceKey: request.sourceKey,
        action: request.action,
        actorId: request.actorId,
      });
      const sourceSeparator = request.sourceKey.indexOf(':');
      const sourceChannel = sourceSeparator > 0
        ? request.sourceKey.slice(0, sourceSeparator)
        : null;
      if (!sourceChannel || channel !== sourceChannel) {
        emitError(json, 'INVALID_ARGS', 'WorkIntake confirmation effect source.channel must match --channel');
      }
      const effect = completeWorkIntakeConfirmationEffect({
        sourceKey: request.sourceKey,
        action: request.action,
        actorId: request.actorId,
      });
      emitSuccess(json, effect.conversationId, 'confirmation_effect_applied', {
        workIntakeConfirmation: {
          action: request.action,
          effectStatus: effect.effectStatus,
          effectKey: request.effectKey,
          replayed: effect.replayed,
        },
      });
      close();
      return;
    } catch (err) {
      const code = [
        'CONFIRMATION_NOT_FOUND',
        'CONFIRMATION_ALREADY_RESOLVED',
        'INVALID_CONFIRMATION_CAPABILITY',
      ].includes(err.code) ? err.code : 'INVALID_ARGS';
      emitError(json, code, `invalid WorkIntake confirmation effect: ${err.message}`);
    }
  }

  if (taskEnvelopeJson !== null) {
    try {
      taskEnvelope = parseTaskEnvelopeJson(taskEnvelopeJson);
    } catch (err) {
      emitError(json, 'INVALID_ARGS', `invalid --task-envelope-json: ${err.message}`);
    }
  }

  if (workIntakeEnvelopeJson !== null) {
    try {
      workIntakeEnvelope = parseInboundEnvelopeJson(workIntakeEnvelopeJson);
      const decisionReceipt = recordWorkIntakeDecision({
        envelope: workIntakeEnvelope,
        classify: classifyWorkIntake,
      });
      workIntakeDecision = decisionReceipt.decision;
      workIntakeDecisionReplayed = decisionReceipt.replayed;
      if (workIntakeDecision.decision === 'create_task') {
        taskEnvelope = toCommitmentEnvelope({
          envelope: workIntakeEnvelope,
          decision: workIntakeDecision,
        }, workIntakeProfileFromEnv());
      }
    } catch (err) {
      emitError(json, 'INVALID_ARGS', `invalid --work-intake-envelope-json: ${err.message}`);
    }
  }

  if (workIntakeConfirmationJson !== null) {
    try {
      const request = parseWorkIntakeConfirmationJson(workIntakeConfirmationJson);
      const capabilitySecret = process.env.C4_WORK_INTAKE_CAPABILITY_SECRET;
      if (!capabilitySecret) {
        const error = new Error('C4_WORK_INTAKE_CAPABILITY_SECRET is required');
        error.code = 'INVALID_CONFIRMATION_CAPABILITY';
        throw error;
      }
      createWorkIntakeConfirmationCapability({ secret: capabilitySecret }).verify({
        token: request.capability,
        sourceKey: request.sourceKey,
        action: request.action,
        actorId: request.actorId,
      });
      const sourceSeparator = request.sourceKey.indexOf(':');
      const sourceChannel = sourceSeparator > 0
        ? request.sourceKey.slice(0, sourceSeparator)
        : null;
      if (!sourceChannel || channel !== sourceChannel) {
        emitError(json, 'INVALID_ARGS', 'WorkIntake confirmation source.channel must match --channel');
      }
      workIntakeConfirmation = resolveWorkIntakeConfirmation({
        sourceKey: request.sourceKey,
        action: request.action,
        actorId: request.actorId,
      });
      workIntakeEnvelope = workIntakeConfirmation.envelope;
      workIntakeDecision = workIntakeConfirmation.decision;
      if (channel !== workIntakeEnvelope.source.channel) {
        emitError(json, 'INVALID_ARGS', 'WorkIntake confirmation source.channel must match --channel');
      }
      channel = workIntakeConfirmation.conversation.channel;
      endpoint = workIntakeConfirmation.conversation.endpointId;
      content = workIntakeConfirmation.action === 'chat_only'
        ? `[Confirmed ordinary message] ${workIntakeEnvelope.text}`
        : `[Confirmed WorkIntake ${workIntakeConfirmation.action}] ${workIntakeEnvelope.text}`;
      if (workIntakeConfirmation.action === 'create_task') {
        taskEnvelope = toCommitmentEnvelope({
          envelope: workIntakeEnvelope,
          decision: workIntakeDecision,
        }, {
          confirmed: true,
          ...workIntakeProfileFromEnv(),
        });
      }
    } catch (err) {
      const code = [
        'CONFIRMATION_NOT_FOUND',
        'CONFIRMATION_ALREADY_RESOLVED',
        'FORBIDDEN',
        'INVALID_CONFIRMATION_CAPABILITY',
      ].includes(err.code) ? err.code : 'INVALID_ARGS';
      emitError(json, code, `invalid WorkIntake confirmation: ${err.message}`);
    }
  }

  if (!channel && noReply) {
    channel = 'system';
  }

  if (!channel && !noReply) {
    if (!json) printUsage();
    emitError(json, 'INVALID_ARGS', '--channel is required unless --no-reply is set');
  }

  if (!content) {
    if (!json) printUsage();
    emitError(json, 'INVALID_ARGS', '--content is required');
  }

  if (workIntakeEnvelope && channel !== workIntakeEnvelope.source.channel) {
    emitError(json, 'INVALID_ARGS', 'WorkIntake source.channel must match --channel');
  }
  if (workIntakeEnvelope && noReply) {
    emitError(json, 'INVALID_ARGS', 'WorkIntake requires a reply-capable channel');
  }
  if (workIntakeEnvelope && !endpoint) {
    emitError(json, 'INVALID_ARGS', 'WorkIntake requires --endpoint');
  }

  if (!Number.isInteger(priority) || priority < 1 || priority > 3) {
    if (!json) printUsage();
    emitError(json, 'INVALID_ARGS', '--priority must be an integer 1, 2, or 3');
  }

  try {
    validateChannel(channel, !noReply);
  } catch (err) {
    emitError(json, 'INVALID_ARGS', `invalid channel: ${err.message}`);
  }

  if (endpoint) {
    try {
      validateEndpoint(endpoint);
    } catch (err) {
      emitError(json, 'INVALID_ARGS', `invalid endpoint: ${err.message}`);
    }
  }

  if ((assistantRequestId === null) !== (assistantSourceId === null)) {
    emitError(json, 'INVALID_ARGS', '--assistant-request-id and --assistant-source-id must be provided together');
  }
  if (assistantRequestId !== null && (noReply || !endpoint)) {
    emitError(json, 'INVALID_ARGS', 'assistant response streams require a reply endpoint');
  }
  if (
    assistantRequestId !== null
    && (
      workIntakeConfirmation !== null
      || (taskEnvelope !== null && workIntakeEnvelope === null)
    )
  ) {
    emitError(json, 'INVALID_ARGS', 'assistant response streams cannot accompany explicit task protocols');
  }
  const assistantStreamEnabled = assistantRequestId !== null
    && (!workIntakeDecision || workIntakeDecision.decision === 'chat_only');

  const replyEndpoint = noReply ? null : endpoint;
  if (
    workIntakeConfirmation
    && !workIntakeConfirmation.created
    && workIntakeConfirmation.action !== 'create_task'
    && workIntakeConfirmation.effectStatus === 'applied'
  ) {
    emitSuccess(
      json,
      workIntakeConfirmation.conversation.id,
      'confirmation_replayed',
      {
        workIntakeConfirmation: {
          action: workIntakeConfirmation.action,
          replayed: true,
          effectStatus: 'applied',
        },
      },
    );
    close();
    return;
  }
  if (workIntakeConfirmation?.action === 'edit') {
    const effectKey = `${workIntakeConfirmation.sourceKey}:edit-guidance`;
    emitSuccess(
      json,
      workIntakeConfirmation.conversation.id,
      'confirmation_resolved',
      {
        workIntakeConfirmation: {
          action: 'edit',
          replayed: false,
          decisionReplayed: !workIntakeConfirmation.created,
          effectStatus: 'pending',
          effectKey,
        },
      },
    );
    close();
    return;
  }
  if (!workIntakeConfirmation && workIntakeDecision?.decision === 'confirm') {
    try {
      const confirmation = recordWorkIntakeConfirmation({
        conversation: {
          channel,
          endpointId: replyEndpoint,
          content,
          priority,
          requireIdle,
        },
        envelope: workIntakeEnvelope,
        decision: workIntakeDecision,
      });
      emitSuccess(
        json,
        confirmation.conversation.id,
        confirmation.created ? 'confirmation_required' : 'confirmation_replayed',
        {
          workIntake: {
            ...confirmation.decision,
            replayed: !confirmation.created,
          },
        },
      );
      close();
      return;
    } catch (err) {
      emitError(
        json,
        err.code === 'IDEMPOTENCY_CONFLICT' ? err.code : 'INTERNAL_ERROR',
        `WorkIntake confirmation persistence failed: ${err.message}`,
      );
    }
  }

  let dbContent = content;
  let route;
  let taskIntake = null;
  let taskRecord = null;
  const isWorkIntakeTask = (
    workIntakeEnvelope !== null
    && workIntakeDecision?.decision === 'create_task'
  ) || workIntakeConfirmation?.action === 'create_task';
  const workIntakeSuccessDetails = (replayed) => {
    if (workIntakeConfirmation) {
      return {
        workIntakeConfirmation: {
          action: workIntakeConfirmation.action,
          replayed,
          effectStatus: workIntakeConfirmation.effectStatus,
        },
      };
    }
    return workIntakeDecision
      ? { workIntake: { ...workIntakeDecision, replayed } }
      : {};
  };
  let successDetails = workIntakeSuccessDetails(workIntakeDecisionReplayed);
  let assistantStream = null;
  let assistantResponse = null;

  if (taskEnvelope) {
    taskIntake = openCommitmentIntakeQueue();
    try {
      const taskRoute = await persistTaskBeforeRoute({
        intake: taskIntake,
        conversation: {
          channel,
          endpointId: replyEndpoint,
          content,
          // A WorkIntake task is consumed by the durable intake queue. Mark
          // its audit conversation delivered before routing so a crash after
          // the queue commit cannot hand the same request to the Agent.
          status: isWorkIntakeTask ? 'delivered' : 'pending',
          priority,
          requireIdle,
        },
        envelope: taskEnvelope,
        route: () => queryRoute(channel, endpoint, noReply),
      });
      taskRecord = taskRoute.persisted.conversation;
      if (workIntakeConfirmation?.action === 'create_task') {
        const effect = completeWorkIntakeConfirmationEffect({
          sourceKey: workIntakeConfirmation.sourceKey,
          action: 'create_task',
          actorId: workIntakeConfirmation.actorId,
        });
        workIntakeConfirmation.effectStatus = effect.effectStatus;
        successDetails = workIntakeSuccessDetails(taskRoute.replayed);
      }
      if (taskRoute.replayed) {
        successDetails = workIntakeSuccessDetails(true);
        emitSuccess(json, taskRecord.id, taskRoute.replayAction, successDetails);
        close();
        return;
      }
      route = taskRoute.routeDecision;
    } catch (err) {
      const code = err.code === 'IDEMPOTENCY_CONFLICT'
        ? 'IDEMPOTENCY_CONFLICT'
        : err.code === 'TASK_INTAKE_FAILED'
          ? 'TASK_INTAKE_FAILED'
          : 'INTERNAL_ERROR';
      emitError(json, code, `task intake failed: ${err.message}`);
    }
  } else {
    route = await queryRoute(channel, endpoint, noReply);
  }

  // WorkIntake task envelopes already have a durable Core intake. Their
  // conversation is only the audit record for that protocol, not another
  // Agent turn. Leaving it pending would make the dispatcher deliver the same
  // natural-language request to the task skill and create a second task.
  const dbStatus = isWorkIntakeTask
    ? 'delivered'
    : route.recovered ? 'pending' : 'delivered';
  let cooldown = null;
  const recordInbound = (storedContent, deliveryAction = null) => {
    if (taskRecord) {
      taskRecord = taskIntake.updateConversation({
        conversationId: taskRecord.id,
        content: storedContent,
        status: dbStatus,
        deliveryAction,
      });
      return taskRecord;
    }
    if (workIntakeConfirmation?.action === 'chat_only') {
      const effect = queueConfirmedWorkIntakeChat({
        sourceKey: workIntakeConfirmation.sourceKey,
        actorId: workIntakeConfirmation.actorId,
        status: dbStatus,
      });
      workIntakeConfirmation.effectStatus = effect.effectStatus;
      successDetails = workIntakeSuccessDetails(!workIntakeConfirmation.created);
      return {
        id: effect.conversation.id,
        direction: 'in',
        channel,
        endpoint_id: replyEndpoint,
        content: storedContent,
        status: effect.conversation.status,
        delivery_action: effect.conversation.deliveryAction,
        priority,
        require_idle: requireIdle ? 1 : 0,
        retry_count: 0,
      };
    }
    if (assistantStreamEnabled) {
      assistantStream ??= openAssistantResponseStream();
      assistantResponse = assistantStream.execute({
        type: 'AcceptAssistantRequest',
        requestId: assistantRequestId,
        sourceId: assistantSourceId,
        route: { channel, endpointId: replyEndpoint },
        conversation: {
          content: storedContent,
          status: dbStatus,
          priority,
          requireIdle,
        },
      });
      return {
        id: assistantResponse.request.conversationId,
        direction: 'in',
        channel,
        endpoint_id: replyEndpoint,
        content: storedContent,
        status: dbStatus,
        delivery_action: deliveryAction,
        priority,
        require_idle: requireIdle ? 1 : 0,
        retry_count: 0,
      };
    }
    return insertConversation(
      'in',
      channel,
      replyEndpoint,
      storedContent,
      dbStatus,
      priority,
      requireIdle,
      deliveryAction,
    );
  };

  if (!route.recovered && !noReply && !assistantStreamEnabled) {
    try {
      cooldown = reserveStatusNoticeCooldownForRoute(channel, endpoint, route);
    } catch (err) {
      emitError(json, 'INTERNAL_ERROR', `failed to reserve status cooldown: ${err.message}`);
    }
    if (cooldown.suppressed) {
      dbContent += `\n\n[C4] Status notification suppressed by cooldown while health=${statusNoticeType(route)} reason=${statusNoticeReason(route)}.`;
      try {
        const record = recordInbound(dbContent, 'suppressed');
        emitSuccess(json, record.id, 'suppressed', successDetails);
        return;
      } catch (err) {
        emitError(json, 'INTERNAL_ERROR', `failed to record suppressed unhealthy message: ${err.message}`);
      } finally {
        close();
      }
    }
  }

  try {
    const record = recordInbound(dbContent);
    if (!route.recovered && assistantResponse) {
      const failed = assistantStream.execute({
        type: 'FailRun',
        requestId: assistantRequestId,
        code: 'RUNTIME_UNAVAILABLE',
        retryable: true,
      });
      emitSuccess(json, record.id, 'delivered', {
        ...successDetails,
        assistantResponse: {
          requestId: failed.request.requestId,
          replayed: assistantResponse.replayed,
          events: failed.replayed
            ? assistantResponse.events
            : [...assistantResponse.events, ...failed.events],
        },
      });
      return;
    }
    if (route.recovered || noReply) {
      const assistantDetails = assistantResponse
        ? {
            assistantResponse: {
              requestId: assistantResponse.request.requestId,
              replayed: assistantResponse.replayed,
              events: assistantResponse.events,
            },
          }
        : {};
      emitSuccess(json, record.id, route.recovered ? 'queued' : 'delivered', {
        ...successDetails,
        ...assistantDetails,
      });
      return;
    }

    const sendResult = sendUnhealthyMessage(channel, endpoint, route.userMessage);
    if (sendResult.status === 0) {
      emitSuccess(json, record.id, 'delivered', successDetails);
      return;
    }
    if (cooldown?.key && Number.isFinite(cooldown.reservedAt)) {
      clearStatusNoticeCooldownReservationForRoute(cooldown.key, cooldown.reservedAt);
    }
    const detail = sendResult.stderr || sendResult.stdout || `exit ${sendResult.status}`;
    emitError(json, 'UNHEALTHY_NOTIFY_FAILED', `failed to send unhealthy status message: ${detail.trim()}`);
  } catch (err) {
    emitError(json, 'INTERNAL_ERROR', `failed to queue message: ${err.message}`);
  } finally {
    assistantStream?.close();
    close();
  }
}

main();
