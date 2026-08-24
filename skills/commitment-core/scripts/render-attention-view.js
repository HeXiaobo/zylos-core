#!/usr/bin/env node

import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const OPEN_STATES = Object.freeze(['review', 'in_progress', 'ready']);
const STATE_ORDER = new Map(OPEN_STATES.map((state, index) => [state, index]));
const TASK_STATES = new Set([...OPEN_STATES, 'done', 'cancelled']);
const QUERY_LIMIT = 100;
const MIN_VIEW_BYTES = 512;
export const MAX_VIEW_BYTES = 16 * 1024;
const FIELD_LIMITS = Object.freeze({
  title: 256,
  description: 1024,
  identifier: 256,
});
const VIEW_TITLE = '# Zylos Attention View';
const OWNERSHIP_MARKER_PATTERN = /^<!-- zylos-attention-view: version=1; generated-at=([^;]+); source=commitment-core; derived=true -->$/m;

function defaultOutputPath(env = process.env) {
  const zylosDir = env.ZYLOS_DIR || path.join(os.homedir(), 'zylos');
  return path.join(zylosDir, 'memory', 'task-attention.md');
}

function compareTasks(left, right) {
  return STATE_ORDER.get(left.state) - STATE_ORDER.get(right.state)
    || compareText(left.updatedAt, right.updatedAt)
    || compareText(left.id, right.id);
}

