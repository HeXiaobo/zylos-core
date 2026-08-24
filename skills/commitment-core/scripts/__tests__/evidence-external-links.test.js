import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import Database from 'better-sqlite3';

import { openCommitmentCore } from '../core.js';

function openHarness({
  dbPath,
  taskIds = ['task-1', 'task-2'],
  externalLinkIds,
} = {}) {
  const directory = dbPath ? null : mkdtempSync(path.join(os.tmpdir(), 'zylos-evidence-'));
  const databasePath = dbPath ?? path.join(directory, 'commitments.db');
  let taskIndex = 0;
  let eventIndex = 0;
  let evidenceIndex = 0;
  let externalLinkIndex = 0;
  const core = openCommitmentCore({
    dbPath: databasePath,
    clock: () => '2026-08-25T10:00:00.000Z',
    idGenerator: () => taskIds[taskIndex++],
    eventIdGenerator: () => `event-${eventIndex++}`,
    evidenceIdGenerator: () => `evidence-${evidenceIndex++}`,
    externalLinkIdGenerator: () => {
      const id = externalLinkIds?.[externalLinkIndex] ?? `external-link-${externalLinkIndex}`;
      externalLinkIndex += 1;
      return id;
    },
  });
  return {
    core,
    dbPath: databasePath,
    cleanup() {
      core.close();
      if (directory) rmSync(directory, { recursive: true, force: true });
    },
  };
}

function createTask(core, id, overrides = {}) {
  return core.ingest({
    idempotencyKey: `source:${id}`,
    source: { channel: 'test', externalId: id, senderId: 'owner-1' },
    task: {
      title: `Task ${id}`,
      ownerId: 'owner-1',
      acceptorId: 'acceptor-1',
      assigneeId: 'agent-1',
      ...overrides,
    },
  }).task;
}

test('Evidence is immutable, participant-authored, queryable, and exactly idempotent', () => {
  const harness = openHarness();
  try {
    createTask(harness.core, 'task-1');
    const request = {
      taskId: 'task-1',
      actorId: 'agent-1',
      kind: ' DELIVERY ',
      uri: 'https://example.test/delivery/1',
      summary: '客户交付记录',
      contentHash: 'sha256:abc123',
      idempotencyKey: 'evidence:delivery:1',
    };

    const recorded = harness.core.evidence.record(request);
    assert.deepEqual(harness.core.evidence.record(request), recorded);
    assert.equal(recorded.created, true);
    assert.deepEqual(recorded.evidence, {
      id: 'evidence-0',
      taskId: 'task-1',
      actorId: 'agent-1',
      kind: 'delivery',
      uri: 'https://example.test/delivery/1',
      summary: '客户交付记录',
      contentHash: 'sha256:abc123',
      createdAt: '2026-08-25T10:00:00.000Z',
    });
    assert.deepEqual(harness.core.evidence.query({ evidenceId: 'evidence-0' }), recorded.evidence);
    assert.deepEqual(
      harness.core.evidence.query({ taskId: 'task-1', kind: ' DELIVERY ' }),
      [recorded.evidence],
    );
    const second = harness.core.evidence.record({
      taskId: 'task-1', actorId: 'acceptor-1', kind: 'delivery', summary: '补充验收记录',
      idempotencyKey: 'evidence:delivery:2',
    }).evidence;
    assert.deepEqual(
      harness.core.evidence.query({ taskId: 'task-1', kind: 'delivery' }),
      [recorded.evidence, second],
      'same-time Evidence uses id as a stable tie-breaker',
    );
    assert.deepEqual(
      harness.core.evidence.query({ taskId: 'task-1', limit: 1 }),
      [recorded.evidence],
    );
    assert.equal(harness.core.evidence.update, undefined);
    assert.equal(harness.core.evidence.remove, undefined);
  } finally {
    harness.cleanup();
  }
});

