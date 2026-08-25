#!/usr/bin/env node
/**
 * Resolve optional Agent/Deployment Profiles for Memory Sync.
 *
 * Profiles are operator configuration, not agent identity or memory. A missing
 * selection is the runtime-neutral default and deliberately loads no bundled
 * governance. Hosting platforms may select profiles with environment variables
 * without rewriting the Core package.
 */

import fs from 'node:fs';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_PROFILE_ROOT = path.resolve(SCRIPT_DIR, '..', 'profiles');
const PROFILE_ID = /^[a-z0-9](?:[a-z0-9._-]{0,62})$/;
const DISABLED_PROFILE_IDS = new Set(['default', 'none']);

function readConfig(zylosDir) {
  const configPath = path.join(zylosDir, '.zylos', 'config.json');
  let content;
  try {
    content = fs.readFileSync(configPath, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') {
      try {
        fs.lstatSync(configPath);
      } catch (lstatError) {
        if (lstatError?.code === 'ENOENT') return {};
        throw new Error(`cannot read Zylos profile configuration: ${lstatError.message}`);
      }
    }
    throw new Error(`cannot read Zylos profile configuration: ${error.message}`);
  }
  let config;
  try {
    config = JSON.parse(content);
  } catch (error) {
    throw new Error(`cannot parse Zylos profile configuration: ${error.message}`);
  }
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new Error('cannot parse Zylos profile configuration: root must be an object');
  }
  return config;
}

function readConfiguredProfiles(zylosDir) {
  const config = readConfig(zylosDir);
  if (config.profiles === undefined) return { config, profiles: {} };
  if (!config.profiles || typeof config.profiles !== 'object' || Array.isArray(config.profiles)) {
    throw new Error('cannot parse Zylos profile configuration: profiles must be an object');
  }
  return { config, profiles: config.profiles };
}

function optionalProfileValue(value, source, kind) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') {
    throw new Error(`invalid ${kind} Profile selection in ${source}: expected a string`);
  }
  return value.trim() || null;
}

function selectedProfileValue(env, envName, configValue, kind) {
  if (Object.hasOwn(env, envName)) {
    return optionalProfileValue(env[envName], envName, kind);
  }
  return optionalProfileValue(configValue, 'config.json', kind);
}

function normalizeIdentifier(value, kind, { allowDisabled = false } = {}) {
  if (value === null) return null;
  const normalized = value.toLowerCase();
  if (allowDisabled && DISABLED_PROFILE_IDS.has(normalized)) return null;
  if (!PROFILE_ID.test(normalized)) {
    throw new Error(`invalid ${kind} Profile identifier "${value}"`);
  }
  return normalized;
}

function resolveProfileSelection(configuredProfiles, env) {
  return {
    agent: normalizeIdentifier(
      selectedProfileValue(
        env,
        'ZYLOS_AGENT_PROFILE',
        configuredProfiles.agent,
        'Agent',
      ),
      'Agent',
      { allowDisabled: true },
    ),
    deployment: normalizeIdentifier(
      selectedProfileValue(
        env,
        'ZYLOS_DEPLOYMENT_PROFILE',
        configuredProfiles.deployment,
        'Deployment',
      ),
      'Deployment',
      { allowDisabled: true },
    ),
  };
}

