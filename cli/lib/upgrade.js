/**
 * Core upgrade logic for components.
 * Uses GitHub archive tarballs and filesystem-based backup/rollback.
 * Zero git dependency.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execSync, spawnSync } from 'node:child_process';
import { SKILLS_DIR, COMPONENTS_DIR, ENV_FILE } from './config.js';
import { loadComponents } from './components.js';
import { loadLocalRegistry } from './registry.js';
import { parseSkillMd } from './skill.js';
import {
  saveMergeBaseline,
} from './manifest.js';
import { downloadArchive, downloadBranch } from './download.js';
import { fetchLatestTag, fetchRawFile, compareSemverDesc, sanitizeError } from './github.js';
import { copyTree, syncTree } from './fs-utils.js';
import { applyCaddyRoutes, removeCaddyRoutes } from './caddy.js';
import { smartSync, formatMergeResult } from './smart-merge.js';
import { restartManagedProcess } from './pm2.js';
import { verifyTargetCapabilities } from './capability-compatibility.js';
import {
  abortUpgradeMetadataTransaction,
  beginUpgradeMetadataTransaction,
  buildUpgradeMetadata,
  finalizeUpgradeMetadataTransaction,
  recoverUpgradeMetadataTransactions,
  validateUpgradeSource,
} from './upgrade-metadata.js';

// ---------------------------------------------------------------------------
// Version helpers
// ---------------------------------------------------------------------------

/**
 * Read the local version from SKILL.md frontmatter, falling back to package.json.
 */
function getLocalVersion(skillDir) {
  // Primary: SKILL.md frontmatter
  const parsed = parseSkillMd(skillDir);
  if (parsed?.frontmatter?.version) {
    return { success: true, version: String(parsed.frontmatter.version) };
  }
  // Fallback: package.json
  const pkgPath = path.join(skillDir, 'package.json');
  try {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    if (pkg.version) {
      return { success: true, version: String(pkg.version) };
    }
  } catch {
    // package.json doesn't exist or is invalid
  }
  return { success: false, error: 'Version not found in SKILL.md or package.json' };
}

/**
 * Get the repo for a component from components.json or registry.
 */
export function getRepo(component) {
  const components = loadComponents();
  if (components[component]?.source?.type?.startsWith('local-')) return null;
  if (components[component]?.repo) return components[component].repo;
  const registry = loadLocalRegistry();
  if (registry[component]?.repo) return registry[component].repo;
  return null;
}

export function getLocalSourceUpgradeError(component, installed = loadComponents()[component]) {
  if (!installed?.source?.type?.startsWith('local-')) return null;
  const sourcePath = installed.source.path || 'the original local source';
  return {
    success: false,
    error: 'local_source_upgrade_unsupported',
    message: `Component '${component}' was installed from a local source. Reinstall it from ${sourcePath} to update it.`,
    source: installed.source,
  };
}

/**
 * Get the latest version from GitHub (latest tag).
 * Falls back to fetching SKILL.md from GitHub if no tags found.
 *
 * @param {string} component
 * @param {string} repo
 * @param {object} [opts]
 * @param {boolean} [opts.beta=false] - Include prerelease (beta) tags
 */
function getLatestVersion(component, repo, { beta = false } = {}) {
  if (!repo) return { success: false, error: 'No repo configured for component' };

  // Primary: fetch latest tag from GitHub
  try {
    const tagVersion = fetchLatestTag(repo, { includePrerelease: beta });
    if (tagVersion) {
      return { success: true, version: tagVersion };
    }
  } catch {
    // Network/API error — fall through to SKILL.md fallback
  }

  // Fallback: fetch raw SKILL.md from GitHub (only for non-beta, as SKILL.md has no prerelease info)
  if (!beta) {
    try {
      const content = fetchRawFile(repo, 'SKILL.md');
      const match = content.match(/^---\n([\s\S]*?)\n---/);
      if (match) {
        const versionMatch = match[1].match(/^version:\s*(.+)$/m);
        if (versionMatch) {
          return { success: true, version: versionMatch[1].trim() };
        }
      }
      return { success: false, error: 'Version not found in remote SKILL.md' };
    } catch (err) {
      return { success: false, error: `Cannot fetch remote: ${sanitizeError(err.message)}` };
    }
  }

  return { success: false, error: 'No release tags found' };
}

// ---------------------------------------------------------------------------
// Public: checkForUpdates
// ---------------------------------------------------------------------------

/**
 * Check if a component has updates available.
 * Uses registry lookup (fast, no HTTP) with fallback to GitHub raw SKILL.md.
 *
 * @param {string} component
 * @param {object} [opts]
 * @param {boolean} [opts.beta=false] - Include prerelease (beta) versions
 * @returns {object} { success, hasUpdate, current, latest, repo }
 */
