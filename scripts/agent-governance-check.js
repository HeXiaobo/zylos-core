#!/usr/bin/env node

/**
 * Repository-level guardrails for Agent work and releases.
 *
 * The default mode is a read-only PR/feature-branch check. Release and deploy
 * modes are intentionally stricter: they require a clean checkout and an
 * external, READY manifest that pins the current commit by its full SHA.
 *
 * This file never writes a release manifest. Keeping the manifest outside the
 * repository prevents a commit from containing a hash of itself.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SCRIPT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FULL_SHA_RE = /^[0-9a-f]{40}$/i;
const VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const RELEASE_MANIFEST_V1 = 'zylos.release-manifest/v1';
const RELEASE_MANIFEST_V2 = 'zylos.release-manifest/v2';
const VERSION_KEYS = ['version', 'release', 'releaseVersion', 'packageVersion'];
const TASK_BRANCH_PREFIXES = [
  'codex', 'feat', 'feature', 'fix', 'chore', 'docs', 'refactor', 'test',
  'perf', 'ci', 'build', 'style', 'revert',
];
const VERSION_METADATA_FILENAMES = new Set(['package.json', 'package-lock.json', 'VERSION']);

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function asNonEmptyString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function normalizeRelativePath(value) {
  return String(value).split(path.sep).join('/').replace(/^\.\//, '');
}

function isPathInside(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function readText(filePath) {
  return fs.readFileSync(filePath, 'utf8');
}

function readJson(filePath, label, errors) {
  try {
    return JSON.parse(readText(filePath));
  } catch (error) {
    errors.push(`${label} is not valid JSON: ${error.message}`);
    return null;
  }
}

function walkFiles(root) {
  const files = [];
  const skip = new Set(['.git', 'node_modules']);

  function walk(directory) {
    let entries;
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (skip.has(entry.name)) continue;
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(fullPath);
      else if (entry.isFile()) files.push(fullPath);
    }
  }

  walk(root);
  return files.sort();
}

function nearestPackageVersion(root, filePath, packageCache = new Map()) {
  let directory = path.dirname(filePath);
  const resolvedRoot = path.resolve(root);
  while (isPathInside(resolvedRoot, directory)) {
    const packagePath = path.join(directory, 'package.json');
    if (!packageCache.has(packagePath)) {
      if (fs.existsSync(packagePath)) {
        try {
          packageCache.set(packagePath, JSON.parse(readText(packagePath)));
        } catch {
          packageCache.set(packagePath, null);
        }
      } else {
        packageCache.set(packagePath, null);
      }
    }
    const packageJson = packageCache.get(packagePath);
    if (isObject(packageJson) && asNonEmptyString(packageJson.version)) return String(packageJson.version).trim();
    if (directory === resolvedRoot) break;
    directory = path.dirname(directory);
  }
  return null;
}

function versionFields(value) {
  if (!isObject(value)) return {};
  const result = {};
  for (const key of VERSION_KEYS) {
    if (value[key] !== undefined && value[key] !== null) result[key] = String(value[key]).trim();
  }
  if (isObject(value.metadata)) {
    for (const key of VERSION_KEYS) {
      if (value.metadata[key] !== undefined && value.metadata[key] !== null) {
        result[`metadata.${key}`] = String(value.metadata[key]).trim();
      }
    }
  }
  return result;
}

function firstVersion(value) {
  const fields = versionFields(value);
  for (const key of VERSION_KEYS) {
    if (fields[key]) return fields[key];
  }
  for (const key of VERSION_KEYS) {
    if (fields[`metadata.${key}`]) return fields[`metadata.${key}`];
  }
  return null;
}

function parseYamlScalar(value) {
  const text = String(value || '').trim();
  if (!text) return {};
  if (text === 'true') return true;
  if (text === 'false') return false;
  if (text === 'null' || text === '~') return null;
  if (/^-?\d+(?:\.\d+)?$/.test(text)) return Number(text);
  if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) {
    return text.slice(1, -1);
  }
  if (text.startsWith('{') || text.startsWith('[')) {
    try {
      return JSON.parse(text);
    } catch {
      // The metadata fields we inspect are scalar. Preserve other YAML
      // values as text rather than making the gate depend on a parser package.
    }
  }
  return text.replace(/\s+#.*$/, '').trim();
}

/**
 * Parse the small subset of YAML needed from SKILL.md frontmatter without a
 * runtime dependency. Descriptions and other block values are retained as
 * opaque text; nested mappings (including capabilities) are supported.
 */
