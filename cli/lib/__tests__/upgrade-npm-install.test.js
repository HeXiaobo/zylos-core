import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-upgrade-npm-install-'));
process.env.ZYLOS_DIR = path.join(root, 'zylos');

const { runUpgrade } = await import(new URL('../upgrade.js', import.meta.url));

test.after(() => fs.rmSync(root, { recursive: true, force: true }));

function writeSkill(dir, { version, payload, lifecycle = '' }) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'SKILL.md'),
    `---\nname: demo\nversion: ${version}\n${lifecycle}---\n`,
    'utf8',
  );
  fs.writeFileSync(path.join(dir, 'payload.txt'), `${payload}\n`, 'utf8');
  fs.writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify({ name: 'demo', version }, null, 2),
    'utf8',
  );
}

function createFakeBin(logPath) {
  const binDir = fs.mkdtempSync(path.join(root, 'fake-bin-'));
  fs.writeFileSync(
    path.join(binDir, 'npm'),
    `#!/bin/sh\nprintf '%s\\n' "$#" >> "${logPath}"\nfor arg in "$@"; do printf '%s\\n' "$arg" >> "${logPath}"; done\nprintf '.\\n' >> "${logPath}"\nexit 0\n`,
    { mode: 0o755 },
  );
  fs.writeFileSync(
    path.join(binDir, 'pm2'),
    '#!/bin/sh\nif [ "$1" = "jlist" ]; then printf \'[]\'; fi\n',
    { mode: 0o755 },
  );
  return binDir;
}

function readNpmInvocations(logPath) {
  const lines = fs.readFileSync(logPath, 'utf8').trim().split('\n');
  const invocations = [];
  let cursor = 0;
  while (cursor < lines.length) {
    const count = Number(lines[cursor++]);
    assert.equal(Number.isInteger(count), true);
    invocations.push(lines.slice(cursor, cursor + count));
    cursor += count;
    assert.equal(lines[cursor++], '.');
  }
  return invocations;
}

function withFakeBin(binDir, callback) {
  const previousPath = process.env.PATH;
  process.env.PATH = `${binDir}${path.delimiter}${previousPath}`;
  try {
    return callback();
  } finally {
    process.env.PATH = previousPath;
  }
}

test('forward component install passes --omit=dev and --ignore-scripts to npm', () => {
  const component = 'demo-npm-forward';
  const skillDir = path.join(process.env.ZYLOS_DIR, '.claude', 'skills', component);
  const targetDir = path.join(root, 'target-forward');
  const logPath = path.join(root, 'forward-npm.log');
  writeSkill(skillDir, { version: '1.0.0', payload: 'old' });
  writeSkill(targetDir, { version: '2.0.0', payload: 'new' });
  const binDir = createFakeBin(logPath);

  try {
    const result = withFakeBin(binDir, () => runUpgrade(component, {
      tempDir: targetDir,
      newVersion: '2.0.0',
      jsonOutput: true,
    }));

    assert.equal(result.success, true);
    assert.deepEqual(readNpmInvocations(logPath), [
      ['install', '--omit=dev', '--ignore-scripts'],
    ]);
  } finally {
    fs.rmSync(binDir, { recursive: true, force: true });
  }
});

test('rollback dependency reinstall also passes --omit=dev and --ignore-scripts', () => {
  const component = 'demo-npm-rollback';
  const skillDir = path.join(process.env.ZYLOS_DIR, '.claude', 'skills', component);
  const targetDir = path.join(root, 'target-rollback');
  const logPath = path.join(root, 'rollback-npm.log');
  writeSkill(skillDir, { version: '1.0.0', payload: 'old' });
  writeSkill(targetDir, {
    version: '2.0.0',
    payload: 'new',
    lifecycle: 'lifecycle:\n  hooks:\n    post-upgrade: hooks/post-upgrade.js\n',
  });
  fs.mkdirSync(path.join(targetDir, 'hooks'), { recursive: true });
  fs.writeFileSync(path.join(targetDir, 'hooks', 'post-upgrade.js'), 'process.exit(23);\n', 'utf8');
  const binDir = createFakeBin(logPath);

  try {
    const result = withFakeBin(binDir, () => runUpgrade(component, {
      tempDir: targetDir,
      newVersion: '2.0.0',
      jsonOutput: true,
    }));

    assert.equal(result.success, false);
    assert.equal(result.failedStep, 8);
    assert.equal(result.rollback.performed, true);
    assert.equal(result.rollback.steps.some((step) => step.action === 'restore_dependencies' && step.success), true);
    assert.equal(fs.readFileSync(path.join(skillDir, 'payload.txt'), 'utf8'), 'old\n');
    assert.deepEqual(readNpmInvocations(logPath), [
      ['install', '--omit=dev', '--ignore-scripts'],
      ['install', '--omit=dev', '--ignore-scripts'],
    ]);
  } finally {
    fs.rmSync(binDir, { recursive: true, force: true });
  }
});