function compareText(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function escapeMarkdownInline(value) {
  return String(value)
    .replace(/[\r\n\t]+/g, ' ')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replace(/([\\`*_[\]{}()#+.!|~-])/g, '\\$1');
}

function truncateCodePoints(value, maxCodePoints) {
  let codePoints = 0;
  let codeUnits = 0;
  for (const character of value) {
    if (codePoints === maxCodePoints) {
      return { value: value.slice(0, codeUnits), truncated: true };
    }
    codePoints += 1;
    codeUnits += character.length;
  }
  return { value, truncated: false };
}

function renderBoundedField(value, maxCodePoints) {
  const bounded = truncateCodePoints(value, maxCodePoints);
  return {
    text: `${escapeMarkdownInline(bounded.value)}${bounded.truncated ? '…' : ''}`,
    truncated: bounded.truncated,
  };
}

function renderTask(task) {
  const id = renderBoundedField(task.id, FIELD_LIMITS.identifier);
  const title = renderBoundedField(task.title, FIELD_LIMITS.title);
  const owner = renderBoundedField(task.ownerId, FIELD_LIMITS.identifier);
  const acceptor = renderBoundedField(task.acceptorId, FIELD_LIMITS.identifier);
  const assignee = renderBoundedField(task.assigneeId ?? 'unassigned', FIELD_LIMITS.identifier);
  const renderedDescription = task.description === null
    ? null
    : renderBoundedField(task.description, FIELD_LIMITS.description);
  const description = task.description === null
    ? ''
    : `\n  - Description: ${renderedDescription.text}`;
  return {
    task,
    content: `- [ ] **${title.text}** — ID: ${id.text}\n`
      + `  - Owner: ${owner.text}; Acceptor: ${acceptor.text}; Assignee: ${assignee.text}; Version: ${task.version}; Updated: ${escapeMarkdownInline(task.updatedAt)}`
      + description,
    fieldTruncated: [id, title, owner, acceptor, assignee, renderedDescription]
      .some((field) => field?.truncated),
  };
}

function renderDocument(renderedTasks, generatedAt, { omittedTaskCount, queryLimitReached }) {
  const lines = [
    VIEW_TITLE,
    '',
    `<!-- zylos-attention-view: version=1; generated-at=${generatedAt}; source=commitment-core; derived=true -->`,
    '',
    '> Derived, read-only view. Changes here are overwritten from Commitment Core.',
  ];

  for (const state of OPEN_STATES) {
    const stateTasks = renderedTasks.filter(({ task }) => task.state === state);
    if (stateTasks.length === 0) continue;
    lines.push('', `## ${state}`, '', stateTasks.map(({ content }) => content).join('\n'));
  }
  if (renderedTasks.some(({ fieldTruncated }) => fieldTruncated)) {
    lines.push(
      '',
      '> Content truncated: one or more task fields exceeded per-field limits '
        + '(title 256, description 1024, identifiers 256 code points).',
    );
  }
  if (omittedTaskCount > 0) {
    lines.push(
      '',
      `> Truncated: ${omittedTaskCount} additional open task${omittedTaskCount === 1 ? '' : 's'} omitted to stay within the view byte limit.`,
    );
  }
  if (queryLimitReached) {
    lines.push('', `> Query limit reached (${QUERY_LIMIT}); the number of additional open tasks is unknown.`);
  }
  lines.push('');
  return lines.join('\n');
}

function assertExistingViewOwnership(outputPath, fileSystem) {
  let existing;
  try {
    existing = fileSystem.readFileSync(outputPath, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    throw error;
  }
  const marker = OWNERSHIP_MARKER_PATTERN.exec(existing);
  const generatedAt = marker?.[1];
  const parsed = generatedAt ? new Date(generatedAt) : null;
  const ownsFile = existing.startsWith(`${VIEW_TITLE}\n\n`)
    && marker
    && !Number.isNaN(parsed.getTime())
    && parsed.toISOString() === generatedAt;
  if (!ownsFile) {
    const error = new Error(
      `refusing to replace an Attention view without the version 1 ownership marker: ${outputPath}`,
    );
    error.code = 'ATTENTION_VIEW_NOT_OWNED';
    throw error;
  }
}

function renderWithinBudget(renderedTasks, generatedAt, maxBytes, queryLimitReached) {
  for (let visibleCount = renderedTasks.length; visibleCount >= 0; visibleCount -= 1) {
    const omittedTaskCount = renderedTasks.length - visibleCount;
    const visibleTasks = renderedTasks.slice(0, visibleCount);
    const content = renderDocument(visibleTasks, generatedAt, {
      omittedTaskCount,
      queryLimitReached,
    });
    if (Buffer.byteLength(content) <= maxBytes) {
      return {
        content,
        visibleCount,
        omittedTaskCount,
        fieldTruncatedTaskCount: visibleTasks
          .filter(({ fieldTruncated }) => fieldTruncated).length,
      };
    }
  }
  throw new RangeError(`maxBytes is too small to render the attention view`);
}

function assertMaxViewBytes(maxBytes) {
  if (!Number.isInteger(maxBytes) || maxBytes < MIN_VIEW_BYTES || maxBytes > MAX_VIEW_BYTES) {
    throw new TypeError(`maxBytes must be an integer between ${MIN_VIEW_BYTES} and ${MAX_VIEW_BYTES}`);
  }
}

function assertGeneratedAt(generatedAt) {
  if (typeof generatedAt !== 'string') {
    throw new TypeError('generatedAt must be a canonical ISO timestamp');
  }
  const parsed = new Date(generatedAt);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== generatedAt) {
    throw new TypeError('generatedAt must be a canonical ISO timestamp');
  }
}

function assertTaskText(value, field) {
  if (typeof value !== 'string' || !/\S/u.test(value)) {
    throw new TypeError(`${field} must be a non-empty string`);
  }
}

function assertTaskTimestamp(value, field) {
  assertTaskText(value, field);
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== value) {
    throw new TypeError(`${field} must be a canonical ISO timestamp`);
  }
}

function assertTaskRecord(task, index) {
  const field = (name) => `tasks[${index}].${name}`;
  if (task === null || typeof task !== 'object' || Array.isArray(task)) {
    throw new TypeError(`tasks[${index}] must be an object`);
  }
  assertTaskText(task.id, field('id'));
  assertTaskText(task.title, field('title'));
  assertTaskText(task.state, field('state'));
  if (!TASK_STATES.has(task.state)) throw new TypeError(`${field('state')} is invalid`);
  assertTaskText(task.ownerId, field('ownerId'));
  assertTaskText(task.acceptorId, field('acceptorId'));
  if (task.description !== null) assertTaskText(task.description, field('description'));
  if (task.assigneeId !== null) assertTaskText(task.assigneeId, field('assigneeId'));
  if (!Number.isInteger(task.version) || task.version < 1) {
    throw new TypeError(`${field('version')} must be a positive integer`);
  }
  assertTaskTimestamp(task.createdAt, field('createdAt'));
  assertTaskTimestamp(task.updatedAt, field('updatedAt'));
}

function assertQueriedTasks(tasks) {
  if (!Array.isArray(tasks)) throw new TypeError('core.query must return an array');
  if (tasks.length > QUERY_LIMIT) {
    throw new TypeError(`core.query returned more than ${QUERY_LIMIT} tasks`);
  }
  const taskIds = new Set();
  tasks.forEach((task, index) => {
    assertTaskRecord(task, index);
    if (taskIds.has(task.id)) throw new TypeError(`duplicate ${fieldForTask(index, 'id')}`);
    taskIds.add(task.id);
  });
}

function fieldForTask(index, name) {
  return `tasks[${index}].${name}`;
}

function atomicWriteFile(outputPath, content, fileSystem, temporaryId) {
  fileSystem.mkdirSync(path.dirname(outputPath), { recursive: true });
  const temporaryPath = `${outputPath}.tmp-${process.pid}-${temporaryId()}`;
  let fileDescriptor;
  try {
    fileDescriptor = fileSystem.openSync(temporaryPath, 'wx', 0o600);
    fileSystem.writeFileSync(fileDescriptor, content, 'utf8');
    fileSystem.fsyncSync(fileDescriptor);
    fileSystem.closeSync(fileDescriptor);
    fileDescriptor = undefined;
    fileSystem.renameSync(temporaryPath, outputPath);
  } catch (error) {
    if (fileDescriptor !== undefined) {
      try {
        fileSystem.closeSync(fileDescriptor);
      } catch {
        // Preserve the original write/publication error.
      }
    }
    try {
      fileSystem.unlinkSync(temporaryPath);
    } catch {
      // The temporary file may not have been created.
    }
    throw error;
  }
}

export function publishAttentionView({
  core,
  outputPath = defaultOutputPath(),
  generatedAt = new Date().toISOString(),
  maxBytes = MAX_VIEW_BYTES,
  fileSystem = fs,
  temporaryId = randomUUID,
} = {}) {
  assertMaxViewBytes(maxBytes);
  assertGeneratedAt(generatedAt);
  if (!core || typeof core.query !== 'function') {
    throw new TypeError('core.query must be a function');
  }
  if (typeof outputPath !== 'string' || outputPath.trim() === '') {
    throw new TypeError('outputPath must be a non-empty string');
  }
  assertExistingViewOwnership(outputPath, fileSystem);
  const queriedTasks = core.query({ states: OPEN_STATES, limit: QUERY_LIMIT });
  assertQueriedTasks(queriedTasks);
  const queryLimitReached = queriedTasks.length === QUERY_LIMIT;
  const tasks = queriedTasks
    .filter((task) => STATE_ORDER.has(task.state))
    .sort(compareTasks);
  const renderedTasks = tasks.map(renderTask);
  const {
    content,
    visibleCount,
    omittedTaskCount,
    fieldTruncatedTaskCount,
  } = renderWithinBudget(
    renderedTasks,
    generatedAt,
    maxBytes,
    queryLimitReached,
  );
  atomicWriteFile(outputPath, content, fileSystem, temporaryId);
  return {
    outputPath,
    taskCount: visibleCount,
    queriedTaskCount: tasks.length,
    omittedTaskCount: queryLimitReached ? null : omittedTaskCount,
    fieldTruncatedTaskCount,
    truncated: omittedTaskCount > 0 || fieldTruncatedTaskCount > 0 || queryLimitReached,
    queryLimitReached,
    bytes: Buffer.byteLength(content),
  };
}

function parseCliArgs(args) {
  const options = { json: false, outputPath: null, maxBytes: MAX_VIEW_BYTES };
  const seen = new Set();
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (!['--json', '--output', '--max-bytes'].includes(argument)) {
      throw new TypeError(`unsupported argument: ${argument}`);
    }
    if (seen.has(argument)) throw new TypeError(`duplicate argument: ${argument}`);
    seen.add(argument);

    if (argument === '--json') {
      options.json = true;
      continue;
    }
    const value = args[index + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new TypeError(`${argument} requires a value`);
    }
    index += 1;
    if (argument === '--output') {
      if (value.trim() === '') throw new TypeError('--output requires a non-empty path');
      options.outputPath = value;
    } else if (!/^\d+$/.test(value)) {
      throw new TypeError('--max-bytes must be an integer');
    } else {
      options.maxBytes = Number(value);
      assertMaxViewBytes(options.maxBytes);
    }
  }
  return options;
}

async function openDefaultCore() {
  const { openCommitmentCore } = await import('./core.js');
  return openCommitmentCore();
}

export async function runAttentionViewCli({
  args = process.argv.slice(2),
  env = process.env,
  openCore = openDefaultCore,
  clock = () => new Date(),
  stdout = process.stdout,
} = {}) {
  const options = parseCliArgs(args);
  const core = await openCore();
  try {
    const result = publishAttentionView({
      core,
      outputPath: options.outputPath ?? defaultOutputPath(env),
      generatedAt: clock().toISOString(),
      maxBytes: options.maxBytes,
    });
    stdout.write(options.json
      ? `${JSON.stringify(result)}\n`
      : `Rendered ${result.taskCount} open task(s) to ${result.outputPath}\n`);
    return result;
  } finally {
    core.close();
  }
}

if (process.argv[1]
  && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  runAttentionViewCli().catch((error) => {
    process.stderr.write(`attention-view: ${error.message}\n`);
    process.exitCode = 1;
  });
}
