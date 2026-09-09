import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { bundle, distribution, catalog } from './helpers/qualified-release-fixture.js';
const root = path.resolve('.');
const moduleUrl = name => pathToFileURL(path.join(root, name)).href;
function sandbox({ empty = false, existing = false } = {}) {
 const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-channel-cli-'));
 const bin = path.join(directory, 'bin'); fs.mkdirSync(bin);
 const document = distribution({ target: bundle('8.0.0') }), fixture = catalog([document]);
 const paths = { ...fixture.paths, '/repos/HeXiaobo/zylos-core/releases?per_page=100&page=1': JSON.stringify(empty ? [] : fixture.releases) };
 fs.writeFileSync(path.join(directory, 'responses.json'), JSON.stringify(paths));
 const write = (name, script) => fs.writeFileSync(path.join(bin, name), script, { mode: 0o755 });
 write('curl', `#!${process.execPath}
const fs = require('node:fs'); const args = process.argv.slice(2), url = args.find(x => /^https:/.test(x)) || '';
fs.appendFileSync(process.env.CALLS, url + '\\n');
if (url.endsWith('/tools/upgrade/release-channel.mjs')) { fs.copyFileSync(process.env.RESOLVER, args[args.indexOf('-o')+1]); process.exit(0); }
const data = JSON.parse(fs.readFileSync(process.env.RESPONSES)); const endpoint = url.replace('https://api.github.com', '');
if (Object.hasOwn(data, endpoint)) { process.stdout.write(data[endpoint]); process.exit(0); }
process.stderr.write('fixture: download unavailable'); process.exit(22);
`);
 write('gh', '#!/bin/sh\nexit 1\n');
 write('git', '#!/bin/sh\nif [ "$1" = "ls-remote" ]; then printf "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\\trefs/heads/main\\n"; else echo git-fixture; fi\n');
 write('tmux', '#!/bin/sh\necho tmux-fixture\n');
 write('npm', '#!/bin/sh\nif [ "$1" = "config" ]; then echo "$HOME"; else printf "%s\\n" "$*" >> "$MUTATIONS"; fi\n');
 if (existing) write('zylos', '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "${FIXTURE_CURRENT_VERSION:-0.7.0}"; else printf "%s\\n" "$*" >> "$MUTATIONS"; fi\n');
 // Real Node for the bootstrap; all installation/network effects are sandboxed.
 fs.symlinkSync(process.execPath, path.join(bin, 'node'));
 const env = { ...process.env, HOME: directory, ZYLOS_DIR: path.join(directory, 'runtime'), PATH: `${bin}:/usr/bin:/bin`,
  RESPONSES: path.join(directory, 'responses.json'), CALLS: path.join(directory, 'calls'), MUTATIONS: path.join(directory, 'mutations'),
  RESOLVER: path.join(root, 'tools/upgrade/release-channel.mjs'), GH_TOKEN: '', GITHUB_TOKEN: '', ZYLOS_SELF_UPGRADE_REPO: 'HeXiaobo/zylos-core',
  NONINTERACTIVE: '1', CI: 'true', ZYLOS_GH_RETRY_DELAY_MS: '' };
 return { directory, env, document, calls: () => fs.existsSync(env.CALLS) ? fs.readFileSync(env.CALLS, 'utf8') : '',
  mutations: () => fs.existsSync(env.MUTATIONS) ? fs.readFileSync(env.MUTATIONS, 'utf8') : '',
  cleanup: () => fs.rmSync(directory, { recursive: true, force: true }) };
}
function evaluate(fixture, code) {
 const child = spawnSync(process.execPath, ['--input-type=module', '-e', code], { cwd: root, env: fixture.env, encoding: 'utf8', timeout: 20000 });
 assert.equal(child.status, 0, child.stderr); return JSON.parse(child.stdout);
}
test('Core self-check and component add resolve the same qualified immutable sources', async () => {
 const fixture = sandbox();
 try {
  const result = evaluate(fixture, `import { checkForCoreUpdates } from ${JSON.stringify(moduleUrl('cli/lib/self-upgrade.js'))};
   import { resolveTarget } from ${JSON.stringify(moduleUrl('cli/lib/components.js'))};
   console.log(JSON.stringify({ core: checkForCoreUpdates(), feishu: await resolveTarget('https://github.com/HeXiaobo/zylos-feishu'), hxa: await resolveTarget('https://github.com/HeXiaobo/zylos-hxa-connect') }));`);
  assert.equal(result.core.success, true); assert.equal(result.core.source.ref, fixture.document.bundle.core.sha);
  for (const name of ['feishu', 'hxa']) { assert.equal(result[name].source.ref, fixture.document.bundle[name].sha); assert.equal(result[name].source.refType, 'commit'); }
  assert.ok(!fixture.calls().includes('/tags?')); assert.ok(!fixture.calls().includes('/main/'));
 } finally { fixture.cleanup(); }
});
test('ordinary CLI self-check reports unavailable qualified download without trying main', () => {
 const fixture = sandbox();
 try {
  const child = spawnSync(process.execPath, [path.join(root, 'cli/zylos.js'), 'upgrade', '--self', '--check', '--json'], { env: fixture.env, encoding: 'utf8', timeout: 20000 });
  assert.equal(child.status, 1, child.stderr); const result = JSON.parse(child.stdout);
  assert.equal(result.error, 'self_upgrade_download_failed'); assert.equal(result.source.ref, fixture.document.bundle.core.sha);
  assert.ok(!fixture.calls().includes('/main')); assert.equal(fixture.mutations(), '');
 } finally { fixture.cleanup(); }
});
for (const existing of [false, true]) test(`installer uses qualified SHA and ${existing ? 'native upgrade for an existing installation' : 'immutable npm input for a fresh installation'}`, () => {
 const fixture = sandbox({ existing });
 try {
  const child = spawnSync('/bin/bash', [path.join(root, 'scripts/install.sh'), '--no-init', '-y'], { env: fixture.env, encoding: 'utf8', timeout: 20000 });
  assert.equal(child.status, 0, child.stdout + child.stderr);
  const mutation = fixture.mutations(); assert.ok(mutation.includes(fixture.document.bundle.core.sha));
  assert.ok(existing ? mutation.includes('upgrade --self') && !mutation.includes('install -g') : mutation.includes('install -g --install-links --ignore-scripts'));
  assert.ok(!mutation.includes('#main')); assert.ok(!mutation.includes(' init'));
 } finally { fixture.cleanup(); }
});
test('unqualified catalog stops the installer before npm or runtime writes', () => {
 const fixture = sandbox({ empty: true });
 try {
  const child = spawnSync('/bin/bash', [path.join(root, 'scripts/install.sh'), '--no-init', '-y'], { env: fixture.env, encoding: 'utf8', timeout: 20000 });
  assert.notEqual(child.status, 0); assert.match(child.stderr, /No verified stable release/); assert.equal(fixture.mutations(), '');
 } finally { fixture.cleanup(); }
});

for (const current of ['8.0.0', '9.0.0']) test(`installer preserves installed ${current} without reinstalling older/equal source`, () => {
 const fixture = sandbox({ existing: true }); fixture.env.FIXTURE_CURRENT_VERSION = current;
 try {
  const child = spawnSync('/bin/bash', [path.join(root, 'scripts/install.sh'), '--no-init', '-y'], { env: fixture.env, encoding: 'utf8', timeout: 20000 });
  assert.equal(child.status, 0, child.stdout + child.stderr); assert.equal(fixture.mutations(), '');
  assert.match(child.stdout, /preserving its source/);
 } finally { fixture.cleanup(); }
});
