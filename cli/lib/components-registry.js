import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { atomicWriteJson } from './atomic-json.js';
import { COMPONENTS_FILE, LOCKS_DIR } from './config.js';
import { captureProcessIdentity, inspectProcessIdentity } from './process-identity.js';

const LOCK_DIR = path.join(LOCKS_DIR, 'components-registry.lock');
const LOCK_OWNER = path.join(LOCK_DIR, 'owner.json');
const DEFAULT_TIMEOUT_MS = 10_000;

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function assertPlainObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
}

function readLockOwner() {
  try {
    const owner = JSON.parse(fs.readFileSync(LOCK_OWNER, 'utf8'));
    assertPlainObject(owner, 'components registry lock owner');
    if (typeof owner.token !== 'string' || owner.token.length === 0) {
      throw new Error('components registry lock token is required');
    }
    return owner;
  } catch (err) {
    if (err?.code === 'ENOENT') return null;
    throw new Error(`cannot inspect components registry lock: ${err.message}`);
  }
}

function acquireRegistryLock({ timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  fs.mkdirSync(LOCKS_DIR, { recursive: true });
  const deadline = Date.now() + timeoutMs;
  const owner = {
    token: crypto.randomUUID(),
    process: captureProcessIdentity(),
    createdAt: new Date().toISOString(),
  };

  while (true) {
    try {
      fs.mkdirSync(LOCK_DIR);
      try {
        atomicWriteJson(LOCK_OWNER, owner, { mode: 0o600 });
      } catch (err) {
        fs.rmSync(LOCK_DIR, { recursive: true, force: true });
        throw err;
      }
      return owner;
    } catch (err) {
      if (err?.code !== 'EEXIST') throw err;
      const existing = readLockOwner();
      if (existing) {
        const status = inspectProcessIdentity(existing.process);
        if (status.state !== 'ALIVE') {
          throw new Error(
            `components registry lock recovery required (${status.state.toLowerCase()}: ${status.reason}); `
            + `preserved ${LOCK_DIR}`,
          );
        }
      }
      if (Date.now() >= deadline) {
        throw new Error(`components registry is busy; preserved lock ${LOCK_DIR}`);
      }
      sleepSync(25);
    }
  }
}

function releaseRegistryLock(owner) {
  const existing = readLockOwner();
  if (!existing || existing.token !== owner.token) {
    throw new Error('components registry lock fencing token mismatch');
  }
  fs.rmSync(LOCK_DIR, { recursive: true, force: true });
}

export function readComponentsRegistryStrict() {
  if (!fs.existsSync(COMPONENTS_FILE)) return {};
  const components = JSON.parse(fs.readFileSync(COMPONENTS_FILE, 'utf8'));
  assertPlainObject(components, 'components registry');
  return components;
}

export function updateComponentsRegistry(mutator, options) {
  const owner = acquireRegistryLock(options);
  try {
    const current = readComponentsRegistryStrict();
    const next = mutator(current);
    assertPlainObject(next, 'updated components registry');
    atomicWriteJson(COMPONENTS_FILE, next);
    return next;
  } finally {
    releaseRegistryLock(owner);
  }
}
