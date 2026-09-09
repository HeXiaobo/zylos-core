import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { validateComponentRepoOverride } from '../component-repo-override.js';
import { validateUpgradeSource } from '../upgrade-metadata.js';

const SHA = '0123456789abcdef0123456789abcdef01234567';
const CLI = path.join(import.meta.dirname, '..', '..', 'zylos.js');
// The upgrade child resolves npm/pm2 from PATH and then validates them with a
// strict ownership check that rejects executables under world-writable
// ancestors (e.g. /tmp on Linux CI). Fixture roots used by child-process
// upgrades therefore live inside the checkout, whose ancestors are always
// user-owned and non-world-writable.
const FIXTURE_BASE = path.join(import.meta.dirname, '..', '..', '..', 'test', 'integration', 'runtime');

// Resolve a host executable for a fixture stub to delegate to. Used only by
// the test process while building fixtures, never inside the upgrade child.
function resolveHostExecutable(name) {
  for (const dir of String(process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, name);
    try {
      if (!fs.statSync(candidate).isFile()) continue;
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // keep scanning
    }
  }
  throw new Error(`required host tool not found on PATH: ${name}`);
}

// The child-process upgrade tests below pin the child's PATH to fakeBin ONLY
// (#74): the child resolves npm/pm2 from PATH through an ownership trust-walk
// that rejects executables under group/world-writable ancestors. On umask-002
// checkouts the fixture stubs themselves get rejected, and resolution used to
// fall through to the HOST pm2 — whose daemon-spawn output then broke jlist
// parsing only under the full suite (isolated HOME → no daemon → spawn noise).
// With no host entry reachable, pm2/npm resolve to the stub or to nothing;
// both are deterministic and the host daemon is untouchable.
//
// The pipeline also execs a few binaries by plain name with no trust-walk
// (curl, tar via download.js; ps via process-identity.js). curl has a real
// stub; tar, ps and gzip (GNU tar shells out to it for .gz) cannot be faked,
// so their stubs delegate to the host binaries resolved at fixture time. The
// delegations are unaffected by checkout permission bits because plain
// execFileSync resolves by PATH order and never runs the trust-walk.
function writeDelegatingStub(fakeBin, name) {
  fs.writeFileSync(
    path.join(fakeBin, name),
    `#!/bin/sh\nexec "${resolveHostExecutable(name)}" "$@"\n`,
    { mode: 0o755 },
  );
}

test('accepts a GitHub owner/name override pinned to a full commit SHA', () => {
  assert.deepEqual(
    validateComponentRepoOverride({
      repo: 'HeXiaobo/zylos-hxa-connect',
      branch: SHA,
      target: 'hxa-connect',
      upgradeSelf: false,
      upgradeAll: false,
    }),
    { repo: 'HeXiaobo/zylos-hxa-connect', branch: SHA },
  );
});

test('rejects URLs, empty values, and shell-like repository input', () => {
  for (const repo of [
    'https://github.com/HeXiaobo/zylos-hxa-connect',
    '',
    'HeXiaobo/zylos-hxa-connect;touch /tmp/pwned',
    'HeXiaobo/zylos-hxa-connect?ref=main',
    'HeXiaobo/zylos-hxa-connect/extra',
  ]) {
    assert.throws(
      () => validateComponentRepoOverride({
        repo,
        branch: SHA,
        target: 'hxa-connect',
        upgradeSelf: false,
        upgradeAll: false,
      }),
      /GitHub repository must be an owner\/name slug/,
      repo,
    );
  }
});

test('requires an immutable full commit SHA for an override', () => {
  for (const branch of ['', 'main', '0123456789abcdef0123456789abcdef0123456', `${SHA}-extra`]) {
    assert.throws(
      () => validateComponentRepoOverride({
        repo: 'HeXiaobo/zylos-hxa-connect',
        branch,
        target: 'hxa-connect',
        upgradeSelf: false,
        upgradeAll: false,
      }),
      /--repo requires --branch <40-hex-commit-sha>/,
      branch || '(empty)',
    );
  }
});

test('metadata validation applies the same GitHub slug boundary', () => {
  for (const repo of [
    'https://github.com/owner/repo',
    'owner/repo/extra',
    'owner/repo;injected',
    ' owner/repo',
  ]) {
    assert.throws(
      () => validateUpgradeSource({
        type: 'github-release',
        repo,
        ref: SHA,
        refType: 'commit',
      }),
      /upgrade source repo must be owner\/name/,
      repo,
    );
  }
});

