#!/usr/bin/env node

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HXA_TARGET = Object.freeze({
  component: 'hxa-connect',
  packageName: 'zylos-hxa-connect',
  version: '1.7.3',
  repo: 'HeXiaobo/zylos-hxa-connect',
  acceptedRepos: ['HeXiaobo/zylos-hxa-connect', 'coco-xyz/zylos-hxa-connect'],
  sha: '160dbaeac86f503b2d1889343354c5aee3b57785',
  service: 'zylos-hxa-connect',
  entry: 'src/bot.js',
});
const HXA_CRITICAL_PATHS = Object.freeze([
  'package.json',
  'SKILL.md',
  HXA_TARGET.entry,
  'scripts/cli.js',
  'ecosystem.config.cjs',
]);

export function pathsReferToSameFile(leftPath, rightPath, fsApi = fs) {
  if (!leftPath || !rightPath) return false;
  try {
    const left = fsApi.statSync(leftPath);
    const right = fsApi.statSync(rightPath);
    return left.dev === right.dev && left.ino === right.ino;
  } catch {
    return false;
  }
}

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

function hashFile(filePath) {
  if (!fileIsRegular(filePath)) return null;
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function atomicWriteJson(filePath, value) {
  const tempPath = `${filePath}.tmp-${process.pid}`;
  fs.writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tempPath, filePath);
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

export function validatePinnedHxaRecoveryTarget({ coreSha, agent } = {}) {
  if (!/^[0-9a-f]{40}$/i.test(coreSha || '')) {
    return { ok: false, error: 'core script SHA must be a full immutable 40-hex commit' };
  }
  if (agent !== 'ss') return { ok: false, error: 'agent identity must be exactly ss' };
  return { ok: true };
}

export function validateHxaSource(root, fsApi = fs) {
  let packageJson;
  try {
    packageJson = readJson(path.join(root, 'package.json'), fsApi);
  } catch (error) {
    return { ok: false, error: `invalid HXA package.json: ${error.message}` };
  }
  if (packageJson.name !== HXA_TARGET.packageName || packageJson.version !== HXA_TARGET.version) {
    return {
      ok: false,
      error: `expected ${HXA_TARGET.packageName}@${HXA_TARGET.version}, found ${packageJson.name}@${packageJson.version}`,
    };
  }
  for (const relativePath of HXA_CRITICAL_PATHS.slice(1)) {
    if (!fileIsRegular(path.join(root, relativePath), fsApi)) {
      return { ok: false, error: `HXA source is missing ${relativePath}` };
    }
  }
  return { ok: true, package: packageJson };
}

function criticalHxaHashes(root) {
  return Object.fromEntries(HXA_CRITICAL_PATHS.map((relativePath) => [
    relativePath,
    hashFile(path.join(root, relativePath)),
  ]));
}

export function validateHxaRegistryEntry(entry, zylosDir) {
  if (!entry) return { ok: false, error: 'hxa-connect is not registered' };
  if (entry.version !== HXA_TARGET.version) {
    return { ok: false, error: `registered HXA version must be ${HXA_TARGET.version}, found ${entry.version}` };
  }
  if (!HXA_TARGET.acceptedRepos.includes(entry.repo)) {
    return { ok: false, error: `unexpected HXA repo ${entry.repo}` };
  }
  const expectedSkillDir = path.join(zylosDir, '.claude', 'skills', HXA_TARGET.component);
  const expectedDataDir = path.join(zylosDir, 'components', HXA_TARGET.component);
  if (path.resolve(entry.skillDir || expectedSkillDir) !== expectedSkillDir) {
    return { ok: false, error: `unexpected HXA skillDir ${entry.skillDir}` };
  }
  if (path.resolve(entry.dataDir || expectedDataDir) !== expectedDataDir) {
    return { ok: false, error: `unexpected HXA dataDir ${entry.dataDir}` };
  }
  return { ok: true, skillDir: expectedSkillDir, dataDir: expectedDataDir };
}

export function validateHxaPm2Process(proc, expectedExecPath) {
  if (!proc) return { ok: false, error: `${HXA_TARGET.service} is absent from PM2` };
  if (proc.status !== 'online' || !Number.isInteger(proc.pid) || proc.pid <= 0) {
    return { ok: false, error: `${HXA_TARGET.service} is not genuinely online` };
  }
  if (path.resolve(proc.execPath || '') !== path.resolve(expectedExecPath)) {
    return {
      ok: false,
      error: `${HXA_TARGET.service} executable mismatch: ${proc.execPath || '(unset)'}`,
    };
  }
  if (!fileIsRegular(expectedExecPath)) {
    return { ok: false, error: `${HXA_TARGET.service} executable does not exist` };
  }
  return { ok: true };
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

function stageArchive(destination) {
  fs.mkdirSync(destination, { recursive: true });
  const archivePath = path.join(path.dirname(destination), 'hxa-connect.tar.gz');
  requireSuccess(run('curl', [
    '-fsSL', '--retry', '2', '--retry-all-errors',
    `https://github.com/${HXA_TARGET.repo}/archive/${HXA_TARGET.sha}.tar.gz`,
    '-o', archivePath,
  ], { timeout: 120_000 }), 'HXA archive download failed');
  requireSuccess(run('tar', [
    'xzf', archivePath, '-C', destination, '--strip-components=1',
  ], { timeout: 120_000 }), 'HXA archive extraction failed');
}

function availableDiskKb(targetPath) {
  const result = requireSuccess(run('df', ['-Pk', targetPath]), 'disk inspection failed');
  const fields = result.stdout.trim().split(/\r?\n/).at(-1)?.trim().split(/\s+/);
  const value = Number(fields?.[3]);
  if (!Number.isFinite(value)) throw new HoldError('could not parse available disk space');
  return value;
}

export function buildHxaProbeCommands(cliPath) {
  return [
    { name: 'profile', args: [cliPath, 'profile'] },
    { name: 'peers', args: [cliPath, 'peers'] },
  ];
}

function checkNetwork(skillDir) {
  const cli = path.join(skillDir, 'scripts', 'cli.js');
  const [profileCommand, peersCommand] = buildHxaProbeCommands(cli);
  const profile = requireSuccess(
    run(process.execPath, profileCommand.args, { timeout: 30_000 }),
    'HXA profile probe failed',
    'CHANNEL_UNVERIFIED',
  );
  const peers = requireSuccess(
    run(process.execPath, peersCommand.args, { timeout: 30_000 }),
    'HXA peers probe failed',
    'CHANNEL_UNVERIFIED',
  );
  return {
    profileExitCode: profile.status,
    peersExitCode: peers.status,
    profileReturnedJson: /^\s*[\[{]/.test(profile.stdout),
    peersReturnedJson: /^\s*[\[{]/.test(peers.stdout),
  };
}

export function runHxaRecovery(argv = process.argv.slice(2)) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ status: 'HOLD', code: error.code, error: error.message })}\n`);
    return 1;
  }
  const target = validatePinnedHxaRecoveryTarget(args);
  if (!target.ok) {
    process.stdout.write(`${JSON.stringify({ status: 'HOLD', code: 'INVALID_ARGS', error: target.error })}\n`);
    return 1;
  }

  const zylosDir = path.resolve(args.zylosDir || process.env.ZYLOS_DIR || path.join(os.homedir(), 'zylos'));
  const reportDir = path.join(
    zylosDir,
    '.zylos',
    'upgrade-reports',
    `hxa-recovery-${new Date().toISOString().replace(/[:.]/g, '-')}`,
  );
  fs.mkdirSync(reportDir, { recursive: true, mode: 0o700 });
  const summaryPath = path.join(reportDir, 'summary.json');
  const summary = {
    status: 'RUNNING',
    result: null,
    execute: args.execute,
    agent: args.agent,
    scriptCoreSha: args.coreSha,
    target: HXA_TARGET,
    reportDir,
    startedAt: new Date().toISOString(),
  };
  atomicWriteJson(summaryPath, summary);

  const lockDir = path.join(zylosDir, '.zylos', 'locks', 'restore-hxa-connect.lock');
  const scratchRoot = path.join(zylosDir, '.zylos', 'tmp', `hxa-recovery-${process.pid}`);
  let lockHeld = false;
  try {
    fs.mkdirSync(path.dirname(lockDir), { recursive: true });
    fs.mkdirSync(lockDir);
    lockHeld = true;
    fs.mkdirSync(scratchRoot, { recursive: true, mode: 0o700 });

    const componentsPath = path.join(zylosDir, '.zylos', 'components.json');
    const components = readJson(componentsPath);
    const registry = validateHxaRegistryEntry(components[HXA_TARGET.component], zylosDir);
    if (!registry.ok) throw new HoldError(registry.error, 'PREFLIGHT_FAILED');
    if (!directoryExists(registry.dataDir)) {
      throw new HoldError(`HXA data directory is missing: ${registry.dataDir}`, 'PREFLIGHT_FAILED');
    }
    const skillDirExists = fs.existsSync(registry.skillDir);
    let existingSourceMarker = null;
    if (skillDirExists) {
      const installedSource = validateHxaSource(registry.skillDir);
      if (!installedSource.ok) throw new HoldError(installedSource.error, 'PREFLIGHT_FAILED');
      try {
        existingSourceMarker = readJson(path.join(registry.skillDir, '.zylos-source.json'));
      } catch (error) {
        throw new HoldError(`existing HXA source marker is invalid: ${error.message}`, 'PREFLIGHT_FAILED');
      }
      if (
        existingSourceMarker.repo !== HXA_TARGET.repo
        || existingSourceMarker.sha !== HXA_TARGET.sha
        || existingSourceMarker.version !== HXA_TARGET.version
      ) {
        throw new HoldError('existing HXA source marker does not match the pinned target', 'PREFLIGHT_FAILED');
      }
    }
    const diskAvailableKb = availableDiskKb(zylosDir);
    if (diskAvailableKb < 1_048_576) {
      throw new HoldError(`less than 1 GiB disk available: ${diskAvailableKb} KiB`, 'PREFLIGHT_FAILED');
    }

    const stagedDir = path.join(scratchRoot, 'staged');
    stageArchive(stagedDir);
    const source = validateHxaSource(stagedDir);
    if (!source.ok) throw new HoldError(source.error, 'SOURCE_INVALID');
    if (skillDirExists) {
      const stagedHashes = criticalHxaHashes(stagedDir);
      const installedHashes = criticalHxaHashes(registry.skillDir);
      if (JSON.stringify(stagedHashes) !== JSON.stringify(installedHashes)) {
        throw new HoldError('existing HXA critical files differ from the pinned archive', 'PREFLIGHT_FAILED');
      }
    }

    const configPath = path.join(registry.dataDir, 'config.json');
    const beforePm2 = pm2Process(HXA_TARGET.service);
    summary.preflight = {
      status: 'PASS',
      diskAvailableKb,
      registryRepo: components[HXA_TARGET.component].repo,
      registryVersion: components[HXA_TARGET.component].version,
      skillDirState: skillDirExists ? 'PRESENT_PINNED' : 'MISSING',
      dataDirState: 'PRESENT',
      hashes: {
        components: hashFile(componentsPath),
        config: hashFile(configPath),
      },
      pm2: beforePm2,
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

    if (!skillDirExists) {
      requireSuccess(run('npm', [
        'install', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund',
      ], { cwd: stagedDir, timeout: 300_000 }), 'HXA dependency install failed');
      atomicWriteJson(path.join(stagedDir, '.zylos-source.json'), {
        repo: HXA_TARGET.repo,
        sha: HXA_TARGET.sha,
        version: HXA_TARGET.version,
        installedAt: new Date().toISOString(),
      });
      fs.mkdirSync(path.dirname(registry.skillDir), { recursive: true });
      fs.renameSync(stagedDir, registry.skillDir);
    } else {
      requireSuccess(run('npm', [
        'install', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund',
      ], { cwd: registry.skillDir, timeout: 300_000 }), 'existing HXA dependency verification failed');
    }

    const updatedComponents = readJson(componentsPath);
    updatedComponents[HXA_TARGET.component] = {
      ...updatedComponents[HXA_TARGET.component],
      repo: HXA_TARGET.repo,
      version: HXA_TARGET.version,
      upgradedAt: new Date().toISOString(),
    };
    atomicWriteJson(componentsPath, updatedComponents);
    const persistedComponent = readJson(componentsPath)[HXA_TARGET.component];
    if (
      persistedComponent?.repo !== HXA_TARGET.repo
      || persistedComponent?.version !== HXA_TARGET.version
    ) {
      throw new HoldError('HXA fork routing did not persist', 'ROUTING_NOT_PERSISTED');
    }

    const ecosystemPath = path.join(registry.skillDir, 'ecosystem.config.cjs');
    requireSuccess(run('pm2', [
      'startOrRestart', ecosystemPath, '--only', HXA_TARGET.service, '--update-env',
    ], { env: { ...process.env, ZYLOS_DIR: zylosDir } }), 'HXA PM2 start failed');
    requireSuccess(run('pm2', ['save']), 'PM2 save failed');

    const expectedExecPath = path.join(registry.skillDir, HXA_TARGET.entry);
    let liveProcess;
    let liveResult;
    for (let attempt = 0; attempt < 15; attempt += 1) {
      liveProcess = pm2Process(HXA_TARGET.service);
      liveResult = validateHxaPm2Process(liveProcess, expectedExecPath);
      if (liveResult.ok) break;
      run('sleep', ['2'], { timeout: 5_000 });
    }
    if (!liveResult?.ok) throw new HoldError(liveResult?.error || 'HXA PM2 verification failed');
    const network = checkNetwork(registry.skillDir);

    summary.postcheck = {
      status: 'PASS',
      version: readJson(path.join(registry.skillDir, 'package.json')).version,
      source: readJson(path.join(registry.skillDir, '.zylos-source.json')),
      registryRepo: readJson(componentsPath)[HXA_TARGET.component]?.repo,
      hashes: {
        components: hashFile(componentsPath),
        config: hashFile(configPath),
      },
      configHashPreserved: summary.preflight.hashes.config === hashFile(configPath),
      pm2: liveProcess,
      network,
    };
    if (!summary.postcheck.configHashPreserved) {
      throw new HoldError('HXA config hash changed during code-only recovery');
    }
    summary.status = 'PASS';
    summary.result = 'HXA_CODE_AND_CHANNEL_RESTORED';
    summary.finishedAt = new Date().toISOString();
    atomicWriteJson(summaryPath, summary);
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    return 0;
  } catch (error) {
    summary.status = 'HOLD';
    summary.code = error.code || 'RECOVERY_FAILED';
    summary.error = error.message;
    summary.result = fs.existsSync(path.join(zylosDir, '.claude', 'skills', HXA_TARGET.component))
      ? 'CODE_PRESENT_CHANNEL_NOT_VERIFIED'
      : 'NO_COMPONENT_MUTATION_VERIFIED';
    summary.finishedAt = new Date().toISOString();
    atomicWriteJson(summaryPath, summary);
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    return 1;
  } finally {
    fs.rmSync(scratchRoot, { recursive: true, force: true });
    if (lockHeld) fs.rmSync(lockDir, { recursive: true, force: true });
  }
}

const isMain = pathsReferToSameFile(process.argv[1], fileURLToPath(import.meta.url));
if (isMain) process.exitCode = runHxaRecovery();
