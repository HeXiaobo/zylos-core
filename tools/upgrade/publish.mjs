#!/usr/bin/env node
// Publication is the final step, after a complete qualification matrix.
// A source tag alone is deliberately not an installable release channel.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  CATALOG_REPOSITORY, RELEASE_ASSET, QUALIFICATION_GATE_VERSION,
  canonical, canonicalBundle, qualificationFingerprint, sha256, parseVersion,
  validateDistribution, readPublishedDistribution,
} from './release-channel.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const read = filename => JSON.parse(fs.readFileSync(filename, 'utf8'));
const RELEASE_LIST_PAGE_SIZE = 100;
const RELEASE_LIST_MAX_PAGES = 100;
function sameBundle(gate, bundle) {
  return ['core', 'feishu', 'hxa'].every(name => gate?.candidateBundle?.[`${name}Sha`] === bundle[name].sha);
}
export function buildDistribution({ manifest, qualificationEntries, releaseTag }) {
  if (manifest.status !== 'READY' || manifest.deploymentAllowed !== true || manifest.evidence?.canary !== 'PASS'
      || manifest.evidence?.finalCanary?.status !== 'PASS' || manifest.holdReasons?.length) throw new Error('Publication requires a fully qualified release, not an installed-but-HOLD candidate');
  const bundle = canonicalBundle(manifest.candidate);
  if (!Array.isArray(qualificationEntries) || !qualificationEntries.length) throw new Error('Qualification matrix is required');
  const qualifications = qualificationEntries.map(({ report, reportBytes, finalGate, finalGateBytes }) => {
    if (report.schema !== 'zylos.release-qualification/v1' || report.status !== 'PASS'
        || report.releaseId !== manifest.releaseId || canonical(report.target) !== canonical(bundle)
        || report.failures?.length || report.gateVersion !== QUALIFICATION_GATE_VERSION
        || report.environmentFingerprint !== qualificationFingerprint(report.environment)) throw new Error('A qualification report is failed, incomplete, or for another bundle');
    if (finalGate.schema !== 'zylos.agent-preflight/v1' || finalGate.mode !== 'deploy'
        || finalGate.deploymentStage !== 'final' || finalGate.status !== 'PASS'
        || finalGate.releaseId !== manifest.releaseId || !sameBundle(finalGate, bundle)
        || finalGate.failures?.length || !finalGate.runtimeTarget) throw new Error('A successful final host gate bound to the exact bundle is required');
    if (canonical(JSON.parse(reportBytes)) !== canonical(report) || canonical(JSON.parse(finalGateBytes)) !== canonical(finalGate)) throw new Error('Qualification evidence bytes do not match parsed evidence');
    // Allowlist public fields. Host/profile IDs, messages, credentials, paths,
    // and arbitrary report extensions never leave the publisher's machine.
    return {
      schema: report.schema, releaseId: report.releaseId, status: 'PASS', target: bundle,
      checkedAt: report.checkedAt, gateVersion: report.gateVersion,
      environment: report.environment, environmentFingerprint: report.environmentFingerprint,
      sourceReportSha256: sha256(reportBytes), finalGateSha256: sha256(finalGateBytes),
    };
  });
  return validateDistribution({
    schema: 'zylos.distribution-release/v1', releaseId: manifest.releaseId, releaseTag,
    status: 'QUALIFIED', channel: Object.values(bundle).some(x => parseVersion(x.version).pre) ? 'preview' : 'stable',
    bundle, qualifications, qualificationsSha256: sha256(canonical(qualifications)),
  });
}

