/**
 * Self-upgrade logic for zylos-core itself.
 * Downloads new version via GitHub tarball, syncs Core Skills with
 * manifest-based preservation, and runs npm install -g from local path.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execSync, spawnSync } from 'node:child_process';
import { SKILLS_DIR, ZYLOS_DIR, getZylosConfig } from './config.js';
import { downloadArchive, downloadBranch } from './download.js';
import { generateManifest, saveMergeBaseline } from './manifest.js';
import { fetchRawFile, fetchLatestTag, compareSemverDesc, sanitizeError } from './github.js';
import { copyTree, syncTree } from './fs-utils.js';
import { getCommandHooks, hookScriptKey } from './hook-utils.js';
import { isCoreManaged } from './sync-settings-hooks.js';
import { smartSync, formatMergeResult } from './smart-merge.js';
import { getAllowedTmpRoots } from './upgrade.js';
import { runMigrations } from './migrate.js';
import {
  CURRENT_INSTRUCTION_FORMAT_VERSION,
  instructionPaths,
  readInstructionFormatVersion,
  refreshSplitInstructions,
  writeInstructionFormatVersion,
} from './runtime/instruction-builder.js';
import {
  classifyInstructionBaseline,
  cleanupMigrationPrompt,
  executeMigrationApply,
  loadInstructionCatalog,
  migrationPromptPath,
  sha256,
  verifyInstructionConservation,
  writeMigrationPrompt,
} from './instruction-migration.js';
import { deployManifestTemplate } from './runtime/tmux-env.js';
import { writeCodexConfig } from './runtime-setup.js';
import { getCoreEcosystemPath, restartManagedProcess } from './pm2.js';
import {
  verifyCommunicationAssets,
  verifyCommunicationContinuity,
} from './communication-continuity.js';
import { readEnvFile } from './env.js';

// Services that must be present for upgraded Core behavior to function. During
// an upgrade we start one only when the machine was already running Zylos and
// PM2 has no record of that service at all. A deliberately stopped process is
// therefore preserved, while a process introduced by the new release is not
// silently omitted from the old process list.
const UPGRADE_REQUIRED_CORE_SERVICES = [
  {
    name: 'c4-response-stream-supervisor',
    script: ['comm-bridge', 'scripts', 'c4-response-stream-supervisor.js'],
  },
];

// Only these process definitions are owned by Core's ecosystem file. Other
// services discovered under SKILLS_DIR belong to installed components and
// must be restarted from their existing PM2 definition; forcing a component
// name through the Core ecosystem can silently leave it stopped.
const CORE_ECOSYSTEM_SERVICE_NAMES = Object.freeze([
  'scheduler',
  'web-console',
  'c4-dispatcher',
  'c4-intake-supervisor',
  'c4-response-stream-supervisor',
  'activity-monitor',
  'caddy',
]);

const DEFAULT_FINALIZER_TIMEOUT_MS = 900_000;
const MIN_FINALIZER_TIMEOUT_MS = 180_000;

export function resolveSelfUpgradeFinalizerTimeoutMs(processEnv = process.env) {
  const raw = String(processEnv.ZYLOS_SELF_UPGRADE_FINALIZER_TIMEOUT_MS || '').trim();
  if (!raw) return DEFAULT_FINALIZER_TIMEOUT_MS;

  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_FINALIZER_TIMEOUT_MS;
  return Math.max(Math.trunc(parsed), MIN_FINALIZER_TIMEOUT_MS);
}

// Patch #6 (3AI fork layer): allow self-upgrade to target an alternate repo
// (e.g. the 3AI fork) via the ZYLOS_SELF_UPGRADE_REPO env var. Value is an
// `owner/repo` slug (e.g. `HeXiaobo/zylos-core`). Default stays canonical, so
// normal upgrades on machines that do not set it are unaffected, and it makes
// fork-based upgrades ratifiable without hand-editing installed code on every
// machine.
//   NOTE — deliberately NOT named ZYLOS_REPO: scripts/install.sh already uses
//   ZYLOS_REPO with a DIFFERENT meaning (a full URL, for fresh installs). Same
//   name + two meanings (URL vs slug) would silently mis-resolve here, so the
//   self-upgrade override gets its own name.
//   The same variable is consumed by doctor, activity-monitor, the installer,
//   and changelog lookup so check and download sources cannot drift apart.
//   Stable no-branch upgrades still require a release tag in the selected repo.
export function resolveCoreRepository({ processEnv = process.env, readEnv = readEnvFile } = {}) {
  const processValue = String(processEnv.ZYLOS_SELF_UPGRADE_REPO || '').trim();
  if (processValue) return processValue;

  try {
    const fileValue = String(readEnv().get('ZYLOS_SELF_UPGRADE_REPO') || '').trim();
    if (fileValue) return fileValue;
  } catch {
    // An absent or unreadable persisted config must not make the CLI unusable.
  }

  return 'zylos-ai/zylos-core';
}

export const CORE_REPO = resolveCoreRepository();
const REPO = CORE_REPO;

// ---------------------------------------------------------------------------
// Version helpers
// ---------------------------------------------------------------------------

/**
 * Get current installed zylos-core version from package.json.
 */
export function getCurrentVersion() {
  const pkgPath = path.join(import.meta.dirname, '..', '..', 'package.json');
  try {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    return { success: true, version: pkg.version };
  } catch (err) {
    return { success: false, error: `Cannot read package.json: ${err.message}` };
  }
}

/**
 * Get latest zylos-core version from GitHub.
 * Uses tag-based detection (unified with component upgrades).
 * Falls back to package.json on a branch when --branch is specified.
 *
 * @param {object} [opts]
 * @param {string} [opts.branch] - Branch to read from (reads package.json from branch)
 * @param {boolean} [opts.beta=false] - Include prerelease (beta) tags
 */
function getLatestVersion({ branch, beta = false } = {}) {
  // When --branch is specified, read package.json from that branch
  if (branch) {
    try {
      const content = fetchRawFile(REPO, 'package.json', branch);
      const pkg = JSON.parse(content);
      return { success: true, version: pkg.version };
    } catch (err) {
      return { success: false, error: `Cannot fetch latest version: ${sanitizeError(err.message)}` };
    }
  }

  // Default: tag-based detection (unified with component upgrades)
  try {
    const tagVersion = fetchLatestTag(REPO, { includePrerelease: beta });
    if (tagVersion) {
      return { success: true, version: tagVersion };
    }
    return { success: false, error: 'No release tags found' };
  } catch (err) {
    return { success: false, error: `Cannot fetch latest version: ${sanitizeError(err.message)}` };
  }
}

// ---------------------------------------------------------------------------
// Public: checkForCoreUpdates
// ---------------------------------------------------------------------------

/**
 * Check if zylos-core has updates available.
 *
 * @param {object} [opts]
 * @param {string} [opts.branch] - Branch to compare against
 * @param {boolean} [opts.beta=false] - Include prerelease (beta) versions
 * @returns {object} { success, hasUpdate, current, latest }
 */
export function checkForCoreUpdates({ branch, beta = false } = {}) {
  const current = getCurrentVersion();
  if (!current.success) {
    return { success: false, error: 'version_not_found', message: current.error };
  }

  const latest = getLatestVersion({ branch, beta });
  if (!latest.success) {
    return { success: false, error: 'remote_version_failed', message: latest.error };
  }

  // Use semver comparison (not string inequality) to avoid suggesting downgrades.
  // compareSemverDesc(a, b) > 0 means b is higher than a.
  const hasUpdate = compareSemverDesc(current.version, latest.version) > 0;

  return {
    success: true,
    hasUpdate,
    current: current.version,
    latest: latest.version,
  };
}

// ---------------------------------------------------------------------------
// Public: downloadCoreToTemp
// ---------------------------------------------------------------------------

/**
 * Download a zylos-core version to temp directory.
 *
 * @param {string} version
 * @returns {{ success: boolean, tempDir?: string, error?: string }}
 */
function getWritableTmpBase(prefix = 'zylos-self-upgrade-probe-') {
  let base = os.tmpdir();
  try {
    const probe = fs.mkdtempSync(path.join(base, prefix));
    fs.rmSync(probe, { recursive: true, force: true });
  } catch {
    // System tmp unavailable — fallback to ~/tmp
    base = path.join(os.homedir(), 'tmp');
    fs.mkdirSync(base, { recursive: true });
  }
  return base;
}

export function downloadCoreToTemp(version, branch) {
  const base = getWritableTmpBase('zylos-self-upgrade-probe-');
  const tempDir = fs.mkdtempSync(path.join(base, 'zylos-self-upgrade-'));

  if (branch) {
    const branchResult = downloadBranch(REPO, branch, tempDir);
    if (!branchResult.success) {
      fs.rmSync(tempDir, { recursive: true, force: true });
      return { success: false, error: branchResult.error };
    }
    return { success: true, tempDir };
  }

  const result = downloadArchive(REPO, version, tempDir);
  if (!result.success) {
    // Fallback: try downloading main branch (for pre-release versions without tags)
    const branchResult = downloadBranch(REPO, 'main', tempDir);
    if (!branchResult.success) {
      fs.rmSync(tempDir, { recursive: true, force: true });
      return { success: false, error: result.error };
    }
  }

  return { success: true, tempDir };
}

// ---------------------------------------------------------------------------
// Public: readChangelog
// ---------------------------------------------------------------------------

/**
 * Read CHANGELOG.md from a directory.
 */
