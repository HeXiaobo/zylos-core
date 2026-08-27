#!/usr/bin/env node

/**
 * Release-bound HXA component preflight.
 *
 * The dry-run path is intentionally independent from the generic component
 * upgrade command. It accepts only an immutable repository/SHA and an
 * explicit release/agent/report binding, then inspects the target and a
 * staged archive without acquiring a runtime lock or touching the installed
 * component. Execute is deliberately left unsupported until its transaction
 * and postcheck evidence contract is implemented.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const COMPONENT = 'hxa-connect';
const PACKAGE_NAME = 'zylos-hxa-connect';
const CANONICAL_REPO = 'HeXiaobo/zylos-hxa-connect';
const INSTALLED_REPO_ALLOWLIST = new Set([CANONICAL_REPO, 'coco-xyz/zylos-hxa-connect']);
const FULL_SHA = /^[0-9a-f]{40}$/i;
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const HOSTNAME = /^[A-Za-z0-9][A-Za-z0-9.-]*$/;
const MIN_AVAILABLE_KB = 5 * 1024 * 1024;
const MAX_ARCHIVE_BYTES = 256 * 1024 * 1024;
const MAX_EXTRACTED_BYTES = 512 * 1024 * 1024;
const MAX_ARCHIVE_ENTRIES = 16_384;
const MIN_RUNTIME_FREE_INODES = 100_000;

class HoldError extends Error {
  constructor(message, code = 'PREFLIGHT_FAILED') {
    super(message);
    this.name = 'HoldError';
    this.code = code;
  }
}

function isRegular(filePath) {
  try {
    const stat = fs.lstatSync(filePath);
    return stat.isFile() && !stat.isSymbolicLink();
  } catch {
    return false;
  }
}

function isDirectory(directoryPath) {
  try {
    const stat = fs.lstatSync(directoryPath);
    return stat.isDirectory() && !stat.isSymbolicLink();
  } catch {
    return false;
  }
}

function validateOwnedRegularFile(filePath, label, maxBytes = 1024 * 1024) {
  let stat;
  try { stat = fs.lstatSync(filePath); } catch {
    throw new HoldError(`${label} is missing or unreadable`, 'TARGET_INVALID');
  }
  if (!stat.isFile() || stat.isSymbolicLink()) throw new HoldError(`${label} is not a regular file`, 'TARGET_INVALID');
  if (typeof process.getuid !== 'function' || stat.uid !== process.getuid()) {
    throw new HoldError(`${label} is not owned by the runtime user`, 'TARGET_INVALID');
  }
  if ((stat.mode & 0o022) !== 0) throw new HoldError(`${label} is writable by group or others`, 'TARGET_INVALID');
  if (!Number.isSafeInteger(stat.size) || stat.size < 0 || stat.size > maxBytes) {
    throw new HoldError(`${label} exceeds its safe size limit`, 'TARGET_INVALID');
  }
  return stat;
}

function readSourceMarker(markerPath, label) {
  validateOwnedRegularFile(markerPath, label, 16 * 1024);
  const marker = readJson(markerPath, label);
  if (!marker || typeof marker !== 'object' || Array.isArray(marker)) {
    throw new HoldError(`${label} must be an object`, 'SOURCE_MARKER_INVALID');
  }
  const allowed = new Set(['repo', 'sha', 'ref', 'refType', 'version', 'installedAt', 'upgradedAt']);
  if (Object.keys(marker).some((key) => !allowed.has(key))) {
    throw new HoldError(`${label} contains unsupported fields`, 'SOURCE_MARKER_INVALID');
  }
  if (typeof marker.repo !== 'string' || normalizeRepository(marker.repo) !== marker.repo) {
    throw new HoldError(`${label} repository is invalid`, 'SOURCE_MARKER_INVALID');
  }
  if (typeof marker.version !== 'string' || !VERSION.test(marker.version)) {
    throw new HoldError(`${label} version is invalid`, 'SOURCE_MARKER_INVALID');
  }
  if (marker.sha !== undefined && (typeof marker.sha !== 'string' || !FULL_SHA.test(marker.sha))) {
    throw new HoldError(`${label} SHA is invalid`, 'SOURCE_MARKER_INVALID');
  }
  if (marker.refType !== undefined && !['commit', 'branch', 'tag'].includes(marker.refType)) {
    throw new HoldError(`${label} refType is invalid`, 'SOURCE_MARKER_INVALID');
  }
  if (marker.refType === 'commit' && (!FULL_SHA.test(marker.ref || '') || marker.sha !== marker.ref)) {
    throw new HoldError(`${label} commit ref is invalid`, 'SOURCE_MARKER_INVALID');
  }
  for (const key of ['installedAt', 'upgradedAt']) {
    if (marker[key] !== undefined && (typeof marker[key] !== 'string' || Number.isNaN(Date.parse(marker[key])))) {
      throw new HoldError(`${label} ${key} is invalid`, 'SOURCE_MARKER_INVALID');
    }
  }
  return Object.fromEntries(Object.entries(marker).filter(([key]) => allowed.has(key)));
}

function readJson(filePath, label) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    throw new HoldError(`${label} is unreadable: ${error.message}`, 'PREFLIGHT_FAILED');
  }
}

function parseJsonOutput(text, label) {
  const value = String(text || '').trim();
  try {
    return JSON.parse(value);
  } catch {
    for (let index = 0; index < value.length; index += 1) {
      if (value[index] !== '{' && value[index] !== '[') continue;
      try {
        return JSON.parse(value.slice(index));
      } catch {
        // Continue looking for a JSON boundary after diagnostic text.
      }
    }
  }
  throw new HoldError(`${label} did not return valid JSON`, 'PREFLIGHT_FAILED');
}

function safeChildEnv(additions = {}) {
  const allowed = [
    'HOME', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'TMPDIR', 'TZ',
    'HTTPS_PROXY', 'HTTP_PROXY', 'ALL_PROXY', 'NO_PROXY',
    'https_proxy', 'http_proxy', 'all_proxy', 'no_proxy',
    'SSL_CERT_FILE', 'SSL_CERT_DIR',
  ];
  const env = { PATH: '/usr/bin:/bin:/usr/sbin:/sbin' };
  for (const name of allowed) {
    if (typeof process.env[name] === 'string') env[name] = process.env[name];
  }
  return { ...env, ...additions };
}

function run(command, args, options = {}) {
  if (!path.isAbsolute(command)) {
    return { command, args, status: null, signal: null, stdout: '', stderr: '', error: 'command path must be absolute' };
  }
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    timeout: options.timeout ?? 120_000,
    cwd: options.cwd,
    env: options.env ?? safeChildEnv(),
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: options.maxBuffer ?? (8 * 1024 * 1024),
  });
  return {
    command,
    args,
    status: result.status,
    signal: result.signal,
    stdout: String(result.stdout || ''),
    stderr: String(result.stderr || ''),
    error: result.error?.message || null,
  };
}

function validateToolCandidate(candidate, { system = false } = {}) {
  try {
    const resolved = fs.realpathSync.native(candidate);
    const stat = fs.statSync(resolved);
    const parent = fs.statSync(path.dirname(resolved));
    if (!stat.isFile() || (stat.mode & 0o111) === 0) return null;
    if ((stat.mode & 0o022) !== 0 || (parent.mode & 0o022) !== 0) return null;
    if (system && (stat.uid !== 0 || parent.uid !== 0)) return null;
    if (!system && typeof process.getuid === 'function' && ![0, process.getuid()].includes(stat.uid)) return null;
    return resolved;
  } catch {
    return null;
  }
}

function resolveTrustedTool(name, candidates, options = {}) {
  for (const candidate of candidates) {
    const resolved = validateToolCandidate(candidate, options);
    if (resolved) return resolved;
  }
  throw new HoldError(`trusted ${name} executable is unavailable`, 'TOOL_UNVERIFIED');
}

function resolveTools(injected = null) {
  if (injected) {
    for (const [name, command] of Object.entries(injected)) {
      if (!path.isAbsolute(command)) throw new HoldError(`injected ${name} tool must be absolute`, 'TOOL_UNVERIFIED');
    }
    return { ...injected };
  }
  const userHome = os.userInfo().homedir;
  return {
    ps: resolveTrustedTool('ps', ['/usr/bin/ps', '/bin/ps'], { system: true }),
    tar: resolveTrustedTool('tar', ['/usr/bin/tar', '/bin/tar'], { system: true }),
    curl: resolveTrustedTool('curl', ['/usr/bin/curl', '/bin/curl'], { system: true }),
    pm2: resolveTrustedTool('pm2', [
      path.join(path.dirname(process.execPath), 'pm2'),
      '/usr/local/bin/pm2',
      path.join(userHome, '.npm-global', 'bin', 'pm2'),
      path.join(userHome, '.local', 'bin', 'pm2'),
      '/usr/bin/pm2',
      '/bin/pm2',
    ]),
  };
}

function requireSuccess(result, label, code = 'PREFLIGHT_FAILED') {
  if (result.status === 0 && !result.error) return result;
  const detail = result.error
    || result.stderr.trim().split(/\r?\n/).find(Boolean)
    || result.stdout.trim().split(/\r?\n/).find(Boolean)
    || `exit ${result.status}`;
  throw new HoldError(`${label}: ${detail}`, code);
}

function atomicWriteJson(filePath, value) {
  const temporaryPath = `${filePath}.tmp-${process.pid}-${crypto.randomBytes(8).toString('hex')}`;
  let descriptor = null;
  try {
    const parent = path.dirname(filePath);
    if (path.dirname(temporaryPath) !== parent) throw new Error('temporary report path escaped its parent');
    if (fs.existsSync(filePath)) {
      const existing = fs.lstatSync(filePath);
      if (!existing.isFile() || existing.isSymbolicLink()) throw new Error('report target is not a regular file');
      if (typeof process.getuid !== 'function' || existing.uid !== process.getuid() || (existing.mode & 0o077) !== 0) {
        throw new Error('report target ownership or mode is unsafe');
      }
    }
    descriptor = fs.openSync(temporaryPath, 'wx', 0o600);
    fs.writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = null;
    fs.renameSync(temporaryPath, filePath);
  } catch (error) {
    if (descriptor !== null) {
      try { fs.closeSync(descriptor); } catch {}
    }
    try { fs.rmSync(temporaryPath, { force: true }); } catch {}
    throw error;
  }
}

function parseArgs(argv) {
  const values = new Map([
    ['--repo', 'repo'],
    ['--sha', 'sha'],
    ['--version', 'version'],
    ['--agent', 'agent'],
    ['--profile-id', 'profileId'],
    ['--hostname', 'hostname'],
    ['--release-id', 'releaseId'],
    ['--report-root', 'reportRoot'],
  ]);
  const result = { mode: null };
  const seen = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--dry-run' || token === '--execute') {
      if (result.mode) throw new HoldError('choose exactly one of --dry-run or --execute', 'INVALID_ARGS');
      result.mode = token.slice(2);
      continue;
    }
    const key = values.get(token);
    if (!key) throw new HoldError(`unknown argument: ${token}`, 'INVALID_ARGS');
    if (seen.has(key)) throw new HoldError(`${token} may only be provided once`, 'INVALID_ARGS');
    seen.add(key);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new HoldError(`${token} requires a value`, 'INVALID_ARGS');
    result[key] = value;
    index += 1;
  }
  if (!result.mode) throw new HoldError('choose exactly one of --dry-run or --execute', 'INVALID_ARGS');
  for (const key of ['repo', 'sha', 'version', 'agent', 'profileId', 'hostname', 'releaseId', 'reportRoot']) {
    if (!result[key]) throw new HoldError(`--${key.replace(/[A-Z]/g, (match) => `-${match.toLowerCase()}`)} is required`, 'INVALID_ARGS');
  }
  if (!path.isAbsolute(result.reportRoot)) {
    throw new HoldError('--report-root must be an absolute path', 'INVALID_ARGS');
  }
  if (result.repo.split('/').length !== 2 || result.repo.split('/').some((part) => !SAFE_NAME.test(part))) {
    throw new HoldError('--repo must be an owner/name slug', 'INVALID_ARGS');
  }
  if (result.repo !== CANONICAL_REPO) {
    throw new HoldError(`--repo must be the canonical ${CANONICAL_REPO}`, 'INVALID_ARGS');
  }
  if (!FULL_SHA.test(result.sha)) throw new HoldError('--sha must be a full immutable 40-hex commit', 'INVALID_ARGS');
  if (!VERSION.test(result.version)) throw new HoldError('--version must be a semantic version', 'INVALID_ARGS');
  if (!SAFE_NAME.test(result.agent)) throw new HoldError('--agent must be a simple identity name', 'INVALID_ARGS');
  if (result.agent === 'unknown') throw new HoldError('--agent must identify the target employee', 'INVALID_ARGS');
  if (!SAFE_NAME.test(result.profileId) || result.profileId === 'unknown') {
    throw new HoldError('--profile-id must identify the exact target profile', 'INVALID_ARGS');
  }
  if (!HOSTNAME.test(result.hostname) || result.hostname.length > 253) {
    throw new HoldError('--hostname must identify the exact target host', 'INVALID_ARGS');
  }
  if (result.releaseId.length > 256 || /[\r\n]/.test(result.releaseId)) {
    throw new HoldError('--release-id is invalid', 'INVALID_ARGS');
  }
  return result;
}

function validateOwnedDirectory(directoryPath, label, { privateMode = false } = {}) {
  let stat;
  try { stat = fs.lstatSync(directoryPath); } catch {
    throw new HoldError(`${label} is missing or unreadable`, 'REPORT_FAILED');
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new HoldError(`${label} is not a real directory`, 'REPORT_FAILED');
  if (typeof process.getuid !== 'function' || stat.uid !== process.getuid()) {
    throw new HoldError(`${label} is not owned by the runtime user`, 'REPORT_FAILED');
  }
  const unsafeMask = privateMode ? 0o077 : 0o022;
  if ((stat.mode & unsafeMask) !== 0) {
    throw new HoldError(`${label} has unsafe permissions`, 'REPORT_FAILED');
  }
  return fs.realpathSync.native(directoryPath);
}

function ensureReportRoot(reportRoot, zylosDir) {
  const reportBase = path.join(zylosDir, '.zylos', 'upgrade-reports');
  const reportName = path.basename(reportRoot);
  if (!SAFE_NAME.test(reportName) || path.dirname(path.resolve(reportRoot)) !== path.resolve(reportBase)) {
    throw new HoldError('--report-root must be a new direct child of <zylos>/.zylos/upgrade-reports', 'REPORT_FAILED');
  }
  const configDir = path.join(zylosDir, '.zylos');
  validateOwnedDirectory(configDir, 'runtime .zylos directory');
  try { fs.mkdirSync(reportBase, { mode: 0o700 }); } catch (error) {
    if (error?.code !== 'EEXIST') throw new HoldError('upgrade report base could not be created', 'REPORT_FAILED');
  }
  const realBase = validateOwnedDirectory(reportBase, 'upgrade report base', { privateMode: true });
  const expectedReportRoot = path.join(realBase, reportName);
  let requestedParent;
  try { requestedParent = fs.realpathSync.native(path.dirname(reportRoot)); } catch {
    throw new HoldError('--report-root parent is unreadable', 'REPORT_FAILED');
  }
  if (requestedParent !== realBase) {
    throw new HoldError('--report-root parent did not resolve to the private report base', 'REPORT_FAILED');
  }
  try { fs.mkdirSync(expectedReportRoot, { mode: 0o700 }); } catch (error) {
    if (error?.code === 'EEXIST') throw new HoldError('report root already exists; use a unique report directory', 'REPORT_EXISTS');
    throw new HoldError('report root could not be created', 'REPORT_FAILED');
  }
  const realReportRoot = validateOwnedDirectory(expectedReportRoot, 'report root', { privateMode: true });
  if (fs.realpathSync.native(reportRoot) !== realReportRoot) {
    throw new HoldError('report root did not resolve to the newly created private directory', 'REPORT_FAILED');
  }
}

function resolveZylosDir() {
  return path.resolve(process.env.ZYLOS_DIR || path.join(os.homedir(), 'zylos'));
}

function skillDirFor(zylosDir) {
  return path.join(zylosDir, '.claude', 'skills', COMPONENT);
}

function parseSkillMetadata(skillDir) {
  const skillPath = path.join(skillDir, 'SKILL.md');
  if (!isRegular(skillPath)) throw new HoldError('HXA SKILL.md is missing or not a regular file', 'TARGET_INVALID');
  const content = fs.readFileSync(skillPath, 'utf8');
  const frontmatter = content.match(/^---\n([\s\S]*?)\n---/m)?.[1] || '';
  const readScalar = (name) => frontmatter.match(new RegExp(`^${name}:\\s*(.+)$`, 'm'))?.[1]?.trim() || null;
  return { name: readScalar('name'), version: readScalar('version') };
}

function readPackage(skillDir, label) {
  const packagePath = path.join(skillDir, 'package.json');
  if (!isRegular(packagePath)) throw new HoldError(`${label} package.json is missing or unsafe`, 'PACKAGE_INVALID');
  const pkg = readJson(packagePath, label);
  if (pkg?.name !== PACKAGE_NAME) {
    throw new HoldError(`${label} package name must be ${PACKAGE_NAME}, found ${pkg?.name || 'missing'}`, 'PACKAGE_INVALID');
  }
  if (typeof pkg.version !== 'string' || !pkg.version) {
    throw new HoldError(`${label} package version is missing`, 'PACKAGE_INVALID');
  }
  return pkg;
}

function normalizeRepository(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().replace(/\.git$/, '');
  const match = trimmed.match(/github\.com[/:]([^/]+\/[^/]+)$/i);
  return match ? match[1] : trimmed.includes('/') ? trimmed : null;
}

function validateCurrentTarget(zylosDir, agent) {
  const componentsPath = path.join(zylosDir, '.zylos', 'components.json');
  validateOwnedRegularFile(componentsPath, 'installed components registry');
  const components = readJson(componentsPath, 'installed components registry');
  const entry = components?.[COMPONENT];
  if (!entry || typeof entry !== 'object') {
    throw new HoldError('hxa-connect is not registered', 'TARGET_INVALID');
  }
  const skillDir = skillDirFor(zylosDir);
  if (!isDirectory(skillDir)) throw new HoldError('installed HXA skill directory is missing', 'TARGET_INVALID');
  if (entry.skillDir && path.resolve(entry.skillDir) !== path.resolve(skillDir)) {
    throw new HoldError('registered HXA skillDir does not match the target runtime', 'TARGET_INVALID');
  }
  const pkg = readPackage(skillDir, 'installed HXA');
  const skill = parseSkillMetadata(skillDir);
  if (skill.name && skill.name.replace(/^zylos-/, '') !== COMPONENT) {
    throw new HoldError(`installed HXA skill name does not identify ${COMPONENT}`, 'TARGET_INVALID');
  }
  if (!skill.version || skill.version !== pkg.version) {
    throw new HoldError('installed HXA SKILL.md and package versions do not match', 'TARGET_INVALID');
  }
  if (entry.version !== pkg.version) {
    throw new HoldError('installed HXA registry and package versions do not match', 'TARGET_INVALID');
  }
  const installedRepo = normalizeRepository(entry.repo);
  if (!INSTALLED_REPO_ALLOWLIST.has(installedRepo)) {
    throw new HoldError('installed HXA registry repository is not an approved source', 'TARGET_INVALID');
  }
  const markerPath = path.join(skillDir, '.zylos-source.json');
  let marker = null;
  if (fs.existsSync(markerPath)) marker = readSourceMarker(markerPath, 'installed HXA source marker');
  return {
    componentsPath,
    components,
    entry,
    skillDir,
    packageVersion: pkg.version,
    skillVersion: skill.version,
    sourceMarker: marker,
    expectedAgent: agent,
  };
}

const READ_ONLY_PROFILE_PROBE = String.raw`
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const [skillDir, configPath, orgLabel] = process.argv.slice(1);
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
const orgConfig = config.orgs?.[orgLabel];
if (!orgConfig) throw new Error('configured HXA org is missing');
const envModule = await import(pathToFileURL(path.join(skillDir, 'src', 'env.js')));
await envModule.setupFetchProxy();
const require = createRequire(path.join(skillDir, 'package.json'));
const sdkEntry = require.resolve('@coco-xyz/hxa-connect-sdk');
const { HxaConnectClient } = await import(pathToFileURL(sdkEntry));
const client = new HxaConnectClient({
  url: orgConfig.hub_url || config.default_hub_url,
  token: orgConfig.agent_token,
  orgId: orgConfig.org_id,
});
const profile = await client.getProfile();
process.stdout.write('__ZYLOS_READ_ONLY_PROFILE__' + JSON.stringify(profile) + '\n');
`;

function probeRemoteProfile(skillDir, configPath, orgLabel, childEnvAdditions = {}) {
  const result = requireSuccess(run(process.execPath, [
    '--input-type=module',
    '--eval',
    READ_ONLY_PROFILE_PROBE,
    skillDir,
    configPath,
    orgLabel,
  ], { timeout: 30_000, env: safeChildEnv(childEnvAdditions) }), 'read-only HXA Hub profile probe failed', 'IDENTITY_UNVERIFIED');
  const prefix = '__ZYLOS_READ_ONLY_PROFILE__';
  const line = result.stdout.split(/\r?\n/).find((candidate) => candidate.startsWith(prefix));
  if (!line) throw new HoldError('read-only HXA Hub profile probe returned no profile', 'IDENTITY_UNVERIFIED');
  return parseJsonOutput(line.slice(prefix.length), 'read-only HXA Hub profile probe');
}

function inspectIdentity(
  zylosDir,
  reportRoot,
  { agent: expectedAgent, profileId: expectedProfileId, hostname: expectedHostname },
  childEnvAdditions = {},
) {
  const configPath = path.join(zylosDir, 'components', COMPONENT, 'config.json');
  if (!isRegular(configPath)) throw new HoldError('HXA runtime config is missing or unsafe', 'IDENTITY_UNVERIFIED');
  const config = readJson(configPath, 'HXA runtime config');
  if (!config?.orgs || typeof config.orgs !== 'object' || Array.isArray(config.orgs)) {
    throw new HoldError('HXA config requires migration; refusing to run a mutating profile CLI', 'CONFIG_MIGRATION_REQUIRED');
  }
  const accessKeys = ['dmPolicy', 'dmAllowFrom', 'groupPolicy', 'threads'];
  const needsMigration = accessKeys.some((key) => Object.hasOwn(config, key))
    || Object.values(config.orgs).some((org) => {
      if (!org || typeof org !== 'object' || !Object.hasOwn(org, 'enabled')) return true;
      const access = org.access;
      if (!access || typeof access !== 'object') return true;
      if (!Object.hasOwn(access, 'dmPolicy') || !Object.hasOwn(access, 'groupPolicy') || Object.hasOwn(access, 'threadMode')) return true;
      return Object.values(access.threads || {}).some((thread) => !thread || typeof thread !== 'object' || !Object.hasOwn(thread, 'mode'));
    });
  if (needsMigration) {
    throw new HoldError('HXA config has pending schema migration; refusing to mutate it during dry-run', 'CONFIG_MIGRATION_REQUIRED');
  }
  const enabled = Object.entries(config.orgs).filter(([, org]) => org && typeof org === 'object' && org.enabled !== false);
  const selected = enabled.find(([label]) => label === 'default') || enabled[0];
  if (!selected) throw new HoldError('HXA config has no enabled org identity', 'IDENTITY_UNVERIFIED');
  const [orgLabel, org] = selected;
  const configuredAgent = typeof org.agent_name === 'string' ? org.agent_name.trim() : null;
  const configuredProfileId = typeof org.agent_id === 'string' ? org.agent_id.trim() : null;
  if (configuredAgent !== expectedAgent) {
    throw new HoldError(`configured target identity mismatch: expected ${expectedAgent}, found ${configuredAgent || 'missing'}`, 'IDENTITY_MISMATCH');
  }
  if (typeof configuredProfileId !== 'string' || !configuredProfileId.trim()) {
    throw new HoldError('HXA config did not return a profile ID', 'IDENTITY_UNVERIFIED');
  }
  if (configuredProfileId !== expectedProfileId) {
    throw new HoldError(`configured target profile mismatch: expected ${expectedProfileId}, found ${configuredProfileId}`, 'IDENTITY_MISMATCH');
  }
  const hostname = os.hostname().trim();
  if (!hostname) throw new HoldError('hostname probe returned an empty value', 'IDENTITY_UNVERIFIED');
  if (hostname !== expectedHostname) {
    throw new HoldError(`target hostname mismatch: expected ${expectedHostname}, found ${hostname}`, 'IDENTITY_MISMATCH');
  }
  const remote = probeRemoteProfile(skillDirFor(zylosDir), configPath, orgLabel, childEnvAdditions);
  const actualAgent = remote?.name || remote?.agent || remote?.agentName || null;
  const profileId = remote?.id || remote?.profileId || remote?.profile_id || null;
  if (actualAgent !== expectedAgent || profileId !== expectedProfileId) {
    throw new HoldError('fresh HXA Hub profile does not match the release target', 'IDENTITY_MISMATCH');
  }
  const observedAt = new Date().toISOString();
  const receipt = {
    schema: 'zylos.hxa-identity-receipt/v1',
    observedAt,
    name: actualAgent,
    profileId,
    hostname,
    orgLabel,
    source: 'HxaConnectClient.getProfile',
  };
  const receiptBytes = `${JSON.stringify(receipt, null, 2)}\n`;
  const receiptPath = path.join(reportRoot, 'identity-receipt.json');
  fs.writeFileSync(receiptPath, receiptBytes, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  return {
    name: actualAgent,
    profileId,
    hostname,
    orgLabel,
    observedAt,
    receiptPath,
    receiptSha256: crypto.createHash('sha256').update(receiptBytes).digest('hex'),
    evidence: 'read-only config validation, fresh HXA Hub getProfile, os.hostname, and private sanitized receipt',
  };
}

function inspectEmptyDirectory(directoryPath, label, unsafeCode) {
  let stat;
  try {
    stat = fs.lstatSync(directoryPath);
  } catch (error) {
    if (error?.code === 'ENOENT') return { status: 'PASS', path: directoryPath, entries: [], absent: true };
    throw new HoldError(`${label} is unreadable`, unsafeCode);
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new HoldError(`${label} is not a real directory`, unsafeCode);
  let entries;
  try { entries = fs.readdirSync(directoryPath).sort(); } catch {
    throw new HoldError(`${label} is unreadable`, unsafeCode);
  }
  if (entries.length > 0) throw new HoldError(`${label} is not empty: ${entries.join(', ')}`, 'CONCURRENT_UPGRADE');
  return { status: 'PASS', path: directoryPath, entries, absent: false };
}

function inspectLocks(zylosDir) {
  return inspectEmptyDirectory(path.join(zylosDir, '.zylos', 'locks'), 'upgrade locks directory', 'LOCKS_UNSAFE');
}

function inspectUpgradeTransactions(zylosDir) {
  return inspectEmptyDirectory(
    path.join(zylosDir, '.zylos', 'upgrade-metadata-transactions'),
    'upgrade metadata transactions directory',
    'TRANSACTIONS_UNSAFE',
  );
}

function isWithin(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function readLinuxProcess(pid) {
  if (process.platform !== 'linux') return null;
  try {
    const argv = fs.readFileSync(`/proc/${pid}/cmdline`).toString('utf8').split('\0').filter(Boolean);
    const cwd = fs.realpathSync.native(`/proc/${pid}/cwd`);
    const environment = fs.readFileSync(`/proc/${pid}/environ`).toString('utf8').split('\0').filter(Boolean);
    const zylosEntry = environment.find((entry) => entry.startsWith('ZYLOS_DIR='));
    const zylosDir = zylosEntry ? zylosEntry.slice('ZYLOS_DIR='.length) : null;
    return { argv, cwd, zylosDir };
  } catch (error) {
    if (error?.code === 'ENOENT') return { vanished: true };
    throw new HoldError(`process ${pid} could not be inspected safely`, 'PROCESS_SCAN_UNAVAILABLE');
  }
}

function classifyProcess(argv, cwd, processZylosDir, zylosDir) {
  if (!Array.isArray(argv) || argv.length === 0) return null;
  const basenames = argv.map((value) => path.basename(value));
  const cwdBound = typeof cwd === 'string' && isWithin(zylosDir, cwd);
  const explicitDirIndex = argv.indexOf('--zylos-dir');
  const explicitDir = explicitDirIndex >= 0 ? argv[explicitDirIndex + 1] : null;
  const explicitBound = typeof explicitDir === 'string' && path.resolve(explicitDir) === path.resolve(zylosDir);
  const environmentBound = typeof processZylosDir === 'string' && path.resolve(processZylosDir) === path.resolve(zylosDir);
  const pathBound = argv.some((value) => path.isAbsolute(value) && isWithin(zylosDir, value));
  const targetBound = cwdBound || explicitBound || environmentBound || pathBound;
  if (!targetBound) return null;

  if (basenames.some((name) => /^(?:upgrade-fork-pair|restore-hxa-connect|restore-ss-upgrade-blockers)\.(?:js|sh)$/.test(name))) {
    return 'zylos-upgrader';
  }
  const hxaIndex = basenames.findIndex((name) => name === 'upgrade-hxa-connect.js');
  if (hxaIndex >= 0 && argv.slice(hxaIndex + 1).includes('--execute')) return 'hxa-upgrader';
  const cliIndex = basenames.findIndex((name) => name === 'zylos' || name === 'zylos.js');
  if (cliIndex >= 0 && argv.slice(cliIndex + 1).some((value) => value === 'upgrade')) return 'zylos-upgrade';

  const managerIndex = basenames.findIndex((name) => /^(?:npm|npm-cli\.js|pnpm|pnpm\.cjs|yarn|yarn\.js|bun)$/.test(name));
  if (managerIndex >= 0) {
    const verbs = new Set(['install', 'ci', 'add', 'update', 'remove', 'uninstall', 'link', 'rebuild', 'dedupe']);
    if (argv.slice(managerIndex + 1).some((value) => verbs.has(value))) return 'package-install';
  }
  return null;
}

function inspectUpgradeProcesses(tools, zylosDir) {
  const result = requireSuccess(run(tools.ps, ['-eo', 'pid=,args=']), 'upgrade process inspection failed', 'PROCESS_SCAN_UNAVAILABLE');
  const matches = [];
  for (const line of result.stdout.split(/\r?\n/)) {
    const match = line.trim().match(/^(\d+)\s+(.+)$/);
    if (!match) continue;
    const pid = Number(match[1]);
    if (pid === process.pid || pid === process.ppid) continue;
    const command = match[2];
    if (!/(?:upgrade-fork-pair|restore-hxa-connect|restore-ss-upgrade-blockers|upgrade-hxa-connect|(?:^|[\s/])zylos(?:\.js)?(?:\s+--?[^\s]+)*\s+upgrade|(?:^|[\s/])(?:npm|npm-cli\.js|pnpm|pnpm\.cjs|yarn|yarn\.js|bun)\s+)/.test(command)) {
      continue;
    }
    const linux = readLinuxProcess(pid);
    if (linux?.vanished) continue;
    let kind = linux ? classifyProcess(linux.argv, linux.cwd, linux.zylosDir, zylosDir) : null;
    if (!linux) {
      const targetMentioned = command.includes(zylosDir);
      if (targetMentioned && /\b(?:upgrade-fork-pair|restore-hxa-connect|restore-ss-upgrade-blockers)\.(?:js|sh)\b/.test(command)) kind = 'zylos-upgrader';
      else if (targetMentioned && /\bupgrade-hxa-connect\.js\b[^\n]*\s--execute\b/.test(command)) kind = 'hxa-upgrader';
      else if (targetMentioned && /\b(?:zylos|cli\/zylos\.js)\s+upgrade\b/.test(command)) kind = 'zylos-upgrade';
      else if (targetMentioned && /\b(?:npm|pnpm|yarn|bun)\s+(?:install|ci|add|update|remove|uninstall|link|rebuild|dedupe)\b/.test(command)) kind = 'package-install';
    }
    if (kind) matches.push({ pid, kind });
  }
  if (matches.length > 0) throw new HoldError(`concurrent upgrade/install process detected: ${matches.map((item) => `${item.kind}:${item.pid}`).join(', ')}`, 'CONCURRENT_UPGRADE');
  return { status: 'PASS', matches: [] };
}

function inspectPm2(skillDir, tools, childEnvAdditions = {}) {
  const result = requireSuccess(
    run(process.execPath, [tools.pm2, 'jlist'], { env: safeChildEnv(childEnvAdditions) }),
    'PM2 inspection failed',
    'PM2_UNVERIFIED',
  );
  const processes = parseJsonOutput(result.stdout, 'PM2 inspection');
  if (!Array.isArray(processes)) throw new HoldError('PM2 inspection did not return an array', 'PM2_UNVERIFIED');
  const matches = processes.filter((candidate) => candidate.name === 'zylos-hxa-connect');
  if (matches.length !== 1) throw new HoldError(`expected one zylos-hxa-connect PM2 process, found ${matches.length}`, 'PM2_UNVERIFIED');
  const [proc] = matches;
  const expectedExecPath = path.join(skillDir, 'src', 'bot.js');
  if (!proc || proc.pm2_env?.status !== 'online') {
    throw new HoldError('zylos-hxa-connect is not genuinely online in PM2', 'PM2_UNVERIFIED');
  }
  if (!Number.isInteger(proc.pid) || proc.pid <= 0) throw new HoldError('zylos-hxa-connect has no valid PM2 PID', 'PM2_UNVERIFIED');
  if (!Number.isInteger(proc.pm2_env?.unstable_restarts) || proc.pm2_env.unstable_restarts !== 0) {
    throw new HoldError('zylos-hxa-connect PM2 unstable restart count is missing or nonzero', 'PM2_UNVERIFIED');
  }
  try { process.kill(proc.pid, 0); } catch (error) {
    if (error?.code !== 'EPERM') throw new HoldError('zylos-hxa-connect PM2 PID is not alive', 'PM2_UNVERIFIED');
  }
  if (path.resolve(proc.pm2_env?.pm_exec_path || '') !== path.resolve(expectedExecPath)) {
    throw new HoldError('zylos-hxa-connect PM2 executable does not match the installed component', 'PM2_UNVERIFIED');
  }
  if (!isRegular(expectedExecPath)) throw new HoldError('installed HXA executable is missing', 'PM2_UNVERIFIED');
  return {
    status: 'PASS',
    service: proc.name,
    pid: proc.pid,
    execPath: expectedExecPath,
    restartTime: proc.pm2_env?.restart_time ?? null,
    unstableRestarts: proc.pm2_env?.unstable_restarts ?? null,
  };
}

function inspectDisk(zylosDir) {
  let stat;
  try {
    stat = fs.statfsSync(zylosDir, { bigint: true });
  } catch {
    throw new HoldError('filesystem capacity inspection failed', 'DISK_UNVERIFIED');
  }
  const availableBytesBig = stat.bavail * stat.bsize;
  const availableKiBBig = availableBytesBig / 1024n;
  if (availableKiBBig > BigInt(Number.MAX_SAFE_INTEGER) || stat.ffree > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new HoldError('filesystem capacity exceeds the supported numeric range', 'DISK_UNVERIFIED');
  }
  const availableKiB = Number(availableKiBBig);
  const availableInodes = Number(stat.ffree);
  if (availableKiB < MIN_AVAILABLE_KB) {
    throw new HoldError(`available disk ${availableKiB} KiB is below required ${MIN_AVAILABLE_KB} KiB`, 'DISK_LOW');
  }
  return { status: 'PASS', availableKiB, availableInodes, minimumKiB: MIN_AVAILABLE_KB };
}

function inspectRuntimeCapacity(zylosDir) {
  const disk = inspectDisk(zylosDir);
  if (!Number.isSafeInteger(disk.availableInodes) || disk.availableInodes < MIN_RUNTIME_FREE_INODES) {
    throw new HoldError(
      `available inodes ${disk.availableInodes} are below the runtime floor ${MIN_RUNTIME_FREE_INODES}`,
      'INODES_LOW',
    );
  }
  return { ...disk, minimumInodes: MIN_RUNTIME_FREE_INODES };
}

function inspectStagingCapacity(zylosDir, remaining = null) {
  const disk = inspectRuntimeCapacity(zylosDir);
  const archiveBytes = remaining?.archiveBytes ?? MAX_ARCHIVE_BYTES;
  const extractedBytes = remaining?.extractedBytes ?? MAX_EXTRACTED_BYTES;
  const entryCount = remaining?.entryCount ?? MAX_ARCHIVE_ENTRIES;
  const entryReserveBytes = entryCount * 4096;
  const fixedReserveBytes = 32 * 1024 * 1024;
  const requiredBytes = (MIN_AVAILABLE_KB * 1024)
    + archiveBytes
    + extractedBytes
    + entryReserveBytes
    + fixedReserveBytes;
  const requiredKiB = Math.ceil(requiredBytes / 1024);
  if (disk.availableKiB < requiredKiB) {
    throw new HoldError(
      `available disk ${disk.availableKiB} KiB cannot preserve the ${MIN_AVAILABLE_KB} KiB floor during worst-case staging; required ${requiredKiB} KiB`,
      'STAGING_DISK_LOW',
    );
  }
  const requiredInodes = MIN_RUNTIME_FREE_INODES + entryCount + 128;
  if (!Number.isSafeInteger(disk.availableInodes) || disk.availableInodes < requiredInodes) {
    throw new HoldError(
      `available inodes ${disk.availableInodes} are below required ${requiredInodes}`,
      'STAGING_INODES_LOW',
    );
  }
  return {
    status: 'PASS',
    availableKiB: disk.availableKiB,
    requiredKiB,
    availableInodes: disk.availableInodes,
    requiredInodes,
    archiveReserveBytes: archiveBytes,
    extractedReserveBytes: extractedBytes,
    entryReserveBytes,
    fixedReserveBytes,
  };
}

function validateArchiveListing(archivePath, tools) {
  const names = requireSuccess(run(tools.tar, ['tzf', archivePath]), 'HXA archive listing failed', 'SOURCE_UNVERIFIED')
    .stdout.split(/\r?\n/).filter(Boolean);
  if (names.length === 0) throw new HoldError('HXA archive is empty', 'SOURCE_INVALID');
  if (names.length > MAX_ARCHIVE_ENTRIES) throw new HoldError('HXA archive contains too many entries', 'SOURCE_TOO_LARGE');
  const normalizedNames = new Set();
  for (const name of names) {
    const normalized = name.replace(/\\/g, '/');
    if (normalized.startsWith('/') || normalized.split('/').includes('..')) {
      throw new HoldError('HXA archive contains an unsafe path', 'SOURCE_INVALID');
    }
    const identity = normalized.replace(/\/$/, '');
    if (normalizedNames.has(identity)) throw new HoldError('HXA archive contains a duplicate path', 'SOURCE_INVALID');
    normalizedNames.add(identity);
  }
  const verbose = requireSuccess(run(tools.tar, ['tvzf', archivePath]), 'HXA archive type listing failed', 'SOURCE_UNVERIFIED')
    .stdout.split(/\r?\n/).filter(Boolean);
  if (verbose.some((line) => !['-', 'd'].includes(line.trimStart()[0]))) {
    throw new HoldError('HXA archive contains a link or special entry', 'SOURCE_INVALID');
  }
  let estimatedExtractedBytes = 0;
  for (const line of verbose.filter((candidate) => candidate.trimStart().startsWith('-'))) {
    const fields = line.trim().split(/\s+/);
    const sizeField = fields[1]?.includes('/') ? fields[2] : fields[4];
    const size = Number(sizeField);
    if (!Number.isSafeInteger(size) || size < 0) {
      throw new HoldError('HXA archive entry size could not be verified', 'SOURCE_UNVERIFIED');
    }
    estimatedExtractedBytes += size;
    if (estimatedExtractedBytes > MAX_EXTRACTED_BYTES) {
      throw new HoldError('HXA archive exceeds the extracted size limit', 'SOURCE_TOO_LARGE');
    }
  }
  return { estimatedExtractedBytes, entryCount: names.length };
}

function directoryBytes(root) {
  let total = 0;
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const candidate = path.join(current, entry.name);
      const stat = fs.lstatSync(candidate);
      if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) {
        throw new HoldError('staged HXA source contains a link or special entry', 'SOURCE_INVALID');
      }
      if (stat.isDirectory()) pending.push(candidate);
      else {
        total += stat.size;
        if (total > MAX_EXTRACTED_BYTES) throw new HoldError('staged HXA source exceeds the size limit', 'SOURCE_TOO_LARGE');
      }
    }
  }
  return total;
}

function cleanupStaging(stageDir) {
  if (!stageDir) return { status: 'PASS', removed: false };
  try {
    fs.rmSync(stageDir, { recursive: true, force: true });
    return { status: 'PASS', removed: true };
  } catch {
    return { status: 'HOLD', removed: false, path: stageDir, code: 'STAGING_CLEANUP_FAILED' };
  }
}

function stageArchive(reportRoot, repo, sha, zylosDir, tools, childEnvAdditions = {}) {
  const stageDir = fs.mkdtempSync(path.join(reportRoot, '.staging-'));
  const archivePath = path.join(stageDir, 'hxa-connect.tar.gz');
  const archiveUrl = `https://github.com/${repo}/archive/${sha}.tar.gz`;
  try {
    requireSuccess(run(tools.curl, [
      '-fsSL', '--retry', '2', '--retry-all-errors', '--max-filesize', String(MAX_ARCHIVE_BYTES), archiveUrl, '-o', archivePath,
    ], { timeout: 120_000, env: safeChildEnv(childEnvAdditions) }), 'HXA archive download failed', 'SOURCE_UNVERIFIED');
    const archiveBytes = fs.statSync(archivePath).size;
    if (archiveBytes <= 0 || archiveBytes > MAX_ARCHIVE_BYTES) {
      throw new HoldError('HXA archive is empty or exceeds the size limit', 'SOURCE_TOO_LARGE');
    }
    const { estimatedExtractedBytes, entryCount } = validateArchiveListing(archivePath, tools);
    const extractionCapacity = inspectStagingCapacity(zylosDir, {
      archiveBytes: 0,
      extractedBytes: estimatedExtractedBytes,
      entryCount,
    });
    const extractionProcessCheck = inspectUpgradeProcesses(tools, zylosDir);
    const sourceDir = path.join(stageDir, 'source');
    fs.mkdirSync(sourceDir, { mode: 0o700 });
    requireSuccess(run(tools.tar, ['xzf', archivePath, '-C', sourceDir, '--strip-components=1'], { timeout: 120_000 }), 'HXA archive extraction failed', 'SOURCE_UNVERIFIED');
    const extractedBytes = directoryBytes(sourceDir);
    return {
      stageDir,
      sourceDir,
      archiveUrl,
      archiveBytes,
      estimatedExtractedBytes,
      entryCount,
      extractionCapacity,
      extractionProcessCheck,
      extractedBytes,
    };
  } catch (error) {
    const cleanup = cleanupStaging(stageDir);
    if (cleanup.status !== 'PASS') {
      throw new HoldError(
        `staging cleanup failed after ${error.code || 'preflight error'}; residue retained at ${stageDir}`,
        'STAGING_CLEANUP_FAILED',
      );
    }
    throw error;
  }
}

function validateCandidate(sourceDir, { repo, sha, version }) {
  const pkg = readPackage(sourceDir, 'candidate HXA');
  if (pkg.version !== version) {
    throw new HoldError(`candidate HXA version must be ${version}, found ${pkg.version}`, 'PACKAGE_VERSION_MISMATCH');
  }
  const skill = parseSkillMetadata(sourceDir);
  if (!skill.name || skill.name.replace(/^zylos-/, '') !== COMPONENT) {
    throw new HoldError(`candidate HXA skill name does not identify ${COMPONENT}`, 'PACKAGE_INVALID');
  }
  if (!skill.version || skill.version !== version) {
    throw new HoldError(`candidate HXA SKILL.md version must be ${version}, found ${skill.version}`, 'PACKAGE_VERSION_MISMATCH');
  }
  if (!isRegular(path.join(sourceDir, 'src', 'bot.js'))) {
    throw new HoldError('candidate HXA executable src/bot.js is missing', 'SOURCE_INVALID');
  }
  const declaredRepo = normalizeRepository(
    typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url,
  );
  if (declaredRepo && declaredRepo !== repo) {
    throw new HoldError(`candidate repository metadata must be ${repo}, found ${declaredRepo}`, 'SOURCE_REPO_MISMATCH');
  }
  const markerPath = path.join(sourceDir, '.zylos-source.json');
  if (fs.existsSync(markerPath)) {
    const marker = readSourceMarker(markerPath, 'candidate source marker');
    if (
      marker?.repo !== repo
      || (marker.sha || marker.ref) !== sha
      || marker.version !== version
      || (marker.refType !== undefined && marker.refType !== 'commit')
    ) throw new HoldError('candidate source marker does not match the immutable target', 'SOURCE_REF_MISMATCH');
  }
  return {
    status: 'PASS',
    packageName: pkg.name,
    version: pkg.version,
    repo,
    sha,
    refType: 'commit',
  };
}

function summarizeCurrent(current) {
  return {
    packageVersion: current.packageVersion,
    skillVersion: current.skillVersion,
    registryVersion: current.entry.version || null,
    registryRepo: current.entry.repo || null,
    sourceMarker: current.sourceMarker,
  };
}

function baseSummary(args, executionId) {
  return {
    schema: 'zylos.hxa-upgrade-preflight/v1',
    mode: args.mode,
    status: 'RUNNING',
    result: null,
    releaseId: args.releaseId,
    executionId,
    target: {
      component: COMPONENT,
      repo: args.repo,
      sha: args.sha,
      version: args.version,
      agent: args.agent,
      profileId: args.profileId,
      hostname: args.hostname,
    },
    runtimeMutation: 'none',
    reportRoot: args.reportRoot,
    checks: {},
    current: null,
    startedAt: new Date().toISOString(),
  };
}

export function runHxaUpgrade(argv = process.argv.slice(2), runtime = {}) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ schema: 'zylos.hxa-upgrade-preflight/v1', status: 'HOLD', result: 'HOLD', code: error.code || 'INVALID_ARGS', error: error.message, runtimeMutation: 'none' }, null, 2)}\n`);
    return 1;
  }

  const executionId = crypto.randomUUID();
  let summary = baseSummary(args, executionId);
  let summaryPath = null;
  let stageDir = null;
  try {
    if (args.mode === 'execute') {
      throw new HoldError('execute mode is not implemented by this preflight wrapper', 'EXECUTE_UNSUPPORTED');
    }

    const zylosDir = resolveZylosDir();
    ensureReportRoot(args.reportRoot, zylosDir);
    summaryPath = path.join(args.reportRoot, 'summary.json');
    atomicWriteJson(summaryPath, summary);
    const tools = resolveTools(runtime.tools || null);
    const current = validateCurrentTarget(zylosDir, args.agent);
    summary.current = summarizeCurrent(current);
    summary.checks.identity = { status: 'RUNNING' };
    const identity = inspectIdentity(zylosDir, args.reportRoot, args, runtime.childEnvAdditions || {});
    summary.checks.identity = { status: 'PASS', ...identity };

    summary.checks.locks = inspectLocks(zylosDir);
    summary.checks.transactions = inspectUpgradeTransactions(zylosDir);
    summary.checks.processes = inspectUpgradeProcesses(tools, zylosDir);
    summary.checks.pm2 = inspectPm2(current.skillDir, tools, runtime.childEnvAdditions || {});
    summary.checks.disk = inspectRuntimeCapacity(zylosDir);
    summary.checks.stagingCapacity = inspectStagingCapacity(zylosDir);

    const staged = stageArchive(args.reportRoot, args.repo, args.sha, zylosDir, tools, runtime.childEnvAdditions || {});
    stageDir = staged.stageDir;
    summary.checks.source = {
      ...validateCandidate(staged.sourceDir, args),
      archiveUrl: staged.archiveUrl,
      archiveBytes: staged.archiveBytes,
      estimatedExtractedBytes: staged.estimatedExtractedBytes,
      entryCount: staged.entryCount,
      extractionCapacity: staged.extractionCapacity,
      extractionProcessCheck: staged.extractionProcessCheck,
      extractedBytes: staged.extractedBytes,
      marker: fs.existsSync(path.join(staged.sourceDir, '.zylos-source.json')) ? 'MATCHED' : 'ABSENT',
    };
    summary.checks.package = {
      status: 'PASS',
      name: summary.checks.source.packageName,
      version: summary.checks.source.version,
    };
    summary.checks.diskAfterStaging = inspectRuntimeCapacity(zylosDir);
    summary.checks.runtime = {
      status: 'PASS',
      install: false,
      backup: false,
      stop: false,
      hooks: false,
      pm2Mutation: false,
      registryWrite: false,
      configWrite: false,
      sourceMarkerWrite: false,
    };
    summary.checks.cleanup = cleanupStaging(stageDir);
    stageDir = null;
    if (summary.checks.cleanup.status !== 'PASS') {
      throw new HoldError(
        `staging cleanup failed; residue retained at ${summary.checks.cleanup.path}`,
        'STAGING_CLEANUP_FAILED',
      );
    }
    summary.status = 'PASS';
    summary.result = 'PRECHECK_ONLY';
    summary.finishedAt = new Date().toISOString();
    atomicWriteJson(summaryPath, summary);
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    return 0;
  } catch (error) {
    if (stageDir) {
      const cleanup = cleanupStaging(stageDir);
      summary.checks.cleanup = cleanup;
      stageDir = null;
      if (cleanup.status !== 'PASS') {
        error = new HoldError(
          `staging cleanup failed after ${error.code || 'preflight error'}; residue retained at ${cleanup.path}`,
          'STAGING_CLEANUP_FAILED',
        );
      }
    }
    summary.status = 'HOLD';
    summary.result = 'HOLD';
    summary.code = error.code || 'PREFLIGHT_FAILED';
    summary.error = error.message;
    summary.finishedAt = new Date().toISOString();
    if (summaryPath) {
      try { atomicWriteJson(summaryPath, summary); } catch {}
    }
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    return 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  process.exitCode = runHxaUpgrade();
}
