import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-lock-test-'));
const zylosDir = path.join(fixtureRoot, 'zylos');
process.env.ZYLOS_DIR = zylosDir;

const { acquireLock, isLocked, releaseLock } = await import('../lock.js');
const locksDir = path.join(zylosDir, '.zylos', 'locks');

test.after(() => fs.rmSync(fixtureRoot, { recursive: true, force: true }));

test('lock records token and process-start owner and releases only its token', () => {
  const component = 'lock-token';
  const acquired = acquireLock(component);
  assert.equal(acquired.success, true);
  assert.match(acquired.token, /^[0-9a-f-]{36}$/);
  const lockPath = path.join(locksDir, `${component}.lock`);
  const data = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
  assert.equal(data.token, acquired.token);
  assert.equal(data.owner.pid, process.pid);
  assert.equal(data.owner.processStart, data.processStart);
  assert.equal(typeof data.processStart, 'string');

  const replaced = { ...data, token: 'different-owner-token' };
  fs.writeFileSync(lockPath, JSON.stringify(replaced));
  assert.equal(releaseLock(component).success, false);
  fs.writeFileSync(lockPath, JSON.stringify(data));
  assert.equal(releaseLock(component).success, true);
});

test('a live owner is never reclaimed merely because its lock is old', () => {
  const component = 'lock-old-live';
  const acquired = acquireLock(component);
  assert.equal(acquired.success, true);
  const lockPath = path.join(locksDir, `${component}.lock`);
  const data = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
  data.timestamp = Date.now() - (20 * 60 * 1000);
  fs.writeFileSync(lockPath, JSON.stringify(data));

  const second = acquireLock(component);
  assert.equal(second.success, false);
  assert.equal(fs.existsSync(lockPath), true);
  assert.equal(isLocked(component).locked, true);
  assert.equal(releaseLock(component).success, true);
});

test('legacy lock with a live owner is held instead of deleted', () => {
  const component = 'lock-legacy-live';
  const acquired = acquireLock(component);
  assert.equal(acquired.success, true);
  const lockPath = path.join(locksDir, `${component}.lock`);
  const current = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
  fs.writeFileSync(lockPath, JSON.stringify({
    pid: process.pid,
    timestamp: Date.now() - (30 * 60 * 1000),
    component,
    processStart: current.processStart,
  }));
  const second = acquireLock(component);
  assert.equal(second.success, false);
  assert.equal(fs.existsSync(lockPath), true);
  assert.equal(isLocked(component).locked, true);
  fs.rmSync(lockPath, { force: true });
});

test('a lock owned by a dead PID is reclaimable without age-only cleanup', () => {
  const component = 'lock-dead-owner';
  fs.mkdirSync(locksDir, { recursive: true });
  const lockPath = path.join(locksDir, `${component}.lock`);
  fs.writeFileSync(lockPath, JSON.stringify({
    pid: 2147483647,
    timestamp: Date.now(),
    component,
    token: 'dead-owner-token',
    processStart: 'dead-process-start',
  }));
  const acquired = acquireLock(component);
  assert.equal(acquired.success, true);
  assert.notEqual(acquired.token, 'dead-owner-token');
  assert.equal(releaseLock(component).success, true);
});