test('Evidence rejects malformed, unauthorized, and conflicting writes', () => {
  const harness = openHarness();
  try {
    createTask(harness.core, 'task-1');
    const base = {
      taskId: 'task-1',
      actorId: 'owner-1',
      kind: 'note',
      summary: '验收说明',
      idempotencyKey: 'evidence:note:1',
    };
    harness.core.evidence.record(base);

    assert.throws(
      () => harness.core.evidence.record({ ...base, summary: 'changed' }),
      (error) => error?.code === 'IDEMPOTENCY_CONFLICT',
    );
    assert.throws(
      () => harness.core.evidence.record({ ...base, actorId: 'outsider', idempotencyKey: 'evidence:outsider' }),
      (error) => error?.code === 'FORBIDDEN',
    );
    assert.throws(
      () => harness.core.evidence.record({ ...base, taskId: 'missing', idempotencyKey: 'evidence:missing' }),
      (error) => error?.code === 'TASK_NOT_FOUND',
    );
    assert.throws(
      () => harness.core.evidence.record({
        taskId: 'task-1', actorId: 'owner-1', kind: 'note', idempotencyKey: 'evidence:empty',
      }),
      /at least one of uri, summary, or contentHash/,
    );
    assert.throws(
      () => harness.core.evidence.record({ ...base, unknown: true, idempotencyKey: 'evidence:unknown' }),
      /unsupported evidence request field/,
    );
    assert.throws(
      () => harness.core.evidence.record({
        ...base, summary: 'x'.repeat(10_001), idempotencyKey: 'evidence:oversized',
      }),
      /at most 10000 characters/,
    );
    assert.throws(
      () => harness.core.evidence.record({
        ...base, kind: 'bad kind', idempotencyKey: 'evidence:bad-kind',
      }),
      /lowercase identifier/,
    );
    assert.throws(
      () => harness.core.evidence.query({ taskId: 'task-1', evidenceId: 'evidence-0' }),
      /unsupported evidence query field/,
    );
    assert.throws(
      () => harness.core.evidence.query({ taskId: 'task-1', limit: 101 }),
      /between 1 and 100/,
    );
  } finally {
    harness.cleanup();
  }
});

test('Evidence row and receipt roll back together when receipt persistence fails', () => {
  const harness = openHarness();
  try {
    createTask(harness.core, 'task-1');
    const raw = new Database(harness.dbPath);
    raw.exec(`
      CREATE TRIGGER reject_evidence_receipt
      BEFORE INSERT ON commitment_evidence_receipts
      BEGIN
        SELECT RAISE(ABORT, 'receipt rejected');
      END;
    `);
    assert.throws(() => harness.core.evidence.record({
      taskId: 'task-1', actorId: 'owner-1', kind: 'note', summary: 'atomic',
      idempotencyKey: 'evidence:atomic',
    }), /receipt rejected/);
    assert.equal(raw.prepare('SELECT COUNT(*) AS count FROM commitment_evidence').get().count, 0);
    raw.exec('DROP TRIGGER reject_evidence_receipt');
    raw.close();

    assert.equal(harness.core.evidence.record({
      taskId: 'task-1', actorId: 'owner-1', kind: 'note', summary: 'atomic',
      idempotencyKey: 'evidence:atomic',
    }).evidence.id, 'evidence-1');
  } finally {
    harness.cleanup();
  }
});

test('ExternalLink normalizes backend and maintains a stable bidirectional mapping', () => {
  const harness = openHarness();
  try {
    createTask(harness.core, 'task-1');
    const request = {
      taskId: 'task-1', actorId: 'owner-1', backend: ' FeiShu ', externalId: 'TK-001',
      idempotencyKey: 'link:feishu:1',
    };
    const first = harness.core.externalLinks.link(request);
    assert.deepEqual(harness.core.externalLinks.link(request), first);
    assert.equal(first.created, true);
    assert.equal(first.link.backend, 'feishu');

    const semanticReplay = harness.core.externalLinks.link({
      ...request,
      backend: 'feishu',
      idempotencyKey: 'link:feishu:replay',
    });
    assert.equal(semanticReplay.created, false);
    assert.deepEqual(semanticReplay.link, first.link);
    assert.throws(
      () => harness.core.externalLinks.link({
        ...request,
        externalId: 'TK-CHANGED',
        idempotencyKey: 'link:feishu:replay',
      }),
      (error) => error?.code === 'IDEMPOTENCY_CONFLICT',
    );
    assert.deepEqual(harness.core.externalLinks.query({ taskId: 'task-1' }), [first.link]);
    assert.deepEqual(
      harness.core.externalLinks.query({ backend: ' FEISHU ', externalId: 'TK-001' }),
      first.link,
    );
    assert.deepEqual(harness.core.externalLinks.query({ backend: 'feishu' }), [first.link]);
    assert.throws(
      () => harness.core.externalLinks.query({ backend: 'feishu', limit: 101 }),
      /between 1 and 100/,
    );
    assert.throws(
      () => harness.core.externalLinks.link({
        ...request, backend: 'bad backend', idempotencyKey: 'link:bad-backend',
      }),
      /lowercase identifier/,
    );
    assert.equal(harness.core.externalLinks.sync, undefined);
  } finally {
    harness.cleanup();
  }
});