test('allows an explicit self override pinned to a sha-or-tag ref (#40)', () => {
  assert.deepEqual(
    validateComponentRepoOverride({
      repo: 'HeXiaobo/zylos-core',
      branch: SHA,
      target: null,
      upgradeSelf: true,
      upgradeAll: false,
    }),
    { repo: 'HeXiaobo/zylos-core', branch: SHA },
  );
  // A tag or branch name is a legitimate self pin; only components keep the
  // stricter 40-hex contract.
  assert.deepEqual(
    validateComponentRepoOverride({
      repo: 'HeXiaobo/zylos-core',
      branch: 'v0.7.2-rc.18',
      target: null,
      upgradeSelf: true,
      upgradeAll: false,
    }),
    { repo: 'HeXiaobo/zylos-core', branch: 'v0.7.2-rc.18' },
  );
});

test('self overrides require --branch and --all overrides stay rejected', () => {
  assert.throws(
    () => validateComponentRepoOverride({
      repo: 'HeXiaobo/zylos-core',
      branch: null,
      target: null,
      upgradeSelf: true,
      upgradeAll: false,
    }),
    /--repo with --self requires --branch <sha-or-tag>/,
  );
  assert.throws(
    () => validateComponentRepoOverride({
      repo: 'HeXiaobo/zylos-core',
      branch: 'main',
      target: null,
      upgradeSelf: false,
      upgradeAll: true,
    }),
    /only supported for a component target/,
  );
});

