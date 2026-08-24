#!/usr/bin/env node

import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { openCommitmentCore } from './core.js';

const VALUE_FLAGS = new Set([
  '--projection',
  '--event-id',
  '--actor',
  '--idempotency-key',
  '--expected-version',
]);

function argumentError(message) {
  const error = new TypeError(message);
  error.code = 'INVALID_ARGUMENT';
  return error;
}

function parsePositiveInteger(value, field) {
  if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value)) {
    throw argumentError(`${field} must be a positive integer`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw argumentError(`${field} must be a safe positive integer`);
  }
  return parsed;
}

function requireOption(options, flag) {
  const value = options.get(flag);
  if (typeof value !== 'string' || value.trim() === '') {
    throw argumentError(`${flag} is required`);
  }
  return value;
}

function parseArgs(args) {
  const options = new Map();
  let json = false;
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (flag === '--json') {
      if (json) throw argumentError('duplicate flag: --json');
      json = true;
      continue;
    }
    if (!VALUE_FLAGS.has(flag)) throw argumentError(`unknown flag: ${flag}`);
    if (options.has(flag)) throw argumentError(`duplicate flag: ${flag}`);
    const value = args[index + 1];
    if (value === undefined || value.startsWith('--')) {
      throw argumentError(`missing value for ${flag}`);
    }
    options.set(flag, value);
    index += 1;
  }

  return {
    request: {
      projection: requireOption(options, '--projection'),
      eventId: requireOption(options, '--event-id'),
      actorId: requireOption(options, '--actor'),
      idempotencyKey: requireOption(options, '--idempotency-key'),
    },
    expectedVersion: parsePositiveInteger(
      requireOption(options, '--expected-version'),
      '--expected-version',
    ),
    json,
  };
}

export function runOutboxRedriveCli({
  args = process.argv.slice(2),
  openCore = openCommitmentCore,
  stdout = process.stdout,
} = {}) {
  const options = parseArgs(args);
  const core = openCore();
  try {
    const result = core.outbox.redrive(options.request, options.expectedVersion);
    stdout.write(options.json
      ? `${JSON.stringify(result)}\n`
      : `Redriven ${result.delivery.projection}/${result.delivery.eventId} `
        + `to generation ${result.redrive.generation} `
        + `(delivery v${result.delivery.version})\n`);
    return result;
  } finally {
    core.close();
  }
}

if (process.argv[1]
  && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    runOutboxRedriveCli();
  } catch (error) {
    const code = error?.code ? `${error.code}: ` : '';
    process.stderr.write(`outbox-redrive: ${code}${error.message}\n`);
    process.exitCode = 1;
  }
}
