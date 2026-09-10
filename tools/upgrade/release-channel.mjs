#!/usr/bin/env node
// Standalone on purpose: the fresh-install bootstrap can run this with Node
// before Zylos, a runtime, or an employee identity exists.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export const CATALOG_REPOSITORY = 'HeXiaobo/zylos-core';
export const RELEASE_ASSET = 'zylos-release.json';
export const QUALIFICATION_GATE_VERSION = 'functional-canary-v2';
// 'matched' selects only a release qualified for this exact host environment.
// 'newest-qualified' also serves a host environment the matrix does not cover yet;
// the consumer must then run its own complete local evidence workflow.
export const ENVIRONMENT_POLICIES = Object.freeze(['matched', 'newest-qualified']);
export const REPOSITORIES = Object.freeze({
  core: CATALOG_REPOSITORY,
  feishu: 'HeXiaobo/zylos-feishu',
  hxa: 'HeXiaobo/zylos-hxa-connect',
});
const SHA = /^[a-f0-9]{40}$/;
const HASH = /^[a-f0-9]{64}$/;
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
export const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  return JSON.stringify(value);
}
export function parseVersion(value) {
  const match = typeof value === 'string' && VERSION.exec(value);
  if (!match || (match[4] || '').split('.').some(x => /^0\d+$/.test(x))) throw new Error(`Invalid version: ${value}`);
  return { numbers: match.slice(1, 4).map(BigInt), pre: match[4]?.split('.') };
}
export function compareVersions(a, b) {
  const x = parseVersion(a), y = parseVersion(b);
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
export function componentForRepository(repo) {
  return Object.keys(REPOSITORIES).find(name => REPOSITORIES[name].toLowerCase() === String(repo).toLowerCase()) || null;
}
export function canonicalBundle(input) {
  return Object.fromEntries(Object.entries(REPOSITORIES).map(([name, repo]) => {
    const item = input?.[name], version = item?.version || item?.packageVersion;
    if (item?.repo !== repo || !SHA.test(item?.sha || '') || (item.version && item.packageVersion && item.version !== item.packageVersion)) throw new Error(`${name}: exact repository/version/full SHA required`);
    parseVersion(version);
    return [name, { repo, version, sha: item.sha }];
  }));
}
export function qualificationFingerprint(environment) {
  if (!environment || !['linux', 'darwin'].includes(environment.platform)
      || !['x64', 'arm64'].includes(environment.arch)
      || !Number.isInteger(environment.nodeMajor) || environment.nodeMajor < 20
      || !['claude', 'codex'].includes(environment.runtime)
      || !HASH.test(environment.functionalConfigSha256 || '')) {
    throw new Error('Qualification environment must identify platform, arch, Node major, runtime and functional configuration hash');
  }
  const allowed = ['platform', 'arch', 'nodeMajor', 'runtime', 'functionalConfigSha256'];
  if (Object.keys(environment).some(k => !allowed.includes(k))) throw new Error('Qualification environment contains non-portable fields');
  return `sha256:${sha256(canonical(environment))}`;
}
export function readReleaseHost({ runtimeRoot = process.env.ZYLOS_DIR || path.join(os.homedir(), 'zylos'), runtime } = {}) {
  if (!runtime) {
    const file = path.join(runtimeRoot, '.zylos/config.json');
    runtime = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')).runtime || 'claude' : 'claude';
  }
  if (!['claude', 'codex'].includes(runtime)) throw new Error('Unknown runtime for release compatibility');
  return { platform: process.platform, arch: process.arch, nodeMajor: Number(process.versions.node.split('.')[0]), runtime };
}
export function validateDistribution(document) {
  if (document?.schema !== 'zylos.distribution-release/v1' || document.status !== 'QUALIFIED'
      || typeof document.releaseId !== 'string' || !document.releaseId
      || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(document.releaseTag || '')) throw new Error('Invalid qualified release manifest');
  const bundle = canonicalBundle(document.bundle);
  if (canonical(bundle) !== canonical(document.bundle)) throw new Error('Release bundle must use canonical component identities');
  const preview = Object.values(bundle).some(x => parseVersion(x.version).pre);
  if (document.channel !== (preview ? 'preview' : 'stable')) throw new Error('Release channel disagrees with package versions');
  if (!Array.isArray(document.qualifications) || !document.qualifications.length) throw new Error('Release has no qualification matrix');
  const fingerprints = new Set();
  for (const q of document.qualifications) {
    if (q?.schema !== 'zylos.release-qualification/v1' || q.status !== 'PASS'
      || q.releaseId !== document.releaseId || canonical(q.target) !== canonical(bundle)
      || q.gateVersion !== QUALIFICATION_GATE_VERSION
      || q.environmentFingerprint !== qualificationFingerprint(q.environment)
      || !Number.isFinite(Date.parse(q.checkedAt))
      || !HASH.test(q.sourceReportSha256 || '') || !HASH.test(q.finalGateSha256 || '')) throw new Error('Release qualification is missing, failed or belongs to another bundle');
    if (fingerprints.has(q.environmentFingerprint)) throw new Error('Duplicate qualification environment');
    fingerprints.add(q.environmentFingerprint);
  }
  if (document.qualificationsSha256 !== sha256(canonical(document.qualifications))) throw new Error('Qualification hash mismatch');
  return document;
}

// Requests and asset paths are constructed locally, never taken from release
// notes. Credentials go through stdin and are never part of process arguments.
let cachedToken;
function token() {
  if (cachedToken !== undefined) return cachedToken;
  cachedToken = process.env.GH_TOKEN || process.env.GITHUB_TOKEN || '';
  if (!cachedToken) {
    try { cachedToken = execFileSync('gh', ['auth', 'token'], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { /* public access */ }
  }
  return cachedToken;
}
export function githubRequest(endpoint, { raw = false } = {}) {
  if (!endpoint.startsWith(`/repos/${CATALOG_REPOSITORY}/`)) throw new Error('Untrusted release endpoint');
  const headers = [`Accept: ${raw ? 'application/octet-stream' : 'application/vnd.github+json'}`];
  if (token()) headers.push(`Authorization: Bearer ${token()}`);
  try {
    return execFileSync('curl', ['-fsSL', '--connect-timeout', '10', '--max-time', '30', '-H', '@-', `https://api.github.com${endpoint}`], {
      input: headers.join('\n') + '\n', encoding: 'utf8', timeout: 35000,
      maxBuffer: 8 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch {
    throw Object.assign(new Error('Cannot read the verified release channel from GitHub. Retry when network access or API credentials are available; no source was selected.'), { code: 'RELEASE_TRANSPORT_ERROR' });
  }
}
export function readReleaseCatalog({ request = githubRequest } = {}) {
  const releases = [];
  for (let page = 1; page <= 100; page++) {
    const items = JSON.parse(request(`/repos/${CATALOG_REPOSITORY}/releases?per_page=100&page=${page}`));
    if (!Array.isArray(items)) throw new Error('Invalid GitHub releases response');
    releases.push(...items);
    if (items.length < 100) return releases;
  }
  throw new Error('Release catalog pagination limit reached; refusing an incomplete selection');
}
export function readPublishedDistribution(release, { request = githubRequest, allowDraft = false } = {}) {
  if ((!allowDraft && release?.draft !== false) || typeof release?.prerelease !== 'boolean'
      || (!allowDraft && !Number.isFinite(Date.parse(release.published_at)))) throw new Error('Release is not published');
  const assets = release.assets?.filter(x => x.name === RELEASE_ASSET) || [];
  if (assets.length !== 1) throw new Error('Release has no unique qualification asset');
  const asset = assets[0];
  if (!Number.isSafeInteger(asset.id) || asset.id <= 0 || asset.state !== 'uploaded'
      || !Number.isSafeInteger(asset.size) || asset.size <= 0 || asset.size > 256 * 1024
      || !/^sha256:[a-f0-9]{64}$/.test(asset.digest || '')) throw new Error('Qualification asset metadata is invalid');
  const bytes = request(`/repos/${CATALOG_REPOSITORY}/releases/assets/${asset.id}`, { raw: true });
  if (Buffer.byteLength(bytes) !== asset.size || `sha256:${sha256(bytes)}` !== asset.digest) throw new Error('Qualification asset digest mismatch');
  const document = validateDistribution(JSON.parse(bytes));
  if (document.releaseTag !== release.tag_name || release.prerelease !== (document.channel === 'preview')) throw new Error('Published release tag/channel disagrees with qualification');
  // Resolve annotated tags through GitHub's commit endpoint. The selected
  // runtime sources always remain the full SHAs in the qualified bundle.
  const commit = JSON.parse(request(`/repos/${CATALOG_REPOSITORY}/commits/${encodeURIComponent(release.tag_name)}`));
  if (commit.sha !== document.bundle.core.sha) throw new Error('Release tag no longer matches the qualified Core commit');
  return { document, assetBytes: bytes, releaseId: release.id, publishedAt: release.published_at, assetId: asset.id, assetSha256: sha256(bytes) };
}

export function resolveQualifiedRelease({ component = 'core', requested = 'latest', channel = 'stable', installed, environment, host,
  components = [component], versions = {}, environmentPolicy = 'matched', request = githubRequest } = {}) {
  if (!REPOSITORIES[component] || !['stable', 'preview'].includes(channel)
      || !ENVIRONMENT_POLICIES.includes(environmentPolicy)
      || !Array.isArray(components) || !components.length || components.some(x => !REPOSITORIES[x])) throw new Error('Invalid release selection scope/channel');
  const exact = requested === 'latest' ? null : requested.replace(/^v/, '');
  if (exact) parseVersion(exact);
  const allowPreview = channel === 'preview' || Boolean(exact && parseVersion(exact).pre);
  const baseline = installed ? canonicalBundle(installed) : null;
  const fingerprint = environment ? qualificationFingerprint(environment) : null;
  const requireMatchedEnvironment = environmentPolicy === 'matched';
  const skipped = [], eligible = [];
  const releases = readReleaseCatalog({ request });
  for (const release of releases) {
    if (release.draft || (!allowPreview && release.prerelease)) continue;
    if (!release.assets?.some(x => x.name === RELEASE_ASSET)) continue;
    let entry;
    try { entry = readPublishedDistribution(release, { request }); }
    catch (error) {
      if (error.code === 'RELEASE_TRANSPORT_ERROR') throw error;
      skipped.push({ tag: release.tag_name, reason: error.message });
      continue;
    }
    const { bundle } = entry.document;
    // Published qualification environments travel with the skip reason so a
    // blocked consumer can report which host environments the catalog covers.
    const environments = entry.document.qualifications.map(q => q.environment);
    if (host && !entry.document.qualifications.some(q => Object.entries(host).every(([key, value]) => q.environment[key] === value))) {
      skipped.push({ tag: release.tag_name, reason: 'Host platform/Node/runtime is outside the published qualification matrix', environments });
      if (requireMatchedEnvironment) continue;
    }
    if (fingerprint && !entry.document.qualifications.some(q => q.environmentFingerprint === fingerprint)) {
      skipped.push({ tag: release.tag_name, reason: 'Environment is outside the published qualification matrix', environments });
      if (requireMatchedEnvironment) continue;
    }
    if (exact && bundle[component].version !== exact) continue;
    if (Object.entries(versions).some(([name, value]) => value !== 'latest' && bundle[name]?.version !== value.replace(/^v/, ''))) continue;
    const preserved = Object.keys(REPOSITORIES).filter(name => !components.includes(name));
    if (baseline && preserved.some(name => canonical(bundle[name]) !== canonical(baseline[name]))) {
      skipped.push({ tag: release.tag_name, reason: 'Not qualified with the installed companion sources' });
      continue;
    }
    eligible.push(entry);
  }
  eligible.sort((a, b) => compareVersions(b.document.bundle[component].version, a.document.bundle[component].version)
    || Date.parse(b.publishedAt) - Date.parse(a.publishedAt));
  if (!eligible.length) {
    const error = new Error(`No verified ${allowPreview ? 'stable/preview' : 'stable'} release matches ${component} ${requested}${baseline && components.length < 3 ? ' with the installed companions' : ''}. The publisher must qualify a compatible release; no installation or fallback to tags/main was attempted.`);
    error.code = 'NO_QUALIFIED_RELEASE'; error.skipped = skipped;
    error.host = host || null; error.environmentFingerprint = fingerprint;
    throw error;
  }
  const chosen = eligible[0], target = chosen.document.bundle[component];
  if (eligible.some(x => x.document.bundle[component].version === target.version && x.document.bundle[component].sha !== target.sha)) throw new Error('Conflicting qualified commits for the same component version');
  // The chosen release is always a published, fully qualified bundle. Whether it
  // covers the consumer's own environment is reported separately: an uncovered
  // environment may still use the bundle, but only through complete local evidence.
  const hostQualification = host
    ? chosen.document.qualifications.find(q => Object.entries(host).every(([key, value]) => q.environment[key] === value)) : null;
  const qualification = fingerprint ? chosen.document.qualifications.find(q => q.environmentFingerprint === fingerprint) : null;
  return { ...chosen, component, target, skipped, environmentVerified: Boolean(hostQualification) && (!fingerprint || Boolean(qualification)),
    qualifiedEnvironments: chosen.document.qualifications.map(q => q.environment), environmentPolicy, qualification,
    source: {
    repo: target.repo, version: target.version, ref: target.sha,
    tag: chosen.document.releaseTag, policy: chosen.document.channel === 'preview' ? 'verified-preview' : 'verified-stable',
    releaseId: chosen.document.releaseId, qualificationAssetSha256: chosen.assetSha256,
  } };
}

if (process.argv[1] && fs.existsSync(process.argv[1]) && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) {
  try {
    const args = process.argv.slice(2), options = {};
    if (args.includes('--help')) {
      console.log('node release-channel.mjs [--component core|feishu|hxa] [--version latest|VERSION] [--channel stable|preview] [--runtime claude|codex] [--installed FILE] [--out FILE] [--sha-only]');
    } else {
      for (let i = 0; i < args.length; i++) {
        if (args[i] === '--sha-only') { options[args[i]] = true; continue; }
        if (!['--component', '--version', '--channel', '--runtime', '--installed', '--out'].includes(args[i]) || !args[i + 1] || args[i + 1].startsWith('--') || options[args[i]]) throw new Error('Invalid arguments; use --help');
        options[args[i]] = args[++i];
      }
      const result = resolveQualifiedRelease({ component: options['--component'], requested: options['--version'], channel: options['--channel'], host: readReleaseHost({ runtime: options['--runtime'] }), installed: options['--installed'] && JSON.parse(fs.readFileSync(options['--installed'], 'utf8')) });
      if (options['--out']) fs.writeFileSync(options['--out'], JSON.stringify(result, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
      console.log(options['--sha-only'] ? result.target.sha : JSON.stringify(result, null, 2));
    }
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
