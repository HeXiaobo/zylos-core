/**
 * zylos task — local Commitment Core task management.
 *
 * This command is an Adapter over the Commitment Core Interface. It never
 * reads or writes the Core's SQLite tables directly.
 */

import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const BUNDLED_CORE_PATH = path.join(
  PACKAGE_ROOT,
  'skills',
  'commitment-core',
  'scripts',
  'core.js',
);

function defaultZylosDir() {
  return process.env.ZYLOS_DIR || path.join(os.homedir(), 'zylos');
}

function taskCoreError(code, message, cause) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.code = code;
  return error;
}

function isDevelopmentCheckout() {
  return existsSync(path.join(PACKAGE_ROOT, '.git'));
}

async function importCore(corePath, importModule) {
  const coreModule = await importModule(pathToFileURL(corePath).href);
  if (typeof coreModule.openCommitmentCore !== 'function') {
    throw new TypeError(`Commitment Core has no openCommitmentCore export: ${corePath}`);
  }
  return coreModule.openCommitmentCore;
}

/**
 * Resolve the deployed Skill first: its node_modules live beside that copy.
 * A bundled-source fallback is limited to a source checkout/test process and
 * can be disabled to emulate the production install layout.
 */
export async function loadCommitmentCore({
  zylosDir = defaultZylosDir(),
  importModule = (specifier) => import(specifier),
  sourcePreference = process.env.ZYLOS_TASK_CORE_SOURCE,
} = {}) {
  const installedCorePath = path.join(
    zylosDir,
    '.claude',
    'skills',
    'commitment-core',
    'scripts',
    'core.js',
  );

  if (existsSync(installedCorePath)) {
    try {
      return await importCore(installedCorePath, importModule);
    } catch (cause) {
      throw taskCoreError(
        'TASK_CORE_UNAVAILABLE',
        `Commitment Core is installed but could not be loaded from ${installedCorePath}. `
          + 'Run "zylos upgrade --self" to restore its dependencies.',
        cause,
      );
    }
  }

  const allowBundled = sourcePreference === 'bundled'
    || (sourcePreference !== 'installed'
      && (process.env.NODE_ENV === 'test' || isDevelopmentCheckout()));
  if (allowBundled && existsSync(BUNDLED_CORE_PATH)) {
    try {
      return await importCore(BUNDLED_CORE_PATH, importModule);
    } catch (cause) {
      throw taskCoreError(
        'TASK_CORE_UNAVAILABLE',
        `Bundled Commitment Core could not be loaded from ${BUNDLED_CORE_PATH}. `
          + 'Install its local dependencies before running development commands.',
        cause,
      );
    }
  }

  throw taskCoreError(
    'TASK_CORE_NOT_INSTALLED',
    `Commitment Core is not installed at ${installedCorePath}. `
      + 'Run "zylos init" or "zylos upgrade --self" first.',
  );
}

const WRITE_COMMANDS = Object.freeze({
  start: 'StartTask',
  submit: 'SubmitForReview',
  accept: 'AcceptTask',
  rework: 'RequestChanges',
  cancel: 'CancelTask',
  reopen: 'ReopenTask',
});

function argumentError(message) {
  const error = new TypeError(message);
  error.code = 'INVALID_ARGUMENT';
  return error;
}

function requireValue(value, field) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw argumentError(`${field} is required`);
  }
  return value;
}

function parsePositiveInteger(value, field) {
  if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value)) {
    throw argumentError(`${field} must be a positive integer`);
  }
  return Number(value);
}

function parseArgs(args, {
  valueFlags = [],
  booleanFlags = [],
  repeatableFlags = [],
  positionalCount = 0,
} = {}) {
  const valueSet = new Set(valueFlags);
  const booleanSet = new Set(booleanFlags);
  const repeatableSet = new Set(repeatableFlags);
  const options = {};
  const positionals = [];

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (!token.startsWith('--')) {
      positionals.push(token);
      continue;
    }

    const flag = token.slice(2);
    if (booleanSet.has(flag)) {
      if (Object.hasOwn(options, flag)) throw argumentError(`duplicate flag: --${flag}`);
      options[flag] = true;
      continue;
    }
    if (!valueSet.has(flag)) throw argumentError(`unknown flag: --${flag}`);

    const value = args[index + 1];
    if (value === undefined || value.startsWith('--')) {
      throw argumentError(`missing value for --${flag}`);
    }
    index += 1;
    if (repeatableSet.has(flag)) {
      options[flag] ??= [];
      options[flag].push(value);
    } else {
      if (Object.hasOwn(options, flag)) throw argumentError(`duplicate flag: --${flag}`);
      options[flag] = value;
    }
  }

  if (positionals.length !== positionalCount) {
    throw argumentError(
      positionalCount === 0
        ? 'unexpected positional argument'
        : `expected ${positionalCount} task id`,
    );
  }
  return { options, positionals };
}

function printJson(value) {
  console.log(JSON.stringify(value));
}

function printTask(task) {
  console.log(`${task.id}  ${task.state}  v${task.version}  ${task.title}`);
}

