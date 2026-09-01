import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

const SHA = '0123456789abcdef0123456789abcdef01234567';
const HOSTNAME = os.hostname();
const SCRIPT = path.join(import.meta.dirname, '..', '..', '..', 'scripts', 'upgrade-hxa-connect.js');

function runWithInjectedRuntime(args, { cwd, env, tools, childEnvAdditions }) {
  const evaluator = [
    `import { runHxaUpgrade } from ${JSON.stringify(pathToFileURL(SCRIPT).href)};`,
    'const runtime = JSON.parse(process.env.ZYLOS_TEST_RUNTIME);',
    'process.exitCode = runHxaUpgrade(runtime.argv, { tools: runtime.tools, childEnvAdditions: runtime.childEnvAdditions });',
  ].join('\n');
  return spawnSync(process.execPath, ['--input-type=module', '--eval', evaluator], {
    cwd,
    env: {
      ...env,
      ZYLOS_TEST_RUNTIME: JSON.stringify({ argv: args, tools, childEnvAdditions }),
    },
    encoding: 'utf8',
    timeout: 30000,
  });
}

function writeSkill(dir, { version, payload = 'old' }) {
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\nname: hxa-connect\nversion: ${version}\n---\n`, 'utf8');
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'zylos-hxa-connect', version, type: 'module' }, null, 2), 'utf8');
  fs.writeFileSync(path.join(dir, 'src', 'bot.js'), `${payload}\n`, 'utf8');
}

test('HXA fixed-SHA dry-run validates the target and does not mutate runtime state', () => {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-hxa-upgrade-dry-run-'));
  const zylosDir = path.join(fixtureRoot, 'zylos-home');
  const reportRoot = path.join(zylosDir, '.zylos', 'upgrade-reports', 'ZYL-TEST-001');
  const fakeBin = path.join(fixtureRoot, 'bin');
  const archiveRoot = path.join(fixtureRoot, 'hxa-source');
  const tarball = path.join(fixtureRoot, 'hxa-source.tar.gz');
  const calls = path.join(fixtureRoot, 'calls.log');
  const skillDir = path.join(zylosDir, '.claude', 'skills', 'hxa-connect');
  const componentsPath = path.join(zylosDir, '.zylos', 'components.json');
  const executionId = 'not-supplied-by-caller';

  try {
    writeSkill(skillDir, { version: '1.7.3' });
    fs.mkdirSync(path.join(skillDir, 'scripts'), { recursive: true });
    fs.writeFileSync(
      path.join(skillDir, 'scripts', 'cli.js'),
      "import fs from 'node:fs'; fs.appendFileSync(process.env.ZYLOS_TEST_CALLS, 'profile-cli\\n'); process.exit(99);\n",
      'utf8',
    );
    fs.writeFileSync(
      path.join(skillDir, 'src', 'env.js'),
      "export async function setupFetchProxy() {}\n",
      'utf8',
    );
    const sdkDir = path.join(skillDir, 'node_modules', '@coco-xyz', 'hxa-connect-sdk');
    fs.mkdirSync(path.join(sdkDir, 'dist'), { recursive: true });
    fs.writeFileSync(path.join(sdkDir, 'package.json'), JSON.stringify({
      name: '@coco-xyz/hxa-connect-sdk',
      version: '0.0.0-test',
      type: 'module',
      exports: {
        '.': {
          types: './dist/index.d.ts',
          import: './dist/index.js',
        },
      },
    }));
    fs.writeFileSync(path.join(sdkDir, 'dist', 'index.js'), [
      'export class HxaConnectClient {',
      "  async getProfile() { return { name: process.env.ZYLOS_TEST_PROFILE_NAME || 'ss', id: process.env.ZYLOS_TEST_PROFILE_ID || 'profile-ss', org_id: process.env.ZYLOS_TEST_ORG_ID || 'org-test' }; }",
      '}',
      '',
    ].join('\n'));
    fs.mkdirSync(path.dirname(componentsPath), { recursive: true });
    fs.chmodSync(path.dirname(componentsPath), 0o700);
    fs.writeFileSync(componentsPath, JSON.stringify({
      'hxa-connect': {
        version: '1.7.3',
        repo: 'coco-xyz/zylos-hxa-connect',
        skillDir,
      },
    }, null, 2));
    const hxaConfigPath = path.join(zylosDir, 'components', 'hxa-connect', 'config.json');
    fs.mkdirSync(path.dirname(hxaConfigPath), { recursive: true });
    fs.writeFileSync(hxaConfigPath, JSON.stringify({
      default_hub_url: 'https://hub.invalid.test',
      orgs: {
        default: {
          enabled: true,
          org_id: 'org-test',
          agent_id: 'profile-ss',
          agent_name: 'ss',
          agent_token: 'redacted-test-token',
          access: { dmPolicy: 'open', groupPolicy: 'open', threads: {} },
        },
      },
    }));

    writeSkill(archiveRoot, { version: '1.7.5', payload: 'new' });
    execFileSync('tar', ['czf', tarball, '-C', fixtureRoot, path.basename(archiveRoot)]);
    fs.mkdirSync(fakeBin, { recursive: true });
    fs.writeFileSync(path.join(fakeBin, 'pm2'), [
      '#!/usr/bin/env node',
      "import fs from 'node:fs';",
      `fs.appendFileSync(${JSON.stringify(calls)}, 'pm2 ' + process.argv.slice(2).join(' ') + '\\n');`,
      "if (process.argv[2] !== 'jlist') process.exit(99);",
      `process.stdout.write(${JSON.stringify(`${JSON.stringify([{ name: 'zylos-hxa-connect', pid: process.pid, pm2_env: { status: 'online', pm_exec_path: path.join(skillDir, 'src', 'bot.js'), restart_time: 0, unstable_restarts: 0 } }])}\n`)});`,
    ].join('\n'), { mode: 0o755 });
    fs.writeFileSync(path.join(fakeBin, 'curl'), [
      '#!/bin/sh',
      `printf 'curl %s\\n' "$*" >> "${calls}"`,
      'while [ "$#" -gt 0 ]; do',
      '  if [ "$1" = "-o" ]; then cp "$ZYLOS_TEST_TARBALL" "$2"; exit 0; fi',
      '  shift',
      'done',
      'exit 1',
    ].join('\n'), { mode: 0o755 });
    fs.writeFileSync(path.join(fakeBin, 'ps'), '#!/bin/sh\nif [ "$1" = "-o" ]; then printf "Mon Jan 1 00:00:00 2024\\n"; fi\nexit 0\n', { mode: 0o755 });

    const tools = {
      pm2: path.join(fakeBin, 'pm2'),
      curl: path.join(fakeBin, 'curl'),
      ps: path.join(fakeBin, 'ps'),
      tar: '/usr/bin/tar',
      // Explicitly trusted injection: the fixtures live under the system
      // tempdir, whose world-writable ancestors (e.g. /tmp on Linux CI) are
      // rejected by the strict tool validation that PATH-discovered tools
      // must pass.
      trusted: true,
    };
    const childEnvAdditions = {
      ZYLOS_TEST_TARBALL: tarball,
      ZYLOS_TEST_CALLS: calls,
    };

    const beforeComponents = fs.readFileSync(componentsPath, 'utf8');
    const beforeSkill = fs.readFileSync(path.join(skillDir, 'src', 'bot.js'), 'utf8');
    const child = runWithInjectedRuntime([
      '--dry-run',
      '--repo', 'HeXiaobo/zylos-hxa-connect',
      '--sha', SHA,
      '--version', '1.7.5',
      '--agent', 'ss',
      '--profile-id', 'profile-ss',
      '--hostname', HOSTNAME,
      '--release-id', 'ZYL-TEST-001',
      '--report-root', reportRoot,
    ], {
      cwd: fixtureRoot,
      env: {
        ...process.env,
        ZYLOS_DIR: zylosDir,
      },
      tools,
      childEnvAdditions,
    });

    assert.equal(child.status, 0, `stdout:\n${child.stdout}\nstderr:\n${child.stderr}`);
    const output = JSON.parse(child.stdout);
    assert.equal(output.schema, 'zylos.hxa-upgrade-preflight/v1');
    assert.equal(output.status, 'PASS');
    assert.equal(output.mode, 'dry-run');
    assert.equal(output.result, 'PRECHECK_ONLY');
    assert.equal(output.releaseId, 'ZYL-TEST-001');
    assert.match(output.executionId, /^[0-9a-f-]{36}$/);
    assert.deepEqual(output.target, {
      component: 'hxa-connect',
      repo: 'HeXiaobo/zylos-hxa-connect',
      sha: SHA,
      version: '1.7.5',
      agent: 'ss',
      profileId: 'profile-ss',
      hostname: HOSTNAME,
    });
    assert.equal(output.checks.identity.status, 'PASS');
    assert.match(output.checks.identity.observedAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.match(output.checks.identity.receiptSha256, /^[0-9a-f]{64}$/);
    assert.equal(fs.existsSync(output.checks.identity.receiptPath), true);
    assert.equal(fs.lstatSync(output.checks.identity.receiptPath).mode & 0o077, 0);
    assert.equal(output.checks.source.status, 'PASS');
    assert.equal(output.checks.package.status, 'PASS');
    assert.equal(output.checks.locks.status, 'PASS');
    assert.equal(output.checks.transactions.status, 'PASS');
    assert.equal(output.checks.pm2.status, 'PASS');
    assert.equal(output.checks.disk.status, 'PASS');
    assert.equal(output.checks.stagingCapacity.status, 'PASS');
    assert.equal(output.checks.stagingCapacity.requiredInodes > 100000, true);
    assert.equal(output.checks.diskAfterStaging.status, 'PASS');
    assert.equal(output.checks.cleanup.status, 'PASS');
    assert.equal(fs.readdirSync(reportRoot).some((name) => name.startsWith('.staging-')), false);
    assert.equal(output.runtimeMutation, 'none');
    assert.equal(fs.readFileSync(componentsPath, 'utf8'), beforeComponents);
    assert.equal(fs.readFileSync(path.join(skillDir, 'src', 'bot.js'), 'utf8'), beforeSkill);
    assert.equal(fs.existsSync(path.join(zylosDir, '.zylos', 'locks')), false);
    assert.doesNotMatch(fs.readFileSync(calls, 'utf8'), /pm2 (delete|start|restart|save)/);
    assert.doesNotMatch(fs.readFileSync(calls, 'utf8'), /profile-cli/);
    assert.equal(fs.existsSync(path.join(reportRoot, 'summary.json')), true);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(reportRoot, 'summary.json'), 'utf8')), output);

    const singleOrgConfig = JSON.parse(fs.readFileSync(hxaConfigPath, 'utf8'));
    const multiOrgConfig = structuredClone(singleOrgConfig);
    multiOrgConfig.orgs.secondary = {
      enabled: true,
      org_id: 'org-secondary',
      agent_id: 'profile-secondary',
      agent_name: 'ss-secondary',
      agent_token: 'redacted-secondary-token',
      access: { dmPolicy: 'open', groupPolicy: 'open', threads: {} },
    };
    fs.writeFileSync(hxaConfigPath, JSON.stringify(multiOrgConfig));
    const ambiguousOrg = runWithInjectedRuntime([
      '--dry-run',
      '--repo', 'HeXiaobo/zylos-hxa-connect',
      '--sha', SHA,
      '--version', '1.7.5',
      '--agent', 'ss',
      '--profile-id', 'profile-ss',
      '--hostname', HOSTNAME,
      '--release-id', 'ZYL-TEST-MULTI-ORG-HOLD',
      '--report-root', path.join(zylosDir, '.zylos', 'upgrade-reports', 'ZYL-TEST-MULTI-ORG-HOLD'),
    ], {
      cwd: fixtureRoot,
      env: { ...process.env, ZYLOS_DIR: zylosDir },
      tools,
      childEnvAdditions,
    });
    assert.notEqual(ambiguousOrg.status, 0);
    assert.equal(JSON.parse(ambiguousOrg.stdout).code, 'IDENTITY_UNVERIFIED');

    const explicitOrg = runWithInjectedRuntime([
      '--dry-run',
      '--repo', 'HeXiaobo/zylos-hxa-connect',
      '--sha', SHA,
      '--version', '1.7.5',
      '--agent', 'ss',
      '--org', 'default',
      '--profile-id', 'profile-ss',
      '--hostname', HOSTNAME,
      '--release-id', 'ZYL-TEST-MULTI-ORG-PASS',
      '--report-root', path.join(zylosDir, '.zylos', 'upgrade-reports', 'ZYL-TEST-MULTI-ORG-PASS'),
    ], {
      cwd: fixtureRoot,
      env: { ...process.env, ZYLOS_DIR: zylosDir },
      tools,
      childEnvAdditions,
    });
    assert.equal(explicitOrg.status, 0, `stdout:\n${explicitOrg.stdout}\nstderr:\n${explicitOrg.stderr}`);
    assert.equal(JSON.parse(explicitOrg.stdout).target.org, 'default');
    fs.writeFileSync(hxaConfigPath, JSON.stringify(singleOrgConfig));

    const markerPath = path.join(skillDir, '.zylos-source.json');
    const externalMarker = path.join(fixtureRoot, 'external-marker.json');
    fs.writeFileSync(externalMarker, JSON.stringify({ secret: 'must-not-enter-report' }));
    fs.symlinkSync(externalMarker, markerPath);
    const unsafeMarkerReportRoot = path.join(zylosDir, '.zylos', 'upgrade-reports', 'ZYL-TEST-MARKER');
    const unsafeMarker = runWithInjectedRuntime([
      '--dry-run',
      '--repo', 'HeXiaobo/zylos-hxa-connect',
      '--sha', SHA,
      '--version', '1.7.5',
      '--agent', 'ss',
      '--profile-id', 'profile-ss',
      '--hostname', HOSTNAME,
      '--release-id', 'ZYL-TEST-MARKER',
      '--report-root', unsafeMarkerReportRoot,
    ], {
      cwd: fixtureRoot,
      env: { ...process.env, ZYLOS_DIR: zylosDir },
      tools,
      childEnvAdditions,
    });
    assert.notEqual(unsafeMarker.status, 0);
    assert.equal(JSON.parse(unsafeMarker.stdout).code, 'TARGET_INVALID');
    assert.doesNotMatch(unsafeMarker.stdout, /must-not-enter-report/);
    fs.unlinkSync(markerPath);

    const mismatchReportRoot = path.join(zylosDir, '.zylos', 'upgrade-reports', 'ZYL-TEST-MISMATCH');
    const mismatch = runWithInjectedRuntime([
      '--dry-run',
      '--repo', 'HeXiaobo/zylos-hxa-connect',
      '--sha', SHA,
      '--version', '1.7.5',
      '--agent', 'ss',
      '--profile-id', 'profile-ss',
      '--hostname', HOSTNAME,
      '--release-id', 'ZYL-TEST-MISMATCH',
      '--report-root', mismatchReportRoot,
    ], {
      cwd: fixtureRoot,
      env: {
        ...process.env,
        ZYLOS_DIR: zylosDir,
      },
      tools,
      childEnvAdditions: { ...childEnvAdditions, ZYLOS_TEST_PROFILE_ID: 'different-profile' },
    });
    assert.notEqual(mismatch.status, 0);
    assert.equal(JSON.parse(mismatch.stdout).code, 'IDENTITY_MISMATCH');

    const legacyConfig = `${JSON.stringify({
      org_id: 'org-test',
      agent_id: 'profile-ss',
      agent_name: 'ss',
      agent_token: 'redacted-test-token',
    })}\n`;
    fs.writeFileSync(hxaConfigPath, legacyConfig);
    const legacyReportRoot = path.join(zylosDir, '.zylos', 'upgrade-reports', 'ZYL-TEST-LEGACY');
    const legacy = runWithInjectedRuntime([
      '--dry-run',
      '--repo', 'HeXiaobo/zylos-hxa-connect',
      '--sha', SHA,
      '--version', '1.7.5',
      '--agent', 'ss',
      '--profile-id', 'profile-ss',
      '--hostname', HOSTNAME,
      '--release-id', 'ZYL-TEST-LEGACY',
      '--report-root', legacyReportRoot,
    ], {
      cwd: fixtureRoot,
      env: {
        ...process.env,
        ZYLOS_DIR: zylosDir,
      },
      tools,
      childEnvAdditions,
    });
    assert.notEqual(legacy.status, 0);
    assert.equal(JSON.parse(legacy.stdout).code, 'CONFIG_MIGRATION_REQUIRED');
    assert.equal(fs.readFileSync(hxaConfigPath, 'utf8'), legacyConfig);
    assert.doesNotMatch(fs.readFileSync(calls, 'utf8'), /profile-cli/);
    void executionId;
  } finally {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test('HXA wrapper rejects mutable or malformed release bindings before touching the runtime', () => {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-hxa-upgrade-invalid-'));
  const reportRoot = path.join(fixtureRoot, 'report');
  const baseArgs = [
    '--dry-run',
    '--repo', 'HeXiaobo/zylos-hxa-connect',
    '--sha', SHA,
    '--version', '1.7.5',
    '--agent', 'ss',
    '--profile-id', 'profile-ss',
    '--hostname', HOSTNAME,
    '--release-id', 'ZYL-TEST-INVALID',
    '--report-root', reportRoot,
  ];

  try {
    for (const [flag, value, code] of [
      ['--sha', 'main', 'INVALID_ARGS'],
      ['--repo', 'https://github.com/HeXiaobo/zylos-hxa-connect', 'INVALID_ARGS'],
      ['--repo', 'attacker/zylos-hxa-connect', 'INVALID_ARGS'],
      ['--version', 'latest', 'INVALID_ARGS'],
    ]) {
      const args = [...baseArgs];
      args[args.indexOf(flag) + 1] = value;
      const child = spawnSync(process.execPath, [SCRIPT, ...args], {
        cwd: fixtureRoot,
        env: { ...process.env, ZYLOS_DIR: path.join(fixtureRoot, 'zylos-home') },
        encoding: 'utf8',
        timeout: 30000,
      });
      assert.notEqual(child.status, 0, `${flag} ${value} unexpectedly succeeded`);
      const output = JSON.parse(child.stdout);
      assert.equal(output.status, 'HOLD');
      assert.equal(output.code, code);
      assert.equal(output.runtimeMutation, 'none');
    }
    assert.equal(fs.existsSync(path.join(fixtureRoot, 'zylos-home')), false);
  } finally {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test('execute mode acquires no transaction when another component lock is present', () => {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-hxa-upgrade-concurrent-'));
  const zylosDir = path.join(fixtureRoot, 'zylos-home');
  const configDir = path.join(zylosDir, '.zylos');
  const locksDir = path.join(configDir, 'locks');
  const reportRoot = path.join(configDir, 'upgrade-reports', 'ZYL-TEST-CONCURRENT');
  const args = [
    '--execute',
    '--repo', 'HeXiaobo/zylos-hxa-connect',
    '--sha', SHA,
    '--version', '1.7.5',
    '--agent', 'ss',
    '--profile-id', 'profile-ss',
    '--hostname', HOSTNAME,
    '--release-id', 'ZYL-TEST-CONCURRENT',
    '--report-root', reportRoot,
  ];

  try {
    fs.mkdirSync(locksDir, { recursive: true, mode: 0o700 });
    fs.chmodSync(configDir, 0o700);
    fs.writeFileSync(path.join(locksDir, 'other-component.lock'), JSON.stringify({
      pid: process.pid,
      timestamp: Date.now(),
      component: 'other-component',
    }));
    const child = runWithInjectedRuntime(args, {
      cwd: fixtureRoot,
      env: { ...process.env, ZYLOS_DIR: zylosDir },
      tools: {
        pm2: '/usr/bin/true',
        curl: '/usr/bin/true',
        ps: '/usr/bin/true',
        tar: '/usr/bin/tar',
      },
      childEnvAdditions: {},
    });

    assert.notEqual(child.status, 0);
    const output = JSON.parse(child.stdout);
    assert.equal(output.status, 'HOLD');
    assert.equal(output.code, 'CONCURRENT_UPGRADE');
    assert.equal(output.runtimeMutation, 'none');
    assert.equal(output.checks.transaction, undefined);
    assert.deepEqual(fs.readdirSync(locksDir), ['other-component.lock']);
    assert.equal(fs.existsSync(path.join(zylosDir, '.claude')), false);
  } finally {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test('HXA wrapper creates only a new private direct-child report directory', () => {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-hxa-upgrade-report-root-'));
  const zylosDir = path.join(fixtureRoot, 'zylos-home');
  const configDir = path.join(zylosDir, '.zylos');
  const reportBase = path.join(configDir, 'upgrade-reports');
  const baseArgs = [
    '--dry-run',
    '--repo', 'HeXiaobo/zylos-hxa-connect',
    '--sha', SHA,
    '--version', '1.7.5',
    '--agent', 'ss',
    '--profile-id', 'profile-ss',
    '--hostname', HOSTNAME,
    '--release-id', 'ZYL-TEST-REPORT',
    '--report-root', path.join(reportBase, 'placeholder'),
  ];
  const invoke = (reportRoot) => {
    const args = [...baseArgs];
    args[args.indexOf('--report-root') + 1] = reportRoot;
    return spawnSync(process.execPath, [SCRIPT, ...args], {
      cwd: fixtureRoot,
      env: { ...process.env, ZYLOS_DIR: zylosDir },
      encoding: 'utf8',
      timeout: 30000,
    });
  };

  try {
    fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
    fs.chmodSync(configDir, 0o700);
    const nested = path.join(reportBase, 'nested', 'run');
    const nestedResult = invoke(nested);
    assert.notEqual(nestedResult.status, 0);
    assert.equal(JSON.parse(nestedResult.stdout).code, 'REPORT_FAILED');
    assert.equal(fs.existsSync(nested), false);

    fs.mkdirSync(reportBase, { mode: 0o700 });
    const existing = path.join(reportBase, 'existing');
    fs.mkdirSync(existing, { mode: 0o700 });
    const existingResult = invoke(existing);
    assert.notEqual(existingResult.status, 0);
    assert.equal(JSON.parse(existingResult.stdout).code, 'REPORT_EXISTS');
  } finally {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test('execute mode applies one immutable HXA transaction and records provenance', () => {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-hxa-upgrade-execute-'));
  const zylosDir = path.join(fixtureRoot, 'zylos-home');
  const reportRoot = path.join(zylosDir, '.zylos', 'upgrade-reports', 'ZYL-TEST-EXECUTE');
  const fakeBin = path.join(fixtureRoot, 'bin');
  const archiveRoot = path.join(fixtureRoot, 'hxa-source');
  const tarball = path.join(fixtureRoot, 'hxa-source.tar.gz');
  const calls = path.join(fixtureRoot, 'calls.log');
  const profileSequenceFile = path.join(fixtureRoot, 'profile-sequence');
  const skillDir = path.join(zylosDir, '.claude', 'skills', 'hxa-connect');
  const componentsPath = path.join(zylosDir, '.zylos', 'components.json');
  const hxaConfigPath = path.join(zylosDir, 'components', 'hxa-connect', 'config.json');

  try {
    writeSkill(skillDir, { version: '1.7.3', payload: 'old' });
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), `---
name: hxa-connect
version: 1.7.3
lifecycle:
  service:
    name: zylos-hxa-connect
---
`, 'utf8');
    fs.mkdirSync(path.join(skillDir, 'scripts'), { recursive: true });
    fs.writeFileSync(
      path.join(skillDir, 'src', 'env.js'),
      "export async function setupFetchProxy() {}\n",
      'utf8',
    );
    const sdkDir = path.join(skillDir, 'node_modules', '@coco-xyz', 'hxa-connect-sdk');
    fs.mkdirSync(path.join(sdkDir, 'dist'), { recursive: true });
    fs.writeFileSync(path.join(sdkDir, 'package.json'), JSON.stringify({
      name: '@coco-xyz/hxa-connect-sdk',
      version: '0.0.0-test',
      type: 'module',
      exports: { '.': { import: './dist/index.js' } },
    }));
    fs.writeFileSync(path.join(sdkDir, 'dist', 'index.js'), [
      "import fs from 'node:fs';",
      'export class HxaConnectClient {',
      "  async getProfile() { const sequence = (process.env.ZYLOS_TEST_PROFILE_SEQUENCE || '').split(',').filter(Boolean); let index = 0; const sequenceFile = process.env.ZYLOS_TEST_PROFILE_SEQUENCE_FILE; if (sequenceFile && fs.existsSync(sequenceFile)) index = Number(fs.readFileSync(sequenceFile, 'utf8') || 0); const id = sequence[index] || 'profile-ss'; if (sequenceFile) fs.writeFileSync(sequenceFile, String(index + 1)); return { name: 'ss', id, org_id: 'org-test' }; }",
      '}',
      '',
    ].join('\n'));
    fs.mkdirSync(path.dirname(componentsPath), { recursive: true });
    fs.chmodSync(path.dirname(componentsPath), 0o700);
    fs.writeFileSync(componentsPath, JSON.stringify({
      'hxa-connect': {
        version: '1.7.3',
        repo: 'coco-xyz/zylos-hxa-connect',
        skillDir,
      },
    }, null, 2));
    fs.mkdirSync(path.dirname(hxaConfigPath), { recursive: true });
    fs.writeFileSync(hxaConfigPath, JSON.stringify({
      default_hub_url: 'https://hub.invalid.test',
      orgs: {
        default: {
          enabled: true,
          org_id: 'org-test',
          agent_id: 'profile-ss',
          agent_name: 'ss',
          agent_token: 'redacted-test-token',
          access: { dmPolicy: 'open', groupPolicy: 'open', threads: {} },
        },
      },
    }));

    writeSkill(archiveRoot, { version: '1.7.5', payload: 'new' });
    fs.writeFileSync(path.join(archiveRoot, 'src', 'env.js'), "export async function setupFetchProxy() {}\n", 'utf8');
    fs.writeFileSync(path.join(archiveRoot, 'SKILL.md'), `---
name: hxa-connect
version: 1.7.5
lifecycle:
  service:
    name: zylos-hxa-connect
  hooks:
    pre-upgrade: hooks/pre-upgrade.js
    post-upgrade: hooks/post-upgrade.js
---
`, 'utf8');
    fs.mkdirSync(path.join(archiveRoot, 'hooks'), { recursive: true });
    fs.writeFileSync(path.join(archiveRoot, 'hooks', 'pre-upgrade.js'), [
      "import fs from 'node:fs';",
      "import path from 'node:path';",
      "if (process.env.ZYLOS_TEST_MUTATE_CANDIDATE) fs.writeFileSync(path.join(process.cwd(), 'src', 'bot.js'), 'tampered-by-hook\\n');",
      'process.exit(0);',
      '',
    ].join('\n'), 'utf8');
    fs.writeFileSync(path.join(archiveRoot, 'hooks', 'post-upgrade.js'), 'process.exit(0);\n', 'utf8');
    execFileSync('tar', ['czf', tarball, '-C', fixtureRoot, path.basename(archiveRoot)]);

    fs.mkdirSync(fakeBin, { recursive: true });
    fs.writeFileSync(path.join(fakeBin, 'pm2'), [
      '#!/usr/bin/env node',
      "import fs from 'node:fs';",
      `fs.appendFileSync(${JSON.stringify(calls)}, 'pm2 ' + process.argv.slice(2).join(' ') + '\\n');`,
      "if (process.argv[2] === 'jlist') {",
      "  if (process.env.ZYLOS_TEST_BREAK_SUMMARY && !fs.existsSync(process.env.ZYLOS_TEST_BREAK_MARKER)) { fs.writeFileSync(process.env.ZYLOS_TEST_BREAK_MARKER, '1'); fs.rmSync(process.env.ZYLOS_TEST_SUMMARY_PATH, { force: true }); fs.mkdirSync(process.env.ZYLOS_TEST_SUMMARY_PATH); }",
      `  process.stdout.write(${JSON.stringify(`${JSON.stringify([{ name: 'zylos-hxa-connect', pid: 1, pm2_env: { status: 'online', pm_exec_path: path.join(skillDir, 'src', 'bot.js'), restart_time: 0, unstable_restarts: 0 } }])}\n`)});`,
      '}',
    ].join('\n'), { mode: 0o755 });
    fs.writeFileSync(path.join(fakeBin, 'npm'), '#!/bin/sh\nprintf "npm %s\\n" "$*" >> "$ZYLOS_TEST_CALLS"\nexit 0\n', { mode: 0o755 });
    fs.writeFileSync(path.join(fakeBin, 'curl'), [
      '#!/bin/sh',
      `printf 'curl %s\n' "$*" >> "${calls}"`,
      'while [ "$#" -gt 0 ]; do',
      '  if [ "$1" = "-o" ]; then cp "$ZYLOS_TEST_TARBALL" "$2"; exit 0; fi',
      '  shift',
      'done',
      'exit 1',
    ].join('\n'), { mode: 0o755 });
    fs.writeFileSync(path.join(fakeBin, 'ps'), '#!/bin/sh\nif [ "$1" = "-o" ]; then printf "Mon Jan 1 00:00:00 2024\\n"; fi\nexit 0\n', { mode: 0o755 });

    const tools = {
      pm2: path.join(fakeBin, 'pm2'),
      // Execute mode runs an npm install inside the transaction; without an
      // injected npm the script lazily resolves one from PATH through the
      // strict validator, which rejects the hosted runner's toolcache.
      npm: path.join(fakeBin, 'npm'),
      curl: path.join(fakeBin, 'curl'),
      ps: path.join(fakeBin, 'ps'),
      tar: '/usr/bin/tar',
      // Explicitly trusted injection: the fixtures live under the system
      // tempdir, whose world-writable ancestors (e.g. /tmp on Linux CI) are
      // rejected by the strict tool validation that PATH-discovered tools
      // must pass.
      trusted: true,
    };
    fs.writeFileSync(path.join(fakeBin, 'npm'), '#!/bin/sh\nprintf "npm %s\\n" "$*" >> "$ZYLOS_TEST_CALLS"\nexit 0\n', { mode: 0o755 });
    const childEnvAdditions = {
      PATH: `${fakeBin}${path.delimiter}${process.env.PATH}`,
      ZYLOS_TEST_TARBALL: tarball,
      ZYLOS_TEST_CALLS: calls,
    };
    const child = runWithInjectedRuntime([
      '--execute',
      '--repo', 'HeXiaobo/zylos-hxa-connect',
      '--sha', SHA,
      '--version', '1.7.5',
      '--agent', 'ss',
      '--profile-id', 'profile-ss',
      '--hostname', HOSTNAME,
      '--release-id', 'ZYL-TEST-EXECUTE',
      '--report-root', reportRoot,
    ], {
      cwd: fixtureRoot,
      env: {
        ...process.env,
        ZYLOS_DIR: zylosDir,
        PATH: childEnvAdditions.PATH,
        ZYLOS_TEST_CALLS: calls,
        ZYLOS_TEST_TARBALL: tarball,
      },
      tools,
      childEnvAdditions,
    });

    assert.equal(child.status, 0, `stdout:\n${child.stdout}\nstderr:\n${child.stderr}`);
    const output = JSON.parse(child.stdout);
    assert.equal(output.status, 'PASS');
    assert.equal(output.mode, 'execute');
    assert.equal(output.result, 'EXECUTE_COMPLETE');
    assert.match(output.executionId, /^[0-9a-f-]{36}$/);
    assert.equal(output.runtimeMutation, 'component-only');
    assert.equal(output.checks.transaction.status, 'PASS');
    assert.equal(output.checks.transaction.result.success, true);
    assert.equal(output.checks.source.hooks.status, 'PASS');
    assert.deepEqual(output.checks.source.hooks.entries.map((hook) => hook.name), ['pre-upgrade', 'post-upgrade']);
    assert.equal(output.checks.exactSource.status, 'PASS');
    assert.equal(output.checks.transaction.result.postUpgradeCheck.exactSource.status, 'PASS');
    assert.equal(output.checks.backup.status, 'PASS');
    assert.equal(output.checks.postcheck.status, 'PASS');
    assert.equal(output.checks.provenance.source.repo, 'HeXiaobo/zylos-hxa-connect');
    assert.equal(output.checks.provenance.source.sha, SHA);
    assert.equal(output.checks.provenance.source.ref, SHA);
    assert.equal(output.checks.provenance.source.refType, 'commit');
    assert.equal(output.checks.provenance.source.version, '1.7.5');
    assert.equal(JSON.parse(fs.readFileSync(componentsPath, 'utf8'))['hxa-connect'].version, '1.7.5');
    assert.equal(JSON.parse(fs.readFileSync(componentsPath, 'utf8'))['hxa-connect'].repo, 'HeXiaobo/zylos-hxa-connect');
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(skillDir, '.zylos-source.json'), 'utf8')), output.checks.provenance.source);
    assert.match(output.checks.provenance.source.upgradedAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(fs.readFileSync(path.join(skillDir, 'src', 'bot.js'), 'utf8'), 'new\n');
    const callLog = fs.readFileSync(calls, 'utf8');
    assert.match(callLog, /pm2 stop zylos-hxa-connect/);
    assert.match(callLog, /pm2 (?:start .*--only zylos-hxa-connect|restart zylos-hxa-connect)/);
    assert.match(callLog, /pm2 save/);
    assert.match(callLog, /npm install/);

    const terminalReportRoot = path.join(zylosDir, '.zylos', 'upgrade-reports', 'ZYL-TEST-TERMINAL-SUMMARY');
    const terminalSummaryPath = path.join(terminalReportRoot, 'summary.json');
    const terminalBreakMarker = path.join(fixtureRoot, 'terminal-summary-broken');
    const terminalSummaryChild = runWithInjectedRuntime([
      '--dry-run',
      '--repo', 'HeXiaobo/zylos-hxa-connect',
      '--sha', SHA,
      '--version', '1.7.5',
      '--agent', 'ss',
      '--profile-id', 'profile-ss',
      '--hostname', HOSTNAME,
      '--release-id', 'ZYL-TEST-TERMINAL-SUMMARY',
      '--report-root', terminalReportRoot,
    ], {
      cwd: fixtureRoot,
      env: {
        ...process.env,
        ZYLOS_DIR: zylosDir,
        PATH: childEnvAdditions.PATH,
        ZYLOS_TEST_CALLS: calls,
        ZYLOS_TEST_TARBALL: tarball,
        ZYLOS_TEST_BREAK_SUMMARY: '1',
        ZYLOS_TEST_BREAK_MARKER: terminalBreakMarker,
        ZYLOS_TEST_SUMMARY_PATH: terminalSummaryPath,
      },
      tools,
      childEnvAdditions: {
        ...childEnvAdditions,
        ZYLOS_TEST_BREAK_SUMMARY: '1',
        ZYLOS_TEST_BREAK_MARKER: terminalBreakMarker,
        ZYLOS_TEST_SUMMARY_PATH: terminalSummaryPath,
      },
    });
    assert.notEqual(terminalSummaryChild.status, 0, `stdout:\n${terminalSummaryChild.stdout}\nstderr:\n${terminalSummaryChild.stderr}`);
    const terminalSummaryOutput = JSON.parse(terminalSummaryChild.stdout);
    assert.equal(terminalSummaryOutput.status, 'HOLD');
    assert.equal(terminalSummaryOutput.result, 'HOLD');
    assert.equal(terminalSummaryOutput.code, 'SUMMARY_WRITE_FAILED');
    assert.equal(terminalSummaryOutput.checks.terminalSummary.status, 'FALLBACK');
    const terminalFallbackPath = path.join(
      terminalReportRoot,
      `terminal-summary-${terminalSummaryOutput.executionId}.json`,
    );
    assert.equal(fs.existsSync(terminalFallbackPath), true);
    const terminalFallback = JSON.parse(fs.readFileSync(terminalFallbackPath, 'utf8'));
    assert.equal(terminalFallback.status, 'HOLD');
    assert.notEqual(terminalFallback.checks.transaction?.status, 'RUNNING');

    const candidateMutationReportRoot = path.join(zylosDir, '.zylos', 'upgrade-reports', 'ZYL-TEST-CANDIDATE-MUTATION');
    const candidateMutation = runWithInjectedRuntime([
      '--execute',
      '--repo', 'HeXiaobo/zylos-hxa-connect',
      '--sha', SHA,
      '--version', '1.7.5',
      '--agent', 'ss',
      '--profile-id', 'profile-ss',
      '--hostname', HOSTNAME,
      '--release-id', 'ZYL-TEST-CANDIDATE-MUTATION',
      '--report-root', candidateMutationReportRoot,
    ], {
      cwd: fixtureRoot,
      env: {
        ...process.env,
        ZYLOS_DIR: zylosDir,
        PATH: childEnvAdditions.PATH,
        ZYLOS_TEST_CALLS: calls,
        ZYLOS_TEST_TARBALL: tarball,
        ZYLOS_TEST_MUTATE_CANDIDATE: '1',
      },
      tools,
      childEnvAdditions,
    });
    assert.notEqual(candidateMutation.status, 0);
    const candidateMutationOutput = JSON.parse(candidateMutation.stdout);
    assert.equal(candidateMutationOutput.status, 'HOLD');
    assert.equal(candidateMutationOutput.code, 'UPGRADE_FAILED');
    assert.equal(candidateMutationOutput.checks.sourceSnapshot.status, 'PASS');
    assert.equal(candidateMutationOutput.checks.transaction.result.failedStep, 10);
    assert.match(candidateMutationOutput.checks.transaction.result.error, /exact candidate/i);
    assert.equal(candidateMutationOutput.checks.rollback.status, 'PASS');
    assert.equal(fs.readFileSync(path.join(skillDir, 'src', 'bot.js'), 'utf8'), 'new\n');

    const raceReportRoot = path.join(zylosDir, '.zylos', 'upgrade-reports', 'ZYL-TEST-IDENTITY-RACE');
    const race = runWithInjectedRuntime([
      '--execute',
      '--repo', 'HeXiaobo/zylos-hxa-connect',
      '--sha', SHA,
      '--version', '1.7.5',
      '--agent', 'ss',
      '--profile-id', 'profile-ss',
      '--hostname', HOSTNAME,
      '--release-id', 'ZYL-TEST-IDENTITY-RACE',
      '--report-root', raceReportRoot,
    ], {
      cwd: fixtureRoot,
      env: {
        ...process.env,
        ZYLOS_DIR: zylosDir,
        PATH: childEnvAdditions.PATH,
        ZYLOS_TEST_CALLS: calls,
        ZYLOS_TEST_TARBALL: tarball,
        ZYLOS_TEST_PROFILE_SEQUENCE: 'profile-ss,different-profile',
        ZYLOS_TEST_PROFILE_SEQUENCE_FILE: profileSequenceFile,
      },
      tools,
      childEnvAdditions: {
        ...childEnvAdditions,
        ZYLOS_TEST_PROFILE_SEQUENCE: 'profile-ss,different-profile',
        ZYLOS_TEST_PROFILE_SEQUENCE_FILE: profileSequenceFile,
      },
    });
    assert.notEqual(race.status, 0);
    const raceOutput = JSON.parse(race.stdout);
    assert.equal(raceOutput.status, 'HOLD');
    assert.equal(raceOutput.code, 'IDENTITY_MISMATCH');
    assert.equal(raceOutput.checks.transaction.status, 'HOLD');
    assert.equal(raceOutput.checks.lockRelease.status, 'PASS');
    assert.equal(fs.readFileSync(path.join(skillDir, 'src', 'bot.js'), 'utf8'), 'new\n');

    const nestedLink = path.join(skillDir, 'src', 'nested-link.js');
    fs.writeFileSync(path.join(fixtureRoot, 'outside-target.js'), 'outside\n', 'utf8');
    fs.symlinkSync(path.join(fixtureRoot, 'outside-target.js'), nestedLink);
    const symlinkReportRoot = path.join(zylosDir, '.zylos', 'upgrade-reports', 'ZYL-TEST-NESTED-SYMLINK');
    const symlinkChild = runWithInjectedRuntime([
      '--execute',
      '--repo', 'HeXiaobo/zylos-hxa-connect',
      '--sha', SHA,
      '--version', '1.7.5',
      '--agent', 'ss',
      '--profile-id', 'profile-ss',
      '--hostname', HOSTNAME,
      '--release-id', 'ZYL-TEST-NESTED-SYMLINK',
      '--report-root', symlinkReportRoot,
    ], {
      cwd: fixtureRoot,
      env: {
        ...process.env,
        ZYLOS_DIR: zylosDir,
        PATH: childEnvAdditions.PATH,
        ZYLOS_TEST_CALLS: calls,
        ZYLOS_TEST_TARBALL: tarball,
      },
      tools,
      childEnvAdditions,
    });
    assert.notEqual(symlinkChild.status, 0);
    const symlinkOutput = JSON.parse(symlinkChild.stdout);
    assert.equal(symlinkOutput.code, 'EXACT_SOURCE_UNVERIFIED');
    assert.equal(symlinkOutput.checks.lockRelease.status, 'PASS');
    fs.rmSync(nestedLink, { force: true });

    const extraFile = path.join(skillDir, 'src', 'untracked-extra.js');
    fs.writeFileSync(extraFile, 'untracked\n', 'utf8');
    const extraReportRoot = path.join(zylosDir, '.zylos', 'upgrade-reports', 'ZYL-TEST-EXTRA-SOURCE');
    const extraChild = runWithInjectedRuntime([
      '--execute',
      '--repo', 'HeXiaobo/zylos-hxa-connect',
      '--sha', SHA,
      '--version', '1.7.5',
      '--agent', 'ss',
      '--profile-id', 'profile-ss',
      '--hostname', HOSTNAME,
      '--release-id', 'ZYL-TEST-EXTRA-SOURCE',
      '--report-root', extraReportRoot,
    ], {
      cwd: fixtureRoot,
      env: {
        ...process.env,
        ZYLOS_DIR: zylosDir,
        PATH: childEnvAdditions.PATH,
        ZYLOS_TEST_CALLS: calls,
        ZYLOS_TEST_TARBALL: tarball,
      },
      tools,
      childEnvAdditions,
    });
    assert.notEqual(extraChild.status, 0);
    const extraOutput = JSON.parse(extraChild.stdout);
    assert.equal(extraOutput.code, 'UPGRADE_FAILED');
    assert.equal(extraOutput.checks.transaction.result.failedStep, 10);
    assert.equal(extraOutput.checks.rollback.status, 'PASS');
    assert.equal(fs.readFileSync(extraFile, 'utf8'), 'untracked\n');
    fs.rmSync(extraFile, { force: true });
  } finally {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test('execute failure returns terminal rollback evidence and releases its lock', () => {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-hxa-upgrade-rollback-'));
  const zylosDir = path.join(fixtureRoot, 'zylos-home');
  const reportRoot = path.join(zylosDir, '.zylos', 'upgrade-reports', 'ZYL-TEST-ROLLBACK');
  const fakeBin = path.join(fixtureRoot, 'bin');
  const archiveRoot = path.join(fixtureRoot, 'hxa-source');
  const tarball = path.join(fixtureRoot, 'hxa-source.tar.gz');
  const calls = path.join(fixtureRoot, 'calls.log');
  const npmCount = path.join(fixtureRoot, 'npm.count');
  const skillDir = path.join(zylosDir, '.claude', 'skills', 'hxa-connect');
  const componentsPath = path.join(zylosDir, '.zylos', 'components.json');
  const hxaConfigPath = path.join(zylosDir, 'components', 'hxa-connect', 'config.json');

  try {
    writeSkill(skillDir, { version: '1.7.3', payload: 'old' });
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), `---
name: hxa-connect
version: 1.7.3
lifecycle:
  service:
    name: zylos-hxa-connect
---
`, 'utf8');
    fs.writeFileSync(path.join(skillDir, 'src', 'env.js'), 'export async function setupFetchProxy() {}\n', 'utf8');
    const sdkDir = path.join(skillDir, 'node_modules', '@coco-xyz', 'hxa-connect-sdk');
    fs.mkdirSync(path.join(sdkDir, 'dist'), { recursive: true });
    fs.writeFileSync(path.join(sdkDir, 'package.json'), JSON.stringify({
      name: '@coco-xyz/hxa-connect-sdk',
      version: '0.0.0-test',
      type: 'module',
      exports: { '.': { import: './dist/index.js' } },
    }));
    fs.writeFileSync(path.join(sdkDir, 'dist', 'index.js'), [
      'export class HxaConnectClient {',
      "  async getProfile() { return { name: 'ss', id: 'profile-ss', org_id: 'org-test' }; }",
      '}',
      '',
    ].join('\n'));
    fs.mkdirSync(path.dirname(componentsPath), { recursive: true });
    fs.chmodSync(path.dirname(componentsPath), 0o700);
    fs.writeFileSync(componentsPath, JSON.stringify({
      'hxa-connect': {
        version: '1.7.3',
        repo: 'coco-xyz/zylos-hxa-connect',
        skillDir,
      },
    }, null, 2));
    fs.mkdirSync(path.dirname(hxaConfigPath), { recursive: true });
    fs.writeFileSync(hxaConfigPath, JSON.stringify({
      default_hub_url: 'https://hub.invalid.test',
      orgs: {
        default: {
          enabled: true,
          org_id: 'org-test',
          agent_id: 'profile-ss',
          agent_name: 'ss',
          agent_token: 'redacted-test-token',
          access: { dmPolicy: 'open', groupPolicy: 'open', threads: {} },
        },
      },
    }));

    writeSkill(archiveRoot, { version: '1.7.5', payload: 'new' });
    fs.writeFileSync(path.join(archiveRoot, 'SKILL.md'), `---
name: hxa-connect
version: 1.7.5
lifecycle:
  service:
    name: zylos-hxa-connect
---
`, 'utf8');
    execFileSync('tar', ['czf', tarball, '-C', fixtureRoot, path.basename(archiveRoot)]);

    fs.mkdirSync(fakeBin, { recursive: true });
    fs.writeFileSync(path.join(fakeBin, 'pm2'), [
      '#!/usr/bin/env node',
      "import fs from 'node:fs';",
      `fs.appendFileSync(${JSON.stringify(calls)}, 'pm2 ' + process.argv.slice(2).join(' ') + '\\n');`,
      "if (process.argv[2] === 'jlist') {",
      `  process.stdout.write(${JSON.stringify(`${JSON.stringify([{ name: 'zylos-hxa-connect', pid: 1, pm2_env: { status: 'online', pm_exec_path: path.join(skillDir, 'src', 'bot.js'), restart_time: 0, unstable_restarts: 0 } }])}\n`)});`,
      '}',
    ].join('\n'), { mode: 0o755 });
    fs.writeFileSync(path.join(fakeBin, 'npm'), [
      '#!/bin/sh',
      `printf 'npm %s\\n' "$*" >> "${calls}"`,
      `if [ ! -f "${npmCount}" ]; then : > "${npmCount}"; exit 17; fi`,
      'exit 0',
      '',
    ].join('\n'), { mode: 0o755 });
    fs.writeFileSync(path.join(fakeBin, 'curl'), [
      '#!/bin/sh',
      'while [ "$#" -gt 0 ]; do',
      '  if [ "$1" = "-o" ]; then cp "$ZYLOS_TEST_TARBALL" "$2"; exit 0; fi',
      '  shift',
      'done',
      'exit 1',
    ].join('\n'), { mode: 0o755 });
    fs.writeFileSync(path.join(fakeBin, 'ps'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });

    const tools = {
      pm2: path.join(fakeBin, 'pm2'),
      // Execute mode runs an npm install inside the transaction; without an
      // injected npm the script lazily resolves one from PATH through the
      // strict validator, which rejects the hosted runner's toolcache.
      npm: path.join(fakeBin, 'npm'),
      curl: path.join(fakeBin, 'curl'),
      ps: path.join(fakeBin, 'ps'),
      tar: '/usr/bin/tar',
      // Explicitly trusted injection: the fixtures live under the system
      // tempdir, whose world-writable ancestors (e.g. /tmp on Linux CI) are
      // rejected by the strict tool validation that PATH-discovered tools
      // must pass.
      trusted: true,
    };
    const childEnvAdditions = {
      PATH: `${fakeBin}${path.delimiter}${process.env.PATH}`,
      ZYLOS_TEST_TARBALL: tarball,
      ZYLOS_TEST_CALLS: calls,
    };
    const child = runWithInjectedRuntime([
      '--execute',
      '--repo', 'HeXiaobo/zylos-hxa-connect',
      '--sha', SHA,
      '--version', '1.7.5',
      '--agent', 'ss',
      '--profile-id', 'profile-ss',
      '--hostname', HOSTNAME,
      '--release-id', 'ZYL-TEST-ROLLBACK',
      '--report-root', reportRoot,
    ], {
      cwd: fixtureRoot,
      env: {
        ...process.env,
        ZYLOS_DIR: zylosDir,
        PATH: childEnvAdditions.PATH,
        ZYLOS_TEST_TARBALL: tarball,
        ZYLOS_TEST_CALLS: calls,
      },
      tools,
      childEnvAdditions,
    });

    assert.notEqual(child.status, 0, `stdout:\n${child.stdout}`);
    const output = JSON.parse(child.stdout);
    assert.equal(output.status, 'HOLD');
    assert.equal(output.code, 'UPGRADE_FAILED');
    assert.equal(output.runtimeMutation, 'component-only');
    assert.equal(output.checks.transaction.status, 'HOLD');
    assert.equal(output.checks.transaction.result.success, false);
    assert.equal(output.checks.transaction.result.failedStep, 5);
    assert.equal(output.checks.rollback.status, 'PASS');
    assert.equal(output.checks.lockRelease.status, 'PASS');
    assert.equal(JSON.parse(fs.readFileSync(componentsPath, 'utf8'))['hxa-connect'].version, '1.7.3');
    assert.equal(fs.readFileSync(path.join(skillDir, 'src', 'bot.js'), 'utf8'), 'old\n');
    assert.equal(fs.existsSync(path.join(skillDir, '.zylos-source.json')), false);
    assert.deepEqual(fs.readdirSync(path.join(zylosDir, '.zylos', 'locks')), []);
    assert.match(fs.readFileSync(calls, 'utf8'), /pm2 stop zylos-hxa-connect/);
    assert.match(fs.readFileSync(calls, 'utf8'), /pm2 restart/);
  } finally {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});
