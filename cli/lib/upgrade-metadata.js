import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { atomicWriteJson, removeDurably } from './atomic-json.js';
import { updateComponentsRegistry } from './components-registry.js';
import { CONFIG_DIR, SKILLS_DIR } from './config.js';
import { captureProcessIdentity, inspectProcessIdentity } from './process-identity.js';
import { isValidGitHubRepository } from './component-repo-override.js';

const JOURNAL_DIR = path.join(CONFIG_DIR, 'upgrade-metadata-transactions');
const SOURCE_MARKER = '.zylos-source.json';
const JOURNAL_SCHEMA_VERSION = 2;

function assertPlainObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
}

function assertTimestamp(value, label) {
  const isoTimestamp = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
  if (value !== undefined && (
    typeof value !== 'string'
    || !isoTimestamp.test(value)
    || Number.isNaN(Date.parse(value))
  )) {
    throw new Error(`${label} must be an ISO timestamp`);
  }
}

export function validateUpgradeSource(source) {
  assertPlainObject(source, 'upgrade source');
  if (source.type !== 'github-release') throw new Error('upgrade source type must be github-release');
  if (!isValidGitHubRepository(source.repo)) {
    throw new Error('upgrade source repo must be owner/name');
  }
  if (typeof source.ref !== 'string' || source.ref.length === 0) {
    throw new Error('upgrade source ref is required');
  }
  if (!['commit', 'branch', 'tag'].includes(source.refType)) {
    throw new Error('upgrade source refType must be commit, branch, or tag');
  }
  if (source.refType === 'commit' && !/^[0-9a-f]{40}$/i.test(source.ref)) {
    throw new Error('commit source ref must be a full 40-hex SHA');
  }
  if (source.refType !== 'commit' && /^[0-9a-f]{40}$/i.test(source.ref)) {
    throw new Error('a full commit SHA must use refType commit');
  }
  assertTimestamp(source.installedAt, 'upgrade source installedAt');
  return source;
}

function readLegacyMarker(markerPath) {
  if (!fs.existsSync(markerPath)) return null;
  let marker;
  try {
    marker = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
  } catch (err) {
    throw new Error(`Existing source marker is invalid: ${err.message}`);
  }
  assertPlainObject(marker, 'existing source marker');
  if (typeof marker.repo !== 'string' || marker.repo.length === 0) {
    throw new Error('existing source marker repo is required');
  }
  if (typeof marker.version !== 'string' || marker.version.length === 0) {
    throw new Error('existing source marker version is required');
  }
  if (marker.sha !== undefined && !/^[0-9a-f]{40}$/i.test(marker.sha)) {
    throw new Error('existing source marker sha must be a full 40-hex SHA');
  }
  assertTimestamp(marker.installedAt, 'existing source marker installedAt');
  assertTimestamp(marker.upgradedAt, 'existing source marker upgradedAt');
  return marker;
}

function assertTargetMarker(marker) {
  assertPlainObject(marker, 'source marker');
  validateUpgradeSource({
    type: 'github-release',
    repo: marker.repo,
    ref: marker.ref,
    refType: marker.refType,
    ...(marker.installedAt ? { installedAt: marker.installedAt } : {}),
  });
  if (typeof marker.version !== 'string' || marker.version.length === 0) {
    throw new Error('source marker version is required');
  }
  if (marker.refType === 'commit' && marker.sha !== marker.ref) {
    throw new Error('source marker sha must equal its commit ref');
  }
  if (marker.refType !== 'commit' && marker.sha !== undefined) {
    throw new Error('non-commit source marker must not claim a sha');
  }
  assertTimestamp(marker.upgradedAt, 'source marker upgradedAt');
}

export function buildUpgradeMetadata({ component, skillDir, version, source, registryEntry }) {
  validateUpgradeSource(source);
  if (typeof version !== 'string' || version.length === 0) {
    throw new Error('installed component version is required for source provenance');
  }
  const expectedSkillDir = path.join(SKILLS_DIR, component);
  if (path.resolve(skillDir) !== path.resolve(expectedSkillDir)) {
    throw new Error(`unexpected component skill directory: ${skillDir}`);
  }
  const previous = readLegacyMarker(path.join(skillDir, SOURCE_MARKER));
  const upgradedAt = new Date().toISOString();
  const installedAt = previous?.installedAt || source.installedAt;
  const marker = {
    repo: source.repo,
    ...(source.refType === 'commit' ? { sha: source.ref } : {}),
    ref: source.ref,
    refType: source.refType,
    version,
    ...(installedAt ? { installedAt } : {}),
    upgradedAt,
  };
  assertTargetMarker(marker);

  let targetRegistryEntry = null;
  if (registryEntry !== undefined && registryEntry !== null) {
    assertPlainObject(registryEntry, 'component registry entry');
    targetRegistryEntry = {
      version,
      repo: source.repo,
      upgradedAt,
      ...(installedAt ? { installedAt } : {}),
      source: {
        type: source.type,
        repo: source.repo,
        ref: source.ref,
        refType: source.refType,
      },
    };
    if (source.refType === 'tag') delete targetRegistryEntry.branch;
    else targetRegistryEntry.branch = source.ref;
  }

  return { marker, targetRegistryEntry };
}

