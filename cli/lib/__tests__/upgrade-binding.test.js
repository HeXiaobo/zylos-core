import { bindReport, verifyBinding } from '../../../tools/upgrade/governance/bind-report.mjs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
const script = new URL('../../../tools/upgrade/governance/bind-report.mjs', import.meta.url);
test('binds native per-invocation HXA IDs without rewriting either raw report', () => {
 const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'binding-'));
 try {
  const target = { repo: 'HeXiaobo/zylos-hxa-connect', packageVersion: '1.7.10', sha: 'a'.repeat(40), branch: 'main' };
  const manifest = path.join(dir, 'manifest.json');
  fs.writeFileSync(manifest, JSON.stringify({ releaseId: 'release-test', candidate: { hxa: target } }));
  for (const mode of ['dry-run','execute']) {
   const raw = path.join(dir, `${mode}.json`), output = path.join(dir, `${mode}-bound.json`);
   const value = { schema: 'zylos.hxa-upgrade-preflight/v1', status: 'PASS', releaseId: 'release-test', executionId: `raw-${mode}`, mode, result: mode === 'dry-run' ? 'PRECHECK_ONLY' : 'EXECUTE_COMPLETE', target: { repo: target.repo, sha: target.sha, version: target.packageVersion, agent: 'ss', hostname: 'host', profileId: 'profile' } };
   fs.writeFileSync(raw, JSON.stringify(value)); const before = fs.readFileSync(raw);
   const result = spawnSync(process.execPath, [fileURLToPath(script), '--manifest',manifest,'--raw',raw,'--kind',mode === 'dry-run' ? 'hxa.dryRun' : 'hxa.execute','--execution-id','parent-test','--out',output], { encoding: 'utf8' });
   assert.equal(result.status, 0, result.stderr);
   const bound = JSON.parse(fs.readFileSync(output));
   assert.equal(bound.executionId, 'parent-test'); assert.equal(bound.rawReport.executionId, `raw-${mode}`);
   assert.deepEqual(bound.target,target); assert.deepEqual(fs.readFileSync(raw),before);
  }
 } finally { fs.rmSync(dir,{recursive:true,force:true}); }
});

test('rejects failed, wrong-mode, wrong-release and wrong-source native evidence', () => {
 const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'binding-reject-'));
 try {
  const target = {repo:'HeXiaobo/zylos-hxa-connect',sha:'a'.repeat(40),packageVersion:'1.7.10'};
  const manifest = {releaseId:'release',candidate:{hxa:target}};
  const native = {schema:'zylos.hxa-upgrade-preflight/v1', status:'PASS',mode:'execute',result:'EXECUTE_COMPLETE',releaseId:'release',executionId:'original',target:{repo:target.repo,sha:target.sha,version:'1.7.10',agent:'ss',profileId:'id',hostname:'host'}};
  const rawPath = path.join(dir,'raw.json');
  for (const patch of [{status:'HOLD'},{mode:'dry-run'},{releaseId:'other'},{target:{...native.target,sha:'b'.repeat(40)}}]) {
   fs.writeFileSync(rawPath,JSON.stringify({...native,...patch}));
   assert.throws(()=>bindReport({manifest,rawPath,kind:'hxa.execute',executionId:'parent'}));
  }
  fs.writeFileSync(rawPath,JSON.stringify(native));
  const bound = bindReport({manifest,rawPath,kind:'hxa.execute',executionId:'parent'});
  assert.throws(()=>verifyBinding({...bound,result:'forged'},manifest,'hxa.execute'),/does not match/);
  assert.throws(()=>verifyBinding(bound,manifest,'hxa.dryRun'),/different stage/);
 } finally { fs.rmSync(dir,{recursive:true,force:true}); }
});
