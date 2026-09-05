#!/usr/bin/env node

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

export const GATE_VERSIONS = Object.freeze({
  'source.core': 'source-v1',
  'source.feishu': 'source-v1',
  'source.hxa': 'source-v1',
  'pair.dryRun': 'pair-v1',
  'canary.functional': 'functional-canary-v2',
  'canary.hostSmoke': 'host-smoke-v1',
  'runtime.identity': 'runtime-identity-v1',
  'runtime.hxa.provenance': 'runtime-provenance-v1',
  'runtime.hxa.execute': 'hxa-execute-v1',
});

function readJson(filename) {
  return JSON.parse(fs.readFileSync(filename, 'utf8'));
}

function hashFile(filename) {
  return crypto.createHash('sha256').update(fs.readFileSync(filename)).digest('hex');
}

function componentInput(component, versionKey = 'version') {
  return {
    repo: component?.repo,
    version: component?.[versionKey],
    sha: component?.sha,
  };
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function sha256Text(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

export function evidenceReferenceSha256({ gate, gateVersion, inputs, environmentFingerprint, reportSha256 }) {
  return sha256Text(stableJson({ gate, gateVersion, inputs, environmentFingerprint, reportSha256 }));
}

function sameInputs(left, right) {
  return stableJson(left) === stableJson(right);
}

function matchingRecord(records, gate, inputs, environmentFingerprint) {
  return records.find(record =>
    record?.gate === gate &&
    record?.gateVersion === GATE_VERSIONS[gate] &&
    sameInputs(record?.inputs, inputs) &&
    record?.environmentFingerprint === environmentFingerprint
  );
}

function evaluateRecord(record) {
  if (!record) return { decision: 'RUN' };
  if (typeof record.report !== 'string' || !path.isAbsolute(record.report) || !fs.existsSync(record.report)) {
    return { decision: 'HOLD', reason: 'EVIDENCE_REPORT_UNAVAILABLE' };
  }
  if (typeof record.reportSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(record.reportSha256)) {
    return { decision: 'HOLD', reason: 'EVIDENCE_HASH_INVALID' };
  }
  if (hashFile(record.report) !== record.reportSha256) {
    return { decision: 'HOLD', reason: 'EVIDENCE_HASH_MISMATCH' };
  }
  const expectedReference = evidenceReferenceSha256(record);
  if (record.referenceSha256 !== expectedReference) {
    return { decision: 'HOLD', reason: 'EVIDENCE_REFERENCE_HASH_MISMATCH' };
  }
  return {
    decision: 'REUSED',
    report: record.report,
    reportSha256: record.reportSha256,
    referenceSha256: record.referenceSha256,
  };
}

function evaluateReleaseQualification(record, inputs) {
  const result = evaluateRecord(record);
  if (result.decision !== 'REUSED') return result;
  try {
    const report = readJson(record.report);
    if (
      report?.schema !== 'zylos.release-qualification/v1' ||
      report?.status !== 'PASS' ||
      !sameInputs(report?.target, inputs)
    ) {
      return { decision: 'HOLD', reason: 'RELEASE_QUALIFICATION_INVALID' };
    }
  } catch {
    return { decision: 'HOLD', reason: 'RELEASE_QUALIFICATION_INVALID' };
  }
  return result;
}

export function decideEvidenceReuse({ gate, gateVersion, inputs, environmentFingerprint, records, applicable = true }) {
  if (!applicable) return { decision: 'NOT_APPLICABLE' };
  if (gateVersion !== GATE_VERSIONS[gate]) return { decision: 'RUN', reason: 'GATE_VERSION_CHANGED' };
  if (typeof environmentFingerprint !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(environmentFingerprint)) {
    return { decision: 'RUN', reason: 'ENVIRONMENT_FINGERPRINT_MISSING' };
  }
  return evaluateRecord(matchingRecord(records, gate, inputs, environmentFingerprint));
}

function runtimeReference(gate, inputs, environmentFingerprint, runtimeReport, snapshotSha256) {
  const gateVersion = GATE_VERSIONS[gate];
  return {
    gate,
    gateVersion,
    inputs,
    environmentFingerprint,
    decision: 'REUSED',
    report: runtimeReport,
    reportSha256: snapshotSha256,
    referenceSha256: evidenceReferenceSha256({
      gate,
      gateVersion,
      inputs,
      environmentFingerprint,
      reportSha256: snapshotSha256,
    }),
  };
}

function runtimeDecisions(runtimeSnapshot, hxaCandidate, now, snapshotSha256, runtimeReport) {
  if (!runtimeSnapshot) return [];
  const observedAt = Date.parse(runtimeSnapshot.observedAt);
  const nowMs = Date.parse(now);
  const identity = runtimeSnapshot.identity;
  const identityValid =
    identity &&
    typeof identity.name === 'string' && identity.name.length > 0 &&
    typeof identity.profileId === 'string' && identity.profileId.length > 0 &&
    typeof identity.hostname === 'string' && identity.hostname.length > 0;
  const ageMs = nowMs - observedAt;
  const fresh = Number.isFinite(observedAt) && Number.isFinite(nowMs) && ageMs >= 0 && ageMs <= 300_000;
  if (!identityValid || !fresh) {
    const reason = !identityValid ? 'RUNTIME_IDENTITY_INVALID' : 'RUNTIME_SNAPSHOT_STALE';
    return [
      { gate: 'runtime.identity', gateVersion: GATE_VERSIONS['runtime.identity'], decision: 'HOLD', reason },
      { gate: 'runtime.hxa.provenance', gateVersion: GATE_VERSIONS['runtime.hxa.provenance'], decision: 'HOLD', reason },
      { gate: 'runtime.hxa.execute', gateVersion: GATE_VERSIONS['runtime.hxa.execute'], decision: 'HOLD', reason },
    ];
  }
  const observedHxa = componentInput(runtimeSnapshot.hxa, 'packageVersion');
  const exact = sameInputs(observedHxa, hxaCandidate) && runtimeSnapshot.hxa?.sourceMarkerStatus === 'PASS';
  const environmentFingerprint = `sha256:${sha256Text(stableJson(identity))}`;
  const shared = { runtimeTarget: identity, observedAt: runtimeSnapshot.observedAt };
  return [
    { ...runtimeReference('runtime.identity', identity, environmentFingerprint, runtimeReport, snapshotSha256), ...shared },
    exact
      ? { ...runtimeReference('runtime.hxa.provenance', observedHxa, environmentFingerprint, runtimeReport, snapshotSha256), ...shared }
      : { gate: 'runtime.hxa.provenance', gateVersion: GATE_VERSIONS['runtime.hxa.provenance'], decision: 'RUN', environmentFingerprint, ...shared },
    exact
      ? { gate: 'runtime.hxa.execute', gateVersion: GATE_VERSIONS['runtime.hxa.execute'], decision: 'NOT_APPLICABLE', reason: 'ALREADY_AT_IMMUTABLE_TARGET', inputs: observedHxa, environmentFingerprint, ...shared }
      : { gate: 'runtime.hxa.execute', gateVersion: GATE_VERSIONS['runtime.hxa.execute'], decision: 'RUN', reason: 'RUNTIME_NOT_AT_IMMUTABLE_TARGET', environmentFingerprint, ...shared },
  ];
}

export function planEvidenceReuse({ manifest, catalog, runtimeSnapshot = null, now = new Date().toISOString(), snapshotSha256 = null, runtimeReport = null }) {
  const records = catalog?.schema === 'zylos.evidence-catalog/v1' && Array.isArray(catalog.records)
    ? catalog.records
    : [];
  const core = componentInput(manifest?.candidate?.core);
  const feishu = componentInput(manifest?.candidate?.feishu);
  const hxa = componentInput(manifest?.candidate?.hxa, 'packageVersion');
  const immutableBundle = { core, feishu, hxa };
  const rolloutMode = manifest?.deploymentContract?.rolloutMode || 'CANARY';
  const requested = [
    ['source.core', core],
    ['source.feishu', feishu],
    ['source.hxa', hxa],
    ['pair.dryRun', { core, feishu }],
  ];
  const decisions = requested.map(([gate, inputs]) => {
    const gateVersion = GATE_VERSIONS[gate];
    const environmentFingerprint = manifest?.evidenceReuse?.environmentFingerprints?.[gate] || null;
    const result = decideEvidenceReuse({ gate, gateVersion, inputs, environmentFingerprint, records });
    return { gate, gateVersion, inputs, environmentFingerprint, ...result };
  });
  const qualificationFingerprint = manifest?.evidenceReuse?.environmentFingerprints?.['canary.functional'] || null;
  if (rolloutMode === 'CANARY') {
    decisions.push({
      gate: 'canary.functional',
      gateVersion: GATE_VERSIONS['canary.functional'],
      inputs: immutableBundle,
      environmentFingerprint: qualificationFingerprint,
      decision: 'RUN',
      reason: 'the canary host must qualify the immutable release once',
    });
  } else if (rolloutMode === 'FLEET') {
    const record = matchingRecord(records, 'canary.functional', immutableBundle, qualificationFingerprint);
    const result = evaluateReleaseQualification(record, immutableBundle);
    decisions.push({
      gate: 'canary.functional',
      gateVersion: GATE_VERSIONS['canary.functional'],
      inputs: immutableBundle,
      environmentFingerprint: qualificationFingerprint,
      ...(result.decision === 'RUN'
        ? { decision: 'HOLD', reason: 'RELEASE_QUALIFICATION_REQUIRED' }
        : result),
    });
  } else {
    decisions.push({
      gate: 'canary.functional',
      gateVersion: GATE_VERSIONS['canary.functional'],
      inputs: immutableBundle,
      environmentFingerprint: qualificationFingerprint,
      decision: 'HOLD',
      reason: 'ROLLOUT_MODE_INVALID',
    });
  }
  decisions.push({
    gate: 'canary.hostSmoke',
    gateVersion: GATE_VERSIONS['canary.hostSmoke'],
    inputs: immutableBundle,
    environmentFingerprint: manifest?.evidenceReuse?.environmentFingerprints?.['canary.hostSmoke'] || null,
    decision: 'RUN',
    reason: 'host identity, runtime, queue, and request binding are host-sensitive',
  });
  decisions.push(...runtimeDecisions(runtimeSnapshot, hxa, now, snapshotSha256, runtimeReport));
  return {
    schema: 'zylos.evidence-reuse-plan/v1',
    releaseId: manifest?.releaseId || null,
    rolloutMode,
    status: decisions.some(decision => decision.decision === 'HOLD') ? 'HOLD' : 'PASS',
    attemptPolicy: { maxAttempts: 2, onExhaustion: 'HOLD' },
    decisions,
  };
}

function option(args, name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

export function runCli(args = process.argv.slice(2)) {
  if (args[0] !== 'plan') throw new Error('Usage: evidence-reuse.mjs plan --manifest PATH --catalog PATH');
  const manifestPath = option(args, '--manifest');
  const catalogPath = option(args, '--catalog');
  if (!manifestPath || !catalogPath) throw new Error('Usage: evidence-reuse.mjs plan --manifest PATH --catalog PATH');
  const runtimePath = option(args, '--runtime');
  return planEvidenceReuse({
    manifest: readJson(manifestPath),
    catalog: readJson(catalogPath),
    runtimeSnapshot: runtimePath ? readJson(runtimePath) : null,
    snapshotSha256: runtimePath ? hashFile(runtimePath) : null,
    runtimeReport: runtimePath ? path.resolve(runtimePath) : null,
    now: option(args, '--now') || new Date().toISOString(),
  });
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.stdout.write(`${JSON.stringify(runCli(), null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 64;
  }
}
