#!/usr/bin/env node
/**
 * Install dependencies for skills that have their own package.json.
 * Runs as a pretest hook so `npm test` works out of the box.
 */

import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = join(fileURLToPath(import.meta.url), '..', '..');
const skillsDir = join(root, 'skills');
const runtimeDependencyFields = ['dependencies', 'optionalDependencies', 'peerDependencies'];

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
  const packageJson = JSON.parse(readFileSync(pkg, 'utf8'));
  if (!hasRuntimeDependencies(packageJson)) continue;
  if (!existsSync(lock)) {
    throw new Error(`[pretest] skills/${name.name} has runtime dependencies but no package-lock.json`);
  }
  if (existsSync(modules)) continue;
  console.log(`[pretest] Installing deps for skills/${name.name}`);
  execFileSync('npm', ['ci', '--omit=dev'], { cwd: dir, stdio: 'inherit' });
}
