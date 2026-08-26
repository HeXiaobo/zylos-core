#!/usr/bin/env node
/**
 * Deterministic Core + Feishu fork upgrade orchestrator.
 *
 * This file intentionally uses only Node built-ins. The immutable bootstrap
 * downloads a Core archive by full commit SHA, then this orchestrator validates
 * both target archives and the live deployment before invoking either upgrade.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const CORE_REPO = 'HeXiaobo/zylos-core';
const FEISHU_REPO = 'HeXiaobo/zylos-feishu';
const FULL_SHA = /^[0-9a-f]{40}$/i;
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const MIN_AVAILABLE_KB = 5 * 1024 * 1024;

const CORE_PROTOCOLS = Object.freeze({
  'c4.reply': 2,
  'c4.reply.argv-compat': 1,
  'c4.reply.body-file': 1,
  'external-task-adapter': 1,
  'task-reminder': 1,
});

const CORE_ASSETS = Object.freeze([
  'skills/comm-bridge/scripts/c4-send.js',
  'skills/comm-bridge/scripts/c4-receive.js',
  'skills/comm-bridge/scripts/c4-dispatcher.js',
  'skills/comm-bridge/scripts/c4-response-stream-supervisor.js',
  'scripts/upgrade-fork-pair.js',
  'scripts/upgrade-fork-pair.sh',
]);

const FEISHU_ASSETS = Object.freeze([
  'src/index.js',
  'hooks/pre-upgrade.js',
  'hooks/post-upgrade.js',
  'scripts/native-task-closure-gate.js',
  'scripts/native-task-completion-gate.js',
  'src/lib/task-comment-worker.js',
  'src/lib/task-v2-projection.js',
]);

class HoldError extends Error {
  constructor(message, code = 'PRECHECK_FAILED') {
    super(message);
    this.name = 'HoldError';
    this.code = code;
  }
}

function readJson(filePath, fsApi = fs) {
  return JSON.parse(fsApi.readFileSync(filePath, 'utf8'));
}

function fileIsRegular(filePath, fsApi = fs) {
  try {
    return fsApi.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function validateAssets(root, assets, fsApi = fs) {
  return assets.filter((relativePath) => !fileIsRegular(path.join(root, relativePath), fsApi));
}

function validateProtocols(actual, required) {
  const errors = [];
  for (const [name, minimum] of Object.entries(required)) {
    const value = actual?.[name];
    if (!Number.isInteger(value) || value < minimum) {
      errors.push(`${name} requires >= ${minimum}, found ${value ?? 'missing'}`);
    }
  }
  return errors;
}

export function validatePinnedTarget({ coreSha, feishuSha, coreVersion, feishuVersion, agent } = {}) {
  if (!FULL_SHA.test(String(coreSha || ''))) {
    return { ok: false, error: 'core SHA must be a full immutable 40-hex commit' };
  }
  if (!FULL_SHA.test(String(feishuSha || ''))) {
    return { ok: false, error: 'Feishu SHA must be a full immutable 40-hex commit' };
  }
  if (!VERSION.test(String(coreVersion || ''))) {
    return { ok: false, error: 'Core expected version is missing or invalid' };
  }
  if (!VERSION.test(String(feishuVersion || ''))) {
    return { ok: false, error: 'Feishu expected version is missing or invalid' };
  }
  if (!String(agent || '').trim() || agent === 'unknown') {
    return { ok: false, error: 'agent identity is required' };
  }
  return { ok: true };
}

export function validateCoreSource(root, expectedVersion, fsApi = fs) {
  try {
    const pkg = readJson(path.join(root, 'package.json'), fsApi);
    const capabilities = readJson(path.join(root, 'capabilities.json'), fsApi);
    const errors = [];
    if (pkg.name !== 'zylos') errors.push(`package name must be zylos, found ${pkg.name ?? 'missing'}`);
    if (pkg.version !== expectedVersion) {
      errors.push(`package version must be ${expectedVersion}, found ${pkg.version ?? 'missing'}`);
    }
    if (capabilities.product !== 'zylos-core') {
      errors.push(`capability product must be zylos-core, found ${capabilities.product ?? 'missing'}`);
    }
    if (capabilities.release !== expectedVersion) {
      errors.push(`capability release must be ${expectedVersion}, found ${capabilities.release ?? 'missing'}`);
    }
    errors.push(...validateProtocols(capabilities.protocols, CORE_PROTOCOLS));
    const missing = validateAssets(root, CORE_ASSETS, fsApi);
    if (missing.length > 0) errors.push(`missing critical Core assets: ${missing.join(', ')}`);
    return errors.length === 0 ? { ok: true, package: pkg, capabilities } : {
      ok: false,
      error: errors.join('; '),
    };
  } catch (error) {
    return { ok: false, error: `invalid Core source: ${error.message}` };
  }
}

export function validateFeishuSource(root, expectedVersion, fsApi = fs) {
  try {
    const pkg = readJson(path.join(root, 'package.json'), fsApi);
    const capabilities = readJson(path.join(root, 'capabilities.json'), fsApi);
    const errors = [];
    if (pkg.name !== 'zylos-feishu') {
      errors.push(`package name must be zylos-feishu, found ${pkg.name ?? 'missing'}`);
    }
    if (pkg.version !== expectedVersion) {
      errors.push(`package version must be ${expectedVersion}, found ${pkg.version ?? 'missing'}`);
    }
    if (capabilities.product !== 'zylos-feishu') {
      errors.push(`capability product must be zylos-feishu, found ${capabilities.product ?? 'missing'}`);
    }
    if (capabilities.release !== expectedVersion) {
      errors.push(`capability release must be ${expectedVersion}, found ${capabilities.release ?? 'missing'}`);
    }
    errors.push(...validateProtocols(
      capabilities.requires?.['zylos-core']?.protocols,
      CORE_PROTOCOLS,
    ));
    const missing = validateAssets(root, FEISHU_ASSETS, fsApi);
    if (missing.length > 0) errors.push(`missing critical Feishu assets: ${missing.join(', ')}`);
    return errors.length === 0 ? { ok: true, package: pkg, capabilities } : {
      ok: false,
      error: errors.join('; '),
    };
  } catch (error) {
    return { ok: false, error: `invalid Feishu source: ${error.message}` };
  }
}

export function buildUpgradeCommands({
  nodePath,
  stagedCoreDir,
  installedCoreDir,
  coreSha,
  feishuSha,
}) {
  return {
    core: {
      command: nodePath,
      args: [
        path.join(stagedCoreDir, 'cli', 'zylos.js'),
        'upgrade', '--self', '--branch', coreSha, '--yes', '--json',
      ],
    },
    feishu: {
      command: nodePath,
      args: [
        path.join(installedCoreDir, 'cli', 'zylos.js'),
        'upgrade', 'feishu', '--branch', feishuSha,
        '--yes', '--skip-eval', '--json',
      ],
    },
  };
}

function parseArgs(argv) {
  const result = { execute: false, dryRun: false, agent: 'unknown' };
  const valueFlags = new Map([
    ['--core-sha', 'coreSha'],
    ['--feishu-sha', 'feishuSha'],
    ['--core-version', 'coreVersion'],
    ['--feishu-version', 'feishuVersion'],
    ['--staged-core', 'stagedCoreDir'],
    ['--agent', 'agent'],
    ['--report-root', 'reportRoot'],
  ]);

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--execute') {
      result.execute = true;
      continue;
    }
    if (arg === '--dry-run') {
      result.dryRun = true;
      continue;
    }
    const key = valueFlags.get(arg);
    if (!key) throw new HoldError(`unknown option: ${arg}`, 'INVALID_ARGS');
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) {
      throw new HoldError(`${arg} requires a value`, 'INVALID_ARGS');
    }
    result[key] = value;
    index += 1;
  }

  if (result.execute === result.dryRun) {
    throw new HoldError('choose exactly one of --execute or --dry-run', 'INVALID_ARGS');
  }
  if (!result.stagedCoreDir) {
    throw new HoldError('--staged-core is required; use the immutable bootstrap', 'INVALID_ARGS');
  }
  return result;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    timeout: options.timeout ?? 120_000,
    cwd: options.cwd,
    env: options.env ?? process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return {
    status: result.status,
    signal: result.signal,
    stdout: String(result.stdout || ''),
    stderr: String(result.stderr || ''),
    error: result.error?.message ?? null,
  };
}

function requireSuccess(result, label, code = 'COMMAND_FAILED') {
  if (result.status === 0 && !result.error) return result;
  const detail = result.error
    || result.stderr.trim().split(/\r?\n/).find(Boolean)
    || result.stdout.trim().split(/\r?\n/).find(Boolean)
    || `exit ${result.status}`;
  throw new HoldError(`${label}: ${detail}`, code);
}

function parseJsonOutput(output) {
  const text = String(output || '').trim();
  try {
    return JSON.parse(text);
  } catch {
    for (let index = 0; index < text.length; index += 1) {
      if (text[index] !== '{' && text[index] !== '[') continue;
      try {
        return JSON.parse(text.slice(index));
      } catch {
        // Try the next possible boundary.
      }
    }
  }
  return null;
}

function atomicWriteJson(filePath, value) {
  const tempPath = `${filePath}.tmp-${process.pid}`;
  fs.writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tempPath, filePath);
}

function hashFile(filePath) {
  if (!fileIsRegular(filePath)) return null;
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function persistedEnvValue(filePath, name) {
  let content;
  try {
    content = fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const match = line.match(/^([A-Z0-9_]+)\s*=\s*(.*)$/);
    if (match?.[1] !== name) continue;
    return match[2].trim().replace(/^(['"])(.*)\1$/, '$2');
  }
  return null;
}

function pm2Snapshot() {
  const result = requireSuccess(run('pm2', ['jlist']), 'PM2 inspection failed');
  const processes = parseJsonOutput(result.stdout);
  if (!Array.isArray(processes)) throw new HoldError('PM2 returned invalid JSON');
  return processes.map((proc) => ({
    name: proc.name,
    status: proc.pm2_env?.status ?? 'unknown',
    pid: proc.pid ?? null,
    execPath: proc.pm2_env?.pm_exec_path ?? null,
    restartTime: proc.pm2_env?.restart_time ?? null,
    unstableRestarts: proc.pm2_env?.unstable_restarts ?? null,
  })).sort((left, right) => String(left.name).localeCompare(String(right.name)));
}

export function validatePm2Snapshot(snapshot, { requireSupervisor = false } = {}) {
  const required = ['activity-monitor', 'c4-dispatcher', 'zylos-feishu'];
  if (requireSupervisor) required.push('c4-response-stream-supervisor');
  const errors = [];
  for (const name of required) {
    const proc = snapshot.find((candidate) => candidate.name === name);
    if (!proc || proc.status !== 'online') {
      errors.push(`${name} is not online`);
    }
  }
  for (const proc of snapshot) {
    if (proc.status !== 'online') continue;
    if (!proc.execPath || !fileIsRegular(proc.execPath)) {
      errors.push(
        `${proc.name} reports online but has no live executable at ${proc.execPath || '(unset)'}`,
      );
    }
  }
  return errors;
}

/**
 * Plan the one safe preflight repair needed after an older Core rollback.
 *
 * The repair is deliberately exact: the known target-only service name must
 * point at its canonical live path, that path must be absent in the restored
 * baseline, and the immutable target must contain the replacement entrypoint.
 * Anything else remains a HOLD for human diagnosis.
 */