export function publishDistribution(document, { assetPath, notesPath, gh = args => execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }), readDistribution = readPublishedDistribution } = {}) {
  validateDistribution(document);
  const assetBytes = fs.readFileSync(assetPath, 'utf8');
  if (canonical(JSON.parse(assetBytes)) !== canonical(document)) throw new Error('Prepared publication asset changed');
  const tag = document.releaseTag;
  const isNotFound = error => /\b404\b/.test(String(error.stderr || error.message));
  const parseRelease = bytes => {
    const release = JSON.parse(bytes);
    if (!release || release.tag_name !== tag) throw new Error('GitHub release lookup returned a different tag');
    return release;
  };
  const findFromReleaseList = () => {
    const matches = [];
    for (let page = 1; page <= RELEASE_LIST_MAX_PAGES; page++) {
      let items;
      try {
        items = JSON.parse(gh(['api', `repos/${CATALOG_REPOSITORY}/releases?per_page=${RELEASE_LIST_PAGE_SIZE}&page=${page}`]));
      } catch (error) {
        throw new Error(`Unable to list GitHub releases while locating ${tag}; no publication attempted: ${error.message}`);
      }
      if (!Array.isArray(items)) throw new Error('Invalid GitHub releases response while locating an existing release');
      matches.push(...items.filter(release => release?.tag_name === tag));
      if (matches.length > 1) throw new Error(`Multiple GitHub releases found for tag ${tag}; publication aborted`);
      if (items.length < RELEASE_LIST_PAGE_SIZE) return matches[0] || null;
    }
    throw new Error('GitHub release listing pagination limit reached; refusing an incomplete release lookup');
  };
  const find = () => {
    try { return parseRelease(gh(['api', `repos/${CATALOG_REPOSITORY}/releases/tags/${tag}`])); }
    catch (error) {
      // GitHub's tag endpoint hides draft releases. Fall back to the
      // authenticated, bounded release listing so an existing draft can be
      // resumed without creating a second release for the same tag.
      if (isNotFound(error)) return findFromReleaseList();
      throw error;
    }
  };
  let release = find();
  if (!release) {
    // --verify-tag prevents gh from silently tagging a newer default branch.
    // Create a draft first, upload its asset, verify readback, publish last.
    try {
      gh(['release', 'create', tag, assetPath, '--repo', CATALOG_REPOSITORY, '--verify-tag', '--draft',
        '--title', `Zylos ${document.releaseId}`, '--notes-file', notesPath,
        ...(document.channel === 'preview' ? ['--prerelease'] : []), '--latest=false']);
    } catch {
      // Mutation result may be uncertain; inspect once, never create twice.
      release = find();
      if (!release) throw new Error('Release creation did not produce a verifiable draft; no publication attempted');
    }
    release ||= find();
  }
  if (!release) throw new Error('Release draft is unavailable');
  const observed = readDistribution(release, { allowDraft: true });
  if (observed.assetSha256 !== sha256(assetBytes) || canonical(observed.document) !== canonical(document)) throw new Error('Existing release does not match prepared evidence; it was not overwritten');
  if (release.draft) {
    try {
      gh(['release', 'edit', tag, '--repo', CATALOG_REPOSITORY, '--draft=false',
        `--latest=${document.channel === 'stable'}`]);
    } catch { /* inspect the same release below before deciding whether to retry */ }
  }
  const final = find();
  if (!final || final.draft) return { status: 'PUBLICATION_PENDING', releaseId: release.id, tag, runtimeMutation: false };
  const verified = readDistribution(final);
  if (verified.assetSha256 !== sha256(assetBytes)) throw new Error('Published release asset differs from prepared evidence');
  return { status: 'PUBLISHED', releaseId: final.id, tag, channel: document.channel,
    url: `https://github.com/${CATALOG_REPOSITORY}/releases/tag/${tag}`, runtimeMutation: false };
}

