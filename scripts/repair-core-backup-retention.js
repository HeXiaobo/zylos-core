#!/usr/bin/env node
/**
 * Explicitly authorized repair for a retired Core backup quarantine.
 *
 * This command is intentionally separate from the pair upgrader. It only
 * removes npm-generated `.bin` symlink directory entries after the Core
 * retention repair API has verified the signed quarantine marker, exact owner
 * authorization, and all filesystem identities.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { repairCoreBackupQuarantine } from './upgrade-fork-pair.js';

function parseArgs(argv) {
  const result = { apply: false, dryRun: false };
  const valueFlags = new Map([
    ['--quarantine-path', 'quarantinePath'],
    ['--authorization', 'authorizationPath'],
    ['--audit-path', 'auditPath'],
    ['--home-dir', 'homeDir'],
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--apply') {
      result.apply = true;
      continue;
    }
    if (arg === '--dry-run') {
      result.dryRun = true;
      continue;
    }
    const key = valueFlags.get(arg);
    if (!key) throw new Error(`unknown option: ${arg}`);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`${arg} requires a value`);
    result[key] = value;
    index += 1;
  }
  if (result.apply === result.dryRun) throw new Error('choose exactly one of --apply or --dry-run');
  for (const [flag, key] of [
    ['--quarantine-path', 'quarantinePath'],
    ['--authorization', 'authorizationPath'],
    ['--audit-path', 'auditPath'],
  ]) {
    if (!result[key]) throw new Error(`${flag} is required`);
  }
  return result;
}

function usageError(error) {
  return {
    status: 'HOLD',
    result: 'NO_MUTATION',
    code: 'INVALID_ARGS',
    error: error.message,
  };
}

function main(argv = process.argv.slice(2)) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (error) {
    process.stdout.write(`${JSON.stringify(usageError(error), null, 2)}\n`);
    return 1;
  }

  let authorization;
  try {
    authorization = JSON.parse(fs.readFileSync(path.resolve(args.authorizationPath), 'utf8'));
  } catch (error) {
    process.stdout.write(`${JSON.stringify({
      status: 'HOLD',
      result: 'NO_MUTATION',
      code: 'RETENTION_REPAIR_AUTHORIZATION_READ_FAILED',
      error: error.message,
    }, null, 2)}\n`);
    return 1;
  }

  const result = repairCoreBackupQuarantine({
    quarantinePath: args.quarantinePath,
    authorization,
    auditPath: args.auditPath,
    apply: args.apply,
    homeDir: args.homeDir ? path.resolve(args.homeDir) : undefined,
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  return result.status === 'PASS' ? 0 : 1;
}

if (path.resolve(process.argv[1] || '') === path.resolve(fileURLToPath(import.meta.url))) {
  process.exitCode = main();
}

