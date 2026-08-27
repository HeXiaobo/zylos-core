import assert from 'node:assert/strict';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { openCommitmentCore } from '../core.js';
import {
  parseLegacyTaskAdoptionManifest,
  runLegacyTaskAdoptionCli,
} from '../legacy-task-adoption.js';

function captureStdout() {
  let output = '';
  return {
    write(value) {
      output += value;
    },
    read() {
      return JSON.parse(output);
    },
  };
}

function task(overrides = {}) {
  return {
    title: 'Legacy native task',
    description: 'Keep this existing task body.',
    ownerId: 'owner-1',
    acceptorId: 'owner-1',
    assigneeId: 'agent:ss',
    ...overrides,
  };
}

function manifest(entries) {
  return JSON.stringify({
    schema: 'zylos.legacy-task-adoption/v1',
    entries,
  });
}

function entry(overrides = {}) {
  return {
    idempotencyKey: 'legacy-adoption:one',
    externalId: 'guid-one',
    taskId: 'core-task-one',
    task: task(),
    ...overrides,
  };
}

function writeManifest(directory, entries) {
  const manifestPath = path.join(directory, 'adoption.json');
  writeFileSync(manifestPath, manifest(entries));
  return manifestPath;
}

test('manifest parser rejects unknown fields and duplicate ids before opening Core', () => {
  const base = entry();
  for (const value of [
    { ...base, unexpected: true },
    { ...base, task: task({ unexpected: true }) },
    { schema: 'zylos.legacy-task-adoption/v1', entries: [base, base] },
    {
      schema: 'zylos.legacy-task-adoption/v1',
      entries: [base, entry({ idempotencyKey: 'legacy-adoption:two' })],
    },
    {
      schema: 'zylos.legacy-task-adoption/v1',
      entries: [base, entry({ externalId: 'guid-two' })],
    },
    {
      schema: 'zylos.legacy-task-adoption/v1',
      entries: [base, entry({ taskId: 'core-task-two', idempotencyKey: 'legacy-adoption:two' })],
    },
  ]) {
    assert.throws(
      () => parseLegacyTaskAdoptionManifest(value),
      error => error?.code === 'INVALID_MANIFEST',
    );
  }
});

