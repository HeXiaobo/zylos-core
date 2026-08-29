#!/usr/bin/env node

/**
 * Release-bound HXA component preflight.
 *
 * The dry-run path is intentionally independent from the generic component
 * upgrade command. It accepts only an immutable repository/SHA and an
 * explicit release/agent/report binding, then inspects the target and a
 * staged archive without acquiring a runtime lock or touching the installed
 * component. Execute uses Core's existing component transaction module after
 * the same release-bound checks have passed. This wrapper owns the immutable
 * binding, target identity, component lock, and private evidence report; it
 * does not implement a second generic upgrade path.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import { acquireLock, releaseLock } from '../cli/lib/lock.js';
import { runUpgrade } from '../cli/lib/upgrade.js';

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
    if (!stat.isFile() || (stat.mode & 0o111) === 0) return null;
    const currentUid = typeof process.getuid === 'function' ? process.getuid() : null;
    if ((stat.mode & 0o022) !== 0) return null;
    if (system && stat.uid !== 0) return null;
    if (!system && currentUid !== null && ![0, currentUid].includes(stat.uid)) return null;
    let ancestor = path.dirname(resolved);
    while (true) {
      const ancestorStat = fs.statSync(ancestor);
      if ((ancestorStat.mode & 0o022) !== 0) return null;
      if (system && ancestorStat.uid !== 0) return null;
      if (!system && currentUid !== null && ![0, currentUid].includes(ancestorStat.uid)) return null;
      const next = path.dirname(ancestor);
      if (next === ancestor) break;
      ancestor = next;
    }
    return resolved;
  } catch {
    return null;
  }
}

function validateInjectedToolCandidate(candidate) {
  try {
    const resolved = fs.realpathSync.native(candidate);
    const stat = fs.statSync(resolved);
    return stat.isFile() && (stat.mode & 0o111) !== 0 ? resolved : null;
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

function resolvePathTool(name) {
  const pathEntries = String(process.env.PATH || '').split(path.delimiter).filter(Boolean);
  return resolveTrustedTool(
    name,
    pathEntries.map((entry) => path.join(entry, name)),
  );
}

function resolveTools(injected = null) {
  if (injected) {
    const explicitlyTrusted = injected.trusted === true;
    const commands = Object.entries(injected).filter(([name]) => name !== 'trusted');
    const canonical = {};
    for (const [name, command] of commands) {
      if (typeof command !== 'string' || !path.isAbsolute(command)) {
        throw new HoldError(`injected ${name} tool must be absolute`, 'TOOL_UNVERIFIED');
      }
      const resolved = explicitlyTrusted
        ? validateInjectedToolCandidate(command)
        : validateToolCandidate(command);
      if (!resolved) throw new HoldError(`injected ${name} tool is not a regular executable`, 'TOOL_UNVERIFIED');
      canonical[name] = resolved;
    }
    return {
      ...canonical,
      // Dry-run and pre-transaction lock gates do not need npm. Resolve an
      // omitted injected npm lazily immediately before execute so a child
      // runtime's PATH cannot mask an earlier, more useful gate result.
      npm: injected.npm ? canonical.npm : null,
      // Runtime injection is an explicit test/platform seam. Production CLI
      // execution never reaches this branch; generic calls may therefore
      // trust the canonicalized test executables without weakening default
      // PATH resolution.
      trusted: explicitlyTrusted,
    };
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
    npm: resolvePathTool('npm'),
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

function persistTerminalSummary(summaryPath, summary) {
  if (!summaryPath) return { summary, persisted: false, path: null, attempted: false };
  try {
    atomicWriteJson(summaryPath, summary);
    return { summary, persisted: true, path: summaryPath, attempted: true };
  } catch {
    // Fall through to an adjacent terminal record. The caller must still
    // report a non-zero result even when this fallback is successful.
  }

  const fallbackPath = path.join(path.dirname(summaryPath), `terminal-summary-${summary.executionId}.json`);
  const fallbackSummary = {
    ...summary,
    code: 'SUMMARY_WRITE_FAILED',
    checks: {
      ...summary.checks,
      terminalSummary: {
        status: 'FALLBACK',
        primary: 'FAILED',
        path: path.basename(fallbackPath),
      },
    },
  };
  if (fallbackPath) {
    try {
      atomicWriteJson(fallbackPath, fallbackSummary);
      return { summary: fallbackSummary, persisted: true, path: fallbackPath, attempted: true };
    } catch {
      // No filesystem evidence could be persisted. Return the safe terminal
      // object for stdout/stderr rather than leaving a RUNNING-looking state.
    }
  }
  return {
    summary: {
      ...fallbackSummary,
      checks: {
        ...fallbackSummary.checks,
        terminalSummary: {
          ...fallbackSummary.checks.terminalSummary,
          status: 'FAILED',
          primary: 'FAILED',
          path: null,
        },
      },
    },
    persisted: false,
    path: null,
    attempted: true,
  };
}

function parseArgs(argv) {
  const values = new Map([
    ['--repo', 'repo'],
    ['--sha', 'sha'],
    ['--version', 'version'],
    ['--agent', 'agent'],
    ['--org', 'org'],
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
  if (result.org !== undefined && !SAFE_NAME.test(result.org)) {
    throw new HoldError('--org must identify one configured HXA org label', 'INVALID_ARGS');
  }
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
  const frontmatterText = content.match(/^---\n([\s\S]*?)\n---/m)?.[1] || '';
  let frontmatter = {};
  try {
    frontmatter = yaml.load(frontmatterText, { schema: yaml.JSON_SCHEMA }) || {};
  } catch (error) {
    throw new HoldError(`HXA SKILL.md frontmatter is invalid: ${error.message}`, 'TARGET_INVALID');
  }
  return {
    name: typeof frontmatter.name === 'string' ? frontmatter.name.trim() : null,
    version: typeof frontmatter.version === 'string' ? frontmatter.version.trim() : null,
    frontmatter,
  };
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
import { pathToFileURL } from 'node:url';

const [skillDir, configPath, orgLabel] = process.argv.slice(1);
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
const orgConfig = config.orgs?.[orgLabel];
if (!orgConfig) throw new Error('configured HXA org is missing');
const envModule = await import(pathToFileURL(path.join(skillDir, 'src', 'env.js')));
await envModule.setupFetchProxy();
const { HxaConnectClient } = await import('@coco-xyz/hxa-connect-sdk');
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
  ], {
    timeout: 30_000,
    cwd: skillDir,
    env: safeChildEnv(childEnvAdditions),
  }), 'read-only HXA Hub profile probe failed', 'IDENTITY_UNVERIFIED');
  const prefix = '__ZYLOS_READ_ONLY_PROFILE__';
  const line = result.stdout.split(/\r?\n/).find((candidate) => candidate.startsWith(prefix));
  if (!line) throw new HoldError('read-only HXA Hub profile probe returned no profile', 'IDENTITY_UNVERIFIED');
  return parseJsonOutput(line.slice(prefix.length), 'read-only HXA Hub profile probe');
}

function inspectIdentity(
  zylosDir,
  reportRoot,
  {
    agent: expectedAgent,
    org: expectedOrgLabel,
    profileId: expectedProfileId,
    hostname: expectedHostname,
  },
  childEnvAdditions = {},
  receiptName = 'identity-receipt.json',
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
  if (!expectedOrgLabel && enabled.length > 1) {
    throw new HoldError(
      'HXA config has multiple enabled org identities; --org is required',
      'IDENTITY_UNVERIFIED',
    );
  }
  const selected = expectedOrgLabel
    ? enabled.find(([label]) => label === expectedOrgLabel)
    : enabled[0];
  if (!selected) throw new HoldError('HXA config has no enabled org identity', 'IDENTITY_UNVERIFIED');
  const [orgLabel, org] = selected;
  const configuredOrgId = typeof org.org_id === 'string' ? org.org_id.trim() : null;
  const configuredAgent = typeof org.agent_name === 'string' ? org.agent_name.trim() : null;
  const configuredProfileId = typeof org.agent_id === 'string' ? org.agent_id.trim() : null;
  if (!configuredOrgId) {
    throw new HoldError('HXA config did not return an org ID', 'IDENTITY_UNVERIFIED');
  }
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
  const orgId = remote?.org_id || remote?.orgId || null;
  if (
    actualAgent !== expectedAgent
    || profileId !== expectedProfileId
    || orgId !== configuredOrgId
  ) {
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
    orgId,
    source: 'HxaConnectClient.getProfile',
  };
  const receiptBytes = `${JSON.stringify(receipt, null, 2)}\n`;
  if (!SAFE_NAME.test(path.basename(receiptName)) || path.dirname(receiptName) !== '.') {
    throw new HoldError('identity receipt name is invalid', 'REPORT_FAILED');
  }
  const receiptPath = path.join(reportRoot, receiptName);
  fs.writeFileSync(receiptPath, receiptBytes, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  return {
    name: actualAgent,
    profileId,
    hostname,
    orgLabel,
    orgId,
    observedAt,
    receiptPath,
    receiptSha256: crypto.createHash('sha256').update(receiptBytes).digest('hex'),
    evidence: 'read-only config validation, fresh HXA Hub getProfile, os.hostname, and private sanitized receipt',
  };
}

function inspectEmptyDirectory(directoryPath, label, unsafeCode, { ignoreEntries = [] } = {}) {
  let stat;
  try {
    stat = fs.lstatSync(directoryPath);
  } catch (error) {
    if (error?.code === 'ENOENT') return { status: 'PASS', path: directoryPath, entries: [], ignoredEntries: [], absent: true };
    throw new HoldError(`${label} is unreadable`, unsafeCode);
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new HoldError(`${label} is not a real directory`, unsafeCode);
  let entries;
  try { entries = fs.readdirSync(directoryPath).sort(); } catch {
    throw new HoldError(`${label} is unreadable`, unsafeCode);
  }
  const ignored = new Set(ignoreEntries);
  const visibleEntries = entries.filter((entry) => !ignored.has(entry));
  if (visibleEntries.length > 0) {
    throw new HoldError(`${label} is not empty: ${visibleEntries.join(', ')}`, 'CONCURRENT_UPGRADE');
  }
  return {
    status: 'PASS',
    path: directoryPath,
    entries: visibleEntries,
    ignoredEntries: entries.filter((entry) => ignored.has(entry)),
    absent: false,
  };
}

function inspectLocks(zylosDir, options = {}) {
  return inspectEmptyDirectory(
    path.join(zylosDir, '.zylos', 'locks'),
    'upgrade locks directory',
    'LOCKS_UNSAFE',
    options,
  );
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

// These are runtime-owned artifacts rather than release source. They are
// inspected for links/special files but excluded from source membership and
// digest comparison.
const EXACT_SOURCE_EXCLUDED_NAMES = new Set([
  'node_modules',
  '.backup',
  '.zylos-source.json',
  '.zylos',
  '.zylos-data',
  '.git',
]);

function hashRegularFile(filePath) {
  const hash = crypto.createHash('sha256');
  const descriptor = fs.openSync(filePath, 'r');
  const buffer = Buffer.allocUnsafe(64 * 1024);
  try {
    let offset = 0;
    while (true) {
      const bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, offset);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
      offset += bytesRead;
    }
  } finally {
    fs.closeSync(descriptor);
  }
  return hash.digest('hex');
}

function collectExactSourceTree(root, label) {
  let rootStat;
  try { rootStat = fs.lstatSync(root); } catch {
    throw new HoldError(`${label} is missing or unreadable`, 'EXACT_SOURCE_UNVERIFIED');
  }
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new HoldError(`${label} is not a real directory`, 'EXACT_SOURCE_UNVERIFIED');
  }
  const files = new Map();
  const walk = (directory, relativePrefix, atRoot = false) => {
    let entries;
    try { entries = fs.readdirSync(directory).sort(); } catch {
      throw new HoldError(`${label} cannot be read`, 'EXACT_SOURCE_UNVERIFIED');
    }
    for (const name of entries) {
      const candidate = path.join(directory, name);
      const relative = relativePrefix ? path.join(relativePrefix, name) : name;
      let stat;
      try { stat = fs.lstatSync(candidate); } catch {
        throw new HoldError(`${label} changed while it was being inspected`, 'EXACT_SOURCE_UNVERIFIED');
      }
      if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) {
        throw new HoldError(`${label} contains a link or special entry: ${relative}`, 'EXACT_SOURCE_UNVERIFIED');
      }
      if (atRoot && EXACT_SOURCE_EXCLUDED_NAMES.has(name)) continue;
      if (stat.isDirectory()) {
        walk(candidate, relative, false);
      } else {
        files.set(relative.replaceAll(path.sep, '/'), {
          bytes: stat.size,
          sha256: hashRegularFile(candidate),
        });
      }
    }
  };
  walk(root, '', true);
  return files;
}

function sourceTreeDigest(files) {
  const digest = crypto.createHash('sha256');
  for (const [relative, metadata] of [...files.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    digest.update(`${relative}\0${metadata.bytes}\0${metadata.sha256}\n`);
  }
  return digest.digest('hex');
}

function freezeExactSourceTree(root, label) {
  const files = collectExactSourceTree(root, label);
  return Object.freeze({
    files,
    sha256: sourceTreeDigest(files),
  });
}

function verifyExactSourceTree(installedDir, frozenCandidate) {
  const installed = collectExactSourceTree(installedDir, 'installed HXA source');
  const staged = frozenCandidate?.files instanceof Map
    ? frozenCandidate.files
    : collectExactSourceTree(frozenCandidate, 'staged HXA source');
  const missing = [];
  const extra = [];
  const mismatched = [];
  for (const relative of staged.keys()) {
    if (!installed.has(relative)) {
      missing.push(relative);
      continue;
    }
    const expected = staged.get(relative);
    const actual = installed.get(relative);
    if (expected.bytes !== actual.bytes || expected.sha256 !== actual.sha256) mismatched.push(relative);
  }
  for (const relative of installed.keys()) {
    if (!staged.has(relative)) extra.push(relative);
  }
  if (missing.length > 0 || extra.length > 0 || mismatched.length > 0) {
    const detail = [
      missing.length > 0 ? `missing=${missing.join(',')}` : null,
      extra.length > 0 ? `extra=${extra.join(',')}` : null,
      mismatched.length > 0 ? `mismatched=${mismatched.join(',')}` : null,
    ].filter(Boolean).join('; ');
    throw new HoldError(`installed HXA source is not an exact candidate: ${detail}`, 'EXACT_SOURCE_NOT_APPLIED');
  }
  return {
    status: 'PASS',
    mode: 'overwrite',
    comparedFiles: staged.size,
    candidateSha256: frozenCandidate?.sha256 || sourceTreeDigest(staged),
    missing: [],
    extra: [],
    mismatched: [],
    excludedNames: [...EXACT_SOURCE_EXCLUDED_NAMES].sort(),
  };
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

// HXA dec6 declares the standard lifecycle hooks. post-install is accepted as
// an install-time hook for source compatibility but is not run by this upgrade
// transaction; only pre/post-upgrade are executed by cli/lib/upgrade.js.
const ALLOWED_CANDIDATE_HOOKS = new Map([
  ['post-install', 'hooks/post-install.js'],
  ['pre-upgrade', 'hooks/pre-upgrade.js'],
  ['post-upgrade', 'hooks/post-upgrade.js'],
]);

function assertNoSymlinkPath(rootDir, candidatePath, label) {
  const relative = path.relative(path.resolve(rootDir), path.resolve(candidatePath));
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new HoldError(`${label} escapes component directory`, 'HOOK_INVALID');
  }
  let current = path.resolve(rootDir);
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    let stat;
    try { stat = fs.lstatSync(current); } catch {
      throw new HoldError(`${label} is missing`, 'HOOK_INVALID');
    }
    if (stat.isSymbolicLink()) throw new HoldError(`${label} traverses a symbolic link`, 'HOOK_INVALID');
  }
}

function validateCandidateHooks(sourceDir, skill) {
  const declared = skill?.frontmatter?.lifecycle?.hooks;
  if (declared === undefined || declared === null) {
    return { status: 'PASS', entries: [] };
  }
  if (!declared || typeof declared !== 'object' || Array.isArray(declared)) {
    throw new HoldError('candidate lifecycle hooks must be a mapping', 'HOOK_INVALID');
  }
  const entries = [];
  for (const [name, value] of Object.entries(declared)) {
    const expectedPath = ALLOWED_CANDIDATE_HOOKS.get(name);
    if (!expectedPath || value !== expectedPath) {
      throw new HoldError(`candidate lifecycle hook ${name} is not an approved exact hook`, 'HOOK_UNSUPPORTED');
    }
    const hookPath = path.resolve(sourceDir, value);
    assertNoSymlinkPath(sourceDir, hookPath, `${name} hook`);
    if (!isRegular(hookPath)) {
      throw new HoldError(`${name} hook is not a regular non-symlink file`, 'HOOK_INVALID');
    }
    entries.push({ name, path: value, phase: name === 'post-install' ? 'install-only' : 'upgrade' });
  }
  return { status: 'PASS', entries };
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
  const hooks = validateCandidateHooks(sourceDir, skill);
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
    hooks,
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

function verifyPostUpgrade(zylosDir, args, tools, childEnvAdditions = {}) {
  const current = validateCurrentTarget(zylosDir, args.agent);
  if (current.packageVersion !== args.version || current.skillVersion !== args.version) {
    throw new HoldError(
      `installed HXA version mismatch after execute: expected ${args.version}, found ${current.packageVersion}`,
      'POSTCHECK_FAILED',
    );
  }
  const installedRepo = normalizeRepository(current.entry.repo);
  if (installedRepo !== args.repo) {
    throw new HoldError(
      `installed HXA repository mismatch after execute: expected ${args.repo}, found ${installedRepo || 'missing'}`,
      'POSTCHECK_FAILED',
    );
  }
  const marker = current.sourceMarker;
  if (
    !marker
    || marker.repo !== args.repo
    || marker.sha !== args.sha
    || marker.ref !== args.sha
    || marker.refType !== 'commit'
    || marker.version !== args.version
  ) {
    throw new HoldError('installed HXA source marker does not prove the immutable target', 'SOURCE_PROVENANCE_MISSING');
  }
  const pm2 = inspectPm2(current.skillDir, tools, childEnvAdditions);
  return {
    status: 'PASS',
    packageVersion: current.packageVersion,
    registryVersion: current.entry.version,
    registryRepo: installedRepo,
    source: marker,
    pm2,
  };
}

// The generic transaction commits the source marker and registry only in its
// final step.  Therefore the pre-commit runtime check must not require those
// two pieces of metadata to have the candidate version yet.  It verifies the
// files and PM2 process that the transaction has just installed, while the
// wrapper's verifyPostUpgrade() above performs the metadata/provenance check
// after runUpgrade returns successfully.
function verifyPostUpgradeRuntime(zylosDir, args, tools, childEnvAdditions = {}) {
  const componentsPath = path.join(zylosDir, '.zylos', 'components.json');
  validateOwnedRegularFile(componentsPath, 'installed components registry');
  const components = readJson(componentsPath, 'installed components registry');
  const entry = components?.[COMPONENT];
  if (!entry || typeof entry !== 'object') {
    throw new HoldError('hxa-connect is not registered after execute', 'POSTCHECK_FAILED');
  }

  const skillDir = skillDirFor(zylosDir);
  if (!isDirectory(skillDir)) {
    throw new HoldError('installed HXA skill directory is missing after execute', 'POSTCHECK_FAILED');
  }
  if (entry.skillDir && path.resolve(entry.skillDir) !== path.resolve(skillDir)) {
    throw new HoldError('registered HXA skillDir changed during execute', 'POSTCHECK_FAILED');
  }

  const pkg = readPackage(skillDir, 'installed HXA after execute');
  const skill = parseSkillMetadata(skillDir);
  if (skill.name && skill.name.replace(/^zylos-/, '') !== COMPONENT) {
    throw new HoldError('installed HXA skill name does not identify hxa-connect after execute', 'POSTCHECK_FAILED');
  }
  if (pkg.version !== args.version || skill.version !== args.version) {
    throw new HoldError(
      `installed HXA runtime version mismatch before metadata commit: expected ${args.version}, found ${pkg.version}`,
      'POSTCHECK_FAILED',
    );
  }
  if (!isRegular(path.join(skillDir, 'src', 'bot.js'))) {
    throw new HoldError('installed HXA executable is missing after execute', 'POSTCHECK_FAILED');
  }
  const pm2 = inspectPm2(skillDir, tools, childEnvAdditions);
  return {
    status: 'PASS',
    packageVersion: pkg.version,
    skillVersion: skill.version,
    pm2,
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
      ...(args.org ? { org: args.org } : {}),
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
  let lockHeld = false;
  let committedHold = false;
  const releaseOwnedLock = () => {
    if (!lockHeld) return { success: true, alreadyReleased: true };
    const result = releaseLock(COMPONENT);
    if (!result.success) {
      summary.checks.lockRelease = {
        status: 'HOLD',
        error: result.error || 'component lock release was not confirmed',
      };
      throw new HoldError('HXA component lock release was not confirmed', 'LOCK_RELEASE_FAILED');
    }
    lockHeld = false;
    summary.checks.lockRelease = { status: 'PASS' };
    return result;
  };
  try {
    const zylosDir = resolveZylosDir();
    ensureReportRoot(args.reportRoot, zylosDir);
    summaryPath = path.join(args.reportRoot, 'summary.json');
    atomicWriteJson(summaryPath, summary);
    const tools = resolveTools(runtime.tools || null);
    const childEnvAdditions = runtime.childEnvAdditions || {};

    // Acquire the component lock before reading identity or preparing any
    // mutation inputs.  A read-only lock-directory check protects against an
    // unsafe/symlinked directory; acquireLock then closes the component-level
    // race.  The owned lock is ignored by the second check below, while any
    // unrelated lock remains a hard concurrent-upgrade hold.
    if (args.mode === 'execute') {
      summary.checks.locks = inspectLocks(zylosDir);
      const lock = acquireLock(COMPONENT);
      if (!lock.success) {
        throw new HoldError(lock.error || 'HXA component is already being upgraded', 'CONCURRENT_UPGRADE');
      }
      lockHeld = true;
      summary.runtimeMutation = 'component-only';
      summary.checks.transaction = {
        status: 'RUNNING',
        executionId,
        lock: 'acquired',
        module: 'cli/lib/upgrade.js',
      };
      atomicWriteJson(summaryPath, summary);
    }

    let current = validateCurrentTarget(zylosDir, args.agent);
    summary.current = summarizeCurrent(current);
    if (args.mode === 'execute') {
      const installedFiles = collectExactSourceTree(current.skillDir, 'installed HXA source');
      summary.checks.installedSource = {
        status: 'PASS',
        comparedFiles: installedFiles.size,
        excludedNames: [...EXACT_SOURCE_EXCLUDED_NAMES].sort(),
      };
    }
    summary.checks.identity = { status: 'RUNNING' };
    const identity = inspectIdentity(zylosDir, args.reportRoot, args, childEnvAdditions);
    summary.checks.identity = { status: 'PASS', ...identity };

    summary.checks.locks = inspectLocks(
      zylosDir,
      args.mode === 'execute' ? { ignoreEntries: [`${COMPONENT}.lock`] } : {},
    );
    summary.checks.transactions = inspectUpgradeTransactions(zylosDir);
    summary.checks.processes = inspectUpgradeProcesses(tools, zylosDir);
    summary.checks.pm2 = inspectPm2(current.skillDir, tools, childEnvAdditions);
    summary.checks.disk = inspectRuntimeCapacity(zylosDir);
    summary.checks.stagingCapacity = inspectStagingCapacity(zylosDir);

    const staged = stageArchive(args.reportRoot, args.repo, args.sha, zylosDir, tools, childEnvAdditions);
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
    // Freeze the validated candidate before any lifecycle hook runs. A
    // pre-upgrade hook executes with the candidate as its cwd and must not be
    // able to redefine the bytes later used as provenance evidence.
    const frozenCandidate = freezeExactSourceTree(staged.sourceDir, 'validated HXA source snapshot');
    summary.checks.sourceSnapshot = {
      status: 'PASS',
      comparedFiles: frozenCandidate.files.size,
      sha256: frozenCandidate.sha256,
      excludedNames: [...EXACT_SOURCE_EXCLUDED_NAMES].sort(),
    };
    summary.checks.package = {
      status: 'PASS',
      name: summary.checks.source.packageName,
      version: summary.checks.source.version,
    };
    summary.checks.diskAfterStaging = inspectRuntimeCapacity(zylosDir);

    // Staging can take long enough for a target identity, lock, process, or
    // PM2 state to change.  Re-read every execute gate while we still hold the
    // lock and immediately before runUpgrade performs its durable backup.
    if (args.mode === 'execute') {
      const preExecuteCurrent = validateCurrentTarget(zylosDir, args.agent);
      const preExecuteIdentity = inspectIdentity(
        zylosDir,
        args.reportRoot,
        args,
        childEnvAdditions,
        'identity-receipt-pre-execute.json',
      );
      const preExecuteLocks = inspectLocks(zylosDir, { ignoreEntries: [`${COMPONENT}.lock`] });
      const preExecuteTransactions = inspectUpgradeTransactions(zylosDir);
      const preExecuteProcesses = inspectUpgradeProcesses(tools, zylosDir);
      const preExecutePm2 = inspectPm2(preExecuteCurrent.skillDir, tools, childEnvAdditions);
      const preExecuteDisk = inspectRuntimeCapacity(zylosDir);
      const preExecuteInstalledFiles = collectExactSourceTree(preExecuteCurrent.skillDir, 'installed HXA source');
      summary.current = summarizeCurrent(preExecuteCurrent);
      summary.checks.identity = { ...summary.checks.identity, preExecute: preExecuteIdentity };
      summary.checks.preExecute = {
        status: 'PASS',
        identity: preExecuteIdentity,
        locks: preExecuteLocks,
        transactions: preExecuteTransactions,
        processes: preExecuteProcesses,
        pm2: preExecutePm2,
        disk: preExecuteDisk,
        installedSource: {
          status: 'PASS',
          comparedFiles: preExecuteInstalledFiles.size,
          excludedNames: [...EXACT_SOURCE_EXCLUDED_NAMES].sort(),
        },
      };
      summary.checks.pm2 = preExecutePm2;
      current = preExecuteCurrent;
    }

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

    if (args.mode === 'dry-run') {
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
    }

    const source = {
      type: 'github-release',
      repo: args.repo,
      ref: args.sha,
      refType: 'commit',
      ...(current.entry.installedAt ? { installedAt: current.entry.installedAt } : {}),
    };
    let upgradeResult;
    try {
      const upgradeNpm = tools.npm || resolvePathTool('npm');
      upgradeResult = runUpgrade(COMPONENT, {
        tempDir: staged.sourceDir,
        newVersion: args.version,
        // HXA release execution is bound to an immutable source.  Merge mode
        // can preserve local candidate code, so use the generic module's
        // exact overwrite contract and reject any preservation evidence below.
        mode: 'overwrite',
        jsonOutput: true,
        source,
        registryEntry: current.entry,
        postUpgradeCheck: (transactionContext) => {
          const stopStep = transactionContext.steps.find((step) => step.name === 'stop_service');
          const startStep = transactionContext.steps.find((step) => step.name === 'start_service');
          if (stopStep?.status !== 'done' || startStep?.status !== 'done') {
            throw new Error('HXA transaction did not confirm both service stop and restart');
          }
          const preservedOrMerged = [
            ...(transactionContext.mergeKept || []),
            ...(transactionContext.mergePreserved || []),
            ...(transactionContext.mergedFiles || []),
            ...(transactionContext.mergeConflicts || []).map((item) => item.file || item),
          ];
          if (preservedOrMerged.length > 0) {
            throw new Error('HXA transaction preserved or merged local component files');
          }
          const exactSource = verifyExactSourceTree(
            transactionContext.skillDir,
            frozenCandidate,
          );
          const runtime = verifyPostUpgradeRuntime(
            zylosDir,
            args,
            tools,
            childEnvAdditions,
          );
          return { status: 'PASS', exactSource, runtime };
        },
        tools: {
          pm2: tools.pm2,
          npm: upgradeNpm,
          trusted: tools.trusted === true,
        },
      });
    } catch (error) {
      summary.checks.transaction = {
        status: 'HOLD',
        executionId,
        module: 'cli/lib/upgrade.js',
        error: error.message,
      };
      summary.checks.rollback = {
        status: 'NOT_RUN',
        reason: 'upgrade module did not return a terminal result',
      };
      throw new HoldError(`HXA component transaction failed: ${error.message}`, 'UPGRADE_FAILED');
    }

    summary.checks.transaction = {
      status: upgradeResult.success ? 'PASS' : 'HOLD',
      executionId,
      module: 'cli/lib/upgrade.js',
      result: upgradeResult,
    };
    if (upgradeResult.committedHold || upgradeResult.rollback?.status === 'COMMITTED_HOLD') {
      committedHold = true;
      summary.checks.rollback = {
        status: 'HOLD',
        performed: false,
        reason: 'authoritative baseline was committed; rollback is not safe',
        steps: upgradeResult.rollback?.steps || [],
      };
      throw new HoldError(
        `HXA component transaction committed but requires recovery: ${upgradeResult.error || 'unknown failure'}`,
        'COMMITTED_HOLD',
      );
    }
    if (!upgradeResult.success) {
      const rollbackSteps = upgradeResult.rollback?.steps || [];
      const rollbackComplete = upgradeResult.rollback?.performed === false
        || (rollbackSteps.length > 0 && rollbackSteps.every((step) => step.success === true));
      summary.checks.rollback = {
        status: rollbackComplete ? 'PASS' : 'HOLD',
        performed: Boolean(upgradeResult.rollback?.performed),
        steps: rollbackSteps,
      };
      throw new HoldError(
        `HXA component transaction failed: ${upgradeResult.error || 'unknown upgrade error'}`,
        'UPGRADE_FAILED',
      );
    }

    // The generic module has committed the baseline by this point. Any later
    // verification or cleanup failure is therefore a committed hold, never a
    // claim that the previous runtime was rolled back.
    committedHold = true;

    const mergeStep = upgradeResult.steps?.find((step) => step.name === 'smart_merge');
    const mergePreservation = [
      ...(upgradeResult.mergeKept || []),
      ...(upgradeResult.mergePreserved || []),
      ...(upgradeResult.mergedFiles || []),
      ...(upgradeResult.mergeConflicts || []).map((item) => item.file || item),
    ];
    if (mergePreservation.length > 0) {
      summary.checks.transaction = {
        ...summary.checks.transaction,
        status: 'HOLD',
        result: upgradeResult,
      };
      summary.checks.exactSource = {
        status: 'HOLD',
        mode: 'overwrite',
        preservedOrMerged: mergePreservation,
        step: mergeStep,
      };
      throw new HoldError(
        'HXA transaction preserved or merged local component files; exact source was not proven',
        'EXACT_SOURCE_NOT_APPLIED',
      );
    }
    summary.checks.exactSource = {
      ...(upgradeResult.postUpgradeCheck?.exactSource || {
        status: 'HOLD',
        mode: 'overwrite',
        error: 'pre-commit exact source check was not recorded',
      }),
      preservedOrMerged: [],
      step: mergeStep,
    };
    if (summary.checks.exactSource.status !== 'PASS') {
      throw new HoldError('HXA transaction did not record an exact source check', 'EXACT_SOURCE_NOT_APPLIED');
    }

    if (upgradeResult.metadataRecoveryPending) {
      summary.checks.metadataRecovery = {
        status: 'HOLD',
        required: true,
        reason: 'source metadata recovery is pending',
      };
      summary.checks.transaction = {
        ...summary.checks.transaction,
        status: 'HOLD',
      };
      committedHold = true;
      throw new HoldError(
        'HXA transaction left source metadata recovery pending',
        'METADATA_RECOVERY_PENDING',
      );
    }

    const stopStep = upgradeResult.steps?.find((step) => step.name === 'stop_service');
    const startStep = upgradeResult.steps?.find((step) => step.name === 'start_service');
    if (stopStep?.status !== 'done' || startStep?.status !== 'done') {
      summary.checks.runtime = {
        status: 'HOLD',
        stop: stopStep,
        start: startStep,
      };
      summary.checks.transaction = {
        ...summary.checks.transaction,
        status: 'HOLD',
      };
      throw new HoldError(
        'HXA transaction did not confirm both service stop and restart',
        'RUNTIME_TRANSITION_UNVERIFIED',
      );
    }

    const backupStep = upgradeResult.steps?.find((step) => step.name === 'backup');
    if (!upgradeResult.backupDir || backupStep?.status !== 'done' || !isDirectory(upgradeResult.backupDir)) {
      throw new HoldError('HXA transaction did not leave a verifiable component backup', 'BACKUP_UNVERIFIED');
    }
    summary.checks.backup = {
      status: 'PASS',
      path: upgradeResult.backupDir,
      step: backupStep,
    };

    summary.checks.postcheck = verifyPostUpgrade(
      zylosDir,
      args,
      tools,
      runtime.childEnvAdditions || {},
    );
    summary.checks.provenance = {
      status: 'PASS',
      source: summary.checks.postcheck.source,
      verifiedBy: 'installed package, registry, source marker, and PM2 postcheck',
    };
    const step = (name) => upgradeResult.steps?.find((candidate) => candidate.name === name);
    summary.checks.runtime = {
      status: 'PASS',
      install: step('npm_install')?.status === 'done',
      backup: backupStep.status === 'done',
      stop: step('stop_service')?.status === 'done',
      hooks: ['pre_upgrade_hook', 'post_upgrade_hook'].some((name) => step(name)?.status === 'done'),
      pm2Mutation: step('start_service')?.status === 'done',
      registryWrite: true,
      configWrite: ['pre_upgrade_hook', 'post_upgrade_hook'].some((name) => step(name)?.status === 'done'),
      sourceMarkerWrite: true,
    };

    summary.checks.cleanup = cleanupStaging(stageDir);
    stageDir = null;
    if (summary.checks.cleanup.status !== 'PASS') {
      throw new HoldError(
        `staging cleanup failed; residue retained at ${summary.checks.cleanup.path}`,
        'STAGING_CLEANUP_FAILED',
      );
    }
    releaseOwnedLock();
    summary.status = 'PASS';
    summary.result = 'EXECUTE_COMPLETE';
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
    if (lockHeld) {
      try {
        releaseOwnedLock();
      } catch (releaseError) {
        error = releaseError;
      }
    }
    if (args.mode === 'execute' && summary.checks.transaction?.status === 'RUNNING') {
      summary.checks.transaction = {
        ...summary.checks.transaction,
        status: 'HOLD',
        error: error.message,
      };
    }
    summary.status = 'HOLD';
    summary.result = committedHold ? 'COMMITTED_HOLD' : 'HOLD';
    summary.code = error.code || 'PREFLIGHT_FAILED';
    summary.error = error.message;
    summary.finishedAt = new Date().toISOString();
    const terminalSummary = persistTerminalSummary(summaryPath, summary);
    summary = terminalSummary.summary;
    if (terminalSummary.attempted && !terminalSummary.persisted) {
      process.stderr.write('HXA terminal summary persistence failed; terminal state is available only in this response\n');
    }
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    return 1;
  } finally {
    if (lockHeld) {
      try { releaseOwnedLock(); } catch {}
    }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  process.exitCode = runHxaUpgrade();
}
