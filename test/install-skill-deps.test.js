import { afterEach, beforeEach, describe, expect, test } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const sourceScript = fileURLToPath(new URL('../scripts/install-skill-deps.js', import.meta.url));
let tempRoot;

function writeJson(root, relativePath, value) {
  const fullPath = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function git(root, args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
}

function makeFixture(skills) {
  const root = fs.mkdtempSync(path.join(tempRoot, 'repo-'));
  const callsPath = path.join(tempRoot, `${path.basename(root)}-npm-calls.jsonl`);
  writeJson(root, 'package.json', { name: 'skill-deps-fixture', private: true, type: 'module' });
  fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
  fs.copyFileSync(sourceScript, path.join(root, 'scripts', 'install-skill-deps.js'));

  for (const [name, { packageJson, packageLock }] of Object.entries(skills)) {
    writeJson(root, path.join('skills', name, 'package.json'), packageJson);
    if (packageLock) writeJson(root, path.join('skills', name, 'package-lock.json'), packageLock);
  }

  const binDir = path.join(root, 'test-bin');
  fs.mkdirSync(binDir, { recursive: true });
  const fakeNpm = path.join(binDir, 'npm');
  fs.writeFileSync(fakeNpm, `#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
const calls = process.env.INSTALL_SKILL_DEPS_CALLS;
fs.appendFileSync(calls, JSON.stringify({ cwd: process.cwd(), args: process.argv.slice(2) }) + '\\n');
if (process.argv[2] === 'install') {
  fs.writeFileSync(path.join(process.cwd(), 'package-lock.json'), '{}\\n');
}
`, 'utf8');
  fs.chmodSync(fakeNpm, 0o755);

  git(root, ['init', '-b', 'main']);
  git(root, ['config', 'user.email', 'skill-deps-test@example.invalid']);
  git(root, ['config', 'user.name', 'Skill Deps Test']);
  git(root, ['add', '.']);
  git(root, ['commit', '-m', 'fixture']);
  return { root, binDir, callsPath };
}

function runInstaller(fixture) {
  return spawnSync(process.execPath, ['scripts/install-skill-deps.js'], {
    cwd: fixture.root,
    encoding: 'utf8',
    env: {
      ...process.env,
      INSTALL_SKILL_DEPS_CALLS: fixture.callsPath,
      PATH: `${fixture.binDir}${path.delimiter}${process.env.PATH}`,
    },
  });
}

function npmCalls(fixture) {
  if (!fs.existsSync(fixture.callsPath)) return [];
  return fs.readFileSync(fixture.callsPath, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

beforeEach(() => {
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-install-skill-deps-'));
});

afterEach(() => {
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

describe('skill dependency pretest', () => {
  test('skips packages without runtime dependencies and leaves a clean candidate clean', () => {
    const fixture = makeFixture({
      empty: {
        packageJson: { name: 'empty-skill', private: true, devDependencies: { testOnly: '1.0.0' } },
      },
    });

    const result = runInstaller(fixture);

    expect(result.status).toBe(0);
    expect(npmCalls(fixture)).toEqual([]);
    expect(fs.existsSync(path.join(fixture.root, 'skills', 'empty', 'package-lock.json'))).toBe(false);
    expect(git(fixture.root, ['status', '--porcelain'])).toBe('');
  });

  test('installs runtime dependencies from the existing lockfile without rewriting it', () => {
    const packageLock = {
      name: 'runtime-skill',
      lockfileVersion: 3,
      requires: true,
      packages: {
        '': { name: 'runtime-skill', dependencies: { example: '1.0.0' } },
        'node_modules/example': { version: '1.0.0' },
      },
    };
    const fixture = makeFixture({
      runtime: {
        packageJson: { name: 'runtime-skill', private: true, dependencies: { example: '1.0.0' } },
        packageLock,
      },
    });
    const lockPath = path.join(fixture.root, 'skills', 'runtime', 'package-lock.json');
    const lockBefore = fs.readFileSync(lockPath, 'utf8');

    const result = runInstaller(fixture);

    expect(result.status).toBe(0);
    const calls = npmCalls(fixture);
    expect(calls).toHaveLength(1);
    expect(fs.realpathSync(calls[0].cwd)).toBe(fs.realpathSync(path.join(fixture.root, 'skills', 'runtime')));
    expect(calls[0].args).toEqual(['ci', '--omit=dev']);
    expect(fs.readFileSync(lockPath, 'utf8')).toBe(lockBefore);
    expect(git(fixture.root, ['status', '--porcelain'])).toBe('');
  });

  test('fails closed before npm when runtime dependencies have no lockfile', () => {
    const fixture = makeFixture({
      unlocked: {
        packageJson: { name: 'unlocked-skill', private: true, dependencies: { example: '1.0.0' } },
      },
    });

    const result = runInstaller(fixture);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/skills\/unlocked.*package-lock\.json/s);
    expect(npmCalls(fixture)).toEqual([]);
    expect(fs.existsSync(path.join(fixture.root, 'skills', 'unlocked', 'package-lock.json'))).toBe(false);
    expect(git(fixture.root, ['status', '--porcelain'])).toBe('');
  });
});
