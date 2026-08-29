import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-upgrade-syntax-'));
process.env.ZYLOS_DIR = path.join(root, 'zylos');

const { runUpgrade } = await import(new URL('../upgrade.js', import.meta.url));
const { checkJavaScriptSyntax } = await import(new URL('../syntax-check.js', import.meta.url));

test.after(() => fs.rmSync(root, { recursive: true, force: true }));

function writeFile(dir, relativePath, content) {
  const filePath = path.join(dir, relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf8');
}

function writeComponent(dir, version, source) {
  writeFile(dir, 'package.json', JSON.stringify({
    name: path.basename(dir),
    version,
    type: 'module',
  }));
  writeFile(dir, 'SKILL.md', `---\nname: ${path.basename(dir)}\nversion: ${version}\n---\n`);
  writeFile(dir, 'index.js', source);
}

function createTools(logPath) {
  const binDir = path.join(root, 'bin');
  fs.mkdirSync(binDir, { recursive: true });
  const pm2 = path.join(binDir, 'pm2');
  const npm = path.join(binDir, 'npm');
  fs.writeFileSync(pm2, `#!/bin/sh\nprintf 'pm2 %s\\n' "$*" >> "${logPath}"\nif [ "$1" = "jlist" ]; then printf '[]'; fi\n`, { mode: 0o755 });
  fs.writeFileSync(npm, `#!/bin/sh\nprintf 'npm %s\\n' "$*" >> "${logPath}"\n`, { mode: 0o755 });
  return { pm2, npm, trusted: true };
}

test('merge upgrade rejects invalid JavaScript before the new artifact can be started', () => {
  const component = 'demo-syntax-invalid';
  const skillDir = path.join(process.env.ZYLOS_DIR, '.claude', 'skills', component);
  const targetDir = path.join(root, 'target-invalid');
  const logPath = path.join(root, 'tool.log');

  writeComponent(skillDir, '1.0.0', 'export const version = "old";\n');
  writeComponent(targetDir, '2.0.0', [
    'export function getInteractiveCardContent() {}',
    'export function getInteractiveCardContent() {}',
    '',
  ].join('\n'));

  const result = runUpgrade(component, {
    tempDir: targetDir,
    newVersion: '2.0.0',
    mode: 'merge',
    jsonOutput: true,
    tools: createTools(logPath),
  });

  assert.equal(result.success, false);
  assert.equal(result.failedStep, 4);
  assert.equal(result.steps.at(-1).name, 'smart_merge');
  assert.equal(result.syntaxCheck.status, 'FAIL');
  assert.match(result.error, /index\.js/);
  assert.match(result.error, /getInteractiveCardContent/);
  assert.equal(fs.readFileSync(path.join(skillDir, 'index.js'), 'utf8'), 'export const version = "old";\n');
  assert.doesNotMatch(fs.readFileSync(logPath, 'utf8'), /pm2 (?:start|restart)/);
});

test('merge upgrade fails closed when JavaScript cannot be measured as an ESM tree', () => {
  const component = 'demo-syntax-unmeasurable';
  const skillDir = path.join(process.env.ZYLOS_DIR, '.claude', 'skills', component);
  const targetDir = path.join(root, 'target-unmeasurable');

  writeFile(skillDir, 'SKILL.md', '---\nname: demo-syntax-unmeasurable\nversion: 1.0.0\n---\n');
  writeFile(skillDir, 'index.js', 'export const version = "old";\n');
  writeFile(targetDir, 'SKILL.md', '---\nname: demo-syntax-unmeasurable\nversion: 2.0.0\n---\n');
  writeFile(targetDir, 'index.js', 'export const version = "new";\n');

  const result = runUpgrade(component, {
    tempDir: targetDir,
    newVersion: '2.0.0',
    mode: 'merge',
    jsonOutput: true,
    tools: createTools(path.join(root, 'unmeasurable-tool.log')),
  });

  assert.equal(result.success, false);
  assert.equal(result.failedStep, 4);
  assert.equal(result.syntaxCheck.status, 'UNMEASURABLE');
  assert.match(result.error, /UNMEASURABLE/);
  assert.match(result.error, /type.*module/i);
  assert.equal(fs.readFileSync(path.join(skillDir, 'index.js'), 'utf8'), 'export const version = "old";\n');
});

test('syntax validation checks JavaScript files in nested directories', () => {
  const treeDir = path.join(root, 'nested-tree');
  writeFile(treeDir, 'package.json', JSON.stringify({ type: 'module' }));
  writeFile(treeDir, 'index.js', 'export const ready = true;\n');
  writeFile(treeDir, 'nested/worker.mjs', [
    'export function processItem() {}',
    'export function processItem() {}',
    '',
  ].join('\n'));

  const result = checkJavaScriptSyntax(treeDir);

  assert.equal(result.status, 'FAIL');
  assert.deepEqual(result.checkedFiles, ['index.js', 'nested/worker.mjs']);
  assert.equal(result.failures.length, 1);
  assert.equal(result.failures[0].file, 'nested/worker.mjs');
  assert.equal(result.failures[0].identifier, 'processItem');
  assert.match(result.error, /nested\/worker\.mjs/);
});

test('valid module trees pass syntax validation and complete the merge upgrade', () => {
  const component = 'demo-syntax-valid';
  const skillDir = path.join(process.env.ZYLOS_DIR, '.claude', 'skills', component);
  const targetDir = path.join(root, 'target-valid');

  writeComponent(skillDir, '1.0.0', 'export const version = "old";\n');
  writeComponent(targetDir, '2.0.0', 'export const version = "new";\n');
  writeFile(targetDir, 'nested/worker.mjs', 'export function processItem() { return true; }\n');

  const result = runUpgrade(component, {
    tempDir: targetDir,
    newVersion: '2.0.0',
    mode: 'merge',
    jsonOutput: true,
    tools: createTools(path.join(root, 'valid-tool.log')),
  });

  assert.equal(result.success, true);
  assert.equal(result.syntaxCheck.status, 'PASS');
  assert.deepEqual(result.syntaxCheck.checkedFiles, ['index.js', 'nested/worker.mjs']);
  assert.equal(fs.readFileSync(path.join(skillDir, 'index.js'), 'utf8'), 'export const version = "new";\n');
});
