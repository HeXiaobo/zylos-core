import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

const POLICY_VERSION = 1;
const POLICY_FILE = path.join('.zylos', 'c4-outbound-policy.json');
const AUDIT_FILE = path.join('comm-bridge', 'outbound-policy-audit.jsonl');
const MAX_RULES = 256;
const MAX_RULE_ID_BYTES = 128;
const MAX_LITERAL_BYTES = 4096;
const MAX_CODE_POINTS_PER_RULE = 256;
const MAX_MESSAGE_BYTES = 4 * 1024 * 1024;

function zylosDir() {
  return process.env.ZYLOS_DIR || path.join(os.homedir(), 'zylos');
}

function policyPath() {
  return path.join(zylosDir(), POLICY_FILE);
}

function auditPath() {
  return path.join(zylosDir(), AUDIT_FILE);
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function routeLabel(value) {
  if (typeof value !== 'string' || !value) return '[none]';
  return /^[a-zA-Z0-9._-]{1,64}$/.test(value) ? value : '[redacted]';
}

function auditContext({ channel, endpoint, message }) {
  return {
    channel: routeLabel(channel),
    endpointHash: sha256(typeof endpoint === 'string' ? endpoint : ''),
    bodyBytes: Buffer.byteLength(message, 'utf8'),
    bodySha256: sha256(message),
  };
}

function currentUid() {
  return typeof process.getuid === 'function' ? process.getuid() : null;
}

function assertOwnedSecurePath(stats, kind) {
  const wrongType = kind === 'file' ? !stats.isFile() : !stats.isDirectory();
  if (stats.isSymbolicLink() || wrongType) {
    throw new Error(`${kind} path is not a secure regular ${kind}`);
  }
  if ((stats.mode & 0o022) !== 0) throw new Error(`${kind} path is writable by group or other users`);
  const uid = currentUid();
  if (uid !== null && stats.uid !== uid) throw new Error(`${kind} path is not owned by the runtime user`);
}

function ensureSecureDirectory(directoryPath) {
  let stats;
  try {
    stats = fs.lstatSync(directoryPath);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    fs.mkdirSync(directoryPath, { recursive: true, mode: 0o700 });
    stats = fs.lstatSync(directoryPath);
  }
  assertOwnedSecurePath(stats, 'directory');
}

function assertSecureRuntimeDirectory() {
  const stats = secureDirectoryStats(zylosDir());
  if (!stats) throw new Error('runtime directory is unavailable');
}

function securePolicyFileStats(filePath) {
  let stats;
  try {
    stats = fs.lstatSync(filePath);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  assertOwnedSecurePath(stats, 'file');
  return stats;
}

function secureDirectoryStats(directoryPath) {
  let stats;
  try {
    stats = fs.lstatSync(directoryPath);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  assertOwnedSecurePath(stats, 'directory');
  return stats;
}

function appendAudit(record) {
  const destination = auditPath();
  assertSecureRuntimeDirectory();
  ensureSecureDirectory(path.dirname(destination));
  const existing = securePolicyFileStats(destination);
  fs.appendFileSync(destination, `${JSON.stringify(record)}\n`, { encoding: 'utf8', mode: 0o600 });
  if (!existing) assertOwnedSecurePath(fs.lstatSync(destination), 'file');
}

function readPolicyFile() {
  const rootPath = zylosDir();
  try {
    if (!secureDirectoryStats(rootPath)) return { rules: [] };
    if (!secureDirectoryStats(path.join(rootPath, '.zylos'))) return { rules: [] };
  } catch {
    return { errorCode: 'POLICY_FILE_UNAVAILABLE' };
  }

  const filePath = policyPath();
  let stats;
  try {
    stats = securePolicyFileStats(filePath);
  } catch {
    return { errorCode: 'POLICY_FILE_UNAVAILABLE' };
  }
  if (!stats) return { rules: [] };

  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return { errorCode: 'POLICY_FILE_INVALID' };
  }

  try {
    return { rules: normalizeRules(parsed) };
  } catch {
    return { errorCode: 'POLICY_SCHEMA_INVALID' };
  }
}

function normalizeRules(policy) {
  if (!policy || typeof policy !== 'object' || Array.isArray(policy)) {
    throw new Error('policy must be an object');
  }
  if (policy.version !== POLICY_VERSION) {
    throw new Error('unsupported policy version');
  }
  const policyKeys = new Set(['version', 'rules']);
  if (Object.keys(policy).some(key => !policyKeys.has(key))) {
    throw new Error('policy contains unknown fields');
  }
  if (!Array.isArray(policy.rules) || policy.rules.length === 0 || policy.rules.length > MAX_RULES) {
    throw new Error('policy rules must be a non-empty bounded array');
  }

  const ids = new Set();
  return policy.rules.map((rule, index) => {
    if (!rule || typeof rule !== 'object' || Array.isArray(rule)) {
      throw new Error('rule must be an object');
    }
    const ruleKeys = new Set(['id', 'contains', 'codePoints']);
    if (Object.keys(rule).some(key => !ruleKeys.has(key))) {
      throw new Error('rule contains unknown fields');
    }
    const id = rule.id === undefined ? `rule-${index + 1}` : rule.id;
    if (typeof id !== 'string' || !/^[a-zA-Z0-9._:-]{1,128}$/.test(id)
      || Buffer.byteLength(id, 'utf8') > MAX_RULE_ID_BYTES || ids.has(id)) {
      throw new Error('rule id must be a safe label');
    }
    ids.add(id);

    const contains = rule.contains;
    if (contains !== undefined && (typeof contains !== 'string' || contains.length === 0
      || Buffer.byteLength(contains, 'utf8') > MAX_LITERAL_BYTES)) {
      throw new Error('rule contains must be a non-empty string');
    }

    const codePoints = rule.codePoints === undefined ? [] : rule.codePoints;
    if (!Array.isArray(codePoints) || codePoints.length > MAX_CODE_POINTS_PER_RULE
      || codePoints.length === 0 && contains === undefined) {
      throw new Error('rule must contain literal text or code points');
    }
    for (const codePoint of codePoints) {
      if (!Number.isInteger(codePoint) || codePoint < 0 || codePoint > 0x10FFFF) {
        throw new Error('rule code points must be valid Unicode scalar values');
      }
      if (codePoint >= 0xD800 && codePoint <= 0xDFFF) {
        throw new Error('rule code points must not be surrogate code points');
      }
    }

    return {
      id,
      contains,
      codePoints: codePoints.map(codePoint => String.fromCodePoint(codePoint)),
    };
  });
}

function matchedRuleIds(rules, message) {
  return rules
    .filter(rule => (
      (rule.contains !== undefined && message.includes(rule.contains))
      || rule.codePoints.some(codePoint => message.includes(codePoint))
    ))
    .map(rule => rule.id);
}

function writeConfigurationAudit(errorCode, context) {
  try {
    appendAudit({
      auditVersion: 1,
      event: 'outbound_policy_configuration_error',
      timestamp: new Date().toISOString(),
      errorCode,
      ...context,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Enforce the configured outbound content policy at the send seam.
 *
 * The interface deliberately accepts a route and body only. Policy loading,
 * validation, matching, and content-safe audit persistence stay behind this
 * module so every external channel (including nonstandard channel names)
 * shares one fail-closed decision point.
 *
 * A missing default policy file means no rules are configured. A present but
 * invalid policy is a configuration failure and rejects the send. Rules use
 * literal `contains` strings and/or Unicode `codePoints`; regular expressions
 * are intentionally not supported. The policy and audit paths are fixed
 * relative to the runtime directory so a caller cannot redirect either one.
 */
export function enforceOutboundPolicy({ channel, endpoint, message }) {
  if (typeof message !== 'string') throw new TypeError('message must be a string');

  const context = auditContext({ channel, endpoint, message });
  const policy = readPolicyFile();
  if (policy.errorCode) {
    const auditWritten = writeConfigurationAudit(policy.errorCode, context);
    const error = new Error('Outbound policy is unavailable; message rejected');
    error.code = 'OUTBOUND_POLICY_UNAVAILABLE';
    error.auditWritten = auditWritten;
    throw error;
  }

  if (policy.rules.length > 0 && context.bodyBytes > MAX_MESSAGE_BYTES) {
    const auditWritten = writeConfigurationAudit('MESSAGE_TOO_LARGE', context);
    const error = new Error('Outbound message exceeds the policy size limit');
    error.code = 'OUTBOUND_POLICY_MESSAGE_TOO_LARGE';
    error.auditWritten = auditWritten;
    throw error;
  }

  const ruleIds = matchedRuleIds(policy.rules, message);
  if (ruleIds.length === 0) return { allowed: true };

  try {
    appendAudit({
      auditVersion: 1,
      event: 'outbound_policy_blocked',
      timestamp: new Date().toISOString(),
      ruleRefs: ruleIds.map(ruleId => sha256(`rule:${ruleId}`)),
      ...context,
    });
  } catch (cause) {
    const error = new Error('Outbound policy audit is unavailable; message rejected');
    error.code = 'OUTBOUND_POLICY_AUDIT_UNAVAILABLE';
    error.cause = cause;
    throw error;
  }

  return { allowed: false, ruleRefs: ruleIds.map(ruleId => sha256(`rule:${ruleId}`)) };
}
