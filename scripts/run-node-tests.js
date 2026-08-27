#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT = process.cwd();
const TEST_ROOTS = [
  path.join(ROOT, 'cli', 'lib', '__tests__'),
  path.join(ROOT, 'cli', 'lib', 'runtime', '__tests__'),
  path.join(ROOT, 'skills', 'activity-monitor', 'scripts', '__tests__'),
  path.join(ROOT, 'skills', 'commitment-core', 'scripts', '__tests__'),
  path.join(ROOT, 'skills', 'work-intake', 'scripts', '__tests__'),
];

function walk(dir, files = []) {
  if (!fs.existsSync(dir)) return files;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(fullPath, files);
    } else if (entry.isFile() && entry.name.endsWith('.test.js')) {
      files.push(fullPath);
    }
  }
  return files;
}

function isNodeTest(file) {
  const rel = path.relative(ROOT, file).split(path.sep).join('/');
  if (rel.startsWith('cli/lib/__tests__/')) return true;
  if (rel.startsWith('cli/lib/runtime/__tests__/')) return true;
  if (rel.startsWith('skills/activity-monitor/scripts/__tests__/')) return true;
  if (rel.startsWith('skills/commitment-core/scripts/__tests__/')) return true;
  if (rel.startsWith('skills/work-intake/scripts/__tests__/')) return true;
  return false;
}

const testFiles = TEST_ROOTS
  .flatMap((dir) => walk(dir))
  .filter(isNodeTest)
  .sort()
  .map((file) => path.relative(ROOT, file));

if (testFiles.length === 0) {
  console.error('No Node test files found.');
  process.exit(1);
}

console.log(`Running ${testFiles.length} Node test files`);
// Some CLI modules resolve ~/zylos eagerly at import time and their rollback
// tests intentionally remove installation files. Never let an ordinary test
// invocation inherit the live runtime directory.
const isolatedHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-node-tests-home-'));
const isolatedZylosDir = path.join(isolatedHomeDir, 'zylos');
fs.mkdirSync(isolatedZylosDir, { recursive: true });
let result;
try {
  result = spawnSync(
    process.execPath,
    ['--experimental-test-module-mocks', '--test', ...testFiles],
    {
      stdio: 'inherit',
      env: {
        ...process.env,
        HOME: isolatedHomeDir,
        ZYLOS_DIR: isolatedZylosDir,
        ZYLOS_TEST_ISOLATED: '1',
      },
    },
  );
} finally {
  fs.rmSync(isolatedHomeDir, { recursive: true, force: true });
}

process.exit(result?.status ?? 1);
