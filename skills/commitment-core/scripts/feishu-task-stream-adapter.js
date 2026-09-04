import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import Database from 'better-sqlite3';

const execFileAsync = promisify(execFile);

const PROJECTION = 'feishu-task-stream';

// Task lifecycle events that map onto a visible task status card.
const STREAMED_EVENT_TYPES = new Set([
  'TaskCreated',
  'TaskStarted',
  'TaskSubmittedForReview',
  'TaskAccepted',
  'TaskCancelled',
]);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function defaultZylosDir() {
  return process.env.ZYLOS_DIR || path.join(os.homedir(), 'zylos');
}

function defaultC4DbPath() {
  return path.join(defaultZylosDir(), 'comm-bridge', 'c4.db');
}

function defaultAssistantEventScript() {
  // commitment-core/scripts → comm-bridge/scripts (sibling skill directories
  // under the same skills root).
  return path.resolve(__dirname, '..', '..', 'comm-bridge', 'scripts', 'c4-assistant-event.js');
}

/**
 * Resolve the originating Feishu conversation for a task, across the two
 * durable stores:
 *   commitments.db commitment_sources  (taskId → idempotency key, channel, Feishu message id)
 *   c4.db          commitment_intake_queue ⋈ conversations (idempotency key → endpoint route)
 *
 * Returns null when the task did not originate from a Feishu intake (legacy
 * adoption, external adapter, …) so the caller can ack the delivery harmlessly.
 */
export function resolveFeishuOrigin({
  sources = [],
  c4DbPath = defaultC4DbPath(),
  openC4Db = (file) => new Database(file, { readonly: true, fileMustExist: true }),
}) {
  const feishu = sources.find(source => source.channel === 'feishu' && source.externalId)
    || sources.find(source => source.channel === 'feishu');
  if (!feishu) return null;

  let c4;
  try {
    c4 = openC4Db(c4DbPath);
  } catch (error) {
    if (error?.code === 'SQLITE_CANTOPEN') return null;
    throw error;
  }
  try {
    const row = c4.prepare(`
      SELECT c.endpoint_id AS endpoint, c.channel
      FROM commitment_intake_queue q
      JOIN conversations c ON c.id = q.conversation_id
      WHERE q.idempotency_key = ?
      ORDER BY q.id DESC
      LIMIT 1
    `).get(feishu.idempotencyKey);
    if (!row || row.channel !== 'feishu' || !row.endpoint) return null;
    const messageId = feishu.externalId;
    const digest = createHash('sha256').update(String(messageId)).digest('hex').slice(0, 40);
    return {
      requestId: `assistant.feishu.${digest}`,
      sourceId: String(messageId),
      endpoint: row.endpoint,
    };
  } finally {
    c4.close();
  }
}

function routeFromEndpoint(endpoint) {
  return { channel: 'feishu', endpointId: endpoint };
}

function completeOutput(title) {
  const label = title?.trim() ? `「${title.trim()}」` : '';
  return `✅ 任务${label}已完成。`;
}

/**
 * Map a task lifecycle event onto canonical assistant-stream commands for
 * the originating conversation. The Feishu adapter (scripts/stream.js) renders
 * these on the existing status-card engine, and the terminal completion output
 * is delivered as a new message so the chat re-notifies.
 */
export function commandsForTaskEvent({ event, title }) {
  const commands = [];
  switch (event.type) {
    case 'TaskCreated':
      // Accept only: the request stays 'queued' (durable, not subject to the
      // started-run stale timeout) until the agent actually starts the task.
      // The Feishu stream lazily opens its status card on this first delivery.
      commands.push({ kind: 'accept' });
      break;
    case 'TaskStarted':
      // The agent has claimed the task — start the run (stream "执行中").
      commands.push({ kind: 'start' });
      commands.push({
        kind: 'tool',
        payload: { toolName: 'task-execution', status: 'started' },
      });
      break;
    case 'TaskSubmittedForReview':
      commands.push({
        kind: 'tool',
        payload: { toolName: 'task-review-notify', status: 'completed' },
      });
      break;
    case 'TaskAccepted':
      commands.push({
        kind: 'complete',
        payload: { output: completeOutput(title) },
      });
      break;
    case 'TaskCancelled':
      commands.push({
        kind: 'fail',
        payload: { code: 'TASK_CANCELLED', retryable: false },
      });
      break;
    default:
      return [];
  }
  return commands;
}

