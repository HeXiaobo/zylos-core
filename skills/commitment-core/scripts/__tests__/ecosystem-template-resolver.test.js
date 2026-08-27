import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { resolveEcosystemTemplate } from './ecosystem-template-resolver.js';

function writeFixture(filePath, label) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `module.exports = { label: '${label}' };\n`);
}

test('source-tree PM2 template wins over installed and deployed layouts', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-ecosystem-resolver-'));
  const sourcePath = path.join(directory, 'source', 'templates', 'pm2', 'ecosystem.config.cjs');
  const globalNpmRoot = path.join(directory, 'global', 'lib', 'node_modules');
  const installedPath = path.join(globalNpmRoot, 'zylos', 'templates', 'pm2', 'ecosystem.config.cjs');
  const zylosDir = path.join(directory, 'deployed', 'zylos');
  const deployedPath = path.join(zylosDir, 'pm2', 'ecosystem.config.cjs');

  try {
    writeFixture(sourcePath, 'source');
    writeFixture(installedPath, 'installed');
    writeFixture(deployedPath, 'deployed');

    assert.equal(resolveEcosystemTemplate(sourcePath, { globalNpmRoot, zylosDir }), sourcePath);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('globally installed zylos template is the first deployed-layout fallback', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-ecosystem-resolver-'));
  const sourcePath = path.join(directory, 'missing-source', 'ecosystem.config.cjs');
  const globalNpmRoot = path.join(directory, 'global', 'lib', 'node_modules');
  const installedPath = path.join(globalNpmRoot, 'zylos', 'templates', 'pm2', 'ecosystem.config.cjs');
  const zylosDir = path.join(directory, 'deployed', 'zylos');
  const deployedPath = path.join(zylosDir, 'pm2', 'ecosystem.config.cjs');

  try {
    writeFixture(installedPath, 'installed');
    writeFixture(deployedPath, 'deployed');

    assert.equal(resolveEcosystemTemplate(sourcePath, { globalNpmRoot, zylosDir }), installedPath);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('deployed PM2 ecosystem is used when source and installed templates are absent', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-ecosystem-resolver-'));
  const sourcePath = path.join(directory, 'missing-source', 'ecosystem.config.cjs');
  const globalNpmRoot = path.join(directory, 'missing-global', 'node_modules');
  const zylosDir = path.join(directory, 'deployed', 'zylos');
  const deployedPath = path.join(zylosDir, 'pm2', 'ecosystem.config.cjs');

  try {
    writeFixture(deployedPath, 'deployed');

    assert.equal(resolveEcosystemTemplate(sourcePath, { globalNpmRoot, zylosDir }), deployedPath);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
