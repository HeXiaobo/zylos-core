#!/usr/bin/env node
/**
 * Read-only functional configuration descriptor for a qualified Zylos bundle.
 *
 * Every source and runtime path is supplied by the caller. The descriptor is
 * deliberately limited to portable behavior; account IDs, credentials,
 * labels, topology counts, and mapping cardinality never enter its hash.
 * HXA final delivery mode is read from the exact online PM2 response-stream
 * supervisor record and resolved by the pinned HXA source module. It is never
 * inferred from the caller environment or the runtime .env file.
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const ENV_KEYS = Object.freeze([
  'COMMITMENT_FEISHU_TASK_V2_ENABLED',
  'FEISHU_TASK_COMMENTS_ENABLED',
  'C4_REPLY_REFACTOR_V1',
]);
const HXA_FINAL_DELIVERY_MODE_KEY = 'HXA_FINAL_DELIVERY_MODE';
const HXA_ACCESS_KEYS = Object.freeze(['dmPolicy', 'dmAllowFrom', 'groupPolicy', 'threads']);
const LABEL_RE = /^[a-z0-9][a-z0-9-]*$/;
const VALUE_FLAGS = Object.freeze({
  '--zylos-dir': 'zylosDir',
  '--core-source': 'coreSource',
  '--feishu-source': 'feishuSource',
  '--hxa-source': 'hxaSource',
  '--pm2-jlist': 'pm2Jlist',
  '--runtime': 'runtime',
  '--out': 'out',
});

const PM2_ROLE_ORDER = Object.freeze([
  'feishu-service',
  'feishu-task-v2-projection',
  'feishu-task-comments',
  'commitment-feishu-task-projection',
]);

const PM2_NAME_ROLES = Object.freeze({
  'zylos-feishu': 'feishu-service',
  'zylos-feishu-task-v2-projection': 'feishu-task-v2-projection',
  'zylos-feishu-task-comments': 'feishu-task-comments',
  'zylos-feishu-task-projection': 'commitment-feishu-task-projection',
});
const WORKER_ROLES = Object.freeze(PM2_ROLE_ORDER.slice(1));

function usage() {
  return [
    'node <PROBE>',
    '  --zylos-dir DIR --core-source DIR --feishu-source DIR',
    '  --hxa-source DIR --runtime claude|codex [--pm2-jlist FILE] [--out FILE]',
  ].join('\n');
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--help') {
      console.log(usage());
      process.exit(0);
    }
    const key = VALUE_FLAGS[flag];
    const value = argv[index + 1];
    if (!key || !value || value.startsWith('--') || options[key] !== undefined) {
      throw new Error(`Invalid arguments.\n${usage()}`);
    }
    options[key] = value;
    index += 1;
  }
  for (const key of ['zylosDir', 'coreSource', 'feishuSource', 'hxaSource', 'runtime']) {
    if (!options[key]) throw new Error(`Missing --${key.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`)}.\n${usage()}`);
  }
  if (!['claude', 'codex'].includes(options.runtime)) {
    throw new Error('--runtime must be claude or codex');
  }
  for (const key of ['zylosDir', 'coreSource', 'feishuSource', 'hxaSource', 'pm2Jlist', 'out']) {
    if (options[key]) options[key] = path.resolve(options[key]);
  }
  return options;
}

function assertFile(file, label) {
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
    throw new Error(`${label} is missing: ${file}`);
  }
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function readDotenv(envFile, feishuSource) {
  const requireFromFeishu = createRequire(path.join(feishuSource, 'package.json'));
  const { parse } = requireFromFeishu('dotenv');
  return fs.existsSync(envFile)
    ? parse(fs.readFileSync(envFile, 'utf8'))
    : {};
}

function readPm2Snapshot(snapshotFile) {
  let stdout;
  if (snapshotFile) {
    assertFile(snapshotFile, 'PM2 jlist snapshot');
    stdout = fs.readFileSync(snapshotFile, 'utf8');
  } else {
    try {
      stdout = execFileSync('pm2', ['jlist'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      throw new Error(`Unable to read PM2 jlist: ${error.message}`);
    }
  }
  let processes;
  try {
    processes = JSON.parse(stdout || '[]');
  } catch (error) {
    throw new Error(`PM2 jlist is not valid JSON: ${error.message}`);
  }
  if (!Array.isArray(processes)) throw new Error('PM2 jlist must be a JSON array');
  return processes;
}

function normalizedPath(value) {
  return String(value || '').replaceAll('\\', '/');
}

function resolvedPm2Path(process, key) {
  const raw = normalizedPath(process?.pm2_env?.[key]);
  if (!raw) return null;
  if (path.isAbsolute(raw)) return path.normalize(raw);
  const cwd = normalizedPath(process?.pm2_env?.pm_cwd);
  return cwd && path.isAbsolute(cwd) ? path.resolve(cwd, raw) : null;
}

function pm2Role(process, zylosDir) {
  const runtimeRoot = path.resolve(zylosDir);
  const feishuRoot = path.join(runtimeRoot, '.claude', 'skills', 'feishu');
  const commitmentCoreRoot = path.join(runtimeRoot, '.claude', 'skills', 'commitment-core');
  const execPath = resolvedPm2Path(process, 'pm_exec_path');
  if (execPath === path.join(feishuRoot, 'src', 'index.js')) {
    return 'feishu-service';
  }
  if (execPath === path.join(feishuRoot, 'src', 'lib', 'task-v2-projection-worker.js')) {
    return 'feishu-task-v2-projection';
  }
  if (execPath === path.join(feishuRoot, 'src', 'lib', 'task-comment-worker.js')) {
    return 'feishu-task-comments';
  }
  if (execPath === path.join(commitmentCoreRoot, 'scripts', 'feishu-projection-worker.js')) {
    return 'commitment-feishu-task-projection';
  }
  // A non-empty executable path from another runtime must never be rescued by
  // a matching process name. Name fallback is only for old/sanitized snapshots
  // that omit the executable path entirely.
  if (execPath) return null;
  const role = PM2_NAME_ROLES[process?.name];
  if (typeof role !== 'string') return null;
  const cwd = resolvedPm2Path(process, 'pm_cwd');
  const expectedCwd = role === 'commitment-feishu-task-projection'
    ? path.join(commitmentCoreRoot, 'scripts')
    : feishuRoot;
  return cwd === expectedCwd ? role : null;
}

function effectivePm2Flags(process, dotenvEnv) {
  // Feishu loads the runtime dotenv file with override=false. PM2 therefore
  // wins for a key present in the process environment, while dotenv fills a
  // key that PM2 did not set for that process.
  const pm2EnvCandidates = [
    process?.pm2_env?.env,
    process?.pm2_env,
    process?.env,
  ].filter(isRecord);
  const flags = {};
  const sources = {};
  for (const key of ENV_KEYS) {
    const pm2Env = pm2EnvCandidates.find(candidate =>
      Object.prototype.hasOwnProperty.call(candidate, key));
    if (pm2Env) {
      flags[key] = pm2Env[key] == null ? null : String(pm2Env[key]);
      sources[key] = ['pm2'];
    } else if (Object.prototype.hasOwnProperty.call(dotenvEnv, key)) {
      flags[key] = dotenvEnv[key] == null ? null : String(dotenvEnv[key]);
      sources[key] = ['dotenv'];
    } else {
      flags[key] = null;
      sources[key] = ['unset'];
    }
  }
  return { flags, sources };
}

function mergeSources(left, right) {
  return Object.fromEntries(ENV_KEYS.map((key) => [
    key,
    [...new Set([...(left[key] || []), ...(right[key] ? [right[key]] : [])])]
      .sort(),
  ]));
}

function inspectPm2Flags(processes, dotenvEnv, canonical, zylosDir) {
  const onlineByRole = new Map();
  for (const process of processes) {
    if (!isRecord(process) || process?.pm2_env?.status !== 'online') continue;
    const role = pm2Role(process, zylosDir);
    if (!role) continue;
    const observation = effectivePm2Flags(process, dotenvEnv);
    const existing = onlineByRole.get(role);
    if (!existing) {
      onlineByRole.set(role, observation);
      continue;
    }
    if (canonical(existing.flags) !== canonical(observation.flags)) {
      throw new Error(`Conflicting effective PM2 flags for ${role}`);
    }
    existing.sources = mergeSources(existing.sources, observation.sources);
  }

  const primary = onlineByRole.get('feishu-service');
  if (!primary) {
    throw new Error('No online Feishu service was found in PM2 jlist');
  }
  for (const role of WORKER_ROLES) {
    const worker = onlineByRole.get(role);
    if (!worker) continue;
    for (const key of ['COMMITMENT_FEISHU_TASK_V2_ENABLED', 'FEISHU_TASK_COMMENTS_ENABLED']) {
      if (worker.flags[key] !== primary.flags[key]) {
        throw new Error(`Inconsistent effective PM2 flag ${key} for ${role}`);
      }
    }
  }

  const evidence = {};
  for (const role of PM2_ROLE_ORDER) {
    const observation = onlineByRole.get(role);
    if (!observation) continue;
    evidence[role] = {
      status: 'online',
      flags: observation.flags,
      sources: observation.sources,
    };
  }
  return { primaryFlags: primary.flags, evidence };
}

function pm2EnvironmentCandidates(process) {
  return [
    ['pm2_env.env', process?.pm2_env?.env],
    ['pm2_env', process?.pm2_env],
  ].filter(([, value]) => isRecord(value));
}

function resolveSupervisorDeliveryMode(process, resolveFinalDeliveryMode) {
  const candidates = pm2EnvironmentCandidates(process);
  const present = candidates.filter(([, value]) =>
    Object.prototype.hasOwnProperty.call(value, HXA_FINAL_DELIVERY_MODE_KEY));
  if (present.length === 0) {
    // The HXA resolver owns the default. Passing an explicit empty object is
    // intentional: the operator's process.env and runtime .env are not
    // effective inputs for a PM2-managed supervisor child.
    return {
      mode: resolveFinalDeliveryMode(Object.create(null)),
      sources: ['pm2-process-env-unset'],
    };
  }
  const resolved = present.map(([source, env]) => ({
    source,
    mode: resolveFinalDeliveryMode(env),
  }));
  const modes = [...new Set(resolved.map(item => item.mode))];
  if (modes.length !== 1) {
    throw new Error(`Conflicting effective ${HXA_FINAL_DELIVERY_MODE_KEY} values for the exact PM2 supervisor`);
  }
  return {
    mode: modes[0],
    sources: resolved.map(item => item.source),
  };
}

function inspectHxaFinalDeliveryMode(processes, resolveFinalDeliveryMode, zylosDir) {
  const expectedPath = path.join(
    path.resolve(zylosDir),
    '.claude',
    'skills',
    'comm-bridge',
    'scripts',
    'c4-response-stream-supervisor.js',
  );
  const matches = [];
  for (const process of processes) {
    if (!isRecord(process) || process?.pm2_env?.status !== 'online') continue;
    // The executable path is the identity boundary. Do not fall back to the
    // process name: another runtime may use the same PM2 name.
    const execPath = resolvedPm2Path(process, 'pm_exec_path');
    if (execPath !== expectedPath) continue;
    const resolved = resolveSupervisorDeliveryMode(process, resolveFinalDeliveryMode);
    matches.push({
      name: typeof process.name === 'string' ? process.name : null,
      status: 'online',
      execPath,
      effectiveMode: resolved.mode,
      sources: resolved.sources,
    });
  }
  if (matches.length === 0) {
    throw new Error(`No online HXA response stream supervisor matched exact runtime path: ${expectedPath}`);
  }
  const modes = [...new Set(matches.map(item => item.effectiveMode))];
  if (modes.length !== 1) {
    throw new Error(`Conflicting effective ${HXA_FINAL_DELIVERY_MODE_KEY} values across exact PM2 supervisors`);
  }
  return {
    mode: modes[0],
    expectedPath,
    matches,
  };
}

function flagIsOn(value) {
  return value === '1';
}

function replyRefactorIsOn(value) {
  return ['1', 'true', 'enabled'].includes(String(value ?? '').trim().toLowerCase());
}

function mergeFeishuConfig(raw, defaults) {
  const parsed = isRecord(raw) ? raw : {};
  const config = {
    ...defaults,
    ...parsed,
    workIntake: {
      ...defaults.workIntake,
      ...(isRecord(parsed.workIntake) ? parsed.workIntake : {}),
    },
  };
  // Match Feishu's legacy migration when dmPolicy is absent. The allowlist
  // entries themselves remain host-specific and are intentionally ignored.
  if (!Object.prototype.hasOwnProperty.call(parsed, 'dmPolicy')) {
    if (config.whitelist) {
      const whitelist = isRecord(config.whitelist) ? config.whitelist : {};
      const enabled = whitelist.private_enabled ?? whitelist.enabled ?? false;
      config.dmPolicy = enabled ? 'allowlist' : 'open';
    } else {
      config.dmPolicy = 'owner';
    }
  }
  return config;
}

function effectiveDmPolicy(config, defaults) {
  // Feishu checks memberAccessPolicy first. A present policy therefore keeps
  // precedence even when the legacy dmPolicy field is also configured.
  if (config.memberAccessPolicy) {
    return {
      source: 'memberAccessPolicy',
      mode: isRecord(config.memberAccessPolicy)
        && typeof config.memberAccessPolicy.mode === 'string'
        ? config.memberAccessPolicy.mode
        : 'invalid',
    };
  }
  const legacyMode = config.dmPolicy || defaults.dmPolicy;
  return {
    source: 'legacyDmPolicy',
    mode: typeof legacyMode === 'string' ? legacyMode : 'invalid',
  };
}

function effectiveFeishu(raw, defaults, env, getters) {
  const config = mergeFeishuConfig(raw, defaults);
  const message = isRecord(config.message) ? config.message : {};
  return {
    connectionMode: config.connection_mode || defaults.connection_mode,
    effectiveDmPolicy: effectiveDmPolicy(config, defaults),
    workIntake: {
      enabled: config.workIntake?.enabled === true,
      timeZone: config.workIntake?.timeZone || defaults.workIntake.timeZone,
      confirmationTtlMs: config.workIntake?.confirmationTtlMs
        ?? defaults.workIntake.confirmationTtlMs,
    },
    replies: {
      markdownCard: message.useMarkdownCard === true,
      processDisplay: getters.getStreamProcessDisplay(config),
      streamTimeoutsMs: {
        queued: getters.getResponseStreamQueuedTimeoutMs(config),
        main: getters.getResponseStreamMainTimeoutMs(config),
        taskQueued: getters.getResponseStreamTaskQueuedTimeoutMs(config),
        taskMain: getters.getResponseStreamTaskMainTimeoutMs(config),
      },
    },
    enabled: config.enabled !== false,
    replyRefactorV1Enabled: replyRefactorIsOn(env.C4_REPLY_REFACTOR_V1),
  };
}

function migrateHxaInMemory(raw) {
  // Mirrors the source migration without calling migrateConfig(), which writes
  // a backup and rewrites the runtime file.
  const config = cloneJson(raw);
  if (!isRecord(config)) throw new Error('HXA config must be a JSON object');
  if (!isRecord(config.orgs)) {
    if (!config.org_id) throw new Error('HXA config has no orgs/org_id');
    const { hub_url, org_id, agent_id, agent_token, agent_name, ...rest } = config;
    const access = {};
    for (const key of HXA_ACCESS_KEYS) {
      if (Object.prototype.hasOwnProperty.call(rest, key)) {
        access[key] = rest[key];
        delete rest[key];
      }
    }
    config.default_hub_url = hub_url || null;
    config.orgs = {
      default: {
        enabled: true,
        org_id,
        agent_id: agent_id || null,
        agent_token,
        agent_name,
        hub_url: null,
        access: { dmPolicy: 'open', groupPolicy: 'open', ...access },
      },
    };
    Object.assign(config, rest);
  }

  const globalAccess = {};
  for (const key of HXA_ACCESS_KEYS) {
    if (Object.prototype.hasOwnProperty.call(config, key)) globalAccess[key] = config[key];
  }
  for (const [label, org] of Object.entries(config.orgs)) {
    if (!isRecord(org)) throw new Error(`HXA org ${label} must be an object`);
    if (!isRecord(org.access)) org.access = {};
    for (const [key, value] of Object.entries(globalAccess)) {
      if (!Object.prototype.hasOwnProperty.call(org.access, key)) org.access[key] = value;
    }
    if (!Object.prototype.hasOwnProperty.call(org, 'enabled')) org.enabled = true;
    if (!Object.prototype.hasOwnProperty.call(org.access, 'dmPolicy')) org.access.dmPolicy = 'open';
    if (!Object.prototype.hasOwnProperty.call(org.access, 'groupPolicy')) org.access.groupPolicy = 'open';
    const orgMode = org.access.threadMode;
    const threads = isRecord(org.access.threads) ? org.access.threads : {};
    for (const thread of Object.values(threads)) {
      if (isRecord(thread) && !Object.prototype.hasOwnProperty.call(thread, 'mode')) {
        thread.mode = orgMode || 'mention';
      }
    }
    delete org.access.threadMode;
  }
  return config;
}

function senderPolicy(value) {
  const allowFrom = Array.isArray(value) ? value : [];
  if (allowFrom.length === 0) return 'open';
  return allowFrom.some((entry) => String(entry) === '*') ? 'wildcard' : 'allowlist';
}

function uniqueSorted(items, canonical) {
  const unique = new Map(items.map((item) => [canonical(item), item]));
  return [...unique.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, item]) => item);
}

function hxaAccessPolicies(raw, canonical) {
  const config = migrateHxaInMemory(raw);
  const combinations = [];
  for (const [label, org] of Object.entries(config.orgs)) {
    // resolveOrgs() ignores invalid labels; keep only enabled, valid orgs in
    // the functional descriptor and leave identity/credential checks to the
    // host preflight.
    if (!LABEL_RE.test(label) || org.enabled === false) continue;
    const access = isRecord(org.access) ? org.access : {};
    const orgMode = access.threadMode;
    const threads = isRecord(access.threads) ? access.threads : {};
    const threadPolicies = Object.values(threads).map((thread) => ({
      mode: isRecord(thread) && typeof thread.mode === 'string'
        ? thread.mode
        : (orgMode || 'mention'),
      senderPolicy: senderPolicy(isRecord(thread) ? thread.allowFrom : undefined),
    }));
    combinations.push({
      dmPolicy: access.dmPolicy || 'open',
      groupPolicy: access.groupPolicy || 'open',
      threadPolicies: uniqueSorted(threadPolicies, canonical),
    });
  }
  return uniqueSorted(combinations, canonical);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const releaseChannelPath = path.join(options.coreSource, 'tools/upgrade/release-channel.mjs');
  const feishuModulePath = path.join(options.feishuSource, 'src/lib/config.js');
  const hxaModulePath = path.join(options.hxaSource, 'src/env.js');
  const hxaDeliveryModulePath = path.join(
    options.hxaSource,
    'src/lib/assistant-response-delivery.js',
  );
  assertFile(releaseChannelPath, 'Core release-channel module');
  assertFile(path.join(options.coreSource, 'package.json'), 'Core package manifest');
  assertFile(feishuModulePath, 'Feishu config module');
  assertFile(path.join(options.feishuSource, 'package.json'), 'Feishu package manifest');
  assertFile(hxaModulePath, 'HXA environment module');
  assertFile(hxaDeliveryModulePath, 'HXA final delivery module');
  assertFile(path.join(options.zylosDir, 'components/hxa-connect/config.json'), 'HXA runtime config');

  const core = await import(pathToFileURL(releaseChannelPath).href);
  const feishu = await import(pathToFileURL(feishuModulePath).href);
  const hxaDelivery = await import(pathToFileURL(hxaDeliveryModulePath).href);
  if (typeof hxaDelivery.resolveFinalDeliveryMode !== 'function') {
    throw new Error('HXA final delivery module does not export resolveFinalDeliveryMode');
  }
  const envFile = path.join(options.zylosDir, '.env');
  const feishuConfigPath = path.join(options.zylosDir, 'components/feishu/config.json');
  const hxaConfigPath = path.join(options.zylosDir, 'components/hxa-connect/config.json');
  const dotenvEnv = readDotenv(envFile, options.feishuSource);
  const pm2Processes = readPm2Snapshot(options.pm2Jlist);
  const pm2Flags = inspectPm2Flags(pm2Processes, dotenvEnv, core.canonical, options.zylosDir);
  const hxaFinalDelivery = inspectHxaFinalDeliveryMode(
    pm2Processes,
    hxaDelivery.resolveFinalDeliveryMode,
    options.zylosDir,
  );
  const env = pm2Flags.primaryFlags;
  const feishuRaw = fs.existsSync(feishuConfigPath) ? readJson(feishuConfigPath) : {};
  const hxaRaw = readJson(hxaConfigPath);
  const descriptor = {
    schema: 'zylos.functional-config/v3',
    featureSwitches: {
      feishuEnabled: effectiveFeishu(feishuRaw, feishu.DEFAULT_CONFIG, env, feishu).enabled,
      taskV2Enabled: flagIsOn(env.COMMITMENT_FEISHU_TASK_V2_ENABLED),
      taskCommentsEnabled: flagIsOn(env.FEISHU_TASK_COMMENTS_ENABLED),
      taskCommentsEffective: flagIsOn(env.COMMITMENT_FEISHU_TASK_V2_ENABLED)
        && flagIsOn(env.FEISHU_TASK_COMMENTS_ENABLED),
      replyRefactorV1Enabled: replyRefactorIsOn(env.C4_REPLY_REFACTOR_V1),
    },
    feishu: effectiveFeishu(feishuRaw, feishu.DEFAULT_CONFIG, env, feishu),
    hxa: {
      finalDeliveryMode: hxaFinalDelivery.mode,
      enabledOrgAccessPolicies: hxaAccessPolicies(hxaRaw, core.canonical),
    },
  };
  // The feature switch is recorded once in the descriptor. Keep the Feishu
  // section focused on its own effective settings.
  delete descriptor.feishu.enabled;
  delete descriptor.feishu.replyRefactorV1Enabled;

  const canonicalJson = core.canonical(descriptor);
  const functionalConfigSha256 = core.sha256(canonicalJson);
  const environment = {
    ...core.readReleaseHost({ runtimeRoot: options.zylosDir, runtime: options.runtime }),
    functionalConfigSha256,
  };
  const result = {
    schema: 'zylos.qualified-config-probe/v3',
    purpose: 'functional-descriptor-only',
    readOnly: true,
    checkedAt: new Date().toISOString(),
    descriptor,
    canonicalJson,
    functionalConfigSha256,
    environment,
    environmentFingerprint: core.qualificationFingerprint(environment),
    pm2: {
      source: options.pm2Jlist ? 'snapshot-file' : 'live-jlist',
      effectiveAllowlistedFlags: pm2Flags.evidence,
      hxaFinalDeliveryMode: {
        effective: hxaFinalDelivery.mode,
        supervisorPath: hxaFinalDelivery.expectedPath,
        matches: hxaFinalDelivery.matches,
      },
    },
  };
  const bytes = JSON.stringify(result, null, 2) + '\n';
  if (options.out) fs.writeFileSync(options.out, bytes, { flag: 'wx', mode: 0o600 });
  process.stdout.write(bytes);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