export function checkForUpdates(component, { beta = false } = {}) {
  const skillDir = path.join(SKILLS_DIR, component);

  if (!fs.existsSync(skillDir)) {
    return {
      success: false,
      error: 'component_not_found',
      message: `Component '${component}' is not installed`,
    };
  }

  const localSourceError = getLocalSourceUpgradeError(component);
  if (localSourceError) return localSourceError;

  const localVersion = getLocalVersion(skillDir);
  if (!localVersion.success) {
    return {
      success: false,
      error: 'version_not_found',
      message: `Cannot read current version: ${localVersion.error}`,
    };
  }

  const repo = getRepo(component);
  const latest = getLatestVersion(component, repo, { beta });
  if (!latest.success) {
    return {
      success: false,
      error: 'remote_version_failed',
      message: `Cannot determine latest version: ${latest.error}`,
    };
  }

  // Use semver comparison (not string inequality) to avoid suggesting downgrades.
  // compareSemverDesc(a, b) > 0 means b is higher than a.
  const hasUpdate = compareSemverDesc(localVersion.version, latest.version) > 0;

  return {
    success: true,
    hasUpdate,
    current: localVersion.version,
    latest: latest.version,
    repo,
  };
}

// ---------------------------------------------------------------------------
// Internal: allowed temp roots for safety checks
// ---------------------------------------------------------------------------

function safeResolve(p) {
  try { return fs.realpathSync(p); } catch { return path.resolve(p); }
}

/**
 * Return the list of directory roots under which temp dirs are allowed.
 * Used by cleanupTemp in both component and self-upgrade flows.
 * Order: system tmpdir first, ~/tmp as fallback.
 */
export function getAllowedTmpRoots() {
  const roots = [];
  try { roots.push(safeResolve(os.tmpdir())); } catch { /* skip */ }
  const userTmp = path.join(os.homedir(), 'tmp');
  roots.push(safeResolve(userTmp));
  return roots;
}

// ---------------------------------------------------------------------------
// Public: downloadToTemp
// ---------------------------------------------------------------------------

/**
 * Download a component version to a temp directory.
 *
 * @param {string} repo - GitHub repo (org/name)
 * @param {string} version - Version to download
 * @param {string} [branch] - Optional branch to download from (skips version tag)
 * @returns {{ success: boolean, tempDir?: string, error?: string }}
 */