function parseSkillYaml(source) {
  const root = {};
  const stack = [{ indent: -1, value: root }];
  let block = null;
  const lines = String(source).split(/\r?\n/);

  for (const line of lines) {
    if (!line.trim() || /^\s*#/.test(line)) continue;
    if (/\t/.test(line)) throw new Error('tabs are not supported in YAML frontmatter');
    const indent = line.match(/^ */)[0].length;
    const trimmed = line.trim();

    if (block) {
      if (indent > block.indent) {
        block.lines.push(trimmed);
        continue;
      }
      block.value[block.key] = block.lines.join(' ');
      block = null;
    }

    if (trimmed.startsWith('- ')) {
      // Lists are not release metadata. Accept them as opaque content so a
      // valid SKILL with an unrelated list remains compatible with this gate.
      continue;
    }
    const match = trimmed.match(/^([^:#][^:]*?):(?:\s*(.*))?$/);
    if (!match) throw new Error(`invalid mapping line: ${trimmed}`);
    const key = match[1].trim();
    const rawValue = match[2] ?? '';
    while (stack.length > 1 && indent <= stack.at(-1).indent) stack.pop();
    const parent = stack.at(-1).value;
    if (!isObject(parent)) throw new Error(`invalid mapping parent for ${key}`);
    if (Object.prototype.hasOwnProperty.call(parent, key)) throw new Error(`duplicate key: ${key}`);
    if (rawValue === '|' || rawValue === '|-' || rawValue === '|+' || rawValue === '>' || rawValue === '>- ' || rawValue === '>-') {
      parent[key] = '';
      block = { indent, key, value: parent, lines: [] };
    } else if (rawValue === '') {
      parent[key] = {};
      stack.push({ indent, value: parent[key] });
    } else {
      parent[key] = parseYamlScalar(rawValue);
    }
  }
  if (block) block.value[block.key] = block.lines.join(' ');
  return root;
}

function parseSkillFrontmatter(content) {
  const match = String(content).match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) return { frontmatter: null, error: 'missing YAML frontmatter' };
  try {
    const frontmatter = parseSkillYaml(match[1]);
    if (frontmatter === null || frontmatter === undefined) return { frontmatter: {} };
    if (!isObject(frontmatter)) return { frontmatter: null, error: 'frontmatter must be a mapping' };
    return { frontmatter };
  } catch (error) {
    return { frontmatter: null, error: error.message };
  }
}

function packageFiles(root) {
  return walkFiles(root).filter((filePath) => path.basename(filePath) === 'package.json');
}

function packageLockFor(packagePath) {
  return path.join(path.dirname(packagePath), 'package-lock.json');
}

/**
 * Validate package, lockfile, capabilities and SKILL release metadata.
 * Capabilities and SKILL version fields are optional for legacy components;
 * whenever a component publishes one, it must agree with its package.
 */
export function validateReleaseMetadata({ root = SCRIPT_ROOT } = {}) {
  const repoRoot = path.resolve(root);
  const errors = [];
  const warnings = [];
  const checks = [];
  const packages = packageFiles(repoRoot);
  const packageCache = new Map();
  let rootPackage = null;
  let rootVersion = null;

  if (packages.length === 0) {
    errors.push('No package.json files found');
  }

  for (const packagePath of packages) {
    const relative = normalizeRelativePath(path.relative(repoRoot, packagePath));
    const packageJson = readJson(packagePath, relative, errors);
    packageCache.set(packagePath, packageJson);
    if (!packageJson) continue;
    if (path.resolve(packagePath) === path.join(repoRoot, 'package.json')) {
      rootPackage = packageJson;
      rootVersion = asNonEmptyString(packageJson.version);
      if (!rootVersion) errors.push('package.json must declare a non-empty version');
      else if (!VERSION_RE.test(rootVersion)) errors.push(`package.json has invalid version: ${rootVersion}`);
      if (!asNonEmptyString(packageJson.name)) errors.push('package.json must declare a non-empty name');
    }

    const lockPath = packageLockFor(packagePath);
    if (!fs.existsSync(lockPath)) continue;
    const lockRelative = normalizeRelativePath(path.relative(repoRoot, lockPath));
    const lock = readJson(lockPath, lockRelative, errors);
    if (!lock) continue;
    const lockRoot = isObject(lock.packages) ? lock.packages[''] : null;
    const packageVersion = asNonEmptyString(packageJson.version);
    const lockVersion = asNonEmptyString(lock.version);
    const lockRootVersion = isObject(lockRoot) ? asNonEmptyString(lockRoot.version) : null;
    const packageName = asNonEmptyString(packageJson.name);
    const lockName = isObject(lockRoot) ? asNonEmptyString(lockRoot.name) : null;

    if (packageName && lockName && packageName !== lockName) {
      errors.push(`${relative} name ${packageName} does not match ${lockRelative} root name ${lockName}`);
    }
    if (packageVersion !== lockVersion) {
      errors.push(`${relative} version ${packageVersion ?? '(missing)'} does not match ${lockRelative} version ${lockVersion ?? '(missing)'}`);
    }
    if (packageVersion !== lockRootVersion) {
      errors.push(`${relative} version ${packageVersion ?? '(missing)'} does not match ${lockRelative} packages[""].version ${lockRootVersion ?? '(missing)'}`);
    }
    checks.push(`${relative} ↔ ${lockRelative}`);
  }

  if (!rootPackage) errors.push('Root package.json is missing or invalid');

  const capabilitiesFiles = walkFiles(repoRoot)
    .filter((filePath) => path.basename(filePath) === 'capabilities.json');
  for (const capabilitiesPath of capabilitiesFiles) {
    const relative = normalizeRelativePath(path.relative(repoRoot, capabilitiesPath));
    const capabilities = readJson(capabilitiesPath, relative, errors);
    if (!capabilities) continue;
    const declaredVersion = firstVersion(capabilities);
    if (declaredVersion) {
      const expectedVersion = path.resolve(capabilitiesPath) === path.join(repoRoot, 'capabilities.json')
        ? rootVersion
        : nearestPackageVersion(repoRoot, capabilitiesPath, packageCache) || rootVersion;
      if (expectedVersion && declaredVersion !== expectedVersion) {
        errors.push(`${relative} release metadata ${declaredVersion} does not match package version ${expectedVersion}`);
      }
    }
    checks.push(`${relative} parsed`);
  }

  const skillFiles = walkFiles(repoRoot).filter((filePath) => path.basename(filePath) === 'SKILL.md');
  for (const skillPath of skillFiles) {
    const relative = normalizeRelativePath(path.relative(repoRoot, skillPath));
    const parsed = parseSkillFrontmatter(readText(skillPath));
    if (parsed.error) {
      errors.push(`${relative} has ${parsed.error}`);
      continue;
    }
    const skillName = asNonEmptyString(parsed.frontmatter.name);
    const skillDirectory = path.basename(path.dirname(skillPath));
    if (skillName && skillName !== skillDirectory) {
      errors.push(`${relative} name ${skillName} does not match skill directory ${skillDirectory}`);
    }
    const declaredVersion = firstVersion(parsed.frontmatter);
    const expectedVersion = nearestPackageVersion(repoRoot, skillPath, packageCache);
    if (declaredVersion && expectedVersion && declaredVersion !== expectedVersion) {
      errors.push(`${relative} release metadata ${declaredVersion} does not match package version ${expectedVersion}`);
    }
    if (isObject(parsed.frontmatter.capabilities)) {
      const capabilityVersion = firstVersion(parsed.frontmatter.capabilities);
      if (capabilityVersion && expectedVersion && capabilityVersion !== expectedVersion) {
        errors.push(`${relative} capabilities release metadata ${capabilityVersion} does not match package version ${expectedVersion}`);
      }
    }
    checks.push(`${relative} parsed`);
  }

  if (!capabilitiesFiles.length) warnings.push('No capabilities.json found; capability release metadata check skipped');

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    checks,
    packageName: asNonEmptyString(rootPackage?.name),
    repository: rootPackage
      ? normalizeRepository(git(repoRoot, ['remote', 'get-url', 'origin'], { allowFailure: true }))
        || repositoryName(rootPackage, repoRoot)
      : null,
    version: rootVersion,
  };
}

/** Classify a branch and expose whether it is eligible for release actions. */
export function classifyBranch(branchName) {
  const name = String(branchName || '').replace(/^refs\/heads\//, '').trim();
  if (name === 'main' || name === 'master') {
    return { name, kind: 'main', releaseAllowed: true };
  }
  if (/^release\/[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) {
    return { name, kind: 'release', releaseAllowed: true };
  }
  if (/^wip\/[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(name)) {
    return { name, kind: 'wip', releaseAllowed: false };
  }
  if (/^archive\/[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(name)) {
    return { name, kind: 'archive', releaseAllowed: false };
  }
  const prefix = TASK_BRANCH_PREFIXES.find((candidate) => name.startsWith(`${candidate}/`));
  if (prefix && name.length > prefix.length + 1) {
    return { name, kind: 'feature', prefix, releaseAllowed: false };
  }
  return { name, kind: 'unknown', releaseAllowed: false };
}

function git(root, args, { allowFailure = false, trimOutput = true } = {}) {
  try {
    const output = execFileSync('git', args, {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return trimOutput ? output.trim() : output;
  } catch (error) {
    if (allowFailure) return null;
    const detail = error.stderr ? String(error.stderr).trim() : error.message;
    throw new Error(`git ${args.join(' ')} failed: ${detail}`);
  }
}

function currentSha(root) {
  const sha = git(root, ['rev-parse', '--verify', 'HEAD^{commit}']);
  if (!FULL_SHA_RE.test(sha)) throw new Error(`HEAD is not a full commit SHA: ${sha}`);
  return sha.toLowerCase();
}

function currentBranch(root, explicitBranch) {
  if (explicitBranch) return String(explicitBranch).replace(/^refs\/heads\//, '').trim();
  const envBranch = process.env.GITHUB_HEAD_REF || process.env.GITHUB_REF_NAME;
  if (envBranch) return String(envBranch).replace(/^refs\/heads\//, '').trim();
  return git(root, ['symbolic-ref', '--quiet', '--short', 'HEAD'], { allowFailure: true });
}

function worktreeDirty(root) {
  return Boolean((git(root, ['status', '--porcelain=v1'], { allowFailure: true }) || '').trim());
}

function resolveCommit(root, candidate) {
  if (!candidate) return null;
  const value = git(root, ['rev-parse', '--verify', `${candidate}^{commit}`], { allowFailure: true });
  return value && FULL_SHA_RE.test(value) ? value.toLowerCase() : null;
}

function resolveBase(root, explicitBase) {
  const candidates = [
    explicitBase,
    process.env.GITHUB_BASE_SHA,
    process.env.GITHUB_BASE_REF,
    'origin/main',
    'main',
  ].filter(Boolean);
  for (const candidate of candidates) {
    const resolved = resolveCommit(root, candidate);
    if (resolved) return resolved;
  }
  return null;
}

function changedFiles(root, baseSha) {
  const changed = new Set();
  if (baseSha) {
    const diff = git(root, ['diff', '--name-only', '--diff-filter=ACDMRTUXB', baseSha, '--'], { allowFailure: true }) || '';
    for (const file of diff.split('\n').filter(Boolean)) changed.add(normalizeRelativePath(file));
  }
  const status = git(root, ['status', '--porcelain=v1'], { allowFailure: true, trimOutput: false }) || '';
  for (const line of status.trimEnd().split('\n').filter(Boolean)) {
    const value = line.slice(3).trim();
    if (!value) continue;
    if (value.includes(' -> ')) changed.add(normalizeRelativePath(value.split(' -> ').pop()));
    else changed.add(normalizeRelativePath(value));
  }
  return [...changed].sort();
}

function gitFile(root, revision, relativePath) {
  if (!revision) return null;
  return git(root, ['show', `${revision}:${relativePath}`], { allowFailure: true });
}

function parseJsonText(text) {
  if (text === null || text === undefined) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function skillMetadataFromText(text) {
  if (text === null || text === undefined) return null;
  const parsed = parseSkillFrontmatter(text);
  if (!parsed.frontmatter) return {};
  return {
    ...versionFields(parsed.frontmatter),
    ...Object.fromEntries(
      Object.entries(versionFields(parsed.frontmatter.capabilities)).map(([key, value]) => [`capabilities.${key}`, value]),
    ),
  };
}

function metadataChangedBetween(root, baseSha, relativePath) {
  const headPath = path.join(root, relativePath);
  const baseText = gitFile(root, baseSha, relativePath);
  const headText = fs.existsSync(headPath) ? readText(headPath) : null;
  const fileName = path.basename(relativePath);

  if (fileName === 'SKILL.md') {
    return JSON.stringify(skillMetadataFromText(baseText)) !== JSON.stringify(skillMetadataFromText(headText));
  }
  if (fileName === 'capabilities.json') {
    const baseJson = parseJsonText(baseText);
    const headJson = parseJsonText(headText);
    if (baseJson === null || headJson === null) return true;
    return JSON.stringify(versionFields(baseJson)) !== JSON.stringify(versionFields(headJson));
  }
  if (fileName === 'VERSION') {
    return String(baseText ?? '').trim() !== String(headText ?? '').trim();
  }
  if (fileName === 'package.json' || fileName === 'package-lock.json') {
    const baseJson = parseJsonText(baseText);
    const headJson = parseJsonText(headText);
    const baseVersion = baseJson?.version ?? baseJson?.packages?.['']?.version ?? null;
    const headVersion = headJson?.version ?? headJson?.packages?.['']?.version ?? null;
    return String(baseVersion ?? '') !== String(headVersion ?? '');
  }
  return false;
}

/**
 * Feature/task branches may change implementation and tests, but not release
 * version metadata relative to their base commit.
 */
export function validateNoVersionMetadataChanges({ root = SCRIPT_ROOT, baseSha, branch } = {}) {
  const repoRoot = path.resolve(root);
  const errors = [];
  const changed = changedFiles(repoRoot, baseSha);
  const candidates = new Set();
  for (const relativePath of changed) {
    const fileName = path.basename(relativePath);
    if (VERSION_METADATA_FILENAMES.has(fileName) || fileName === 'capabilities.json' || fileName === 'SKILL.md') {
      candidates.add(relativePath);
    }
  }
  for (const relativePath of [...candidates].sort()) {
    if (metadataChangedBetween(repoRoot, baseSha, relativePath)) {
      errors.push(`Feature branch ${branch || '(current)'} changes release/version metadata in ${relativePath}; use a release/* branch and release manifest`);
    }
  }
  return { ok: errors.length === 0, errors, changedFiles: changed, checkedFiles: [...candidates].sort() };
}

function repositoryName(packageJson, root) {
  const repository = packageJson?.repository;
  const value = typeof repository === 'string' ? repository : repository?.url;
  if (value) {
    const normalized = normalizeRepository(value);
    if (normalized) return normalized;
  }
  return path.basename(root);
}

function normalizeRepository(value) {
  let text = String(value || '').trim();
  if (!text) return null;
  text = text.replace(/^git\+/, '').replace(/\.git$/, '').replace(/\/$/, '');
  try {
    const parsed = new URL(text.includes('://') ? text : `https://github.com/${text.replace(/^git@github\.com:/, '')}`);
    const parts = parsed.pathname.split('/').filter(Boolean);
    return parts.length >= 2 ? `${parts.at(-2)}/${parts.at(-1)}` : null;
  } catch {
    const parts = text.replace(/^git@[^:]+:/, '').split('/').filter(Boolean);
    return parts.length >= 2 ? `${parts.at(-2)}/${parts.at(-1)}` : null;
  }
}

function repoSlug(value) {
  const normalized = normalizeRepository(value) || String(value || '').trim();
  return normalized.split('/').filter(Boolean).pop() || null;
}

function manifestTarget(manifest, expectedRepoSlug, { sha = null, version = null } = {}) {
  if (!isObject(manifest)) return {};
  const candidates = [];
  for (const group of ['candidate', 'stable']) {
    const groupValue = manifest[group];
    if (isObject(groupValue)) {
      for (const key of [expectedRepoSlug, 'core', 'zylos-core']) {
        if (isObject(groupValue[key])) candidates.push(groupValue[key]);
      }
    }
  }
  if (isObject(manifest.repositories)) {
    for (const [key, value] of Object.entries(manifest.repositories)) {
      if (isObject(value) && (repoSlug(key) === expectedRepoSlug || repoSlug(value.repo) === expectedRepoSlug)) candidates.push(value);
    }
  }
  if (Array.isArray(manifest.components)) {
    candidates.push(...manifest.components.filter((value) => isObject(value)
      && (!value.repo || repoSlug(value.repo) === expectedRepoSlug || value.name === expectedRepoSlug)));
  }
  for (const key of ['core', 'zylos-core', 'target', 'component']) {
    if (isObject(manifest[key])) candidates.push(manifest[key]);
  }
  const matchingRepo = candidates.filter((value) => !value.repo || repoSlug(value.repo) === expectedRepoSlug || value.name === expectedRepoSlug);
  const target = matchingRepo.find((value) =>
    (sha && String(value.sha || value.commit || value.commitSha || value.headSha).toLowerCase() === String(sha).toLowerCase())
    || (version && String(value.version || value.release || value.packageVersion) === String(version)))
    || matchingRepo[0];
  return target || manifest;
}

function manifestValue(manifest, target, keys) {
  for (const key of keys) {
    if (target?.[key] !== undefined && target?.[key] !== null) return target[key];
    if (manifest?.[key] !== undefined && manifest?.[key] !== null) return manifest[key];
  }
  return null;
}

function localIdentityProbePath(explicitPath) {
  return explicitPath || process.env.ZYLOS_HXA_PROFILE_CLI
    || path.join(os.homedir(), 'zylos', '.claude', 'skills', 'hxa-connect', 'scripts', 'cli.js');
}

/** Run the fresh, machine-local HXA profile probe used by release gates. */
export function probeLocalIdentity({ probePath, exec = execFileSync } = {}) {
  const cliPath = localIdentityProbePath(probePath);
  if (!fs.existsSync(cliPath)) {
    return { ok: false, error: `HXA identity probe is missing: ${cliPath}`, path: cliPath };
  }
  try {
    const output = exec(process.execPath, [cliPath, 'profile'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const identity = JSON.parse(output);
    if (!isObject(identity)) return { ok: false, error: 'HXA identity probe did not return an object', path: cliPath };
    return { ok: true, identity, path: cliPath };
  } catch (error) {
    return { ok: false, error: `HXA identity probe failed: ${error.message}`, path: cliPath };
  }
}

/** Validate and pin an external release/deployment manifest. */
export function validateReleaseManifest({
  root = SCRIPT_ROOT,
  manifestPath,
  sha,
  version,
  branch,
  packageName,
  repository,
  localIdentity,
  identityProbePath,
  localHostname = os.hostname(),
  mode = 'release',
} = {}) {
  const repoRoot = path.resolve(root);
  const errors = [];
  if (!manifestPath) return { ok: false, errors: ['Release/deploy mode requires --manifest or ZYLOS_RELEASE_MANIFEST'] };

  const requestedPath = path.resolve(repoRoot, manifestPath);
  let resolvedManifestPath = requestedPath;
  try {
    resolvedManifestPath = fs.realpathSync(requestedPath);
  } catch {
    errors.push(`Release manifest does not exist: ${requestedPath}`);
  }
  const realRepoRoot = fs.existsSync(repoRoot) ? fs.realpathSync(repoRoot) : repoRoot;
  if (isPathInside(realRepoRoot, resolvedManifestPath)) {
    errors.push('Release manifest must be outside the repository; do not self-reference the current commit in a tracked manifest');
  }
  if (errors.length) return { ok: false, errors, path: resolvedManifestPath };
  let stat;
  try {
    stat = fs.statSync(resolvedManifestPath);
  } catch (error) {
    errors.push(`Cannot stat release manifest: ${error.message}`);
    return { ok: false, errors, path: resolvedManifestPath };
  }
  if (!stat.isFile()) errors.push('Release manifest must be a regular file');
  const manifest = readJson(resolvedManifestPath, 'Release manifest', errors);
  if (!manifest) return { ok: false, errors, path: resolvedManifestPath };

  const expectedSlug = repoSlug(repository) || repoSlug(packageName) || path.basename(repoRoot);
  const target = manifestTarget(manifest, expectedSlug, { sha, version });
  const releaseId = asNonEmptyString(manifest.releaseId) || asNonEmptyString(manifest.id);
  const status = manifestValue(manifest, target, ['status', 'state']);
  const deploymentAllowed = manifestValue(manifest, target, ['deploymentAllowed']);
  const manifestRepo = manifestValue(manifest, target, ['repo', 'repository']);
  const manifestBranch = manifestValue(manifest, target, ['branch', 'ref']);
  const manifestSha = manifestValue(manifest, target, ['sha', 'commit', 'commitSha', 'headSha']);
  const manifestVersion = manifestValue(manifest, target, ['version', 'release', 'packageVersion']);

  const manifestSchema = manifest.schema === undefined ? RELEASE_MANIFEST_V1 : manifest.schema;
  const isGlobalV2Manifest = manifestSchema === RELEASE_MANIFEST_V2 && manifest.target === undefined;
  if (![RELEASE_MANIFEST_V1, RELEASE_MANIFEST_V2].includes(manifestSchema)) {
    errors.push(`Release manifest schema is unsupported: ${manifest.schema}`);
  }
  if (manifestSchema === RELEASE_MANIFEST_V2 && manifest.target !== undefined) {
    errors.push('Global v2 release manifest must not contain a per-agent target');
  }
  if (!releaseId) errors.push('Release manifest must declare releaseId');
  if (status !== 'READY') errors.push(`Release manifest status must be READY (found ${status ?? '(missing)'})`);
  if (deploymentAllowed !== true) errors.push('Release manifest deploymentAllowed must be true');
  if (status === 'READY' && Array.isArray(manifest.holdReasons) && manifest.holdReasons.length > 0) {
    errors.push('READY release manifest must not contain holdReasons');
  }
  if (!manifestRepo) errors.push('Release manifest must declare repo');
  else if (normalizeRepository(manifestRepo) !== normalizeRepository(repository)) {
    errors.push(`Release manifest repo ${manifestRepo} does not exactly match ${repository}`);
  } else if (repoSlug(manifestRepo) !== expectedSlug) {
    errors.push(`Release manifest repo ${manifestRepo} does not target ${expectedSlug}`);
  }
  if (!manifestBranch) errors.push('Release manifest must declare branch');
  else if (branch && String(manifestBranch).replace(/^refs\/heads\//, '') !== String(branch).replace(/^refs\/heads\//, '')) {
    errors.push(`Release manifest branch ${manifestBranch} does not match current branch ${branch}`);
  }
  if (!FULL_SHA_RE.test(String(manifestSha || ''))) {
    errors.push('Release manifest must pin a full 40-character commit SHA');
  } else if (sha && String(manifestSha).toLowerCase() !== String(sha).toLowerCase()) {
    errors.push(`Release manifest SHA ${manifestSha} does not match current HEAD ${sha}`);
  }
  if (!asNonEmptyString(manifestVersion)) errors.push('Release manifest must declare version');
  else if (version && String(manifestVersion).trim() !== String(version).trim()) {
    errors.push(`Release manifest version ${manifestVersion} does not match package version ${version}`);
  }
  if (manifestBranch && /^release\//.test(String(manifestBranch)) && manifestVersion) {
    const branchVersion = String(manifestBranch).slice('release/'.length).replace(/^v/, '');
    if (branchVersion !== String(manifestVersion).replace(/^v/, '')) {
      errors.push(`Release branch ${manifestBranch} does not match manifest version ${manifestVersion}`);
    }
  }

  const targetIdentity = manifest.target;
  const targetAgent = asNonEmptyString(targetIdentity?.agent);
  const targetProfileId = asNonEmptyString(targetIdentity?.profileId);
  const targetHostname = asNonEmptyString(targetIdentity?.hostname);
  const identityRequired = mode === 'deploy' || !isGlobalV2Manifest;
  if (identityRequired) {
    if (!targetAgent) errors.push('Release manifest target.agent is required');
    if (!targetProfileId) errors.push('Release manifest target.profileId is required');
    if (!targetHostname) errors.push('Release manifest target.hostname is required');
  }
  let identityResult = null;
  if (identityRequired && targetAgent && targetProfileId && targetHostname) {
    identityResult = localIdentity
      ? { ok: true, identity: localIdentity, path: null }
      : probeLocalIdentity({ probePath: identityProbePath });
    if (!identityResult.ok) {
      errors.push(`Release/deploy identity probe required: ${identityResult.error}`);
    } else {
      const identity = identityResult.identity;
      const actualAgent = asNonEmptyString(identity.name) || asNonEmptyString(identity.agent) || asNonEmptyString(identity.agentName);
      const actualProfileId = asNonEmptyString(identity.id) || asNonEmptyString(identity.profileId);
      if (actualAgent !== targetAgent) errors.push(`Release/deploy target agent ${targetAgent} does not match fresh local profile ${actualAgent || '(missing)'}`);
      if (actualProfileId !== targetProfileId) errors.push(`Release/deploy target profileId ${targetProfileId} does not match fresh local profile ${actualProfileId || '(missing)'}`);
      if (localHostname !== targetHostname) errors.push(`Release/deploy target hostname ${targetHostname} does not match local hostname ${localHostname}`);
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    path: resolvedManifestPath,
    releaseId,
    status,
    deploymentAllowed,
    repo: manifestRepo,
    branch: manifestBranch,
    sha: manifestSha,
    version: manifestVersion,
    schema: manifestSchema,
    target: { agent: targetAgent, profileId: targetProfileId, hostname: targetHostname },
    identity: identityResult?.identity || null,
  };
}

/** Validate evidence that is required only when the operation will deploy. */
export function validateDeploymentReadiness(manifest) {
  const errors = [];
  if (!asNonEmptyString(manifest?.evidence?.pairReport)) {
    errors.push('Deploy mode requires evidence.pairReport');
  }
  if (manifest?.evidence?.canary !== 'PASS') {
    errors.push(`Deploy mode requires evidence.canary=PASS (found ${manifest?.evidence?.canary ?? '(missing)'})`);
  }
  if (manifest?.evidence?.hxaProvenance !== 'PASS') {
    errors.push(`Deploy mode requires evidence.hxaProvenance=PASS (found ${manifest?.evidence?.hxaProvenance ?? '(missing)'})`);
  }
  return errors;
}

function parseArgs(argv) {
  const options = { mode: 'check', manifestPath: null, base: null, branch: null, root: null, identityProbePath: null, json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--json') options.json = true;
    else if (arg === '--mode' || arg === '--manifest' || arg === '--base' || arg === '--branch' || arg === '--root' || arg === '--identity-probe') {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) throw new Error(`${arg} requires a value`);
      index += 1;
      if (arg === '--mode') options.mode = value;
      if (arg === '--manifest') options.manifestPath = value;
      if (arg === '--base') options.base = value;
      if (arg === '--branch') options.branch = value;
      if (arg === '--root') options.root = value;
      if (arg === '--identity-probe') options.identityProbePath = value;
    } else if (arg.startsWith('--mode=')) options.mode = arg.slice('--mode='.length);
    else if (arg.startsWith('--manifest=')) options.manifestPath = arg.slice('--manifest='.length);
    else if (arg.startsWith('--base=')) options.base = arg.slice('--base='.length);
    else if (arg.startsWith('--branch=')) options.branch = arg.slice('--branch='.length);
    else if (arg.startsWith('--root=')) options.root = arg.slice('--root='.length);
    else if (arg.startsWith('--identity-probe=')) options.identityProbePath = arg.slice('--identity-probe='.length);
    else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new Error(`Unknown option: ${arg}`);
  }
  if (!['check', 'pr', 'release', 'deploy'].includes(options.mode)) {
    throw new Error(`Unknown mode ${options.mode}; expected check, pr, release, or deploy`);
  }
  return options;
}

function usage() {
  return [
    'Usage: node scripts/agent-governance-check.js [options]',
    '',
    '  --mode check|pr|release|deploy   Gate mode (default: check)',
    '  --base <sha-or-ref>              Base commit for feature metadata checks',
    '  --branch <name>                  Branch override (CI uses GITHUB_HEAD_REF)',
    '  --manifest <path>                External release manifest (or ZYLOS_RELEASE_MANIFEST)',
    '  --identity-probe <path>          Fresh HXA profile probe used by release/deploy gates',
    '  --json                           Emit a machine-readable report',
  ].join('\n');
}

/** Run all read-only checks and return a structured report. */
export function runGovernance({
  root = process.cwd(),
  mode = 'check',
  base = null,
  branch = null,
  manifestPath = null,
  identityProbePath = null,
} = {}) {
  const repoRoot = path.resolve(root);
  const errors = [];
  const warnings = [];
  let sha = null;
  try {
    sha = currentSha(repoRoot);
  } catch (error) {
    errors.push(error.message);
  }
  const actualBranch = currentBranch(repoRoot, branch);
  const branchInfo = classifyBranch(actualBranch);
  if (!actualBranch) errors.push('Unable to determine current branch; pass --branch in detached CI checkouts');
  if (branchInfo.kind === 'unknown') errors.push(`Branch ${actualBranch || '(missing)'} does not use an approved category (main, release/*, feat/*, fix/*, codex/*, wip/*, archive/*, etc.)`);

  const metadata = validateReleaseMetadata({ root: repoRoot });
  errors.push(...metadata.errors);
  warnings.push(...metadata.warnings);

  const baseSha = resolveBase(repoRoot, base);
  let versionGate = { ok: true, errors: [], changedFiles: [], checkedFiles: [] };
  if (branchInfo.kind === 'feature') {
    if (!baseSha) {
      versionGate = { ok: false, errors: ['Feature branch checks require a resolvable base commit; pass --base <sha>'], changedFiles: [], checkedFiles: [] };
    } else {
      versionGate = validateNoVersionMetadataChanges({ root: repoRoot, baseSha, branch: actualBranch });
    }
    errors.push(...versionGate.errors);
  }

  const dirty = worktreeDirty(repoRoot);
  let manifest = null;
  if (mode === 'release' || mode === 'deploy') {
    if (!branchInfo.releaseAllowed) errors.push(`${mode} mode is only allowed on main or release/* branches (found ${actualBranch || '(missing)'})`);
    if (dirty) errors.push(`${mode} mode requires a clean worktree`);
    const resolvedManifestPath = manifestPath || process.env.ZYLOS_RELEASE_MANIFEST || null;
    manifest = validateReleaseManifest({
      root: repoRoot,
      manifestPath: resolvedManifestPath,
      sha,
      version: metadata.version,
      branch: actualBranch,
      packageName: metadata.packageName,
      repository: metadata.repository,
      identityProbePath,
      mode,
    });
    errors.push(...manifest.errors);
    if (mode === 'deploy' && manifest.path && fs.existsSync(manifest.path)) {
      const deployManifest = readJson(manifest.path, 'Release manifest', errors);
      if (deployManifest) errors.push(...validateDeploymentReadiness(deployManifest));
    }
  }

  return {
    ok: errors.length === 0,
    mode,
    repo: metadata.repository || path.basename(repoRoot),
    root: repoRoot,
    branch: actualBranch,
    branchKind: branchInfo.kind,
    sha,
    version: metadata.version,
    baseSha,
    dirty,
    metadata,
    versionGate,
    manifest,
    warnings,
    errors,
  };
}

function reportRepository(root, metadata) {
  try {
    const origin = git(root, ['remote', 'get-url', 'origin'], { allowFailure: true });
    if (origin) return normalizeRepository(origin) || metadata?.repository || path.basename(root);
    const packageJson = JSON.parse(readText(path.join(root, 'package.json')));
    return normalizeRepository(packageJson.repository?.url || packageJson.repository)
      || metadata?.repository
      || path.basename(root);
  } catch {
    return path.basename(root);
  }
}

function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
    if (options.help) {
      console.log(usage());
      return;
    }
    const report = runGovernance({
      root: options.root || process.cwd(),
      mode: options.mode,
      base: options.base,
      branch: options.branch,
      manifestPath: options.manifestPath,
      identityProbePath: options.identityProbePath,
    });
    if (options.json) {
      console.log(JSON.stringify({ ...report, repo: reportRepository(report.root, report.metadata) }, null, 2));
    } else {
      console.log(`repo: ${reportRepository(report.root, report.metadata)}`);
      console.log(`branch: ${report.branch || '(unknown)'} [${report.branchKind}]`);
      console.log(`sha: ${report.sha || '(unknown)'}`);
      console.log(`version: ${report.version || '(unknown)'}`);
      console.log(`mode: ${report.mode}`);
      if (report.baseSha) console.log(`base: ${report.baseSha}`);
      if (report.warnings.length) report.warnings.forEach((warning) => console.log(`WARN ${warning}`));
      if (report.ok) console.log('PASS agent governance checks');
      else {
        report.errors.forEach((error) => console.error(`FAIL ${error}`));
        console.error('HOLD agent governance checks');
      }
    }
    process.exitCode = report.ok ? 0 : 1;
  } catch (error) {
    if (options?.json) console.log(JSON.stringify({ ok: false, errors: [error.message] }, null, 2));
    else console.error(`ERROR ${error.message}\n\n${usage()}`);
    process.exitCode = 2;
  }
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (invokedPath && invokedPath === path.resolve(fileURLToPath(import.meta.url))) main();
