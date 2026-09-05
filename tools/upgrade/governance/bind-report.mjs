#!/usr/bin/env node
// Bind native report identities to a release; never edit the original or invent a stage.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { atomicWriteJson } from './release-transaction.mjs';
export const BINDING_SCHEMA = 'zylos.native-upgrade-report-binding/v1';
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function requireValue(condition, message) { if (!condition) throw new Error(message); }
function sameSource(actual, expected) {
 return actual?.repo === expected?.repo && actual?.sha === expected?.sha &&
  (actual?.version ?? actual?.packageVersion) === (expected?.version ?? expected?.packageVersion) && /^[a-f0-9]{40}$/.test(expected?.sha || '');
}
export function bindReport({ manifest, rawPath, kind, executionId }) {
 requireValue(path.isAbsolute(rawPath || ''), 'Raw report path must be absolute');
 requireValue(['hxa.dryRun','hxa.execute','pair.dryRun','pair.execute'].includes(kind), 'Unsupported native report kind');
 requireValue(typeof executionId === 'string' && executionId.length > 0 && typeof manifest.releaseId === 'string' && manifest.releaseId.length > 0, 'Release and parent execution ID required');
 const bytes = fs.readFileSync(rawPath), raw = JSON.parse(bytes);
 const hxa = kind.startsWith('hxa.'), dryRun = kind.endsWith('.dryRun');
 requireValue(raw.schema === (hxa ? 'zylos.hxa-upgrade-preflight/v1' : 'zylos.fork-pair-upgrade/v1'), 'Unexpected native schema');
 requireValue(raw.status === 'PASS', 'Native report must already be PASS');
 requireValue(raw.mode === (dryRun ? 'dry-run' : 'execute'), 'Native stage/mode mismatch');
 requireValue(raw.result === (dryRun ? 'PRECHECK_ONLY' : hxa ? 'EXECUTE_COMPLETE' : 'UPGRADE_COMPLETE'), 'Native result is not a completed stage');
 const rawId = hxa ? raw.executionId : raw.transactionId;
 requireValue(typeof rawId === 'string' && rawId.length > 0, 'Native execution/transaction ID missing');
 requireValue(hxa ? raw.releaseId === manifest.releaseId : raw.releaseId === undefined || raw.releaseId === manifest.releaseId, 'Native releaseId mismatch');
 const target = hxa ? manifest.candidate?.hxa : { core: manifest.candidate?.core, feishu: manifest.candidate?.feishu };
 for (const name of hxa ? ['hxa'] : ['core','feishu']) requireValue(sameSource(hxa ? raw.target : raw.target?.[name], hxa ? target : target[name]), `Native ${name} source differs from candidate`);
 const runtimeTarget = hxa ? { agent: raw.target.agent, profileId: raw.target.profileId, hostname: raw.target.hostname } : { agent: raw.agent };
 requireValue(typeof runtimeTarget.agent === 'string' && runtimeTarget.agent.length > 0, 'Native agent identity missing');
 if (hxa) requireValue(runtimeTarget.profileId && runtimeTarget.hostname, 'Native HXA host identity missing');
 return { schema: BINDING_SCHEMA, status: raw.status, releaseId: manifest.releaseId, executionId, kind,
  mode: raw.mode, result: raw.result, target, runtimeTarget,
  rawReport: { path: rawPath, sha256: digest(bytes), schema: raw.schema, executionId: rawId } };
}
export function verifyBinding(report, manifest, expectedKind) {
 requireValue(report.kind === expectedKind, 'Bound report is for a different stage');
 const expected = bindReport({ manifest, rawPath: report.rawReport?.path, kind: expectedKind, executionId: report.executionId });
 // Field order is not significant, but extra or modified evidence fields are rejected.
 const stable = value => Array.isArray(value) ? value.map(stable) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value;
 requireValue(JSON.stringify(stable(report)) === JSON.stringify(stable(expected)), 'Bound report or raw hash does not match original');
 return expected.runtimeTarget;
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
 try {
  const args = process.argv.slice(2), o = {};
  for (let i=0;i<args.length;i+=2) {
   if (!['--manifest','--raw','--kind','--execution-id','--out'].includes(args[i]) || !args[i+1] || o[args[i]]) throw new Error('Use --manifest ABSOLUTE_JSON --raw ABSOLUTE_JSON --kind hxa.dryRun|hxa.execute|pair.dryRun|pair.execute --execution-id PARENT_ID --out NEW_ABSOLUTE_JSON');
   o[args[i]]=args[i+1];
  }
  requireValue(path.isAbsolute(o['--out'] || '') && path.isAbsolute(o['--manifest'] || ''), 'Absolute manifest and new output required');
  const report = bindReport({ manifest: JSON.parse(fs.readFileSync(o['--manifest'])), rawPath:o['--raw'],kind:o['--kind'],executionId:o['--execution-id'] });
  atomicWriteJson(o['--out'],report,{exclusive:true});
  console.log(JSON.stringify({status:'BOUND',report:o['--out'],rawReport:report.rawReport}));
 } catch(error) {console.error(error.message);process.exitCode=2;}
}
