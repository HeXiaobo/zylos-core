#!/usr/bin/env node
/**
 * Install dependencies for skills that have their own package.json.
 * Runs as a pretest hook so `npm test` works out of the box.
 */

import { mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = join(fileURLToPath(import.meta.url), '..', '..');
const skillsDir = join(root, 'skills');
const runtimeDependencyFields = ['dependencies', 'optionalDependencies', 'peerDependencies'];
const dependencyMapFields = [...runtimeDependencyFields, 'devDependencies'];
const lockNamespace = createHash('sha256').update(realpathSync(root)).digest('hex');
const testLockRoot = process.env.NODE_ENV === 'test' ? process.env.ZYLOS_TEST_SKILL_DEPS_LOCK_ROOT : undefined;
const processLockRoot = testLockRoot ?? join(tmpdir(), 'zylos-install-skill-deps-locks', lockNamespace);
const lockPollMs = 25;
const lockAcquireTimeoutMs = 120_000;
const incompleteOwnerGraceMs = 5_000;

function sleepSync(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function readJsonFile(filePath, displayPath) {
  try {
    const value = JSON.parse(readFileSync(filePath, 'utf8'));
    if (!isPlainObject(value)) throw new Error('root value must be a plain object');
    return value;
  } catch (error) {
    throw new Error(`[pretest] ${displayPath} is invalid: ${error.message}`);
  }
}

function mapsEqual(left = {}, right = {}) {
  const leftEntries = Object.entries(left).sort(([a], [b]) => a.localeCompare(b));
  const rightEntries = Object.entries(right).sort(([a], [b]) => a.localeCompare(b));
  return JSON.stringify(leftEntries) === JSON.stringify(rightEntries);
}

function validateDependencyMap(container, field, displayPath) {
  if (!Object.hasOwn(container, field)) return;
  if (!isPlainObject(container[field])) {
    throw new Error(`[pretest] ${displayPath} field ${field} must be a plain object`);
  }
  for (const [dependencyName, specifier] of Object.entries(container[field])) {
    if (typeof specifier !== 'string' || specifier.length === 0) {
      throw new Error(`[pretest] ${displayPath} field ${field}.${dependencyName} must be a non-empty string specifier`);
    }
  }
}

function validatePackageJson(packageJson, skillName) {
  for (const field of dependencyMapFields) {
    validateDependencyMap(packageJson, field, `skills/${skillName}/package.json`);
  }
}

function validatePackageLock(packageLock, packageJson, skillName) {
  const displayPath = `skills/${skillName}/package-lock.json`;
  if (![2, 3].includes(packageLock.lockfileVersion)) {
    throw new Error(`[pretest] ${displayPath} must use lockfileVersion 2 or 3`);
  }
  if (!isPlainObject(packageLock.packages) || !isPlainObject(packageLock.packages[''])) {
    throw new Error(`[pretest] ${displayPath} must contain a plain-object packages[""] root`);
  }
  const lockRoot = packageLock.packages[''];
  if (packageJson.name !== undefined && (packageLock.name !== packageJson.name || lockRoot.name !== packageJson.name)) {
    throw new Error(`[pretest] ${displayPath} package name does not match package.json`);
  }
  if (packageJson.version !== undefined && (packageLock.version !== packageJson.version || lockRoot.version !== packageJson.version)) {
    throw new Error(`[pretest] ${displayPath} package version does not match package.json`);
  }
  for (const field of dependencyMapFields) {
    validateDependencyMap(lockRoot, field, `${displayPath} root`);
    if (!mapsEqual(packageJson[field] ?? {}, lockRoot[field] ?? {})) {
      throw new Error(`[pretest] ${displayPath} root field ${field} does not match package.json`);
    }
  }
}

function assertTrackedLockfile(skillName) {
  const relativePath = join('skills', skillName, 'package-lock.json');
  try {
    execFileSync('git', ['-C', root, 'ls-files', '--error-unmatch', '--', relativePath], { stdio: 'ignore' });
  } catch {
    throw new Error(`[pretest] ${relativePath} must be tracked by Git`);
  }
}

function readOwner(ownerPath) {
  try {
    const owner = JSON.parse(readFileSync(ownerPath, 'utf8'));
    if (!isPlainObject(owner) || !Number.isInteger(owner.pid) || typeof owner.token !== 'string') return null;
    return owner;
  } catch {
    return null;
  }
}

function readLeaseOwner(directory) {
  try {
    const owners = readdirSync(directory)
      .map((entry) => /^owner-(\d+)-([0-9a-f-]+)\.lease$/.exec(entry))
      .filter(Boolean);
    if (owners.length !== 1) return null;
    const pid = Number(owners[0][1]);
    const token = owners[0][2];
    if (!Number.isInteger(pid) || pid <= 0 || token.length === 0) return null;
    return { pid, token };
  } catch {
    return null;
  }
}

function readDirectoryOwner(directory) {
  return readLeaseOwner(directory) ?? readOwner(join(directory, 'owner.json'));
}

function hasInvalidOwnerEvidence(directory) {
  try {
    return existsSync(join(directory, 'owner.json'))
      || readdirSync(directory).some((entry) => entry.startsWith('owner-') && entry.endsWith('.lease'));
  } catch {
    return false;
  }
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

function lockIsStale(lockDir) {
  const owner = readDirectoryOwner(lockDir);
  if (owner) return !processIsAlive(owner.pid);
  if (hasInvalidOwnerEvidence(lockDir)) return false;
  try {
    return Date.now() - statSync(lockDir).mtimeMs >= incompleteOwnerGraceMs;
  } catch {
    return false;
  }
}

function releaseOwnedDirectory(directory, token) {
  const owner = readDirectoryOwner(directory);
  if (owner?.pid === process.pid && owner.token === token) rmSync(directory, { recursive: true, force: true });
}

function createOwnedDirectory(directory, token) {
  const pendingDirectory = `${directory}.pending-${process.pid}-${token}`;
  mkdirSync(pendingDirectory, { mode: 0o700 });
  try {
    writeFileSync(join(pendingDirectory, `owner-${process.pid}-${token}.lease`), '', { mode: 0o600 });
    writeFileSync(join(pendingDirectory, 'owner.json'), `${JSON.stringify({ pid: process.pid, token })}\n`, { mode: 0o600 });
    renameSync(pendingDirectory, directory);
  } catch (error) {
    rmSync(pendingDirectory, { recursive: true, force: true });
    if (error?.code === 'ENOTEMPTY') error.code = 'EEXIST';
    throw error;
  }
}

function recoverStaleLock(lockDir) {
  if (!lockIsStale(lockDir)) return false;
  const recoveryDir = `${lockDir}.recovery`;
  const recoveryToken = randomUUID();
  try {
    createOwnedDirectory(recoveryDir, recoveryToken);
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
    return false;
  }
  try {
    if (lockIsStale(lockDir)) rmSync(lockDir, { recursive: true, force: true });
    return true;
  } finally {
    releaseOwnedDirectory(recoveryDir, recoveryToken);
  }
}

function acquireSkillLock(skillName) {
  mkdirSync(processLockRoot, { recursive: true, mode: 0o700 });
  const lockDir = join(processLockRoot, `${encodeURIComponent(skillName)}.lock`);
  const token = randomUUID();
  const deadline = Date.now() + lockAcquireTimeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(`${lockDir}.recovery`)) {
      if (lockIsStale(`${lockDir}.recovery`)) rmSync(`${lockDir}.recovery`, { recursive: true, force: true });
      sleepSync(lockPollMs);
      continue;
    }
    try {
      createOwnedDirectory(lockDir, token);
      return { lockDir, token };
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      recoverStaleLock(lockDir);
      sleepSync(lockPollMs);
    }
  }
  throw new Error(`[pretest] timed out waiting for dependency install lock for skills/${skillName}`);
}

function withSkillLock(skillName, operation) {
  const handle = acquireSkillLock(skillName);
  try {
    return operation();
  } finally {
    releaseOwnedDirectory(handle.lockDir, handle.token);
  }
}

function hasRuntimeDependencies(packageJson) {
  return runtimeDependencyFields.some((field) => Object.keys(packageJson[field] ?? {}).length > 0);
}

for (const name of readdirSync(skillsDir, { withFileTypes: true })) {
  if (!name.isDirectory()) continue;
  const dir = join(skillsDir, name.name);
  const pkg = join(dir, 'package.json');
  const lock = join(dir, 'package-lock.json');
  const modules = join(dir, 'node_modules');
  if (!existsSync(pkg)) continue;
  const packageJson = readJsonFile(pkg, `skills/${name.name}/package.json`);
  validatePackageJson(packageJson, name.name);
  if (!hasRuntimeDependencies(packageJson)) continue;
  if (!existsSync(lock)) {
    throw new Error(`[pretest] skills/${name.name} has runtime dependencies but no package-lock.json`);
  }
  assertTrackedLockfile(name.name);
  const packageLock = readJsonFile(lock, `skills/${name.name}/package-lock.json`);
  validatePackageLock(packageLock, packageJson, name.name);
  if (existsSync(modules)) continue;
  withSkillLock(name.name, () => {
    if (existsSync(modules)) return;
    console.log(`[pretest] Installing deps for skills/${name.name}`);
    try {
      execFileSync('npm', ['ci', '--omit=dev'], { cwd: dir, stdio: 'inherit' });
    } catch (error) {
      rmSync(modules, { recursive: true, force: true });
      throw error;
    }
  });
}
