import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function requireAbsolutePath(value, label) {
  if (typeof value !== 'string' || !path.isAbsolute(value)) {
    throw new TypeError(`${label} must be an absolute path`);
  }
  return path.normalize(value);
}

function isRegularFile(filePath) {
  try {
    return fs.statSync(filePath).isFile();
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return false;
    throw error;
  }
}

function findGlobalNpmRoot() {
  try {
    const output = execFileSync('npm', ['root', '-g'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 10_000,
    }).trim();
    return output ? requireAbsolutePath(output, 'global npm root') : null;
  } catch {
    return null;
  }
}

export function resolveEcosystemTemplate(sourcePath, {
  globalNpmRoot = null,
  zylosDir = process.env.ZYLOS_DIR || path.join(os.homedir(), 'zylos'),
} = {}) {
  const normalizedSourcePath = requireAbsolutePath(sourcePath, 'sourcePath');
  if (isRegularFile(normalizedSourcePath)) return normalizedSourcePath;

  const normalizedGlobalNpmRoot = globalNpmRoot === null
    ? findGlobalNpmRoot()
    : requireAbsolutePath(globalNpmRoot, 'globalNpmRoot');
  if (normalizedGlobalNpmRoot) {
    const installedPath = path.join(
      normalizedGlobalNpmRoot,
      'zylos',
      'templates',
      'pm2',
      'ecosystem.config.cjs',
    );
    if (isRegularFile(installedPath)) return installedPath;
  }

  const normalizedZylosDir = requireAbsolutePath(zylosDir, 'zylosDir');
  const deployedPath = path.join(normalizedZylosDir, 'pm2', 'ecosystem.config.cjs');
  if (isRegularFile(deployedPath)) return deployedPath;

  throw new Error(
    `PM2 ecosystem template not found in source, installed package, or deployment: ${normalizedSourcePath}`,
  );
}