test('ExternalLink uniqueness holds across Core connections and at the SQLite boundary', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'zylos-external-link-concurrency-'));
  const dbPath = path.join(directory, 'commitments.db');
  const first = openHarness({ dbPath });
  let second;
  try {
    createTask(first.core, 'task-1');
    createTask(first.core, 'task-2');
    second = openHarness({ dbPath, externalLinkIds: ['external-link-from-second'] });
    first.core.externalLinks.link({
      taskId: 'task-1', actorId: 'owner-1', backend: 'paperclip', externalId: 'PC-1',
      idempotencyKey: 'link:paperclip:1',
    });
    assert.throws(
      () => second.core.externalLinks.link({
        taskId: 'task-2', actorId: 'owner-1', backend: 'paperclip', externalId: 'PC-1',
        idempotencyKey: 'link:paperclip:conflict',
      }),
      (error) => error?.code === 'EXTERNAL_LINK_CONFLICT',
    );
    assert.throws(
      () => second.core.externalLinks.link({
        taskId: 'task-1', actorId: 'owner-1', backend: 'paperclip', externalId: 'PC-2',
        idempotencyKey: 'link:paperclip:second-for-task',
      }),
      (error) => error?.code === 'EXTERNAL_LINK_CONFLICT',
    );
    const secondMapping = second.core.externalLinks.link({
      taskId: 'task-2', actorId: 'owner-1', backend: 'paperclip', externalId: 'PC-2',
      idempotencyKey: 'link:paperclip:2',
    }).link;

    const raw = new Database(dbPath);
    raw.pragma('foreign_keys = ON');
    assert.throws(() => raw.prepare(`
      INSERT INTO commitment_external_links (
        id, task_id, actor_id, backend, external_id, created_at
      ) VALUES ('raw-link-1', 'task-2', 'owner-1', 'paperclip', 'PC-1', '2026-08-25T10:00:00.000Z')
    `).run(), /UNIQUE constraint failed/);
    assert.throws(() => raw.prepare(`
      INSERT INTO commitment_external_links (
        id, task_id, actor_id, backend, external_id, created_at
      ) VALUES ('raw-link-2', 'missing', 'owner-1', 'other', 'X-1', '2026-08-25T10:00:00.000Z')
    `).run(), /FOREIGN KEY constraint failed/);
    raw.close();
    assert.deepEqual(
      first.core.externalLinks.query({ backend: 'paperclip' }).map((link) => link.externalId),
      ['PC-1', 'PC-2'],
    );
    assert.deepEqual(
      first.core.externalLinks.query({ backend: 'paperclip', limit: 1 }).map((link) => link.externalId),
      ['PC-1'],
    );
    assert.equal(secondMapping.taskId, 'task-2');
  } finally {
    second?.core.close();
    first.core.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('ExternalLink receipt rollback and schema initialization are repeatable', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'zylos-external-link-atomic-'));
  const dbPath = path.join(directory, 'commitments.db');
  let first = openHarness({ dbPath });
  try {
    createTask(first.core, 'task-1');
    const raw = new Database(dbPath);
    raw.exec(`
      CREATE TRIGGER reject_external_link_receipt
      BEFORE INSERT ON commitment_external_link_receipts
      BEGIN
        SELECT RAISE(ABORT, 'link receipt rejected');
      END;
    `);
    const request = {
      taskId: 'task-1', actorId: 'acceptor-1', backend: 'openmax', externalId: 'OM-1',
      idempotencyKey: 'link:openmax:1',
    };
    assert.throws(() => first.core.externalLinks.link(request), /link receipt rejected/);
    assert.equal(raw.prepare('SELECT COUNT(*) AS count FROM commitment_external_links').get().count, 0);
    raw.exec('DROP TRIGGER reject_external_link_receipt');
    raw.close();
    first.core.externalLinks.link(request);
    first.core.close();

    first = openHarness({ dbPath });
    assert.equal(first.core.externalLinks.query({ backend: 'openmax' }).length, 1);
    const check = new Database(dbPath);
    check.pragma('foreign_keys = ON');
    assert.deepEqual(check.pragma('foreign_key_check'), []);
    check.close();
  } finally {
    first.core.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
