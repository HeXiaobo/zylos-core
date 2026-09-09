import { canonical, sha256, REPOSITORIES, QUALIFICATION_GATE_VERSION, qualificationFingerprint } from '../../../../tools/upgrade/release-channel.mjs';

export const environment = {
  platform: process.platform, arch: process.arch, nodeMajor: Number(process.versions.node.split('.')[0]),
  runtime: 'claude', functionalConfigSha256: sha256('fixture functional configuration'),
};
export function bundle(version = '1.0.0') {
  return Object.fromEntries(Object.entries(REPOSITORIES).map(([name, repo], index) => [name, { repo, version, sha: String(index + 1).repeat(40) }]));
}
export function distribution({ target = bundle(), releaseId = 'fixture-release', releaseTag = 'bundle-fixture', env = environment } = {}) {
  const q = { schema: 'zylos.release-qualification/v1', releaseId, status: 'PASS', target,
    checkedAt: '2026-09-09T00:00:00.000Z', gateVersion: QUALIFICATION_GATE_VERSION,
    environment: structuredClone(env), environmentFingerprint: qualificationFingerprint(env),
    sourceReportSha256: sha256('fixture raw qualification'), finalGateSha256: sha256('fixture raw final gate') };
  return { schema: 'zylos.distribution-release/v1', releaseId, releaseTag, status: 'QUALIFIED',
    channel: Object.values(target).some(x => x.version.includes('-')) ? 'preview' : 'stable',
    bundle: target, qualifications: [q], qualificationsSha256: sha256(canonical([q])) };
}
export function catalog(documents) {
  const paths = {}, calls = [], releases = [];
  for (const [index, document] of documents.entries()) {
    const id = index + 1, bytes = JSON.stringify(document) + '\n';
    const release = { id, tag_name: document.releaseTag, draft: false, prerelease: document.channel === 'preview',
      published_at: `2026-09-09T00:${String(index).padStart(2, '0')}:00.000Z`,
      assets: [{ id, name: 'zylos-release.json', state: 'uploaded', size: Buffer.byteLength(bytes), digest: `sha256:${sha256(bytes)}` }] };
    releases.push(release);
    paths[`/repos/HeXiaobo/zylos-core/releases/assets/${id}`] = bytes;
    paths[`/repos/HeXiaobo/zylos-core/commits/${document.releaseTag}`] = JSON.stringify({ sha: document.bundle.core.sha });
  }
  const request = endpoint => {
    calls.push(endpoint);
    if (endpoint === '/repos/HeXiaobo/zylos-core/releases?per_page=100&page=1') return JSON.stringify(releases);
    if (!(endpoint in paths)) throw new Error(`Unexpected fixture request: ${endpoint}`);
    return paths[endpoint];
  };
  return { request, calls, paths, releases };
}