function journalPath(component) {
  if (typeof component !== 'string' || !/^[A-Za-z0-9._-]+$/.test(component)) {
    throw new Error(`invalid component name for metadata transaction: ${component}`);
  }
  return path.join(JOURNAL_DIR, `${component}.json`);
}

function inspectBaselineCommit(journal) {
  const manifestPath = path.join(journal.skillDir, '.zylos', 'manifest.json');
  let raw;
  try {
    raw = fs.readFileSync(manifestPath, 'utf8');
  } catch (err) {
    return err?.code === 'ENOENT'
      ? { state: 'PROVABLY_UNCOMMITTED', reason: 'manifest_missing' }
      : { state: 'UNKNOWN', reason: `manifest_read_failed: ${err.message}` };
  }

  let manifest;
  try {
    manifest = JSON.parse(raw);
  } catch (err) {
    return { state: 'UNKNOWN', reason: `manifest_json_invalid: ${err.message}` };
  }
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    return { state: 'UNKNOWN', reason: 'manifest_root_invalid' };
  }
  if (!manifest.files || typeof manifest.files !== 'object' || Array.isArray(manifest.files)) {
    return { state: 'UNKNOWN', reason: 'manifest_files_invalid' };
  }
  if (
    typeof manifest.generated_at !== 'string'
    || Number.isNaN(Date.parse(manifest.generated_at))
  ) {
    return { state: 'UNKNOWN', reason: 'manifest_generated_at_invalid' };
  }
  if (manifest.metadata_transaction_id === journal.id) {
    return { state: 'COMMITTED', reason: 'matching_transaction_id' };
  }
  if (
    manifest.metadata_transaction_id === undefined
    || (
      typeof manifest.metadata_transaction_id === 'string'
      && manifest.metadata_transaction_id.length > 0
    )
  ) {
    return { state: 'PROVABLY_UNCOMMITTED', reason: 'different_transaction_id' };
  }
  return { state: 'UNKNOWN', reason: 'manifest_transaction_id_invalid' };
}

function validateJournal(journal, expectedPath) {
  assertPlainObject(journal, 'upgrade metadata journal');
  if (journal.schemaVersion !== JOURNAL_SCHEMA_VERSION) throw new Error('unsupported upgrade metadata journal schema');
  if (journalPath(journal.component) !== expectedPath) throw new Error('upgrade metadata journal path mismatch');
  if (typeof journal.id !== 'string' || journal.id.length === 0) throw new Error('upgrade metadata journal id is required');
  assertPlainObject(journal.owner, 'upgrade metadata journal owner');
  if (!Number.isSafeInteger(journal.owner.pid) || journal.owner.pid <= 0) {
    throw new Error('upgrade metadata journal owner pid must be a positive integer');
  }
  if (typeof journal.owner.startToken !== 'string' || journal.owner.startToken.length === 0) {
    throw new Error('upgrade metadata journal owner startToken is required');
  }
  const expectedSkillDir = path.join(SKILLS_DIR, journal.component);
  if (path.resolve(journal.skillDir) !== path.resolve(expectedSkillDir)) {
    throw new Error('upgrade metadata journal skill directory mismatch');
  }
  if (journal.markerPath !== path.join(expectedSkillDir, SOURCE_MARKER)) {
    throw new Error('upgrade metadata journal marker path mismatch');
  }
  assertTargetMarker(journal.marker);
  if (journal.targetRegistryEntry !== null) {
    assertPlainObject(journal.targetRegistryEntry, 'target registry entry');
    const target = journal.targetRegistryEntry;
    if (target.version !== journal.marker.version) throw new Error('target registry version does not match marker');
    if (target.repo !== journal.marker.repo) throw new Error('target registry repo does not match marker');
    if (target.upgradedAt !== journal.marker.upgradedAt) throw new Error('target registry upgradedAt does not match marker');
    if (target.installedAt !== journal.marker.installedAt) throw new Error('target registry installedAt does not match marker');
    assertPlainObject(target.source, 'target registry source');
    validateUpgradeSource(target.source);
    if (
      target.source.repo !== journal.marker.repo
      || target.source.ref !== journal.marker.ref
      || target.source.refType !== journal.marker.refType
    ) {
      throw new Error('target registry source does not match marker');
    }
    if (journal.marker.refType === 'tag' && Object.hasOwn(target, 'branch')) {
      throw new Error('tag target registry entry must not contain branch');
    }
    if (journal.marker.refType !== 'tag' && target.branch !== journal.marker.ref) {
      throw new Error('target registry branch does not match marker ref');
    }
  }
  assertTimestamp(journal.createdAt, 'upgrade metadata journal createdAt');
}

