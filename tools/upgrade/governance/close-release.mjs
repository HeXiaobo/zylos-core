#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import {
  closeRelease,
} from './release-transaction.mjs';

function usage() {
  return [
    'Usage: node governance/close-release.mjs --manifest PATH --reason TEXT',
    '  --authorized-by NAME --authorization-ref REF [--report PATH]',
    '  [--proof PATH] [--closed-at ISO_TIMESTAMP]',
    '  [--dry-run | --recover]',
  ].join('\n');
}

function option(args, name) {
  const index = args.indexOf(name);
  if (index >= 0) return args[index + 1];
  const prefix = `${name}=`;
  const inline = args.find(arg => arg.startsWith(prefix));
  return inline ? inline.slice(prefix.length) : undefined;
}

function has(args, name) {
  return args.includes(name);
}

function fail(message, code = 2) {
  console.error(message);
  console.error(usage());
  process.exit(code);
}

function parseArgs(args) {
  const known = new Set([
    '--manifest', '--reason', '--authorized-by', '--authorization-ref',
    '--report', '--proof', '--closed-at', '--dry-run', '--recover',
  ]);
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--dry-run' || argument === '--recover') continue;
    if (!argument.startsWith('--')) fail(`unknown argument: ${argument}`, 64);
    const name = argument.includes('=') ? argument.slice(0, argument.indexOf('=')) : argument;
    if (!known.has(name)) fail(`unknown argument: ${argument}`, 64);
    if (!argument.includes('=') && index + 1 >= args.length) fail(`missing value for ${argument}`, 64);
    if (!argument.includes('=') && args[index + 1].startsWith('--')) fail(`missing value for ${argument}`, 64);
    if (!argument.includes('=')) index += 1;
  }
  const manifest = option(args, '--manifest');
  const reason = option(args, '--reason');
  const authorizedBy = option(args, '--authorized-by');
  const authorizationRef = option(args, '--authorization-ref');
  if (!manifest || !reason || !authorizedBy || !authorizationRef) fail('manifest, reason, authorized-by, and authorization-ref are required', 64);
  return {
    manifestPath: manifest,
    reason,
    authorizedBy,
    authorizationRef,
    reportPath: option(args, '--report'),
    proofPath: option(args, '--proof'),
    closedAt: option(args, '--closed-at'),
    dryRun: has(args, '--dry-run'),
    recover: has(args, '--recover'),
  };
}

function readProof(filename) {
  const resolved = path.resolve(filename);
  if (!fs.existsSync(resolved)) throw new Error(`proof does not exist: ${resolved}`);
  try {
    return JSON.parse(fs.readFileSync(resolved, 'utf8'));
  } catch (error) {
    throw new Error(`proof is not valid JSON: ${error.message}`);
  }
}

function main() {
  const parsed = parseArgs(process.argv.slice(2));
  let suppliedProof = null;
  if (parsed.proofPath) suppliedProof = readProof(parsed.proofPath);
  const result = closeRelease({
    ...parsed,
    suppliedProof,
    closedAt: parsed.closedAt || new Date().toISOString(),
  });
  console.log(JSON.stringify(result, null, 2));
}

if (path.resolve(process.argv[1] || '') === path.resolve(fileURLToPath(import.meta.url))) {
  try {
    main();
  } catch (error) {
    console.error(error.message);
    process.exitCode = error.code === 'USAGE' ? 64 : 2;
  }
}
