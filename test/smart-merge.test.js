import { describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  formatMergeResult,
  planSmartSync,
  reifySmartSyncPlan,
  smartSync,
} from '../cli/lib/smart-merge.js';
import { generateManifest, saveManifest, saveOriginals, saveMergeBaseline, loadManifest, hashFile } from '../cli/lib/manifest.js';

let tmpRoot;

function mkTmp() {
  return fs.mkdtempSync(path.join(tmpRoot, 'test-'));
}

function writeFile(dir, relPath, content) {
  const full = path.join(dir, relPath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

function readFile(dir, relPath) {
  return fs.readFileSync(path.join(dir, relPath), 'utf8');
}

function fileExists(dir, relPath) {
  return fs.existsSync(path.join(dir, relPath));
}

function normalizePlan(plan) {
  return Object.fromEntries(Object.entries(plan.changes).map(([action, changes]) => [
    action,
    changes.map(({ file }) => file).toSorted(),
  ]));
}

function normalizeResult(result) {
  return {
    create: result.added.toSorted(),
    update: [...result.overwritten, ...result.merged].toSorted(),
    delete: result.deleted.toSorted(),
    preserve: [...result.kept, ...result.preserved].toSorted(),
    conflict: result.conflicts.map(({ file }) => file).toSorted(),
  };
}

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-test-'));
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('smartSync', () => {
  test('dry-run plan matches reify changes for a 459-file references upgrade', () => {
    const src = mkTmp();
    const dest = mkTmp();
    const backupDir = mkTmp();

    writeFile(dest, 'stable.js', 'stable');
    writeFile(dest, 'updated.js', 'old');
    writeFile(dest, 'kept.js', 'base');
    writeFile(dest, 'conflict.js', 'base\n');
    writeFile(dest, 'merged.js', 'first\nmiddle\nlast\n');
    for (let index = 0; index < 459; index += 1) {
      writeFile(dest, `references/generated-${index}.md`, `reference ${index}\n`);
    }
    saveManifest(dest, generateManifest(dest));
    saveOriginals(dest, dest);

    writeFile(dest, 'kept.js', 'local');
    writeFile(dest, 'conflict.js', 'local\n');
    writeFile(dest, 'merged.js', 'first local\nmiddle\nlast\n');
    writeFile(dest, 'user-added.md', 'user');

    writeFile(src, 'stable.js', 'stable');
    writeFile(src, 'updated.js', 'new');
    writeFile(src, 'kept.js', 'base');
    writeFile(src, 'conflict.js', 'upstream\n');
    writeFile(src, 'merged.js', 'first\nmiddle\nlast upstream\n');
    writeFile(src, 'created.js', 'created');

    const plan = planSmartSync(src, dest, { backupDir });
    const result = smartSync(src, dest, { backupDir });
    const actual = normalizeResult(result);
    const predicted = normalizePlan(plan);

    expect(plan.errors).toEqual([]);
    expect(predicted).toEqual(actual);
    expect(predicted.delete).toHaveLength(459);
    expect(result.merged).toEqual(['merged.js']);
    expect(Object.values(plan.changes).flat().every(({ certainty, reason }) =>
      certainty === 'exact' && typeof reason === 'string' && reason.length > 0
    )).toBe(true);
    expect(readFile(dest, 'user-added.md')).toBe('user');
  });

  test('dry-run plan matches reify when the baseline manifest is missing', () => {
    const src = mkTmp();
    const dest = mkTmp();

    writeFile(dest, 'collision.js', 'local');
    writeFile(dest, 'user-added.js', 'user');
    writeFile(src, 'collision.js', 'incoming');
    writeFile(src, 'created.js', 'created');

    const beforePlan = generateManifest(dest);
    const plan = planSmartSync(src, dest);
    expect(generateManifest(dest).files).toEqual(beforePlan.files);

    const result = smartSync(src, dest);
    expect(normalizePlan(plan)).toEqual(normalizeResult(result));
    expect(normalizePlan(plan)).toEqual({
      create: ['created.js'],
      update: ['collision.js'],
      delete: [],
      preserve: [],
      conflict: [],
    });
    expect(readFile(dest, 'user-added.js')).toBe('user');
  });

  test('overwrite plan matches reify without merge-mode preservation', () => {
    const src = mkTmp();
    const dest = mkTmp();
    const backupDir = mkTmp();

    writeFile(dest, 'changed.js', 'base');
    writeFile(dest, 'removed.js', 'base');
    saveManifest(dest, generateManifest(dest));
    saveOriginals(dest, dest);
    writeFile(dest, 'changed.js', 'local');
    writeFile(dest, 'removed.js', 'local');
    writeFile(src, 'changed.js', 'upstream');

    const plan = planSmartSync(src, dest, { mode: 'overwrite', backupDir });
    const result = smartSync(src, dest, { mode: 'overwrite', backupDir });

    expect(normalizePlan(plan)).toEqual(normalizeResult(result));
    expect(normalizePlan(plan)).toEqual({
      create: [],
      update: ['changed.js'],
      delete: ['removed.js'],
      preserve: [],
      conflict: [],
    });
  });

  test('plan and reify stay in parity after committing and repeating the same upgrade', () => {
    const src = mkTmp();
    const dest = mkTmp();
    const backupDir = mkTmp();

    writeFile(dest, 'stable.js', 'stable');
    writeFile(dest, 'removed.js', 'base');
    writeFile(dest, 'preserved.js', 'base');
    saveManifest(dest, generateManifest(dest));
    saveOriginals(dest, dest);
    writeFile(dest, 'preserved.js', 'local');
    writeFile(src, 'stable.js', 'stable');

    const firstPlan = planSmartSync(src, dest, { backupDir });
    const firstResult = smartSync(src, dest, { backupDir });
    expect(normalizePlan(firstPlan)).toEqual(normalizeResult(firstResult));
    saveMergeBaseline(dest, src, firstResult.nextManifest);

    const secondPlan = planSmartSync(src, dest, { backupDir });
    const secondResult = smartSync(src, dest, { backupDir });
    expect(normalizePlan(secondPlan)).toEqual(normalizeResult(secondResult));
    expect(normalizePlan(secondPlan)).toEqual({
      create: [], update: [], delete: [], preserve: [], conflict: [],
    });
    expect(readFile(dest, 'preserved.js')).toBe('local');
  });

  test('an outer rollback restores the same exact plan for a retry', () => {
    const src = mkTmp();
    const dest = mkTmp();
    const backupDir = mkTmp();
    const rollbackSnapshot = mkTmp();

    writeFile(dest, 'updated.js', 'old');
    writeFile(dest, 'removed.js', 'base');
    saveManifest(dest, generateManifest(dest));
    saveOriginals(dest, dest);
    writeFile(dest, 'local-only.js', 'user');
    writeFile(src, 'updated.js', 'new');
    writeFile(src, 'created.js', 'created');
    fs.cpSync(dest, rollbackSnapshot, { recursive: true });

    const beforeRollback = planSmartSync(src, dest, { backupDir });
    const applied = smartSync(src, dest, { backupDir });
    expect(normalizePlan(beforeRollback)).toEqual(normalizeResult(applied));

    fs.rmSync(dest, { recursive: true, force: true });
    fs.cpSync(rollbackSnapshot, dest, { recursive: true });

    const afterRollback = planSmartSync(src, dest, { backupDir });
    expect(normalizePlan(afterRollback)).toEqual(normalizePlan(beforeRollback));
    expect(Object.values(afterRollback.changes).flat()).toEqual(
      Object.values(beforeRollback.changes).flat(),
    );
    expect(readFile(dest, 'local-only.js')).toBe('user');
  });

  test('dry-run leaves recovery residue untouched while execute keeps supported recovery semantics', () => {
    const src = mkTmp();
    const dest = mkTmp();

    writeFile(dest, 'stable.js', 'stable');
    saveManifest(dest, generateManifest(dest));
    saveOriginals(dest, dest);
    writeFile(dest, '.zylos/manifest.json.tmp', '{"files":{"bogus.js":"deadbeef"}}');
    writeFile(dest, '.zylos/originals.new/bogus.js', 'staged');
    writeFile(src, 'stable.js', 'stable');

    const plan = planSmartSync(src, dest);
    expect(plan.errors).toEqual([
      'baseline recovery required before exact planning: manifest.json.tmp, originals.new',
    ]);
    expect(fileExists(dest, '.zylos/manifest.json.tmp')).toBe(true);
    expect(fileExists(dest, '.zylos/originals.new/bogus.js')).toBe(true);

    const result = smartSync(src, dest);
    expect(result.errors).toEqual([]);
    expect(fileExists(dest, '.zylos/manifest.json.tmp')).toBe(false);
    expect(fileExists(dest, '.zylos/originals.new')).toBe(false);
    expect(normalizeResult(result)).toEqual({
      create: [], update: [], delete: [], preserve: [], conflict: [],
    });
  });

  test('symlink collisions and manifest traversal fail closed without changing external files', () => {
    const src = mkTmp();
    const dest = mkTmp();
    const outside = path.join(tmpRoot, 'outside.txt');

    fs.writeFileSync(outside, 'outside');
    writeFile(dest, 'linked.js', 'base');
    saveManifest(dest, generateManifest(dest));
    fs.unlinkSync(path.join(dest, 'linked.js'));
    fs.symlinkSync(outside, path.join(dest, 'linked.js'));
    writeFile(src, 'linked.js', 'incoming');

    const symlinkPlan = planSmartSync(src, dest);
    const symlinkResult = smartSync(src, dest);
    expect(symlinkPlan.errors).toEqual([
      'linked.js: destination path is a symlink',
    ]);
    expect(symlinkResult.errors).toEqual(symlinkPlan.errors);
    expect(fs.readFileSync(outside, 'utf8')).toBe('outside');

    fs.unlinkSync(path.join(dest, 'linked.js'));
    writeFile(dest, 'safe.js', 'safe');
    saveManifest(dest, {
      files: { '../outside.txt': hashFile(outside) },
      generated_at: new Date().toISOString(),
    });
    fs.rmSync(src, { recursive: true, force: true });
    fs.mkdirSync(src, { recursive: true });

    const traversalPlan = planSmartSync(src, dest);
    const traversalResult = smartSync(src, dest);
    expect(traversalPlan.errors).toEqual(['../outside.txt: unsafe path in saved manifest']);
    expect(traversalResult.errors).toEqual(traversalPlan.errors);
    expect(fs.readFileSync(outside, 'utf8')).toBe('outside');

    const externalDir = path.join(tmpRoot, 'external-dir');
    fs.mkdirSync(externalDir);
    fs.symlinkSync(externalDir, path.join(dest, 'nested'));
    writeFile(src, 'nested/created.js', 'incoming');
    const nestedSymlinkPlan = planSmartSync(src, dest);
    const nestedSymlinkResult = smartSync(src, dest);
    expect(nestedSymlinkPlan.errors).toContain('nested: destination path is a symlink');
    expect(nestedSymlinkResult.errors).toEqual(nestedSymlinkPlan.errors);
    expect(fs.existsSync(path.join(externalDir, 'created.js'))).toBe(false);
  });

  test('a dangling destination symlink fails closed without creating its external target', () => {
    const src = mkTmp();
    const dest = mkTmp();
    const externalDir = path.join(tmpRoot, 'dangling-external');
    const externalTarget = path.join(externalDir, 'created.js');

    fs.mkdirSync(externalDir);
    fs.symlinkSync(externalTarget, path.join(dest, 'new.js'));
    writeFile(src, 'new.js', 'INCOMING');

    const plan = planSmartSync(src, dest);
    const result = smartSync(src, dest);

    expect(plan.errors).toEqual([
      'new.js: destination path is a symlink',
    ]);
    expect(result.errors).toEqual(plan.errors);
    expect(fs.existsSync(externalTarget)).toBe(false);
    expect(fs.lstatSync(path.join(dest, 'new.js')).isSymbolicLink()).toBe(true);
  });

  test('an unrelated destination symlink is not silently omitted from safety checks', () => {
    const src = mkTmp();
    const dest = mkTmp();
    const externalTarget = path.join(tmpRoot, 'unrelated-external.js');

    fs.symlinkSync(externalTarget, path.join(dest, 'user-link.js'));
    writeFile(src, 'safe.js', 'SAFE');

    const plan = planSmartSync(src, dest);
    const result = smartSync(src, dest);

    expect(plan.errors).toEqual(['user-link.js: destination path is a symlink']);
    expect(result.errors).toEqual(plan.errors);
    expect(fs.existsSync(path.join(dest, 'safe.js'))).toBe(false);
    expect(fs.existsSync(externalTarget)).toBe(false);
  });

  test('execute rejects a symlinked baseline directory before recovery can mutate it', () => {
    const src = mkTmp();
    const dest = mkTmp();
    const externalMetadata = path.join(tmpRoot, 'external-metadata');

    writeFile(src, 'safe.js', 'SAFE');
    fs.mkdirSync(path.join(externalMetadata, 'originals.new'), { recursive: true });
    fs.writeFileSync(path.join(externalMetadata, 'manifest.json.tmp'), '{}');
    fs.writeFileSync(path.join(externalMetadata, 'originals.new', 'marker.js'), 'EXTERNAL');
    fs.symlinkSync(externalMetadata, path.join(dest, '.zylos'));

    const plan = planSmartSync(src, dest);
    const result = smartSync(src, dest);

    expect(plan.errors).toEqual(['.zylos: destination path is a symlink']);
    expect(result.errors).toEqual(plan.errors);
    expect(fs.existsSync(path.join(externalMetadata, 'manifest.json.tmp'))).toBe(true);
    expect(readFile(externalMetadata, 'originals.new/marker.js')).toBe('EXTERNAL');
    expect(fs.existsSync(path.join(dest, 'safe.js'))).toBe(false);
  });

  test('a source file symlink is reported instead of silently omitted from the plan', () => {
    const src = mkTmp();
    const dest = mkTmp();
    const externalFile = path.join(tmpRoot, 'source-external.js');

    fs.writeFileSync(externalFile, 'EXTERNAL');
    fs.symlinkSync(externalFile, path.join(src, 'linked.js'));
    writeFile(dest, '.zylos/manifest.json.tmp', '{}');
    writeFile(dest, '.zylos/originals.new/marker.js', 'BASELINE');

    const plan = planSmartSync(src, dest);
    const result = smartSync(src, dest);

    expect(plan.errors).toEqual(['linked.js: source path is a symlink']);
    expect(result.errors).toEqual(plan.errors);
    expect(fs.existsSync(path.join(dest, 'linked.js'))).toBe(false);
    expect(fs.readFileSync(externalFile, 'utf8')).toBe('EXTERNAL');
    expect(fileExists(dest, '.zylos/manifest.json.tmp')).toBe(true);
    expect(readFile(dest, '.zylos/originals.new/marker.js')).toBe('BASELINE');
  });

  test('a source directory symlink is reported without traversing its external tree', () => {
    const src = mkTmp();
    const dest = mkTmp();
    const externalDir = path.join(tmpRoot, 'source-external-dir');

    fs.mkdirSync(externalDir);
    fs.writeFileSync(path.join(externalDir, 'payload.js'), 'EXTERNAL');
    fs.symlinkSync(externalDir, path.join(src, 'linked-dir'));

    const plan = planSmartSync(src, dest);
    const result = smartSync(src, dest);

    expect(plan.errors).toEqual(['linked-dir: source path is a symlink']);
    expect(result.errors).toEqual(plan.errors);
    expect(fs.existsSync(path.join(dest, 'linked-dir'))).toBe(false);
    expect(fs.readFileSync(path.join(externalDir, 'payload.js'), 'utf8')).toBe('EXTERNAL');
  });

  test('a source root symlink fails closed before manifest generation', () => {
    const realSource = mkTmp();
    const sourceLink = path.join(tmpRoot, 'source-root-link');
    const dest = mkTmp();

    writeFile(realSource, 'payload.js', 'EXTERNAL');
    fs.symlinkSync(realSource, sourceLink);

    const plan = planSmartSync(sourceLink, dest);
    const result = smartSync(sourceLink, dest);

    expect(plan.errors).toEqual([`source root is a symlink: ${sourceLink}`]);
    expect(result.errors).toEqual(plan.errors);
    expect(fs.existsSync(path.join(dest, 'payload.js'))).toBe(false);
  });

  test('a destination root symlink fails closed without writing through it', () => {
    const src = mkTmp();
    const realDestination = mkTmp();
    const destinationLink = path.join(tmpRoot, 'destination-root-link');

    writeFile(src, 'new.js', 'INCOMING');
    fs.symlinkSync(realDestination, destinationLink);

    const plan = planSmartSync(src, destinationLink);
    const result = smartSync(src, destinationLink);

    expect(plan.errors).toEqual([
      `destination root is a symlink: ${destinationLink}`,
    ]);
    expect(result.errors).toEqual(plan.errors);
    expect(fs.existsSync(path.join(realDestination, 'new.js'))).toBe(false);
  });

  test('a dangling destination root symlink is rejected without materializing its target', () => {
    const src = mkTmp();
    const destinationLink = path.join(tmpRoot, 'dangling-destination-root');
    const externalTarget = path.join(tmpRoot, 'missing-destination-root');

    writeFile(src, 'new.js', 'INCOMING');
    fs.symlinkSync(externalTarget, destinationLink);

    const plan = planSmartSync(src, destinationLink);
    const result = smartSync(src, destinationLink);

    expect(plan.errors).toEqual([
      `destination root is a symlink: ${destinationLink}`,
    ]);
    expect(result.errors).toEqual(plan.errors);
    expect(fs.existsSync(externalTarget)).toBe(false);
    expect(fs.lstatSync(destinationLink).isSymbolicLink()).toBe(true);
  });

  test('a dangling destination symlink chain is detected in parent components', () => {
    const src = mkTmp();
    const dest = mkTmp();
    const externalRoot = path.join(tmpRoot, 'missing-chain-target');

    fs.symlinkSync(externalRoot, path.join(dest, 'hop'));
    fs.symlinkSync('hop', path.join(dest, 'linked'));
    writeFile(src, 'linked/new.js', 'INCOMING');

    const plan = planSmartSync(src, dest);
    const result = smartSync(src, dest);

    expect(plan.errors).toEqual([
      'hop: destination path is a symlink',
      'linked: destination path is a symlink',
    ]);
    expect(result.errors).toEqual(plan.errors);
    expect(fs.existsSync(externalRoot)).toBe(false);
  });

  test('reifier rejects a destination leaf replaced by a symlink after planning', () => {
    const src = mkTmp();
    const dest = mkTmp();
    const externalDir = path.join(tmpRoot, 'toctou-external');
    const externalTarget = path.join(externalDir, 'created.js');

    fs.mkdirSync(externalDir);
    writeFile(src, 'new.js', 'INCOMING');
    const plan = planSmartSync(src, dest);
    expect(plan.errors).toEqual([]);

    fs.symlinkSync(externalTarget, path.join(dest, 'new.js'));
    const result = reifySmartSyncPlan(plan);

    expect(result.errors).toEqual([
      'new.js: destination path is a symlink',
    ]);
    expect(fs.existsSync(externalTarget)).toBe(false);
    expect(fs.lstatSync(path.join(dest, 'new.js')).isSymbolicLink()).toBe(true);
  });

  test('reifier rejects a destination root replaced by a symlink after planning', () => {
    const src = mkTmp();
    const dest = mkTmp();
    const parkedDestination = path.join(tmpRoot, 'parked-destination');
    const externalDestination = mkTmp();

    writeFile(src, 'new.js', 'INCOMING');
    const plan = planSmartSync(src, dest);
    expect(plan.errors).toEqual([]);

    fs.renameSync(dest, parkedDestination);
    fs.symlinkSync(externalDestination, dest);
    const result = reifySmartSyncPlan(plan);

    expect(result.errors).toEqual([`destination root is a symlink: ${dest}`]);
    expect(fs.existsSync(path.join(externalDestination, 'new.js'))).toBe(false);
  });

  test('reifier rejects a source root replaced by a symlink after planning', () => {
    const src = mkTmp();
    const dest = mkTmp();
    const parkedSource = path.join(tmpRoot, 'parked-source');
    const externalSource = mkTmp();

    writeFile(src, 'new.js', 'INCOMING');
    writeFile(externalSource, 'new.js', 'EXTERNAL');
    const plan = planSmartSync(src, dest);
    expect(plan.errors).toEqual([]);

    fs.renameSync(src, parkedSource);
    fs.symlinkSync(externalSource, src);
    const result = reifySmartSyncPlan(plan);

    expect(result.errors).toEqual([`source root is a symlink: ${src}`]);
    expect(fs.existsSync(path.join(dest, 'new.js'))).toBe(false);
    expect(readFile(externalSource, 'new.js')).toBe('EXTERNAL');
  });

  test('reifier rejects a destination parent replaced by a symlink chain after planning', () => {
    const src = mkTmp();
    const dest = mkTmp();
    const externalRoot = path.join(tmpRoot, 'toctou-chain-target');

    writeFile(src, 'nested/new.js', 'INCOMING');
    const plan = planSmartSync(src, dest);
    expect(plan.errors).toEqual([]);

    fs.symlinkSync(externalRoot, path.join(dest, 'hop'));
    fs.symlinkSync('hop', path.join(dest, 'nested'));
    const result = reifySmartSyncPlan(plan);

    expect(result.errors).toEqual([
      'hop: destination path is a symlink',
      'nested: destination path is a symlink',
    ]);
    expect(fs.existsSync(externalRoot)).toBe(false);
  });

  test('new file: added to dest', () => {
    const src = mkTmp();
    const dest = mkTmp();

    writeFile(src, 'newfile.js', 'new content');

    const result = smartSync(src, dest);
    expect(result.added).toContain('newfile.js');
    expect(readFile(dest, 'newfile.js')).toBe('new content');
  });

  test('no manifest: overwrite all files', () => {
    const src = mkTmp();
    const dest = mkTmp();

    writeFile(dest, 'a.js', 'old');
    writeFile(src, 'a.js', 'new');

    const result = smartSync(src, dest);
    expect(result.overwritten).toContain('a.js');
    expect(readFile(dest, 'a.js')).toBe('new');
  });

  test('local unmodified + new changed: overwrite', () => {
    const src = mkTmp();
    const dest = mkTmp();

    // Simulate previous install: write file, save manifest
    writeFile(dest, 'a.js', 'original');
    const manifest = generateManifest(dest);
    saveManifest(dest, manifest);

    // New version has changes
    writeFile(src, 'a.js', 'updated');

    const result = smartSync(src, dest);
    expect(result.overwritten).toContain('a.js');
    expect(readFile(dest, 'a.js')).toBe('updated');
  });

  test('local modified + new unchanged: keep local', () => {
    const src = mkTmp();
    const dest = mkTmp();

    // Simulate previous install
    writeFile(dest, 'a.js', 'original');
    const manifest = generateManifest(dest);
    saveManifest(dest, manifest);

    // User modified locally
    writeFile(dest, 'a.js', 'user modified');

    // New version same as original (no upstream change)
    writeFile(src, 'a.js', 'original');

    const result = smartSync(src, dest);
    expect(result.kept).toContain('a.js');
    expect(readFile(dest, 'a.js')).toBe('user modified');
  });

  test('both changed different sections: clean merge via diff3', () => {
    const src = mkTmp();
    const dest = mkTmp();

    // Original version
    const originalContent = 'line1\nline2\nline3\nline4\nline5\n';
    writeFile(dest, 'a.js', originalContent);
    const manifest = generateManifest(dest);
    saveManifest(dest, manifest);
    saveOriginals(dest, dest); // Save originals for three-way merge base

    // User modifies line 2
    writeFile(dest, 'a.js', 'line1\nuser-modified\nline3\nline4\nline5\n');

    // New version modifies line 5
    writeFile(src, 'a.js', 'line1\nline2\nline3\nline4\nupstream-modified\n');

    const result = smartSync(src, dest);
    expect(result.merged).toContain('a.js');

    const merged = readFile(dest, 'a.js');
    expect(merged).toContain('user-modified');
    expect(merged).toContain('upstream-modified');
  });

  test('both changed same line: conflict — overwrite + backup', () => {
    const src = mkTmp();
    const dest = mkTmp();
    const backupDir = mkTmp();

    // Original version
    writeFile(dest, 'a.js', 'line1\noriginal\nline3\n');
    const manifest = generateManifest(dest);
    saveManifest(dest, manifest);
    saveOriginals(dest, dest);

    // User modifies same line
    writeFile(dest, 'a.js', 'line1\nuser-version\nline3\n');

    // New version also modifies same line
    writeFile(src, 'a.js', 'line1\nupstream-version\nline3\n');

    const result = smartSync(src, dest, { backupDir });
    expect(result.conflicts.length).toBe(1);
    expect(result.conflicts[0].file).toBe('a.js');

    // New version should win
    expect(readFile(dest, 'a.js')).toBe('line1\nupstream-version\nline3\n');

    // Backup should have user's version
    expect(readFile(backupDir, 'a.js')).toBe('line1\nuser-version\nline3\n');
  });

  test('neither changed: no action', () => {
    const src = mkTmp();
    const dest = mkTmp();

    writeFile(dest, 'a.js', 'same');
    const manifest = generateManifest(dest);
    saveManifest(dest, manifest);

    writeFile(src, 'a.js', 'same');

    const result = smartSync(src, dest);
    expect(result.overwritten.length).toBe(0);
    expect(result.kept.length).toBe(0);
    expect(result.merged.length).toBe(0);
    expect(result.conflicts.length).toBe(0);
    expect(result.added.length).toBe(0);
  });

  test('creates subdirectories for new files', () => {
    const src = mkTmp();
    const dest = mkTmp();

    writeFile(src, 'sub/dir/file.js', 'content');

    const result = smartSync(src, dest);
    expect(result.added).toContain('sub/dir/file.js');
    expect(readFile(dest, 'sub/dir/file.js')).toBe('content');
  });

  test('deletes files removed in new version', () => {
    const src = mkTmp();
    const dest = mkTmp();

    // Simulate previous install with two files
    writeFile(dest, 'a.js', 'keep');
    writeFile(dest, 'removed.js', 'to be removed');
    const manifest = generateManifest(dest);
    saveManifest(dest, manifest);

    // New version only has a.js (removed.js is gone)
    writeFile(src, 'a.js', 'keep');

    const result = smartSync(src, dest);
    expect(result.deleted).toContain('removed.js');
    expect(fileExists(dest, 'removed.js')).toBe(false);
    expect(fileExists(dest, 'a.js')).toBe(true);
  });

  test('deletes files in subdirectories and cleans up empty dirs', () => {
    const src = mkTmp();
    const dest = mkTmp();

    // Simulate previous install with file in subdir
    writeFile(dest, 'a.js', 'keep');
    writeFile(dest, 'sub/removed.js', 'to be removed');
    const manifest = generateManifest(dest);
    saveManifest(dest, manifest);

    // New version only has a.js
    writeFile(src, 'a.js', 'keep');

    const result = smartSync(src, dest);
    expect(result.deleted).toContain('sub/removed.js');
    expect(fileExists(dest, 'sub/removed.js')).toBe(false);
    // Empty parent directory should be cleaned up
    expect(fs.existsSync(path.join(dest, 'sub'))).toBe(false);
  });

  test('preserves user-added files not in old manifest', () => {
    const src = mkTmp();
    const dest = mkTmp();

    // Simulate previous install with only a.js
    writeFile(dest, 'a.js', 'original');
    const manifest = generateManifest(dest);
    saveManifest(dest, manifest);

    // User adds custom.js (not in old manifest)
    writeFile(dest, 'custom.js', 'user file');

    // New version still only has a.js
    writeFile(src, 'a.js', 'original');

    const result = smartSync(src, dest);
    // User-added file should be preserved (not deleted)
    expect(result.deleted).not.toContain('custom.js');
    expect(fileExists(dest, 'custom.js')).toBe(true);
  });

  test('user-added file collision: conflict + backup', () => {
    const src = mkTmp();
    const dest = mkTmp();
    const backupDir = mkTmp();

    // Simulate previous install with only a.js
    writeFile(dest, 'a.js', 'original');
    const manifest = generateManifest(dest);
    saveManifest(dest, manifest);

    // User adds b.js (not in old manifest)
    writeFile(dest, 'b.js', 'user version');

    // New version also has b.js
    writeFile(src, 'a.js', 'original');
    writeFile(src, 'b.js', 'upstream version');

    const result = smartSync(src, dest, { backupDir });
    expect(result.conflicts.length).toBe(1);
    expect(result.conflicts[0].file).toBe('b.js');

    // New version should win
    expect(readFile(dest, 'b.js')).toBe('upstream version');

    // User's version should be backed up
    expect(readFile(backupDir, 'b.js')).toBe('user version');
  });

  test('untracked manifest collision with identical content is unchanged, not a conflict', () => {
    const src = mkTmp();
    const dest = mkTmp();
    const backupDir = mkTmp();

    writeFile(dest, 'a.js', 'tracked');
    saveManifest(dest, generateManifest(dest));

    writeFile(dest, 'same.js', 'byte-identical');
    writeFile(src, 'a.js', 'tracked');
    writeFile(src, 'same.js', 'byte-identical');

    fs.utimesSync(path.join(dest, 'same.js'), new Date(1000), new Date(1000));
    const before = fs.statSync(path.join(dest, 'same.js')).mtimeMs;
    const result = smartSync(src, dest, { backupDir });

    expect(result.conflicts).toEqual([]);
    expect(fs.readdirSync(backupDir)).toEqual([]);
    expect(readFile(dest, 'same.js')).toBe('byte-identical');
    expect(fs.statSync(path.join(dest, 'same.js')).mtimeMs).toBe(before);
  });

  test('returns the next manifest without committing it', () => {
    const src = mkTmp();
    const dest = mkTmp();

    writeFile(src, 'a.js', 'new content');

    const result = smartSync(src, dest);

    // The transaction owner commits this candidate after later steps succeed.
    const manifestPath = path.join(dest, '.zylos', 'manifest.json');
    expect(fs.existsSync(manifestPath)).toBe(false);
    expect(result.nextManifest.files['a.js']).toBeTruthy();
  });

  test('outer baseline commit saves originals after sync', () => {
    const src = mkTmp();
    const dest = mkTmp();

    writeFile(src, 'a.js', 'source content');

    const result = smartSync(src, dest);
    saveMergeBaseline(dest, src, result.nextManifest);

    // Originals should be saved
    const originalsPath = path.join(dest, '.zylos', 'originals', 'a.js');
    expect(fs.existsSync(originalsPath)).toBe(true);
    expect(fs.readFileSync(originalsPath, 'utf8')).toBe('source content');
  });
});

describe('smartSync manifest authority (#715)', () => {
  test('user-added file survives two sync rounds and never enters the manifest', () => {
    const src = mkTmp();
    const dest = mkTmp();

    // Simulate previous install with only a.js
    writeFile(dest, 'a.js', 'original');
    saveManifest(dest, generateManifest(dest));

    // User adds a file the package never shipped
    writeFile(dest, 'custom.js', 'user data');

    // Package still ships only a.js
    writeFile(src, 'a.js', 'original');

    // Round 1: user file untouched and NOT absorbed into the manifest
    const first = smartSync(src, dest);
    saveMergeBaseline(dest, src, first.nextManifest);
    expect(fileExists(dest, 'custom.js')).toBe(true);
    expect(loadManifest(dest).files['custom.js']).toBeUndefined();

    // Round 2: a dest-scan manifest would now list custom.js as "upstream-removed"
    const result = smartSync(src, dest);
    expect(result.deleted).not.toContain('custom.js');
    expect(fileExists(dest, 'custom.js')).toBe(true);
    expect(readFile(dest, 'custom.js')).toBe('user data');
    expect(loadManifest(dest).files['custom.js']).toBeUndefined();
  });

  test('kept local modification is not rolled back by a later sync; manifest records source hash', () => {
    const src = mkTmp();
    const dest = mkTmp();

    // Simulate previous install
    writeFile(dest, 'a.js', 'original');
    saveManifest(dest, generateManifest(dest));

    // User modifies locally; upstream unchanged
    writeFile(dest, 'a.js', 'user modified');
    writeFile(src, 'a.js', 'original');

    // Sync 2: local kept, manifest must record the SOURCE hash, not the local hash
    const result2 = smartSync(src, dest);
    expect(result2.kept).toContain('a.js');
    expect(result2.nextManifest.files['a.js']).toBe(hashFile(path.join(src, 'a.js')));
    saveMergeBaseline(dest, src, result2.nextManifest);

    // Sync 3: with a dest-scan manifest the local mod would look unmodified and
    // the (unchanged) upstream would look new — silently rolling the user back
    const result3 = smartSync(src, dest);
    expect(result3.kept).toContain('a.js');
    expect(result3.overwritten).not.toContain('a.js');
    expect(readFile(dest, 'a.js')).toBe('user modified');
  });

  test('clean-merged local modification survives the next sync; manifest records source hash', () => {
    const src = mkTmp();
    const dest = mkTmp();

    // Original version with saved originals for three-way merge
    writeFile(dest, 'a.js', 'line1\nline2\nline3\nline4\nline5\n');
    saveManifest(dest, generateManifest(dest));
    saveOriginals(dest, dest);

    // User modifies line 2; upstream modifies line 5
    writeFile(dest, 'a.js', 'line1\nuser-modified\nline3\nline4\nline5\n');
    writeFile(src, 'a.js', 'line1\nline2\nline3\nline4\nupstream-modified\n');

    const result = smartSync(src, dest);
    expect(result.merged).toContain('a.js');
    // Manifest records the package hash, so the merged delta stays "local"
    expect(result.nextManifest.files['a.js']).toBe(hashFile(path.join(src, 'a.js')));
    saveMergeBaseline(dest, src, result.nextManifest);

    // Next sync with unchanged upstream must keep the merged content
    const result2 = smartSync(src, dest);
    expect(result2.kept).toContain('a.js');
    expect(result2.overwritten).not.toContain('a.js');
    expect(readFile(dest, 'a.js')).toContain('user-modified');
    expect(readFile(dest, 'a.js')).toContain('upstream-modified');
  });

  test('upstream-deleted + locally-modified file is preserved and backed up; unmodified one still deleted', () => {
    const src = mkTmp();
    const dest = mkTmp();
    const backupDir = mkTmp();

    // Simulate previous install with three files
    writeFile(dest, 'a.js', 'keep');
    writeFile(dest, 'modified-then-removed.js', 'original');
    writeFile(dest, 'clean-then-removed.js', 'untouched');
    saveManifest(dest, generateManifest(dest));

    // User modifies one of the files upstream is about to remove
    writeFile(dest, 'modified-then-removed.js', 'user changes');

    // New version only ships a.js
    writeFile(src, 'a.js', 'keep');

    const result = smartSync(src, dest, { backupDir });

    // Locally-modified file: preserved in place + backed up, not deleted
    expect(result.preserved).toContain('modified-then-removed.js');
    expect(result.deleted).not.toContain('modified-then-removed.js');
    expect(readFile(dest, 'modified-then-removed.js')).toBe('user changes');
    expect(readFile(backupDir, 'modified-then-removed.js')).toBe('user changes');

    // Unmodified file: still deleted as before
    expect(result.deleted).toContain('clean-then-removed.js');
    expect(fileExists(dest, 'clean-then-removed.js')).toBe(false);

    // Neither appears in the new manifest
    const manifest = result.nextManifest;
    expect(manifest.files['modified-then-removed.js']).toBeUndefined();
    expect(manifest.files['clean-then-removed.js']).toBeUndefined();
  });

  test('read-only manifest file does not block the atomic baseline commit', () => {
    const src = mkTmp();
    const dest = mkTmp();

    // Simulate previous install
    writeFile(dest, 'a.js', 'original');
    saveManifest(dest, generateManifest(dest));
    saveOriginals(dest, dest);

    writeFile(src, 'a.js', 'updated');

    // The live manifest must never be written in place — the commit is a
    // rename, which replaces a read-only file without opening it for write.
    // An in-place write here could truncate the manifest on I/O failure.
    fs.chmodSync(path.join(dest, '.zylos', 'manifest.json'), 0o444);

    const result = smartSync(src, dest);
    expect(result.errors).toEqual([]);
    saveMergeBaseline(dest, src, result.nextManifest);
    expect(loadManifest(dest).files['a.js']).toBe(hashFile(path.join(src, 'a.js')));
    expect(readFile(dest, '.zylos/originals/a.js')).toBe('updated');
  });

  test('staging failure leaves the previous baseline pair untouched', () => {
    const src = mkTmp();
    const dest = mkTmp();

    // Simulate previous install with originals v1
    writeFile(dest, 'a.js', 'original');
    saveManifest(dest, generateManifest(dest));
    saveOriginals(dest, dest);
    const manifestBefore = fs.readFileSync(path.join(dest, '.zylos', 'manifest.json'), 'utf8');

    writeFile(src, 'a.js', 'updated');

    // Read-only .zylos: no staging file can be created — the baseline commit
    // must fail without touching either live piece
    fs.chmodSync(path.join(dest, '.zylos'), 0o555);

    const result = smartSync(src, dest);
    let commitError;
    try {
      saveMergeBaseline(dest, src, result.nextManifest);
    } catch (err) {
      commitError = err;
    }
    fs.chmodSync(path.join(dest, '.zylos'), 0o755);

    expect(result.errors).toEqual([]);
    expect(commitError).toBeDefined();
    expect(fs.readFileSync(path.join(dest, '.zylos', 'manifest.json'), 'utf8')).toBe(manifestBefore);
    expect(readFile(dest, '.zylos/originals/a.js')).toBe('original');
  });

  test('crash after legacy originals staging: next sync recovers before merging', () => {
    const src = mkTmp();
    const dest = mkTmp();

    // Previous install with originals v1 (three-way merge base)
    writeFile(dest, 'a.js', 'line1\nline2\nline3\nline4\nline5\n');
    saveManifest(dest, generateManifest(dest));
    saveOriginals(dest, dest);

    // Simulate a crash mid-transaction: originals were moved aside and never
    // restored (the legacy .bak staging scheme)
    fs.renameSync(
      path.join(dest, '.zylos', 'originals'),
      path.join(dest, '.zylos', 'originals.bak')
    );

    // User edit + upstream edit on different lines — clean-mergeable, but only
    // if the originals are recovered before the merge logic reads them
    writeFile(dest, 'a.js', 'line1\nuser-modified\nline3\nline4\nline5\n');
    writeFile(src, 'a.js', 'line1\nline2\nline3\nline4\nupstream-modified\n');

    const result = smartSync(src, dest);
    expect(result.merged).toContain('a.js');
    expect(result.conflicts).toEqual([]);
    expect(readFile(dest, 'a.js')).toContain('user-modified');
    expect(readFile(dest, 'a.js')).toContain('upstream-modified');
    expect(fs.existsSync(path.join(dest, '.zylos', 'originals.bak'))).toBe(false);
  });

  test('uncommitted staged transaction is rolled back, not absorbed', () => {
    const src = mkTmp();
    const dest = mkTmp();

    // Previous install
    writeFile(dest, 'a.js', 'original');
    saveManifest(dest, generateManifest(dest));
    saveOriginals(dest, dest);

    // Simulate a crash before the commit point: a staged manifest (bogus
    // content) and staged originals are still lying around
    writeFile(dest, '.zylos/manifest.json.tmp', '{"files":{"bogus.js":"deadbeef"}}');
    writeFile(dest, '.zylos/originals.new/bogus.js', 'staged junk');

    writeFile(src, 'a.js', 'original');
    const result = smartSync(src, dest);

    expect(result.errors).toEqual([]);
    // The bogus staged manifest never became live; recovery produced a clean candidate.
    expect(loadManifest(dest).files['bogus.js']).toBeUndefined();
    expect(result.nextManifest.files['a.js']).toBe(hashFile(path.join(src, 'a.js')));
    // No stale transaction artifacts survive
    expect(fs.existsSync(path.join(dest, '.zylos', 'manifest.json.tmp'))).toBe(false);
    expect(fs.existsSync(path.join(dest, '.zylos', 'originals.new'))).toBe(false);
    expect(readFile(dest, '.zylos/originals/a.js')).toBe('original');
  });

  test('sync with errors keeps the previous manifest and originals', () => {
    const src = mkTmp();
    const dest = mkTmp();

    // Simulate previous install
    writeFile(dest, 'a.js', 'original');
    saveManifest(dest, generateManifest(dest));
    const manifestBefore = JSON.stringify(loadManifest(dest));

    // Make the destination file unwritable so the overwrite fails
    fs.chmodSync(path.join(dest, 'a.js'), 0o444);
    writeFile(src, 'a.js', 'updated');

    const result = smartSync(src, dest);
    expect(result.errors.length).toBeGreaterThan(0);

    // Baseline untouched: manifest identical, no originals recorded
    expect(JSON.stringify(loadManifest(dest))).toBe(manifestBefore);
    expect(fs.existsSync(path.join(dest, '.zylos', 'originals'))).toBe(false);
  });
});

describe('smartSync mode: overwrite', () => {
  test('overwrite mode: overwrites locally modified files', () => {
    const src = mkTmp();
    const dest = mkTmp();

    // Simulate previous install
    writeFile(dest, 'a.js', 'original');
    const manifest = generateManifest(dest);
    saveManifest(dest, manifest);

    // User modified locally
    writeFile(dest, 'a.js', 'user modified');

    // New version has changes
    writeFile(src, 'a.js', 'upstream version');

    const result = smartSync(src, dest, { mode: 'overwrite' });
    expect(result.overwritten).toContain('a.js');
    expect(result.kept.length).toBe(0);
    expect(readFile(dest, 'a.js')).toBe('upstream version');
  });

  test('overwrite mode: still adds new files', () => {
    const src = mkTmp();
    const dest = mkTmp();

    writeFile(src, 'new.js', 'new content');

    const result = smartSync(src, dest, { mode: 'overwrite' });
    expect(result.added).toContain('new.js');
    expect(readFile(dest, 'new.js')).toBe('new content');
  });

  test('overwrite mode: still deletes removed files', () => {
    const src = mkTmp();
    const dest = mkTmp();

    writeFile(dest, 'a.js', 'keep');
    writeFile(dest, 'removed.js', 'to be removed');
    const manifest = generateManifest(dest);
    saveManifest(dest, manifest);

    writeFile(src, 'a.js', 'keep');

    const result = smartSync(src, dest, { mode: 'overwrite' });
    expect(result.deleted).toContain('removed.js');
    expect(fileExists(dest, 'removed.js')).toBe(false);
  });

  test('overwrite mode: deletes upstream-removed file even with local modifications', () => {
    const src = mkTmp();
    const dest = mkTmp();

    // Simulate previous install with two files
    writeFile(dest, 'a.js', 'keep');
    writeFile(dest, 'removed.js', 'original');
    saveManifest(dest, generateManifest(dest));

    // User modifies the file upstream is about to remove
    writeFile(dest, 'removed.js', 'user changes');

    // New version only ships a.js
    writeFile(src, 'a.js', 'keep');

    const result = smartSync(src, dest, { mode: 'overwrite' });
    // Overwrite-all contract: no merge-mode preservation
    expect(result.deleted).toContain('removed.js');
    expect(result.preserved.length).toBe(0);
    expect(fileExists(dest, 'removed.js')).toBe(false);
  });

  test('overwrite mode: no conflicts or merges', () => {
    const src = mkTmp();
    const dest = mkTmp();

    // Both sides changed — in merge mode this would be a conflict
    writeFile(dest, 'a.js', 'original');
    const manifest = generateManifest(dest);
    saveManifest(dest, manifest);
    saveOriginals(dest, dest);

    writeFile(dest, 'a.js', 'user version');
    writeFile(src, 'a.js', 'upstream version');

    const result = smartSync(src, dest, { mode: 'overwrite' });
    expect(result.overwritten).toContain('a.js');
    expect(result.conflicts.length).toBe(0);
    expect(result.merged.length).toBe(0);
    expect(result.kept.length).toBe(0);
    expect(readFile(dest, 'a.js')).toBe('upstream version');
  });
});

describe('formatMergeResult', () => {
  test('formats all categories', () => {
    const result = {
      overwritten: ['a.js'],
      kept: ['b.js', 'c.js'],
      merged: ['d.js'],
      conflicts: [{ file: 'e.js', backupPath: '/tmp/e.js' }],
      added: ['f.js'],
      deleted: ['g.js'],
      errors: ['something failed'],
    };
    const formatted = formatMergeResult(result);
    expect(formatted).toContain('1 overwritten');
    expect(formatted).toContain('2 kept');
    expect(formatted).toContain('1 merged');
    expect(formatted).toContain('1 conflicts');
    expect(formatted).toContain('1 added');
    expect(formatted).toContain('1 deleted');
    expect(formatted).toContain('1 errors');
  });

  test('returns "no changes" for empty result', () => {
    const result = {
      overwritten: [],
      kept: [],
      merged: [],
      conflicts: [],
      added: [],
      deleted: [],
      errors: [],
    };
    expect(formatMergeResult(result)).toBe('no changes');
  });
});
