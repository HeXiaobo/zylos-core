import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { assertNoVersionReuse, assertQualificationSuperset, buildDistribution, publishDistribution } from '../../../tools/upgrade/publish.mjs';
import { attachQualification, assertImportedQualification } from '../../../tools/upgrade/qualification.mjs';
import { canonical, qualificationFingerprint, sha256 } from '../../../tools/upgrade/release-channel.mjs';
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
test('publisher discovers a draft hidden from the tag endpoint without creating a duplicate', () => {
 const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-publish-draft-fixture-'));
 try {
  const document = buildDistribution(evidence()), assetPath = path.join(root, 'zylos-release.json'), notesPath = path.join(root, 'notes.md');
  const assetBytes = JSON.stringify(document); fs.writeFileSync(assetPath, assetBytes); fs.writeFileSync(notesPath, 'Fixture');
  const release = { id: 7, tag_name: document.releaseTag, draft: true, assets: [] }; const calls = [];
  const gh = args => {
   calls.push(args);
   if (args[0] === 'api' && args[1].includes('/releases/tags/')) throw new Error('HTTP 404');
   if (args[0] === 'api' && args[1].includes('/releases?')) return JSON.stringify([release]);
   if (args[0] === 'release' && args[1] === 'edit') { release.draft = false; return ''; }
   throw new Error(`unexpected gh call: ${args.join(' ')}`);
  };
  const readDistribution = () => ({ document, assetSha256: sha256(assetBytes) });
  assert.equal(publishDistribution(document, { assetPath, notesPath, gh, readDistribution }).status, 'PUBLISHED');
  assert.equal(calls.filter(args => args[0] === 'release' && args[1] === 'create').length, 0);
 } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
test('a new release may not reuse a published component version for another commit', () => {
 const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-publish-version-reuse-fixture-'));
 try {
  const document = buildDistribution(evidence()), assetPath = path.join(root, 'zylos-release.json'), notesPath = path.join(root, 'notes.md');
  fs.writeFileSync(assetPath, JSON.stringify(document)); fs.writeFileSync(notesPath, 'Fixture');
  const published = structuredClone(document);
  published.releaseId = 'earlier-release'; published.releaseTag = 'bundle-earlier-release';
  published.bundle.core.sha = 'a'.repeat(40);
  published.qualifications[0].target = published.bundle;
  const entry = { id: 9, tag_name: published.releaseTag, draft: false, prerelease: false, assets: [{ id: 9, name: 'zylos-release.json' }] };
  const readDistribution = release => {
   const doc = release.tag_name === 'bundle-same-commit' ? document : published;
   return { document: doc, assetSha256: sha256(JSON.stringify(doc)) };
  };
  assert.throws(() => assertNoVersionReuse([entry], { releaseTag: document.releaseTag, channel: 'stable', bundle: document.bundle, readDistribution }),
   /must not reuse a published component version/);
  // Re-publishing the same commit, an unqualified entry, the release being
  // updated, and another channel are all allowed.
  assert.equal(assertNoVersionReuse([{ ...entry, tag_name: 'bundle-same-commit' }], { releaseTag: document.releaseTag, channel: 'stable', bundle: document.bundle, readDistribution }), true);
  assert.equal(assertNoVersionReuse([entry], { releaseTag: published.releaseTag, channel: 'stable', bundle: published.bundle, readDistribution }), true);
  assert.equal(assertNoVersionReuse([{ ...entry, assets: [] }], { releaseTag: document.releaseTag, channel: 'stable', bundle: document.bundle, readDistribution }), true);
  assert.equal(assertNoVersionReuse([{ ...entry, prerelease: true }], { releaseTag: document.releaseTag, channel: 'stable', bundle: document.bundle, readDistribution }), true);
  // The refusal happens before the first mutation, so no draft is ever created.
  const releases = [entry]; const calls = [];
  const gh = args => {
   calls.push(args.join(' '));
   if (args[0] === 'api' && args[1].includes('/releases/tags/')) throw new Error('HTTP 404');
   if (args[0] === 'api' && args[1].includes('/releases?')) return JSON.stringify(releases);
   throw new Error(`unexpected gh call: ${args.join(' ')}`);
  };
  assert.throws(() => publishDistribution(document, { assetPath, notesPath, gh, readDistribution, catalog: () => releases }),
   /must not reuse a published component version/);
  assert.deepEqual(calls.filter(call => call.startsWith('release create')), []);
 } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
test('publisher continues bounded release pagination before editing the exact draft tag', () => {
 const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-publish-pagination-fixture-'));
 try {
  const document = buildDistribution(evidence()), assetPath = path.join(root, 'zylos-release.json'), notesPath = path.join(root, 'notes.md');
  const assetBytes = JSON.stringify(document); fs.writeFileSync(assetPath, assetBytes); fs.writeFileSync(notesPath, 'Fixture');
  const target = { id: 8, tag_name: document.releaseTag, draft: true }; const firstPage = Array.from({ length: 100 }, (_, i) => ({ id: i + 100, tag_name: `other-${i}`, draft: true }));
  const listPages = []; const editedTags = []; let creates = 0;
  const gh = args => {
   if (args[0] === 'api' && args[1].includes('/releases/tags/')) throw new Error('HTTP 404');
   if (args[0] === 'api' && args[1].includes('/releases?')) {
    listPages.push(args[1]);
    return args[1].endsWith('page=1') ? JSON.stringify(firstPage) : JSON.stringify([target]);
   }
   if (args[0] === 'release' && args[1] === 'edit') { editedTags.push(args[2]); target.draft = false; return ''; }
   if (args[0] === 'release' && args[1] === 'create') { creates++; throw new Error('unexpected create'); }
   throw new Error(`unexpected gh call: ${args.join(' ')}`);
  };
  const readDistribution = () => ({ document, assetSha256: sha256(assetBytes) });
  assert.equal(publishDistribution(document, { assetPath, notesPath, gh, readDistribution }).status, 'PUBLISHED');
  assert.equal(creates, 0);
  assert.deepEqual(editedTags, [document.releaseTag]);
  assert.equal(listPages.filter(endpoint => endpoint.endsWith('page=1')).length, 2);
  assert.equal(listPages.filter(endpoint => endpoint.endsWith('page=2')).length, 2);
 } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
test('uncertain draft creation and publish are inspected, never submitted twice; conflict is preserved', () => {
 const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-publish-fixture-'));
 try {
  const document = buildDistribution(evidence()), assetPath = path.join(root, 'zylos-release.json'), notesPath = path.join(root, 'notes.md');
  const assetBytes = JSON.stringify(document); fs.writeFileSync(assetPath, assetBytes); fs.writeFileSync(notesPath, 'Fixture');
  let release = null; const mutations = []; const lookups = [];
  const gh = args => {
   if (args[0] === 'api') {
    lookups.push(args[1]);
    if (args[1].includes('/releases/tags/')) throw new Error('HTTP 404');
    if (args[1].includes('/releases?')) return JSON.stringify(release ? [release] : []);
   }
   mutations.push(args[1]);
   if (args[1] === 'create') { release = { id: 1, tag_name: document.releaseTag, draft: true }; throw new Error('uncertain connection'); }
   if (args[1] === 'edit') { release.draft = false; throw new Error('uncertain connection'); }
  };
  const readDistribution = () => ({ document, assetSha256: sha256(assetBytes) });
  assert.equal(publishDistribution(document, { assetPath, notesPath, gh, readDistribution }).status, 'PUBLISHED');
  assert.deepEqual(mutations, ['create', 'edit']);
  assert.equal(publishDistribution(document, { assetPath, notesPath, gh, readDistribution }).status, 'PUBLISHED');
  assert.deepEqual(mutations, ['create', 'edit']);
  assert.ok(lookups.some(endpoint => endpoint.includes('/releases?')));
  assert.throws(() => publishDistribution(document, { assetPath, notesPath, gh, readDistribution: () => ({ document, assetSha256: 'f'.repeat(64) }) }), /not overwritten/);
  assert.deepEqual(mutations, ['create', 'edit']);
 } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
test('publisher refuses to create when exact-tag draft discovery fails or conflicts', () => {
 const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-publish-list-fixture-'));
 try {
  const document = buildDistribution(evidence()), assetPath = path.join(root, 'asset'), bytes = JSON.stringify(document); fs.writeFileSync(assetPath, bytes);
  let creates = 0; const tag404 = () => { throw new Error('HTTP 404'); };
  const listingFailure = args => {
   if (args[0] === 'api' && args[1].includes('/releases/tags/')) throw new Error('HTTP 404');
   if (args[0] === 'api' && args[1].includes('/releases?')) throw new Error('HTTP 503');
   if (args[0] === 'release' && args[1] === 'create') creates++;
   throw new Error('unexpected gh call');
  };
  assert.throws(() => publishDistribution(document, { assetPath, gh: listingFailure, readDistribution: () => ({ document, assetSha256: sha256(bytes) }) }), /no publication attempted/);
  const conflictingListing = args => {
   if (args[0] === 'api' && args[1].includes('/releases/tags/')) return tag404();
   if (args[0] === 'api' && args[1].includes('/releases?')) return JSON.stringify([
    { id: 1, tag_name: document.releaseTag, draft: true }, { id: 2, tag_name: document.releaseTag, draft: true },
   ]);
   if (args[0] === 'release' && args[1] === 'create') creates++;
   throw new Error('unexpected gh call');
  };
  assert.throws(() => publishDistribution(document, { assetPath, gh: conflictingListing, readDistribution: () => ({ document, assetSha256: sha256(bytes) }) }), /Multiple GitHub releases/);
  assert.equal(creates, 0);
 } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
test('publication left as draft reports pending without retrying the mutation', () => {
 const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-pending-fixture-'));
 try {
  const document = distribution(), assetPath = path.join(root, 'asset'), bytes = JSON.stringify(document); fs.writeFileSync(assetPath, bytes);
  let edits = 0;
  const gh = args => { if (args[0] === 'api') return JSON.stringify({ id: 9, tag_name: document.releaseTag, draft: true }); edits++; throw new Error('offline'); };
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

test('qualification additions are monotonic: only a strict superset of the published matrix is accepted', () => {
 const published = distribution();
 const second = { ...distribution().qualifications[0],
  environment: { ...environment, runtime: environment.runtime === 'claude' ? 'codex' : 'claude' } };
 second.environmentFingerprint = qualificationFingerprint(second.environment);
 const extended = { ...published, qualifications: [published.qualifications[0], second] };
 extended.qualificationsSha256 = sha256(canonical(extended.qualifications));
 assert.equal(assertQualificationSuperset(published, extended), extended);
 for (const mutate of [
  x => { x.releaseId = 'other-release'; },
  x => { x.releaseTag = 'bundle-other'; },
  x => { x.bundle = { ...x.bundle, core: { ...x.bundle.core, sha: 'f'.repeat(40) } }; },
  x => { x.qualifications = [second]; },
  x => { x.qualifications = [{ ...x.qualifications[0], checkedAt: '2026-09-10T00:00:00.000Z' }, second]; },
  x => { x.qualifications = [x.qualifications[0]]; },
 ]) { const bad = structuredClone(extended); mutate(bad); assert.throws(() => assertQualificationSuperset(published, bad)); }
});
test('an appended qualification replaces the published asset and notes without touching the frozen bundle', () => {
 const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-append-fixture-'));
 try {
  const published = distribution();
  const second = { ...published.qualifications[0],
   environment: { ...environment, runtime: environment.runtime === 'claude' ? 'codex' : 'claude' } };
  second.environmentFingerprint = qualificationFingerprint(second.environment);
  const extended = { ...published, qualifications: [published.qualifications[0], second] };
  extended.qualificationsSha256 = sha256(canonical(extended.qualifications));
  const assetPath = path.join(root, 'zylos-release.json'), notesPath = path.join(root, 'release-notes.md');
  const bytes = JSON.stringify(extended); fs.writeFileSync(assetPath, bytes); fs.writeFileSync(notesPath, 'Reviewed notes');
  let live = JSON.stringify(published);
  const calls = [];
  const gh = args => {
   calls.push(args.join(' '));
   if (args[0] === 'api' && args[1].includes('/releases/tags/')) return JSON.stringify({ id: 5, tag_name: published.releaseTag, draft: false });
   if (args[0] === 'release' && args[1] === 'upload') { live = fs.readFileSync(args[3], 'utf8'); return ''; }
   if (args[0] === 'release' && args[1] === 'edit') return '';
   throw new Error(`unexpected gh call: ${args.join(' ')}`);
  };
  const readDistribution = () => ({ document: JSON.parse(live), assetSha256: sha256(live) });
  assert.equal(publishDistribution(extended, { assetPath, notesPath, appendQualifications: true, gh, readDistribution }).status, 'PUBLISHED');
  assert.deepEqual(calls, [`api repos/HeXiaobo/zylos-core/releases/tags/${published.releaseTag}`,
   `release upload ${published.releaseTag} ${assetPath} --clobber --repo HeXiaobo/zylos-core`,
   `release edit ${published.releaseTag} --repo HeXiaobo/zylos-core --notes-file ${notesPath}`,
   `api repos/HeXiaobo/zylos-core/releases/tags/${published.releaseTag}`]);
  // A non-superset addition is rejected before any mutation reaches GitHub.
  const conflicting = structuredClone(published); conflicting.qualifications = [second];
  conflicting.qualificationsSha256 = sha256(canonical(conflicting.qualifications));
  const conflictPath = path.join(root, 'conflict.json'); fs.writeFileSync(conflictPath, JSON.stringify(conflicting));
  const before = calls.length;
  assert.throws(() => publishDistribution(conflicting, { assetPath: conflictPath, notesPath, appendQualifications: true, gh, readDistribution }), /must keep every published qualification/);
  assert.equal(calls.length, before + 1);
  const basePath = path.join(root, 'published.json'); fs.writeFileSync(basePath, JSON.stringify(published));
  assert.throws(() => publishDistribution(published, { assetPath: basePath, appendQualifications: true, gh, readDistribution }), /reviewed notes/);
 } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
test('an uncovered host environment may deploy only through its own complete local evidence', () => {
 const uncovered = { ...environment, runtime: environment.runtime === 'claude' ? 'codex' : 'claude' };
 const document = distribution();
 const candidate = structuredClone(document.bundle); candidate.hxa.packageVersion = candidate.hxa.version; delete candidate.hxa.version;
 const base = () => ({ releaseId: 'uncovered-rollout', candidate, status: 'READY', deploymentAllowed: true,
  evidence: { canary: 'NOT_RUN' }, deploymentContract: { rolloutMode: 'CANARY' },
  distribution: { qualificationImported: false, environmentVerified: false, localEvidenceRequired: 'fully-local-canary',
   hostEnvironment: uncovered, hostEnvironmentFingerprint: qualificationFingerprint(uncovered) } });
 assert.throws(() => assertImportedQualification(base(), { host: uncovered }), /own local canary/);
 const ready = base(); ready.evidence.canary = 'PASS';
 assert.doesNotThrow(() => assertImportedQualification(ready, { host: uncovered }));
 for (const mutate of [
  x => { x.deploymentContract.rolloutMode = 'FLEET'; },
  x => { x.distribution.qualificationImported = true; },
  x => { x.distribution.localEvidenceRequired = 'published-version-evidence'; },
  x => { x.distribution.hostEnvironmentFingerprint = `sha256:${'a'.repeat(64)}`; },
  x => { x.distribution.hostEnvironment = environment; },
  x => { delete x.distribution.hostEnvironment; },
 ]) {
  const bad = base(); bad.evidence.canary = 'PASS'; mutate(bad);
  assert.throws(() => assertImportedQualification(bad, { host: uncovered }));
 }
 // A covered environment still has to import the published qualification first.
 const covered = base();
 covered.distribution = { releaseId: document.releaseId, qualificationImported: false, environmentVerified: true };
 assert.throws(() => assertImportedQualification(covered, { host: environment }), /must be imported before deployment/);
});

test('a published notes correction rewrites only the release body and keeps the asset frozen', () => {
 const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-notes-correction-fixture-'));
 try {
  const published = distribution();
  const assetPath = path.join(root, 'zylos-release.json'), notesPath = path.join(root, 'release-notes.md');
  const assetBytes = JSON.stringify(published) + '\n';
  const corrected = 'Corrected notes: the authoritative probe lives in tools/upgrade/functional-config-probe.mjs\n';
  fs.writeFileSync(assetPath, assetBytes); fs.writeFileSync(notesPath, corrected);
  const release = { id: 11, tag_name: published.releaseTag, draft: false, body: 'Original published notes\n' };
  const calls = [];
  const gh = args => {
   calls.push(args.join(' '));
   if (args[0] === 'api' && args[1].includes('/releases/tags/')) return JSON.stringify(release);
   if (args[0] === 'release' && args[1] === 'edit') { release.body = fs.readFileSync(args[args.indexOf('--notes-file') + 1], 'utf8'); return ''; }
   throw new Error(`unexpected gh call: ${args.join(' ')}`);
  };
  const readDistribution = () => ({ document: published, assetSha256: sha256(assetBytes) });
  const result = publishDistribution(published, { assetPath, notesPath, notesCorrection: true, gh, readDistribution });
  assert.equal(result.status, 'PUBLISHED');
  assert.equal(result.notesCorrected, true);
  assert.equal(result.notesCorrectedSha256, sha256(corrected));
  assert.equal(release.body, corrected);
  assert.deepEqual(calls, [`api repos/HeXiaobo/zylos-core/releases/tags/${published.releaseTag}`,
   `release edit ${published.releaseTag} --repo HeXiaobo/zylos-core --notes-file ${notesPath}`,
   `api repos/HeXiaobo/zylos-core/releases/tags/${published.releaseTag}`]);
  for (const call of calls) assert.ok(!call.startsWith('release upload'), 'a notes correction must never rewrite the asset');
  // The same body is not a correction, and both metadata changes never combine.
  fs.writeFileSync(notesPath, release.body);
  assert.throws(() => publishDistribution(published, { assetPath, notesPath, notesCorrection: true, gh, readDistribution }),
   /identical to the published notes/);
  fs.writeFileSync(notesPath, corrected);
  assert.throws(() => publishDistribution(published, { assetPath, notesPath, appendQualifications: true, notesCorrection: true, gh, readDistribution }),
   /cannot add a qualification/);
  assert.throws(() => publishDistribution(published, { assetPath, notesCorrection: true, gh, readDistribution }), /reviewed notes/);
  // Conflicting evidence is still refused before any mutation.
  const conflicting = structuredClone(published);
  conflicting.qualifications[0].sourceReportSha256 = sha256('another qualification report');
  conflicting.qualificationsSha256 = sha256(canonical(conflicting.qualifications));
  const conflictPath = path.join(root, 'conflict.json'); fs.writeFileSync(conflictPath, JSON.stringify(conflicting));
  const before = calls.length;
  assert.throws(() => publishDistribution(conflicting, { assetPath: conflictPath, notesPath, notesCorrection: true, gh, readDistribution }),
   /does not match prepared evidence/);
  assert.equal(calls.length, before + 1);
  // An unapplied correction is reported instead of a false success.
  release.body = 'Original published notes\n';
  const inert = args => (args[0] === 'api' ? JSON.stringify(release) : '');
  assert.throws(() => publishDistribution(published, { assetPath, notesPath, notesCorrection: true, gh: inert, readDistribution }),
   /do not match the reviewed correction/);
 } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
