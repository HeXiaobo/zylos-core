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

test('allows overrides only for one installed component target', () => {
  assert.throws(
    () => validateComponentRepoOverride({
      repo: 'HeXiaobo/zylos-hxa-connect',
      branch: SHA,
      target: 'hxa-connect',
      upgradeSelf: true,
      upgradeAll: false,
    }),
    /only supported for a component target/,
  );
  assert.throws(
    () => validateComponentRepoOverride({
      repo: 'HeXiaobo/zylos-hxa-connect',
      branch: SHA,
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
        args: ['--self', '--repo', 'HeXiaobo/zylos-hxa-connect', '--branch', SHA],
        error: 'only supported for a component target',
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
      `#!/bin/sh\nexec "${process.execPath}" "$(dirname "$0")/curl.mjs" "$@"\n`,
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
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-component-repo-execute-'));
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
    fs.writeFileSync(
      path.join(archiveRoot, 'package.json'),
      JSON.stringify({ name: 'zylos-hxa-connect', version: '1.7.5' }),
    );
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
      `#!/bin/sh\nexec "${process.execPath}" "$(dirname "$0")/curl.mjs" "$@"\n`,
      { mode: 0o755 },
    );
    fs.writeFileSync(
      path.join(fakeBin, 'pm2'),
      '#!/bin/sh\nif [ "$1" = "jlist" ]; then printf \'[]\'; fi\n',
      { mode: 0o755 },
    );
    fs.writeFileSync(path.join(fakeBin, 'npm'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });

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
    fs.writeFileSync(
      path.join(archiveRoot, 'package.json'),
      JSON.stringify({ name: 'zylos-hxa-connect', version: '1.7.5' }),
    );
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
      `#!/bin/sh\nexec "${process.execPath}" "$(dirname "$0")/curl.mjs" "$@"\n`,
      { mode: 0o755 },
    );
    fs.writeFileSync(
      path.join(fakeBin, 'pm2'),
      '#!/bin/sh\nif [ "$1" = "jlist" ]; then printf \'[]\'; fi\n',
      { mode: 0o755 },
    );
    fs.writeFileSync(path.join(fakeBin, 'npm'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });

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
        PATH: `${fakeBin}${path.delimiter}${process.env.PATH}`,
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
