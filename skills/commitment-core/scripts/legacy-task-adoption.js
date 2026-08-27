#!/usr/bin/env node

import { createHash } from 'node:crypto';
import {
  lstatSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import Database from 'better-sqlite3';

import { openCommitmentCore } from './core.js';

const MANIFEST_SCHEMA = 'zylos.legacy-task-adoption/v1';
const REPORT_SCHEMA = 'zylos.legacy-task-adoption-run/v1';
const MAX_ENTRIES = 100;
const TASK_FIELDS = new Set([
  'title',
  'description',
  'ownerId',
  'acceptorId',
  'assigneeId',
  'dueAt',
  'reminderMinutesBeforeDue',
]);
const ENTRY_FIELDS = new Set(['idempotencyKey', 'externalId', 'taskId', 'task']);
const MANIFEST_FIELDS = new Set(['schema', 'entries']);

function cliError(message, code = 'INVALID_ARGUMENT', cause) {
  const error = new TypeError(message, cause === undefined ? undefined : { cause });
  error.code = code;
  return error;
}

function requireRecord(value, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw cliError(`${field} must be an object`, 'INVALID_MANIFEST');
  }
  return value;
}

function requireText(value, field) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw cliError(`${field} must be a non-empty string`, 'INVALID_MANIFEST');
  }
  return value.trim();
}

function rejectUnknownFields(value, allowed, field) {
  const unknown = Object.keys(value).find(key => !allowed.has(key));
  if (unknown) throw cliError(`unsupported ${field} field: ${unknown}`, 'INVALID_MANIFEST');
}

function parseArgs(args) {
  const options = { commit: false, json: false };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--commit') {
      if (options.commit) throw cliError('duplicate flag: --commit');
      options.commit = true;
      continue;
    }
    if (argument === '--json') {
      if (options.json) throw cliError('duplicate flag: --json');
      options.json = true;
      continue;
    }
    if (argument !== '--manifest' && argument !== '--db-path') {
      throw cliError(`unknown flag: ${argument}`);
    }
    const optionName = argument === '--db-path' ? 'dbPath' : 'manifest';
    if (options[optionName] !== undefined) {
      throw cliError(`duplicate flag: ${argument}`);
    }
    const value = args[index + 1];
    if (value === undefined || value.startsWith('--')) {
      throw cliError(`${argument} requires a value`);
    }
    options[optionName] = requireText(value, argument);
    index += 1;
  }
  if (options.manifest === undefined) throw cliError('--manifest is required');
  return options;
}

function parseTask(rawTask, index) {
  const task = requireRecord(rawTask, `entries[${index}].task`);
  rejectUnknownFields(task, TASK_FIELDS, `entries[${index}].task`);
  return { ...task };
}

export function parseLegacyTaskAdoptionManifest(rawManifest) {
  const manifest = requireRecord(rawManifest, 'manifest');
  rejectUnknownFields(manifest, MANIFEST_FIELDS, 'manifest');
  if (manifest.schema !== MANIFEST_SCHEMA) {
    throw cliError(`manifest.schema must be ${MANIFEST_SCHEMA}`, 'INVALID_MANIFEST');
  }
  if (!Array.isArray(manifest.entries) || manifest.entries.length === 0) {
    throw cliError('manifest.entries must be a non-empty array', 'INVALID_MANIFEST');
  }
  if (manifest.entries.length > MAX_ENTRIES) {
    throw cliError(`manifest.entries must contain at most ${MAX_ENTRIES} items`, 'INVALID_MANIFEST');
  }

  const seen = new Map([
    ['idempotencyKey', new Set()],
    ['externalId', new Set()],
    ['taskId', new Set()],
  ]);
  const entries = manifest.entries.map((rawEntry, index) => {
    const entry = requireRecord(rawEntry, `entries[${index}]`);
    rejectUnknownFields(entry, ENTRY_FIELDS, `entries[${index}]`);
    const normalized = {
      idempotencyKey: requireText(entry.idempotencyKey, `entries[${index}].idempotencyKey`),
      externalId: requireText(entry.externalId, `entries[${index}].externalId`),
      // A caller-owned Core id closes the marker-before-Core id allocation loop.
      taskId: requireText(entry.taskId, `entries[${index}].taskId`),
      task: parseTask(entry.task, index),
    };
    for (const field of ['idempotencyKey', 'externalId', 'taskId']) {
      if (seen.get(field).has(normalized[field])) {
        throw cliError(
          `manifest contains duplicate ${field}: ${normalized[field]}`,
          'INVALID_MANIFEST',
        );
      }
      seen.get(field).add(normalized[field]);
    }
    return normalized;
  });
  return { schema: MANIFEST_SCHEMA, entries };
}