export function planPm2PreflightRepairs(snapshot, {
  zylosDir,
  stagedCoreDir,
  fsApi = fs,
} = {}) {
  if (!zylosDir || !stagedCoreDir) return [];
  const name = 'c4-response-stream-supervisor';
  const expectedLivePath = path.join(
    path.resolve(zylosDir),
    '.claude',
    'skills',
    'comm-bridge',
    'scripts',
    'c4-response-stream-supervisor.js',
  );
  const targetPath = path.join(
    path.resolve(stagedCoreDir),
    'skills',
    'comm-bridge',
    'scripts',
    'c4-response-stream-supervisor.js',
  );
  const proc = snapshot.find((candidate) => candidate.name === name);
  if (
    proc?.status !== 'online'
    || !proc.execPath
    || path.resolve(proc.execPath) !== expectedLivePath
    || fileIsRegular(expectedLivePath, fsApi)
    || !fileIsRegular(targetPath, fsApi)
  ) {
    return [];
  }
  return [{
    action: 'delete_rollback_orphan',
    name,
    execPath: expectedLivePath,
    targetPath,
  }];
}

function applyPm2PreflightRepairs(repairs) {
  const applied = [];
  for (const repair of repairs) {
    requireSuccess(
      run('pm2', ['delete', repair.name]),
      `failed to delete rollback orphan ${repair.name}`,
      'PREFLIGHT_REPAIR_FAILED',
    );
    applied.push({ ...repair, status: 'APPLIED' });
  }
  if (applied.length > 0) {
    requireSuccess(
      run('pm2', ['save']),
      'failed to persist repaired PM2 process list',
      'PREFLIGHT_REPAIR_FAILED',
    );
  }
  return applied;
}

