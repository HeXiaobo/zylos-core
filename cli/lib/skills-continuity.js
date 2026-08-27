import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const SKILLS_INVENTORY_SCHEMA_VERSION = 2;

const EXCLUDED_ENTRY_NAMES = new Set(['node_modules', '.backup']);
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function entryMode(stat) {
  return stat.mode & 0o7777;
}

function sha256(content) {
  return crypto.createHash('sha256').update(content).digest('hex');
}

function normalizeRelativePath(relativePath) {
  return relativePath.split(path.sep).join('/');
}

function assertDirectory(rootDir, label, fsApi) {
  let stat;
  try {
    stat = fsApi.statSync(rootDir);
  } catch (err) {
    throw new Error(`${label} is missing or unreadable: ${rootDir}: ${err.message}`);
  }
  if (!stat.isDirectory()) throw new Error(`${label} must be a directory: ${rootDir}`);
}

function directoryNames(rootDir, label, fsApi) {
  if (!rootDir) return new Set();
  assertDirectory(rootDir, label, fsApi);
  const names = new Set();
  for (const entry of fsApi.readdirSync(rootDir, { withFileTypes: true })) {
    if (EXCLUDED_ENTRY_NAMES.has(entry.name)) continue;
    const stat = fsApi.lstatSync(path.join(rootDir, entry.name));
    if (stat.isSymbolicLink()) throw new Error(`${label} contains unsupported symlink: ${entry.name}`);
    if (stat.isDirectory()) names.add(entry.name);
  }
  return names;
}

// A same-name directory is not, by itself, evidence that the incoming Core
// release owns the live skill.  Skills that have already gone through the
// normal merge-baseline transaction do carry durable provenance, however:
// both the manifest and its originals directory must be present and regular.
// This lets an ordinary Core-managed skill continue through a three-way merge
// while an untracked business skill with the same name remains fail-closed.
function hasMergeBaseline(skillDir, fsApi) {
  const metadataDir = path.join(skillDir, '.zylos');
  const manifestPath = path.join(metadataDir, 'manifest.json');
  const originalsDir = path.join(metadataDir, 'originals');
  try {
    const metadataStat = fsApi.lstatSync(metadataDir);
    const manifestStat = fsApi.lstatSync(manifestPath);
    const originalsStat = fsApi.lstatSync(originalsDir);
    if (
      !metadataStat.isDirectory() || metadataStat.isSymbolicLink()
      || !manifestStat.isFile() || manifestStat.isSymbolicLink()
      || !originalsStat.isDirectory() || originalsStat.isSymbolicLink()
    ) return false;
    const manifest = JSON.parse(fsApi.readFileSync(manifestPath, 'utf8'));
    return isPlainObject(manifest?.files);
  } catch {
    return false;
  }
}

function captureSkillEntries(skillDir, fsApi) {
  const entries = [];

  function walk(currentDir, relativeDir) {
    const currentStat = fsApi.lstatSync(currentDir);
    if (currentStat.isSymbolicLink()) {
      throw new Error(`skills inventory rejects symlink: ${normalizeRelativePath(relativeDir || '.')}`);
    }
    if (!currentStat.isDirectory()) {
      throw new Error(`skills inventory expected directory: ${normalizeRelativePath(relativeDir || '.')}`);
    }
    entries.push({
      path: normalizeRelativePath(relativeDir || '.'),
      type: 'directory',
      sha256: null,
      mode: entryMode(currentStat),
    });

    for (const entry of fsApi.readdirSync(currentDir, { withFileTypes: true })) {
      if (EXCLUDED_ENTRY_NAMES.has(entry.name)) continue;
      const entryPath = path.join(currentDir, entry.name);
      const relativePath = relativeDir ? path.join(relativeDir, entry.name) : entry.name;
      const stat = fsApi.lstatSync(entryPath);
      if (stat.isSymbolicLink()) {
        throw new Error(`skills inventory rejects symlink: ${normalizeRelativePath(relativePath)}`);
      }
      if (stat.isDirectory()) {
        walk(entryPath, relativePath);
        continue;
      }
      if (!stat.isFile()) {
        throw new Error(`skills inventory rejects unsupported entry: ${normalizeRelativePath(relativePath)}`);
      }
      entries.push({
        path: normalizeRelativePath(relativePath),
        type: 'file',
        sha256: sha256(fsApi.readFileSync(entryPath)),
        mode: entryMode(stat),
      });
    }
  }

  walk(skillDir, '');
  return entries.sort((left, right) => left.path.localeCompare(right.path));
}

