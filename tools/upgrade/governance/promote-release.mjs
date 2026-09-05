#!/usr/bin/env node
// Authorize only this host's existing candidate, using the unchanged deployment gate.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { atomicWriteJson, lockManifest, acquireRuntimeTransactionLock, inspectRuntimeIsolation } from './release-transaction.mjs';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
function assertIdle(value, location = 'manifest') {
  if (!value || typeof value !== 'object') return;
  if (value.status === 'RUNNING') throw new Error(`RUNNING transaction at ${location}; follow its executionId, do not promote`);
  for (const [key, child] of Object.entries(value)) assertIdle(child, `${location}.${key}`);
}
export function promoteRelease({ manifestPath, runtimeRoot, stage }) {
  if (!path.isAbsolute(manifestPath || '') || !path.isAbsolute(runtimeRoot || '')) throw new Error('Absolute --manifest and --zylos-dir required');
  if (!['hxa', 'pair'].includes(stage)) throw new Error('--stage must be hxa or pair');
  if (fs.lstatSync(manifestPath).isSymbolicLink()) throw new Error('Manifest symlinks are not supported');
  runtimeRoot = fs.realpathSync(runtimeRoot);
  const unlock = lockManifest(manifestPath);
  let runtimeLock, provisional;
  try {
    const original = fs.readFileSync(manifestPath, 'utf8');
    const before = JSON.parse(original);
    assertIdle(before);
    if (!['HOLD', 'READY'].includes(before.status) || before.transactionClosure) throw new Error('Only an open HOLD/READY candidate can be promoted');
    runtimeLock = acquireRuntimeTransactionLock(runtimeRoot);
    const isolation = inspectRuntimeIsolation(runtimeRoot, runtimeLock);
    const next = { ...before, status: 'READY', deploymentAllowed: true, holdReasons: [] };
    const id = crypto.randomUUID();
    provisional = path.join(path.dirname(manifestPath), `.promotion-${id}.json`);
    atomicWriteJson(provisional, next, { exclusive: true });
    const result = spawnSync(process.execPath, [path.join(HERE, 'agent-preflight.mjs'), 'deploy', '--stage', stage, '--manifest', provisional], {
      encoding: 'utf8', timeout: 120000, maxBuffer: 16 * 1024 * 1024,
      env: { ...process.env, ZYLOS_EMPLOYEE_RUNTIME_REGISTRY: process.env.ZYLOS_EMPLOYEE_RUNTIME_REGISTRY || path.join(path.dirname(manifestPath), 'employee-runtime-registry.json') },
    });
    let gate;
    try { gate = JSON.parse(result.stdout); } catch { throw new Error(`Deployment gate did not return a report: ${result.error?.message || result.stderr}`); }
    const report = path.join(path.dirname(manifestPath), `promotion-${id}.json`);
    const audit = { schema: 'zylos.local-release-promotion/v1', releaseId: before.releaseId,
      stage, runtimeRoot, checkedAt: new Date().toISOString(), isolation,
      beforeSha256: hash(original), before, candidate: next, gate, status: 'HOLD' };
    if (result.status !== 0 || gate.status !== 'PASS' || !gate.runtimeTarget) {
      atomicWriteJson(report, audit, { exclusive: true });
      throw new Error(`Deployment gate HOLD: ${(gate.failures || []).join('; ')}; report: ${report}`);
    }
    inspectRuntimeIsolation(runtimeRoot, runtimeLock);
    if (fs.readFileSync(manifestPath, 'utf8') !== original) throw new Error('Manifest changed during gate; original not overwritten');
    audit.status = 'VALIDATED';
    atomicWriteJson(report, audit, { exclusive: true });
    atomicWriteJson(manifestPath, next);
    atomicWriteJson(report, { ...audit, status: 'PROMOTED', afterSha256: hash(fs.readFileSync(manifestPath)), committedAt: new Date().toISOString() });
    return { status: 'READY', releaseId: before.releaseId, stage, report, runtimeTarget: gate.runtimeTarget, runtimeMutation: false, publicationAllowed: next.publicationAllowed === true };
  } finally {
    if (provisional && fs.existsSync(provisional)) fs.unlinkSync(provisional);
    try { runtimeLock?.release(); } finally { unlock(); }
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const args = process.argv.slice(2), options = {};
    for (let i = 0; i < args.length; i += 2) {
      if (!['--manifest', '--zylos-dir', '--stage'].includes(args[i]) || !args[i + 1] || options[args[i]]) throw new Error('Usage: promote-release.mjs --manifest ABSOLUTE_JSON --zylos-dir ABSOLUTE_RUNTIME --stage hxa|pair');
      options[args[i]] = args[i + 1];
    }
    console.log(JSON.stringify(promoteRelease({ manifestPath: options['--manifest'], runtimeRoot: options['--zylos-dir'], stage: options['--stage'] }), null, 2));
  } catch (error) { console.error(JSON.stringify({ status: 'HOLD', error: error.message })); process.exitCode = 2; }
}
