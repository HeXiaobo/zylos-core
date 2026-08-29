#!/usr/bin/env node

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const CORE_SCHEMA = 'zylos.legacy-task-adoption/v1';
const FEISHU_SCHEMA = 'zylos.feishu-task-v2-legacy-adoption/v1';
const REPORT_SCHEMA = 'zylos.native-task-convergence-run/v1';
const AUTHORIZATION = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{2,255}$/;

class ConvergenceError extends Error {
  constructor(message, code = 'CONVERGENCE_FAILED', cause) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'ConvergenceError';
    this.code = code;
  }
}

function requireText(value, field) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ConvergenceError(`${field} must be a non-empty string`, 'INVALID_ARGUMENT');
  }
  return value.trim();
}

function readJson(filePath, field, fsApi = fs) {
  try {
    return JSON.parse(fsApi.readFileSync(filePath, 'utf8'));
  } catch (cause) {
    throw new ConvergenceError(`${field} must be readable JSON`, 'INVALID_MANIFEST', cause);
  }
}

function sha256File(filePath, fsApi = fs) {
  return crypto.createHash('sha256').update(fsApi.readFileSync(filePath)).digest('hex');
}

function atomicWriteJson(filePath, value, fsApi = fs) {
  const temporary = `${filePath}.${process.pid}.tmp`;
  fsApi.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fsApi.renameSync(temporary, filePath);
}

function parseArgs(argv) {
  const options = { plan: false, apply: false, authorization: null };
  const valueFlags = new Map([
    ['--core-manifest', 'coreManifest'],
    ['--feishu-manifest', 'feishuManifest'],
    ['--core-dir', 'coreDir'],
    ['--feishu-dir', 'feishuDir'],
    ['--report-dir', 'reportDir'],
    ['--authorization', 'authorization'],
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--plan' || argument === '--apply') {
      const key = argument.slice(2);
      if (options[key]) throw new ConvergenceError(`duplicate flag: ${argument}`, 'INVALID_ARGUMENT');
      options[key] = true;
      continue;
    }
    const key = valueFlags.get(argument);
    if (!key) throw new ConvergenceError(`unknown option: ${argument}`, 'INVALID_ARGUMENT');
    if (options[key] !== undefined && options[key] !== null) {
      throw new ConvergenceError(`duplicate flag: ${argument}`, 'INVALID_ARGUMENT');
    }
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) {
      throw new ConvergenceError(`${argument} requires a value`, 'INVALID_ARGUMENT');
    }
    options[key] = requireText(value, argument);
    index += 1;
  }
  if (options.plan === options.apply) {
    throw new ConvergenceError('choose exactly one of --plan or --apply', 'INVALID_ARGUMENT');
  }
  for (const field of ['coreManifest', 'feishuManifest', 'coreDir', 'feishuDir', 'reportDir']) {
    if (!options[field]) throw new ConvergenceError(`--${field.replace(/[A-Z]/g, value => `-${value.toLowerCase()}`)} is required`, 'INVALID_ARGUMENT');
    options[field] = path.resolve(options[field]);
  }
  if (options.apply && !AUTHORIZATION.test(String(options.authorization ?? ''))) {
    throw new ConvergenceError('--apply requires a stable --authorization receipt id', 'REPAIR_NOT_AUTHORIZED');
  }
  if (options.plan && options.authorization !== null) {
    throw new ConvergenceError('--authorization is valid only with --apply', 'INVALID_ARGUMENT');
  }
  return options;
}

function requireRecord(value, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ConvergenceError(`${field} must be an object`, 'INVALID_MANIFEST');
  }
  return value;
}

/** Ensure the independently parsed Core and Feishu manifests name one exact set. */
export function validateConvergenceManifestPair({ coreManifest, feishuManifest } = {}) {
  const core = requireRecord(coreManifest, 'Core manifest');
  const feishu = requireRecord(feishuManifest, 'Feishu manifest');
  if (core.schema !== CORE_SCHEMA || feishu.schema !== FEISHU_SCHEMA) {
    return { ok: false, error: 'unsupported Core or Feishu adoption manifest schema' };
  }
  if (!Array.isArray(core.entries) || !Array.isArray(feishu.entries) || core.entries.length === 0) {
    return { ok: false, error: 'adoption manifests must contain non-empty entries' };
  }
  if (core.entries.length !== feishu.entries.length) {
    return { ok: false, error: 'Core and Feishu adoption manifests have different entry counts' };
  }
  const corePairs = core.entries.map((entry) => `${entry?.externalId}\0${entry?.taskId}`).sort();
  const feishuPairs = feishu.entries.map((entry) => `${entry?.taskGuid}\0${entry?.coreTaskId}`).sort();
  if (corePairs.some((pair, index) => pair !== feishuPairs[index])) {
    return { ok: false, error: 'Core externalId/taskId pairs do not exactly match Feishu taskGuid/coreTaskId pairs' };
  }
  return {
    ok: true,
    appId: feishu.appId,
    entries: corePairs.map(pair => {
      const [taskGuid, coreTaskId] = pair.split('\0');
      return { taskGuid, coreTaskId };
    }),
  };
}

