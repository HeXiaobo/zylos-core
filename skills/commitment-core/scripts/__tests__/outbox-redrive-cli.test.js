import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { openCommitmentCore } from '../core.js';

const CLI_PATH = fileURLToPath(new URL('../outbox-redrive.js', import.meta.url));

function seedDeadLetter(zylosDir) {
  const core = openCommitmentCore({
    dbPath: path.join(zylosDir, 'commitments', 'commitments.db'),
    clock: () => '2026-08-25T10:00:00.000Z',
    idGenerator: () => 'task-001',
    eventIdGenerator: () => 'event-001',
  });
  core.outbox.register({
    projection: 'feishu',
    bootstrapPolicy: 'from_beginning',
    actorId: 'setup-operator',
    idempotencyKey: 'register:feishu',
  });
  core.ingest({
    idempotencyKey: 'source:task-001',
    source: { channel: 'test', externalId: 'message-001', senderId: 'owner-1' },
    task: { title: 'Redrive from CLI', ownerId: 'owner-1' },
  });
  const [leased] = core.outbox.claim({
    projection: 'feishu',
    workerId: 'worker-1',
    idempotencyKey: 'claim:feishu:1',
    leaseMs: 60_000,
    limit: 1,
  });
  const dead = core.outbox.fail({
    projection: 'feishu',
    eventId: leased.eventId,
    workerId: 'worker-1',
    error: 'operator inspected this failure',
    idempotencyKey: 'fail:feishu:1',
  }, leased.version);
  core.close();
  return dead;
}

function runCli(zylosDir, args) {
  return spawnSync(process.execPath, [CLI_PATH, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ZYLOS_DIR: zylosDir },
  });
}

test('local operator CLI performs one explicit redrive and never claims or retries it', () => {
  const zylosDir = mkdtempSync(path.join(os.tmpdir(), 'zylos-outbox-redrive-cli-'));
  try {
    const dead = seedDeadLetter(zylosDir);
    const result = runCli(zylosDir, [
      '--projection', 'feishu',
      '--event-id', dead.eventId,
      '--actor', 'operator-1',
      '--idempotency-key', 'redrive:cli:1',
      '--expected-version', String(dead.version),
      '--json',
    ]);
    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.delivery.status, 'retry_wait');
    assert.equal(output.delivery.attempt, 0);
    assert.equal(output.delivery.totalAttempts, 1);
    assert.equal(output.redrive.actorId, 'operator-1');

    const core = openCommitmentCore({
      dbPath: path.join(zylosDir, 'commitments', 'commitments.db'),
    });
    try {
      const delivery = core.outbox.query({
        projection: 'feishu',
        eventId: dead.eventId,
      });
      assert.equal(delivery.status, 'retry_wait');
      assert.equal(delivery.attempt, 0, 'CLI must not claim or automatically retry');
      assert.equal(delivery.version, dead.version + 1);
    } finally {
      core.close();
    }

    const refused = runCli(zylosDir, [
      '--projection', 'feishu',
      '--event-id', dead.eventId,
      '--actor', 'operator-2',
      '--idempotency-key', 'redrive:cli:2',
      '--expected-version', String(dead.version + 1),
    ]);
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /DELIVERY_NOT_DEAD_LETTER/);
  } finally {
    rmSync(zylosDir, { recursive: true, force: true });
  }
});

test('local operator CLI rejects incomplete or malformed commands with a non-zero exit', () => {
  const result = runCli('/path/not-used', [
    '--projection', 'feishu',
    '--event-id', 'event-001',
    '--actor', 'operator-1',
    '--idempotency-key', 'redrive:cli:invalid',
    '--expected-version', '0',
  ]);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /expected-version must be a positive integer/);
});
