#!/usr/bin/env node
// Import version-level evidence only. This never writes a host check as PASS
// and never promotes a deployment ledger to READY.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { canonical, canonicalBundle, qualificationFingerprint, sha256, validateDistribution, readReleaseHost } from './release-channel.mjs';
import { lockManifest, atomicWriteJson } from './governance/release-transaction.mjs';
import { GATE_VERSIONS, evidenceReferenceSha256, planEvidenceReuse } from './governance/evidence-reuse.mjs';

export function attachQualification(manifest, { assetPath, assetSha256, environment, evidenceDirectory }) {
  const bytes = fs.readFileSync(assetPath);
  if (sha256(bytes) !== assetSha256) throw new Error('Published qualification asset changed');
  const document = validateDistribution(JSON.parse(bytes));
  const bundle = canonicalBundle(manifest.candidate);
  if (canonical(bundle) !== canonical(document.bundle)) throw new Error('Published qualification belongs to a different component combination');
  const fingerprint = qualificationFingerprint(environment);
  const report = document.qualifications.find(q => q.environmentFingerprint === fingerprint);
  if (!report) throw new Error('This environment is not in the published qualification matrix; the publisher must validate it before rollout');
  if (report.gateVersion !== GATE_VERSIONS['canary.functional']) throw new Error('Qualification gate version changed');
  const reportPath = path.join(evidenceDirectory, 'release-qualification.json');
  const write = (file, value) => {
    const bytes = JSON.stringify(value, null, 2) + '\n';
    if (fs.existsSync(file)) {
      if (fs.readFileSync(file, 'utf8') !== bytes) throw new Error('Qualification evidence already exists with different content');
      return;
    }
    fs.writeFileSync(file, bytes, { flag: 'wx', mode: 0o600 });
  };
  write(reportPath, report);
  const record = {
    gate: 'canary.functional', gateVersion: report.gateVersion, inputs: bundle,
    environmentFingerprint: fingerprint, report: reportPath,
    reportSha256: sha256(fs.readFileSync(reportPath)),
  };
  record.referenceSha256 = evidenceReferenceSha256(record);
  const catalog = { schema: 'zylos.evidence-catalog/v1', records: [record] };
  const result = structuredClone(manifest);
  result.deploymentContract.rolloutMode = 'FLEET';
  result.evidenceReuse = { policyVersion: 1, environmentFingerprints: { 'canary.functional': fingerprint } };
  const plan = planEvidenceReuse({ manifest: result, catalog });
  if (plan.status !== 'PASS' || plan.decisions.find(x => x.gate === 'canary.functional')?.decision !== 'REUSED'
      || plan.decisions.find(x => x.gate === 'canary.hostSmoke')?.decision !== 'RUN') throw new Error('Published qualification could not be reused');
  const planPath = path.join(evidenceDirectory, 'evidence-reuse-plan.json');
  write(path.join(evidenceDirectory, 'evidence-catalog.json'), catalog);
  write(planPath, plan);
  result.evidenceReuse.plan = planPath;
  result.evidenceReuse.sha256 = sha256(fs.readFileSync(planPath));
  result.distribution = { ...result.distribution, qualificationImported: true, environmentFingerprint: fingerprint };
  return result;
}