function atomicWriteJson(configPath, config) {
  const configDir = path.dirname(configPath);
  fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
  try {
    if (fs.lstatSync(configPath).isSymbolicLink()) {
      throw new Error('refusing to overwrite symbolic-link Zylos profile configuration');
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }

  const temporaryPath = path.join(
    configDir,
    `.config.json.${process.pid}.${Date.now()}.tmp`,
  );
  let fd;
  try {
    fd = fs.openSync(temporaryPath, 'wx', 0o600);
    fs.writeFileSync(fd, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(temporaryPath, configPath);
    const dirFd = fs.openSync(configDir, 'r');
    try {
      fs.fsyncSync(dirFd);
    } finally {
      fs.closeSync(dirFd);
    }
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    try {
      fs.unlinkSync(temporaryPath);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
}

/**
 * Read profile identity without activating any behavior.
 * Environment selection takes precedence so managed COCO deployments can use
 * an immutable image with per-instance configuration.
 */
export function readProfileSelection({
  zylosDir = process.env.ZYLOS_DIR || path.join(os.homedir(), 'zylos'),
  env = process.env,
} = {}) {
  const { profiles: configuredProfiles } = readConfiguredProfiles(zylosDir);
  return resolveProfileSelection(configuredProfiles, env);
}

/**
 * Atomically update only Core's nested profile keys while preserving every
 * unrelated config.json field. This is the supported pre-upgrade opt-in seam
 * for branded deployments such as the existing 玥然/Mylos installation.
 */
export function writeProfileSelection({
  zylosDir = process.env.ZYLOS_DIR || path.join(os.homedir(), 'zylos'),
  agent,
  deployment,
} = {}) {
  const config = readConfig(zylosDir);
  const previousProfiles = config.profiles === undefined ? {} : config.profiles;
  if (!previousProfiles || typeof previousProfiles !== 'object' || Array.isArray(previousProfiles)) {
    throw new Error('cannot update Zylos profile configuration: profiles must be an object');
  }

  const profiles = { ...previousProfiles };
  if (agent !== undefined) {
    profiles.agent = normalizeIdentifier(agent, 'Agent', { allowDisabled: false });
  }
  if (deployment !== undefined) {
    profiles.deployment = normalizeIdentifier(deployment, 'Deployment', { allowDisabled: false });
  }
  atomicWriteJson(path.join(zylosDir, '.zylos', 'config.json'), {
    ...config,
    profiles,
  });
  return readProfileSelection({ zylosDir, env: {} });
}

/**
 * Load the Memory Sync addendum selected by the Deployment Profile.
 * Agent Profile is metadata only; it cannot accidentally activate deployment
 * governance. Unknown profiles fail closed instead of silently becoming the
 * generic default.
 */
export function loadMemoryGovernanceProfile({
  zylosDir = process.env.ZYLOS_DIR || path.join(os.homedir(), 'zylos'),
  env = process.env,
  profileRoot = DEFAULT_PROFILE_ROOT,
} = {}) {
  const selection = readProfileSelection({ zylosDir, env });
  if (!selection.deployment) return null;

  const profilePath = path.join(
    profileRoot,
    selection.deployment,
    'memory-governance.md',
  );
  let rawContent;
  try {
    const profileRootRealPath = fs.realpathSync(profileRoot);
    const profileRealPath = fs.realpathSync(profilePath);
    const relativePath = path.relative(profileRootRealPath, profileRealPath);
    if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
      throw new Error('profile escapes bundled profile root');
    }
    if (fs.lstatSync(profilePath).isSymbolicLink()) {
      throw new Error('profile file cannot be a symbolic link');
    }
    rawContent = fs.readFileSync(profilePath, 'utf8');
  } catch {
    throw new Error(`unknown Deployment Profile "${selection.deployment}"`);
  }
  const content = rawContent.trim();
  if (!content) {
    throw new Error(`Deployment Profile "${selection.deployment}" has empty memory governance`);
  }

  return {
    id: selection.deployment,
    agentProfile: selection.agent,
    content,
    source: profilePath,
    sha256: crypto.createHash('sha256').update(rawContent).digest('hex'),
  };
}

/**
 * Resolve and cryptographically bind the effective Deployment Profile before
 * a Memory Sync request is emitted. The compact prompt stays under the session
 * shard budget while forcing the maintenance worker to consume the exact file
 * Core already selected and validated.
 */
export function createMemorySyncProfileDirective(options = {}) {
  const profile = loadMemoryGovernanceProfile(options);
  if (!profile) {
    return 'Core mechanically resolved the runtime-neutral default Deployment Profile. Apply only the base zylos-memory rules; no deployment-specific governance is active.';
  }
  const agent = profile.agentProfile
    ? ` for Agent Profile "${profile.agentProfile}"`
    : '';
  return `Core mechanically resolved Deployment Profile "${profile.id}"${agent} at ${profile.source} (sha256 ${profile.sha256}). The Memory Sync subagent must read that exact file and verify its sha256 before applying it; do not infer or replace the profile from agent, channel, or platform identity.`;
}

function parseSetArgs(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    const value = args[index + 1];
    if (!['--agent', '--deployment'].includes(flag) || value === undefined) {
      throw new Error(`invalid set argument "${flag}"`);
    }
    index += 1;
    if (flag === '--agent') options.agent = value;
    if (flag === '--deployment') options.deployment = value;
  }
  if (options.agent === undefined && options.deployment === undefined) {
    throw new Error('set requires --agent and/or --deployment');
  }
  return options;
}

function runCli(args = process.argv.slice(2)) {
  if (args[0] === 'set') {
    const selection = writeProfileSelection(parseSetArgs(args.slice(1)));
    process.stdout.write(`${JSON.stringify(selection)}\n`);
    return;
  }
  if (args.length > 0) throw new Error(`unknown command "${args[0]}"`);
  const profile = loadMemoryGovernanceProfile();
  if (profile) process.stdout.write(`${profile.content}\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    runCli();
  } catch (error) {
    console.error(`deployment-profile: ${error.message}`);
    process.exitCode = 2;
  }
}
