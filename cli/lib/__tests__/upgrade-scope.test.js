import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { COMPONENTS, repository, selection, assertScope, buildScopedCommand } from '../../../tools/upgrade/scope.mjs';
import { prepare } from '../../../tools/upgrade/prepare.mjs';
const baseline = Object.fromEntries(COMPONENTS.map((name, i) => [name, { repo: repository(name), version: '1.0.0', sha: String(i + 1).repeat(40) }]));
function manifest(selected) {
 const m = { releaseId: 'test', stable: structuredClone(baseline), candidate: structuredClone(baseline), upgradeScope: { components: [selected] }, localValidationRepos: { core: '/sources/core' }, operatorTools: { core: { directory: '/operator/core' } } };
 m.candidate[selected].sha = 'a'.repeat(40); return m;
}
test('repository scope defaults to Core; all is explicit', () => {
 assert.deepEqual(selection({}, baseline), ['core']); assert.deepEqual(selection({ '--only': 'all' }), COMPONENTS);
 assert.throws(() => selection({}), /installed/); assert.throws(() => selection({ '--only': 'wrong' }, baseline), /Scope/);
});
test('scope rejects other version flags and modified companions', () => {
 assert.throws(() => selection({ '--only': 'feishu', '--core': 'latest' }, baseline), /outside authorized scope/);
 const m = manifest('feishu'); m.candidate.core.sha = 'b'.repeat(40);
 assert.throws(() => assertScope(m), /unselected component changed/);
 m.candidate.core = { ...baseline.core }; m.candidate.hxa.version = '2.0.0';
 assert.throws(() => assertScope(m), /unselected component changed/);
});
for (const selected of COMPONENTS) test(`${selected} emits only its supported updater`, () => {
 const m = manifest(selected);
 const cmd = buildScopedCommand(m, { zylosDir: '/runtime', runtimeTarget: { agent: 'agent', profileId: 'id', hostname: 'host', deploymentOrgLabel: 'org' }, reportRoot: '/runtime/.zylos/upgrade-reports/new' });
 assert.equal(cmd.component, selected); assert.ok(!cmd.args.includes('--all'));
 assert.equal(cmd.args.includes('--self'), selected === 'core'); assert.equal(cmd.args.includes('feishu'), selected === 'feishu');
 assert.equal(cmd.args[0].endsWith('upgrade-hxa-connect.js'), selected === 'hxa'); assert.ok(cmd.args.includes(m.candidate[selected].sha));
 if (selected !== 'core') assert.ok(cmd.args[0].startsWith('/operator/core/'));
 assert.equal(cmd.env.ZYLOS_DIR, '/runtime');
});
test('HXA rejects missing fresh identity', () => {
 assert.throws(() => buildScopedCommand(manifest('hxa'), { zylosDir: '/runtime' }), /Fresh HXA identity/);
});
test('preparation updates only selected tag and preserves older companion SHAs', () => {
 const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-scope-fixture-')), oldEnv = { ...process.env };
 try {
  const installed = {}; process.env.GIT_CONFIG_COUNT = '0';
  for (const [i, name] of COMPONENTS.entries()) {
   const dir = path.join(root, name); fs.mkdirSync(dir);
   const git = (...a) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8', stdio: ['ignore','pipe','pipe'] }).trim();
   git('init', '-b', 'main');
   for (const version of ['1.0.0', '1.1.0']) {
    const pkgName = name === 'core' ? 'zylos' : `zylos-${name === 'hxa' ? 'hxa-connect' : name}`;
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: pkgName, version }));
    git('add', 'package.json'); git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', version);
    if (version === '1.0.0') installed[name] = { repo: repository(name), version, sha: git('rev-parse', 'HEAD') };
    git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'tag', '-a', `v${version}`, '-m', version);
   }
   process.env[`GIT_CONFIG_KEY_${i}`] = `url.${dir}.insteadOf`; process.env[`GIT_CONFIG_VALUE_${i}`] = `https://github.com/${repository(name)}.git`;
  }
  process.env.GIT_CONFIG_COUNT = '3';
  const input = path.join(root, 'installed.json'); fs.writeFileSync(input, JSON.stringify(installed));
  for (const selected of COMPONENTS) {
   const output = path.join(root, `out-${selected}`);
   const result = prepare({ '--out': output, '--authorization-ref': 'fixture-only', '--only': selected, '--installed': input });
   const m = JSON.parse(fs.readFileSync(path.join(output, 'governance/release-manifest.json')));
   assert.equal(result.runtimeMutation, false); assert.equal(m.deploymentAllowed, false); assert.equal(m.status, 'HOLD');
   assert.deepEqual(m.upgradeScope.components, [selected]); assert.equal(assertScope(m), selected);
   for (const name of COMPONENTS) {
    if (name === selected) assert.notEqual(m.candidate[name].sha, installed[name].sha);
    else assert.equal(m.candidate[name].sha, installed[name].sha);
   }
   for (const file of ['scope.mjs','command.mjs','WORKFLOW.md','UPGRADE.md']) assert.ok(fs.existsSync(path.join(output, file)));
  }
 } finally {
  for (const key of Object.keys(process.env)) if (!(key in oldEnv)) delete process.env[key];
  Object.assign(process.env, oldEnv); fs.rmSync(root, { recursive: true, force: true });
 }
});
