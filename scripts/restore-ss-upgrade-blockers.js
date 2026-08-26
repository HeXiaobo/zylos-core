#!/usr/bin/env node

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const SS_BLOCKER_TARGETS = Object.freeze([
  Object.freeze({
    component: 'wechat',
    packageName: 'zylos-wechat',
    version: '0.3.2',
    repo: 'zylos-ai/zylos-wechat',
    sha: '67f5142b92e0d67563ac00e3c9e245350e58b280',
    service: 'zylos-wechat',
    entry: 'src/index.js',
  }),
  Object.freeze({
    component: 'wecom',
    packageName: 'zylos-wecom',
    version: '0.1.5',
    repo: 'zylos-ai/zylos-wecom',
    sha: '781a51f957ee38bdfa48939b4e3d1c52d70f0722',
    service: 'zylos-wecom',
    entry: 'src/index.js',
  }),
]);

class HoldError extends Error {
  constructor(message, code = 'RECOVERY_HOLD') {
    super(message);
    this.code = code;
  }
}

function fileIsRegular(filePath, fsApi = fs) {
  try {
    return fsApi.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function directoryExists(directoryPath, fsApi = fs) {
  try {
    return fsApi.statSync(directoryPath).isDirectory();
  } catch {
    return false;
  }
}

function readJson(filePath, fsApi = fs) {
  return JSON.parse(fsApi.readFileSync(filePath, 'utf8'));
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

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    timeout: options.timeout ?? 120_000,
    env: options.env ?? process.env,
    cwd: options.cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return {
    command,
    args,
    status: result.status,
    signal: result.signal,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    error: result.error?.message || null,
  };
}

function requireSuccess(result, message, code = 'RECOVERY_FAILED') {
  if (result.status === 0 && !result.error) return result;
  const detail = result.error || result.stderr.trim() || result.stdout.trim() || `exit ${result.status}`;
  throw new HoldError(`${message}: ${detail}`, code);
}

function parseArgs(argv) {
  const result = { execute: false };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--execute') result.execute = true;
    else if (token === '--dry-run') result.execute = false;
    else if (token === '--core-sha') result.coreSha = argv[++index];
    else if (token === '--agent') result.agent = argv[++index];
    else if (token === '--zylos-dir') result.zylosDir = argv[++index];
    else throw new HoldError(`unknown argument: ${token}`, 'INVALID_ARGS');
  }
  return result;
}

export function validatePinnedBlockerRecoveryTarget({ coreSha, agent } = {}) {
  if (!/^[0-9a-f]{40}$/i.test(coreSha || '')) {
    return { ok: false, error: 'core script SHA must be a full immutable 40-hex commit' };
  }
  if (agent !== 'ss') return { ok: false, error: 'agent identity must be exactly ss' };
  return { ok: true };
}

function criticalPaths(target) {
  return ['package.json', 'SKILL.md', target.entry, 'ecosystem.config.cjs'];
}

export function validateRequiredComponentSource(root, target, fsApi = fs) {
  let packageJson;
  try {
    packageJson = readJson(path.join(root, 'package.json'), fsApi);
  } catch (error) {
    return { ok: false, error: `invalid ${target.component} package.json: ${error.message}` };
  }
  if (packageJson.name !== target.packageName || packageJson.version !== target.version) {
    return {
      ok: false,
      error: `expected ${target.packageName}@${target.version}, found ${packageJson.name}@${packageJson.version}`,
    };
  }
  for (const relativePath of criticalPaths(target).slice(1)) {
    if (!fileIsRegular(path.join(root, relativePath), fsApi)) {
      return { ok: false, error: `${target.component} source is missing ${relativePath}` };
    }
  }
  return { ok: true, package: packageJson };
}

export function validateRequiredComponentRegistry(entry, target, zylosDir) {
  if (!entry) return { ok: false, error: `${target.component} is not registered` };
  if (entry.repo !== target.repo || entry.version !== target.version) {
    return {
      ok: false,
      error: `${target.component} must remain ${target.repo}@${target.version}`,
    };
  }
  const skillDir = path.join(zylosDir, '.claude', 'skills', target.component);
  const dataDir = path.join(zylosDir, 'components', target.component);
  if (path.resolve(entry.skillDir || skillDir) !== skillDir) {
    return { ok: false, error: `unexpected ${target.component} skillDir ${entry.skillDir}` };
  }
  if (path.resolve(entry.dataDir || dataDir) !== dataDir) {
    return { ok: false, error: `unexpected ${target.component} dataDir ${entry.dataDir}` };
  }
  return { ok: true, skillDir, dataDir };
}

export function validateRequiredComponentPm2(proc, target, expectedExecPath) {
  if (!proc) return { ok: false, error: `${target.service} is absent from PM2` };
  if (proc.status !== 'online' || !Number.isInteger(proc.pid) || proc.pid <= 0) {
    return { ok: false, error: `${target.service} is not genuinely online` };
  }
  if (path.resolve(proc.execPath || '') !== path.resolve(expectedExecPath)) {
    return { ok: false, error: `${target.service} executable mismatch: ${proc.execPath || '(unset)'}` };
  }
  if (!fileIsRegular(expectedExecPath)) {
    return { ok: false, error: `${target.service} executable does not exist` };
  }
  return { ok: true };
}

function criticalHashes(root, target) {
  return Object.fromEntries(criticalPaths(target).map((relativePath) => [
    relativePath,
    hashFile(path.join(root, relativePath)),
  ]));
}

function pm2Process(name) {
  const result = requireSuccess(run('pm2', ['jlist']), 'PM2 inspection failed');
  let processes;
  try {
    processes = JSON.parse(result.stdout);
  } catch (error) {
    throw new HoldError(`invalid PM2 JSON: ${error.message}`);
  }
  const proc = processes.find((candidate) => candidate.name === name);
  if (!proc) return null;
  return {
    name: proc.name,
    status: proc.pm2_env?.status ?? 'unknown',
    pid: Number.isInteger(proc.pid) ? proc.pid : null,
    execPath: proc.pm2_env?.pm_exec_path ?? null,
    restartTime: proc.pm2_env?.restart_time ?? null,
    unstableRestarts: proc.pm2_env?.unstable_restarts ?? null,
  };
}

function validateHxaContinuity(zylosDir) {
  const expectedExecPath = path.join(zylosDir, '.claude', 'skills', 'hxa-connect', 'src', 'bot.js');
  const proc = pm2Process('zylos-hxa-connect');
  if (
    !proc
    || proc.status !== 'online'
    || !Number.isInteger(proc.pid)
    || proc.pid <= 0
    || path.resolve(proc.execPath || '') !== expectedExecPath
    || !fileIsRegular(expectedExecPath)
  ) {
    throw new HoldError('HXA continuity guard is not genuinely online', 'HXA_GUARD_FAILED');
  }
  return proc;
}

function stageArchive(target, destination) {
  fs.mkdirSync(destination, { recursive: true });
  const archivePath = path.join(path.dirname(destination), `${target.component}.tar.gz`);
  requireSuccess(run('curl', [
    '-fsSL', '--retry', '2', '--retry-all-errors',
    `https://github.com/${target.repo}/archive/${target.sha}.tar.gz`,
    '-o', archivePath,
  ], { timeout: 120_000 }), `${target.component} archive download failed`);
  requireSuccess(run('tar', [
    'xzf', archivePath, '-C', destination, '--strip-components=1',
  ], { timeout: 120_000 }), `${target.component} archive extraction failed`);
}

function availableDiskKb(targetPath) {
  const result = requireSuccess(run('df', ['-Pk', targetPath]), 'disk inspection failed');
  const fields = result.stdout.trim().split(/\r?\n/).at(-1)?.trim().split(/\s+/);
  const value = Number(fields?.[3]);
  if (!Number.isFinite(value)) throw new HoldError('could not parse available disk space');
  return value;
}

function verifySourceMarker(skillDir, target) {
  let marker;
  try {
    marker = readJson(path.join(skillDir, '.zylos-source.json'));
  } catch (error) {
    throw new HoldError(`${target.component} source marker is invalid: ${error.message}`);
  }
  if (marker.repo !== target.repo || marker.sha !== target.sha || marker.version !== target.version) {
    throw new HoldError(`${target.component} source marker does not match the pinned target`);
  }
  return marker;
}

export function runBlockerRecovery(argv = process.argv.slice(2)) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ status: 'HOLD', code: error.code, error: error.message })}\n`);
    return 1;
  }
  const pinned = validatePinnedBlockerRecoveryTarget(args);
  if (!pinned.ok) {
    process.stdout.write(`${JSON.stringify({ status: 'HOLD', code: 'INVALID_ARGS', error: pinned.error })}\n`);
    return 1;
  }

  const zylosDir = path.resolve(args.zylosDir || process.env.ZYLOS_DIR || path.join(os.homedir(), 'zylos'));
  const reportDir = path.join(
    zylosDir,
    '.zylos',
    'upgrade-reports',
    `blocker-recovery-${new Date().toISOString().replace(/[:.]/g, '-')}`,
  );
  fs.mkdirSync(reportDir, { recursive: true, mode: 0o700 });
  const summaryPath = path.join(reportDir, 'summary.json');
  const summary = {
    status: 'RUNNING',
    result: null,
    execute: args.execute,
    agent: args.agent,
    scriptCoreSha: args.coreSha,
    targets: SS_BLOCKER_TARGETS,
    reportDir,
    startedAt: new Date().toISOString(),
  };
  atomicWriteJson(summaryPath, summary);

  const lockDir = path.join(zylosDir, '.zylos', 'locks', 'restore-ss-upgrade-blockers.lock');
  const scratchRoot = path.join(zylosDir, '.zylos', 'tmp', `blocker-recovery-${process.pid}`);
  let lockHeld = false;
  try {
    fs.mkdirSync(path.dirname(lockDir), { recursive: true });
    fs.mkdirSync(lockDir);
    lockHeld = true;
    fs.mkdirSync(scratchRoot, { recursive: true, mode: 0o700 });

    const hxaBefore = validateHxaContinuity(zylosDir);
    const diskAvailableKb = availableDiskKb(zylosDir);
    if (diskAvailableKb < 2_097_152) {
      throw new HoldError(`less than 2 GiB disk available: ${diskAvailableKb} KiB`, 'PREFLIGHT_FAILED');
    }
    const componentsPath = path.join(zylosDir, '.zylos', 'components.json');
    const components = readJson(componentsPath);
    const prepared = [];
    for (const target of SS_BLOCKER_TARGETS) {
      const registry = validateRequiredComponentRegistry(components[target.component], target, zylosDir);
      if (!registry.ok) throw new HoldError(registry.error, 'PREFLIGHT_FAILED');
      if (!directoryExists(registry.dataDir)) {
        throw new HoldError(`${target.component} data directory is missing`, 'PREFLIGHT_FAILED');
      }
      const existing = fs.existsSync(registry.skillDir);
      if (existing) {
        const installed = validateRequiredComponentSource(registry.skillDir, target);
        if (!installed.ok) throw new HoldError(installed.error, 'PREFLIGHT_FAILED');
        verifySourceMarker(registry.skillDir, target);
      }
      const stagedDir = path.join(scratchRoot, target.component, 'staged');
      stageArchive(target, stagedDir);
      const staged = validateRequiredComponentSource(stagedDir, target);
      if (!staged.ok) throw new HoldError(staged.error, 'SOURCE_INVALID');
      if (existing && JSON.stringify(criticalHashes(stagedDir, target)) !== JSON.stringify(criticalHashes(registry.skillDir, target))) {
        throw new HoldError(`${target.component} critical files differ from the pinned archive`, 'PREFLIGHT_FAILED');
      }
      prepared.push({
        target,
        registry,
        existing,
        stagedDir,
        configPath: path.join(registry.dataDir, 'config.json'),
      });
    }

    summary.preflight = {
      status: 'PASS',
      diskAvailableKb,
      hxa: hxaBefore,
      componentsHash: hashFile(componentsPath),
      components: prepared.map(({ target, registry, existing, configPath }) => ({
        name: target.component,
        repo: components[target.component].repo,
        version: components[target.component].version,
        skillDir: registry.skillDir,
        skillDirState: existing ? 'PRESENT_PINNED' : 'MISSING',
        dataDirState: 'PRESENT',
        configHash: hashFile(configPath),
        pm2: pm2Process(target.service),
      })),
    };
    atomicWriteJson(summaryPath, summary);

    if (!args.execute) {
      summary.status = 'PASS';
      summary.result = 'PRECHECK_ONLY';
      summary.finishedAt = new Date().toISOString();
      atomicWriteJson(summaryPath, summary);
      process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
      return 0;
    }

    for (const item of prepared) {
      const installDir = item.existing ? item.registry.skillDir : item.stagedDir;
      requireSuccess(run('npm', [
        'install', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund',
      ], { cwd: installDir, timeout: 300_000 }), `${item.target.component} dependency install failed`);
      if (!item.existing) {
        atomicWriteJson(path.join(item.stagedDir, '.zylos-source.json'), {
          repo: item.target.repo,
          sha: item.target.sha,
          version: item.target.version,
          installedAt: new Date().toISOString(),
        });
        fs.mkdirSync(path.dirname(item.registry.skillDir), { recursive: true });
        fs.renameSync(item.stagedDir, item.registry.skillDir);
      }
    }

    const updatedComponents = readJson(componentsPath);
    for (const { target } of prepared) {
      updatedComponents[target.component] = {
        ...updatedComponents[target.component],
        repo: target.repo,
        version: target.version,
        upgradedAt: new Date().toISOString(),
      };
    }
    atomicWriteJson(componentsPath, updatedComponents);
    const persisted = readJson(componentsPath);
    for (const { target } of prepared) {
      if (persisted[target.component]?.repo !== target.repo || persisted[target.component]?.version !== target.version) {
        throw new HoldError(`${target.component} routing did not persist`, 'ROUTING_NOT_PERSISTED');
      }
    }

    for (const { target, registry } of prepared) {
      requireSuccess(run('pm2', [
        'startOrRestart', path.join(registry.skillDir, 'ecosystem.config.cjs'),
        '--only', target.service, '--update-env',
      ], { env: { ...process.env, ZYLOS_DIR: zylosDir } }), `${target.service} PM2 start failed`);
    }
    requireSuccess(run('pm2', ['save']), 'PM2 save failed');

    const postComponents = [];
    for (const item of prepared) {
      const expectedExecPath = path.join(item.registry.skillDir, item.target.entry);
      let proc;
      let validation;
      for (let attempt = 0; attempt < 15; attempt += 1) {
        proc = pm2Process(item.target.service);
        validation = validateRequiredComponentPm2(proc, item.target, expectedExecPath);
        if (validation.ok) break;
        run('sleep', ['2'], { timeout: 5_000 });
      }
      if (!validation?.ok) throw new HoldError(validation?.error || `${item.target.service} verification failed`);
      const configHash = hashFile(item.configPath);
      const before = summary.preflight.components.find((candidate) => candidate.name === item.target.component);
      if (before.configHash !== configHash) {
        throw new HoldError(`${item.target.component} config hash changed during code-only recovery`);
      }
      postComponents.push({
        name: item.target.component,
        version: readJson(path.join(item.registry.skillDir, 'package.json')).version,
        source: readJson(path.join(item.registry.skillDir, '.zylos-source.json')),
        registryRepo: readJson(componentsPath)[item.target.component]?.repo,
        configHashPreserved: true,
        pm2: proc,
      });
    }

    summary.postcheck = {
      status: 'PASS',
      hxa: validateHxaContinuity(zylosDir),
      componentsHash: hashFile(componentsPath),
      components: postComponents,
    };
    summary.status = 'PASS';
    summary.result = 'SS_UPGRADE_BLOCKERS_RESTORED';
    summary.finishedAt = new Date().toISOString();
    atomicWriteJson(summaryPath, summary);
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    return 0;
  } catch (error) {
    summary.status = 'HOLD';
    summary.code = error.code || 'RECOVERY_FAILED';
    summary.error = error.message;
    summary.result = 'BLOCKER_RECOVERY_NOT_VERIFIED';
    summary.finishedAt = new Date().toISOString();
    atomicWriteJson(summaryPath, summary);
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    return 1;
  } finally {
    fs.rmSync(scratchRoot, { recursive: true, force: true });
    if (lockHeld) fs.rmSync(lockDir, { recursive: true, force: true });
  }
}

const isMain = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) process.exitCode = runBlockerRecovery();
