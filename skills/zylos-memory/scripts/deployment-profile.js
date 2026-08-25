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
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_PROFILE_ROOT = path.resolve(SCRIPT_DIR, '..', 'profiles');
const PROFILE_ID = /^[a-z0-9](?:[a-z0-9._-]{0,62})$/;
const DISABLED_PROFILE_IDS = new Set(['default', 'none']);

function readConfig(zylosDir) {
  try {
    return JSON.parse(
      fs.readFileSync(path.join(zylosDir, '.zylos', 'config.json'), 'utf8'),
    );
  } catch {
    return {};
  }
}

function configuredValue(envValue, configValue) {
  if (typeof envValue === 'string' && envValue.trim()) return envValue.trim();
  if (typeof configValue === 'string' && configValue.trim()) return configValue.trim();
  return null;
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

/**
 * Read profile identity without activating any behavior.
 * Environment selection takes precedence so managed COCO deployments can use
 * an immutable image with per-instance configuration.
 */
export function readProfileSelection({
  zylosDir = process.env.ZYLOS_DIR || path.join(os.homedir(), 'zylos'),
  env = process.env,
} = {}) {
  const config = readConfig(zylosDir);
  const configuredProfiles = config?.profiles && typeof config.profiles === 'object'
    ? config.profiles
    : {};

  return {
    agent: normalizeIdentifier(
      configuredValue(env.ZYLOS_AGENT_PROFILE, configuredProfiles.agent),
      'Agent',
      { allowDisabled: true },
    ),
    deployment: normalizeIdentifier(
      configuredValue(env.ZYLOS_DEPLOYMENT_PROFILE, configuredProfiles.deployment),
      'Deployment',
      { allowDisabled: true },
    ),
  };
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
  let content;
  try {
    content = fs.readFileSync(profilePath, 'utf8').trim();
  } catch {
    throw new Error(`unknown Deployment Profile "${selection.deployment}"`);
  }
  if (!content) {
    throw new Error(`Deployment Profile "${selection.deployment}" has empty memory governance`);
  }

  return {
    id: selection.deployment,
    agentProfile: selection.agent,
    content,
    source: profilePath,
  };
}

function runCli() {
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