function showTaskHelp() {
  console.log(`
Usage: zylos task <subcommand> [options]

Subcommands:
  create                 Create a ready task
  list                   List tasks with bounded filters
  show <taskId>          Show one task
  start <taskId>         ready → in_progress
  submit <taskId>        in_progress → review
  accept <taskId>        review → done
  rework <taskId>        review → ready
  cancel <taskId>        ready/in_progress/review → cancelled
  reopen <taskId>        done → ready

Create options:
  --title <text>         Required task title
  --owner <id>           Required owner identity
  --acceptor <id>        Acceptor identity (defaults to owner)
  --assignee <id>        Assignee identity
  --description <text>   Optional description
  --idempotency-key <k>  Stable caller-provided key (otherwise a UUID is used)
  --json                 JSON output

List/show options:
  --state <state>        Filter list; repeat or use comma-separated states
  --owner <id>           Filter list by owner
  --assignee <id>        Filter list by assignee
  --limit <1..100>       List limit (default: 50)
  --events               Include events when showing one task
  --json                 JSON output

State command options:
  --actor <id>           Required actor identity
  --expected-version <n> Required positive Task version
  --idempotency-key <k>  Stable caller-provided key (otherwise a UUID is used)
  --json                 JSON output
`);
}

function createTask(core, args, makeIdempotencyKey) {
  const { options } = parseArgs(args, {
    valueFlags: ['title', 'owner', 'acceptor', 'assignee', 'description', 'idempotency-key'],
    booleanFlags: ['json'],
  });
  const title = requireValue(options.title, '--title');
  const ownerId = requireValue(options.owner, '--owner');
  const idempotencyKey = options['idempotency-key']
    ? requireValue(options['idempotency-key'], '--idempotency-key')
    : makeIdempotencyKey('create');
  const result = core.ingest({
    idempotencyKey,
    source: {
      channel: 'cli',
      externalId: idempotencyKey,
      senderId: ownerId,
    },
    task: {
      title,
      description: options.description,
      ownerId,
      acceptorId: options.acceptor,
      assigneeId: options.assignee,
    },
  });

  if (options.json) printJson(result);
  else console.log(`${result.created ? 'Created' : 'Replayed'} task ${result.task.id}`);
}

function listTasks(core, args) {
  const { options } = parseArgs(args, {
    valueFlags: ['state', 'owner', 'assignee', 'limit'],
    booleanFlags: ['json'],
    repeatableFlags: ['state'],
  });
  const states = options.state
    ?.flatMap((value) => value.split(','))
    .map((value) => value.trim());
  if (states?.some((state) => state === '')) {
    throw argumentError('--state contains an empty value');
  }
  const tasks = core.query({
    states,
    ownerId: options.owner,
    assigneeId: options.assignee,
    limit: options.limit === undefined
      ? undefined
      : parsePositiveInteger(options.limit, '--limit'),
  });

  if (options.json) printJson(tasks);
  else if (tasks.length === 0) console.log('No tasks.');
  else tasks.forEach(printTask);
}

function showTask(core, args) {
  const { options, positionals } = parseArgs(args, {
    booleanFlags: ['events', 'json'],
    positionalCount: 1,
  });
  const taskId = requireValue(positionals[0], 'taskId');
  const result = core.query({ taskId, includeEvents: options.events ?? false });
  const task = options.events ? result.task : result;
  if (!task) {
    const error = new Error(`task not found: ${taskId}`);
    error.code = 'TASK_NOT_FOUND';
    throw error;
  }

  if (options.json) printJson(result);
  else {
    printTask(task);
    if (options.events) {
      result.events.forEach((event) => {
        console.log(`  ${event.type}  v${event.version}  ${event.actorId}`);
      });
    }
  }
}

function applyStateCommand(core, subcommand, args, makeIdempotencyKey) {
  const { options, positionals } = parseArgs(args, {
    valueFlags: ['actor', 'expected-version', 'idempotency-key'],
    booleanFlags: ['json'],
    positionalCount: 1,
  });
  const taskId = requireValue(positionals[0], 'taskId');
  const actorId = requireValue(options.actor, '--actor');
  const expectedVersion = parsePositiveInteger(options['expected-version'], '--expected-version');
  const idempotencyKey = options['idempotency-key']
    ? requireValue(options['idempotency-key'], '--idempotency-key')
    : makeIdempotencyKey(subcommand);
  const result = core.command({
    type: WRITE_COMMANDS[subcommand],
    taskId,
    actorId,
    idempotencyKey,
  }, expectedVersion);

  if (options.json) printJson(result);
  else printTask(result.task);
}

export async function taskCommand(args, {
  openCore,
  loadCore = loadCommitmentCore,
  makeIdempotencyKey = (operation) => `cli:${operation}:${randomUUID()}`,
} = {}) {
  const subcommand = args[0];
  if (!subcommand || ['help', '--help', '-h'].includes(subcommand)) {
    showTaskHelp();
    return;
  }

  const jsonMode = args.includes('--json');
  let core;
  try {
    if (!['create', 'list', 'show'].includes(subcommand) && !WRITE_COMMANDS[subcommand]) {
      throw argumentError(`unknown task subcommand: ${subcommand}`);
    }
    const openCommitmentCore = openCore ?? await loadCore();
    core = openCommitmentCore();
    if (subcommand === 'create') createTask(core, args.slice(1), makeIdempotencyKey);
    else if (subcommand === 'list') listTasks(core, args.slice(1));
    else if (subcommand === 'show') showTask(core, args.slice(1));
    else if (WRITE_COMMANDS[subcommand]) {
      applyStateCommand(core, subcommand, args.slice(1), makeIdempotencyKey);
    }
  } catch (error) {
    const code = error?.code || (error instanceof TypeError ? 'INVALID_ARGUMENT' : 'TASK_ERROR');
    const payload = { error: { code, message: error?.message || String(error) } };
    if (jsonMode) printJson(payload);
    else console.error(`${code}: ${payload.error.message}`);
    process.exitCode = code === 'INVALID_ARGUMENT' ? 2 : 1;
  } finally {
    core?.close();
  }
}
