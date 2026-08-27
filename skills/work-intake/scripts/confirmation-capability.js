import { createHmac, timingSafeEqual } from 'node:crypto';

const TOKEN_VERSION = 'wic1';
const AUDIENCE = 'c4-work-intake-confirmation';
const ACTIONS = new Set(['create_task', 'chat_only', 'edit']);
const ISSUE_FIELDS = new Set(['sourceKey', 'action', 'actorId', 'expiresAt', 'nonce']);
const VERIFY_FIELDS = new Set(['token', 'sourceKey', 'action', 'actorId']);
const CLAIM_FIELDS = new Set([
  'audience',
  'sourceKey',
  'action',
  'actorId',
  'issuedAt',
  'expiresAt',
  'nonce',
]);
const MIN_SECRET_BYTES = 32;
const MAX_TOKEN_LENGTH = 8_192;
const MAX_TTL_MS = 24 * 60 * 60_000;
const BASE64URL = /^[A-Za-z0-9_-]+$/;

function invalidCapability() {
  const error = new Error('WorkIntake confirmation capability is invalid or expired');
  error.code = 'INVALID_CONFIRMATION_CAPABILITY';
  return error;
}

function requireRecord(value, fields, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object`);
  }
  const keys = Object.keys(value);
  if (keys.length !== fields.size || keys.some(key => !fields.has(key))) {
    throw new TypeError(`${name} contains unsupported or missing fields`);
  }
  return value;
}

function requireText(value, name, maxLength = 512) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`${name} must be a non-empty string`);
  }
  if (Array.from(value).length > maxLength) throw new TypeError(`${name} is too long`);
  return value;
}

function readNow(clock) {
  const now = clock();
  if (!Number.isSafeInteger(now) || now < 0) throw new TypeError('clock must return epoch milliseconds');
  return now;
}

function decode(value) {
  if (typeof value !== 'string' || !BASE64URL.test(value)) throw invalidCapability();
  const decoded = Buffer.from(value, 'base64url');
  if (decoded.toString('base64url') !== value) throw invalidCapability();
  return decoded;
}

function normalizedAction(value) {
  const action = requireText(value, 'action', 32);
  if (!ACTIONS.has(action)) throw new TypeError('action is unsupported');
  return action;
}

/**
 * Shared-secret capability Interface at the channel/Core seam. A trusted
 * channel adapter issues one short-lived attestation only after authenticating
 * the platform callback; Core verifies it without importing a platform SDK.
 */
export function createWorkIntakeConfirmationCapability({ secret, clock = Date.now } = {}) {
  const safeSecret = requireText(secret, 'secret', 4_096);
  if (Buffer.byteLength(safeSecret, 'utf8') < MIN_SECRET_BYTES) {
    throw new TypeError(`secret must contain at least ${MIN_SECRET_BYTES} bytes`);
  }
  if (typeof clock !== 'function') throw new TypeError('clock must be a function');
  const key = Buffer.from(safeSecret, 'utf8');
  const sign = value => createHmac('sha256', key).update(value).digest();

  return Object.freeze({
    issue(input) {
      const request = requireRecord(input, ISSUE_FIELDS, 'capability issue request');
      const now = readNow(clock);
      if (!Number.isSafeInteger(request.expiresAt)
        || request.expiresAt <= now
        || request.expiresAt - now > MAX_TTL_MS) {
        throw new TypeError('expiresAt must be within the next 24 hours');
      }
      const claims = {
        audience: AUDIENCE,
        sourceKey: requireText(request.sourceKey, 'sourceKey'),
        action: normalizedAction(request.action),
        actorId: requireText(request.actorId, 'actorId', 256),
        issuedAt: now,
        expiresAt: request.expiresAt,
        nonce: requireText(request.nonce, 'nonce', 256),
      };
      const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
      const signed = `${TOKEN_VERSION}.${payload}`;
      return `${signed}.${sign(signed).toString('base64url')}`;
    },

    verify(input) {
      try {
        const request = requireRecord(input, VERIFY_FIELDS, 'capability verification request');
        if (typeof request.token !== 'string' || request.token.length > MAX_TOKEN_LENGTH) {
          throw invalidCapability();
        }
        const [version, payload, signature, ...extra] = request.token.split('.');
        if (version !== TOKEN_VERSION || !payload || !signature || extra.length > 0) {
          throw invalidCapability();
        }
        const signed = `${version}.${payload}`;
        const actual = decode(signature);
        const expected = sign(signed);
        if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
          throw invalidCapability();
        }
        const claims = JSON.parse(decode(payload).toString('utf8'));
        requireRecord(claims, CLAIM_FIELDS, 'capability claims');
        const now = readNow(clock);
        if (claims.audience !== AUDIENCE
          || !Number.isSafeInteger(claims.issuedAt)
          || !Number.isSafeInteger(claims.expiresAt)
          || claims.issuedAt > now
          || claims.expiresAt <= now
          || claims.expiresAt - claims.issuedAt > MAX_TTL_MS
          || claims.sourceKey !== request.sourceKey
          || claims.action !== request.action
          || claims.actorId !== request.actorId) {
          throw invalidCapability();
        }
        normalizedAction(claims.action);
        requireText(claims.sourceKey, 'sourceKey');
        requireText(claims.actorId, 'actorId', 256);
        requireText(claims.nonce, 'nonce', 256);
        return claims;
      } catch (error) {
        if (error?.code === 'INVALID_CONFIRMATION_CAPABILITY') throw error;
        throw invalidCapability();
      }
    },
  });
}
