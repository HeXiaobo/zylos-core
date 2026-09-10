import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { compareVersions, prepare, describeResolutionFailure } from '../../../tools/upgrade/prepare.mjs';
import { environmentDescriptor, resolveQualifiedRelease } from '../../../tools/upgrade/release-channel.mjs';
import { bundle, distribution, catalog, environment } from './helpers/qualified-release-fixture.js';
const root = path.resolve('.');
test('semantic ordering handles numeric RCs and stable versions', () => {
 assert.equal(compareVersions('0.7.2-rc.28', '0.7.2-rc.9'), 1);
 assert.equal(compareVersions('0.7.2', '0.7.2-rc.28'), 1);
 assert.equal(compareVersions('1.10.0', '1.9.99'), 1);
});
test('cannot overwrite an existing transaction', () => {
 const out = fs.mkdtempSync(path.join(os.tmpdir(), 'upgrade-entry-test-'));
 const marker = path.join(out, 'RUNNING'); fs.writeFileSync(marker, 'keep');
 try {
  assert.throws(() => prepare({ '--only': 'all', '--out': out, '--authorization-ref': 'test' }), /EEXIST/);
  assert.equal(fs.readFileSync(marker, 'utf8'), 'keep');
 } finally { fs.rmSync(out, { recursive: true }); }
});
test('invalid inputs do not create output', () => {
 const root = fs.mkdtempSync(path.join(os.tmpdir(), 'upgrade-entry-input-')); const out = path.join(root, 'new');
 try {
  for (const overrides of [{ '--authorization-ref': '' }, { '--core': 'main' }, { '--channel': 'bad' }]) {
   assert.throws(() => prepare({ '--only': 'all', '--out': out, '--authorization-ref': 'test', ...overrides }));
   assert.equal(fs.existsSync(out), false);
  }
 } finally { fs.rmSync(root, { recursive: true }); }
});