export function downloadToTemp(repo, version, branch) {
  let base = os.tmpdir();
  try {
    const probe = fs.mkdtempSync(path.join(base, 'zylos-upgrade-probe-'));
    fs.rmSync(probe, { recursive: true, force: true });
  } catch {
    // System tmp unavailable — fallback to ~/tmp
    base = path.join(os.homedir(), 'tmp');
    fs.mkdirSync(base, { recursive: true });
  }
  const tempDir = fs.mkdtempSync(path.join(base, 'zylos-upgrade-'));

  if (branch) {
    const branchResult = downloadBranch(repo, branch, tempDir);
    if (!branchResult.success) {
      fs.rmSync(tempDir, { recursive: true, force: true });
      return { success: false, error: branchResult.error };
    }
    return { success: true, tempDir };
  }

  const result = downloadArchive(repo, version, tempDir);
  if (!result.success) {
    // Fallback: try downloading main branch
    const branchResult = downloadBranch(repo, 'main', tempDir);
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
 *
 * @param {string} dir - Directory containing CHANGELOG.md
 * @returns {string|null}
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

/**
 * Filter changelog to only show entries between two versions.
 * Expects standard format: ## [version] or ## version headers.
 *
 * @param {string} changelog - Full changelog text
 * @param {string} fromVersion - Current installed version (excluded)
 * @returns {string|null} Filtered changelog or null if parsing fails
 */
export function filterChangelog(changelog, fromVersion) {
  if (!changelog || !fromVersion) return changelog;

  const lines = changelog.split('\n');
  const result = [];
  let capturing = false;
  let foundHeaders = false;
  let done = false;

  // Match ## headers containing version numbers: "## [1.0.0]", "## 1.0.0", "## v1.0.0 - date"
  const versionHeaderRe = /^##\s+\[?v?(\d+\.\d+[^\]\s]*)\]?/;

  for (const line of lines) {
    if (done) break;

    const match = line.match(versionHeaderRe);
    if (match) {
      foundHeaders = true;
      const headerVersion = match[1].replace(/^v/, '');
      // Stop when we reach the installed version (already known)
      if (headerVersion === fromVersion) {
        done = true;
        continue;
      }
      // Capture everything from the newest version down to (but not including) fromVersion
      capturing = true;
    }

    if (capturing) {
      result.push(line);
    }
  }

  if (!foundHeaders) return changelog; // Couldn't parse headers, return full text
  return result.join('\n').trim() || null;
}

// ---------------------------------------------------------------------------
// Public: cleanupTemp
// ---------------------------------------------------------------------------

/**
 * Remove a temp directory.
 *
 * @param {string} tempDir
 */
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

// ---------------------------------------------------------------------------
// Internal: create upgrade context
// ---------------------------------------------------------------------------

function createContext(component, { tempDir, newVersion, mode, jsonOutput, source, registryEntry } = {}) {
  const skillDir = path.join(SKILLS_DIR, component);
  const dataDir = path.join(COMPONENTS_DIR, component);

  return {
    component,
    skillDir,
    dataDir,
    tempDir: tempDir || null,
    newVersion: newVersion || null,
    mode: mode || 'merge',
    jsonOutput: Boolean(jsonOutput),
    source: source || null,
    registryEntry: registryEntry || null,
    sourceMarker: null,
    targetRegistryEntry: null,
    metadataRecoveryPending: false,
    metadataTransaction: null,
    // State tracking
    backupDir: null,
    dataBackupRoot: null,
    dataBackupDir: null,
    dataDirExisted: false,
    envBackupPath: null,
    envFileExisted: false,
    backupComplete: false,
    serviceStopped: false,
    serviceExists: true,
    serviceWasRunning: false,
    mutationStarted: false,
    caddyChanged: false,
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

// ---------------------------------------------------------------------------
// Upgrade pipeline
// ---------------------------------------------------------------------------

/**
 * Step 0: verify target-declared protocol requirements before stopping the
 * running channel or writing backups/files.
 */
function step0_verifyCapabilities(ctx) {
  const startTime = Date.now();
  if (!ctx.tempDir || !fs.existsSync(ctx.tempDir)) {
    return { step: 0, name: 'verify_capabilities', status: 'failed', error: 'Temp directory not available', duration: Date.now() - startTime };
  }

  const result = verifyTargetCapabilities(ctx.tempDir);
  if (result.status === 'incompatible') {
    return {
      step: 0,
      name: 'verify_capabilities',
      status: 'failed',
      error: `Incompatible target component: ${result.errors.join('; ')}`,
      duration: Date.now() - startTime,
    };
  }
  return {
    step: 0,
    name: 'verify_capabilities',
    status: result.status === 'compatible' ? 'done' : 'skipped',
    message: result.status === 'compatible' ? 'zylos-core protocols compatible' : result.reason,
    duration: Date.now() - startTime,
  };
}

/**
 * Step 3: stop PM2 service
 */
function step3_stopService(ctx) {
  const startTime = Date.now();
  const parsed = parseSkillMd(ctx.skillDir);
  const serviceName = parsed?.frontmatter?.lifecycle?.service?.name || `zylos-${ctx.component}`;

  try {
    const output = execSync('pm2 jlist 2>/dev/null', { encoding: 'utf8' });
    const processes = JSON.parse(output);
    const service = processes.find(p => p.name === serviceName);

    if (!service) {
      ctx.serviceExists = false;
      return { step: 3, name: 'stop_service', status: 'skipped', message: 'no service', duration: Date.now() - startTime };
    }

    ctx.serviceExists = true;
    ctx.serviceWasRunning = service.pm2_env?.status === 'online';

    if (!ctx.serviceWasRunning) {
      return { step: 3, name: 'stop_service', status: 'skipped', message: 'not running', duration: Date.now() - startTime };
    }

    execSync(`pm2 stop ${serviceName} 2>/dev/null`, { stdio: 'pipe' });
    ctx.serviceStopped = true;

    return { step: 3, name: 'stop_service', status: 'done', message: serviceName, duration: Date.now() - startTime };
  } catch {
    return { step: 3, name: 'stop_service', status: 'skipped', message: 'pm2 not available', duration: Date.now() - startTime };
  }
}

/**
 * Step 1: filesystem and component-data backup.
 */
function step1_backup(ctx) {
  const startTime = Date.now();
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupDir = path.join(ctx.skillDir, '.backup', timestamp);

  try {
    copyTree(ctx.skillDir, backupDir, { excludes: ['node_modules', '.backup', '.zylos'] });

    ctx.backupDir = backupDir;
    ctx.dataBackupRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-component-state-backup-'));
    ctx.dataDirExisted = fs.existsSync(ctx.dataDir);
    if (ctx.dataDirExisted) {
      ctx.dataBackupDir = path.join(ctx.dataBackupRoot, 'data');
      copyTree(ctx.dataDir, ctx.dataBackupDir, { excludes: [] });
    }
    ctx.envFileExisted = fs.existsSync(ENV_FILE);
    ctx.envBackupPath = path.join(ctx.dataBackupRoot, 'zylos.env');
    if (ctx.envFileExisted) fs.copyFileSync(ENV_FILE, ctx.envBackupPath);
    ctx.backupComplete = true;
    return { step: 1, name: 'backup', status: 'done', message: path.basename(backupDir), duration: Date.now() - startTime };
  } catch (err) {
    cleanupDataBackup(ctx);
    return { step: 1, name: 'backup', status: 'failed', error: `Backup failed: ${err.message}`, duration: Date.now() - startTime };
  }
}

/**
 * Step 2: execute the target release's pre-upgrade gate after a recoverable
 * backup exists, but before the service is stopped or installed files change.
 * Components that predate lifecycle hooks remain compatible and are skipped.
 */
export function step2_runPreUpgradeHook(ctx, deps = {}) {
  return runLifecycleHook(ctx, {
    hookName: 'pre-upgrade',
    rootDir: ctx.tempDir,
    step: 2,
    resultName: 'pre_upgrade_hook',
  }, deps);
}

/**
 * Step 4: smart merge new files into skill dir
 *
 * Uses three-way merge when possible:
 * - Local unmodified → overwrite
 * - Local modified + new unchanged → keep local
 * - Both changed → diff3 merge or overwrite + backup local
 */
function step4_smartMerge(ctx) {
  const startTime = Date.now();

  if (!ctx.tempDir || !fs.existsSync(ctx.tempDir)) {
    return { step: 4, name: 'smart_merge', status: 'failed', error: 'Temp directory not available', duration: Date.now() - startTime };
  }

  try {
    ctx.mutationStarted = true;
    const conflictBackupDir = ctx.backupDir ? path.join(ctx.backupDir, 'conflicts') : null;
    const mergeResult = smartSync(ctx.tempDir, ctx.skillDir, {
      backupDir: conflictBackupDir,
      mode: ctx.mode,
    });

    // Store merge info on context for final result
    ctx.mergeConflicts = mergeResult.conflicts;
    ctx.mergedFiles = mergeResult.merged;

    const msg = formatMergeResult(mergeResult);

    if (mergeResult.errors.length > 0) {
      return { step: 4, name: 'smart_merge', status: 'failed', error: mergeResult.errors.join('; '), duration: Date.now() - startTime };
    }

    ctx.nextManifest = mergeResult.nextManifest;

    return { step: 4, name: 'smart_merge', status: 'done', message: msg, duration: Date.now() - startTime };
  } catch (err) {
    return { step: 4, name: 'smart_merge', status: 'failed', error: `Merge failed: ${err.message}`, duration: Date.now() - startTime };
  }
}

/**
 * Step 5: npm install
 */
function step5_npmInstall(ctx) {
  const startTime = Date.now();
  const packageJson = path.join(ctx.skillDir, 'package.json');

  if (!fs.existsSync(packageJson)) {
    return { step: 5, name: 'npm_install', status: 'skipped', message: 'no package.json', duration: Date.now() - startTime };
  }

  try {
    execSync('npm install --omit=dev', {
      cwd: ctx.skillDir,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return { step: 5, name: 'npm_install', status: 'done', duration: Date.now() - startTime };
  } catch (err) {
    return { step: 5, name: 'npm_install', status: 'failed', error: err.stderr?.trim() || err.message, duration: Date.now() - startTime };
  }
}

/**
 * Step 6: verify that smart merge produced an authoritative baseline
 * candidate. It remains uncommitted until the outer transaction succeeds.
 */
function step6_generateManifest(ctx) {
  const startTime = Date.now();

  if (ctx.nextManifest) {
    return { step: 6, name: 'generate_manifest', status: 'skipped', message: 'authoritative baseline pending outer commit', duration: Date.now() - startTime };
  }
  return { step: 6, name: 'generate_manifest', status: 'failed', error: 'baseline candidate missing after smart merge', duration: Date.now() - startTime };
}

/**
 * Final step: commit manifest + originals only after every rollback-triggering
 * operation has succeeded. A pre-commit failure leaves the previous baseline
 * intact, so ordinary business-file rollback is sufficient.
 */
function step10_commitBaseline(ctx) {
  const startTime = Date.now();
  let metadataTransaction = null;
  let baselineCommitted = false;
  try {
    let manifest = ctx.nextManifest;
    if (ctx.source) {
      const updatedVersion = getLocalVersion(ctx.skillDir);
      const metadata = buildUpgradeMetadata({
        component: ctx.component,
        skillDir: ctx.skillDir,
        version: updatedVersion.success ? updatedVersion.version : ctx.newVersion,
        source: ctx.source,
        registryEntry: ctx.registryEntry,
      });
      const begun = beginUpgradeMetadataTransaction({
        component: ctx.component,
        skillDir: ctx.skillDir,
        marker: metadata.marker,
        targetRegistryEntry: metadata.targetRegistryEntry,
        manifest,
      });
      metadataTransaction = begun.journal;
      ctx.metadataTransaction = begun.journal;
      manifest = begun.manifest;
    }
    saveMergeBaseline(ctx.skillDir, ctx.tempDir, manifest);
    baselineCommitted = true;
    if (metadataTransaction) {
      const finalized = finalizeUpgradeMetadataTransaction(metadataTransaction);
      ctx.sourceMarker = finalized.marker;
      ctx.targetRegistryEntry = finalized.targetRegistryEntry;
    }
    return {
      step: 10,
      name: 'commit_baseline',
      status: 'done',
      message: ctx.sourceMarker
        ? 'authoritative source marker and baseline committed'
        : 'authoritative source baseline committed',
      duration: Date.now() - startTime,
    };
  } catch (err) {
    if (metadataTransaction && baselineCommitted) {
      ctx.sourceMarker = metadataTransaction.marker;
      ctx.targetRegistryEntry = metadataTransaction.targetRegistryEntry;
      ctx.metadataRecoveryPending = true;
      return {
        step: 10,
        name: 'commit_baseline',
        status: 'done',
        message: 'baseline committed; source metadata recovery pending',
        warning: err.message,
        metadataRecoveryPending: true,
        duration: Date.now() - startTime,
      };
    }
    return { step: 10, name: 'commit_baseline', status: 'failed', error: `Baseline commit failed: ${err.message}`, duration: Date.now() - startTime };
  }
}

/**
 * Step 7: update Caddy routes (if http_routes declared in SKILL.md)
 */
function step7_updateCaddyRoutes(ctx) {
  const startTime = Date.now();
  const parsed = parseSkillMd(ctx.skillDir);
  const httpRoutes = parsed?.frontmatter?.http_routes;

  if (!httpRoutes || !Array.isArray(httpRoutes) || httpRoutes.length === 0) {
    return { step: 7, name: 'caddy_routes', status: 'skipped', message: 'no http_routes', duration: Date.now() - startTime };
  }

  const result = applyCaddyRoutes(ctx.component, httpRoutes);
  if (result.success) {
    ctx.caddyChanged = result.action === 'added' || result.action === 'updated';
    return { step: 7, name: 'caddy_routes', status: 'done', message: result.action, caddy: result, duration: Date.now() - startTime };
  }
  if (result.action === 'manual_required') {
    return {
      step: 7,
      name: 'caddy_routes',
      status: 'skipped',
      message: 'manual configuration required',
      caddy: result,
      duration: Date.now() - startTime,
    };
  }
  // Caddy failures are non-fatal for upgrades
  return { step: 7, name: 'caddy_routes', status: 'skipped', message: result.error, caddy: result, duration: Date.now() - startTime };
}

function runLifecycleHook(ctx, {
  hookName,
  rootDir,
  step,
  resultName,
}, deps = {}) {
  const startTime = Date.now();
  const spawn = deps.spawnSync ?? spawnSync;
  const exists = deps.existsSync ?? fs.existsSync;
  const stdout = deps.stdout ?? process.stdout;
  const stderr = deps.stderr ?? process.stderr;

  const parsed = parseSkillMd(rootDir);
  const hookRel = parsed?.frontmatter?.lifecycle?.hooks?.[hookName];
  if (!hookRel) {
    return { step, name: resultName, status: 'skipped', message: `no ${hookName} hook`, duration: Date.now() - startTime };
  }

  const hookPath = path.resolve(rootDir, hookRel);
  const hookRelativePath = path.relative(rootDir, hookPath);
  if (hookRelativePath.startsWith('..') || path.isAbsolute(hookRelativePath)) {
    return { step, name: resultName, status: 'failed', error: `Hook path escapes component directory: ${hookRel}`, duration: Date.now() - startTime };
  }
  if (!exists(hookPath)) {
    return { step, name: resultName, status: 'failed', error: `Hook not found: ${hookRel}`, duration: Date.now() - startTime };
  }

  const realSkillDir = fs.realpathSync(rootDir);
  const realHookPath = fs.realpathSync(hookPath);
  const realHookRelativePath = path.relative(realSkillDir, realHookPath);
  if (realHookRelativePath.startsWith('..') || path.isAbsolute(realHookRelativePath)) {
    return { step, name: resultName, status: 'failed', error: `Hook path escapes component directory: ${hookRel}`, duration: Date.now() - startTime };
  }

  const child = spawn(process.execPath, [hookPath], {
    cwd: rootDir,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 300000,
  });

  const hookStdout = child.stdout || '';
  const hookStderr = child.stderr || '';
  if (!ctx.jsonOutput) {
    if (hookStdout) stdout.write(hookStdout);
    if (hookStderr) stderr.write(hookStderr);
  }

  const output = {
    stdout: truncateHookOutput(hookStdout),
    stderr: truncateHookOutput(hookStderr),
  };

  if (child.error) {
    return { step, name: resultName, status: 'failed', error: `Hook failed to start: ${child.error.message}`, output, duration: Date.now() - startTime };
  }
  if (child.status !== 0) {
    const detail = hookStderr.trim() || hookStdout.trim() || `exit code ${child.status}`;
    return { step, name: resultName, status: 'failed', error: `${hookName} hook failed: ${truncateHookOutput(detail)}`, output, duration: Date.now() - startTime };
  }
  return { step, name: resultName, status: 'done', message: hookRel, output, duration: Date.now() - startTime };
}

/** Step 8: run the installed release's post-upgrade hook transactionally. */
export function step7_runPostUpgradeHook(ctx, deps = {}) {
  return runLifecycleHook(ctx, {
    hookName: 'post-upgrade',
    rootDir: ctx.skillDir,
    step: 8,
    resultName: 'post_upgrade_hook',
  }, deps);
}

function truncateHookOutput(value, maxLength = 1000) {
  if (!value) return '';
  return value.length > maxLength ? `${value.slice(0, maxLength)}...` : value;
}

/**
 * Step 9: restart PM2 service (if it was running before upgrade).
 * The historical export name is retained for API compatibility.
 */
export function step8_startService(ctx, deps = {}) {
  const startTime = Date.now();
  const exec = deps.execSync ?? execSync;
  const exists = deps.existsSync ?? fs.existsSync;
  const restartManaged = deps.restartManagedProcess ?? restartManagedProcess;

  if (!ctx.serviceWasRunning) {
    return { step: 9, name: 'start_service', status: 'skipped', message: 'was not running', duration: Date.now() - startTime };
  }

  const parsed = parseSkillMd(ctx.skillDir);
  const serviceName = parsed?.frontmatter?.lifecycle?.service?.name || `zylos-${ctx.component}`;
  const ecosystemPath = path.join(ctx.skillDir, 'ecosystem.config.cjs');

  try {
    restartManaged(serviceName, { ecosystemPath, stdio: 'pipe', save: true });
    return { step: 9, name: 'start_service', status: 'done', message: serviceName, duration: Date.now() - startTime };
  } catch {
    // If the process disappeared from PM2 between step1 and step8, retry via
    // the component ecosystem so PM2 reloads the current service definition.
    try {
      if (!exists(ecosystemPath)) {
        throw new Error(`ecosystem config not found: ${ecosystemPath}`);
      }
      try { exec(`pm2 delete "${serviceName}" 2>/dev/null`, { stdio: 'pipe' }); } catch {}
      restartManaged(serviceName, { ecosystemPath, stdio: 'pipe', save: true });
      return { step: 9, name: 'start_service', status: 'done', message: `${serviceName} (restarted from ecosystem)`, duration: Date.now() - startTime };
    } catch {
      return { step: 9, name: 'start_service', status: 'failed', error: `Failed to restart ${serviceName}`, duration: Date.now() - startTime };
    }
  }
}

// ---------------------------------------------------------------------------
// Public: rollback
// ---------------------------------------------------------------------------

/**
 * Rollback from .backup/ directory.
 *
 * @param {object} ctx - Upgrade context
 * @param {object} [deps] - Injectable dependencies (testing seam)
 * @returns {object[]} Array of rollback action results
 */
export function rollback(ctx, deps = {}) {
  const results = [];

  // Restore files from backup (--delete removes files added by the failed upgrade)
  if (ctx.backupDir && fs.existsSync(ctx.backupDir)) {
    try {
      syncTree(ctx.backupDir, ctx.skillDir, { excludes: ['node_modules', '.backup', '.zylos', '.zylos-data'] });
      results.push({ action: 'restore_files', success: true });
    } catch (err) {
      results.push({ action: 'restore_files', success: false, error: err.message });
    }

    // Restore dependencies
    const packageJson = path.join(ctx.skillDir, 'package.json');
    if (fs.existsSync(packageJson)) {
      try {
        execSync('npm install --omit=dev', {
          cwd: ctx.skillDir,
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        results.push({ action: 'restore_dependencies', success: true });
      } catch (err) {
        results.push({ action: 'restore_dependencies', success: false, error: err.message });
      }
    }
  }

  // Lifecycle hooks may migrate component-owned configuration or state. Put
  // that data back in the same transaction as the code rollback. For a
  // component that had no data directory before the attempt, remove only the
  // directory created during the failed upgrade.
  results.push(...rollbackComponentData(ctx));

  if (ctx.caddyChanged) {
    const applyRoutes = deps.applyCaddyRoutes ?? applyCaddyRoutes;
    const removeRoutes = deps.removeCaddyRoutes ?? removeCaddyRoutes;
    // Read the route contract from the immutable backup rather than trusting
    // the live directory after a possibly-partial file restore.
    const parsed = parseSkillMd(ctx.backupDir || ctx.skillDir);
    const oldRoutes = parsed?.frontmatter?.http_routes;
    try {
      const result = Array.isArray(oldRoutes) && oldRoutes.length > 0
        ? applyRoutes(ctx.component, oldRoutes)
        : removeRoutes(ctx.component);
      results.push({
        action: 'restore_caddy_routes',
        success: result.success !== false,
        ...(result.success === false ? { error: result.error || 'Caddy route restore failed' } : {}),
      });
    } catch (err) {
      results.push({ action: 'restore_caddy_routes', success: false, error: err.message });
    }
  }

  // Restart service if it was running
  if (ctx.serviceWasRunning) {
    const restartManaged = deps.restartManagedProcess ?? restartManagedProcess;
    const parsed = parseSkillMd(ctx.skillDir);
    const serviceName = parsed?.frontmatter?.lifecycle?.service?.name || `zylos-${ctx.component}`;
    const ecosystemPath = path.join(ctx.skillDir, 'ecosystem.config.cjs');
    try {
      // save: true persists the PM2 dump so the rolled-back service survives a
      // reboot. Without it, a recreated process (pm2 delete + start) lives only
      // in memory and is lost on the next `pm2 resurrect`.
      restartManaged(serviceName, { ecosystemPath, stdio: 'pipe', save: true });
      results.push({ action: 'restart_service', success: true });
    } catch (err) {
      results.push({ action: 'restart_service', success: false, error: err.message });
    }
  }

  return results;
}

function rollbackComponentData(ctx) {
  if (!ctx.backupComplete) return [];
  const results = [];
  let restorationSucceeded = true;
  if (ctx.dataDirExisted && ctx.dataBackupDir && fs.existsSync(ctx.dataBackupDir)) {
    try {
      syncTree(ctx.dataBackupDir, ctx.dataDir, { excludes: [] });
      results.push({ action: 'restore_data', success: true });
    } catch (err) {
      restorationSucceeded = false;
      results.push({ action: 'restore_data', success: false, error: err.message, backupDir: ctx.dataBackupDir });
    }
  } else if (!ctx.dataDirExisted && fs.existsSync(ctx.dataDir)) {
    try {
      fs.rmSync(ctx.dataDir, { recursive: true, force: true });
      results.push({ action: 'remove_new_data', success: true });
    } catch (err) {
      restorationSucceeded = false;
      results.push({ action: 'remove_new_data', success: false, error: err.message });
    }
  }

  let envChanged = true;
  try {
    envChanged = ctx.envFileExisted
      ? (!fs.existsSync(ENV_FILE) || !fs.readFileSync(ENV_FILE).equals(fs.readFileSync(ctx.envBackupPath)))
      : fs.existsSync(ENV_FILE);
  } catch {
    // Treat an unreadable current file as changed and attempt the restore;
    // the copy/remove branch below will retain the backup path on failure.
  }
  if (envChanged) {
    try {
      if (ctx.envFileExisted) {
        fs.mkdirSync(path.dirname(ENV_FILE), { recursive: true });
        fs.copyFileSync(ctx.envBackupPath, ENV_FILE);
      } else {
        fs.rmSync(ENV_FILE, { force: true });
      }
      results.push({ action: 'restore_environment', success: true });
    } catch (err) {
      restorationSucceeded = false;
      results.push({ action: 'restore_environment', success: false, error: err.message, backupPath: ctx.envBackupPath });
    }
  }

  if (restorationSucceeded) cleanupDataBackup(ctx);
  return results;
}

function cleanupDataBackup(ctx) {
  try {
    if (ctx.dataBackupRoot && fs.existsSync(ctx.dataBackupRoot)) {
      fs.rmSync(ctx.dataBackupRoot, { recursive: true, force: true });
    }
  } catch {
    return false;
  }
  ctx.dataBackupRoot = null;
  ctx.dataBackupDir = null;
  ctx.envBackupPath = null;
  return true;
}

// ---------------------------------------------------------------------------
// Public: runUpgrade
// ---------------------------------------------------------------------------

/**
 * Run the validated upgrade pipeline (mechanical operations only).
 * Lock must be acquired by caller (component.js).
 *
 * @param {string} component
 * @param {{ tempDir: string, newVersion: string, source?: object, registryEntry?: object }} opts
 * @returns {object} Upgrade result
 */
export function runUpgrade(component, { tempDir, newVersion, mode, jsonOutput, onStep, source, registryEntry } = {}) {
  recoverUpgradeMetadataTransactions({ component });
  const ctx = createContext(component, { tempDir, newVersion, mode, jsonOutput, source, registryEntry });

  if (!fs.existsSync(ctx.skillDir)) {
    return {
      action: 'upgrade',
      component,
      success: false,
      error: `Component directory not found: ${ctx.skillDir}`,
      steps: [],
    };
  }

  if (source) {
    try {
      validateUpgradeSource(source);
    } catch (err) {
      return {
        action: 'upgrade',
        component,
        success: false,
        error: `Invalid upgrade source: ${err.message}`,
        steps: [],
      };
    }
  }

  // Record current version
  const localVersion = getLocalVersion(ctx.skillDir);
  if (localVersion.success) {
    ctx.from = localVersion.version;
  }
  ctx.to = newVersion || null;

  const steps = [
    step0_verifyCapabilities,
    step1_backup,
    step2_runPreUpgradeHook,
    step3_stopService,
    step4_smartMerge,
    step5_npmInstall,
    step6_generateManifest,
    step7_updateCaddyRoutes,
    step7_runPostUpgradeHook,
    step8_startService,
    step10_commitBaseline,
  ];

  const total = steps.length;
  let failedStep = null;

  for (const stepFn of steps) {
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

  // If failed, rollback
  if (failedStep) {
    const rollbackNeeded = ctx.serviceStopped || ctx.mutationStarted;
    const dataRollback = !rollbackNeeded ? rollbackComponentData(ctx) : [];
    const rollbackResults = rollbackNeeded ? rollback(ctx) : dataRollback;
    if (ctx.metadataTransaction) {
      const rollbackComplete = rollbackResults.length > 0
        && rollbackResults.every(result => result.success === true);
      if (rollbackComplete) {
        try {
          abortUpgradeMetadataTransaction(ctx.metadataTransaction);
          rollbackResults.push({ action: 'abort_source_metadata_transaction', success: true });
        } catch (err) {
          rollbackResults.push({
            action: 'preserve_source_metadata_transaction',
            success: false,
            error: err.message,
          });
        }
      } else {
        rollbackResults.push({
          action: 'preserve_source_metadata_transaction',
          success: false,
          error: 'business rollback was not fully successful; manual recovery required',
        });
      }
    }
    const rollbackPerformed = rollbackNeeded || dataRollback.length > 0;
    return {
      action: 'upgrade',
      component,
      success: false,
      from: ctx.from,
      to: null,
      failedStep: failedStep.step,
      error: failedStep.error,
      steps: ctx.steps,
      rollback: { performed: rollbackPerformed, steps: rollbackResults },
    };
  }

  // Success — read the new version and SKILL.md metadata
  cleanupDataBackup(ctx);
  const updatedVersion = getLocalVersion(ctx.skillDir);
  if (updatedVersion.success) {
    ctx.to = updatedVersion.version;
  }

  // Include SKILL.md metadata for Claude (hooks, config, service info)
  const skillMeta = parseSkillMd(ctx.skillDir);
  const fm = skillMeta?.frontmatter || {};
  const lifecycle = fm.lifecycle || {};
  const hooks = lifecycle.hooks || {};
  const config = fm.config || {};

  // Extract Caddy result from steps
  const caddyStep = ctx.steps.find(s => s.name === 'caddy_routes');
  const caddyResult = caddyStep?.caddy
    ? { ...caddyStep.caddy, status: caddyStep.status }
    : (caddyStep ? { action: caddyStep.message, status: caddyStep.status } : null);

  return {
    action: 'upgrade',
    component,
    success: true,
    from: ctx.from,
    to: ctx.to,
    steps: ctx.steps,
    backupDir: ctx.backupDir,
    source: ctx.sourceMarker,
    targetRegistryEntry: ctx.targetRegistryEntry,
    metadataRecoveryPending: ctx.metadataRecoveryPending,
    skill: {
      hooks: Object.keys(hooks).length > 0 ? hooks : null,
      config: Object.keys(config).length > 0 ? config : null,
      service: lifecycle.service || null,
      caddy: caddyResult,
    },
    mergeConflicts: ctx.mergeConflicts.length > 0 ? ctx.mergeConflicts : null,
    mergedFiles: ctx.mergedFiles.length > 0 ? ctx.mergedFiles : null,
  };
}
