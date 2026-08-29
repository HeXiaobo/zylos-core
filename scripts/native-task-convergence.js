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
const STEP_RECEIPT_SCHEMA = 'zylos.native-task-convergence-step/v1';
const LOCK_SCHEMA = 'zylos.native-task-convergence-lock/v1';
const AUTHORIZATION = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{2,255}$/;
const TRANSACTION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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
      // The repair command reports the pre-repair snapshot. A fresh readback is
      // the only authoritative proof that the status drift actually closed.
      { name: 'status-verify', command: nodePath, args: reconciliationArgs.filter(value => value !== '--repair-status') },
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
  if (name === 'status-verify' && report.consistent !== true) {
    throw new ConvergenceError('status repair readback is not consistent', 'CONVERGENCE_STEP_HOLD');
  }
  if (name === 'status-verify') {
    for (const field of [
      'missing',
      'unexpected',
      'stateMismatches',
      'duplicateKeys',
      'missingLinks',
      'linkMismatches',
      'reminderDrifts',
    ]) {
      if (!Array.isArray(report[field])) {
        throw new ConvergenceError(`status repair readback omitted ${field}`, 'INVALID_STEP_REPORT');
      }
      if (report[field].length > 0) {
        throw new ConvergenceError(`status repair readback retained ${field}`, 'CONVERGENCE_STEP_HOLD');
      }
    }
  }
}

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