test('CLI rejects invalid overrides before loading or mutating component state', () => {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-component-repo-args-'));
  const zylosDir = path.join(fixtureRoot, 'zylos-home');

  try {
    const invalidCases = [
      {
        args: ['hxa-connect', '--repo', 'https://github.com/HeXiaobo/zylos-hxa-connect', '--branch', SHA],
        error: 'owner/name slug',
      },
      {
        args: ['hxa-connect', '--repo', 'HeXiaobo/zylos-hxa-connect', '--branch', 'main'],
        error: '40-hex-commit-sha',
      },
      {
        args: ['--self', '--repo', 'HeXiaobo/zylos-hxa-connect'],
        error: '--repo with --self requires --branch',
      },
      {
        args: ['--all', '--repo=HeXiaobo/zylos-hxa-connect', '--branch', SHA],
        error: 'only supported for a component target',
      },
      {
        args: ['hxa-connect', '--repo', 'HeXiaobo/zylos-hxa-connect', '--repo', 'other/repo', '--branch', SHA],
        error: '--repo may only be provided once',
      },
      {
        args: ['hxa-connect', '--repo', 'HeXiaobo/zylos-hxa-connect', '--branch', SHA, '--branch', SHA],
        error: '--branch may only be provided once',
      },
      {
        args: ['hxa-connect', '--repo', 'HeXiaobo/zylos-hxa-connect'],
        error: '40-hex-commit-sha',
      },
      {
        args: ['hxa-connect', '--beta', '--repo', 'HeXiaobo/zylos-hxa-connect', '--branch', SHA],
        error: '--beta and --branch are mutually exclusive',
      },
      {
        args: ['hxa-connect', '--repo', '--branch', SHA],
        error: 'owner/name repository',
      },
    ];

    for (const { args, error } of invalidCases) {
      const child = spawnSync(process.execPath, [CLI, 'upgrade', ...args], {
        cwd: fixtureRoot,
        env: { ...process.env, ZYLOS_DIR: zylosDir },
        encoding: 'utf8',
        timeout: 30000,
      });
      assert.notEqual(child.status, 0, `${args.join(' ')} unexpectedly succeeded`);
      assert.match(`${child.stdout}\n${child.stderr}`, new RegExp(error));
    }
    assert.equal(fs.existsSync(zylosDir), false);
  } finally {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test('override cannot bypass the local-source upgrade guard', () => {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-component-repo-local-'));
  const zylosDir = path.join(fixtureRoot, 'zylos-home');
  const component = 'local-component';
  const skillDir = path.join(zylosDir, '.claude', 'skills', component);
  const componentsPath = path.join(zylosDir, '.zylos', 'components.json');

  try {
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '---\nname: local-component\nversion: 1.0.0\n---\n');
    fs.mkdirSync(path.dirname(componentsPath), { recursive: true });
    fs.writeFileSync(componentsPath, JSON.stringify({
      [component]: {
        version: '1.0.0',
        source: { type: 'local-dir', path: '/tmp/local-component' },
      },
    }));

    const child = spawnSync(process.execPath, [
      CLI,
      'upgrade',
      component,
      '--repo',
      'HeXiaobo/zylos-hxa-connect',
      '--branch',
      SHA,
      '--check',
      '--json',
    ], {
      cwd: fixtureRoot,
      env: { ...process.env, ZYLOS_DIR: zylosDir },
      encoding: 'utf8',
      timeout: 30000,
    });

    assert.notEqual(child.status, 0, `stdout:\n${child.stdout}\nstderr:\n${child.stderr}`);
    const output = JSON.parse(child.stdout);
    assert.equal(output.error, 'local_source_upgrade_unsupported');
    assert.equal(fs.existsSync(path.join(skillDir, '.zylos-source.json')), false);
    assert.deepEqual(JSON.parse(fs.readFileSync(componentsPath, 'utf8')), {
      [component]: {
        version: '1.0.0',
        source: { type: 'local-dir', path: '/tmp/local-component' },
      },
    });
  } finally {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test('check-only downloads the exact ref from the explicit repository', () => {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-component-repo-check-'));
  const zylosDir = path.join(fixtureRoot, 'zylos-home');
  const fakeBin = path.join(fixtureRoot, 'bin');
  const archiveRoot = path.join(fixtureRoot, 'component-fixture');
  const tarball = path.join(fixtureRoot, 'component.tar.gz');
  const urlLog = path.join(fixtureRoot, 'urls.log');
  const component = 'hxa-connect';
  const oldRepo = 'coco-xyz/zylos-hxa-connect';
  const overrideRepo = 'HeXiaobo/zylos-hxa-connect';
  const skillDir = path.join(zylosDir, '.claude', 'skills', component);

  try {
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(
      path.join(skillDir, 'SKILL.md'),
      '---\nname: hxa-connect\nversion: 1.7.4\n---\n',
    );
    fs.mkdirSync(path.join(zylosDir, '.zylos'), { recursive: true });
    fs.writeFileSync(
      path.join(zylosDir, '.zylos', 'components.json'),
      JSON.stringify({
        [component]: { version: '1.7.4', repo: oldRepo },
      }),
    );

    fs.mkdirSync(archiveRoot, { recursive: true });
    fs.writeFileSync(
      path.join(archiveRoot, 'package.json'),
      JSON.stringify({ name: 'zylos-hxa-connect', version: '1.7.5' }),
    );
    fs.writeFileSync(
      path.join(archiveRoot, 'SKILL.md'),
      '---\nname: hxa-connect\nversion: 1.7.5\n---\n',
    );
    execFileSync('tar', ['czf', tarball, '-C', fixtureRoot, path.basename(archiveRoot)]);

    fs.mkdirSync(fakeBin, { recursive: true });
    fs.writeFileSync(path.join(fakeBin, 'curl.mjs'), [
      "import fs from 'node:fs';",
      "const args = process.argv.slice(2);",
      "fs.appendFileSync(process.env.ZYLOS_TEST_URL_LOG, `${args.at(-1)}\\n`);",
      "const outputIndex = args.indexOf('-o');",
      'if (outputIndex !== -1) {',
      '  fs.copyFileSync(process.env.ZYLOS_TEST_TARBALL, args[outputIndex + 1]);',
      '  process.exit(0);',
      '}',
      "process.stdout.write(JSON.stringify([{ name: 'v1.7.5' }]));",
    ].join('\n'));
    fs.writeFileSync(
      path.join(fakeBin, 'curl'),
      `#!/bin/sh\nexec "${process.execPath}" "\${0%/*}/curl.mjs" "$@"\n`,
      { mode: 0o755 },
    );

    const child = spawnSync(process.execPath, [
      CLI,
      'upgrade',
      component,
      '--repo',
      overrideRepo,
      '--branch',
      SHA,
      '--check',
      '--json',
    ], {
      cwd: fixtureRoot,
      env: {
        ...process.env,
        ZYLOS_DIR: zylosDir,
        PATH: `${fakeBin}${path.delimiter}${process.env.PATH}`,
        ZYLOS_TEST_URL_LOG: urlLog,
        ZYLOS_TEST_TARBALL: tarball,
        GITHUB_TOKEN: '',
        GH_TOKEN: '',
      },
      encoding: 'utf8',
      timeout: 30000,
    });

    assert.equal(child.status, 0, `stdout:\n${child.stdout}\nstderr:\n${child.stderr}`);
    const output = JSON.parse(child.stdout);
    const urls = fs.readFileSync(urlLog, 'utf8').trim().split('\n').filter(Boolean);
    assert.equal(output.repo, overrideRepo);
    assert.equal(output.branch, SHA);
    assert.equal(output.latest, '1.7.5');
    assert.ok(
      urls.includes(`https://github.com/${overrideRepo}/archive/${SHA}.tar.gz`),
      `download URLs:\n${urls.join('\n')}`,
    );
    assert.equal(
      urls.some((url) => url.includes(`/coco-xyz/`)),
      false,
      `override check unexpectedly downloaded from the installed repository:\n${urls.join('\n')}`,
    );
    assert.deepEqual(
      JSON.parse(fs.readFileSync(path.join(zylosDir, '.zylos', 'components.json'), 'utf8')),
      { [component]: { version: '1.7.4', repo: oldRepo } },
    );
  } finally {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test('exact-ref check fails closed when the pinned archive cannot be downloaded', () => {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-component-repo-check-fail-'));
  const zylosDir = path.join(fixtureRoot, 'zylos-home');
  const fakeBin = path.join(fixtureRoot, 'bin');
  const urlLog = path.join(fixtureRoot, 'urls.log');
  const component = 'hxa-connect';
  const overrideRepo = 'HeXiaobo/zylos-hxa-connect';
  const skillDir = path.join(zylosDir, '.claude', 'skills', component);

  try {
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(
      path.join(skillDir, 'SKILL.md'),
      '---\nname: hxa-connect\nversion: 1.7.4\n---\n',
    );
    fs.mkdirSync(path.join(zylosDir, '.zylos'), { recursive: true });
    fs.writeFileSync(
      path.join(zylosDir, '.zylos', 'components.json'),
      JSON.stringify({ [component]: { version: '1.7.4', repo: 'coco-xyz/zylos-hxa-connect' } }),
    );

    fs.mkdirSync(fakeBin, { recursive: true });
    fs.writeFileSync(path.join(fakeBin, 'curl'), `#!/bin/sh
printf '%s\n' "$@" >> "${urlLog}"
echo 'curl: pinned archive unavailable' >&2
exit 22
`, { mode: 0o755 });
    fs.writeFileSync(path.join(fakeBin, 'gh'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });

    const child = spawnSync(process.execPath, [
      CLI,
      'upgrade',
      component,
      '--repo',
      overrideRepo,
      '--branch',
      SHA,
      '--check',
      '--json',
    ], {
      cwd: fixtureRoot,
      env: {
        ...process.env,
        ZYLOS_DIR: zylosDir,
        PATH: `${fakeBin}${path.delimiter}${process.env.PATH}`,
        GITHUB_TOKEN: '',
        GH_TOKEN: '',
        ZYLOS_GH_RETRY_DELAY_MS: '',
      },
      encoding: 'utf8',
      timeout: 30000,
    });

    assert.notEqual(child.status, 0, `stdout:\n${child.stdout}\nstderr:\n${child.stderr}`);
    const output = JSON.parse(child.stdout);
    assert.equal(output.success, false);
    assert.equal(output.hasUpdate, false);
    assert.equal(output.error, 'exact_ref_download_failed');
    assert.match(output.message, /Failed to download/);
    assert.equal(output.branch, SHA);
    assert.doesNotMatch(output.reply, /Run "zylos upgrade/);
    assert.match(
      fs.readFileSync(urlLog, 'utf8'),
      new RegExp(`https://github\\.com/${overrideRepo}/archive/${SHA}\\.tar\\.gz`),
    );
  } finally {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test('exact-ref check and execute fail closed when the target version is unreadable', () => {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-component-repo-version-fail-'));
  const zylosDir = path.join(fixtureRoot, 'zylos-home');
  const fakeBin = path.join(fixtureRoot, 'bin');
  const archiveRoot = path.join(fixtureRoot, 'component-fixture');
  const tarball = path.join(fixtureRoot, 'component.tar.gz');
  const urlLog = path.join(fixtureRoot, 'urls.log');
  const component = 'hxa-connect';
  const overrideRepo = 'HeXiaobo/zylos-hxa-connect';
  const skillDir = path.join(zylosDir, '.claude', 'skills', component);

  try {
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(
      path.join(skillDir, 'SKILL.md'),
      '---\nname: hxa-connect\nversion: 1.7.4\n---\n',
    );
    fs.mkdirSync(path.join(zylosDir, '.zylos'), { recursive: true });
    fs.writeFileSync(
      path.join(zylosDir, '.zylos', 'components.json'),
      JSON.stringify({ [component]: { version: '1.7.4', repo: 'coco-xyz/zylos-hxa-connect' } }),
    );

    fs.mkdirSync(archiveRoot, { recursive: true });
    fs.writeFileSync(path.join(archiveRoot, 'README.md'), 'no component version here\n');
    execFileSync('tar', ['czf', tarball, '-C', fixtureRoot, path.basename(archiveRoot)]);

    fs.mkdirSync(fakeBin, { recursive: true });
    fs.writeFileSync(path.join(fakeBin, 'curl'), [
      '#!/bin/sh',
      'printf "%s\\n" "$@" >> "$ZYLOS_TEST_URL_LOG"',
      'while [ "$#" -gt 0 ]; do',
      '  if [ "$1" = "-o" ]; then cp "$ZYLOS_TEST_TARBALL" "$2"; exit 0; fi',
      '  shift',
      'done',
      'exit 1',
    ].join('\n'), { mode: 0o755 });

    const runCli = (extraArgs) => spawnSync(process.execPath, [
      CLI,
      'upgrade',
      component,
      '--repo',
      overrideRepo,
      '--branch',
      SHA,
      ...extraArgs,
      '--json',
    ], {
      cwd: fixtureRoot,
      env: {
        ...process.env,
        ZYLOS_DIR: zylosDir,
        PATH: `${fakeBin}${path.delimiter}${process.env.PATH}`,
        ZYLOS_TEST_URL_LOG: urlLog,
        ZYLOS_TEST_TARBALL: tarball,
        GITHUB_TOKEN: '',
        GH_TOKEN: '',
      },
      encoding: 'utf8',
      timeout: 30000,
    });

    for (const [mode, extraArgs] of [['check', ['--check']], ['execute', ['--yes', '--skip-eval']]]) {
      const child = runCli(extraArgs);
      assert.notEqual(child.status, 0, `${mode} unexpectedly succeeded:\n${child.stdout}\n${child.stderr}`);
      const output = JSON.parse(child.stdout);
      assert.equal(output.action, mode === 'check' ? 'check' : 'upgrade');
      assert.equal(output.success, false);
      assert.equal(output.error, 'exact_ref_version_unreadable');
      assert.match(output.message, /Cannot read target component version/);
      assert.equal(output.branch, SHA);
      assert.doesNotMatch(output.reply, /Run "zylos upgrade/);
    }

    const urls = fs.readFileSync(urlLog, 'utf8')
      .trim()
      .split('\n')
      .filter((value) => value.startsWith('https://'));
    assert.deepEqual(urls, [
      `https://github.com/${overrideRepo}/archive/${SHA}.tar.gz`,
      `https://github.com/${overrideRepo}/archive/${SHA}.tar.gz`,
    ]);
    assert.equal(fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf8'), '---\nname: hxa-connect\nversion: 1.7.4\n---\n');
    assert.deepEqual(
      JSON.parse(fs.readFileSync(path.join(zylosDir, '.zylos', 'components.json'), 'utf8')),
      { [component]: { version: '1.7.4', repo: 'coco-xyz/zylos-hxa-connect' } },
    );
  } finally {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test('execute commits override provenance consistently in marker and registry', () => {
  fs.mkdirSync(FIXTURE_BASE, { recursive: true });
  const fixtureRoot = fs.mkdtempSync(path.join(FIXTURE_BASE, 'zylos-component-repo-execute-'));
  const zylosDir = path.join(fixtureRoot, 'zylos-home');
  const fakeBin = path.join(fixtureRoot, 'bin');
  const archiveRoot = path.join(fixtureRoot, 'component-fixture');
  const tarball = path.join(fixtureRoot, 'component.tar.gz');
  const urlLog = path.join(fixtureRoot, 'urls.log');
  const component = 'hxa-connect';
  const oldRepo = 'coco-xyz/zylos-hxa-connect';
  const overrideRepo = 'HeXiaobo/zylos-hxa-connect';
  const installedAt = '2026-01-02T03:04:05.000Z';
  const skillDir = path.join(zylosDir, '.claude', 'skills', component);
  const oldSha = 'fedcba9876543210fedcba9876543210fedcba98';

  try {
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(
      path.join(skillDir, 'SKILL.md'),
      '---\nname: hxa-connect\nversion: 1.7.4\n---\n',
    );
    fs.writeFileSync(path.join(skillDir, 'payload.txt'), 'old\n');
    fs.writeFileSync(
      path.join(skillDir, '.zylos-source.json'),
      JSON.stringify({ repo: oldRepo, sha: oldSha, ref: oldSha, refType: 'commit', version: '1.7.4', installedAt }),
    );
    fs.mkdirSync(path.join(zylosDir, '.zylos'), { recursive: true });
    fs.writeFileSync(
      path.join(zylosDir, '.zylos', 'components.json'),
      JSON.stringify({
        [component]: {
          version: '1.7.4',
          repo: oldRepo,
          installedAt,
          branch: oldSha,
          source: { type: 'github-release', repo: oldRepo, ref: oldSha, refType: 'commit' },
        },
      }),
    );

    fs.mkdirSync(archiveRoot, { recursive: true });
    // No package.json in the fixture archive: npm_install then skips
    // deterministically ("no package.json") on every machine instead of
    // depending on whether the npm stub passes the ownership trust-walk (#74).
    fs.writeFileSync(
      path.join(archiveRoot, 'SKILL.md'),
      '---\nname: hxa-connect\nversion: 1.7.5\n---\n',
    );
    fs.writeFileSync(path.join(archiveRoot, 'payload.txt'), 'new\n');
    execFileSync('tar', ['czf', tarball, '-C', fixtureRoot, path.basename(archiveRoot)]);

    fs.mkdirSync(fakeBin, { recursive: true });
    fs.writeFileSync(path.join(fakeBin, 'curl.mjs'), [
      "import fs from 'node:fs';",
      "const args = process.argv.slice(2);",
      "fs.appendFileSync(process.env.ZYLOS_TEST_URL_LOG, `${args.at(-1)}\\n`);",
      "const outputIndex = args.indexOf('-o');",
      'if (outputIndex === -1) process.exit(1);',
      'fs.copyFileSync(process.env.ZYLOS_TEST_TARBALL, args[outputIndex + 1]);',
    ].join('\n'));
    fs.writeFileSync(
      path.join(fakeBin, 'curl'),
      `#!/bin/sh\nexec "${process.execPath}" "\${0%/*}/curl.mjs" "$@"\n`,
      { mode: 0o755 },
    );
    fs.writeFileSync(
      path.join(fakeBin, 'pm2'),
      '#!/bin/sh\nif [ "$1" = "jlist" ]; then printf \'[]\'; fi\n',
      { mode: 0o755 },
    );
    writeDelegatingStub(fakeBin, 'tar');
    writeDelegatingStub(fakeBin, 'gzip');
    writeDelegatingStub(fakeBin, 'ps');

    const child = spawnSync(process.execPath, [
      CLI,
      'upgrade',
      component,
      '--repo',
      overrideRepo,
      '--branch',
      SHA,
      '--yes',
      '--skip-eval',
      '--json',
    ], {
      cwd: fixtureRoot,
      env: {
        ...process.env,
        ZYLOS_DIR: zylosDir,
        // fakeBin ONLY — see writeTarStub(): keeps the child away from the
        // host pm2/npm regardless of the checkout's permission bits (#74).
        PATH: fakeBin,
        ZYLOS_TEST_URL_LOG: urlLog,
        ZYLOS_TEST_TARBALL: tarball,
        GITHUB_TOKEN: '',
        GH_TOKEN: '',
      },
      encoding: 'utf8',
      timeout: 30000,
    });

    assert.equal(child.status, 0, `stdout:\n${child.stdout}\nstderr:\n${child.stderr}`);
    const output = JSON.parse(child.stdout);
    const components = JSON.parse(fs.readFileSync(path.join(zylosDir, '.zylos', 'components.json'), 'utf8'));
    const marker = JSON.parse(fs.readFileSync(path.join(skillDir, '.zylos-source.json'), 'utf8'));
    const urls = fs.readFileSync(urlLog, 'utf8').trim().split('\n').filter(Boolean);
    assert.equal(output.success, true);
    assert.equal(output.to, '1.7.5');
    assert.equal(components[component].version, '1.7.5');
    assert.equal(components[component].repo, overrideRepo);
    assert.deepEqual(components[component].source, {
      type: 'github-release',
      repo: overrideRepo,
      ref: SHA,
      refType: 'commit',
    });
    assert.equal(components[component].branch, SHA);
    assert.equal(components[component].installedAt, installedAt);
    assert.equal(marker.repo, overrideRepo);
    assert.equal(marker.sha, SHA);
    assert.equal(marker.ref, SHA);
    assert.equal(marker.refType, 'commit');
    assert.equal(marker.version, '1.7.5');
    assert.equal(marker.installedAt, installedAt);
    assert.equal(components[component].upgradedAt, marker.upgradedAt);
    assert.equal(fs.readFileSync(path.join(skillDir, 'payload.txt'), 'utf8'), 'new\n');
    assert.equal(fs.statSync(path.join(skillDir, '.zylos-source.json')).mode & 0o777, 0o600);
    assert.deepEqual(urls, [`https://github.com/${overrideRepo}/archive/${SHA}.tar.gz`]);
    assert.equal(
      fs.existsSync(path.join(zylosDir, '.zylos', 'upgrade-metadata-transactions', `${component}.json`)),
      false,
    );
  } finally {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test('failed override execution rolls back code and leaves registry metadata untouched', () => {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-component-repo-rollback-'));
  const zylosDir = path.join(fixtureRoot, 'zylos-home');
  const fakeBin = path.join(fixtureRoot, 'bin');
  const archiveRoot = path.join(fixtureRoot, 'component-fixture');
  const tarball = path.join(fixtureRoot, 'component.tar.gz');
  const component = 'hxa-connect';
  const oldRepo = 'coco-xyz/zylos-hxa-connect';
  const overrideRepo = 'HeXiaobo/zylos-hxa-connect';
  const installedAt = '2026-01-02T03:04:05.000Z';
  const skillDir = path.join(zylosDir, '.claude', 'skills', component);
  const oldSha = 'fedcba9876543210fedcba9876543210fedcba98';

  try {
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(
      path.join(skillDir, 'SKILL.md'),
      '---\nname: hxa-connect\nversion: 1.7.4\n---\n',
    );
    fs.writeFileSync(path.join(skillDir, 'payload.txt'), 'old\n');
    fs.writeFileSync(
      path.join(skillDir, '.zylos-source.json'),
      JSON.stringify({ repo: oldRepo, sha: oldSha, ref: oldSha, refType: 'commit', version: '1.7.4', installedAt }),
    );
    fs.mkdirSync(path.join(zylosDir, '.zylos'), { recursive: true });
    fs.writeFileSync(
      path.join(zylosDir, '.zylos', 'components.json'),
      JSON.stringify({
        [component]: {
          version: '1.7.4',
          repo: oldRepo,
          installedAt,
          branch: oldSha,
          source: { type: 'github-release', repo: oldRepo, ref: oldSha, refType: 'commit' },
        },
      }),
    );

    fs.mkdirSync(path.join(archiveRoot, 'hooks'), { recursive: true });
    // No package.json in the fixture archive: npm_install then skips
    // deterministically ("no package.json") on every machine, so the failure
    // that triggers the rollback is always the post-upgrade hook — never a
    // machine-dependent npm resolution outcome (#74).
    fs.writeFileSync(
      path.join(archiveRoot, 'SKILL.md'),
      [
        '---',
        'name: hxa-connect',
        'version: 1.7.5',
        'lifecycle:',
        '  hooks:',
        '    post-upgrade: hooks/fail.js',
        '---',
        '',
      ].join('\n'),
    );
    fs.writeFileSync(path.join(archiveRoot, 'payload.txt'), 'new\n');
    fs.writeFileSync(path.join(archiveRoot, 'hooks', 'fail.js'), 'process.exit(17);\n');
    execFileSync('tar', ['czf', tarball, '-C', fixtureRoot, path.basename(archiveRoot)]);

    fs.mkdirSync(fakeBin, { recursive: true });
    fs.writeFileSync(path.join(fakeBin, 'curl.mjs'), [
      "import fs from 'node:fs';",
      "const args = process.argv.slice(2);",
      "const outputIndex = args.indexOf('-o');",
      'if (outputIndex === -1) process.exit(1);',
      'fs.copyFileSync(process.env.ZYLOS_TEST_TARBALL, args[outputIndex + 1]);',
    ].join('\n'));
    fs.writeFileSync(
      path.join(fakeBin, 'curl'),
      `#!/bin/sh\nexec "${process.execPath}" "\${0%/*}/curl.mjs" "$@"\n`,
      { mode: 0o755 },
    );
    fs.writeFileSync(
      path.join(fakeBin, 'pm2'),
      '#!/bin/sh\nif [ "$1" = "jlist" ]; then printf \'[]\'; fi\n',
      { mode: 0o755 },
    );
    writeDelegatingStub(fakeBin, 'tar');
    writeDelegatingStub(fakeBin, 'gzip');
    writeDelegatingStub(fakeBin, 'ps');

    const child = spawnSync(process.execPath, [
      CLI,
      'upgrade',
      component,
      '--repo',
      overrideRepo,
      '--branch',
      SHA,
      '--yes',
      '--skip-eval',
      '--json',
    ], {
      cwd: fixtureRoot,
      env: {
        ...process.env,
        ZYLOS_DIR: zylosDir,
        // fakeBin ONLY — see writeTarStub(): keeps the child away from the
        // host pm2/npm regardless of the checkout's permission bits (#74).
        PATH: fakeBin,
        ZYLOS_TEST_TARBALL: tarball,
        GITHUB_TOKEN: '',
        GH_TOKEN: '',
      },
      encoding: 'utf8',
      timeout: 30000,
    });

    assert.notEqual(child.status, 0, `stdout:\n${child.stdout}\nstderr:\n${child.stderr}`);
    const output = JSON.parse(child.stdout);
    const componentsPath = path.join(zylosDir, '.zylos', 'components.json');
    const components = JSON.parse(fs.readFileSync(componentsPath, 'utf8'));
    const marker = JSON.parse(fs.readFileSync(path.join(skillDir, '.zylos-source.json'), 'utf8'));
    assert.equal(output.success, false);
    assert.equal(components[component].repo, oldRepo);
    assert.equal(components[component].version, '1.7.4');
    assert.equal(components[component].source.ref, oldSha);
    assert.deepEqual(marker, {
      repo: oldRepo,
      sha: oldSha,
      ref: oldSha,
      refType: 'commit',
      version: '1.7.4',
      installedAt,
    });
    assert.equal(fs.readFileSync(path.join(skillDir, 'payload.txt'), 'utf8'), 'old\n');
    assert.equal(
      fs.existsSync(path.join(zylosDir, '.zylos', 'upgrade-metadata-transactions', `${component}.json`)),
      false,
    );
  } finally {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test('self --check pins the override repository and downloads the tagged ref (#40)', () => {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-self-repo-override-'));
  const fakeBin = path.join(fixtureRoot, 'bin');
  const archiveRoot = path.join(fixtureRoot, 'core-fixture');
  const tarball = path.join(fixtureRoot, 'core.tar.gz');
  const urlLog = path.join(fixtureRoot, 'urls.log');
  const overrideRepo = 'HeXiaobo/zylos-core-fixture';
  const tagRef = 'v9.9.9-fixture';

  try {
    fs.mkdirSync(archiveRoot, { recursive: true });
    fs.writeFileSync(
      path.join(archiveRoot, 'package.json'),
      JSON.stringify({ name: 'zylos', version: '9.9.9' }),
    );
    execFileSync('tar', ['czf', tarball, '-C', fixtureRoot, path.basename(archiveRoot)]);

    fs.mkdirSync(fakeBin, { recursive: true });
    fs.writeFileSync(path.join(fakeBin, 'curl.mjs'), [
      "import fs from 'node:fs';",
      "const args = process.argv.slice(2);",
      "fs.appendFileSync(process.env.ZYLOS_TEST_URL_LOG, `${args.at(-1)}\n`);",
      "const outputIndex = args.indexOf('-o');",
      'if (outputIndex !== -1) {',
      '  fs.copyFileSync(process.env.ZYLOS_TEST_TARBALL, args[outputIndex + 1]);',
      '  process.exit(0);',
      '}',
      "if (args.at(-1).includes('raw.githubusercontent.com')) {",
      "  process.stdout.write(JSON.stringify({ name: 'zylos', version: '9.9.9' }));",
      '  process.exit(0);',
      '}',
      "process.stdout.write(JSON.stringify([]));",
    ].join('\n'));
    fs.writeFileSync(
      path.join(fakeBin, 'curl'),
      `#!/bin/sh\nexec "${process.execPath}" "\${0%/*}/curl.mjs" "$@"\n`,
      { mode: 0o755 },
    );
    fs.writeFileSync(path.join(fakeBin, 'gh'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });

    const child = spawnSync(process.execPath, [
      CLI,
      'upgrade',
      '--self',
      '--repo',
      overrideRepo,
      '--branch',
      tagRef,
      '--check',
      '--json',
    ], {
      cwd: fixtureRoot,
      env: {
        ...process.env,
        HOME: fixtureRoot,
        ZYLOS_DIR: path.join(fixtureRoot, 'zylos-home'),
        PATH: `${fakeBin}${path.delimiter}${process.env.PATH}`,
        GITHUB_TOKEN: '',
        GH_TOKEN: '',
        ZYLOS_TEST_URL_LOG: urlLog,
        ZYLOS_TEST_TARBALL: tarball,
      },
      encoding: 'utf8',
      timeout: 60000,
    });

    assert.equal(child.status, 0, `stdout:\n${child.stdout}\nstderr:\n${child.stderr}`);
    const output = JSON.parse(child.stdout);
    assert.equal(output.success, true);
    assert.equal(output.source.repo, overrideRepo);
    assert.equal(output.source.policy, 'explicit-ref');
    assert.equal(output.source.ref, tagRef);
    assert.equal(output.latest, '9.9.9');
    const urls = fs.readFileSync(urlLog, 'utf8').trim().split('\n').filter(Boolean);
    assert.ok(
      urls.includes(`https://raw.githubusercontent.com/${overrideRepo}/${tagRef}/package.json`),
      `version lookup URLs:\n${urls.join('\n')}`,
    );
    assert.ok(
      urls.includes(`https://github.com/${overrideRepo}/archive/${tagRef}.tar.gz`),
      `download URLs:\n${urls.join('\n')}`,
    );
    assert.equal(
      urls.some((url) => url.includes('refs/heads/')),
      false,
      `a tagged pin must not use the branch archive form:\n${urls.join('\n')}`,
    );
  } finally {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});
