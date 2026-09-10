import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveQualifiedRelease, readReleaseCatalog, readPublishedDistribution, canonical, sha256, validateDistribution } from '../../../tools/upgrade/release-channel.mjs';
import { bundle, distribution, catalog, environment } from './helpers/qualified-release-fixture.js';

test('default channel ignores a newer unqualified release and a newer RC', () => {
  const stable = distribution(), preview = distribution({ target: bundle('2.0.0-rc.1'), releaseTag: 'preview' });
  const fixture = catalog([stable, preview]);
  fixture.releases.push({ id: 3, tag_name: 'v99.0.0', draft: false, prerelease: false, assets: [] });
  const selected = resolveQualifiedRelease({ request: fixture.request });
  assert.equal(selected.target.version, '1.0.0');
  assert.equal(selected.source.ref, stable.bundle.core.sha);
  assert.equal(selected.source.policy, 'verified-stable');
  assert.ok(fixture.calls.every(x => !x.includes('/tags?') && !x.includes('/main')));
});
test('preview is explicit and exact versions never fall back', () => {
  const preview = distribution({ target: bundle('2.0.0-rc.2'), releaseTag: 'preview' });
  const fixture = catalog([distribution(), preview]);
  assert.equal(resolveQualifiedRelease({ request: fixture.request, channel: 'preview' }).target.version, '2.0.0-rc.2');
  assert.equal(resolveQualifiedRelease({ request: fixture.request, requested: 'v2.0.0-rc.2' }).target.version, '2.0.0-rc.2');
  assert.throws(() => resolveQualifiedRelease({ request: fixture.request, requested: '3.0.0' }), /No verified/);
});
test('all three repository selectors preserve unselected companions', () => {
  for (const component of ['core', 'feishu', 'hxa']) {
    const target = bundle(); target[component] = { ...target[component], version: '2.0.0', sha: 'a'.repeat(40) };
    const incompatible = structuredClone(target); incompatible[component === 'core' ? 'feishu' : 'core'].sha = 'b'.repeat(40);
    incompatible[component].version = '3.0.0'; incompatible[component].sha = 'c'.repeat(40);
    const fixture = catalog([distribution({ target }), distribution({ target: incompatible, releaseTag: 'incompatible' })]);
    assert.equal(resolveQualifiedRelease({ component, installed: bundle(), request: fixture.request }).target.version, '2.0.0');
    const all = resolveQualifiedRelease({ component, components: ['core', 'feishu', 'hxa'], request: fixture.request });
    assert.deepEqual(all.document.bundle, incompatible);
  }
});
test('a repeated component version resolves to the newest published bundle and reports the other commits', () => {
  const first = bundle(), second = structuredClone(first);
  second.core.sha = 'f'.repeat(40);
  const older = distribution({ target: first, releaseId: 'older', releaseTag: 'bundle-older' });
  const newer = distribution({ target: second, releaseId: 'newer', releaseTag: 'bundle-newer' });
  const fixture = catalog([older, newer]);
  const resolved = resolveQualifiedRelease({ request: fixture.request });
  assert.equal(resolved.source.ref, second.core.sha);
  assert.equal(resolved.source.releaseId, 'newer');
  assert.deepEqual(resolved.versionConflicts.map(x => x.releaseTag), ['bundle-older']);
  assert.equal(resolved.versionConflicts[0].sha, first.core.sha);
  // An exact version pin follows the same rule: the label is not an identity, so
  // the newest bundle published under it is the one that is installed.
  assert.equal(resolveQualifiedRelease({ request: fixture.request, requested: '1.0.0' }).source.ref, second.core.sha);
  // The rule is per component: a later bundle that changes only the selected
  // component's commit shadows the earlier one, and only that component's label
  // is reported as repeated.
  const third = structuredClone(second);
  third.feishu.sha = 'e'.repeat(40);
  const scopedFixture = catalog([older, newer, distribution({ target: third, releaseId: 'newest-feishu', releaseTag: 'bundle-newest-feishu' })]);
  const scoped = resolveQualifiedRelease({ component: 'feishu', installed: second, request: scopedFixture.request });
  assert.equal(scoped.source.ref, third.feishu.sha);
  assert.deepEqual(scoped.versionConflicts.map(x => x.releaseTag), ['bundle-newer']);
  // A release whose preserved companion commits differ from the installed ones
  // stays ineligible, so it is neither selected nor reported.
  const mismatched = structuredClone(second);
  mismatched.hxa = { ...mismatched.hxa, sha: 'd'.repeat(40) };
  const narrow = catalog([newer, distribution({ target: mismatched, releaseId: 'mismatched', releaseTag: 'bundle-mismatched' })]);
  const kept = resolveQualifiedRelease({ component: 'core', installed: second, request: narrow.request });
  assert.equal(kept.source.releaseId, 'newer');
  assert.deepEqual(kept.versionConflicts, []);
});
test('drafts, failed qualification, bad asset digests and moved tags cannot be selected', () => {
  for (const kind of ['draft', 'failed', 'digest', 'tag']) {
    const document = distribution();
    if (kind === 'failed') { document.qualifications[0].status = 'HOLD'; document.qualificationsSha256 = sha256(canonical(document.qualifications)); }
    const fixture = catalog([document]);
    if (kind === 'draft') fixture.releases[0].draft = true;
    if (kind === 'digest') fixture.releases[0].assets[0].digest = `sha256:${'0'.repeat(64)}`;
    if (kind === 'tag') fixture.paths['/repos/HeXiaobo/zylos-core/commits/bundle-fixture'] = JSON.stringify({ sha: 'f'.repeat(40) });
    assert.throws(() => resolveQualifiedRelease({ request: fixture.request }), /No verified/);
  }
});
test('qualified environment and bundle must match; arbitrary host fields cannot be published', () => {
  const document = distribution(), fixture = catalog([document]);
  assert.ok(resolveQualifiedRelease({ environment, request: fixture.request }).qualification);
  assert.throws(() => resolveQualifiedRelease({ environment: { ...environment, runtime: 'codex' }, request: fixture.request }), /No verified/);
  document.qualifications[0].environment.hostname = 'private-host';
  assert.throws(() => validateDistribution(document), /non-portable/);
});
test('release metadata errors and pagination limits fail before selecting an incomplete catalog', () => {
  assert.throws(() => readReleaseCatalog({ request: () => '{"message":"rate limited"}' }), /Invalid GitHub releases/);
  let calls = 0;
  assert.throws(() => readReleaseCatalog({ request: () => { calls++; return JSON.stringify(Array(100).fill({})); } }), /pagination limit/);
  assert.equal(calls, 100);
});
test('asset download uses a constructed repository endpoint instead of an untrusted URL', () => {
  const fixture = catalog([distribution()]);
  fixture.releases[0].assets[0].url = 'https://untrusted.invalid/secret';
  assert.equal(readPublishedDistribution(fixture.releases[0], { request: fixture.request }).assetId, 1);
  assert.ok(fixture.calls.every(x => x.startsWith('/repos/HeXiaobo/zylos-core/')));
});

test('asset transport failure stops selection instead of choosing an older release', () => {
 const fixture = catalog([distribution()]);
 const request = (endpoint, options) => {
  if (endpoint.includes('/assets/')) throw Object.assign(new Error('offline'), { code: 'RELEASE_TRANSPORT_ERROR' });
  return fixture.request(endpoint, options);
 };
 assert.throws(() => resolveQualifiedRelease({ request }), /offline/);
});
