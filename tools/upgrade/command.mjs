#!/usr/bin/env node
// Emit one supported updater command only after the existing deployment gate.
// The resident Agent owns execution, durable receipts, and final verification.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { assertScope, buildScopedCommand, COMPONENTS, repository, version } from './scope.mjs';
const here = path.dirname(fileURLToPath(import.meta.url));
try {
  const args = process.argv.slice(2), options = {};
  if (args.includes('--help')) {
    console.log('node command.mjs --manifest ABSOLUTE_MANIFEST --zylos-dir ABSOLUTE_RUNTIME [--report-root NEW_HXA_REPORT_ROOT]');
  } else {
    for (let i = 0; i < args.length; i += 2) {
      if (!['--manifest', '--zylos-dir', '--report-root'].includes(args[i]) || !args[i + 1] || args[i + 1].startsWith('--') || options[args[i]]) throw new Error('Invalid arguments; use --help');
      options[args[i]] = args[i + 1];
    }
    const file = options['--manifest'], zylosDir = options['--zylos-dir'];
    if (!path.isAbsolute(file || '') || !path.isAbsolute(zylosDir || '')) throw new Error('Absolute manifest and runtime paths required');
    const bytes = fs.readFileSync(file), manifest = JSON.parse(bytes);
    const component = assertScope(manifest);
    if (manifest.status !== 'READY' || manifest.deploymentAllowed !== true) throw new Error('Preparation incomplete: READY and deploymentAllowed required');
    for (const name of COMPONENTS) {
      const cwd = manifest.localValidationRepos?.[name];
      if (!path.isAbsolute(cwd || '')) throw new Error(`${name}: source directory required`);
      const git = (...a) => execFileSync('git', ['-C', cwd, ...a], { encoding: 'utf8' }).trim();
      if (git('rev-parse', 'HEAD') !== manifest.candidate[name].sha || git('status', '--porcelain')) throw new Error(`${name}: source mismatch or dirty worktree`);
      if (![ `https://github.com/${repository(name)}.git`, `https://github.com/${repository(name)}`, `git@github.com:${repository(name)}.git` ].includes(git('remote', 'get-url', 'origin'))) throw new Error(`${name}: untrusted origin`);
      git('merge-base', '--is-ancestor', manifest.candidate[name].sha, 'origin/main');
      if (JSON.parse(git('show', 'HEAD:package.json')).version !== version(manifest.candidate[name])) throw new Error(`${name}: version mismatch`);
    }
    const tooling = manifest.operatorTools?.core;
    if (!tooling || tooling.repo !== repository('core') || !path.isAbsolute(tooling.directory || '') || !/^[a-f0-9]{40}$/.test(tooling.sha || '')) throw new Error('Pinned operator tooling required');
    const toolGit = (...a) => execFileSync('git', ['-C', tooling.directory, ...a], { encoding: 'utf8' }).trim();
    if (toolGit('rev-parse', 'HEAD') !== tooling.sha || toolGit('status', '--porcelain')) throw new Error('Operator tooling changed or is dirty');
    if (![`https://github.com/${tooling.repo}.git`, `https://github.com/${tooling.repo}`, `git@github.com:${tooling.repo}.git`].includes(toolGit('remote', 'get-url', 'origin'))) throw new Error('Untrusted operator tooling origin');
    toolGit('merge-base', '--is-ancestor', tooling.sha, 'origin/main');
    const stage = component === 'hxa' ? 'hxa' : 'pair';
    const gate = JSON.parse(execFileSync(process.execPath, [path.join(here, 'governance/agent-preflight.mjs'), 'deploy', '--stage', stage, '--manifest', file], { env: { ...process.env, ZYLOS_DIR: zylosDir }, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }));
    if (gate.status !== 'PASS' || gate.releaseId !== manifest.releaseId || !gate.runtimeTarget) throw new Error('Fresh deployment gate failed');
    if (!bytes.equals(fs.readFileSync(file))) throw new Error('Manifest changed during gate; prepare again');
    const command = buildScopedCommand(manifest, { zylosDir, runtimeTarget: gate.runtimeTarget, reportRoot: options['--report-root'] });
    console.log(JSON.stringify({ schema: 'zylos.scoped-upgrade-command/v1', status: 'READY_TO_EXECUTE', releaseId: manifest.releaseId, manifestSha256: crypto.createHash('sha256').update(bytes).digest('hex'), generatedAt: gate.generatedAt, runtimeTarget: gate.runtimeTarget, preserved: manifest.upgradeScope.preserved, ...command, runtimeMutation: false }, null, 2));
  }
} catch (error) { console.error(error.message); process.exitCode = 1; }
