import { afterEach, beforeEach, describe, expect, test } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const sourceScript = fileURLToPath(new URL('../scripts/install-skill-deps.js', import.meta.url));
let tempRoot;

function writeJson(root, relativePath, value) {
  writeFile(root, relativePath, `${JSON.stringify(value, null, 2)}\n`);
}

function writeFile(root, relativePath, content) {
  const fullPath = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content, 'utf8');
}

function git(root, args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
}

function makeFixture(skills) {
  const root = fs.mkdtempSync(path.join(tempRoot, 'repo-'));
  const callsPath = path.join(tempRoot, `${path.basename(root)}-npm-calls.jsonl`);
  const eventsPath = path.join(tempRoot, `${path.basename(root)}-npm-events.jsonl`);
  const lockRoot = path.join(tempRoot, `${path.basename(root)}-locks`);
  writeJson(root, 'package.json', { name: 'skill-deps-fixture', private: true, type: 'module' });
  writeFile(root, '.gitignore', 'node_modules/\n');
  fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
  fs.copyFileSync(sourceScript, path.join(root, 'scripts', 'install-skill-deps.js'));

  for (const [name, { packageJson, packageLock, packageLockRaw, nodeModules }] of Object.entries(skills)) {
    writeJson(root, path.join('skills', name, 'package.json'), packageJson);
    if (packageLock) writeJson(root, path.join('skills', name, 'package-lock.json'), packageLock);
    if (packageLockRaw) writeFile(root, path.join('skills', name, 'package-lock.json'), packageLockRaw);
    if (nodeModules) fs.mkdirSync(path.join(root, 'skills', name, 'node_modules'), { recursive: true });
  }

  const binDir = path.join(root, 'test-bin');
  fs.mkdirSync(binDir, { recursive: true });
  const fakeNpm = path.join(binDir, 'npm');
  fs.writeFileSync(fakeNpm, `#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
const calls = process.env.INSTALL_SKILL_DEPS_CALLS;
fs.appendFileSync(calls, JSON.stringify({ cwd: process.cwd(), args: process.argv.slice(2) }) + '\\n');
const events = process.env.INSTALL_SKILL_DEPS_EVENTS;
fs.appendFileSync(events, JSON.stringify({ event: 'start', pid: process.pid, at: Date.now() }) + '\\n');
const delayMs = Number(process.env.INSTALL_SKILL_DEPS_NPM_DELAY_MS || 0);
if (delayMs > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delayMs);
const failOnce = process.env.INSTALL_SKILL_DEPS_NPM_FAIL_ONCE;
if (failOnce && !fs.existsSync(failOnce)) {
  fs.writeFileSync(failOnce, 'failed once\\n');
  if (process.env.INSTALL_SKILL_DEPS_NPM_LEAVE_PARTIAL_ON_FAILURE) {
    fs.mkdirSync(path.join(process.cwd(), 'node_modules'), { recursive: true });
    fs.writeFileSync(path.join(process.cwd(), 'node_modules', 'partial'), 'incomplete\\n');
  }
  fs.appendFileSync(events, JSON.stringify({ event: 'end', pid: process.pid, at: Date.now(), status: 23 }) + '\\n');
  process.exit(23);
}
if (process.argv[2] === 'install') {
  fs.writeFileSync(path.join(process.cwd(), 'package-lock.json'), '{}\\n');
}
if (process.argv[2] === 'ci') fs.mkdirSync(path.join(process.cwd(), 'node_modules'), { recursive: true });
fs.appendFileSync(events, JSON.stringify({ event: 'end', pid: process.pid, at: Date.now() }) + '\\n');
`, 'utf8');
  fs.chmodSync(fakeNpm, 0o755);

  git(root, ['init', '-b', 'main']);
  git(root, ['config', 'user.email', 'skill-deps-test@example.invalid']);
  git(root, ['config', 'user.name', 'Skill Deps Test']);
  git(root, ['add', '.']);
  git(root, ['commit', '-m', 'fixture']);
  return { root, binDir, callsPath, eventsPath, lockRoot };
}

function installerEnv(fixture, extraEnv = {}) {
  return {
    ...process.env,
    INSTALL_SKILL_DEPS_CALLS: fixture.callsPath,
    INSTALL_SKILL_DEPS_EVENTS: fixture.eventsPath,
    ZYLOS_TEST_SKILL_DEPS_LOCK_ROOT: fixture.lockRoot,
    PATH: `${fixture.binDir}${path.delimiter}${process.env.PATH}`,
    ...extraEnv,
  };
}