export function beginUpgradeMetadataTransaction({ component, skillDir, marker, targetRegistryEntry, manifest }) {
  assertTargetMarker(marker);
  const pathForJournal = journalPath(component);
  if (fs.existsSync(pathForJournal)) {
    recoverUpgradeMetadataTransactions({ component });
    if (fs.existsSync(pathForJournal)) throw new Error(`pending metadata transaction exists for ${component}`);
  }
  const id = crypto.randomUUID();
  const journal = {
    schemaVersion: JOURNAL_SCHEMA_VERSION,
    id,
    owner: captureProcessIdentity(),
    component,
    skillDir,
    markerPath: path.join(skillDir, SOURCE_MARKER),
    marker,
    targetRegistryEntry: targetRegistryEntry || null,
    createdAt: new Date().toISOString(),
  };
  validateJournal(journal, pathForJournal);
  atomicWriteJson(pathForJournal, journal, { mode: 0o600 });
  return {
    journal,
    manifest: { ...manifest, metadata_transaction_id: id },
  };
}

export function finalizeUpgradeMetadataTransaction(journal) {
  const pathForJournal = journalPath(journal.component);
  validateJournal(journal, pathForJournal);
  const baseline = inspectBaselineCommit(journal);
  if (baseline.state !== 'COMMITTED') {
    throw new Error(
      `baseline commit state is ${baseline.state} for metadata transaction ${journal.id}: ${baseline.reason}`,
    );
  }
  atomicWriteJson(journal.markerPath, journal.marker, { mode: 0o600 });
  if (journal.targetRegistryEntry) {
    updateComponentsRegistry(components => {
      assertPlainObject(components[journal.component], `registered component ${journal.component}`);
      components[journal.component] = {
        ...components[journal.component],
        ...journal.targetRegistryEntry,
      };
      if (journal.marker.refType === 'tag') delete components[journal.component].branch;
      return components;
    });
  }
  removeDurably(pathForJournal);
  return {
    marker: journal.marker,
    targetRegistryEntry: journal.targetRegistryEntry,
  };
}

export function abortUpgradeMetadataTransaction(journal) {
  validateJournal(journal, journalPath(journal.component));
  const baseline = inspectBaselineCommit(journal);
  if (baseline.state === 'COMMITTED') return finalizeUpgradeMetadataTransaction(journal);
  if (baseline.state === 'UNKNOWN') {
    throw new Error(
      `cannot abort metadata transaction ${journal.id}; baseline state is UNKNOWN: ${baseline.reason}`,
    );
  }
  removeDurably(journalPath(journal.component));
  return { aborted: true };
}

export function recoverUpgradeMetadataTransactions({ component } = {}) {
  let journalNames;
  try {
    journalNames = fs.readdirSync(JOURNAL_DIR);
  } catch (err) {
    if (err?.code === 'ENOENT') return [];
    throw new Error(`cannot inspect upgrade metadata journals: ${err.message}`);
  }
  const paths = component
    ? (journalNames.includes(`${component}.json`) ? [journalPath(component)] : [])
    : journalNames
      .filter(name => name.endsWith('.json'))
      .map(name => path.join(JOURNAL_DIR, name));
  const results = [];
  for (const pathForJournal of paths) {
    const journal = JSON.parse(fs.readFileSync(pathForJournal, 'utf8'));
    validateJournal(journal, pathForJournal);
    const baseline = inspectBaselineCommit(journal);
    if (baseline.state === 'COMMITTED') {
      finalizeUpgradeMetadataTransaction(journal);
      results.push({ component: journal.component, action: 'rolled_forward' });
    } else if (baseline.state === 'UNKNOWN') {
      throw new Error(
        `metadata recovery HOLD for ${journal.component}; baseline state is UNKNOWN: ${baseline.reason}; `
        + `preserved ${pathForJournal}`,
      );
    } else {
      const owner = inspectProcessIdentity(journal.owner);
      if (owner.state === 'ALIVE') {
        results.push({ component: journal.component, action: 'in_progress' });
        continue;
      }
      throw new Error(
        `metadata recovery HOLD for ${journal.component}; uncommitted owner is ${owner.state} `
        + `(${owner.reason}) and business rollback cannot be proven; preserved ${pathForJournal}`,
      );
    }
  }
  return results;
}