function commandToAssistantEvent(kind, { requestId, sourceId, endpoint }, payload = {}) {
  switch (kind) {
    case 'accept':
      return {
        type: 'AcceptAssistantRequest',
        requestId,
        sourceId,
        route: routeFromEndpoint(endpoint),
        conversation: {
          content: payload.content || '任务进度',
          status: 'pending',
          priority: 3,
          requireIdle: false,
        },
      };
    case 'start':
      return { type: 'StartRun', requestId };
    case 'tool':
      return {
        type: 'ReportRequestToolProgress',
        requestId,
        toolName: payload.toolName,
        status: payload.status,
      };
    case 'complete':
      return { type: 'CompleteRun', requestId, output: payload.output };
    case 'fail':
      return { type: 'FailRun', requestId, code: payload.code, retryable: payload.retryable };
    default:
      throw new TypeError(`unknown task-stream command kind: ${kind}`);
  }
}

/**
 * Projection adapter that fans Commitment Core task lifecycle events into the
 * originating Feishu assistant response stream.
 */
export function createFeishuTaskStreamAdapter({
  core,
  c4DbPath = defaultC4DbPath(),
  assistantEventScript = defaultAssistantEventScript(),
  exec = execFileAsync,
  resolveOrigin = resolveFeishuOrigin,
  openC4Db,
  logger = console,
}) {
  async function runAssistantEvent(command, { idempotencyKey }) {
    const result = await exec('node', [assistantEventScript], {
      input: JSON.stringify(command),
      env: { ...process.env },
      maxBuffer: 4 * 1024 * 1024,
    });
    let parsed;
    try {
      parsed = JSON.parse(result.stdout.trim().split('\n').pop());
    } catch {
      parsed = { ok: false, error: { message: `unparseable event output: ${result.stdout}` } };
    }
    if (!parsed.ok) {
      const message = parsed.error?.message || 'assistant event rejected';
      // A request that is already in its terminal/accepted state means the
      // stream already owns it; re-delivery of the same task event is harmless
      // and should be acknowledged rather than retried forever.
      if (/already|terminal|completed|failed|conflict/i.test(message)) {
        return { skipped: true, reason: message };
      }
      const error = new Error(message);
      error.code = parsed.error?.code || 'ASSISTANT_EVENT_REJECTED';
      error.eventIdempotencyKey = idempotencyKey;
      throw error;
    }
    return parsed;
  }

  return Object.freeze({
    projection: PROJECTION,
    async publishDelivery({ delivery }) {
      const event = delivery.event;
      if (!STREAMED_EVENT_TYPES.has(event.type)) return;

      const sources = typeof core.queryTaskSources === 'function'
        ? core.queryTaskSources({ taskId: event.taskId })
        : [];
      const origin = await resolveOrigin({
        taskId: event.taskId,
        sources,
        c4DbPath,
        ...(openC4Db ? { openC4Db } : {}),
      });
      if (!origin) return; // not a Feishu-originated task; nothing to stream

      const title = await fetchTitle(core, event.taskId);
      const commands = commandsForTaskEvent({ event, title });
      for (let index = 0; index < commands.length; index += 1) {
        const { kind, payload } = commands[index];
        const assistantEvent = commandToAssistantEvent(kind, origin, payload);
        await runAssistantEvent(assistantEvent, {
          idempotencyKey: `task-stream:${event.id}:${kind}:${index}`,
        });
      }
    },
  });
}

async function fetchTitle(core, taskId) {
  try {
    const task = core.query({ taskId });
    return task?.title ?? null;
  } catch {
    return null;
  }
}

export { defaultC4DbPath, PROJECTION as FEISHU_TASK_STREAM_PROJECTION };
