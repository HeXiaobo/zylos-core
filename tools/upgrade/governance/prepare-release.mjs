#!/usr/bin/env node
// Prepare a new evidence ledger without modifying the active transaction.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export function prepareManifest(previous, { releaseId, targets, repositories, authorizationRef }) {
  if (!releaseId || releaseId === previous.releaseId) throw new Error('A new release ID is required');
  if (!authorizationRef) throw new Error('Owner authorization reference is required');
  for (const name of ['core', 'feishu', 'hxa']) {
    if (!/^[a-f0-9]{40}$/.test(targets[name]?.sha || '')) throw new Error(`${name}: immutable SHA required`);
  }
  const stage = target => ({ status: 'NOT_RUN', executionId: null, report: null, target });
  const pair = { core: targets.core, feishu: targets.feishu };
  return {
    schema: 'zylos.release-manifest/v2', releaseId, updatedAt: new Date().toISOString(),
    owner: previous.owner, status: 'HOLD', publicationAllowed: false, deploymentAllowed: false,
    holdReasons: ['PREPARATION_PENDING'], sourcePolicy: previous.sourcePolicy,
    stable: previous.stable, candidate: targets, localValidationRepos: repositories,
    deploymentContract: { ...previous.deploymentContract, rolloutMode: 'CANARY' },
    preparation: { previousReleaseId: previous.releaseId, authorizationRef, activeLedgerUnchanged: true },
    evidence: {
      pairReport: stage(pair), canary: 'NOT_RUN',
      preDeployCanary: { status: 'NOT_RUN', releaseId, executionId: null, report: null },
      pairExecute: { status: 'NOT_RUN' }, finalCanary: { status: 'NOT_RUN' },
      hxa: { status: 'NOT_RUN', releaseId, executionId: null, target: targets.hxa,
        ...Object.fromEntries(['check', 'dryRun', 'execute', 'provenance', 'canary'].map(key => [key, stage(targets.hxa)])) },
    },
  };
}

function main() {
  const args = process.argv.slice(2), options = {};
  const allowed = new Set(['--manifest', '--release-id', '--core-dir', '--feishu-dir', '--hxa-dir', '--authorization-ref', '--out']);
  for (let i = 0; i < args.length; i += 2) {
    if (!allowed.has(args[i]) || !args[i + 1] || args[i + 1].startsWith('--')) throw new Error('Invalid option or missing value');
    options[args[i]] = args[i + 1];
  }
  for (const key of allowed) if (!options[key]) throw new Error(`Required: ${key}`);
  const repositories = {}, targets = {};
  for (const name of ['core', 'feishu', 'hxa']) {
    const cwd = path.resolve(options[`--${name}-dir`]); repositories[name] = cwd;
    const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
    if (git('status', '--porcelain')) throw new Error(`${name}: dirty source`);
    const expectedRepo = `HeXiaobo/zylos-${name === 'hxa' ? 'hxa-connect' : name}`;
    if (![`https://github.com/${expectedRepo}.git`, `https://github.com/${expectedRepo}`, `git@github.com:${expectedRepo}.git`].includes(git('remote', 'get-url', 'origin'))) throw new Error(`${name}: unexpected origin`);
    const sha = git('rev-parse', 'HEAD'); git('merge-base', '--is-ancestor', sha, 'origin/main');
    const pkg = JSON.parse(git('show', `${sha}:package.json`));
    if (pkg.name !== (name === 'core' ? 'zylos' : `zylos-${name === 'hxa' ? 'hxa-connect' : name}`)) throw new Error(`${name}: package name mismatch`);
    targets[name] = { repo: expectedRepo, branch: 'main', [name === 'hxa' ? 'packageVersion' : 'version']: pkg.version, sha };
  }
  const previous = JSON.parse(fs.readFileSync(options['--manifest'], 'utf8'));
  const manifest = prepareManifest(previous, { releaseId: options['--release-id'], targets, repositories, authorizationRef: options['--authorization-ref'] });
  const output = path.resolve(options['--out']);
  if (output === path.resolve(options['--manifest'])) throw new Error('Cannot overwrite active ledger');
  fs.writeFileSync(output, JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify({ status: 'PREPARED', manifest: output, deploymentAllowed: false, activeLedgerUnchanged: true }));
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