export function buildNativeTaskConvergenceCommands({
  nodePath = process.execPath,
  coreDir,
  feishuDir,
  coreManifest,
  feishuManifest,
  apply = false,
} = {}) {
  const coreArgs = [
    path.join(coreDir, 'skills', 'commitment-core', 'scripts', 'legacy-task-adoption.js'),
    '--manifest', coreManifest,
    '--json',
    ...(apply ? ['--commit'] : []),
  ];
  const feishuArgs = [
    path.join(feishuDir, 'scripts', 'task-v2-legacy-adoption-bootstrap.js'),
    '--manifest', feishuManifest,
    ...(apply ? ['--commit'] : []),
  ];
  const reconciliationArgs = [
    path.join(feishuDir, 'src', 'lib', 'task-v2-projection-worker.js'),
    'reconcile',
    ...(apply ? ['--repair-status'] : []),
  ];
  return {
    plans: [
      { name: 'core-plan', command: nodePath, args: coreArgs.filter(value => value !== '--commit') },
      { name: 'feishu-plan', command: nodePath, args: feishuArgs.filter(value => value !== '--commit') },
      { name: 'status-plan', command: nodePath, args: reconciliationArgs.filter(value => value !== '--repair-status') },
    ],
    apply: [
      // Mark the exact remote Task first; a Core commit can then be safely replayed.
      { name: 'feishu-apply', command: nodePath, args: feishuArgs },
      { name: 'core-apply', command: nodePath, args: coreArgs },
      { name: 'status-apply', command: nodePath, args: reconciliationArgs },
    ],
  };
}

function parseJsonOutput(result, name) {
  if (result.error || result.status !== 0) {
    throw new ConvergenceError(
      `${name} failed: ${result.error?.message ?? result.stderr?.trim() ?? `exit ${result.status}`}`,
      'CONVERGENCE_STEP_FAILED',
      result.error,
    );
  }
  try {
    return JSON.parse(result.stdout.trim());
  } catch (cause) {
    throw new ConvergenceError(`${name} returned invalid JSON`, 'INVALID_STEP_REPORT', cause);
  }
}

function validateStepReport(name, report) {
  if (name.startsWith('core-') && report?.failed !== 0) {
    throw new ConvergenceError(`${name} reported ${report?.failed ?? 'unknown'} failures`, 'CONVERGENCE_STEP_HOLD');
  }
  if (name.startsWith('feishu-') && report?.status !== 'PASS') {
    throw new ConvergenceError(`${name} did not PASS`, 'CONVERGENCE_STEP_HOLD');
  }
  if (name.startsWith('status-') && (!report || typeof report !== 'object')) {
    throw new ConvergenceError(`${name} returned no reconciliation report`, 'INVALID_STEP_REPORT');
  }
}

export function runNativeTaskConvergence({
  argv = process.argv.slice(2),
  env = process.env,
  fsApi = fs,
  spawn = spawnSync,
  stdout = process.stdout,
} = {}) {
  const options = parseArgs(argv);
  fsApi.mkdirSync(options.reportDir, { recursive: true });
  const summaryPath = path.join(options.reportDir, 'summary.json');
  const summary = {
    schema: REPORT_SCHEMA,
    status: 'RUNNING',
    mode: options.apply ? 'apply' : 'plan',
    authorization: options.apply ? options.authorization : null,
    startedAt: new Date().toISOString(),
    manifests: {
      core: { path: options.coreManifest, sha256: sha256File(options.coreManifest, fsApi) },
      feishu: { path: options.feishuManifest, sha256: sha256File(options.feishuManifest, fsApi) },
    },
    steps: [],
  };
  atomicWriteJson(summaryPath, summary, fsApi);
  try {
    const pair = validateConvergenceManifestPair({
      coreManifest: readJson(options.coreManifest, 'Core manifest', fsApi),
      feishuManifest: readJson(options.feishuManifest, 'Feishu manifest', fsApi),
    });
    if (!pair.ok) throw new ConvergenceError(pair.error, 'MANIFEST_PAIR_MISMATCH');
    summary.target = pair;
    const commands = buildNativeTaskConvergenceCommands({
      coreDir: options.coreDir,
      feishuDir: options.feishuDir,
      coreManifest: options.coreManifest,
      feishuManifest: options.feishuManifest,
      apply: options.apply,
    });
    const sequence = options.apply ? [...commands.plans, ...commands.apply] : commands.plans;
    for (const step of sequence) {
      const result = spawn(step.command, step.args, {
        env: { ...env, ZYLOS_DIR: env.ZYLOS_DIR || path.join(os.homedir(), 'zylos') },
        encoding: 'utf8',
        timeout: 180_000,
        maxBuffer: 8 * 1024 * 1024,
      });
      const report = parseJsonOutput(result, step.name);
      validateStepReport(step.name, report);
      const reportPath = path.join(options.reportDir, `${step.name}.json`);
      atomicWriteJson(reportPath, report, fsApi);
      summary.steps.push({
        name: step.name,
        reportPath,
        reportSha256: sha256File(reportPath, fsApi),
      });
      atomicWriteJson(summaryPath, summary, fsApi);
    }
    summary.status = 'PASS';
    summary.result = options.apply ? 'CONVERGENCE_APPLIED' : 'PLAN_COMPLETE';
  } catch (error) {
    summary.status = 'HOLD';
    summary.code = error?.code ?? 'CONVERGENCE_FAILED';
    summary.error = error?.message ?? String(error);
  }
  summary.finishedAt = new Date().toISOString();
  atomicWriteJson(summaryPath, summary, fsApi);
  stdout.write(`${JSON.stringify(summary)}\n`);
  return summary;
}

const isMain = process.argv[1]
  && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  try {
    const report = runNativeTaskConvergence();
    process.exitCode = report.status === 'PASS' ? 0 : 1;
  } catch (error) {
    process.stderr.write(`${JSON.stringify({
      schema: 'zylos.native-task-convergence-run/error-v1',
      status: 'HOLD',
      code: error?.code ?? 'INVALID_ARGUMENT',
      error: error?.message ?? String(error),
    })}\n`);
    process.exitCode = error?.code === 'INVALID_ARGUMENT' || error?.code === 'INVALID_MANIFEST' ? 2 : 1;
  }
}