export function readChangelog(dir) {
  const changelogPath = path.join(dir, 'CHANGELOG.md');
  if (!fs.existsSync(changelogPath)) return null;
  try {
    return fs.readFileSync(changelogPath, 'utf8');
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Core Skills sync
// ---------------------------------------------------------------------------

/**
 * Sync Core Skills from new version to SKILLS_DIR using smart merge.
 *
 * Strategy (per file):
 * - Local unmodified → overwrite with new version
 * - Local modified, new unchanged → keep local
 * - Both changed → try diff3 three-way merge; if conflict → overwrite + backup local
 * - New skill (not installed) → copy fresh
 *
 * No "preserve" — every file gets a definitive outcome.
 * Backup serves as safety net for conflict files.
 *
 * @param {string} newSkillsSrc - Path to skills/ in downloaded temp dir
 * @param {string} [backupBase] - Base directory for conflict backups
 * @param {object} [opts]
 * @param {string} [opts.mode] - 'merge' (default) or 'overwrite'
 * @returns {{ synced: string[], added: string[], merged: string[], deleted: string[], preserved: string[], conflicts: { skill: string, file: string, backupPath: string }[], errors: string[], pendingBaselines: { destDir: string, srcDir: string, manifest: object }[] }}
 */
export function syncCoreSkills(newSkillsSrc, backupBase, opts = {}) {
  const result = { synced: [], added: [], merged: [], deleted: [], preserved: [], conflicts: [], errors: [], pendingBaselines: [] };

  if (!fs.existsSync(newSkillsSrc)) {
    return result;
  }

  if (!fs.existsSync(SKILLS_DIR)) {
    fs.mkdirSync(SKILLS_DIR, { recursive: true });
  }

  const entries = fs.readdirSync(newSkillsSrc, { withFileTypes: true });

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const skillName = entry.name;
    const srcDir = path.join(newSkillsSrc, skillName);
    const destDir = path.join(SKILLS_DIR, skillName);

    if (!fs.existsSync(destDir)) {
      // New skill — copy entirely and defer its baseline to the outer commit.
      // Manifest is generated from the SOURCE (authoritative package), never
      // from a destDir scan, so pre-existing local files are not absorbed
      // into the ownership record (issue #715).
      try {
        copyTree(srcDir, destDir);
        result.pendingBaselines.push({ destDir, srcDir, manifest: generateManifest(srcDir) });
        result.added.push(skillName);
      } catch (err) {
        result.errors.push(`${skillName}: ${err.message}`);
      }
      continue;
    }

    // Existing skill — smart merge
    try {
      const skillBackupDir = backupBase ? path.join(backupBase, skillName) : null;
      const mergeResult = smartSync(srcDir, destDir, {
        backupDir: skillBackupDir,
        mode: opts.mode,
      });

      // Aggregate results
      if (mergeResult.overwritten.length || mergeResult.added.length || mergeResult.deleted.length
          || mergeResult.preserved.length) {
        result.synced.push(skillName);
      }
      if (mergeResult.merged.length) {
        result.merged.push(...mergeResult.merged.map(f => `${skillName}/${f}`));
      }
      if (mergeResult.deleted.length) {
        result.deleted.push(...mergeResult.deleted.map(f => `${skillName}/${f}`));
      }
      if (mergeResult.preserved.length) {
        result.preserved.push(...mergeResult.preserved.map(f => `${skillName}/${f}`));
      }
      if (mergeResult.conflicts.length) {
        for (const c of mergeResult.conflicts) {
          result.conflicts.push({ skill: skillName, file: c.file, backupPath: c.backupPath });
        }
      }
      if (mergeResult.errors.length) {
        result.errors.push(...mergeResult.errors.map(e => `${skillName}: ${e}`));
      } else {
        result.pendingBaselines.push({ destDir, srcDir, manifest: mergeResult.nextManifest });
      }

    } catch (err) {
      result.errors.push(`${skillName}: ${err.message}`);
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Template helpers
// ---------------------------------------------------------------------------

/**
 * List all files in templates/ directory recursively.
 * Returns relative paths for Claude to compare with local structure.
 */
function listTemplateFiles(templatesDir) {
  const files = [];
  if (!templatesDir) return files;
  if (!fs.existsSync(templatesDir)) return files;

  function walk(dir, prefix = '') {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walk(path.join(dir, entry.name), rel);
      } else {
        files.push(rel);
      }
    }
  }

  walk(templatesDir);
  return files;
}

/**
 * Compare template settings.json hooks with installed settings.json.
 * Matches hooks by script path (not full command string) to detect:
 *  - missing_hook:  in template, not installed
 *  - modified_hook: same script path, different command or timeout
 *  - removed_hook:  in installed, not in template (core skills only)
 */
export function generateMigrationHints(templatesDir, deps = {}) {
  const hints = [];
  const zylosDir = deps.zylosDir ?? ZYLOS_DIR;
  const existsSync = deps.existsSync ?? fs.existsSync;
  const readFileSync = deps.readFileSync ?? fs.readFileSync;

  const templateSettingsPath = path.join(templatesDir, '.claude', 'settings.json');
  if (!existsSync(templateSettingsPath)) return hints;

  const installedSettingsPath = path.join(zylosDir, '.claude', 'settings.json');

  let templateSettings, installedSettings;
  try {
    templateSettings = JSON.parse(readFileSync(templateSettingsPath, 'utf8'));
  } catch {
    return hints;
  }
  try {
    installedSettings = existsSync(installedSettingsPath)
      ? JSON.parse(readFileSync(installedSettingsPath, 'utf8'))
      : {};
  } catch {
    installedSettings = {};
  }

  const templateHooks = templateSettings.hooks || {};
  const installedHooks = installedSettings.hooks || {};

  // --- Forward pass: detect missing and modified hooks ---
  for (const [event, matchers] of Object.entries(templateHooks)) {
    if (!Array.isArray(matchers)) continue;
    const installedMatchers = Array.isArray(installedHooks[event]) ? installedHooks[event] : [];

    for (const matcher of matchers) {
      for (const templateCmd of getCommandHooks(matcher)) {
        const templateKey = hookScriptKey(templateCmd.command);

        // Find installed hook with the same script path
        let matched = null;
        for (const im of installedMatchers) {
          matched = getCommandHooks(im).find(
            h => hookScriptKey(h.command) === templateKey
          );
          if (matched) break;
        }

        if (!matched) {
          hints.push({
            type: 'missing_hook',
            event,
            hook: { ...templateCmd },
            matcher: matcher.matcher !== undefined ? matcher.matcher : null,
            // Keep flat fields for backward compatibility
            command: templateCmd.command,
            timeout: templateCmd.timeout,
          });
        } else if (matched.command !== templateCmd.command || matched.timeout !== templateCmd.timeout) {
          hints.push({
            type: 'modified_hook',
            event,
            hook: { ...templateCmd },
            command: templateCmd.command,
            timeout: templateCmd.timeout,
            oldCommand: matched.command,
            oldTimeout: matched.timeout,
          });
        }
      }
    }
  }

  // --- statusLine sync ---
  if (templateSettings.statusLine) {
    const tsl = JSON.stringify(templateSettings.statusLine);
    const isl = JSON.stringify(installedSettings.statusLine || null);
    if (tsl !== isl) {
      hints.push({
        type: 'statusLine',
        value: templateSettings.statusLine,
      });
    }
  } else if (installedSettings.statusLine) {
    // Template removed statusLine — generate removal hint
    hints.push({
      type: 'statusLine_remove',
    });
  }

  if (Object.hasOwn(templateSettings, 'model') && !Object.hasOwn(installedSettings, 'model')) {
    let model = templateSettings.model;
    const cfg = (deps.getConfig ?? getZylosConfig)();
    if (model.includes('[1m]') && Object.hasOwn(cfg, 'new_session_threshold') && cfg.new_session_threshold > 30) {
      model = model.replace('[1m]', '');
    }
    hints.push({
      type: 'model_backfill',
      value: model,
    });
  }

  // Backfill boolean settings (autoMemoryEnabled, autoDreamEnabled)
  for (const key of ['autoMemoryEnabled', 'autoDreamEnabled']) {
    if (Object.hasOwn(templateSettings, key) && !Object.hasOwn(installedSettings, key)) {
      hints.push({
        type: 'setting_backfill',
        key,
        value: templateSettings[key],
      });
    }
  }

  // --- Reverse pass: detect removed hooks (core skills only) ---
  for (const [event, matchers] of Object.entries(installedHooks)) {
    if (!Array.isArray(matchers)) continue;
    const templateMatchers = Array.isArray(templateHooks[event]) ? templateHooks[event] : [];

    for (const matcher of matchers) {
      for (const installedCmd of getCommandHooks(matcher)) {
        if (!isCoreManaged(installedCmd)) continue;

        const installedKey = hookScriptKey(installedCmd.command);
        const foundInTemplate = templateMatchers.some(tm =>
          getCommandHooks(tm).some(
            h => hookScriptKey(h.command) === installedKey
          )
        );

        if (!foundInTemplate) {
          hints.push({
            type: 'removed_hook',
            event,
            command: installedCmd.command,
            timeout: installedCmd.timeout,
          });
        }
      }
    }
  }

  return hints;
}

// ---------------------------------------------------------------------------
// 15-stage self-upgrade pipeline (steps 0-14)
// ---------------------------------------------------------------------------

/**
 * Create self-upgrade context.
 */
function createContext({ tempDir, newVersion, mode } = {}) {
  const coreDir = path.join(import.meta.dirname, '..', '..');

  return {
    coreDir,
    tempDir: tempDir || null,
    newVersion: newVersion || null,
    mode: mode || 'merge',
    // State tracking
    backupDir: null,
    servicesStopped: [],
    servicesWereRunning: [],
    cronServicesWereRunning: [],
    servicesExpectedAfterUpgrade: [],
    servicesStartedByUpgrade: [],
    mergeConflicts: [],
    mergedFiles: [],
    // Results
    steps: [],
    from: null,
    to: null,
    success: false,
    error: null,
  };
}

/**
 * Step 0: fail closed before mutation unless the target release declares both
 * the rolling legacy compatibility seam and the safe file-backed reply seam.
 */
export function step0_verifyTargetCommunicationCompatibility(ctx, deps = {}) {
  const startTime = Date.now();
  const fsApi = deps.fs ?? fs;
  const manifestPath = path.join(ctx.tempDir || '', 'capabilities.json');

  try {
    const target = JSON.parse(fsApi.readFileSync(manifestPath, 'utf8'));
    const requiredProtocols = ['c4.reply.argv-compat', 'c4.reply.body-file'];
    const protocolVersions = {};
    for (const protocol of requiredProtocols) {
      const actual = target?.protocols?.[protocol];
      if (!Number.isInteger(actual) || actual < 1) {
        return {
          step: 0,
          name: 'verify_target_communication_compatibility',
          status: 'failed',
          error: `Protocol ${protocol} requires >= 1, found ${actual ?? 'missing'}`,
          duration: Date.now() - startTime,
        };
      }
      protocolVersions[protocol] = actual;
    }
    const assets = verifyCommunicationAssets({
      skillsDir: path.join(ctx.tempDir || '', 'skills'),
      fsApi,
    });
    if (!assets.compatible) {
      return {
        step: 0,
        name: 'verify_target_communication_compatibility',
        status: 'failed',
        error: assets.error,
        duration: Date.now() - startTime,
      };
    }
    return {
      step: 0,
      name: 'verify_target_communication_compatibility',
      status: 'done',
      message: requiredProtocols
        .map((protocol) => `${protocol}=${protocolVersions[protocol]}`)
        .concat(`${assets.checked.length} critical assets`)
        .join('; '),
      duration: Date.now() - startTime,
    };
  } catch (err) {
    return {
      step: 0,
      name: 'verify_target_communication_compatibility',
      status: 'failed',
      error: `Target capabilities could not be read: ${err.message}`,
      duration: Date.now() - startTime,
    };
  }
}

/**
 * Step 1: backup Core Skills
 */
export function step1_backupCoreSkills(ctx, deps = {}) {
  const startTime = Date.now();
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupDir = deps.backupDir
    ?? path.join(getWritableTmpBase('zylos-core-backup-probe-'), `zylos-core-backup-${timestamp}`);
  const zylosDir = deps.zylosDir ?? ZYLOS_DIR;
  const skillsDir = deps.skillsDir ?? SKILLS_DIR;
  const copyTreeFn = deps.copyTree ?? copyTree;
  const fsApi = deps.fs ?? fs;

  try {
    fsApi.mkdirSync(backupDir, { recursive: true });

    const mustBackupCorePackage = Boolean(deps.corePackageDir || ctx.globalCoreDir || ctx.coreDir);
    const resolveInstalledCorePackageDir = deps.resolveInstalledCorePackageDir
      ?? (() => resolveInstalledPackageScript());
    const corePackageDir = deps.corePackageDir
      ?? ctx.globalCoreDir
      ?? (mustBackupCorePackage ? resolveInstalledCorePackageDir() : null);
    if (mustBackupCorePackage) {
      if (!corePackageDir || !fsApi.existsSync(corePackageDir)) {
        throw new Error('Installed global Core package not found');
      }
      copyTreeFn(corePackageDir, path.join(backupDir, 'core-package'));
      ctx.globalCoreDir = corePackageDir;
    }

    // Backup the skills directory (include .zylos manifests — needed for correct rollback)
    if (fsApi.existsSync(skillsDir)) {
      copyTreeFn(skillsDir, path.join(backupDir, 'skills'), { excludes: ['node_modules'] });
    }

    const ecosystemSrc = deps.ecosystemPath ?? path.join(zylosDir, 'pm2', 'ecosystem.config.cjs');
    if (fsApi.existsSync(ecosystemSrc)) {
      const backupPm2Dir = path.join(backupDir, 'pm2');
      fsApi.mkdirSync(backupPm2Dir, { recursive: true });
      fsApi.copyFileSync(ecosystemSrc, path.join(backupPm2Dir, 'ecosystem.config.cjs'));
    }

    ctx.backupDir = backupDir;
    return { step: 1, name: 'backup_core_skills', status: 'done', duration: Date.now() - startTime };
  } catch (err) {
    return { step: 1, name: 'backup_core_skills', status: 'failed', error: err.message, duration: Date.now() - startTime };
  }
}

/**
 * Step 2: pre-upgrade hook (placeholder for future use)
 */
function step2_preUpgradeHook(ctx) {
  const startTime = Date.now();
  // No core pre-upgrade hook yet — reserved for future
  return { step: 2, name: 'pre_upgrade_hook', status: 'skipped', duration: Date.now() - startTime };
}

/**
 * Find PM2 services running from SKILLS_DIR by matching exec paths.
 * This catches ALL zylos-managed services regardless of SKILL.md declarations.
 *
 * @returns {{ name: string, status: string, autorestart: boolean|null, cronRestart: string|null }[]}
 * PM2 processes whose scripts are under SKILLS_DIR
 */
function getSkillsServices(deps = {}) {
  const execSyncFn = deps.execSync ?? execSync;
  try {
    const output = execSyncFn('pm2 jlist 2>/dev/null', { encoding: 'utf8' });
    const processes = JSON.parse(output);
    const resolved = path.resolve(SKILLS_DIR);

    return processes
      .filter(proc => {
        const execPath = proc.pm2_env?.pm_exec_path || '';
        return execPath.startsWith(resolved + '/');
      })
      .map(proc => ({
        name: proc.name,
        status: proc.pm2_env?.status,
        autorestart: proc.pm2_env?.autorestart ?? null,
        cronRestart: proc.pm2_env?.cron_restart ?? null,
      }));
  } catch {
    return [];
  }
}

/**
 * Step 3: stop core services
 */
export function step3_stopCoreServices(ctx, deps = {}) {
  const startTime = Date.now();
  const execSyncFn = deps.execSync ?? execSync;
  const getServices = deps.getSkillsServices ?? (() => getSkillsServices(deps));
  const stopService = deps.stopService ?? ((name) => {
    execSyncFn(`pm2 stop ${name} 2>/dev/null`, { stdio: 'pipe' });
  });

  // Find all PM2 services running from skills directory
  const services = getServices();
  const onlineServices = services.filter(s => s.status === 'online');
  ctx.cronServicesWereRunning = Array.isArray(ctx.cronServicesWereRunning)
    ? ctx.cronServicesWereRunning
    : [];

  if (services.length === 0) {
    return { step: 3, name: 'stop_core_services', status: 'skipped', message: 'no services found', duration: Date.now() - startTime };
  }

  if (onlineServices.length === 0) {
    return { step: 3, name: 'stop_core_services', status: 'done', message: 'none running', duration: Date.now() - startTime };
  }

  for (const svc of onlineServices) {
    ctx.servicesWereRunning.push(svc.name);
    if (svc.autorestart === false && String(svc.cronRestart || '').trim()) {
      ctx.cronServicesWereRunning.push(svc.name);
    }
    try {
      stopService(svc.name);
      ctx.servicesStopped.push(svc.name);
    } catch {
      // Continue even if one service fails to stop
    }
  }

  const msg = ctx.servicesStopped.length > 0 ? ctx.servicesStopped.join(', ') : 'none running';
  return { step: 3, name: 'stop_core_services', status: 'done', message: msg, duration: Date.now() - startTime };
}

/**
 * Step 4: npm pack + npm install -g tarball
 *
 * Using `npm install -g <folder>` creates a symlink to the folder.
 * Since we install from a temp dir that gets cleaned up, the symlink breaks.
 * Instead: npm pack (creates a .tgz copy) → npm install -g <tgz> (copies files).
 */
function step4_npmInstallGlobal(ctx, deps = {}) {
  const startTime = Date.now();
  const execSyncFn = deps.execSync ?? execSync;

  if (!ctx.tempDir || !fs.existsSync(ctx.tempDir)) {
    return { step: 4, name: 'npm_install_global', status: 'failed', error: 'Temp directory not available', duration: Date.now() - startTime };
  }

  try {
    // Pack first — creates a .tgz tarball (copies, not symlinks)
    const tarballName = execSyncFn('npm pack --pack-destination .', {
      cwd: ctx.tempDir,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();

    const tarballPath = path.join(ctx.tempDir, tarballName);

    // Install from tarball — npm copies files into global node_modules
    execSyncFn(`npm install -g --ignore-scripts "${tarballPath}"`, {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ZYLOS_SKIP_POSTINSTALL: '1' },  // Skip postinstall — we sync skills ourselves
    });
    return { step: 4, name: 'npm_install_global', status: 'done', duration: Date.now() - startTime };
  } catch (err) {
    return { step: 4, name: 'npm_install_global', status: 'failed', error: err.stderr?.trim() || err.message, duration: Date.now() - startTime };
  }
}

/**
 * Step 5: sync Core Skills (smart merge — no preserve)
 */
export function step5_syncCoreSkills(ctx, deps = {}) {
  const startTime = Date.now();
  const fsApi = deps.fs ?? fs;
  const zylosDir = deps.zylosDir ?? ZYLOS_DIR;
  const skillsDir = deps.skillsDir ?? SKILLS_DIR;
  const syncCoreSkillsFn = deps.syncCoreSkills ?? syncCoreSkills;

  const newSkillsSrc = path.join(ctx.tempDir, 'skills');
  if (!fsApi.existsSync(newSkillsSrc)) {
    return { step: 5, name: 'sync_core_skills', status: 'skipped', message: 'no skills in new version', duration: Date.now() - startTime };
  }

  try {
    // Conflict backups are durable user-recovery artifacts. Keep them outside
    // the temporary transaction snapshot, which the non-JSON success path
    // removes after the upgrade commits.
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const conflictBackupDir = path.join(zylosDir, '.backup', timestamp, 'conflicts');
    const syncResult = syncCoreSkillsFn(newSkillsSrc, conflictBackupDir, { mode: ctx.mode });

    const parts = [];
    if (syncResult.synced.length) parts.push(`${syncResult.synced.length} synced`);
    if (syncResult.added.length) parts.push(`${syncResult.added.length} added`);
    if (syncResult.merged.length) parts.push(`${syncResult.merged.length} merged`);
    if (syncResult.deleted.length) parts.push(`${syncResult.deleted.length} deleted`);
    if (syncResult.preserved.length) parts.push(`${syncResult.preserved.length} preserved`);
    if (syncResult.conflicts.length) parts.push(`${syncResult.conflicts.length} conflicts`);
    if (syncResult.errors.length) parts.push(`${syncResult.errors.length} errors`);
    const summary = parts.join(', ') || 'no changes';
    const conflictPaths = syncResult.conflicts.map(({ skill, file, backupPath }) =>
      `${skill}/${file} -> ${backupPath}`
    );
    const msg = conflictPaths.length > 0
      ? `${summary}; backups: ${conflictPaths.join('; ')}`
      : summary;

    // Store conflicts on ctx for the final result
    ctx.mergeConflicts = syncResult.conflicts;
    ctx.mergedFiles = syncResult.merged;
    ctx.pendingBaselines = syncResult.pendingBaselines;

    if (syncResult.errors.length > 0) {
      return { step: 5, name: 'sync_core_skills', status: 'failed', error: syncResult.errors.join('; '), duration: Date.now() - startTime };
    }

    const assets = verifyCommunicationAssets({ skillsDir, fsApi });
    if (!assets.compatible) {
      return {
        step: 5,
        name: 'sync_core_skills',
        status: 'failed',
        error: assets.error,
        duration: Date.now() - startTime,
      };
    }

    return {
      step: 5,
      name: 'sync_core_skills',
      status: 'done',
      message: `${msg}; ${assets.checked.length} critical assets verified`,
      duration: Date.now() - startTime,
    };
  } catch (err) {
    return { step: 5, name: 'sync_core_skills', status: 'failed', error: err.message, duration: Date.now() - startTime };
  }
}

/**
 * Step 6: install/update skill dependencies
 */
function step6_installSkillDeps(ctx) {
  const startTime = Date.now();
  const entries = fs.readdirSync(SKILLS_DIR, { withFileTypes: true });
  let installed = 0;
  const failed = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const skillDir = path.join(SKILLS_DIR, entry.name);
    const pkgPath = path.join(skillDir, 'package.json');
    if (!fs.existsSync(pkgPath)) continue;

    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      if (!pkg.dependencies || Object.keys(pkg.dependencies).length === 0) continue;

      execSync('npm install --omit=dev', {
        cwd: skillDir,
        stdio: 'pipe',
        timeout: 120000,
      });
      installed++;
    } catch {
      failed.push(entry.name);
    }
  }

  const msg = `${installed} installed${failed.length ? `, ${failed.length} failed: ${failed.join(', ')}` : ''}`;
  if (failed.length > 0) {
    return { step: 6, name: 'install_skill_deps', status: 'failed', error: msg, duration: Date.now() - startTime };
  }
  return { step: 6, name: 'install_skill_deps', status: 'done', message: msg, duration: Date.now() - startTime };
}

function step7Result(startTime, { status = 'done', message, error }) {
  return {
    step: 7,
    name: 'sync_instructions',
    status,
    ...(message ? { message } : {}),
    ...(error ? { error } : {}),
    duration: Date.now() - startTime,
  };
}

function cleanupPendingMigrationPrompt(zylosDir, deps) {
  try {
    const result = (deps.cleanupMigrationPrompt ?? cleanupMigrationPrompt)({ zylosDir });
    if (result.error) throw result.error;
    return { cleaned: true, promptPath: result.filePath };
  } catch (error) {
    (deps.warn ?? console.warn)(`Warning: could not remove stale migration prompt: ${error.message}`);
    return { cleaned: false, error };
  }
}

function pendingMigrationMessage(reason, { backupPath = null } = {}) {
  const backupNote = backupPath ? `; backup: ${backupPath}` : '';
  return `PENDING MIGRATION — ${reason}; run zylos migrate-instructions${backupNote}`;
}

/** Step 7: deploy, refresh, and migrate legacy instructions when safe. */
export function step7_syncInstructions(ctx, deps = {}) {
  const startTime = Date.now();
  const zylosDir = ctx.zylosDir || ZYLOS_DIR;
  const packageRoot = ctx.packageRoot || path.join(import.meta.dirname, '..', '..');

  const templateDir = path.join(ctx.tempDir, 'templates');
  if (!fs.existsSync(templateDir)) {
    return step7Result(startTime, { status: 'skipped', message: 'no templates in new version' });
  }

  // runtime-env.manifest — create from template if missing (upgrade path)
  // Try tempDir first, then fallback to installed package root
  let manifestSrc = path.join(templateDir, 'runtime-env.manifest.example');
  let manifestStatus = deployManifestTemplate(manifestSrc, zylosDir);
  if (manifestStatus === 'template_missing') {
    manifestSrc = path.join(packageRoot, 'templates', 'runtime-env.manifest.example');
    manifestStatus = deployManifestTemplate(manifestSrc, zylosDir);
  }
  const manifestNote = `; manifest: ${manifestStatus}`;

  const readVersion = deps.readInstructionFormatVersion ?? readInstructionFormatVersion;
  const versionState = readVersion({ zylosDir });
  if (versionState.valid && versionState.version > CURRENT_INSTRUCTION_FORMAT_VERSION) {
    return step7Result(startTime, {
      message: `future instruction format version ${versionState.version}; current v2 migration code does not apply${manifestNote}`,
    });
  }

  // Legacy migration must preserve the old generated file and fail loudly.
  const zylosMd = path.join(zylosDir, 'ZYLOS.md');
  if (!fs.existsSync(zylosMd)) {
    try {
      (deps.runMigrations ?? runMigrations)({ zylosDir, templatesDir: templateDir });
    } catch (err) {
      return step7Result(startTime, { status: 'failed', error: err.message + manifestNote });
    }
  }

  let refreshResult;
  try {
    refreshResult = (deps.refreshSplitInstructions ?? refreshSplitInstructions)({
      zylosDir,
      templatesDir: templateDir,
      assemblerSource: path.join(ctx.tempDir, 'cli', 'lib', 'runtime', 'assembler.mjs'),
    });
  } catch (err) {
    return step7Result(startTime, { status: 'failed', error: err.message + manifestNote });
  }

  if (refreshResult.active) {
    const notes = [];
    if (!versionState.valid) notes.push('invalid instruction format version treated as legacy');
    if (versionState.version !== CURRENT_INSTRUCTION_FORMAT_VERSION) {
      try {
        (deps.writeInstructionFormatVersion ?? writeInstructionFormatVersion)({ zylosDir });
        notes.push('instruction format version backfilled to 2');
      } catch (error) {
        (deps.warn ?? console.warn)(`Warning: could not backfill instruction format version: ${error.message}`);
        notes.push('instruction format version backfill pending');
      }
    }
    const cleanup = cleanupPendingMigrationPrompt(zylosDir, deps);
    if (!cleanup.cleaned) notes.push('stale prompt cleanup pending');
    const suffix = notes.length ? `; ${notes.join('; ')}` : '';
    return step7Result(startTime, { message: `split instructions refreshed atomically${suffix}${manifestNote}` });
  }

  if (!refreshResult.pendingMigration) {
    return step7Result(startTime, {
      message: `instruction assets refreshed; migration state unchanged${manifestNote}`,
    });
  }

  const anomaly = versionState.valid && versionState.version === CURRENT_INSTRUCTION_FORMAT_VERSION;
  const versionWarning = anomaly
    ? 'warning: version 2 exists but split marker is missing'
    : !versionState.valid
      ? 'warning: invalid instruction format version treated as legacy'
      : null;
  const fallback = (reason, options) => step7Result(startTime, {
    message: `${pendingMigrationMessage(reason, options)}${versionWarning ? `; ${versionWarning}` : ''}${manifestNote}`,
  });

  let catalog;
  let original;
  let analysis;
  try {
    catalog = (deps.loadInstructionCatalog ?? loadInstructionCatalog)({
      catalogPath: path.join(ctx.tempDir, 'data', 'instruction-baselines', 'manifest.json'),
    });
    original = (deps.readFileSync ?? fs.readFileSync)(zylosMd, 'utf8');
    analysis = (deps.classifyInstructionBaseline ?? classifyInstructionBaseline)({ original, catalog });
  } catch (error) {
    return fallback(`automatic classification failed: ${error.message}`);
  }

  if (analysis.classification !== 'A') {
    try {
      const systemTemplatePath = instructionPaths('claude', { zylosDir }).systemPath;
      const promptResult = (deps.writeMigrationPrompt ?? writeMigrationPrompt)({
        zylosDir,
        analysis,
        originalSha256: sha256(original),
        systemTemplatePath,
      });
      const promptPath = promptResult?.filePath ?? promptResult?.promptPath
        ?? migrationPromptPath({ zylosDir });
      return step7Result(startTime, {
        message: `PENDING MIGRATION — classification ${analysis.classification}; agent prompt: ${promptPath}${versionWarning ? `; ${versionWarning}` : ''}${manifestNote}`,
      });
    } catch (error) {
      (deps.warn ?? console.warn)(`Warning: could not write migration prompt: ${error.message}`);
      return fallback(`classification ${analysis.classification}; prompt write failed: ${error.message}`);
    }
  }

  let conservation;
  let userContent;
  try {
    conservation = (deps.verifyInstructionConservation ?? verifyInstructionConservation)({
      strippedContent: analysis.strippedContent,
      userContent: '',
      catalog,
      matched: analysis.matched,
    });
    if (!conservation.ok) return fallback(`automatic conservation check refused: ${conservation.reason}`);
    userContent = (deps.readFileSync ?? fs.readFileSync)(path.join(templateDir, 'ZYLOS.md'), 'utf8');
  } catch (error) {
    return fallback(`automatic conservation preparation failed: ${error.message}`);
  }

  const migration = (deps.executeMigrationApply ?? executeMigrationApply)({
    zylosDir,
    templatesDir: templateDir,
    assemblerSource: path.join(ctx.tempDir, 'cli', 'lib', 'runtime', 'assembler.mjs'),
    original,
    analysis,
    userContent,
    conservation,
  });
  if (!migration.migrated) {
    return fallback(`automatic migration failed${migration.error?.message ? `: ${migration.error.message}` : ''}`, {
      backupPath: migration.backupPath,
    });
  }
  const versionNote = migration.versionWritten === false ? '; instruction format version backfill pending' : '';
  const a3Note = migration.a3Pending ? '; assembler settings reconciliation pending' : '';
  return step7Result(startTime, {
    message: `split instructions migrated automatically (classification A); backup: ${migration.backupPath}${versionNote}${a3Note}${versionWarning ? `; ${versionWarning}` : ''}${manifestNote}`,
  });
}

/**
 * Apply migration hints to installed settings.json.
 * Adds missing hooks, updates modified hooks, removes obsolete hooks.
 * Preserves user-added hooks (hooks not from core skills).
 *
 * @param {object[]} hints - Output from generateMigrationHints()
 * @returns {{ applied: number, errors: string[] }}
 */
export function applyMigrationHints(hints, deps = {}) {
  const result = { applied: 0, errors: [] };
  if (!hints || hints.length === 0) return result;

  const zylosDir = deps.zylosDir ?? ZYLOS_DIR;
  const existsSync = deps.existsSync ?? fs.existsSync;
  const readFileSync = deps.readFileSync ?? fs.readFileSync;
  const mkdirSync = deps.mkdirSync ?? fs.mkdirSync;
  const writeFileSync = deps.writeFileSync ?? fs.writeFileSync;
  const settingsPath = path.join(zylosDir, '.claude', 'settings.json');
  let settings;
  try {
    settings = existsSync(settingsPath)
      ? JSON.parse(readFileSync(settingsPath, 'utf8'))
      : {};
  } catch {
    settings = {};
  }

  if (!settings.hooks) settings.hooks = {};

  for (const hint of hints) {
    try {
      if (hint.type === 'missing_hook') {
        // Add the hook to the appropriate event
        if (!Array.isArray(settings.hooks[hint.event])) {
          settings.hooks[hint.event] = [];
        }

        // Use the full hook object from the hint (includes async, timeout, etc.)
        const hookObj = hint.hook
          ? { ...hint.hook }
          : { type: 'command', command: hint.command };
        if (!hint.hook && hint.timeout !== undefined) hookObj.timeout = hint.timeout;

        // Find or create a matcher group
        const matcherValue = hint.matcher !== undefined ? hint.matcher : null;
        let targetGroup = null;

        if (matcherValue !== null) {
          // Look for an existing group with this matcher
          targetGroup = settings.hooks[hint.event].find(
            g => g.matcher === matcherValue
          );
        }

        if (!targetGroup) {
          targetGroup = { hooks: [] };
          if (matcherValue !== null) targetGroup.matcher = matcherValue;
          settings.hooks[hint.event].push(targetGroup);
        }

        targetGroup.hooks.push(hookObj);
        result.applied++;

      } else if (hint.type === 'modified_hook') {
        // Find and update the hook by script path
        const matchers = settings.hooks[hint.event];
        if (!Array.isArray(matchers)) continue;

        const oldScriptKey = hookScriptKey(hint.oldCommand);
        let updated = false;

        for (const group of matchers) {
          if (!Array.isArray(group.hooks)) continue;
          for (let i = 0; i < group.hooks.length; i++) {
            const h = group.hooks[i];
            if (h.type === 'command' && hookScriptKey(h.command) === oldScriptKey) {
              // Update command and timeout
              group.hooks[i].command = hint.command;
              if (hint.timeout !== undefined) {
                group.hooks[i].timeout = hint.timeout;
              }
              updated = true;
              break;
            }
          }
          if (updated) break;
        }

        if (updated) result.applied++;

      } else if (hint.type === 'statusLine') {
        settings.statusLine = hint.value;
        result.applied++;

      } else if (hint.type === 'statusLine_remove') {
        if (settings.statusLine) {
          delete settings.statusLine;
          result.applied++;
        }

      } else if (hint.type === 'model_backfill') {
        if (!Object.hasOwn(settings, 'model')) {
          settings.model = hint.value;
          result.applied++;
        }

      } else if (hint.type === 'setting_backfill') {
        if (!Object.hasOwn(settings, hint.key)) {
          settings[hint.key] = hint.value;
          result.applied++;
        }

      } else if (hint.type === 'removed_hook') {
        // Remove the hook by script path
        const matchers = settings.hooks[hint.event];
        if (!Array.isArray(matchers)) continue;

        const scriptKey = hookScriptKey(hint.command);
        let removed = false;

        for (let gi = matchers.length - 1; gi >= 0; gi--) {
          const group = matchers[gi];
          if (!Array.isArray(group.hooks)) continue;

          group.hooks = group.hooks.filter(h => {
            if (h.type === 'command' && hookScriptKey(h.command) === scriptKey) {
              removed = true;
              return false;
            }
            return true;
          });

          // Remove empty groups
          if (group.hooks.length === 0) {
            matchers.splice(gi, 1);
          }
        }

        // Clean up empty event arrays
        if (matchers.length === 0) {
          delete settings.hooks[hint.event];
        }

        if (removed) result.applied++;
      }
    } catch (err) {
      result.errors.push(`${hint.type}/${hint.event}: ${err.message}`);
    }
  }

  // Clean up empty hooks object
  if (Object.keys(settings.hooks).length === 0) {
    delete settings.hooks;
  }

  // Write back
  const dir = path.dirname(settingsPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');

  return result;
}

/**
 * Step 8: migrate state.md for existing users.
 *
 * If state.md exists but has no Onboarding section, this is an existing user
 * upgrading. Add `onboarding: skipped` so the onboarding flow is not triggered.
 * New installs already have `Status: pending` from the template.
 */
function step8_migrateStateMd() {
  const startTime = Date.now();
  const statePath = path.join(ZYLOS_DIR, 'memory', 'state.md');

  if (!fs.existsSync(statePath)) {
    return { step: 8, name: 'migrate_state_md', status: 'skipped', message: 'state.md not found', duration: Date.now() - startTime };
  }

  try {
    const content = fs.readFileSync(statePath, 'utf8');

    // Already has onboarding section — nothing to do
    if (/## Onboarding/i.test(content)) {
      return { step: 8, name: 'migrate_state_md', status: 'skipped', message: 'onboarding section exists', duration: Date.now() - startTime };
    }

    // Existing user without onboarding — add skipped status
    const section = '\n\n## Onboarding\n- Status: skipped\n';
    fs.writeFileSync(statePath, content.trimEnd() + section);

    return { step: 8, name: 'migrate_state_md', status: 'done', message: 'added onboarding: skipped', duration: Date.now() - startTime };
  } catch (err) {
    // Non-fatal
    return { step: 8, name: 'migrate_state_md', status: 'skipped', message: err.message, duration: Date.now() - startTime };
  }
}

/**
 * Step 9: sync settings.json hooks from template and refresh upgrade-safe
 * config backfills via the newly installed package.
 *
 * Shells out to the NEWLY INSTALLED sync-settings-hooks.js instead of using
 * the in-memory generateMigrationHints(). This avoids bootstrap problems where
 * the old version's sync logic misses new config fields or backfills
 * (e.g. statusLine, Codex config refreshes).
 */
function step9_syncSettingsHooks(ctx) {
  const startTime = Date.now();

  // Resolve the newly installed package path (from step 4) to use the latest sync logic.
  const syncScript = resolveInstalledSyncScript();

  if (!syncScript) {
    // Fallback to in-memory hints if new script not found
    const templatesDir = path.join(ctx.tempDir, 'templates');
    const hints = generateMigrationHints(templatesDir);
    if (hints.length === 0) {
      return { step: 9, name: 'sync_settings_hooks', status: 'done', message: 'no changes needed', duration: Date.now() - startTime };
    }
    const result = applyMigrationHints(hints);
    if (result.errors.length > 0) {
      return { step: 9, name: 'sync_settings_hooks', status: 'failed', error: result.errors.join('; '), duration: Date.now() - startTime };
    }
    return { step: 9, name: 'sync_settings_hooks', status: 'done', message: `${result.applied} hooks updated`, duration: Date.now() - startTime };
  }

  try {
    const output = execSync(`node "${syncScript}"`, { encoding: 'utf8', stdio: 'pipe', timeout: 60000 }).trim();
    // Extract last line as the summary (script outputs per-hook details before summary)
    const lines = output.split('\n').filter(l => l.trim());
    const summary = lines.length > 0 ? lines[lines.length - 1].trim() : 'no changes';
    return { step: 9, name: 'sync_settings_hooks', status: 'done', message: summary, duration: Date.now() - startTime };
  } catch (err) {
    const errMsg = err.stderr ? err.stderr.toString().trim() : err.message;
    return { step: 9, name: 'sync_settings_hooks', status: 'failed', error: errMsg, duration: Date.now() - startTime };
  }
}

/**
 * Resolve the path to sync-settings-hooks.js in the globally installed package.
 * Reads the package name from package.json to avoid hardcoding.
 * @returns {string|null} Absolute path to the script, or null if not found.
 */
function resolveInstalledSyncScript() {
  return resolveInstalledPackageScript('cli', 'lib', 'sync-settings-hooks.js');
}

/**
 * Resolve a script path in the globally installed package.
 * Reads the package name from package.json to avoid hardcoding.
 * @returns {string|null} Absolute path to the script, or null if not found.
 */
function resolveInstalledPackageScript(...parts) {
  try {
    // import.meta.dirname points to cli/lib/, go up two levels to package root
    const pkgPath = path.join(import.meta.dirname, '..', '..', 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    const pkgName = pkg.name || 'zylos';
    const npmRoot = execSync('npm root -g', { encoding: 'utf8', stdio: 'pipe', timeout: 10000 }).trim();
    const script = path.join(npmRoot, pkgName, ...parts);
    return fs.existsSync(script) ? script : null;
  } catch {
    return null;
  }
}

/**
 * Step 10: ensure Codex config is current for existing Codex-capable installs.
 *
 * Fresh install/init and `zylos runtime codex` already call writeCodexConfig().
 * This upgrade-time step covers existing deployments so newly required config
 * keys (for example [features].multi_agent) are backfilled during self-upgrade.
 */
export function step10_ensureCodexConfig(deps = {}) {
  const startTime = Date.now();
  const cfg = deps.cfg ?? getZylosConfig();
  const codexDir = deps.codexDir ?? path.join(os.homedir(), '.codex');
  const writeConfig = deps.writeConfig ?? writeCodexConfig;
  const existsSync = deps.existsSync ?? fs.existsSync;
  const hasCodexState = existsSync(path.join(codexDir, 'config.toml'))
    || existsSync(path.join(codexDir, 'auth.json'));

  if (cfg.runtime !== 'codex' && !hasCodexState) {
    return { step: 10, name: 'ensure_codex_config', status: 'skipped', message: 'codex not in use', duration: Date.now() - startTime };
  }

  if (!writeConfig(ZYLOS_DIR)) {
    if (cfg.runtime !== 'codex') {
      return {
        step: 10,
        name: 'ensure_codex_config',
        status: 'skipped',
        message: 'warning: failed to refresh codex config outside codex runtime',
        duration: Date.now() - startTime
      };
    }
    return { step: 10, name: 'ensure_codex_config', status: 'failed', error: 'failed to write codex config', duration: Date.now() - startTime };
  }

  return { step: 10, name: 'ensure_codex_config', status: 'done', message: 'updated codex config (project + global)', duration: Date.now() - startTime };
}

/**
 * Step 11: start core services
 */
export function step11_startCoreServices(ctx, deps = {}) {
  const startTime = Date.now();
  const fsApi = deps.fs ?? fs;
  const restartFn = deps.restartManagedProcess ?? restartManagedProcess;
  const exec = deps.execSync ?? execSync;
  const restartScheduledFn = deps.restartScheduledProcess ?? ((name) => {
    exec(`pm2 restart ${JSON.stringify(name)} 2>/dev/null`, { stdio: 'pipe' });
  });
  const restartExistingFn = deps.restartExistingProcess
    ?? deps.restartManagedProcess
    ?? ((name) => {
      exec(`pm2 restart ${JSON.stringify(name)} --update-env 2>/dev/null`, { stdio: 'pipe' });
    });
  const coreEcosystemServiceNames = new Set(
    deps.coreEcosystemServiceNames ?? CORE_ECOSYSTEM_SERVICE_NAMES,
  );
  const zylosDir = deps.zylosDir ?? ZYLOS_DIR;
  const skillsDir = deps.skillsDir ?? SKILLS_DIR;

  if (ctx.servicesWereRunning.length === 0) {
    return { step: 11, name: 'start_core_services', status: 'skipped', message: 'no services to restart', duration: Date.now() - startTime };
  }

  // Deploy the new ecosystem.config.cjs from the upgraded package so PM2
  // re-evaluates env vars (e.g. ZYLOS_PACKAGE_ROOT) when services restart.
  // `pm2 restart <name>` reuses PM2's cached config and never picks up new env.
  let ecosystemPath = null;
  const ecosystemTemplateSrc = ctx.tempDir
    ? path.join(ctx.tempDir, 'templates', 'pm2', 'ecosystem.config.cjs')
    : null;
  const pm2Dir = path.join(zylosDir, 'pm2');
  const ecosystemDest = deps.ecosystemPath ?? getCoreEcosystemPath();
  if (ecosystemTemplateSrc && fsApi.existsSync(ecosystemTemplateSrc)) {
    try {
      fsApi.mkdirSync(pm2Dir, { recursive: true });
      fsApi.copyFileSync(ecosystemTemplateSrc, ecosystemDest);
      ecosystemPath = ecosystemDest;
    } catch {
      // Non-fatal — if copy fails, we can still use an already-deployed ecosystem file below.
    }
  } else if (fsApi.existsSync(ecosystemDest)) {
    // No new template available; use the existing ecosystem file
    ecosystemPath = ecosystemDest;
  }
  ecosystemPath = ecosystemPath ?? ecosystemDest;

  const servicesToStart = [...new Set(ctx.servicesWereRunning)];
  ctx.servicesStartedByUpgrade = Array.isArray(ctx.servicesStartedByUpgrade)
    ? ctx.servicesStartedByUpgrade
    : [];
  const requiredServices = deps.requiredCoreServices ?? UPGRADE_REQUIRED_CORE_SERVICES;
  const availableRequiredServices = requiredServices.filter(service =>
    fsApi.existsSync(path.join(skillsDir, ...service.script))
  );

  if (availableRequiredServices.length > 0) {
    const getPm2ProcessNames = deps.getPm2ProcessNames ?? (() => {
      const output = exec('pm2 jlist 2>/dev/null', { encoding: 'utf8', stdio: 'pipe' });
      const processes = JSON.parse(String(output));
      return processes.map(process => process.name).filter(Boolean);
    });

    let pm2ProcessNames;
    try {
      pm2ProcessNames = new Set(getPm2ProcessNames());
    } catch (err) {
      const detail = err?.message ? `: ${err.message}` : '';
      return {
        step: 11,
        name: 'start_core_services',
        status: 'failed',
        error: `failed to inspect PM2 process list before core restart${detail}`,
        duration: Date.now() - startTime,
      };
    }

    for (const service of availableRequiredServices) {
      if (!pm2ProcessNames.has(service.name) && !servicesToStart.includes(service.name)) {
        servicesToStart.push(service.name);
        ctx.servicesStartedByUpgrade.push(service.name);
      }
    }
  }

  ctx.servicesExpectedAfterUpgrade = [...servicesToStart];

  const started = [];
  const failed = [];
  const scheduledServices = new Set(ctx.cronServicesWereRunning || []);

  for (const name of servicesToStart) {
    try {
      if (scheduledServices.has(name)) {
        // Preserve the process's own cron_restart/autorestart definition.
        // The Core ecosystem does not necessarily declare component one-shots.
        restartScheduledFn(name);
      } else if (!coreEcosystemServiceNames.has(name)) {
        // Component daemons can use additional ecosystem files that are not
        // loaded by Core. Preserve their already-registered PM2 definition.
        restartExistingFn(name);
      } else {
        restartFn(name, {
          ecosystemPath,
          stdio: 'pipe',
          fallbackToPlainRestartOnError: true,
        });
      }
      started.push(name);
    } catch {
      failed.push(name);
    }
  }

  if (failed.length > 0) {
    return { step: 11, name: 'start_core_services', status: 'failed', error: `Failed to restart: ${failed.join(', ')}`, duration: Date.now() - startTime };
  }

  if (started.includes('activity-monitor')) {
    const verifyActivityMonitorEnv = deps.verifyActivityMonitorEnv ?? (() => {
      const output = exec('pm2 jlist 2>/dev/null', {
        encoding: 'utf8',
        stdio: 'pipe',
      });
      const processes = JSON.parse(String(output));
      const activityMonitor = processes.find(process => process.name === 'activity-monitor');
      return Boolean(activityMonitor?.pm2_env?.ZYLOS_PACKAGE_ROOT);
    });

    try {
      if (!verifyActivityMonitorEnv()) {
        return { step: 11, name: 'start_core_services', status: 'failed', error: 'activity-monitor PM2 env missing ZYLOS_PACKAGE_ROOT after restart', duration: Date.now() - startTime };
      }
    } catch (err) {
      const detail = err?.message ? `: ${err.message}` : '';
      return { step: 11, name: 'start_core_services', status: 'failed', error: `failed to verify activity-monitor PM2 env after restart${detail}`, duration: Date.now() - startTime };
    }
  }

  try {
    exec('pm2 save 2>/dev/null', { stdio: 'pipe' });
  } catch {
    return { step: 11, name: 'start_core_services', status: 'failed', error: 'failed to save PM2 process list after core restart', duration: Date.now() - startTime };
  }

  return { step: 11, name: 'start_core_services', status: 'done', message: started.join(', '), duration: Date.now() - startTime };
}

/**
 * Step 12: verify services
 *
 * Polls up to 30 seconds (every 2 s) for all runtime processes to become
 * healthy. Daemons must be online. A PM2 cron one-shot (`autorestart: false`
 * plus `cron_restart`) is also healthy while stopped between successful runs;
 * treating that expected idle state as a dead daemon causes false rollbacks.
 */
export function step12_verifyServices(ctx, deps = {}) {
  const startTime = Date.now();
  const exec = deps.execSync ?? execSync;
  const fsApi = deps.fs ?? fs;
  const skillsDir = deps.skillsDir ?? SKILLS_DIR;
  const requiredServices = deps.requiredCoreServices ?? UPGRADE_REQUIRED_CORE_SERVICES;
  const requiredByName = new Map(requiredServices.map((service) => [service.name, service]));
  const servicesToVerify = ctx.servicesExpectedAfterUpgrade?.length > 0
    ? ctx.servicesExpectedAfterUpgrade
    : ctx.servicesWereRunning;

  if (servicesToVerify.length === 0) {
    return { step: 12, name: 'verify_services', status: 'skipped', message: 'no services to verify', duration: Date.now() - startTime };
  }

  const POLL_INTERVAL_MS = 2000;
  const TIMEOUT_MS = 30000;

  while (Date.now() - startTime < TIMEOUT_MS) {
    try { exec('sleep 2', { stdio: 'pipe' }); } catch { /* ignore */ }

    try {
      const output = exec('pm2 jlist 2>/dev/null', { encoding: 'utf8' });
      const processes = JSON.parse(output);

      const isHealthyScheduledIdle = (proc) => {
        const pm2Env = proc?.pm2_env || {};
        const cronRestart = String(pm2Env.cron_restart || '').trim();
        const unstableRestarts = Number(pm2Env.unstable_restarts || 0);
        return pm2Env.status === 'stopped'
          && pm2Env.autorestart === false
          && cronRestart.length > 0
          && Number(pm2Env.exit_code) === 0
          && unstableRestarts === 0;
      };

      const notOnline = servicesToVerify.filter(name => {
        const proc = processes.find(p => p.name === name);
        return !proc
          || (proc.pm2_env?.status !== 'online' && !isHealthyScheduledIdle(proc));
      });

      const invalidExecutables = [];
      for (const name of servicesToVerify) {
        const proc = processes.find((candidate) => candidate.name === name);
        if (!proc) continue;
        const runtimeIsHealthy = proc.pm2_env?.status === 'online'
          || isHealthyScheduledIdle(proc);
        if (!runtimeIsHealthy) continue;
        const execPath = proc.pm2_env?.pm_exec_path;
        let isFile = false;
        try {
          isFile = Boolean(execPath) && fsApi.statSync(execPath).isFile();
        } catch {
          isFile = false;
        }
        if (!isFile) {
          invalidExecutables.push(`${name} missing executable: ${execPath || '(unset)'}`);
          continue;
        }
        const required = requiredByName.get(name);
        if (required) {
          const expectedPath = path.resolve(skillsDir, ...required.script);
          if (path.resolve(execPath) !== expectedPath) {
            invalidExecutables.push(
              `${name} executable mismatch: expected ${expectedPath}, found ${path.resolve(execPath)}`,
            );
          }
        }
      }

      if (invalidExecutables.length > 0) {
        return {
          step: 12,
          name: 'verify_services',
          status: 'failed',
          error: invalidExecutables.join('; '),
          duration: Date.now() - startTime,
        };
      }

      if (notOnline.length === 0) {
        return { step: 12, name: 'verify_services', status: 'done', duration: Date.now() - startTime };
      }

      // If we still have time, keep polling
      if (Date.now() - startTime + POLL_INTERVAL_MS >= TIMEOUT_MS) {
        return { step: 12, name: 'verify_services', status: 'failed', error: `Not online after ${TIMEOUT_MS / 1000}s: ${notOnline.join(', ')}`, duration: Date.now() - startTime };
      }
    } catch (err) {
      return { step: 12, name: 'verify_services', status: 'failed', error: err.message, duration: Date.now() - startTime };
    }
  }

  // Timed out
  return { step: 12, name: 'verify_services', status: 'failed', error: `Timed out after ${TIMEOUT_MS / 1000}s`, duration: Date.now() - startTime };
}

/** Verify both C4 reply contracts without contacting an external channel. */
export function step13_verifyCommunicationContinuity(_ctx, deps = {}) {
  const startTime = Date.now();
  const verify = deps.verify ?? verifyCommunicationContinuity;
  const c4SendPath = deps.c4SendPath
    ?? path.join(SKILLS_DIR, 'comm-bridge', 'scripts', 'c4-send.js');
  const c4ReceivePath = deps.c4ReceivePath
    ?? path.join(SKILLS_DIR, 'comm-bridge', 'scripts', 'c4-receive.js');
  const c4DbPath = deps.c4DbPath
    ?? path.join(SKILLS_DIR, 'comm-bridge', 'scripts', 'c4-db.js');

  try {
    const result = verify({
      c4SendPath,
      c4ReceivePath,
      c4DbPath,
      zylosDir: deps.zylosDir ?? ZYLOS_DIR,
    });
    if (!result.compatible) {
      return {
        step: 13,
        name: 'verify_communication_continuity',
        status: 'failed',
        error: result.error || 'C4 reply contract canary failed',
        duration: Date.now() - startTime,
      };
    }
    const passed = result.checks
      .filter(({ status }) => status === 'passed')
      .map(({ name }) => name);
    return {
      step: 13,
      name: 'verify_communication_continuity',
      status: 'done',
      message: passed.join(', '),
      duration: Date.now() - startTime,
    };
  } catch (err) {
    return {
      step: 13,
      name: 'verify_communication_continuity',
      status: 'failed',
      error: err.message,
      duration: Date.now() - startTime,
    };
  }
}

/** Commit every Core Skill baseline after the complete self-upgrade succeeds. */
function step14_commitSkillBaselines(ctx) {
  const startTime = Date.now();
  try {
    for (const baseline of ctx.pendingBaselines || []) {
      saveMergeBaseline(baseline.destDir, baseline.srcDir, baseline.manifest);
    }
    return {
      step: 14,
      name: 'commit_skill_baselines',
      status: 'done',
      message: `${(ctx.pendingBaselines || []).length} committed`,
      duration: Date.now() - startTime,
    };
  } catch (err) {
    return { step: 14, name: 'commit_skill_baselines', status: 'failed', error: err.message, duration: Date.now() - startTime };
  }
}

// ---------------------------------------------------------------------------
// Rollback
// ---------------------------------------------------------------------------

/**
 * Rollback from backup.
 */
export function rollbackSelf(ctx, deps = {}) {
  const results = [];
  const fsApi = deps.fs ?? fs;
  const syncTreeFn = deps.syncTree ?? syncTree;
  const restartFn = deps.restartManagedProcess ?? restartManagedProcess;
  const execSyncFn = deps.execSync ?? execSync;
  const removeFn = deps.removeManagedProcess ?? ((name) => {
    execSyncFn(`pm2 delete ${JSON.stringify(name)} 2>/dev/null`, { stdio: 'pipe' });
  });
  const savePm2Fn = deps.savePm2 ?? (() => {
    execSyncFn('pm2 save 2>/dev/null', { stdio: 'pipe' });
  });
  const restartScheduledFn = deps.restartScheduledProcess ?? ((name) => {
    execSyncFn(`pm2 restart ${JSON.stringify(name)} 2>/dev/null`, { stdio: 'pipe' });
  });
  const restartExistingFn = deps.restartExistingProcess
    ?? deps.restartManagedProcess
    ?? ((name) => {
      execSyncFn(`pm2 restart ${JSON.stringify(name)} --update-env 2>/dev/null`, { stdio: 'pipe' });
    });
  const coreEcosystemServiceNames = new Set(
    deps.coreEcosystemServiceNames ?? CORE_ECOSYSTEM_SERVICE_NAMES,
  );
  const zylosDir = deps.zylosDir ?? ZYLOS_DIR;
  const skillsDir = deps.skillsDir ?? SKILLS_DIR;
  const ecosystemPath = deps.ecosystemPath ?? getCoreEcosystemPath();

  const backupCorePackage = ctx.backupDir
    ? path.join(ctx.backupDir, 'core-package')
    : null;
  const corePackageDir = deps.corePackageDir
    ?? ctx.globalCoreDir
    ?? resolveInstalledPackageScript();
  if (backupCorePackage && fsApi.existsSync(backupCorePackage)) {
    try {
      if (!corePackageDir) throw new Error('Installed global Core package not found');
      syncTreeFn(backupCorePackage, corePackageDir);
      results.push({ action: 'restore_global_core_package', success: true });
    } catch (err) {
      results.push({ action: 'restore_global_core_package', success: false, error: err.message });
    }
  }

  // Restore Core Skills from backup (include .zylos manifests to keep them in sync with files)
  if (ctx.backupDir && fsApi.existsSync(path.join(ctx.backupDir, 'skills'))) {
    try {
      syncTreeFn(path.join(ctx.backupDir, 'skills'), skillsDir, { excludes: ['node_modules'] });
      results.push({ action: 'restore_core_skills', success: true });
    } catch (err) {
      results.push({ action: 'restore_core_skills', success: false, error: err.message });
    }
  }

  if (ctx.backupDir) {
    const backupEcosystem = path.join(ctx.backupDir, 'pm2', 'ecosystem.config.cjs');
    if (fsApi.existsSync(backupEcosystem)) {
      try {
        fsApi.mkdirSync(path.dirname(ecosystemPath), { recursive: true });
        fsApi.copyFileSync(backupEcosystem, ecosystemPath);
        results.push({ action: 'restore_pm2_ecosystem', success: true });
      } catch (err) {
        results.push({ action: 'restore_pm2_ecosystem', success: false, error: err.message });
      }
    }
  }

  // A failed target may have introduced a PM2 service that did not exist in
  // the baseline (for example c4-response-stream-supervisor). Restoring the
  // old skills removes its entrypoint, so retaining that process would leave
  // a fake-online/orphan service and poison the next upgrade preflight.
  const originallyRunning = new Set(ctx.servicesWereRunning || []);
  const targetOnlyServices = [...new Set(ctx.servicesStartedByUpgrade || [])]
    .filter((name) => !originallyRunning.has(name));
  let removedTargetOnlyService = false;
  for (const name of targetOnlyServices) {
    try {
      removeFn(name);
      removedTargetOnlyService = true;
      results.push({ action: `remove_target_only_${name}`, success: true });
    } catch (err) {
      results.push({ action: `remove_target_only_${name}`, success: false, error: err.message });
    }
  }

  // Restart services if they were running
  const scheduledServices = new Set(ctx.cronServicesWereRunning || []);
  for (const name of ctx.servicesWereRunning || []) {
    try {
      if (scheduledServices.has(name)) {
        restartScheduledFn(name);
      } else if (!coreEcosystemServiceNames.has(name)) {
        restartExistingFn(name);
      } else {
        restartFn(name, {
          ecosystemPath,
          stdio: 'pipe',
          fallbackToPlainRestartOnError: true,
        });
      }
      results.push({ action: `restart_${name}`, success: true });
    } catch (err) {
      results.push({ action: `restart_${name}`, success: false, error: err.message });
    }
  }

  // Persist only after the baseline services have been restarted. Otherwise
  // a reboot could resurrect the removed target-only process from the PM2 dump
  // or retain a snapshot in which baseline services are still stopped.
  if (removedTargetOnlyService) {
    try {
      savePm2Fn();
      results.push({ action: 'save_pm2_rollback_state', success: true });
    } catch (err) {
      results.push({ action: 'save_pm2_rollback_state', success: false, error: err.message });
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Public: runSelfUpgrade
// ---------------------------------------------------------------------------

const POST_INSTALL_STEPS = [
  step5_syncCoreSkills,
  step6_installSkillDeps,
  step7_syncInstructions,
  step8_migrateStateMd,
  step9_syncSettingsHooks,
  step10_ensureCodexConfig,
  step11_startCoreServices,
  step12_verifyServices,
  step13_verifyCommunicationContinuity,
  step14_commitSkillBaselines,
];

function buildSelfUpgradeResult(ctx, failedStep, rollbackResults = null, rollbackPerformed = Boolean(rollbackResults)) {
  if (failedStep) {
    return {
      action: 'self_upgrade',
      success: false,
      from: ctx.from,
      to: null,
      failedStep: failedStep.step,
      error: failedStep.error,
      steps: ctx.steps,
      rollback: { performed: rollbackPerformed, steps: rollbackResults || [] },
    };
  }

  // List template files for Claude to compare with local structure
  const templatesDir = ctx.tempDir ? path.join(ctx.tempDir, 'templates') : null;
  const templates = listTemplateFiles(templatesDir);

  // Migration hints: step 8 already applied settings sync via the newly installed script.
  const migrationHints = [];

  // Check if instruction files were rebuilt (CLAUDE.md / AGENTS.md) — used by
  // component.js to auto-enqueue a Claude restart after the reply is sent, so
  // Claude does not prompt the user about restarting.
  const step7 = ctx.steps.find(s => s.step === 7);
  const instructionFilesRebuilt = step7?.status === 'done' && Boolean(step7?.message?.includes('rebuilt'));

  // Check if settings.json was modified (hooks, statusLine, model) — requires
  // Claude restart to load the new configuration.
  const step9 = ctx.steps.find(s => s.step === 9);
  const settingsChanged = step9?.status === 'done' &&
    !/all up to date|no changes/.test(step9?.message || '');

  return {
    action: 'self_upgrade',
    success: true,
    from: ctx.from,
    to: ctx.to,
    steps: ctx.steps,
    backupDir: ctx.backupDir,
    templates,
    migrationHints,
    instructionFilesRebuilt,
    settingsChanged,
    mergeConflicts: ctx.mergeConflicts.length > 0 ? ctx.mergeConflicts : null,
    mergedFiles: ctx.mergedFiles.length > 0 ? ctx.mergedFiles : null,
  };
}

export function createFinalizeState(ctx) {
  return {
    schemaVersion: 1,
    tempDir: ctx.tempDir,
    backupDir: ctx.backupDir,
    ...(ctx.globalCoreDir ? { globalCoreDir: ctx.globalCoreDir } : {}),
    servicesWereRunning: ctx.servicesWereRunning,
    cronServicesWereRunning: ctx.cronServicesWereRunning || [],
    from: ctx.from,
    to: ctx.to,
    newVersion: ctx.newVersion,
    mode: ctx.mode,
  };
}

function writeFinalizeState(ctx) {
  const statePath = path.join(ctx.tempDir, 'self-upgrade-finalize-state.json');
  fs.writeFileSync(statePath, `${JSON.stringify(createFinalizeState(ctx), null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  return statePath;
}

function runInstalledFinalizer(ctx, { timeoutMs = resolveSelfUpgradeFinalizerTimeoutMs() } = {}) {
  const finalizeScript = resolveInstalledPackageScript('cli', 'lib', 'self-upgrade-finalize.js');
  if (!finalizeScript) {
    throw new Error('newly installed self-upgrade finalizer not found');
  }

  const statePath = writeFinalizeState(ctx);
  const result = spawnSync(process.execPath, [finalizeScript, statePath], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: timeoutMs,
  });

  if (result.error) {
    throw result.error;
  }

  const output = String(result.stdout || '').trim();
  if (!output) {
    const err = String(result.stderr || '').trim() || `finalizer exited ${result.status}`;
    throw new Error(err);
  }

  const parsed = JSON.parse(output);
  if (result.status !== 0 && parsed?.success !== false) {
    const err = String(result.stderr || '').trim() || `finalizer exited ${result.status}`;
    throw new Error(err);
  }

  return parsed;
}

export function runSelfUpgradeFinalize(state = {}, deps = {}) {
  if (state.schemaVersion !== undefined && state.schemaVersion !== 1) {
    return {
      action: 'self_upgrade',
      success: false,
      from: state.from || null,
      to: null,
      failedStep: 5,
      error: `unsupported finalize state schemaVersion: ${state.schemaVersion}`,
      steps: [],
      rollback: { performed: false, steps: [] },
    };
  }

  const ctx = createContext({
    tempDir: state.tempDir,
    newVersion: state.newVersion || state.to,
    mode: state.mode,
  });
  ctx.backupDir = state.backupDir || null;
  ctx.globalCoreDir = state.globalCoreDir || null;
  ctx.servicesWereRunning = Array.isArray(state.servicesWereRunning) ? [...state.servicesWereRunning] : [];
  ctx.cronServicesWereRunning = Array.isArray(state.cronServicesWereRunning)
    ? [...state.cronServicesWereRunning]
    : [];
  ctx.from = state.from || null;
  ctx.to = state.to || state.newVersion || null;

  const steps = deps.steps || POST_INSTALL_STEPS;
  const total = deps.total || 15;
  let failedStep = null;

  for (const stepFn of steps) {
    const result = stepFn(ctx);
    result.total = total;
    ctx.steps.push(result);

    if (result.status === 'failed') {
      failedStep = result;
      ctx.error = result.error;
      break;
    }
  }

  if (failedStep) {
    const rollbackFn = deps.rollbackSelf ?? rollbackSelf;
    const rollbackResults = rollbackFn(ctx);
    return buildSelfUpgradeResult(ctx, failedStep, rollbackResults, true);
  }

  return buildSelfUpgradeResult(ctx, null);
}

/**
 * Run the 15-stage self-upgrade pipeline (steps 0-14).
 * Template migration and Claude restart are handled by Claude after this completes.
 * Lock must be acquired by caller.
 *
 * @param {{ tempDir: string, newVersion: string, onStep?: function }} opts
 * @param {object} [deps] - Isolated self-upgrade seam for npm, PM2, version, rollback, and finalizer boundaries
 * @returns {object} Upgrade result
 */
export function runSelfUpgrade({ tempDir, newVersion, mode, onStep } = {}, deps = {}) {
  const ctx = createContext({ tempDir, newVersion, mode });

  const getCurrentVersionFn = deps.getCurrentVersion ?? getCurrentVersion;
  const current = getCurrentVersionFn();
  if (current.success) {
    ctx.from = current.version;
  }
  ctx.to = newVersion || null;

  const preInstallSteps = deps.preInstallSteps ?? [
    (stepCtx) => step0_verifyTargetCommunicationCompatibility(stepCtx, deps.step0),
    (stepCtx) => step1_backupCoreSkills(stepCtx, deps.step1),
    step2_preUpgradeHook,
    (stepCtx) => step3_stopCoreServices(stepCtx, deps.step3),
    (stepCtx) => step4_npmInstallGlobal(stepCtx, deps.step4),
  ];

  const total = 15;
  let failedStep = null;

  for (const stepFn of preInstallSteps) {
    const result = stepFn(ctx);
    result.total = total;
    ctx.steps.push(result);
    if (onStep) onStep(result);

    if (result.status === 'failed') {
      failedStep = result;
      ctx.error = result.error;
      break;
    }
  }

  if (failedStep) {
    const rollbackFn = deps.rollbackSelf ?? rollbackSelf;
    const rollbackResults = rollbackFn(ctx);
    return buildSelfUpgradeResult(ctx, failedStep, rollbackResults);
  }

  const now = deps.now ?? Date.now;
  const finalizerTimeoutMs = deps.finalizerTimeoutMs ?? resolveSelfUpgradeFinalizerTimeoutMs();
  const finalizerStartedAt = now();

  try {
    const finalizerFn = deps.runInstalledFinalizer ?? runInstalledFinalizer;
    const finalizeResult = finalizerFn(ctx, { timeoutMs: finalizerTimeoutMs });
    const finalizeSteps = Array.isArray(finalizeResult.steps) ? finalizeResult.steps : [];
    for (const step of finalizeSteps) {
      ctx.steps.push(step);
      if (onStep) onStep(step);
    }
    return {
      ...finalizeResult,
      from: ctx.from,
      steps: ctx.steps,
      backupDir: finalizeResult.backupDir || ctx.backupDir,
    };
  } catch (err) {
    const elapsed = Math.max(0, now() - finalizerStartedAt);
    const detail = err.stderr?.toString().trim() || err.message;
    const timedOut = err.code === 'ETIMEDOUT' || /\bETIMEDOUT\b|timed?\s*out/i.test(detail || '');
    const error = timedOut
      ? `Self-upgrade finalizer timed out after ${Math.ceil(finalizerTimeoutMs / 1000)}s: ${detail}`
      : detail;
    failedStep = {
      step: 5,
      name: 'run_new_upgrade_finalizer',
      status: 'failed',
      error,
      total,
      duration: elapsed,
    };
    ctx.steps.push(failedStep);
    if (onStep) onStep(failedStep);
    const rollbackFn = deps.rollbackSelf ?? rollbackSelf;
    const rollbackResults = rollbackFn(ctx);
    return buildSelfUpgradeResult(ctx, failedStep, rollbackResults, true);
  }
}

// ---------------------------------------------------------------------------
// Public: cleanupTemp
// ---------------------------------------------------------------------------

export function cleanupTemp(tempDir) {
  if (!tempDir || !fs.existsSync(tempDir)) return;

  let resolved;
  try { resolved = fs.realpathSync(tempDir); } catch { resolved = path.resolve(tempDir); }

  // Safety: only delete directories under allowed temp roots
  const allowedRoots = getAllowedTmpRoots();
  if (!allowedRoots.some(root => resolved.startsWith(root + '/'))) {
    console.error(`SAFETY: refusing to delete ${resolved} (not under any allowed temp root)`);
    return;
  }

  fs.rmSync(tempDir, { recursive: true, force: true });
}

// Also clean up backup dirs after successful upgrade
export function cleanupBackup(backupDir) {
  if (backupDir && fs.existsSync(backupDir)) {
    fs.rmSync(backupDir, { recursive: true, force: true });
  }
}