function runInstaller(fixture, extraEnv = {}) {
  return spawnSync(process.execPath, ['scripts/install-skill-deps.js'], {
    cwd: fixture.root,
    encoding: 'utf8',
    env: installerEnv(fixture, extraEnv),
  });
}

function startInstaller(fixture, extraEnv = {}, timeoutMs = 10_000) {
  const child = spawn(process.execPath, ['scripts/install-skill-deps.js'], {
    cwd: fixture.root,
    env: installerEnv(fixture, extraEnv),
  });
  const completed = new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (status, signal) => {
      clearTimeout(timer);
      resolve({ status, signal, stdout, stderr, timedOut });
    });
  });
  return { child, completed };
}

function runInstallerAsync(fixture, extraEnv = {}, timeoutMs = 10_000) {
  return startInstaller(fixture, extraEnv, timeoutMs).completed;
}

async function waitFor(predicate, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Timed out waiting for fixture condition');
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
  test.each([
    ['dependencies', 'null', null, false],
    ['optionalDependencies', 'number', 1, false],
    ['peerDependencies', 'array', ['example'], true],
    ['devDependencies', 'null', null, false],
  ])('fails closed when %s is a %s', (field, _label, malformedDependencies, nodeModules) => {
    const fixture = makeFixture({
      malformed: {
        packageJson: { name: 'malformed-skill', private: true, [field]: malformedDependencies },
        packageLock: {
          name: 'malformed-skill',
          lockfileVersion: 3,
          packages: { '': { name: 'malformed-skill', [field]: malformedDependencies } },
        },
        nodeModules,
      },
    });

    const result = runInstaller(fixture);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(`skills/malformed/package.json field ${field} must be a plain object`);
    expect(npmCalls(fixture)).toEqual([]);
  });

  test('fails closed when a dependency map contains a non-string specifier', () => {
    const fixture = makeFixture({
      malformed: {
        packageJson: { name: 'malformed-skill', private: true, dependencies: { example: 1 } },
        packageLock: {
          name: 'malformed-skill',
          lockfileVersion: 3,
          packages: { '': { name: 'malformed-skill', dependencies: { example: 1 } } },
        },
      },
    });

    const result = runInstaller(fixture);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/skills\/malformed.*dependencies.*string specifier/s);
    expect(npmCalls(fixture)).toEqual([]);
  });

  test.each([
    ['invalid JSON before a successful npm fallback', '{', false],
    ['unsupported lockfileVersion', { name: 'locked-skill', version: '1.0.0', lockfileVersion: 1, packages: { '': { name: 'locked-skill', version: '1.0.0', dependencies: { example: '1.0.0' } } } }, false],
    ['missing root package with node_modules present', { name: 'locked-skill', version: '1.0.0', lockfileVersion: 3, packages: {} }, true],
    ['mismatched package identity with node_modules present', { name: 'other-skill', version: '1.0.0', lockfileVersion: 3, packages: { '': { name: 'other-skill', version: '1.0.0', dependencies: { example: '1.0.0' } } } }, true],
    ['mismatched package version', { name: 'locked-skill', version: '2.0.0', lockfileVersion: 3, packages: { '': { name: 'locked-skill', version: '2.0.0', dependencies: { example: '1.0.0' } } } }, false],
    ['mismatched root dependencies', { name: 'locked-skill', version: '1.0.0', lockfileVersion: 3, packages: { '': { name: 'locked-skill', version: '1.0.0', dependencies: { example: '2.0.0' } } } }, false],
  ])('rejects %s', (_label, packageLock, nodeModules) => {
    const fixture = makeFixture({
      locked: {
        packageJson: { name: 'locked-skill', version: '1.0.0', private: true, dependencies: { example: '1.0.0' } },
        ...(typeof packageLock === 'string' ? { packageLockRaw: packageLock } : { packageLock }),
        nodeModules,
      },
    });

    const result = runInstaller(fixture);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/skills\/locked\/package-lock\.json/s);
    expect(npmCalls(fixture)).toEqual([]);
  });

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

  test('rejects an untracked lockfile before npm without changing it', () => {
    const fixture = makeFixture({
      untracked: {
        packageJson: { name: 'untracked-skill', private: true, dependencies: { example: '1.0.0' } },
      },
    });
    const lockPath = path.join(fixture.root, 'skills', 'untracked', 'package-lock.json');
    writeJson(fixture.root, path.relative(fixture.root, lockPath), {
      name: 'untracked-skill',
      lockfileVersion: 3,
      packages: { '': { name: 'untracked-skill', dependencies: { example: '1.0.0' } } },
    });
    const lockBefore = fs.readFileSync(lockPath, 'utf8');

    const result = runInstaller(fixture);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/skills\/untracked\/package-lock\.json.*tracked by Git/s);
    expect(npmCalls(fixture)).toEqual([]);
    expect(fs.readFileSync(lockPath, 'utf8')).toBe(lockBefore);
    expect(git(fixture.root, ['status', '--porcelain'])).toBe('?? skills/untracked/package-lock.json');
  });

  test('coalesces two concurrent pretests so only one process runs npm ci', async () => {
    const fixture = makeFixture({
      concurrent: {
        packageJson: { name: 'concurrent-skill', private: true, dependencies: { example: '1.0.0' } },
        packageLock: {
          name: 'concurrent-skill',
          lockfileVersion: 3,
          packages: { '': { name: 'concurrent-skill', dependencies: { example: '1.0.0' } } },
        },
      },
    });

    const results = await Promise.all([
      runInstallerAsync(fixture, { INSTALL_SKILL_DEPS_NPM_DELAY_MS: '300' }),
      runInstallerAsync(fixture, { INSTALL_SKILL_DEPS_NPM_DELAY_MS: '300' }),
    ]);

    expect(results.map((result) => result.status)).toEqual([0, 0]);
    expect(npmCalls(fixture)).toHaveLength(1);
    expect(fs.existsSync(path.join(fixture.root, 'skills', 'concurrent', 'node_modules'))).toBe(true);
    expect(git(fixture.root, ['status', '--porcelain'])).toBe('');
  });

  test('does not steal a live install lock when owner.json becomes corrupt', async () => {
    const fixture = makeFixture({
      corruptOwner: {
        packageJson: { name: 'corrupt-owner-skill', private: true, dependencies: { example: '1.0.0' } },
        packageLock: {
          name: 'corrupt-owner-skill',
          lockfileVersion: 3,
          packages: { '': { name: 'corrupt-owner-skill', dependencies: { example: '1.0.0' } } },
        },
      },
    });
    const lockDir = path.join(fixture.lockRoot, 'corruptOwner.lock');
    const first = startInstaller(fixture, { INSTALL_SKILL_DEPS_NPM_DELAY_MS: '6500' });
    await waitFor(() => npmCalls(fixture).length === 1 && fs.existsSync(path.join(lockDir, 'owner.json')));

    writeFile(lockDir, 'owner.json', '{');
    const second = runInstallerAsync(fixture, { INSTALL_SKILL_DEPS_NPM_DELAY_MS: '100' });
    const results = await Promise.all([first.completed, second]);

    expect(results.map((result) => result.status)).toEqual([0, 0]);
    expect(npmCalls(fixture)).toHaveLength(1);
    expect(fs.existsSync(path.join(fixture.root, 'skills', 'corruptOwner', 'node_modules'))).toBe(true);
    expect(git(fixture.root, ['status', '--porcelain'])).toBe('');
  }, 15_000);

  test('recovers a stale recovery guard left by a crashed owner', async () => {
    const fixture = makeFixture({
      stale: {
        packageJson: { name: 'stale-skill', private: true, dependencies: { example: '1.0.0' } },
        packageLock: {
          name: 'stale-skill',
          lockfileVersion: 3,
          packages: { '': { name: 'stale-skill', dependencies: { example: '1.0.0' } } },
        },
      },
    });
    const recoveryDir = path.join(fixture.lockRoot, 'stale.lock.recovery');
    fs.mkdirSync(recoveryDir, { recursive: true });
    writeJson(recoveryDir, 'owner.json', { pid: 2_147_483_647, token: 'dead-recovery-owner' });
    const oldDate = new Date(Date.now() - 60_000);
    fs.utimesSync(recoveryDir, oldDate, oldDate);

    const result = await runInstallerAsync(fixture, {}, 750);

    expect(result.timedOut).toBe(false);
    expect(result.status).toBe(0);
    expect(npmCalls(fixture)).toHaveLength(1);
    expect(fs.existsSync(recoveryDir)).toBe(false);
    expect(git(fixture.root, ['status', '--porcelain'])).toBe('');
  });

  test('recovers a stale install lock left by a crashed owner', () => {
    const fixture = makeFixture({
      stale: {
        packageJson: { name: 'stale-skill', private: true, dependencies: { example: '1.0.0' } },
        packageLock: {
          name: 'stale-skill',
          lockfileVersion: 3,
          packages: { '': { name: 'stale-skill', dependencies: { example: '1.0.0' } } },
        },
      },
    });
    const lockDir = path.join(fixture.lockRoot, 'stale.lock');
    fs.mkdirSync(lockDir, { recursive: true });
    writeJson(lockDir, 'owner.json', { pid: 2_147_483_647, token: 'dead-install-owner' });

    const result = runInstaller(fixture);

    expect(result.status).toBe(0);
    expect(npmCalls(fixture)).toHaveLength(1);
    expect(fs.existsSync(lockDir)).toBe(false);
    expect(git(fixture.root, ['status', '--porcelain'])).toBe('');
  });

  test('releases the owner lock after npm failure so the next pretest can retry', () => {
    const fixture = makeFixture({
      retryable: {
        packageJson: { name: 'retryable-skill', private: true, dependencies: { example: '1.0.0' } },
        packageLock: {
          name: 'retryable-skill',
          lockfileVersion: 3,
          packages: { '': { name: 'retryable-skill', dependencies: { example: '1.0.0' } } },
        },
      },
    });
    const failOncePath = path.join(tempRoot, 'npm-failed-once');
    const lockDir = path.join(fixture.lockRoot, 'retryable.lock');

    const failed = runInstaller(fixture, { INSTALL_SKILL_DEPS_NPM_FAIL_ONCE: failOncePath });

    expect(failed.status).not.toBe(0);
    expect(failed.stderr).toMatch(/npm ci --omit=dev/);
    expect(fs.existsSync(lockDir)).toBe(false);
    expect(fs.existsSync(path.join(fixture.root, 'skills', 'retryable', 'node_modules'))).toBe(false);

    const retried = runInstaller(fixture, { INSTALL_SKILL_DEPS_NPM_FAIL_ONCE: failOncePath });

    expect(retried.status).toBe(0);
    expect(npmCalls(fixture)).toHaveLength(2);
    expect(fs.existsSync(lockDir)).toBe(false);
    expect(fs.existsSync(path.join(fixture.root, 'skills', 'retryable', 'node_modules'))).toBe(true);
    expect(git(fixture.root, ['status', '--porcelain'])).toBe('');
  });

  test('retries npm after a failed install leaves partial node_modules', () => {
    const fixture = makeFixture({
      partial: {
        packageJson: { name: 'partial-skill', private: true, dependencies: { example: '1.0.0' } },
        packageLock: {
          name: 'partial-skill',
          lockfileVersion: 3,
          packages: { '': { name: 'partial-skill', dependencies: { example: '1.0.0' } } },
        },
      },
    });
    const failOncePath = path.join(tempRoot, 'npm-left-partial-once');
    const failureEnv = {
      INSTALL_SKILL_DEPS_NPM_FAIL_ONCE: failOncePath,
      INSTALL_SKILL_DEPS_NPM_LEAVE_PARTIAL_ON_FAILURE: '1',
    };

    const failed = runInstaller(fixture, failureEnv);
    const retried = runInstaller(fixture, failureEnv);

    expect(failed.status).not.toBe(0);
    expect(retried.status).toBe(0);
    expect(npmCalls(fixture)).toHaveLength(2);
    expect(fs.existsSync(path.join(fixture.root, 'skills', 'partial', 'node_modules', 'partial'))).toBe(false);
    expect(git(fixture.root, ['status', '--porcelain'])).toBe('');
  });

  test('does not start a second npm process when the parent pretest crashes', async () => {
    const fixture = makeFixture({
      crash: {
        packageJson: { name: 'crash-skill', private: true, dependencies: { example: '1.0.0' } },
        packageLock: {
          name: 'crash-skill',
          lockfileVersion: 3,
          packages: { '': { name: 'crash-skill', dependencies: { example: '1.0.0' } } },
        },
      },
    });
    const first = startInstaller(fixture, { INSTALL_SKILL_DEPS_NPM_DELAY_MS: '800' });
    await waitFor(() => npmCalls(fixture).length === 1);

    first.child.kill('SIGKILL');
    await first.completed;
    const retried = await runInstallerAsync(fixture, { INSTALL_SKILL_DEPS_NPM_DELAY_MS: '800' });

    expect(retried.status).toBe(0);
    expect(npmCalls(fixture)).toHaveLength(1);
    expect(fs.existsSync(path.join(fixture.root, 'skills', 'crash', 'node_modules'))).toBe(true);
    expect(git(fixture.root, ['status', '--porcelain'])).toBe('');
  });
});