function readManifest(pathOrStdin, readFile = readFileSync) {
  try {
    return pathOrStdin === '-'
      ? readFile(0, 'utf8')
      : readFile(pathOrStdin, 'utf8');
  } catch (cause) {
    throw cliError('could not read adoption manifest', 'INVALID_MANIFEST', cause);
  }
}

function parseManifestText(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (cause) {
    throw cliError('adoption manifest must be valid JSON', 'INVALID_MANIFEST', cause);
  }
  return parseLegacyTaskAdoptionManifest(parsed);
}

function safeError(error) {
  return {
    code: error?.code ?? (error instanceof TypeError ? 'INVALID_ARGUMENT' : 'ADOPTION_FAILED'),
    message: error?.message ?? String(error),
  };
}

function defaultDbPath() {
  const zylosDir = process.env.ZYLOS_DIR || path.join(os.homedir(), 'zylos');
  return path.join(zylosDir, 'commitments', 'commitments.db');
}

function fingerprintFile(filePath) {
  const stats = statSync(filePath);
  return {
    bytes: stats.size,
    mtimeMs: stats.mtimeMs,
    sha256: createHash('sha256').update(readFileSync(filePath)).digest('hex'),
  };
}

function absentPlanSource(sourcePath, status = 'absent') {
  return {
    dbPath: ':memory:',
    sourceDb: {
      path: sourcePath,
      status,
      snapshot: null,
    },
    cleanup() {},
  };
}

function createPlanSnapshot(sourcePath) {
  if (sourcePath === ':memory:') return absentPlanSource(':memory:', 'memory');

  const resolvedPath = path.resolve(sourcePath);
  let sourceStat;
  try {
    sourceStat = lstatSync(resolvedPath);
  } catch (cause) {
    if (cause?.code === 'ENOENT') return absentPlanSource(resolvedPath);
    throw cliError('could not inspect plan source database', 'PLAN_SOURCE_INVALID', cause);
  }
  if (!sourceStat.isFile()) {
    throw cliError('plan source database must be a regular file', 'PLAN_SOURCE_INVALID');
  }

  const sourceBefore = fingerprintFile(resolvedPath);
  const tempDir = mkdtempSync(path.join(os.tmpdir(), 'zylos-legacy-task-adoption-'));
  const snapshotPath = path.join(tempDir, 'source.sqlite');
  let source;
  try {
    source = new Database(resolvedPath, { readonly: true, fileMustExist: true });
    source.pragma('busy_timeout = 5000');
    const dataVersionBefore = source.pragma('data_version', { simple: true });
    source.prepare('VACUUM INTO ?').run(snapshotPath);
    const dataVersionAfter = source.pragma('data_version', { simple: true });
    source.close();
    source = null;

    const sourceAfter = fingerprintFile(resolvedPath);
    if (dataVersionBefore !== dataVersionAfter
      || sourceBefore.sha256 !== sourceAfter.sha256
      || sourceBefore.bytes !== sourceAfter.bytes
      || sourceBefore.mtimeMs !== sourceAfter.mtimeMs) {
      throw cliError(
        'plan source database changed while snapshotting',
        'PLAN_SOURCE_CHANGED',
      );
    }

    const snapshot = fingerprintFile(snapshotPath);
    return {
      dbPath: snapshotPath,
      sourceDb: {
        path: resolvedPath,
        status: 'snapshotted',
        fingerprint: {
          ...sourceBefore,
          dataVersionBefore,
          dataVersionAfter,
        },
        snapshot: {
          bytes: snapshot.bytes,
          sha256: snapshot.sha256,
        },
      },
      cleanup() {
        rmSync(tempDir, { recursive: true, force: true });
      },
    };
  } catch (cause) {
    if (source) source.close();
    rmSync(tempDir, { recursive: true, force: true });
    if (cause?.code === 'PLAN_SOURCE_CHANGED') throw cause;
    throw cliError('could not create read-only plan snapshot', 'PLAN_SNAPSHOT_FAILED', cause);
  }
}