function readOptionalJson(filePath, fsApi = fs) {
  try {
    return JSON.parse(fsApi.readFileSync(filePath, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw new ConvergenceError(`existing evidence is unreadable: ${filePath}`, 'INVALID_STEP_REPORT', error);
  }
}

function acquireApplyLock({ zylosDir, transactionId, fsApi = fs, hostname = os.hostname(), isAlive = processIsAlive }) {
  const lockDir = path.join(zylosDir, '.zylos', 'locks');
  const lockPath = path.join(lockDir, 'native-task-convergence.lock');
  fsApi.mkdirSync(lockDir, { recursive: true, mode: 0o700 });
  const owner = {
    schema: LOCK_SCHEMA,
    transactionId,
    pid: process.pid,
    hostname,
    acquiredAt: new Date().toISOString(),
  };
  const create = () => fsApi.writeFileSync(
    lockPath,
    `${JSON.stringify(owner, null, 2)}\n`,
    { encoding: 'utf8', mode: 0o600, flag: 'wx' },
  );
  try {
    create();
  } catch (error) {
    if (error?.code !== 'EEXIST') {
      throw new ConvergenceError('cannot acquire native Task convergence lock', 'LOCK_FAILED', error);
    }
    let stat;
    try {
      stat = fsApi.lstatSync(lockPath);
    } catch (cause) {
      throw new ConvergenceError('cannot inspect native Task convergence lock', 'LOCK_FAILED', cause);
    }
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new ConvergenceError('native Task convergence lock is not a regular file', 'LOCK_FAILED');
    }
    const existing = readOptionalJson(lockPath, fsApi);
    if (
      existing?.schema !== LOCK_SCHEMA
      || !TRANSACTION_ID.test(String(existing.transactionId ?? ''))
      || typeof existing.hostname !== 'string'
      || !Number.isInteger(existing.pid)
    ) {
      throw new ConvergenceError('native Task convergence lock owner is invalid', 'LOCK_FAILED');
    }
    if (existing.hostname !== hostname || isAlive(existing.pid)) {
      throw new ConvergenceError(
        `native Task convergence is already running as ${existing.transactionId}`,
        'LOCK_HELD',
      );
    }
    const stalePath = `${lockPath}.stale.${existing.transactionId}.${Date.now()}.${process.pid}`;
    fsApi.renameSync(lockPath, stalePath);
    create();
  }
  return () => {
    const existing = readOptionalJson(lockPath, fsApi);
    if (existing?.transactionId !== transactionId) {
      throw new ConvergenceError('native Task convergence lock ownership was lost', 'LOCK_RELEASE_FAILED');
    }
    fsApi.unlinkSync(lockPath);
  };
}

function commandReceipt({
  transactionId,
  manifestSha256,
  step,
  attempt,
  status,
  startedAt,
  finishedAt = null,
  exitCode = null,
  reportPath = null,
  reportSha256 = null,
  error = null,
}) {
  return {
    schema: STEP_RECEIPT_SCHEMA,
    transactionId,
    manifestSha256,
    step: step.name,
    command: { executable: step.command, args: step.args },
    attempt,
    status,
    attemptedAt: startedAt,
    startedAt,
    finishedAt,
    exitCode,
    reportPath,
    reportSha256,
    error,
  };
}

function previousStepReceipt(reportDir, stepName, fsApi = fs) {
  const prefix = `${stepName}.attempt-`;
  const attempts = fsApi.readdirSync(reportDir)
    .filter(name => name.startsWith(prefix) && name.endsWith('.receipt.json'))
    .map(name => ({
      name,
      attempt: Number(name.slice(prefix.length, -'.receipt.json'.length)),
    }))
    .filter(entry => Number.isInteger(entry.attempt) && entry.attempt > 0)
    .sort((left, right) => right.attempt - left.attempt);
  if (attempts.length === 0) return null;
  return readOptionalJson(path.join(reportDir, attempts[0].name), fsApi);
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
  const manifestSha256 = {
    core: sha256File(options.coreManifest, fsApi),
    feishu: sha256File(options.feishuManifest, fsApi),
  };
  const runtimeDir = path.resolve(env.ZYLOS_DIR || path.join(os.homedir(), 'zylos'));
  const runtimeHostname = os.hostname();
  const existingSummary = readOptionalJson(summaryPath, fsApi);
  const resumable = options.apply
    && existingSummary?.schema === REPORT_SCHEMA
    && existingSummary?.mode === 'apply'
    && TRANSACTION_ID.test(String(existingSummary.transactionId ?? ''))
    && existingSummary.manifests?.core?.sha256 === manifestSha256.core
    && existingSummary.manifests?.feishu?.sha256 === manifestSha256.feishu
    && existingSummary.authorization === options.authorization
    && existingSummary.runtime?.zylosDir === runtimeDir
    && existingSummary.runtime?.hostname === runtimeHostname
    && ['RUNNING', 'HOLD'].includes(existingSummary.status);
  if (existingSummary && !resumable) {
    throw new ConvergenceError(
      'report directory already contains evidence for a different or terminal transaction',
      'REPORT_IDENTITY_MISMATCH',
    );
  }
  const transactionId = resumable ? existingSummary.transactionId : crypto.randomUUID();
  const summary = {
    schema: REPORT_SCHEMA,
    transactionId,
    status: 'RUNNING',
    mode: options.apply ? 'apply' : 'plan',
    authorization: options.apply ? options.authorization : null,
    startedAt: resumable ? existingSummary.startedAt : new Date().toISOString(),
    resumedAt: resumable ? new Date().toISOString() : null,
    attempt: resumable ? Number(existingSummary.attempt || 1) + 1 : 1,
    resumePolicy: options.apply ? 'READBACK_THEN_IDEMPOTENT_REPLAY' : null,
    runtime: { zylosDir: runtimeDir, hostname: runtimeHostname },
    manifests: {
      core: { path: options.coreManifest, sha256: manifestSha256.core },
      feishu: { path: options.feishuManifest, sha256: manifestSha256.feishu },
    },
    steps: [],
  };
  let releaseLock = null;
  if (options.apply) {
    releaseLock = acquireApplyLock({ zylosDir: runtimeDir, transactionId, fsApi });
  }
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
      const currentReceiptPath = path.join(options.reportDir, `${step.name}.receipt.json`);
      const previousReceipt = previousStepReceipt(options.reportDir, step.name, fsApi);
      const attempt = Number.isInteger(previousReceipt?.attempt) ? previousReceipt.attempt + 1 : 1;
      const receiptPath = path.join(options.reportDir, `${step.name}.attempt-${attempt}.receipt.json`);
      const startedAt = new Date().toISOString();
      const receiptBase = {
        transactionId,
        manifestSha256,
        step,
        attempt,
        startedAt,
      };
      const writeReceipt = value => {
        atomicWriteJson(receiptPath, value, fsApi);
        atomicWriteJson(currentReceiptPath, value, fsApi);
      };
      writeReceipt({
        ...commandReceipt({ ...receiptBase, status: 'ATTEMPTED' }),
        previousStatus: previousReceipt?.status ?? null,
      });
      writeReceipt({
        ...commandReceipt({ ...receiptBase, status: 'RUNNING' }),
        previousStatus: previousReceipt?.status ?? null,
      });
      const result = spawn(step.command, step.args, {
        env: { ...env, ZYLOS_DIR: runtimeDir },
        encoding: 'utf8',
        timeout: 180_000,
        maxBuffer: 8 * 1024 * 1024,
      });
      try {
        const report = parseJsonOutput(result, step.name);
        validateStepReport(step.name, report);
        const reportPath = path.join(options.reportDir, `${step.name}.json`);
        atomicWriteJson(reportPath, report, fsApi);
        const reportSha256 = sha256File(reportPath, fsApi);
        writeReceipt(commandReceipt({
          ...receiptBase,
          status: 'PASS',
          finishedAt: new Date().toISOString(),
          exitCode: result.status,
          reportPath,
          reportSha256,
        }));
        summary.steps.push({
          name: step.name,
          receiptPath,
          currentReceiptPath,
          reportPath,
          reportSha256,
        });
        atomicWriteJson(summaryPath, summary, fsApi);
      } catch (error) {
        const uncertain = Boolean(result.error) || result.status === null;
        writeReceipt(commandReceipt({
          ...receiptBase,
          status: uncertain ? 'UNKNOWN' : 'HOLD',
          finishedAt: new Date().toISOString(),
          exitCode: result.status ?? null,
          error: error?.message ?? String(error),
        }));
        throw error;
      }
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
  if (releaseLock) {
    try {
      releaseLock();
    } catch (error) {
      summary.status = 'HOLD';
      summary.code = 'LOCK_RELEASE_FAILED';
      summary.error = `cannot release native Task convergence lock: ${error?.message ?? String(error)}`;
      atomicWriteJson(summaryPath, summary, fsApi);
    }
  }
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