function availableDiskKb(targetPath) {
  const result = requireSuccess(run('df', ['-Pk', targetPath]), 'disk inspection failed');
  const lines = result.stdout.trim().split(/\r?\n/);
  const fields = lines.at(-1)?.trim().split(/\s+/);
  const available = Number(fields?.[3]);
  if (!Number.isFinite(available)) throw new HoldError('could not parse available disk space');
  return available;
}

function stageImmutableArchive(repo, sha, destination) {
  const archivePath = path.join(path.dirname(destination), `${path.basename(destination)}.tar.gz`);
  fs.mkdirSync(destination, { recursive: true });
  requireSuccess(run('curl', [
    '-fsSL', '--retry', '2', '--retry-all-errors',
    '--output', archivePath,
    `https://github.com/${repo}/archive/${sha}.tar.gz`,
  ], { timeout: 120_000 }), `download ${repo}@${sha} failed`);
  requireSuccess(run('tar', [
    'xzf', archivePath, '-C', destination, '--strip-components=1',
  ], { timeout: 120_000 }), `extract ${repo}@${sha} failed`);
  return archivePath;
}

function commandEvidence(result) {
  return {
    status: result.status,
    signal: result.signal,
    error: result.error,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

function verifyUpgradeResult(result, label) {
  requireSuccess(result, `${label} process failed`, 'UPGRADE_FAILED');
  const payload = parseJsonOutput(result.stdout);
  if (!payload || payload.success !== true) {
    throw new HoldError(
      `${label} reported failure: ${payload?.error || 'invalid JSON result'}`,
      'UPGRADE_FAILED',
    );
  }
  return payload;
}

function runCommunicationCanary(installedCoreDir, zylosDir) {
  const moduleUrl = pathToFileURL(path.join(
    installedCoreDir,
    'cli',
    'lib',
    'communication-continuity.js',
  )).href;
  const skillsDir = path.join(zylosDir, '.claude', 'skills', 'comm-bridge', 'scripts');
  const expression = [
    `import { verifyCommunicationContinuity } from ${JSON.stringify(moduleUrl)};`,
    `const result = verifyCommunicationContinuity({`,
    `c4SendPath:${JSON.stringify(path.join(skillsDir, 'c4-send.js'))},`,
    `c4ReceivePath:${JSON.stringify(path.join(skillsDir, 'c4-receive.js'))},`,
    `c4DbPath:${JSON.stringify(path.join(skillsDir, 'c4-db.js'))},`,
    `zylosDir:${JSON.stringify(zylosDir)}});`,
    `process.stdout.write(JSON.stringify(result));`,
    `if (!result.compatible) process.exitCode = 1;`,
  ].join('');
  const result = requireSuccess(run(process.execPath, [
    '--input-type=module', '--eval', expression,
  ], { timeout: 30_000 }), 'communication canary failed', 'POSTCHECK_FAILED');
  const payload = parseJsonOutput(result.stdout);
  if (!payload?.compatible) throw new HoldError('communication canary returned invalid result');
  return payload;
}

function makeReportDir(zylosDir, explicitRoot) {
  const root = explicitRoot
    ? path.resolve(explicitRoot)
    : path.join(zylosDir, '.zylos', 'upgrade-reports');
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const reportDir = path.join(root, `fork-pair-${timestamp}`);
  fs.mkdirSync(reportDir, { recursive: true });
  return reportDir;
}

export function runForkPairUpgrade(argv = process.argv.slice(2)) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (error) {
    const output = { status: 'HOLD', code: error.code || 'INVALID_ARGS', error: error.message };
    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
    return 1;
  }

  const targetCheck = validatePinnedTarget(args);
  if (!targetCheck.ok) {
    process.stdout.write(`${JSON.stringify({
      status: 'HOLD',
      code: 'INVALID_TARGET',
      error: targetCheck.error,
    }, null, 2)}\n`);
    return 1;
  }

  const zylosDir = path.resolve(process.env.ZYLOS_DIR || path.join(os.homedir(), 'zylos'));
  const reportDir = makeReportDir(zylosDir, args.reportRoot);
  const summaryPath = path.join(reportDir, 'summary.json');
  const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-fork-pair-upgrade-'));
  const summary = {
    schema: 'zylos.fork-pair-upgrade/v1',
    status: 'RUNNING',
    mode: args.execute ? 'execute' : 'dry-run',
    agent: args.agent,
    startedAt: new Date().toISOString(),
    target: {
      core: { repo: CORE_REPO, sha: args.coreSha, version: args.coreVersion },
      feishu: { repo: FEISHU_REPO, sha: args.feishuSha, version: args.feishuVersion },
    },
    reportDir,
    coreUpgraded: false,
    feishuUpgraded: false,
  };
  atomicWriteJson(summaryPath, summary);

  try {
    const stagedCoreDir = path.resolve(args.stagedCoreDir);
    const coreSource = validateCoreSource(stagedCoreDir, args.coreVersion);
    if (!coreSource.ok) throw new HoldError(coreSource.error, 'INVALID_CORE_SOURCE');

    const stagedFeishuDir = path.join(scratchDir, 'feishu');
    stageImmutableArchive(FEISHU_REPO, args.feishuSha, stagedFeishuDir);
    const feishuSource = validateFeishuSource(stagedFeishuDir, args.feishuVersion);
    if (!feishuSource.ok) throw new HoldError(feishuSource.error, 'INVALID_FEISHU_SOURCE');

    const envPath = path.join(zylosDir, '.env');
    const persistedCoreRepo = persistedEnvValue(envPath, 'ZYLOS_SELF_UPGRADE_REPO');
    if (persistedCoreRepo !== CORE_REPO) {
      throw new HoldError(
        `persisted ZYLOS_SELF_UPGRADE_REPO must be ${CORE_REPO}, found ${persistedCoreRepo ?? 'missing'}`,
        'FORK_ROUTING_INVALID',
      );
    }
    const componentsPath = path.join(zylosDir, '.zylos', 'components.json');
    const components = readJson(componentsPath);
    if (components.feishu?.repo !== FEISHU_REPO) {
      throw new HoldError(
        `Feishu component repo must be ${FEISHU_REPO}, found ${components.feishu?.repo ?? 'missing'}`,
        'FORK_ROUTING_INVALID',
      );
    }

    const liveReceive = path.join(
      zylosDir,
      '.claude',
      'skills',
      'comm-bridge',
      'scripts',
      'c4-receive.js',
    );
    if (!fileIsRegular(liveReceive)) {
      throw new HoldError(`live receive entrypoint missing before upgrade: ${liveReceive}`);
    }

    const diskAvailableKb = availableDiskKb(zylosDir);
    if (diskAvailableKb < MIN_AVAILABLE_KB) {
      throw new HoldError(
        `available disk ${diskAvailableKb} KiB is below required ${MIN_AVAILABLE_KB} KiB`,
        'DISK_LOW',
      );
    }
    let beforePm2 = pm2Snapshot();
    const plannedPm2Repairs = planPm2PreflightRepairs(beforePm2, {
      zylosDir,
      stagedCoreDir,
    });
    const repairNames = new Set(plannedPm2Repairs.map((repair) => repair.name));
    const beforePm2Errors = validatePm2Snapshot(
      beforePm2.filter((proc) => !repairNames.has(proc.name)),
    );
    if (beforePm2Errors.length > 0) throw new HoldError(beforePm2Errors.join('; '));

    if (plannedPm2Repairs.length > 0 && args.execute) {
      const applied = applyPm2PreflightRepairs(plannedPm2Repairs);
      beforePm2 = pm2Snapshot();
      const repairVerificationErrors = validatePm2Snapshot(beforePm2);
      for (const repair of plannedPm2Repairs) {
        if (beforePm2.some((proc) => proc.name === repair.name)) {
          repairVerificationErrors.push(`${repair.name} still exists after rollback-orphan repair`);
        }
      }
      if (repairVerificationErrors.length > 0) {
        throw new HoldError(
          repairVerificationErrors.join('; '),
          'PREFLIGHT_REPAIR_FAILED',
        );
      }
      summary.preflightRepairs = { status: 'PASS', applied };
    } else {
      summary.preflightRepairs = {
        status: plannedPm2Repairs.length > 0 ? 'WOULD_APPLY' : 'NOT_REQUIRED',
        planned: plannedPm2Repairs,
      };
    }

    summary.preflight = {
      status: 'PASS',
      diskAvailableKb,
      coreSourceVersion: coreSource.package.version,
      feishuSourceVersion: feishuSource.package.version,
      persistedCoreRepo,
      persistedFeishuRepo: components.feishu.repo,
      hashes: {
        env: hashFile(envPath),
        components: hashFile(componentsPath),
        feishuConfig: hashFile(path.join(zylosDir, 'components', 'feishu', 'config.json')),
        c4Database: hashFile(path.join(zylosDir, 'comm-bridge', 'c4.db')),
      },
      pm2: beforePm2,
    };
    atomicWriteJson(summaryPath, summary);

    if (args.dryRun) {
      summary.status = 'PASS';
      summary.result = 'PRECHECK_ONLY';
      summary.finishedAt = new Date().toISOString();
      atomicWriteJson(summaryPath, summary);
      process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
      return 0;
    }

    requireSuccess(run('npm', [
      'install', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund',
    ], {
      cwd: stagedCoreDir,
      timeout: 300_000,
    }), 'staged Core dependency install failed');

    const npmRootResult = requireSuccess(run('npm', ['root', '-g']), 'global npm root lookup failed');
    const installedCoreDir = path.join(npmRootResult.stdout.trim(), 'zylos');
    const commands = buildUpgradeCommands({
      nodePath: process.execPath,
      stagedCoreDir,
      installedCoreDir,
      coreSha: args.coreSha,
      feishuSha: args.feishuSha,
    });
    const upgradeEnv = {
      ...process.env,
      ZYLOS_DIR: zylosDir,
      ZYLOS_SELF_UPGRADE_REPO: CORE_REPO,
    };

    const coreResult = run(commands.core.command, commands.core.args, {
      env: upgradeEnv,
      timeout: 1_200_000,
    });
    fs.writeFileSync(
      path.join(reportDir, 'core-upgrade.json'),
      `${JSON.stringify(commandEvidence(coreResult), null, 2)}\n`,
      { mode: 0o600 },
    );
    summary.coreResult = verifyUpgradeResult(coreResult, 'Core upgrade');
    summary.coreUpgraded = true;
    atomicWriteJson(summaryPath, summary);

    const installedCore = validateCoreSource(installedCoreDir, args.coreVersion);
    if (!installedCore.ok) {
      throw new HoldError(installedCore.error, 'POSTCHECK_FAILED');
    }

    const feishuResult = run(commands.feishu.command, commands.feishu.args, {
      env: upgradeEnv,
      timeout: 1_200_000,
    });
    fs.writeFileSync(
      path.join(reportDir, 'feishu-upgrade.json'),
      `${JSON.stringify(commandEvidence(feishuResult), null, 2)}\n`,
      { mode: 0o600 },
    );
    summary.feishuResult = verifyUpgradeResult(feishuResult, 'Feishu upgrade');
    summary.feishuUpgraded = true;
    atomicWriteJson(summaryPath, summary);

    const liveFeishuDir = path.join(zylosDir, '.claude', 'skills', 'feishu');
    const liveFeishu = validateFeishuSource(liveFeishuDir, args.feishuVersion);
    if (!liveFeishu.ok) throw new HoldError(liveFeishu.error, 'POSTCHECK_FAILED');

    const afterPm2 = pm2Snapshot();
    const afterPm2Errors = validatePm2Snapshot(afterPm2, { requireSupervisor: true });
    if (afterPm2Errors.length > 0) {
      throw new HoldError(afterPm2Errors.join('; '), 'POSTCHECK_FAILED');
    }
    const communication = runCommunicationCanary(installedCoreDir, zylosDir);

    summary.postcheck = {
      status: 'PASS',
      coreVersion: installedCore.package.version,
      feishuVersion: liveFeishu.package.version,
      communication,
      hashes: {
        env: hashFile(envPath),
        components: hashFile(componentsPath),
        feishuConfig: hashFile(path.join(zylosDir, 'components', 'feishu', 'config.json')),
        c4Database: hashFile(path.join(zylosDir, 'comm-bridge', 'c4.db')),
      },
      pm2: afterPm2,
    };
    summary.status = 'PASS';
    summary.result = 'UPGRADE_COMPLETE';
    summary.finishedAt = new Date().toISOString();
    atomicWriteJson(summaryPath, summary);
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    return 0;
  } catch (error) {
    summary.status = 'HOLD';
    summary.code = error.code || 'UNEXPECTED_ERROR';
    summary.error = error.message;
    summary.result = summary.coreUpgraded && !summary.feishuUpgraded
      ? 'CORE_UPGRADED_FEISHU_ROLLED_BACK_OR_UNCHANGED'
      : 'NO_VERIFIED_PAIR_UPGRADE';
    summary.finishedAt = new Date().toISOString();
    atomicWriteJson(summaryPath, summary);
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    return 1;
  } finally {
    fs.rmSync(scratchDir, { recursive: true, force: true });
  }
}

const isMain = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) process.exitCode = runForkPairUpgrade();