export function assertImportedQualification(manifest, { host = readReleaseHost() } = {}) {
  if (!manifest.distribution) return; // Internal producer candidates use the existing canary workflow.
  const d = manifest.distribution;
  if (d.environmentVerified === false) {
    // A host environment no published qualification covers may still install the
    // verified bundle, but it may not reuse a single piece of the publisher's
    // evidence: the deployment contract stays on the local canary, the bound host
    // environment has to be the one preparing, and the local gates must run.
    if (d.qualificationImported === true) throw new Error('An uncovered host environment must not import published evidence');
    if (manifest.deploymentContract?.rolloutMode === 'FLEET') throw new Error('FLEET rollout requires a published qualification for this host environment');
    if (d.localEvidenceRequired !== 'fully-local-canary') throw new Error('An uncovered host environment must require the complete local evidence workflow');
    if (!d.hostEnvironment || qualificationFingerprint(d.hostEnvironment) !== d.hostEnvironmentFingerprint) throw new Error('Uncovered host environment descriptor is missing or inconsistent');
    if (!Object.entries(host).every(([key, value]) => d.hostEnvironment[key] === value)) throw new Error('Current host does not match the prepared uncovered environment');
    if (!manifest.evidence || manifest.evidence.canary !== 'PASS') throw new Error('An uncovered host environment must pass its own local canary before deployment');
    return;
  }
  if (d.qualificationImported !== true || manifest.deploymentContract?.rolloutMode !== 'FLEET') throw new Error('Published version qualification must be imported before deployment');
  const bytes = fs.readFileSync(d.assetPath);
  if (sha256(bytes) !== d.assetSha256) throw new Error('Published qualification asset changed');
  const document = validateDistribution(JSON.parse(bytes));
  if (document.releaseId !== d.releaseId || canonical(document.bundle) !== canonical(canonicalBundle(manifest.candidate))) throw new Error('Published qualification bundle changed');
  const q = document.qualifications.find(q => q.environmentFingerprint === d.environmentFingerprint);
  if (!q || !Object.entries(host).every(([key, value]) => q.environment[key] === value)) throw new Error('Current host does not match the imported qualification');
  const reuse = manifest.evidenceReuse, planBytes = fs.readFileSync(reuse.plan);
  if (sha256(planBytes) !== reuse.sha256) throw new Error('Evidence reuse plan changed');
  const plan = JSON.parse(planBytes), functional = plan.decisions.find(x => x.gate === 'canary.functional');
  if (plan.status !== 'PASS' || functional?.decision !== 'REUSED'
      || functional.environmentFingerprint !== d.environmentFingerprint
      || canonical(JSON.parse(fs.readFileSync(functional.report))) !== canonical(q)
      || plan.decisions.find(x => x.gate === 'canary.hostSmoke')?.decision !== 'RUN') throw new Error('Published qualification is not bound to the evidence reuse plan');
}

if (process.argv[1] && fs.existsSync(process.argv[1]) && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) {
  try {
    const args = process.argv.slice(2), options = {};
    for (let i = 0; i < args.length; i += 2) {
      if (!['--manifest', '--environment'].includes(args[i]) || !args[i + 1] || options[args[i]]) throw new Error('Usage: qualification.mjs --manifest FILE --environment VERIFIED_HOST_ENVIRONMENT_JSON');
      options[args[i]] = args[i + 1];
    }
    if (!options['--manifest'] || !options['--environment']) throw new Error('Both manifest and environment are required');
    const file = path.resolve(options['--manifest']);
    if (fs.lstatSync(file).isSymbolicLink()) throw new Error('Manifest symlinks are not supported');
    const unlock = lockManifest(file);
    try {
      const original = fs.readFileSync(file), manifest = JSON.parse(original);
      if (manifest.status !== 'HOLD' || manifest.deploymentAllowed !== false) throw new Error('Import only into an unpromoted, newly prepared ledger');
      const environment = JSON.parse(fs.readFileSync(options['--environment'], 'utf8'));
      if (manifest.distribution?.qualificationImported) {
        if (manifest.distribution.environmentFingerprint !== qualificationFingerprint(environment)) throw new Error('Already imported qualification belongs to a different environment');
        assertImportedQualification(manifest);
      } else {
        const result = attachQualification(manifest, {
          assetPath: manifest.distribution.assetPath, assetSha256: manifest.distribution.assetSha256,
          environment, evidenceDirectory: path.resolve(path.dirname(file), '../evidence'),
        });
        if (!original.equals(fs.readFileSync(file))) throw new Error('Ledger changed during qualification import');
        atomicWriteJson(file, result);
      }
      console.log(JSON.stringify({ status: 'VERSION_QUALIFICATION_IMPORTED', deploymentAllowed: false, hostChecks: 'NOT_RUN', manifest: file }));
    } finally { unlock(); }
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