test('a blocked preparation reports the host environment and the published qualification matrix', () => {
 const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-prepare-diag-'));
 const bin = path.join(directory, 'bin'); fs.mkdirSync(bin);
 // The catalog qualifies codex only; this host runs claude.
 const document = distribution({ target: bundle('8.0.0'), env: { ...environment, runtime: 'codex' } });
 const responses = path.join(directory, 'responses.json');
 const fixture = catalog([document]);
 fs.writeFileSync(responses, JSON.stringify({ ...fixture.paths,
  '/repos/HeXiaobo/zylos-core/releases?per_page=100&page=1': JSON.stringify(fixture.releases) }));
 fs.writeFileSync(path.join(bin, 'curl'), `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2), url = args.find(x => /^https:/.test(x)) || '';
const data = JSON.parse(fs.readFileSync(process.env.RESPONSES));
const endpoint = url.replace('https://api.github.com', '');
if (Object.hasOwn(data, endpoint)) { process.stdout.write(data[endpoint]); process.exit(0); }
process.stderr.write('fixture: download unavailable'); process.exit(22);
`, { mode: 0o755 });
 fs.writeFileSync(path.join(bin, 'gh'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
 try {
  const child = spawnSync(process.execPath, [path.join(root, 'tools/upgrade/prepare.mjs'), '--only', 'all',
   '--out', path.join(directory, 'prepared'), '--authorization-ref', 'fixture'], {
   cwd: root, encoding: 'utf8', timeout: 20000,
   env: { ...process.env, PATH: `${bin}:/usr/bin:/bin`, RESPONSES: responses,
    ZYLOS_DIR: path.join(directory, 'runtime'), GH_TOKEN: '', GITHUB_TOKEN: '' } });
  assert.equal(child.status, 1, child.stderr);
  assert.match(child.stderr, /No verified stable release matches core latest/);
  assert.match(child.stderr, /Host environment: .*runtime=claude/);
  assert.match(child.stderr, /bundle-fixture: Host platform\/Node\/runtime is outside the published qualification matrix/);
  assert.match(child.stderr, /qualified for: .*runtime=codex/);
  assert.match(child.stderr, /Next: qualify and publish a release for this host environment/);
 } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
test('resolution failures keep their diagnosis and terminal guidance', () => {
 const error = Object.assign(new Error('No verified stable release matches core latest.'), {
  code: 'NO_QUALIFIED_RELEASE', host: { platform: 'darwin', arch: 'arm64', nodeMajor: 22, runtime: 'claude' },
  environmentFingerprint: 'sha256:ab', skipped: [{ tag: 'bundle-x', reason: 'Host platform/Node/runtime is outside the published qualification matrix',
   environments: [{ platform: 'linux', arch: 'x64', nodeMajor: 22, runtime: 'codex', functionalConfigSha256: 'ab' }] }] });
 const text = describeResolutionFailure(error);
 assert.match(text, /Host environment: platform=darwin arch=arm64 nodeMajor=22 runtime=claude/);
 for (const expected of ['bundle-x: Host platform/Node/runtime is outside the published qualification matrix',
  'qualified for: platform=linux arch=x64 nodeMajor=22 runtime=codex', 'Next: qualify and publish a release for this host environment']) {
  assert.ok(text.includes(expected), expected);
 }
 assert.equal(describeResolutionFailure(new Error('plain failure')), 'plain failure');
});

test('an uncovered host environment needs the explicit newest-qualified policy and is never reported as verified', () => {
 const document = distribution({ target: bundle('8.0.0') });
 const fixture = catalog([document]);
 // The catalog qualifies the fixture environment; this host differs in runtime only.
 const uncovered = { ...environment, runtime: environment.runtime === 'claude' ? 'codex' : 'claude' };
 let blocked;
 try { resolveQualifiedRelease({ component: 'core', host: uncovered, request: fixture.request }); }
 catch (error) { blocked = error; }
 assert.equal(blocked?.code, 'NO_QUALIFIED_RELEASE', 'the default policy must stay fail-closed');
 const relaxed = resolveQualifiedRelease({ component: 'core', host: uncovered, request: fixture.request, environmentPolicy: 'newest-qualified' });
 assert.equal(relaxed.environmentVerified, false);
 assert.equal(relaxed.target.sha, document.bundle.core.sha);
 assert.equal(relaxed.qualification, null);
 assert.deepEqual(relaxed.qualifiedEnvironments.map(x => x.runtime), [environment.runtime]);
 const covered = resolveQualifiedRelease({ component: 'core', host: environment, request: fixture.request, environmentPolicy: 'newest-qualified' });
 assert.equal(covered.environmentVerified, true);
 assert.throws(() => resolveQualifiedRelease({ component: 'core', host: uncovered, request: fixture.request, environmentPolicy: 'anything' }), /Invalid release selection scope\/channel/);
});
test('the blocked-preparation guidance names the supported way forward for an uncovered host', () => {
 const text = describeResolutionFailure(Object.assign(new Error('No verified stable release matches core latest.'), {
  code: 'NO_QUALIFIED_RELEASE', host: environment, skipped: [] }));
 assert.match(text, /--environment-policy newest-qualified/);
 assert.match(text, /complete local canary/);
});
test('the probe result document is accepted wherever an environment descriptor is expected', () => {
 const descriptor = { platform: 'darwin', arch: 'arm64', nodeMajor: 22, runtime: 'claude',
  functionalConfigSha256: '3dba04fabeca05ab8c1bdb3e7d6a1462d2c2d2c54cf3a74c29080a1010a35613' };
 assert.deepEqual(environmentDescriptor(descriptor), descriptor);
 assert.deepEqual(environmentDescriptor({ schema: 'zylos.qualified-config-probe/v3', descriptor: { schema: 'zylos.functional-config/v3' }, environment: descriptor }), descriptor);
 assert.deepEqual(environmentDescriptor({ result: { environment: descriptor } }), descriptor);
 // Nothing to unwrap stays untouched, including malformed input.
 assert.deepEqual(environmentDescriptor({ platform: 'linux' }), { platform: 'linux' });
 assert.deepEqual(environmentDescriptor({ environment: 'not-an-object' }), { environment: 'not-an-object' });
 assert.equal(environmentDescriptor(undefined), undefined);
});
test('preparation passes the unwrapped descriptor to release resolution', () => {
 const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-prepare-environment-'));
 const descriptor = { platform: 'darwin', arch: 'arm64', nodeMajor: 22, runtime: 'claude',
  functionalConfigSha256: '3dba04fabeca05ab8c1bdb3e7d6a1462d2c2d2c54cf3a74c29080a1010a35613' };
 const probePath = path.join(directory, 'probe-result.json'), installedPath = path.join(directory, 'installed.json');
 fs.writeFileSync(probePath, JSON.stringify({ schema: 'zylos.qualified-config-probe/v3', result: { environment: descriptor }, environment: descriptor }));
 fs.writeFileSync(installedPath, JSON.stringify(bundle()));
 let observed;
 try {
  assert.throws(() => prepare({ '--only': 'all', '--runtime': 'claude', '--out': path.join(directory, 'prepared'),
   '--authorization-ref': 'fixture', '--installed': installedPath, '--environment': probePath }, {
   resolveRelease: options => { observed = options.environment; throw new Error('stop after resolution'); } }), /stop after resolution/);
  assert.deepEqual(observed, descriptor);
 } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