function openForMode(options, openCore) {
  if (!options.commit) {
    const sourcePath = options.dbPath ?? defaultDbPath();
    const prepared = createPlanSnapshot(sourcePath);
    try {
      return {
        core: openCore({ dbPath: prepared.dbPath }),
        sourceDb: prepared.sourceDb,
        cleanup: prepared.cleanup,
      };
    } catch (cause) {
      prepared.cleanup();
      throw cause;
    }
  }

  const dbPath = options.dbPath ?? defaultDbPath();
  return {
    core: options.dbPath === undefined ? openCore() : openCore({ dbPath }),
    sourceDb: {
      path: path.resolve(dbPath),
      status: 'live-target',
      snapshot: null,
    },
    cleanup() {},
  };
}

/**
 * Run one manifest through the adjacent Core Module. Plan opens a readonly
 * source database and analyzes a temporary VACUUM INTO snapshot; if the source
 * is absent, it falls back to an isolated in-memory Module. Only --commit
 * opens the live Core DB. This CLI deliberately has no Feishu/remote Adapter
 * and processes entries independently so one idempotent receipt cannot mask
 * another entry's error.
 */
export function runLegacyTaskAdoptionCli({
  args = process.argv.slice(2),
  openCore = openCommitmentCore,
  readFile = readFileSync,
  stdout = process.stdout,
} = {}) {
  const options = parseArgs(args);
  const manifest = parseManifestText(readManifest(options.manifest, readFile));
  const prepared = openForMode(options, openCore);
  const { core } = prepared;
  const results = [];
  try {
    for (const [index, entry] of manifest.entries.entries()) {
      try {
        const result = core.adoptLegacyTask({
          ...entry,
          mode: options.commit ? 'commit' : 'plan',
        });
        results.push({
          index,
          idempotencyKey: entry.idempotencyKey,
          externalId: entry.externalId,
          taskId: entry.taskId,
          ok: true,
          result,
        });
      } catch (error) {
        results.push({
          index,
          idempotencyKey: entry.idempotencyKey,
          externalId: entry.externalId,
          taskId: entry.taskId,
          ok: false,
          error: safeError(error),
        });
      }
    }
  } finally {
    try {
      core.close();
    } finally {
      prepared.cleanup();
    }
  }

  const succeeded = results.filter(item => item.ok).length;
  const report = {
    schema: REPORT_SCHEMA,
    mode: options.commit ? 'commit' : 'plan',
    storage: options.commit
      ? 'core-database'
      : prepared.sourceDb.status === 'snapshotted' ? 'read-only-snapshot' : 'isolated-memory',
    writes: options.commit,
    sourceDb: prepared.sourceDb,
    total: results.length,
    succeeded,
    failed: results.length - succeeded,
    results,
  };
  stdout.write(`${JSON.stringify(report)}\n`);
  return report;
}

if (process.argv[1]
  && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const report = runLegacyTaskAdoptionCli();
    if (report.failed > 0) process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`legacy-task-adoption: ${error?.code ? `${error.code}: ` : ''}${error.message}\n`);
    process.exitCode = error?.code === 'INVALID_MANIFEST' || error?.code === 'INVALID_ARGUMENT' ? 2 : 1;
  }
}
