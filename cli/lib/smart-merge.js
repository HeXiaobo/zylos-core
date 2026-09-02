/**
 * Smart merge: three-way merge for upgrade conflict resolution.
 *
 * Replaces the old "preserve" strategy. Every file gets a definitive outcome:
 * - overwrite: local unmodified, new version applied
 * - keep: local modified, new version unchanged (local is the only delta)
 * - merged: both sides changed, diff3 produced a clean merge
 * - overwritten: both sides changed, conflict — new version wins, local backed up
 *
 * The backup serves as a safety net. In conversation mode, Claude can review
 * backed-up files and perform intelligent re-merging. In CLI mode, the user
 * is prompted to let Claude review after the upgrade.
 */

import fs from 'node:fs';
import path from 'node:path';
import {
  generateManifest,
  hashFile,
  loadManifest,
  recoverMergeBaseline,
  getOriginalContent,
  hasOriginals,
} from './manifest.js';
import { isDiff3Available, merge3 } from './diff3.js';

/**
 * Check if a file appears to be binary by looking for null bytes in the first 8KB.
 */
function isBinaryFile(filePath) {
  const fd = fs.openSync(filePath, 'r');
  try {
    const buf = Buffer.alloc(8192);
    const bytesRead = fs.readSync(fd, buf, 0, 8192, 0);
    return buf.subarray(0, bytesRead).includes(0x00);
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * @typedef {Object} MergeResult
 * @property {string[]} overwritten  - Files overwritten (local unmodified)
 * @property {string[]} kept         - Files kept (only local modified, new unchanged)
 * @property {string[]} merged       - Files auto-merged via diff3
 * @property {ConflictFile[]} conflicts - Files where local was backed up, new version written
 * @property {string[]} added        - New files added
 * @property {string[]} deleted      - Files deleted (removed in new version)
 * @property {string[]} preserved    - Files removed upstream but kept locally (local modifications detected)
 * @property {string[]} errors       - Error descriptions
 * @property {object|null} nextManifest - Authoritative source manifest to commit at the caller's transaction boundary
 */

/**
 * @typedef {Object} ConflictFile
 * @property {string} file       - Relative file path
 * @property {string} backupPath - Absolute path to backed-up local version
 */

/**
 * Smart sync: merge files from srcDir into destDir using three-way strategy.
 *
 * @param {string} srcDir  - New version source directory
 * @param {string} destDir - Installed destination directory
 * @param {object} [opts]
 * @param {string} [opts.backupDir] - Directory to store backed-up conflict files
 * @param {string} [opts.mode]     - 'merge' (default) or 'overwrite' (skip merge, overwrite all)
 * @param {string} [opts.runtimeNodeModulesPath] - Expected runtime dependency target for a root source node_modules symlink
 * @returns {MergeResult}
 */
export function smartSync(srcDir, destDir, opts = {}) {
  const runtimeNodeModulesPath = opts.runtimeNodeModulesPath
    ? path.resolve(opts.runtimeNodeModulesPath)
    : null;
  const safetyErrors = [
    ...sourceTreeErrors(path.resolve(srcDir), { runtimeNodeModulesPath }),
    ...destinationTreeErrors(path.resolve(destDir)),
  ];
  if (safetyErrors.length > 0) return emptyMergeResult(safetyErrors);

  // Repair any interrupted baseline transaction BEFORE reading the manifest
  // or originals — a half-committed baseline read here would misclassify
  // local modifications (e.g. degrade clean merges into conflicts).
  try {
    recoverMergeBaseline(destDir);
  } catch (err) {
    // Baseline is untrustworthy and was deliberately left untouched —
    // merging against it could corrupt user files. Abort the sync.
    return emptyMergeResult([`baseline recovery failed: ${err.message}`]);
  }

  const plan = planSmartSync(srcDir, destDir, {
    ...opts,
    runtimeNodeModulesPath,
  });
  if (plan.errors.length > 0) return emptyMergeResult(plan.errors);
  return reifySmartSyncPlan(plan);
}

function emptyMergeResult(errors = []) {
  return {
    overwritten: [],
    kept: [],
    merged: [],
    conflicts: [],
    added: [],
    deleted: [],
    preserved: [],
    errors: [...errors],
    nextManifest: null,
  };
}

function isSafeRelativePath(relPath) {
  if (typeof relPath !== 'string' || relPath.length === 0 || path.isAbsolute(relPath)) return false;
  const normalized = path.normalize(relPath);
  return normalized !== '..'
    && !normalized.startsWith(`..${path.sep}`)
    && normalized === relPath;
}

function lstatIfPresent(filePath) {
  try {
    return fs.lstatSync(filePath);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

const SMART_SYNC_TREE_EXCLUDES = new Set(['.git', 'node_modules', '.backup']);

function isRuntimeNodeModulesSymlink(rootDir, relativePath, runtimeNodeModulesPath) {
  if (relativePath !== 'node_modules' || !runtimeNodeModulesPath) return false;
  try {
    return fs.realpathSync(path.join(rootDir, relativePath))
      === fs.realpathSync(runtimeNodeModulesPath);
  } catch {
    return false;
  }
}

function treeSymlinkErrors(rootDir, role, { runtimeNodeModulesPath = null } = {}) {
  const errors = [];

  function visit(dir) {
    const entries = fs.readdirSync(dir, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const entryPath = path.join(dir, entry.name);
      const relPath = path.relative(rootDir, entryPath);
      const stat = fs.lstatSync(entryPath);
      if (stat.isSymbolicLink()) {
        const runtimeOnly = role === 'source'
          && isRuntimeNodeModulesSymlink(rootDir, relPath, runtimeNodeModulesPath);
        if (!runtimeOnly) errors.push(`${relPath}: ${role} path is a symlink`);
      } else if (SMART_SYNC_TREE_EXCLUDES.has(entry.name)) {
        continue;
      } else if (stat.isDirectory()) {
        visit(entryPath);
      }
    }
  }

  visit(rootDir);
  return errors;
}

function sourceTreeErrors(rootDir, options = {}) {
  const rootStat = lstatIfPresent(rootDir);
  if (rootStat === null) return [`source root does not exist: ${rootDir}`];
  if (rootStat.isSymbolicLink()) return [`source root is a symlink: ${rootDir}`];
  if (!rootStat.isDirectory()) return [`source root is not a directory: ${rootDir}`];
  return treeSymlinkErrors(rootDir, 'source', options);
}

function destinationRootErrors(rootDir) {
  const rootStat = lstatIfPresent(rootDir);
  if (rootStat === null) return [];
  if (rootStat.isSymbolicLink()) return [`destination root is a symlink: ${rootDir}`];
  if (!rootStat.isDirectory()) return [`destination root is not a directory: ${rootDir}`];
  return [];
}

function destinationTreeErrors(rootDir) {
  const rootErrors = destinationRootErrors(rootDir);
  if (rootErrors.length > 0 || lstatIfPresent(rootDir) === null) return rootErrors;
  return treeSymlinkErrors(rootDir, 'destination');
}

function destinationParentError(rootDir, targetPath) {
  const relative = path.relative(rootDir, targetPath);
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
    return 'destination path escapes its root';
  }
  const parts = relative.split(path.sep);
  let current = rootDir;
  for (const part of parts.slice(0, -1)) {
    current = path.join(current, part);
    const stat = lstatIfPresent(current);
    if (stat === null) break;
    if (stat.isSymbolicLink()) return 'destination path crosses a nested symlink';
    if (!stat.isDirectory()) return 'destination path crosses a non-directory parent';
  }
  return null;
}

function publicChange(operation) {
  const change = {
    file: operation.file,
    certainty: 'exact',
    reason: operation.reason,
  };
  if (operation.outcome) change.outcome = operation.outcome;
  if (operation.backupPath !== undefined) change.backupPath = operation.backupPath;
  return change;
}

function addOperation(plan, operation) {
  plan.operations.push(operation);
  plan.changes[operation.action].push(publicChange(operation));
}

function operationDestinationError(plan, operation) {
  if (!isSafeRelativePath(operation.file)) {
    return `${operation.file}: unsafe operation path`;
  }
  const expectedPath = path.join(plan.destinationDir, operation.file);
  if (path.resolve(operation.destFile) !== expectedPath) {
    return `${operation.file}: destination operation path does not match its root`;
  }
  const parentError = destinationParentError(plan.destinationDir, expectedPath);
  if (parentError) return `${operation.file}: ${parentError}`;

  const stat = lstatIfPresent(expectedPath);
  if (operation.action === 'create') {
    return stat === null
      ? null
      : `${operation.file}: destination changed after planning: expected an absent path`;
  }
  if (stat === null || !stat.isFile() || stat.isSymbolicLink()) {
    return `${operation.file}: destination changed after planning: expected a regular non-symlink file`;
  }
  return null;
}

function reifyPlanErrors(plan) {
  if (!plan || plan.schema !== 'zylos.smart-sync-plan/v1') {
    return ['invalid smart-sync plan'];
  }
  if (plan.errors.length > 0) return [...plan.errors];

  const errors = [
    ...sourceTreeErrors(plan.sourceDir, {
      runtimeNodeModulesPath: plan.runtimeNodeModulesPath,
    }),
    ...destinationTreeErrors(plan.destinationDir),
  ];
  if (errors.length > 0) return errors;

  const currentSourceManifest = generateManifest(plan.sourceDir);
  if (!plan.nextManifest
      || JSON.stringify(currentSourceManifest.files) !== JSON.stringify(plan.nextManifest.files)) {
    return ['source tree changed after planning'];
  }

  for (const operation of plan.operations) {
    const error = operationDestinationError(plan, operation);
    if (error) errors.push(error);
  }
  return errors;
}

function recoveryResidue(destDir) {
  const metadataDir = path.join(destDir, '.zylos');
  return [
    'manifest.json.tmp',
    'originals.new',
    'originals.bak',
  ].filter((name) => fs.existsSync(path.join(metadataDir, name)));
}

/**
 * Build the exact file-operation plan consumed by smartSync without changing
 * the source, destination, manifest, originals, or conflict-backup trees.
 * Interrupted baseline state is reported instead of repaired: recovery is a
 * mutating transaction owned by smartSync, not by a dry-run caller.
 *
 * @param {string} srcDir
 * @param {string} destDir
 * @param {object} [opts]
 * @param {string} [opts.backupDir]
 * @param {string} [opts.mode]
 * @param {string} [opts.runtimeNodeModulesPath] - Expected runtime dependency target for a root source node_modules symlink
 * @returns {{schema: string, mode: string, sourceDir: string, destinationDir: string, changes: object, operations: object[], errors: string[], nextManifest: object|null}}
 */
export function planSmartSync(srcDir, destDir, opts = {}) {
  const { backupDir = null, mode = 'merge' } = opts;
  let { runtimeNodeModulesPath = null } = opts;
  srcDir = path.resolve(srcDir);
  destDir = path.resolve(destDir);
  runtimeNodeModulesPath = runtimeNodeModulesPath
    ? path.resolve(runtimeNodeModulesPath)
    : null;
  const plan = {
    schema: 'zylos.smart-sync-plan/v1',
    mode,
    sourceDir: path.resolve(srcDir),
    destinationDir: path.resolve(destDir),
    changes: { create: [], update: [], delete: [], preserve: [], conflict: [] },
    operations: [],
    errors: [],
    nextManifest: null,
    runtimeNodeModulesPath,
  };

  if (mode !== 'merge' && mode !== 'overwrite') {
    plan.errors.push(`unsupported smart sync mode: ${mode}`);
    return plan;
  }

  plan.errors.push(...sourceTreeErrors(srcDir, { runtimeNodeModulesPath }));
  plan.errors.push(...destinationTreeErrors(destDir));
  if (plan.errors.length > 0) return plan;

  const residue = recoveryResidue(destDir);
  if (residue.length > 0) {
    plan.errors.push(`baseline recovery required before exact planning: ${residue.join(', ')}`);
    return plan;
  }

  const savedManifest = loadManifest(destDir);
  const newManifest = generateManifest(srcDir);
  const diff3Available = isDiff3Available();
  const originalsExist = hasOriginals(destDir);
  plan.nextManifest = newManifest;

  // Generate current manifest for comparison (if we have a saved one)
  let currentManifest;
  if (savedManifest) {
    currentManifest = generateManifest(destDir);
  }

  for (const [relPath, newHash] of Object.entries(newManifest.files)) {
    if (!isSafeRelativePath(relPath)) {
      plan.errors.push(`${relPath}: unsafe source path`);
      continue;
    }
    const srcFile = path.join(srcDir, relPath);
    const destFile = path.join(destDir, relPath);

    const parentError = destinationParentError(destDir, destFile);
    if (parentError) {
      plan.errors.push(`${relPath}: ${parentError}`);
      continue;
    }

    const destStat = lstatIfPresent(destFile);

    // New file — just add it
    if (destStat === null) {
      addOperation(plan, {
        action: 'create', outcome: 'added', file: relPath, srcFile, destFile,
        reason: 'destination_missing',
      });
      continue;
    }

    if (!destStat.isFile() || destStat.isSymbolicLink()) {
      plan.errors.push(`${relPath}: destination is not a regular non-symlink file`);
      continue;
    }

    // Overwrite mode — skip merge logic, always overwrite
    if (mode === 'overwrite') {
      addOperation(plan, {
        action: 'update', outcome: 'overwritten', file: relPath, srcFile, destFile,
        reason: 'overwrite_mode',
      });
      continue;
    }

    // No manifest — can't tell if user modified; treat as overwrite
    if (!savedManifest) {
      addOperation(plan, {
        action: 'update', outcome: 'overwritten', file: relPath, srcFile, destFile,
        reason: 'baseline_manifest_missing',
      });
      continue;
    }

    const savedHash = savedManifest.files[relPath];
    const currentHash = currentManifest.files[relPath];

    // File didn't exist in previous manifest — user may have added it.
    // Treat as conflict: backup the user's local version, write new version.
    if (!savedHash) {
      // The file can be absent from an older manifest while already matching
      // the incoming package byte-for-byte (for example after a previously
      // interrupted baseline update). There is no user delta to preserve in
      // that case, so leave the file untouched and do not report a conflict.
      if (currentHash === newHash) {
        continue;
      }

      addOperation(plan, {
        action: 'conflict', outcome: 'conflict', file: relPath, srcFile, destFile,
        backupPath: backupDir ? path.join(backupDir, relPath) : null,
        reason: 'incoming_collides_with_untracked_local_file',
      });
      continue;
    }

    const localModified = currentHash !== savedHash;
    const newChanged = newHash !== savedHash;

    if (!localModified) {
      // Local unmodified — safe to overwrite
      if (newChanged) {
        addOperation(plan, {
          action: 'update', outcome: 'overwritten', file: relPath, srcFile, destFile,
          reason: 'upstream_changed_local_unmodified',
        });
      }
      // else: neither changed, nothing to do
      continue;
    }

    if (!newChanged) {
      // Only local modified, new version unchanged — keep local
      addOperation(plan, {
        action: 'preserve', outcome: 'kept', file: relPath, destFile,
        reason: 'local_changed_upstream_unchanged',
      });
      continue;
    }

    // Both sides changed — attempt three-way merge
    // Skip text merge for binary files to avoid corruption
    if (isBinaryFile(destFile) || isBinaryFile(srcFile)) {
      addOperation(plan, {
        action: 'conflict', outcome: 'conflict', file: relPath, srcFile, destFile,
        backupPath: backupDir ? path.join(backupDir, relPath) : null,
        reason: 'binary_changed_on_both_sides',
      });
      continue;
    }

    const localContent = fs.readFileSync(destFile, 'utf8');
    const newContent = fs.readFileSync(srcFile, 'utf8');
    let baseContent = null;

    if (originalsExist) {
      baseContent = getOriginalContent(destDir, relPath);
    }

    if (baseContent !== null && diff3Available) {
      try {
        const mergeResult = merge3(baseContent, localContent, newContent);
        if (mergeResult.clean) {
          addOperation(plan, {
            action: 'update', outcome: 'merged', file: relPath, destFile,
            content: mergeResult.content,
            reason: 'clean_three_way_merge',
          });
          continue;
        }
      } catch {
        // diff3 error — fall through to overwrite+backup
      }
    }

    // Cannot merge (no originals, no diff3, or conflict) — overwrite + backup local
    addOperation(plan, {
      action: 'conflict', outcome: 'conflict', file: relPath, srcFile, destFile,
      backupPath: backupDir ? path.join(backupDir, relPath) : null,
      reason: baseContent === null
        ? 'merge_base_missing'
        : diff3Available ? 'three_way_merge_conflict' : 'diff3_unavailable',
    });
  }

  // Delete files that were in the old version but removed in the new version.
  // Only delete files tracked in the old manifest — user-added files are preserved.
  // In merge mode, a tracked file with local modifications is never deleted
  // silently: it is backed up (when possible) and kept in place, reported via
  // result.preserved. Overwrite mode deletes unconditionally — that is its
  // contract: force the destination to match the new version exactly.
  if (savedManifest) {
    const newFiles = new Set(Object.keys(newManifest.files));
    for (const file of Object.keys(savedManifest.files)) {
      if (!isSafeRelativePath(file)) {
        plan.errors.push(`${file}: unsafe path in saved manifest`);
        continue;
      }
      if (!newFiles.has(file)) {
        const destFile = path.join(destDir, file);
        const parentError = destinationParentError(destDir, destFile);
        if (parentError) {
          plan.errors.push(`${file}: tracked ${parentError}`);
          continue;
        }
        const destStat = lstatIfPresent(destFile);
        if (destStat === null) continue;
        if (!destStat.isFile() || destStat.isSymbolicLink()) {
          plan.errors.push(`${file}: tracked destination is not a regular non-symlink file`);
          continue;
        }
        if (mode !== 'overwrite' && hashFile(destFile) !== savedManifest.files[file]) {
          addOperation(plan, {
            action: 'preserve', outcome: 'preserved', file, destFile,
            backupPath: backupDir ? path.join(backupDir, file) : null,
            reason: 'upstream_removed_local_modified',
          });
          continue;
        }
        addOperation(plan, {
          action: 'delete', outcome: 'deleted', file, destFile,
          reason: mode === 'overwrite'
            ? 'overwrite_mode_upstream_removed'
            : 'tracked_upstream_removed_local_unmodified',
        });
      }
    }
  }

  if (plan.errors.length > 0) plan.nextManifest = null;
  return plan;
}

export function reifySmartSyncPlan(plan) {
  const validationErrors = reifyPlanErrors(plan);
  if (validationErrors.length > 0) return emptyMergeResult(validationErrors);

  const result = emptyMergeResult();

  for (const operation of plan.operations) {
    try {
      const destinationError = operationDestinationError(plan, operation);
      if (destinationError) {
        result.errors.push(destinationError);
        break;
      }
      if (operation.action === 'create') {
        fs.mkdirSync(path.dirname(operation.destFile), { recursive: true });
        fs.copyFileSync(operation.srcFile, operation.destFile);
        result.added.push(operation.file);
      } else if (operation.action === 'update' && operation.outcome === 'merged') {
        fs.writeFileSync(operation.destFile, operation.content);
        result.merged.push(operation.file);
      } else if (operation.action === 'update') {
        fs.copyFileSync(operation.srcFile, operation.destFile);
        result.overwritten.push(operation.file);
      } else if (operation.action === 'conflict') {
        if (operation.backupPath) {
          fs.mkdirSync(path.dirname(operation.backupPath), { recursive: true });
          fs.copyFileSync(operation.destFile, operation.backupPath);
        }
        fs.copyFileSync(operation.srcFile, operation.destFile);
        result.conflicts.push({ file: operation.file, backupPath: operation.backupPath });
      } else if (operation.action === 'preserve' && operation.outcome === 'kept') {
        result.kept.push(operation.file);
      } else if (operation.action === 'preserve') {
        if (operation.backupPath) {
          fs.mkdirSync(path.dirname(operation.backupPath), { recursive: true });
          fs.copyFileSync(operation.destFile, operation.backupPath);
        }
        result.preserved.push(operation.file);
      } else if (operation.action === 'delete') {
        fs.unlinkSync(operation.destFile);
        result.deleted.push(operation.file);
        let dir = path.dirname(operation.destFile);
        while (dir !== plan.destinationDir) {
          const entries = fs.readdirSync(dir);
          if (entries.length > 0) break;
          fs.rmdirSync(dir);
          dir = path.dirname(dir);
        }
      }
    } catch (err) {
      result.errors.push(`${operation.file}: ${operation.action} failed: ${err.message}`);
    }
  }

  // Hand the authoritative next baseline to the transaction owner. smartSync
  // changes business files, but it does not know whether later pipeline steps
  // (npm install, hooks, service restart, etc.) will succeed. Persisting here
  // would advance metadata before the outer operation commits and force the
  // rollback layer to compensate by snapshotting/restoring the baseline.
  //
  // A partially-applied sync or any recorded error keeps the previous
  // baseline. On success, the caller commits this source-generated manifest
  // together with source originals at its own final success boundary.
  if (result.errors.length === 0) {
    result.nextManifest = plan.nextManifest;
  }

  return result;
}

/**
 * Format a MergeResult into a human-readable summary string.
 *
 * @param {MergeResult} result
 * @returns {string}
 */
export function formatMergeResult(result) {
  const parts = [];
  if (result.overwritten.length) parts.push(`${result.overwritten.length} overwritten`);
  if (result.kept.length) parts.push(`${result.kept.length} kept`);
  if (result.merged.length) parts.push(`${result.merged.length} merged`);
  if (result.conflicts.length) parts.push(`${result.conflicts.length} conflicts`);
  if (result.added.length) parts.push(`${result.added.length} added`);
  if (result.deleted.length) parts.push(`${result.deleted.length} deleted`);
  if (result.preserved?.length) parts.push(`${result.preserved.length} preserved`);
  if (result.errors.length) parts.push(`${result.errors.length} errors`);
  return parts.join(', ') || 'no changes';
}