export function preparePublication(options) {
  const manifestPath = path.resolve(options['--manifest'] || '');
  const publicationManifestPath = path.resolve(options['--publication-manifest'] || '');
  const output = options['--out'];
  if (!options['--manifest'] || !options['--publication-manifest'] || !options['--qualifications'] || !options['--notes-file']
      || !path.isAbsolute(output || '') || !options['--tag']) throw new Error('External deployment/publication ledgers, qualification index, reviewed --notes-file, --tag and new absolute --out required');
  const repositoryRoot = path.resolve(HERE, '../..');
  for (const value of [manifestPath, publicationManifestPath, output]) {
    if (value === repositoryRoot || value.startsWith(repositoryRoot + path.sep)) throw new Error('Release metadata and publication output must be outside the source repository');
  }
  const reviewedNotes = fs.readFileSync(options['--notes-file'], 'utf8');
  if (!reviewedNotes.trim()) throw new Error('Reviewed release notes must document the tested functional configuration');
  const manifest = read(manifestPath), publication = read(publicationManifestPath);
  if (publication.releaseId !== manifest.releaseId || canonical(canonicalBundle(publication.candidate)) !== canonical(canonicalBundle(manifest.candidate))) throw new Error('Publication authorization belongs to another release');
  const index = read(options['--qualifications']);
  if (!Array.isArray(index)) throw new Error('Qualification index must be an array of report/finalGate absolute paths');
  const entries = index.map(item => {
    if (!path.isAbsolute(item.report || '') || !path.isAbsolute(item.finalGate || '')) throw new Error('Absolute qualification evidence paths required');
    const reportBytes = fs.readFileSync(item.report, 'utf8'), finalGateBytes = fs.readFileSync(item.finalGate, 'utf8');
    return { reportBytes, finalGateBytes, report: JSON.parse(reportBytes), finalGate: JSON.parse(finalGateBytes) };
  });
  const document = buildDistribution({ manifest, qualificationEntries: entries, releaseTag: options['--tag'] });
  const gateBytes = execFileSync(process.execPath, [path.join(HERE, 'governance/agent-preflight.mjs'), 'publish', '--manifest', publicationManifestPath], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  const gate = JSON.parse(gateBytes);
  if (gate.status !== 'PASS' || gate.mode !== 'publish' || gate.releaseId !== manifest.releaseId || !sameBundle(gate, document.bundle)) throw new Error('Publication gate did not authorize this exact bundle');
  fs.mkdirSync(output, { mode: 0o700 });
  const assetPath = path.join(output, RELEASE_ASSET), notesPath = path.join(output, 'release-notes.md');
  fs.writeFileSync(assetPath, JSON.stringify(document, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  fs.writeFileSync(notesPath, `Qualified ${document.channel} release.\n\n` + Object.entries(document.bundle).map(([name, value]) => `- ${name}: ${value.version} (${value.sha})`).join('\n') + '\n\nInstall or upgrade using the repository link and UPGRADE.md. Host backups and health checks still run locally.\n\n' + reviewedNotes + '\n', { flag: 'wx', mode: 0o600 });
  fs.writeFileSync(path.join(output, 'publication-gate.json'), gateBytes, { flag: 'wx', mode: 0o600 });
  return { document, assetPath, notesPath };
}

if (process.argv[1] && fs.existsSync(process.argv[1]) && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) {
  try {
    const args = process.argv.slice(2), options = {};
    if (args.includes('--help')) {
      console.log('node tools/upgrade/publish.mjs --manifest DEPLOYMENT_LEDGER --publication-manifest AUTHORIZED_PUBLICATION_LEDGER --qualifications EVIDENCE_INDEX --notes-file REVIEWED_NOTES --tag BUNDLE_TAG --out NEW_ABSOLUTE_DIRECTORY [--execute]');
    } else {
      for (let i = 0; i < args.length; i++) {
        if (args[i] === '--execute') { options[args[i]] = true; continue; }
        if (!['--manifest', '--publication-manifest', '--qualifications', '--notes-file', '--tag', '--out'].includes(args[i]) || !args[i + 1] || args[i + 1].startsWith('--') || options[args[i]]) throw new Error('Invalid arguments; use --help');
        options[args[i]] = args[++i];
      }
      const prepared = preparePublication(options);
      const result = options['--execute'] ? publishDistribution(prepared.document, prepared)
        : { status: 'PREPARED_FOR_PUBLICATION', assetPath: prepared.assetPath, channel: prepared.document.channel, published: false, runtimeMutation: false };
      console.log(JSON.stringify(result, null, 2));
    }
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
