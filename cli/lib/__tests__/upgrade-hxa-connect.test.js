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
    fs.mkdirSync(sdkDir, { recursive: true });
    fs.writeFileSync(path.join(sdkDir, 'package.json'), JSON.stringify({
      name: '@coco-xyz/hxa-connect-sdk',
      version: '0.0.0-test',
      type: 'module',
      main: 'index.js',
    }));
    fs.writeFileSync(path.join(sdkDir, 'index.js'), [
      'export class HxaConnectClient {',
      "  async getProfile() { return { name: process.env.ZYLOS_TEST_PROFILE_NAME || 'ss', id: process.env.ZYLOS_TEST_PROFILE_ID || 'profile-ss' }; }",
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
    fs.writeFileSync(path.join(fakeBin, 'ps'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });

    const tools = {
      pm2: path.join(fakeBin, 'pm2'),
      curl: path.join(fakeBin, 'curl'),
      ps: path.join(fakeBin, 'ps'),
      tar: '/usr/bin/tar',
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

test('execute mode is an explicit HOLD until the bound transaction and postcheck exist', () => {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-hxa-upgrade-execute-hold-'));
  const zylosDir = path.join(fixtureRoot, 'zylos-home');
  const reportRoot = path.join(fixtureRoot, 'report');
  try {
    const child = spawnSync(process.execPath, [
      SCRIPT,
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
      env: { ...process.env, ZYLOS_DIR: zylosDir },
      encoding: 'utf8',
      timeout: 30000,
    });
    assert.notEqual(child.status, 0);
    const output = JSON.parse(child.stdout);
    assert.equal(output.status, 'HOLD');
    assert.equal(output.code, 'EXECUTE_UNSUPPORTED');
    assert.equal(output.runtimeMutation, 'none');
    assert.equal(fs.existsSync(zylosDir), false);
    assert.equal(fs.existsSync(path.join(reportRoot, 'summary.json')), false);
  } finally {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});
