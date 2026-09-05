#!/usr/bin/env node
// Preparation only: no runtime installation or service mutations.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { prepareManifest } from './governance/prepare-release.mjs';
import { selection, version as installedVersion } from './scope.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
function parse(value) {
  const m = VERSION.exec(value);
  if (!m || (m[4] || '').split('.').some(x => /^0\d+$/.test(x))) throw new Error(`Invalid version: ${value}`);
  return { numbers: m.slice(1, 4).map(BigInt), pre: m[4]?.split('.') };
}
export function compareVersions(a, b) {
  const x = parse(a), y = parse(b);
  for (let i = 0; i < 3; i++) if (x.numbers[i] !== y.numbers[i]) return x.numbers[i] > y.numbers[i] ? 1 : -1;
  if (!x.pre || !y.pre) return x.pre ? -1 : y.pre ? 1 : 0;
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const l = x.pre[i], r = y.pre[i];
    if (l === r) continue;
    if (l === undefined || r === undefined) return l === undefined ? -1 : 1;
    const ln = /^\d+$/.test(l), rn = /^\d+$/.test(r);
    if (ln && rn) return BigInt(l) > BigInt(r) ? 1 : -1;
    if (ln !== rn) return ln ? -1 : 1;
    return l > r ? 1 : -1;
  }
  return 0;
}
export function selectTag(tags, requested = 'latest', channel = 'fork') {
  if (!['fork', 'stable'].includes(channel)) throw new Error('Channel must be fork or stable');
  const versions = tags.map(tag => ({ tag, version: tag.replace(/^v/, '') })).filter(item => {
    try { parse(item.version); return true; } catch { return false; }
  });
  const explicit = requested.replace(/^v/, '');
  if (requested !== 'latest') parse(explicit);
  const matches = versions.filter(x => requested === 'latest'
    ? channel === 'fork' || !parse(x.version).pre : x.version === explicit);
  matches.sort((a, b) => compareVersions(b.version, a.version));
  if (!matches.length) throw new Error(`No published tag matches ${requested} (${channel})`);
  if (matches.filter(x => x.version === matches[0].version).length !== 1) throw new Error('Ambiguous version tags; resolve at source');
  return matches[0];
}
export function prepare(options) {
  const output = options['--out'];
  if (!path.isAbsolute(output || '') || !options['--authorization-ref']) throw new Error('New absolute --out and --authorization-ref required');
  if (!['fork', 'stable'].includes(options['--channel'] || 'fork')) throw new Error('Unknown channel');
  for (const name of ['core', 'feishu', 'hxa']) {
    const requested = options[`--${name}`] || 'latest';
    if (requested !== 'latest') parse(requested.replace(/^v/, ''));
  }
  const installed = options['--installed'] ? JSON.parse(fs.readFileSync(options['--installed'], 'utf8')) : undefined;
  const components = selection(options, installed);
  // mkdir is exclusive: never overwrite or reuse a partial/active transaction.
  fs.mkdirSync(output, { mode: 0o700 });
  const source = path.join(output, 'source'); fs.mkdirSync(source);
  const repositories = {}, candidate = {};
  for (const name of ['core', 'feishu', 'hxa']) {
    const repo = `HeXiaobo/zylos-${name === 'hxa' ? 'hxa-connect' : name}`;
    const cwd = path.join(source, name); repositories[name] = cwd;
    execFileSync('git', ['clone', '--no-checkout', `https://github.com/${repo}.git`, cwd], { stdio: 'inherit' });
    const git = (...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
    const selected = components.includes(name)
      ? selectTag(git('tag', '--list').split('\n'), options[`--${name}`] || 'latest', options['--channel'] || 'fork')
      : { version: installedVersion(installed[name]) };
    const sha = components.includes(name) ? git('rev-parse', `refs/tags/${selected.tag}^{commit}`) : installed[name].sha;
    if (!/^[a-f0-9]{40}$/.test(sha)) throw new Error(`${name}: invalid commit SHA`);
    git('merge-base', '--is-ancestor', sha, 'origin/main');
    const pkg = JSON.parse(git('show', `${sha}:package.json`));
    if (pkg.version !== selected.version || pkg.name !== (name === 'core' ? 'zylos' : `zylos-${name === 'hxa' ? 'hxa-connect' : name}`)) throw new Error(`${name}: tag/package mismatch`);
    git('switch', '-c', `release/${pkg.version}`, sha);
    if (git('status', '--porcelain')) throw new Error(`${name}: dirty source`);
    candidate[name] = { repo, branch: 'main', sha, [name === 'hxa' ? 'packageVersion' : 'version']: pkg.version };
  }
  fs.cpSync(path.join(HERE, 'governance'), path.join(output, 'governance'), { recursive: true });
  for (const file of ['scope.mjs', 'command.mjs']) fs.copyFileSync(path.join(HERE, file), path.join(output, file));
  fs.copyFileSync(path.join(HERE, 'WORKFLOW.md'), path.join(output, 'WORKFLOW.md'));
  fs.copyFileSync(path.join(HERE, '../../UPGRADE.md'), path.join(output, 'UPGRADE.md'));
  const releaseId = `ZYL-UPGRADE-${os.hostname().replace(/[^a-zA-Z0-9-]/g, '-')}-${Date.now()}`;
  const previous = { releaseId: null, owner: 'HeXiaobo', stable: installed || {},
    sourcePolicy: { deployableBranch: 'main', immutableFullShaOnly: true, featureReleaseArchiveBranchesAreHistoryOnly: true },
    deploymentContract: { targetMode: 'global', rolloutMode: 'CANARY', immutableFullShaOnly: true, cleanWorktreeRequired: true, dryRunRequired: true, pairReportRequired: true, canaryRequired: true, pairComponents: ['core', 'feishu'], hxaRequired: true } };
  const manifest = prepareManifest(previous, { releaseId, targets: candidate, repositories, authorizationRef: options['--authorization-ref'] });
  const toolDirectory = path.resolve(HERE, '../..');
  const toolSha = execFileSync('git', ['-C', toolDirectory, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  manifest.operatorTools = { core: { repo: 'HeXiaobo/zylos-core', directory: toolDirectory, sha: toolSha } };
  manifest.upgradeScope = { components, preserved: ['core', 'feishu', 'hxa'].filter(name => !components.includes(name)) };
  const write = (name, value) => fs.writeFileSync(path.join(output, name), JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  write('bundle.json', { ...previous, releaseId, candidate, upgradeScope: manifest.upgradeScope });
  write('governance/release-manifest.json', manifest);
  write('governance/employee-runtime-registry.json', { schema: 'zylos.employee-runtime-registry/v1', employees: {} });
  fs.mkdirSync(path.join(output, 'evidence'));
  return { status: 'PREPARED', directory: output, releaseId, candidate, upgradeScope: manifest.upgradeScope, deploymentAllowed: false, runtimeMutation: false, next: 'Read WORKFLOW.md; verify host, rollback baseline, compatibility and evidence before READY.' };
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const args = process.argv.slice(2), options = {};
    if (args.includes('--help')) {
      console.log('node tools/upgrade/prepare.mjs --out NEW_ABSOLUTE_DIR --authorization-ref MESSAGE_ID [--only core|feishu|hxa|all] [--installed VERIFIED_BASELINE_JSON] [--core latest|VERSION] [--feishu latest|VERSION] [--hxa latest|VERSION] [--channel fork|stable]');
    } else {
      for (let i = 0; i < args.length; i += 2) {
        if (!['--out', '--authorization-ref', '--core', '--feishu', '--hxa', '--channel', '--only', '--installed'].includes(args[i]) || !args[i + 1] || args[i + 1].startsWith('--') || options[args[i]]) throw new Error('Invalid arguments; use --help');
        options[args[i]] = args[i + 1];
      }
      console.log(JSON.stringify(prepare(options), null, 2));
    }
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