function captureDeclaredScripts(skillDir, fsApi) {
  const skillFile = path.join(skillDir, 'SKILL.md');
  try {
    const stat = fsApi.lstatSync(skillFile);
    if (!stat.isFile() || stat.isSymbolicLink()) return [];
    const content = fsApi.readFileSync(skillFile, 'utf8');
    const scripts = [];
    const seen = new Set();
    for (const match of content.matchAll(/^\s*entry:\s*([^\s#]+)\s*$/gm)) {
      const scriptPath = normalizeRelativePath(match[1]);
      if (path.posix.isAbsolute(scriptPath) || scriptPath === '..' || scriptPath.startsWith('../')) continue;
      if (!seen.has(scriptPath)) {
        seen.add(scriptPath);
        scripts.push({ path: scriptPath });
      }
    }
    return scripts.sort((left, right) => left.path.localeCompare(right.path));
  } catch {
    return [];
  }
}

export function captureExactSkillsInventory({
  skillsDir,
  incomingSkillsDir = null,
  installedCoreSkillsDir = null,
  classifyOwnership = false,
  fsApi = fs,
}) {
  assertDirectory(skillsDir, 'skills root', fsApi);
  const incomingNames = directoryNames(incomingSkillsDir, 'incoming skills root', fsApi);
  const installedCoreNames = directoryNames(installedCoreSkillsDir, 'installed Core skills root', fsApi);
  const skills = [];

  for (const entry of fsApi.readdirSync(skillsDir, { withFileTypes: true })) {
    if (EXCLUDED_ENTRY_NAMES.has(entry.name)) continue;
    const skillDir = path.join(skillsDir, entry.name);
    const stat = fsApi.lstatSync(skillDir);
    if (stat.isSymbolicLink()) throw new Error(`skills root contains unsupported symlink: ${entry.name}`);
    if (!stat.isDirectory()) continue;

    const ownedByTarget = installedCoreNames.has(entry.name) || hasMergeBaseline(skillDir, fsApi);
    if (classifyOwnership && incomingNames.has(entry.name) && !ownedByTarget) {
      throw new Error(
        `untrusted same-name skill collision: ${entry.name} exists locally and in the incoming Core package`,
      );
    }
    const entries = captureSkillEntries(skillDir, fsApi);
    skills.push({
      name: entry.name,
      ownedByTarget,
      fileCount: entries.filter(({ type }) => type === 'file').length,
      declaredScripts: captureDeclaredScripts(skillDir, fsApi),
      entries,
    });
  }

  return {
    schemaVersion: SKILLS_INVENTORY_SCHEMA_VERSION,
    root: path.resolve(skillsDir),
    skills: skills.sort((left, right) => left.name.localeCompare(right.name)),
  };
}

function assertInventoryEntry(entry, label) {
  if (!isPlainObject(entry)) throw new Error(`${label} must be an object`);
  if (typeof entry.path !== 'string' || entry.path.length === 0 || path.isAbsolute(entry.path)) {
    throw new Error(`${label}.path must be a relative path`);
  }
  const normalized = path.posix.normalize(entry.path);
  if (normalized !== entry.path || normalized === '..' || normalized.startsWith('../')) {
    throw new Error(`${label}.path is not canonical`);
  }
  if (!['file', 'directory'].includes(entry.type)) throw new Error(`${label}.type is invalid`);
  if (!Number.isSafeInteger(entry.mode) || entry.mode < 0 || entry.mode > 0o7777) {
    throw new Error(`${label}.mode is invalid`);
  }
  if (entry.type === 'file' && !SHA256_PATTERN.test(entry.sha256)) {
    throw new Error(`${label}.sha256 is invalid`);
  }
  if (entry.type === 'directory' && entry.sha256 !== null) {
    throw new Error(`${label}.sha256 must be null for a directory`);
  }
}

export function assertExactSkillsInventory(inventory) {
  if (!isPlainObject(inventory) || inventory.schemaVersion !== SKILLS_INVENTORY_SCHEMA_VERSION) {
    throw new Error('trusted pre-mutation skills inventory is required');
  }
  if (typeof inventory.root !== 'string' || !path.isAbsolute(inventory.root)) {
    throw new Error('pre-mutation skills inventory root must be absolute');
  }
  if (!Array.isArray(inventory.skills)) {
    throw new Error('pre-mutation skills inventory skills must be an array');
  }

  const names = new Set();
  for (const [skillIndex, skill] of inventory.skills.entries()) {
    const label = `pre-mutation skills inventory.skills[${skillIndex}]`;
    if (!isPlainObject(skill) || typeof skill.name !== 'string' || !/^[^/\\]+$/.test(skill.name)) {
      throw new Error(`${label}.name is invalid`);
    }
    if (names.has(skill.name)) throw new Error(`${label}.name is duplicated`);
    names.add(skill.name);
    if (typeof skill.ownedByTarget !== 'boolean') throw new Error(`${label}.ownedByTarget is invalid`);
    if (!Number.isSafeInteger(skill.fileCount) || skill.fileCount < 0) {
      throw new Error(`${label}.fileCount is invalid`);
    }
    if (!Array.isArray(skill.declaredScripts)) throw new Error(`${label}.declaredScripts must be an array`);
    for (const [scriptIndex, script] of skill.declaredScripts.entries()) {
      if (!isPlainObject(script) || typeof script.path !== 'string' || path.isAbsolute(script.path)) {
        throw new Error(`${label}.declaredScripts[${scriptIndex}].path is invalid`);
      }
      const normalized = path.posix.normalize(script.path);
      if (normalized !== script.path || normalized === '..' || normalized.startsWith('../')) {
        throw new Error(`${label}.declaredScripts[${scriptIndex}].path is not canonical`);
      }
    }
    if (!Array.isArray(skill.entries) || skill.entries.length === 0) {
      throw new Error(`${label}.entries must be a non-empty array`);
    }
    const entryPaths = new Set();
    for (const [entryIndex, entry] of skill.entries.entries()) {
      assertInventoryEntry(entry, `${label}.entries[${entryIndex}]`);
      if (entryPaths.has(entry.path)) throw new Error(`${label} has duplicate entry path: ${entry.path}`);
      entryPaths.add(entry.path);
    }
    const rootEntry = skill.entries.find((entry) => entry.path === '.');
    if (!rootEntry || rootEntry.type !== 'directory') {
      throw new Error(`${label} is missing its directory root entry`);
    }
  }
  return inventory;
}

function compareSkillEntries(expectedSkill, actualSkill, label) {
  const actualByPath = new Map(actualSkill.entries.map((entry) => [entry.path, entry]));
  const expectedFileCount = expectedSkill.entries.filter(({ type }) => type === 'file').length;
  const actualFileCount = actualSkill.entries.filter(({ type }) => type === 'file').length;
  if (actualFileCount < expectedFileCount) {
    throw new Error(
      `${label} ${expectedSkill.name}: file count collapsed from ${expectedFileCount} to ${actualFileCount}`,
    );
  }
  for (const expectedEntry of expectedSkill.entries) {
    const actualEntry = actualByPath.get(expectedEntry.path);
    if (!actualEntry) {
      if (expectedSkill.declaredScripts?.some(({ path: declaredPath }) => declaredPath === expectedEntry.path)) {
        throw new Error(`${label} ${expectedSkill.name}: declared script missing: ${expectedEntry.path}`);
      }
      throw new Error(`${label} ${expectedSkill.name}: entry missing: ${expectedEntry.path}`);
    }
    for (const field of ['type', 'sha256', 'mode']) {
      if (actualEntry[field] !== expectedEntry[field]) {
        throw new Error(`${label} ${expectedSkill.name}: entry changed: ${expectedEntry.path} (${field})`);
      }
    }
  }
  const expectedPaths = new Set(expectedSkill.entries.map((entry) => entry.path));
  for (const actualEntry of actualSkill.entries) {
    if (!expectedPaths.has(actualEntry.path)) {
      throw new Error(`${label} ${expectedSkill.name}: unexpected entry: ${actualEntry.path}`);
    }
  }
}

export function verifyExactSkillsBackup(expected, backup) {
  assertExactSkillsInventory(expected);
  assertExactSkillsInventory(backup);
  const backupByName = new Map(backup.skills.map((skill) => [skill.name, skill]));
  for (const skill of expected.skills) {
    const backedUp = backupByName.get(skill.name);
    if (!backedUp) {
      throw new Error(`Skills transaction backup incomplete for ${skill.name}: top-level directory missing`);
    }
    compareSkillEntries(skill, backedUp, 'Skills transaction backup incomplete for');
  }
  const expectedNames = new Set(expected.skills.map((skill) => skill.name));
  for (const skill of backup.skills) {
    if (!expectedNames.has(skill.name)) {
      throw new Error(`Skills transaction backup incomplete: unexpected top-level directory: ${skill.name}`);
    }
  }
}

export function verifyPostSyncSkillsContinuity(expected, current) {
  assertExactSkillsInventory(expected);
  assertExactSkillsInventory(current);
  if (current.root !== expected.root) {
    throw new Error(`Post-sync skills continuity scanned unexpected root: ${current.root}`);
  }
  const currentByName = new Map(current.skills.map((skill) => [skill.name, skill]));
  for (const skill of expected.skills) {
    const installed = currentByName.get(skill.name);
    if (!installed) {
      throw new Error(`Post-sync skills continuity failed for ${skill.name}: top-level directory missing`);
    }
    if (skill.ownedByTarget) continue;
    compareSkillEntries(skill, installed, 'Post-sync skills continuity failed for foreign skill');
  }
}
