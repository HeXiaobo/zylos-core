import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildDistribution, publishDistribution } from '../../../tools/upgrade/publish.mjs';
import { attachQualification, assertImportedQualification } from '../../../tools/upgrade/qualification.mjs';
import { sha256 } from '../../../tools/upgrade/release-channel.mjs';
import { distribution, environment } from './helpers/qualified-release-fixture.js';

function evidence() {
 const document = distribution();
 const manifest = { releaseId: document.releaseId, status: 'READY', deploymentAllowed: true,
  candidate: structuredClone(document.bundle), evidence: { canary: 'PASS', finalCanary: { status: 'PASS' } } };
 const report = { ...document.qualifications[0], hostname: 'private-host', messages: ['private-message'], profileId: 'private-profile' };
 const finalGate = { schema: 'zylos.agent-preflight/v1', mode: 'deploy', deploymentStage: 'final', status: 'PASS', releaseId: manifest.releaseId,
  candidateBundle: Object.fromEntries(Object.entries(document.bundle).map(([k,v]) => [`${k}Sha`,v.sha])), runtimeTarget: { hostname: 'private-host' } };
 const entry = { report, reportBytes: JSON.stringify(report), finalGate, finalGateBytes: JSON.stringify(finalGate) };
 return { manifest, qualificationEntries: [entry], releaseTag: document.releaseTag };
}
test('publisher requires complete qualification and strips host/private report fields', () => {
 const input = evidence();
 const result = buildDistribution(input), bytes = JSON.stringify(result);
 assert.equal(result.status, 'QUALIFIED'); assert.ok(!bytes.includes('private-'));
 for (const mutate of [x => x.manifest.status = 'HOLD', x => x.manifest.evidence.canary = 'NOT_RUN',
  x => x.qualificationEntries[0].finalGate.status = 'HOLD', x => x.qualificationEntries[0].finalGate.candidateBundle.coreSha = 'a'.repeat(40),
  x => x.qualificationEntries[0].report.target.core.version = '9.0.0', x => x.qualificationEntries[0].report.environment.hostname = 'private-host']) {
  const bad = evidence(); mutate(bad); assert.throws(() => buildDistribution(bad));
 }
});
test('uncertain draft creation and publish are inspected, never submitted twice; conflict is preserved', () => {
 const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-publish-fixture-'));
 try {
  const document = buildDistribution(evidence()), assetPath = path.join(root, 'zylos-release.json'), notesPath = path.join(root, 'notes.md');
  const assetBytes = JSON.stringify(document); fs.writeFileSync(assetPath, assetBytes); fs.writeFileSync(notesPath, 'Fixture');
  let release = null; const mutations = [];
  const gh = args => {
   if (args[0] === 'api') { if (!release) throw new Error('HTTP 404'); return JSON.stringify(release); }
   mutations.push(args[1]);
   if (args[1] === 'create') { release = { id: 1, draft: true }; throw new Error('uncertain connection'); }
   if (args[1] === 'edit') { release.draft = false; throw new Error('uncertain connection'); }
  };
  const readDistribution = () => ({ document, assetSha256: sha256(assetBytes) });
  assert.equal(publishDistribution(document, { assetPath, notesPath, gh, readDistribution }).status, 'PUBLISHED');
  assert.deepEqual(mutations, ['create', 'edit']);
  assert.equal(publishDistribution(document, { assetPath, notesPath, gh, readDistribution }).status, 'PUBLISHED');
  assert.deepEqual(mutations, ['create', 'edit']);
  assert.throws(() => publishDistribution(document, { assetPath, notesPath, gh, readDistribution: () => ({ document, assetSha256: 'f'.repeat(64) }) }), /not overwritten/);
  assert.deepEqual(mutations, ['create', 'edit']);
 } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
test('publication left as draft reports pending without retrying the mutation', () => {
 const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-pending-fixture-'));
 try {
  const document = distribution(), assetPath = path.join(root, 'asset'), bytes = JSON.stringify(document); fs.writeFileSync(assetPath, bytes);
  let edits = 0;
  const gh = args => { if (args[0] === 'api') return JSON.stringify({ id: 9, draft: true }); edits++; throw new Error('offline'); };
  const result = publishDistribution(document, { assetPath, gh, readDistribution: () => ({ document, assetSha256: sha256(bytes) }) });
  assert.equal(result.status, 'PUBLICATION_PENDING'); assert.equal(result.releaseId, 9); assert.equal(edits, 1);
 } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
test('import reuses only version evidence; host smoke stays RUN and modified evidence blocks deployment', () => {
 const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-qualification-fixture-'));
 try {
  const document = distribution(), assetPath = path.join(root, 'published.json'), bytes = JSON.stringify(document); fs.writeFileSync(assetPath, bytes);
  const candidate = structuredClone(document.bundle); candidate.hxa.packageVersion = candidate.hxa.version; delete candidate.hxa.version;
  const manifest = { releaseId: 'local-rollout', candidate, status: 'HOLD', deploymentAllowed: false, evidence: { canary: 'NOT_RUN' },
   deploymentContract: { rolloutMode: 'CANARY' }, distribution: { releaseId: document.releaseId, assetPath, assetSha256: sha256(bytes), qualificationImported: false } };
  const options = { assetPath, assetSha256: sha256(bytes), environment, evidenceDirectory: root };
  assert.throws(() => assertImportedQualification(manifest), /must be imported/);
  const result = attachQualification(manifest, options);
  const host = { platform: environment.platform, arch: environment.arch, nodeMajor: environment.nodeMajor, runtime: environment.runtime };
  assertImportedQualification(result, { host });
  assert.deepEqual(attachQualification(manifest, options), result); // safe resume of partial preparation
  assert.equal(result.status, 'HOLD'); assert.equal(result.deploymentAllowed, false); assert.equal(result.evidence.canary, 'NOT_RUN');
  assert.throws(() => assertImportedQualification(result, { host: { ...host, nodeMajor: host.nodeMajor + 1 } }), /Current host/);
  assert.throws(() => attachQualification(manifest, { ...options, environment: { ...environment, functionalConfigSha256: 'a'.repeat(64) } }), /not in/);
  fs.appendFileSync(assetPath, ' '); assert.throws(() => assertImportedQualification(result, { host }), /asset changed/);
 } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