test('default plan validates through Core in memory and never creates the requested DB', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'zylos-adoption-cli-plan-'));
  try {
    const manifestPath = writeManifest(directory, [entry()]);
    const dbPath = path.join(directory, 'should-not-exist.sqlite');
    const stdout = captureStdout();
    const report = runLegacyTaskAdoptionCli({
      args: ['--manifest', manifestPath, '--db-path', dbPath],
      stdout,
    });

    assert.equal(report.mode, 'plan');
    assert.equal(report.storage, 'isolated-memory');
    assert.equal(report.writes, false);
    assert.equal(report.succeeded, 1);
    assert.equal(report.results[0].result.task.id, 'core-task-one');
    assert.equal(existsSync(dbPath), false);
    assert.deepEqual(stdout.read(), report);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('plan snapshots an existing Core DB and detects conflicts without writing it', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'zylos-adoption-cli-snapshot-'));
  const dbPath = path.join(directory, 'commitments.db');
  try {
    let core = openCommitmentCore({ dbPath });
    try {
      const existing = core.ingest({
        idempotencyKey: 'source-existing',
        source: { channel: 'test', externalId: 'source-existing', senderId: 'owner-1' },
        task: task({ title: 'Existing Core task' }),
      });
      core.externalLinks.link({
        taskId: existing.task.id,
        actorId: 'owner-1',
        backend: 'feishu-task-v2',
        externalId: 'guid-already-linked',
        idempotencyKey: 'link-existing',
      });
    } finally {
      core.close();
    }

    const sourceBefore = readFileSync(dbPath);
    const manifestPath = writeManifest(directory, [entry({
      externalId: 'guid-already-linked',
      taskId: 'core-task-conflict',
    })]);
    const report = runLegacyTaskAdoptionCli({
      args: ['--manifest', manifestPath, '--db-path', dbPath],
      stdout: captureStdout(),
    });

    assert.equal(report.storage, 'read-only-snapshot');
    assert.equal(report.writes, false);
    assert.equal(report.sourceDb.status, 'snapshotted');
    assert.equal(report.sourceDb.path, path.resolve(dbPath));
    assert.equal(report.sourceDb.fingerprint.bytes, sourceBefore.length);
    assert.match(report.sourceDb.fingerprint.sha256, /^[0-9a-f]{64}$/);
    assert.match(report.sourceDb.snapshot.sha256, /^[0-9a-f]{64}$/);
    assert.equal(report.results[0].error.code, 'EXTERNAL_LINK_CONFLICT');
    assert.deepEqual(readFileSync(dbPath), sourceBefore);

    core = openCommitmentCore({ dbPath });
    try {
      assert.equal(core.query({ limit: 10 }).length, 1);
      assert.equal(core.externalLinks.query({ backend: 'feishu-task-v2' }).length, 1);
      assert.equal(core.query({ taskId: 'core-task-conflict' }), null);
    } finally {
      core.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('explicit commit is per-entry idempotent and persists exactly one adoption', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'zylos-adoption-cli-commit-'));
  const dbPath = path.join(directory, 'commitments.db');
  try {
    const manifestPath = writeManifest(directory, [entry()]);
    const first = runLegacyTaskAdoptionCli({
      args: ['--manifest', manifestPath, '--db-path', dbPath, '--commit'],
      stdout: captureStdout(),
    });
    const replay = runLegacyTaskAdoptionCli({
      args: ['--manifest', manifestPath, '--db-path', dbPath, '--commit'],
      stdout: captureStdout(),
    });

    assert.equal(first.mode, 'commit');
    assert.equal(first.writes, true);
    assert.equal(first.results[0].result.created, true);
    assert.deepEqual(replay.results[0].result, first.results[0].result);

    const core = openCommitmentCore({ dbPath });
    try {
      assert.equal(core.query({ limit: 10 }).length, 1);
      assert.equal(core.externalLinks.query({ backend: 'feishu-task-v2' }).length, 1);
    } finally {
      core.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('one item conflict is reported without preventing later entries or partial writes', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'zylos-adoption-cli-batch-'));
  const dbPath = path.join(directory, 'commitments.db');
  try {
    let core = openCommitmentCore({ dbPath });
    try {
      const existing = core.ingest({
        idempotencyKey: 'source-existing',
        source: { channel: 'test', externalId: 'source-existing', senderId: 'owner-1' },
        task: task({ title: 'Existing Core task' }),
      });
      core.externalLinks.link({
        taskId: existing.task.id,
        actorId: 'owner-1',
        backend: 'feishu-task-v2',
        externalId: 'guid-already-linked',
        idempotencyKey: 'link-existing',
      });
    } finally {
      core.close();
    }

    const manifestPath = writeManifest(directory, [
      entry({
        idempotencyKey: 'legacy-adoption:conflict',
        externalId: 'guid-already-linked',
        taskId: 'core-task-conflict',
      }),
      entry({
        idempotencyKey: 'legacy-adoption:success',
        externalId: 'guid-success',
        taskId: 'core-task-success',
      }),
    ]);
    const report = runLegacyTaskAdoptionCli({
      args: ['--manifest', manifestPath, '--db-path', dbPath, '--commit'],
      stdout: captureStdout(),
    });

    assert.equal(report.total, 2);
    assert.equal(report.succeeded, 1);
    assert.equal(report.failed, 1);
    assert.equal(report.results[0].error.code, 'EXTERNAL_LINK_CONFLICT');
    assert.equal(report.results[1].ok, true);

    core = openCommitmentCore({ dbPath });
    try {
      const tasks = core.query({ limit: 10 });
      assert.equal(tasks.length, 2);
      assert.equal(core.query({ taskId: 'core-task-conflict' }), null);
      assert.equal(core.query({ taskId: 'core-task-success' }).id, 'core-task-success');
    } finally {
      core.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
