import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const CLOSURE_SCHEMA = 'zylos.release-transaction-closure/v1';
export const PROOF_SCHEMA = 'zylos.release-transaction-proof/v1';
export const ISOLATION_SCHEMA = 'zylos.release-transaction-isolation/v1';

const RUNTIME_LOCK_NAME = 'release-governance.lock';

const FULL_HASH = /^[0-9a-f]{64}$/;
const MUTATION_PHASES = Object.freeze([
  Object.freeze({ key: 'hxa.execute', path: ['evidence', 'hxa', 'execute'] }),
  Object.freeze({ key: 'pair.execute', path: ['evidence', 'pairExecute'] }),
]);
const ROLLBACK_REPORT_SCHEMAS = Object.freeze({
  'hxa.execute': 'zylos.hxa-connect-rollback/v1',
  'pair.execute': 'zylos.fork-pair-rollback/v1',
});

function valueAt(object, segments) {
  return segments.reduce((value, segment) => value?.[segment], object);
}

function isObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function isAbsoluteFile(filename) {
  if (typeof filename !== 'string' || !path.isAbsolute(filename)) return false;
  try {
    return fs.statSync(filename).isFile();
  } catch {
    return false;
  }
}

function isoTimestamp(value) {
  if (typeof value !== 'string' || value.length === 0) return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (isObject(value)) {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function hashText(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

export function hashFile(filename) {
  return crypto.createHash('sha256').update(fs.readFileSync(filename)).digest('hex');
}

function expectedObservedStatus(stage) {
  if (!isObject(stage) || typeof stage.status !== 'string') return null;
  return stage.status;
}

function sameTarget(actual, expected, versionKey) {
  if (!isObject(actual) || !isObject(expected)) return false;
  return actual.repo === expected.repo &&
    actual.branch === expected.branch &&
    actual.sha === expected.sha &&
    actual[versionKey] === expected[versionKey];
}

function sameRuntimeTarget(actual, expected, versionKey) {
  if (!isObject(actual) || !isObject(expected)) return false;
  return actual.repo === expected.repo &&
    actual.sha === expected.sha &&
    actual[versionKey] === expected[versionKey];
}

function readJsonFile(filename, label, errors) {
  if (!isAbsoluteFile(filename)) {
    errors.push(`${label} must be an existing absolute path`);
    return null;
  }
  try {
    const value = JSON.parse(fs.readFileSync(filename, 'utf8'));
    if (!isObject(value)) errors.push(`${label} must contain a JSON object`);
    return isObject(value) ? value : null;
  } catch (error) {
    errors.push(`${label} is not valid JSON: ${error.message}`);
    return null;
  }
}

function noMutationPhase(key, stage, manifest, errors = []) {
  const observedStatus = expectedObservedStatus(stage);
  if (observedStatus === 'NOT_RUN') {
    if (key === 'pair.execute') {
      if (stage.releaseId !== manifest.releaseId) errors.push(`${key}.releaseId does not match manifest`);
      if (stage.executionId !== null) errors.push(`${key}.executionId must be null for NOT_RUN`);
      if (stage.report !== null) errors.push(`${key}.report must be null for NOT_RUN`);
    } else {
      if (!sameTarget(stage.target, manifest.candidate?.hxa, 'packageVersion')) {
        errors.push(`${key}.target does not match candidate HXA target`);
      }
      if (stage.executionId !== null) errors.push(`${key}.executionId must be null for NOT_RUN`);
      if (stage.report !== null) errors.push(`${key}.report must be null for NOT_RUN`);
    }
    return {
      phase: key,
      observedStatus,
      disposition: 'NO_MUTATION',
      reason: 'stage was not run',
    };
  }
  if (observedStatus === 'NOT_APPLICABLE' && stage?.result === 'ALREADY_AT_IMMUTABLE_TARGET') {
    if (key !== 'hxa.execute') errors.push(`${key}.NOT_APPLICABLE is not supported`);
    if (typeof stage.executionId !== 'string' || stage.executionId.length === 0) {
      errors.push(`${key}.executionId is required for NOT_APPLICABLE`);
    }
    if (!sameTarget(stage.target, manifest.candidate?.hxa, 'packageVersion')) {
      errors.push(`${key}.target does not match candidate HXA target`);
    }
    const report = readJsonFile(stage.report, `${key}.report`, errors);
    if (report) {
      if (report.status !== 'PASS') errors.push(`${key}.report.status must be PASS`);
      if (report.releaseId !== manifest.releaseId) errors.push(`${key}.report.releaseId does not match manifest`);
      if (report.executionId !== stage.executionId) errors.push(`${key}.report.executionId does not match stage`);
      if (report.result !== 'ALREADY_AT_IMMUTABLE_TARGET') errors.push(`${key}.report.result is invalid`);
      if (report.runtimeMutation !== 'none') errors.push(`${key}.report.runtimeMutation must be none`);
      if (!sameTarget(report.target, manifest.candidate?.hxa, 'packageVersion')) {
        errors.push(`${key}.report.target does not match candidate HXA target`);
      }
      if (report.observedRuntime?.status !== 'PASS' ||
          !sameRuntimeTarget(report.observedRuntime, manifest.candidate?.hxa, 'packageVersion')) {
        errors.push(`${key}.report.observedRuntime does not prove the candidate HXA target`);
      }
    }
    return {
      phase: key,
      observedStatus,
      disposition: 'NO_MUTATION',
      result: stage.result,
      reason: 'stage was already at the immutable target',
      evidence: report ? {
        executionId: stage.executionId,
        target: stage.target,
        report: stage.report,
        reportSha256: hashFile(stage.report),
      } : undefined,
    };
  }
  return null;
}

function expectedPhaseTarget(manifest, key, group) {
  if (key === 'hxa.execute') return manifest[group]?.hxa || null;
  return {
    core: manifest[group]?.core || null,
    feishu: manifest[group]?.feishu || null,
  };
}

function validateRollbackPhase(key, phase, stage, manifest, errors) {
  const observedStatus = expectedObservedStatus(stage);
  if (phase?.observedStatus !== observedStatus) {
    errors.push(`${key}.observedStatus does not match manifest (${observedStatus})`);
  }
  if (phase?.disposition !== 'ROLLED_BACK') {
    errors.push(`${key} must be NO_MUTATION or ROLLED_BACK`);
    return;
  }
  const rollback = phase.rollback;
  if (!isObject(rollback)) {
    errors.push(`${key}.rollback evidence is required for a rolled-back phase`);
    return;
  }
  if (rollback.status !== 'PASS' || rollback.verified !== true) {
    errors.push(`${key}.rollback must have status=PASS and verified=true`);
  }
  if (!isAbsoluteFile(rollback.report)) {
    errors.push(`${key}.rollback.report must be an existing absolute path`);
  } else {
    if (!FULL_HASH.test(rollback.reportSha256 || '')) {
      errors.push(`${key}.rollback.reportSha256 must be a 64-character lowercase SHA-256`);
    } else if (hashFile(rollback.report) !== rollback.reportSha256) {
      errors.push(`${key}.rollback.reportSha256 does not match the rollback report`);
    }
    try {
      const report = JSON.parse(fs.readFileSync(rollback.report, 'utf8'));
      if (!isObject(report) || report.status !== 'PASS') {
        errors.push(`${key}.rollback.report must be a structured PASS report`);
      } else {
        const expectedSchema = ROLLBACK_REPORT_SCHEMAS[key];
        if (report.schema !== expectedSchema) errors.push(`${key}.rollback.report.schema must be ${expectedSchema}`);
        if (report.releaseId !== manifest.releaseId) {
          errors.push(`${key}.rollback.report.releaseId does not match manifest`);
        }
        if (typeof stage?.executionId !== 'string' || stage.executionId.length === 0) {
          errors.push(`${key}.executionId is required for an executed phase`);
        } else if (report.executionId !== stage.executionId) {
          errors.push(`${key}.rollback.report.executionId does not match stage`);
        }
        if (report.result !== 'BASELINE_RESTORED' || report.verified !== true) {
          errors.push(`${key}.rollback.report must prove verified BASELINE_RESTORED`);
        }
        const attempted = expectedPhaseTarget(manifest, key, 'candidate');
        const restored = expectedPhaseTarget(manifest, key, 'stable');
        if (stableJson(report.attemptedTarget) !== stableJson(attempted)) {
          errors.push(`${key}.rollback.report.attemptedTarget does not match candidate`);
        }
        if (stableJson(report.restoredTarget) !== stableJson(restored)) {
          errors.push(`${key}.rollback.report.restoredTarget does not match stable target`);
        }
      }
    } catch (error) {
      errors.push(`${key}.rollback.report is not valid JSON: ${error.message}`);
    }
  }
}

function normalizeSuppliedProof(proof, manifest, errors) {
  if (!isObject(proof)) {
    errors.push('transaction proof must be an object');
    return null;
  }
  if (proof.schema !== PROOF_SCHEMA) errors.push(`transaction proof schema must be ${PROOF_SCHEMA}`);
  if (proof.releaseId !== manifest.releaseId) errors.push('transaction proof releaseId does not match manifest');
  if (!isoTimestamp(proof.checkedAt)) errors.push('transaction proof checkedAt must be a canonical ISO timestamp');
  if (!isObject(proof.activeExecution) || !['NOT_STARTED', 'NOT_RUNNING', 'ROLLED_BACK'].includes(proof.activeExecution.status)) {
    errors.push('transaction proof activeExecution.status must be NOT_STARTED, NOT_RUNNING, or ROLLED_BACK');
  }
  if (!isObject(proof.phases)) {
    errors.push('transaction proof phases is required');
    return null;
  }
  const expectedKeys = MUTATION_PHASES.map(phase => phase.key).sort();
  const actualKeys = Object.keys(proof.phases).sort();
  if (stableJson(expectedKeys) !== stableJson(actualKeys)) {
    errors.push(`transaction proof phases must contain exactly ${expectedKeys.join(', ')}`);
  }
  return proof;
}

/**
 * Build and validate the narrow proof needed before cancelling a release.
 * A no-op transaction can be proven from immutable manifest stage evidence;
 * an executed stage must carry an independently hashed PASS rollback report.
 */
export function buildMutationProof(manifest, suppliedProof = null) {
  const errors = [];
  const phases = {};
  const proof = suppliedProof ? normalizeSuppliedProof(suppliedProof, manifest, errors) : null;

  for (const { key, path: stagePath } of MUTATION_PHASES) {
    const stage = valueAt(manifest, stagePath);
    if (!isObject(stage) || typeof stage.status !== 'string') {
      errors.push(`${key} stage is required`);
      continue;
    }
    const noMutation = noMutationPhase(key, stage, manifest, errors);
    if (noMutation) {
      if (proof?.phases?.[key]) {
        const supplied = proof.phases[key];
        if (supplied.observedStatus !== noMutation.observedStatus) {
          errors.push(`${key}.observedStatus does not match manifest (${noMutation.observedStatus})`);
        }
        if (supplied.disposition !== 'NO_MUTATION') {
          errors.push(`${key} cannot be marked ROLLED_BACK when manifest proves no mutation`);
        }
        if (noMutation.observedStatus === 'NOT_APPLICABLE' && supplied.result !== noMutation.result) {
          errors.push(`${key}.result does not match the immutable-target result in the manifest`);
        }
        phases[key] = noMutation;
      } else {
        phases[key] = noMutation;
      }
      continue;
    }

    if (!proof) {
      errors.push(`${key} has status=${expectedObservedStatus(stage)}; independent fully rolled back evidence is required`);
      continue;
    }
    const supplied = proof.phases?.[key];
    if (!supplied) {
      errors.push(`${key} rollback proof is missing`);
      continue;
    }
    validateRollbackPhase(key, supplied, stage, manifest, errors);
    phases[key] = {
      phase: key,
      observedStatus: expectedObservedStatus(stage),
      disposition: supplied.disposition,
      rollback: supplied.rollback,
    };
  }

  if (proof) {
    const proofKeys = Object.keys(proof.phases || {}).sort();
    for (const key of proofKeys) {
      if (!MUTATION_PHASES.some(phase => phase.key === key)) errors.push(`unknown transaction proof phase: ${key}`);
    }
  }

  const hasRollback = MUTATION_PHASES.some(({ key }) => phases[key]?.disposition === 'ROLLED_BACK');
  const activeStatus = proof?.activeExecution?.status || 'NOT_STARTED';
  if (hasRollback && activeStatus !== 'ROLLED_BACK') {
    errors.push('transaction proof activeExecution.status must be ROLLED_BACK when a phase was rolled back');
  }
  if (!hasRollback && !['NOT_STARTED', 'NOT_RUNNING'].includes(activeStatus)) {
    errors.push('transaction proof activeExecution.status must be NOT_STARTED or NOT_RUNNING when no phase was rolled back');
  }

  const allSettled = errors.length === 0 && MUTATION_PHASES.every(({ key }) =>
    phases[key]?.disposition === 'NO_MUTATION' || phases[key]?.disposition === 'ROLLED_BACK',
  );
  if (!allSettled && errors.length === 0) errors.push('all mutation phases must be settled');
  if (errors.length > 0) {
    const error = new Error(errors.join('; '));
    error.code = 'TRANSACTION_CLOSURE_UNPROVEN';
    error.failures = errors;
    throw error;
  }

  return {
    schema: PROOF_SCHEMA,
    status: 'PASS',
    checkedAt: proof?.checkedAt || new Date().toISOString(),
    activeExecution: proof?.activeExecution || {
      status: 'NOT_STARTED',
      source: 'immutable manifest mutation-stage evidence',
    },
    phases,
    allSettled: true,
  };
}

function closureCoreFields(closure) {
  return {
    schema: closure.schema,
    closureId: closure.closureId,
    releaseId: closure.releaseId,
    action: closure.action,
    previous: closure.previous,
    result: closure.result,
    reason: closure.reason,
    authorization: closure.authorization,
    closedAt: closure.closedAt,
    mutationProof: closure.mutationProof,
    transactionIsolation: closure.transactionIsolation,
    manifestPreimage: closure.manifestPreimage,
    generatedBy: closure.generatedBy,
  };
}

export function validateClosureRecord(closure, { manifest = null, manifestPath = null, requireReport = true } = {}) {
  const failures = [];
  if (!isObject(closure)) return { valid: false, failures: ['transactionClosure is required'] };
  if (closure.schema !== CLOSURE_SCHEMA) failures.push(`transactionClosure.schema must be ${CLOSURE_SCHEMA}`);
  if (typeof closure.closureId !== 'string' || closure.closureId.length === 0) failures.push('transactionClosure.closureId is required');
  if (closure.action !== 'CANCEL') failures.push('transactionClosure.action must be CANCEL');
  if (manifest && closure.releaseId !== manifest.releaseId) failures.push('transactionClosure.releaseId does not match releaseId');
  if (closure.previous?.status !== 'READY') failures.push('transactionClosure.previous.status must be READY');
  if (closure.previous?.deploymentAllowed !== true) failures.push('transactionClosure.previous.deploymentAllowed must be true');
  if (closure.result?.status !== 'CANCELLED') failures.push('transactionClosure.result.status must be CANCELLED');
  if (closure.result?.deploymentAllowed !== false) failures.push('transactionClosure.result.deploymentAllowed must be false');
  if (closure.result?.publicationAllowed !== false) failures.push('transactionClosure.result.publicationAllowed must be false');
  if (typeof closure.reason !== 'string' || closure.reason.trim().length === 0) failures.push('transactionClosure.reason is required');
  if (!isObject(closure.authorization)) failures.push('transactionClosure.authorization is required');
  if (closure.authorization?.identity !== 'user') failures.push('transactionClosure.authorization.identity must be user');
  if (typeof closure.authorization?.authorizedBy !== 'string' || closure.authorization.authorizedBy.trim().length === 0) {
    failures.push('transactionClosure.authorization.authorizedBy is required');
  }
  if (typeof closure.authorization?.reference !== 'string' || closure.authorization.reference.trim().length === 0) {
    failures.push('transactionClosure.authorization.reference is required');
  }
  if (!isoTimestamp(closure.closedAt)) failures.push('transactionClosure.closedAt must be a canonical ISO timestamp');
  if (!isObject(closure.generatedBy) || closure.generatedBy.command !== 'governance/close-release.mjs') {
    failures.push('transactionClosure.generatedBy.command is invalid');
  }
  const preimage = closure.manifestPreimage;
  if (!isObject(preimage)) {
    failures.push('transactionClosure.manifestPreimage is required');
  } else {
    if (!isAbsoluteFile(preimage.path)) failures.push('transactionClosure.manifestPreimage.path must be an existing absolute path');
    if (!FULL_HASH.test(preimage.sha256 || '')) failures.push('transactionClosure.manifestPreimage.sha256 is invalid');
    if (manifestPath && path.resolve(preimage.manifestPath || '') !== path.resolve(manifestPath)) {
      failures.push('transactionClosure.manifestPreimage.manifestPath does not match inspected manifest');
    }
    if (isAbsoluteFile(preimage.path) && FULL_HASH.test(preimage.sha256 || '')) {
      if (hashFile(preimage.path) !== preimage.sha256) {
        failures.push('transactionClosure.manifestPreimage.sha256 does not match snapshot');
      }
      try {
        const snapshot = JSON.parse(fs.readFileSync(preimage.path, 'utf8'));
        if (!isObject(snapshot) || snapshot.releaseId !== closure.releaseId || snapshot.status !== 'READY' || snapshot.deploymentAllowed !== true) {
          failures.push('transactionClosure.manifestPreimage snapshot is not the previous READY release');
        }
      } catch (error) {
        failures.push(`transactionClosure.manifestPreimage snapshot is not valid JSON: ${error.message}`);
      }
    }
  }
  const proof = closure.mutationProof;
  if (!isObject(proof) || proof.schema !== PROOF_SCHEMA || proof.status !== 'PASS' || proof.allSettled !== true) {
    failures.push('transactionClosure.mutationProof must be a PASS proof with allSettled=true');
  }
  const isolation = closure.transactionIsolation;
  if (!isObject(isolation) || isolation.schema !== ISOLATION_SCHEMA || isolation.status !== 'PASS') {
    failures.push(`transactionClosure.transactionIsolation must be a PASS ${ISOLATION_SCHEMA} record`);
  } else {
    if (!path.isAbsolute(isolation.runtimeRoot || '')) failures.push('transactionClosure.transactionIsolation.runtimeRoot must be absolute');
    if (!path.isAbsolute(isolation.lockRoot || '')) failures.push('transactionClosure.transactionIsolation.lockRoot must be absolute');
    if (isolation.lockName !== RUNTIME_LOCK_NAME) failures.push(`transactionClosure.transactionIsolation.lockName must be ${RUNTIME_LOCK_NAME}`);
    if (!FULL_HASH.test(isolation.lockTokenSha256 || '')) failures.push('transactionClosure.transactionIsolation.lockTokenSha256 is invalid');
    if (!isoTimestamp(isolation.checkedAt)) failures.push('transactionClosure.transactionIsolation.checkedAt must be a canonical ISO timestamp');
    if (!Array.isArray(isolation.otherEntries) || isolation.otherEntries.length !== 0) failures.push('transactionClosure.transactionIsolation.otherEntries must be empty');
    if (!Array.isArray(isolation.activeProcesses) || isolation.activeProcesses.length !== 0) failures.push('transactionClosure.transactionIsolation.activeProcesses must be empty');
  }
  if (isObject(proof)) {
    if (!isoTimestamp(proof.checkedAt)) failures.push('transactionClosure.mutationProof.checkedAt must be a canonical ISO timestamp');
    if (!isObject(proof.activeExecution) || !['NOT_STARTED', 'NOT_RUNNING', 'ROLLED_BACK'].includes(proof.activeExecution.status)) {
      failures.push('transactionClosure.mutationProof.activeExecution.status is invalid');
    }
    const proofKeys = Object.keys(proof.phases || {}).sort();
    const expectedKeys = MUTATION_PHASES.map(item => item.key).sort();
    if (stableJson(proofKeys) !== stableJson(expectedKeys)) {
      failures.push(`transactionClosure.mutationProof.phases must contain exactly ${expectedKeys.join(', ')}`);
    }
    for (const { key } of MUTATION_PHASES) {
      const phase = proof.phases?.[key];
      if (!isObject(phase)) {
        failures.push(`transactionClosure.mutationProof.phases.${key} is required`);
        continue;
      }
      if (phase.phase !== key) failures.push(`transactionClosure.mutationProof.phases.${key}.phase is invalid`);
      if (!['NO_MUTATION', 'ROLLED_BACK'].includes(phase.disposition)) {
        failures.push(`transactionClosure.mutationProof.phases.${key}.disposition is invalid`);
      }
      if (phase.disposition === 'NO_MUTATION' && !['NOT_RUN', 'NOT_APPLICABLE'].includes(phase.observedStatus)) {
        failures.push(`transactionClosure.mutationProof.phases.${key} NO_MUTATION status is invalid`);
      }
      if (phase.disposition === 'NO_MUTATION' && phase.observedStatus === 'NOT_APPLICABLE' && phase.result !== 'ALREADY_AT_IMMUTABLE_TARGET') {
        failures.push(`transactionClosure.mutationProof.phases.${key} NOT_APPLICABLE result is invalid`);
      }
      if (manifest) {
        const definition = MUTATION_PHASES.find(item => item.key === key);
        const stage = valueAt(manifest, definition.path);
        const observedStatus = expectedObservedStatus(stage);
        if (observedStatus === null) {
          failures.push(`transactionClosure.mutationProof.phases.${key} manifest stage is required`);
          continue;
        }
        if (phase.observedStatus !== observedStatus) {
          failures.push(`transactionClosure.mutationProof.phases.${key}.observedStatus does not match manifest (${observedStatus})`);
        }
        const phaseErrors = [];
        const expectedNoMutation = noMutationPhase(key, stage, manifest, phaseErrors);
        for (const failure of phaseErrors) failures.push(`transactionClosure.mutationProof.phases.${key} ${failure}`);
        if (phase.disposition === 'NO_MUTATION' && expectedNoMutation === null) {
          failures.push(`transactionClosure.mutationProof.phases.${key} claims NO_MUTATION for an executed stage`);
        }
        if (phase.disposition === 'NO_MUTATION' && expectedNoMutation && stableJson(phase) !== stableJson(expectedNoMutation)) {
          failures.push(`transactionClosure.mutationProof.phases.${key} does not match canonical no-mutation evidence`);
        }
        if (phase.disposition === 'ROLLED_BACK') {
          validateRollbackPhase(key, phase, stage, manifest, failures);
        }
      } else if (phase.disposition === 'ROLLED_BACK' && (!isObject(phase.rollback) || phase.rollback.status !== 'PASS' || phase.rollback.verified !== true)) {
        failures.push(`transactionClosure.mutationProof.phases.${key} rollback is not verified`);
      }
    }
    const hasRollback = MUTATION_PHASES.some(({ key }) => proof.phases?.[key]?.disposition === 'ROLLED_BACK');
    if (hasRollback && proof.activeExecution?.status !== 'ROLLED_BACK') {
      failures.push('transactionClosure.mutationProof.activeExecution.status must be ROLLED_BACK when a phase was rolled back');
    }
    if (!hasRollback && !['NOT_STARTED', 'NOT_RUNNING'].includes(proof.activeExecution?.status)) {
      failures.push('transactionClosure.mutationProof.activeExecution.status must be NOT_STARTED or NOT_RUNNING when no phase was rolled back');
    }
  }
  if (requireReport) {
    if (!isObject(closure.report)) {
      failures.push('transactionClosure.report is required');
    } else {
      if (!isAbsoluteFile(closure.report.path)) failures.push('transactionClosure.report.path must be an existing absolute path');
      if (!FULL_HASH.test(closure.report.sha256 || '')) failures.push('transactionClosure.report.sha256 is invalid');
      if (isAbsoluteFile(closure.report.path) && FULL_HASH.test(closure.report.sha256 || '')) {
        if (hashFile(closure.report.path) !== closure.report.sha256) failures.push('transactionClosure.report.sha256 does not match report');
        try {
          const report = JSON.parse(fs.readFileSync(closure.report.path, 'utf8'));
          if (!isObject(report) || report.schema !== CLOSURE_SCHEMA || report.closureId !== closure.closureId || report.releaseId !== closure.releaseId) {
            failures.push('transactionClosure.report content is not bound to the closure');
          }
          const expected = closureCoreFields(closure);
          const actual = isObject(report) ? closureCoreFields(report) : null;
          if (stableJson(actual) !== stableJson(expected)) failures.push('transactionClosure.report body does not match manifest closure');
          if (isObject(report?.manifest)) {
            if (report.manifest.path !== closure.manifestPreimage?.manifestPath) {
              failures.push('transactionClosure.report manifest path does not match manifest preimage');
            }
            if (report.manifest.beforeSha256 !== closure.manifestPreimage?.sha256) {
              failures.push('transactionClosure.report beforeSha256 does not match manifest preimage');
            }
            if (report.manifest.snapshot !== closure.manifestPreimage?.path) {
              failures.push('transactionClosure.report snapshot does not match manifest preimage');
            }
          } else {
            failures.push('transactionClosure.report manifest preimage binding is required');
          }
        } catch (error) {
          failures.push(`transactionClosure.report is not valid JSON: ${error.message}`);
        }
      }
    }
  }
  return { valid: failures.length === 0, failures };
}

function ensureRequiredText(value, label) {
  if (typeof value !== 'string' || value.trim().length === 0) throw new Error(`${label} is required`);
  return value.trim();
}

function safeReleaseId(releaseId) {
  return String(releaseId || 'release').replace(/[^A-Za-z0-9._-]+/g, '_');
}

export function defaultReportPath(manifestPath, releaseId) {
  return path.join(path.dirname(manifestPath), 'evidence', safeReleaseId(releaseId), 'transaction-closure.json');
}

export function atomicWriteJson(filename, value, { exclusive = false } = {}) {
  const resolved = path.resolve(filename);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  if (exclusive && fs.existsSync(resolved)) throw new Error(`refusing to overwrite existing evidence report: ${resolved}`);
  const temporary = path.join(path.dirname(resolved), `.${path.basename(resolved)}.${process.pid}.${crypto.randomUUID()}.tmp`);
  let descriptor;
  try {
    descriptor = fs.openSync(temporary, 'wx', 0o600);
    fs.writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    if (exclusive) {
      try {
        fs.linkSync(temporary, resolved);
      } catch (error) {
        if (error.code === 'EEXIST') throw new Error(`refusing to overwrite existing evidence report: ${resolved}`);
        throw error;
      }
      fs.unlinkSync(temporary);
    } else {
      fs.renameSync(temporary, resolved);
    }
    try {
      const directory = fs.openSync(path.dirname(resolved), 'r');
      fs.fsyncSync(directory);
      fs.closeSync(directory);
    } catch {
      // Directory fsync is not available on every supported filesystem.
    }
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
  return resolved;
}

function atomicWriteBytes(filename, bytes, { exclusive = false } = {}) {
  const resolved = path.resolve(filename);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  if (exclusive && fs.existsSync(resolved)) throw new Error(`refusing to overwrite existing evidence file: ${resolved}`);
  const temporary = path.join(path.dirname(resolved), `.${path.basename(resolved)}.${process.pid}.${crypto.randomUUID()}.tmp`);
  let descriptor;
  try {
    descriptor = fs.openSync(temporary, 'wx', 0o600);
    fs.writeFileSync(descriptor, bytes);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    if (exclusive) {
      try {
        fs.linkSync(temporary, resolved);
      } catch (error) {
        if (error.code === 'EEXIST') throw new Error(`refusing to overwrite existing evidence file: ${resolved}`);
        throw error;
      }
      fs.unlinkSync(temporary);
    } else {
      fs.renameSync(temporary, resolved);
    }
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
  return resolved;
}

export function lockManifest(manifestPath) {
  const lockPath = `${manifestPath}.lock`;
  let descriptor;
  try {
    descriptor = fs.openSync(lockPath, 'wx', 0o600);
    fs.writeFileSync(descriptor, `${JSON.stringify({ pid: process.pid, manifest: manifestPath, acquiredAt: new Date().toISOString() })}\n`);
    fs.fsyncSync(descriptor);
    return () => {
      fs.closeSync(descriptor);
      fs.unlinkSync(lockPath);
    };
  } catch (error) {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    if (error.code === 'EEXIST') throw new Error(`release manifest is locked by another transaction: ${lockPath}`);
    throw error;
  }
}

function ensureRealDirectory(directoryPath) {
  fs.mkdirSync(directoryPath, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(directoryPath);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`runtime lock root is not a real directory: ${directoryPath}`);
  }
}

function scanUpgradeProcesses(runtimeRoot) {
  let output;
  try {
    output = execFileSync('ps', ['-eo', 'pid=,args='], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    throw new Error(`cannot inspect active upgrade processes: ${error.message}`);
  }
  const pattern = /(?:upgrade-fork-pair|upgrade-hxa-connect|restore-hxa-connect|restore-ss-upgrade-blockers)\.(?:js|sh)|agent-preflight\.mjs\s+deploy|(?:^|\s)zylos(?:\.js)?\s+upgrade/;
  const matches = [];
  for (const line of output.split(/\r?\n/)) {
    const match = line.trim().match(/^(\d+)\s+(.+)$/);
    if (!match) continue;
    const pid = Number(match[1]);
    const command = match[2];
    if (pid === process.pid || pid === process.ppid) continue;
    if (!pattern.test(command)) continue;
    if (!command.includes(runtimeRoot)) continue;
    matches.push({ pid, command });
  }
  return matches;
}

export function inspectRuntimeIsolation(runtimeRoot, lock) {
  const lockRoot = path.join(runtimeRoot, '.zylos', 'locks');
  ensureRealDirectory(lockRoot);
  const entries = fs.readdirSync(lockRoot).sort();
  const otherEntries = entries.filter(entry => entry !== lock?.name);
  if (otherEntries.length > 0) {
    throw new Error(`concurrent runtime lock detected: ${otherEntries.join(', ')}`);
  }
  const activeProcesses = scanUpgradeProcesses(runtimeRoot);
  if (activeProcesses.length > 0) {
    throw new Error(`active upgrade process detected: ${activeProcesses.map(item => `${item.pid}:${item.command}`).join(', ')}`);
  }
  return {
    schema: ISOLATION_SCHEMA,
    status: 'PASS',
    runtimeRoot,
    lockRoot,
    lockName: lock?.name || RUNTIME_LOCK_NAME,
    lockTokenSha256: lock ? hashText(lock.token) : hashText('dry-run-no-lock'),
    checkedAt: new Date().toISOString(),
    otherEntries: [],
    activeProcesses: [],
  };
}

export function acquireRuntimeTransactionLock(runtimeRoot) {
  const lockRoot = path.join(runtimeRoot, '.zylos', 'locks');
  ensureRealDirectory(lockRoot);
  const existing = fs.readdirSync(lockRoot).sort();
  if (existing.length > 0) throw new Error(`concurrent runtime lock detected: ${existing.join(', ')}`);
  const lockPath = path.join(lockRoot, RUNTIME_LOCK_NAME);
  const token = crypto.randomUUID();
  try {
    fs.mkdirSync(lockPath, { mode: 0o700 });
    atomicWriteJson(path.join(lockPath, 'owner.json'), {
      schema: ISOLATION_SCHEMA,
      pid: process.pid,
      token,
      acquiredAt: new Date().toISOString(),
      runtimeRoot,
    }, { exclusive: true });
  } catch (error) {
    if (error.code === 'EEXIST') throw new Error(`release transaction lock is already held: ${lockPath}`);
    throw error;
  }
  return {
    name: RUNTIME_LOCK_NAME,
    path: lockPath,
    token,
    release() {
      const ownerPath = path.join(lockPath, 'owner.json');
      const owner = JSON.parse(fs.readFileSync(ownerPath, 'utf8'));
      if (owner.pid !== process.pid || owner.token !== token) {
        throw new Error('release transaction lock ownership changed before release');
      }
      fs.unlinkSync(ownerPath);
      fs.rmdirSync(lockPath);
    },
  };
}

export function closeRelease({
  manifestPath,
  reportPath = null,
  reason,
  authorizedBy,
  authorizationRef,
  closedAt = new Date().toISOString(),
  suppliedProof = null,
  dryRun = false,
  recover = false,
} = {}) {
  const resolvedManifest = path.resolve(ensureRequiredText(manifestPath, 'manifest path'));
  const releaseReason = ensureRequiredText(reason, 'reason');
  const actor = ensureRequiredText(authorizedBy, 'authorized-by');
  const reference = ensureRequiredText(authorizationRef, 'authorization-ref');
  const resolvedRuntimeRoot = path.resolve(path.join(os.homedir(), 'zylos'));
  if (dryRun && recover) throw new Error('dry-run and recover are mutually exclusive');
  if (!isoTimestamp(closedAt)) throw new Error('closed-at must be a canonical ISO timestamp');
  if (!fs.existsSync(resolvedManifest)) throw new Error(`manifest does not exist: ${resolvedManifest}`);
  let manifest;
  let beforeBytes;
  try {
    beforeBytes = fs.readFileSync(resolvedManifest);
    manifest = JSON.parse(beforeBytes.toString('utf8'));
  } catch (error) {
    throw new Error(`manifest is not valid JSON: ${error.message}`);
  }
  if (!isObject(manifest)) throw new Error('manifest must be a JSON object');
  if (!['zylos.release-manifest/v1', 'zylos.release-manifest/v2'].includes(manifest.schema)) {
    throw new Error('manifest schema is unsupported');
  }
  if (typeof manifest.releaseId !== 'string' || manifest.releaseId.trim().length === 0) {
    throw new Error('manifest releaseId is required');
  }
  if (!Array.isArray(manifest.holdReasons)) throw new Error('manifest holdReasons must be an array');
  if (manifest.publicationAllowed !== undefined && typeof manifest.publicationAllowed !== 'boolean') {
    throw new Error('manifest publicationAllowed must be boolean');
  }
  const resolvedReport = path.resolve(reportPath || defaultReportPath(resolvedManifest, manifest.releaseId));
  const resolvedPreimage = `${resolvedReport}.manifest-before.json`;
  if (resolvedReport === resolvedManifest) throw new Error('report path must not be the release manifest');
  if (manifest.status !== 'READY') throw new Error(`only READY manifests may be cancelled (found ${manifest.status || 'missing'})`);
  if (manifest.deploymentAllowed !== true) throw new Error('READY manifest must have deploymentAllowed=true before cancellation');
  if (manifest.transactionClosure !== undefined) throw new Error('manifest already contains transactionClosure; refusing a second closure');

  const prepare = (currentManifest, currentBytes, transactionIsolation) => {
    const mutationProof = buildMutationProof(currentManifest, suppliedProof);
    const closureId = crypto.randomUUID();
    const closure = {
      schema: CLOSURE_SCHEMA,
      closureId,
      releaseId: currentManifest.releaseId,
      action: 'CANCEL',
      previous: { status: currentManifest.status, deploymentAllowed: currentManifest.deploymentAllowed },
      result: { status: 'CANCELLED', deploymentAllowed: false, publicationAllowed: false },
      reason: releaseReason,
      authorization: { identity: 'user', authorizedBy: actor, reference },
      closedAt,
      mutationProof,
      transactionIsolation,
      manifestPreimage: {
        manifestPath: resolvedManifest,
        path: resolvedPreimage,
        sha256: hashText(currentBytes),
      },
      generatedBy: { command: 'governance/close-release.mjs', schemaVersion: 1 },
    };
    const audit = {
      ...closure,
      manifest: {
        path: resolvedManifest,
        beforeSha256: hashText(currentBytes),
        snapshot: resolvedPreimage,
      },
    };
    return {
      closure,
      audit,
      result: {
        schema: 'zylos.release-closure-result/v1',
        status: 'PASS',
        dryRun: Boolean(dryRun),
        releaseId: currentManifest.releaseId,
        manifest: resolvedManifest,
        report: resolvedReport,
        releaseStatus: 'CANCELLED',
        deploymentAllowed: false,
        closureId,
        mutationProof,
      },
    };
  };

  if (dryRun) return prepare(manifest, beforeBytes, inspectRuntimeIsolation(resolvedRuntimeRoot, null)).result;

  const buildNextManifest = (currentManifest, closure, reportSha256) => ({
    ...currentManifest,
    status: 'CANCELLED',
    deploymentAllowed: false,
    publicationAllowed: false,
    holdReasons: Array.from(new Set([...(Array.isArray(currentManifest.holdReasons) ? currentManifest.holdReasons : []), 'RELEASE_TRANSACTION_CANCELLED'])),
    transactionClosure: {
      ...closure,
      report: {
        path: resolvedReport,
        sha256: reportSha256,
      },
    },
  });

  if (recover) {
    if (!fs.existsSync(resolvedPreimage)) throw new Error('recovery requires the existing manifest preimage');
    const runtimeLock = acquireRuntimeTransactionLock(resolvedRuntimeRoot);
    try {
      const releaseLock = lockManifest(resolvedManifest);
      try {
        const currentBytes = fs.readFileSync(resolvedManifest);
        const currentManifest = JSON.parse(currentBytes.toString('utf8'));
        if (currentManifest.status !== 'READY' || currentManifest.deploymentAllowed !== true || currentManifest.transactionClosure !== undefined) {
          throw new Error('recovery requires the unchanged READY manifest preimage');
        }
        const preimageBytes = fs.readFileSync(resolvedPreimage);
        if (hashText(currentBytes) !== hashText(preimageBytes)) {
          throw new Error('recovery manifest does not match the immutable manifest preimage');
        }
        let audit;
        if (fs.existsSync(resolvedReport)) {
          audit = JSON.parse(fs.readFileSync(resolvedReport, 'utf8'));
          if (!isObject(audit)) throw new Error('recovery report must be a JSON object');
          if (audit.reason !== releaseReason) throw new Error('recovery reason does not match the existing closure report');
          if (audit.authorization?.authorizedBy !== actor || audit.authorization?.reference !== reference) {
            throw new Error('recovery authorization does not match the existing closure report');
          }
          if (
            audit.manifest?.path !== resolvedManifest ||
            audit.manifest?.snapshot !== resolvedPreimage ||
            audit.manifest?.beforeSha256 !== hashText(preimageBytes)
          ) {
            throw new Error('recovery report is not bound to the manifest preimage');
          }
          if (suppliedProof) {
            const recoveredProof = buildMutationProof(currentManifest, suppliedProof);
            if (stableJson(recoveredProof) !== stableJson(audit.mutationProof)) {
              throw new Error('recovery proof does not match the existing closure report');
            }
          }
          audit.transactionIsolation = inspectRuntimeIsolation(resolvedRuntimeRoot, runtimeLock);
        } else {
          audit = prepare(
            currentManifest,
            currentBytes,
            inspectRuntimeIsolation(resolvedRuntimeRoot, runtimeLock),
          ).audit;
        }
        const validation = validateClosureRecord(audit, {
          manifest: currentManifest,
          manifestPath: resolvedManifest,
          requireReport: false,
        });
        if (!validation.valid) throw new Error(`recovery closure evidence is invalid: ${validation.failures.join('; ')}`);
        atomicWriteJson(resolvedReport, audit, { exclusive: !fs.existsSync(resolvedReport) });
        const closure = closureCoreFields(audit);
        const next = buildNextManifest(currentManifest, closure, hashFile(resolvedReport));
        atomicWriteJson(resolvedManifest, next);
        return {
          schema: 'zylos.release-closure-result/v1',
          status: 'PASS',
          recovered: true,
          dryRun: false,
          releaseId: currentManifest.releaseId,
          manifest: resolvedManifest,
          report: resolvedReport,
          releaseStatus: 'CANCELLED',
          deploymentAllowed: false,
          closureId: closure.closureId,
          mutationProof: closure.mutationProof,
        };
      } finally {
        releaseLock();
      }
    } finally {
      runtimeLock.release();
    }
  }

  if (fs.existsSync(resolvedReport) || fs.existsSync(resolvedPreimage)) {
    throw new Error(`existing evidence requires an explicit --recover after verification: ${resolvedReport}`);
  }
  const runtimeLock = acquireRuntimeTransactionLock(resolvedRuntimeRoot);
  try {
    const releaseLock = lockManifest(resolvedManifest);
    try {
      const rereadBytes = fs.readFileSync(resolvedManifest);
      if (hashText(rereadBytes) !== hashText(beforeBytes)) {
        throw new Error('manifest changed while preparing closure; refusing to overwrite it');
      }
      const reread = JSON.parse(rereadBytes.toString('utf8'));
      if (reread.status !== 'READY' || reread.deploymentAllowed !== true || reread.transactionClosure !== undefined) {
        throw new Error('manifest changed while preparing closure; refusing to overwrite it');
      }
      const transactionIsolation = inspectRuntimeIsolation(resolvedRuntimeRoot, runtimeLock);
      const prepared = prepare(reread, rereadBytes, transactionIsolation);
      atomicWriteBytes(resolvedPreimage, rereadBytes, { exclusive: true });
      atomicWriteJson(resolvedReport, prepared.audit, { exclusive: true });
      const next = buildNextManifest(reread, prepared.closure, hashFile(resolvedReport));
      atomicWriteJson(resolvedManifest, next);
      return prepared.result;
    } finally {
      releaseLock();
    }
  } finally {
    runtimeLock.release();
  }
}

export { MUTATION_PHASES };
