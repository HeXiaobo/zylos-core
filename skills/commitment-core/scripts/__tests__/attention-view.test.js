import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  publishAttentionView,
  runAttentionViewCli,
} from '../render-attention-view.js';

const OWNED_PREVIOUS_VIEW = [
  '# Zylos Attention View',
  '',
  '<!-- zylos-attention-view: version=1; generated-at=2026-08-24T07:00:00.000Z; source=commitment-core; derived=true -->',
  '',
  '> previous attention view',
  '',
].join('\n');

function task(id, state, updatedAt) {
  return {
    id,
    title: `${state} ${id}`,
    description: null,
    state,
    ownerId: 'owner-1',
    acceptorId: 'owner-1',
    assigneeId: null,
    version: 1,
    createdAt: '2026-08-25T00:00:00.000Z',
    updatedAt,
  };
}

test('publishes only open tasks in deterministic attention order', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'zylos-attention-view-'));
  const outputPath = path.join(directory, 'state.md');
  let receivedQuery;
  const core = {
    query(query) {
      receivedQuery = query;
      return [
        task('ready-newer', 'ready', '2026-08-25T04:00:00.000Z'),
        task('done', 'done', '2026-08-25T05:00:00.000Z'),
        task('review-later-id', 'review', '2026-08-25T01:00:00.000Z'),
        task('cancelled', 'cancelled', '2026-08-25T06:00:00.000Z'),
        task('in-progress', 'in_progress', '2026-08-25T02:00:00.000Z'),
        task('review-earlier-id', 'review', '2026-08-25T01:00:00.000Z'),
        task('ready-older', 'ready', '2026-08-25T03:00:00.000Z'),
      ];
    },
  };

  try {
    const result = publishAttentionView({
      core,
      outputPath,
      generatedAt: '2026-08-25T07:00:00.000Z',
    });
    const content = readFileSync(outputPath, 'utf8');

    assert.deepEqual(receivedQuery, {
      states: ['review', 'in_progress', 'ready'],
      limit: 100,
    });
    assert.equal(result.taskCount, 5);
    assert.equal(result.omittedTaskCount, 0);
    assert.match(content, /version=1; generated-at=2026-08-25T07:00:00.000Z/);
    assert.ok(content.indexOf('review review\\-earlier\\-id') < content.indexOf('review review\\-later\\-id'));
    assert.ok(content.indexOf('review review\\-later\\-id') < content.indexOf('in\\_progress in\\-progress'));
    assert.ok(content.indexOf('in\\_progress in\\-progress') < content.indexOf('ready ready\\-older'));
    assert.ok(content.indexOf('ready ready\\-older') < content.indexOf('ready ready\\-newer'));
    assert.doesNotMatch(content, /done done|cancelled cancelled/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('escapes task fields so Core content cannot inject attention-view Markdown', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'zylos-attention-view-'));
  const outputPath = path.join(directory, 'state.md');
  const maliciousTask = {
    ...task('task-|-[id]', 'review', '2026-08-25T01:00:00.000Z'),
    title: 'Break\n## injected [link](https://bad) | <b>',
    description: '> shell\r\n- surprise & goodbye',
    ownerId: 'owner_*admin*',
  };

  try {
    publishAttentionView({
      core: { query: () => [maliciousTask] },
      outputPath,
      generatedAt: '2026-08-25T07:00:00.000Z',
    });
    const content = readFileSync(outputPath, 'utf8');

    assert.doesNotMatch(content, /\n## injected|<b>|\n- surprise/);
    assert.match(content, /Break \\#\\# injected \\\[link\\\]\\\(https:\/\/bad\\\) \\\| &lt;b&gt;/);
    assert.match(content, /owner\\_\\\*admin\\\*/);
    assert.match(content, /&gt; shell \\- surprise &amp; goodbye/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('keeps the rendered view within its byte budget and marks omitted tasks', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'zylos-attention-view-'));
  const outputPath = path.join(directory, 'state.md');
  const tasks = Array.from({ length: 8 }, (_, index) => ({
    ...task(`task-${index}`, 'ready', `2026-08-25T0${index}:00:00.000Z`),
    description: `详情-${index}-${'很长'.repeat(120)}`,
  }));

  try {
    const result = publishAttentionView({
      core: { query: () => tasks },
      outputPath,
      generatedAt: '2026-08-25T07:00:00.000Z',
      maxBytes: 1024,
    });
    const content = readFileSync(outputPath, 'utf8');

    assert.ok(Buffer.byteLength(content) <= 1024);
    assert.equal(result.bytes, Buffer.byteLength(content));
    assert.equal(result.truncated, true);
    assert.ok(result.omittedTaskCount > 0);
    assert.match(content, new RegExp(`Truncated: ${result.omittedTaskCount} additional open task`));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('keeps the previous owned Attention view when the atomic rename fails', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'zylos-attention-view-'));
  const outputPath = path.join(directory, 'state.md');
  fs.writeFileSync(outputPath, OWNED_PREVIOUS_VIEW);
  const failingFileSystem = {
    ...fs,
    renameSync() {
      throw new Error('injected rename failure');
    },
  };

  try {
    assert.throws(() => publishAttentionView({
      core: { query: () => [task('task-1', 'ready', '2026-08-25T01:00:00.000Z')] },
      outputPath,
      generatedAt: '2026-08-25T07:00:00.000Z',
      fileSystem: failingFileSystem,
      temporaryId: () => 'test-temp',
    }), /injected rename failure/);

    assert.equal(readFileSync(outputPath, 'utf8'), OWNED_PREVIOUS_VIEW);
    assert.deepEqual(fs.readdirSync(directory), ['state.md']);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('refuses to replace a file that lacks the Attention ownership/version marker', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'zylos-attention-view-foreign-'));
  const outputPath = path.join(directory, 'state.md');
  const foreignContent = '# Current Focus\n\nHuman-authored memory that must survive.\n';
  fs.writeFileSync(outputPath, foreignContent);
  let queries = 0;

  try {
    assert.throws(() => publishAttentionView({
      core: {
        query() {
          queries += 1;
          return [];
        },
      },
      outputPath,
      generatedAt: '2026-08-25T07:00:00.000Z',
    }), (error) => error?.code === 'ATTENTION_VIEW_NOT_OWNED');
    assert.equal(queries, 0);
    assert.equal(readFileSync(outputPath, 'utf8'), foreignContent);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('marks omitted count unknown when the Core query limit is reached', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'zylos-attention-view-'));
  const outputPath = path.join(directory, 'state.md');
  const tasks = Array.from({ length: 100 }, (_, index) => task(
    `task-${String(index).padStart(3, '0')}`,
    'ready',
    '2026-08-25T01:00:00.000Z',
  ));

  try {
    const result = publishAttentionView({
      core: { query: () => tasks },
      outputPath,
      generatedAt: '2026-08-25T07:00:00.000Z',
    });
    const content = readFileSync(outputPath, 'utf8');

    assert.equal(result.queryLimitReached, true);
    assert.equal(result.truncated, true);
    assert.equal(result.omittedTaskCount, null);
    assert.match(content, /Query limit reached \(100\); the number of additional open tasks is unknown/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('standalone CLI opens Core, writes the default ZYLOS_DIR view, and closes Core', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'zylos-attention-view-cli-'));
  let closed = false;
  let stdout = '';
  const core = {
    query: () => [task('task-1', 'ready', '2026-08-25T01:00:00.000Z')],
    close() {
      closed = true;
    },
  };

  try {
    const result = await runAttentionViewCli({
      args: ['--json'],
      env: { ZYLOS_DIR: directory },
      openCore: () => core,
      clock: () => new Date('2026-08-25T07:00:00.000Z'),
      stdout: { write: (chunk) => { stdout += chunk; } },
    });

    assert.equal(result.outputPath, path.join(directory, 'memory', 'task-attention.md'));
    assert.equal(closed, true);
    assert.match(readFileSync(result.outputPath, 'utf8'), /ready task\\-1/);
    assert.deepEqual(JSON.parse(stdout), result);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('standalone CLI rejects malformed arguments before opening Core', async () => {
  const invalidArguments = [
    ['state.md'],
    ['--unknown'],
    ['--json=true'],
    ['--json', '--json'],
    ['--output'],
    ['--output', '--json'],
    ['--max-bytes', '1024.5'],
    ['--max-bytes', '1'],
    ['--max-bytes', '999999'],
  ];
  let openCount = 0;

  for (const args of invalidArguments) {
    await assert.rejects(runAttentionViewCli({
      args,
      openCore: () => {
        openCount += 1;
        throw new Error('Core should not open');
      },
    }), TypeError);
  }
  assert.equal(openCount, 0);
});

test('rejects a non-canonical generation timestamp without replacing the old view', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'zylos-attention-view-'));
  const outputPath = path.join(directory, 'state.md');
  fs.writeFileSync(outputPath, OWNED_PREVIOUS_VIEW);

  try {
    for (const generatedAt of ['not-a-date', '2026-08-25T07:00:00Z\n## injected']) {
      assert.throws(() => publishAttentionView({
        core: { query: () => [] },
        outputPath,
        generatedAt,
      }), TypeError);
    }
    assert.equal(readFileSync(outputPath, 'utf8'), OWNED_PREVIOUS_VIEW);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('fails closed when Core returns a malformed task record', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'zylos-attention-view-'));
  const outputPath = path.join(directory, 'state.md');
  fs.writeFileSync(outputPath, OWNED_PREVIOUS_VIEW);

  try {
    assert.throws(() => publishAttentionView({
      core: { query: () => [{}] },
      outputPath,
      generatedAt: '2026-08-25T07:00:00.000Z',
    }), TypeError);
    assert.equal(readFileSync(outputPath, 'utf8'), OWNED_PREVIOUS_VIEW);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('bounds individual Core fields before rendering and marks content truncation', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'zylos-attention-view-'));
  const outputPath = path.join(directory, 'state.md');
  const oversizedTask = {
    ...task('task-1', 'review', '2026-08-25T01:00:00.000Z'),
    title: '题'.repeat(1000),
    description: '述'.repeat(5000),
  };

  try {
    const result = publishAttentionView({
      core: { query: () => [oversizedTask] },
      outputPath,
      generatedAt: '2026-08-25T07:00:00.000Z',
    });
    const content = readFileSync(outputPath, 'utf8');

    assert.equal(result.taskCount, 1);
    assert.equal(result.fieldTruncatedTaskCount, 1);
    assert.equal(result.truncated, true);
    assert.match(content, /Content truncated: one or more task fields exceeded per-field limits/);
    assert.ok(Buffer.byteLength(content) <= 16 * 1024);
    assert.ok((content.match(/题/g) ?? []).length <= 256);
    assert.ok((content.match(/述/g) ?? []).length <= 1024);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('executable script rebuilds the dedicated task Attention view through a real Core query', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'zylos-attention-view-e2e-'));
  const { openCommitmentCore } = await import('../core.js');
  const core = openCommitmentCore({
    dbPath: path.join(directory, 'commitments', 'commitments.db'),
    idGenerator: () => 'task-e2e',
    eventIdGenerator: () => 'event-e2e',
    clock: () => '2026-08-25T01:00:00.000Z',
  });

  try {
    core.ingest({
      idempotencyKey: 'e2e:task',
      source: { channel: 'test', externalId: 'message-e2e', senderId: 'owner-e2e' },
      task: { title: 'E2E task', ownerId: 'owner-e2e' },
    });
    core.close();

    const scriptPath = fileURLToPath(new URL('../render-attention-view.js', import.meta.url));
    const child = spawnSync(process.execPath, [scriptPath, '--json'], {
      encoding: 'utf8',
      env: { ...process.env, ZYLOS_DIR: directory },
    });

    assert.equal(child.status, 0, child.stderr);
    const result = JSON.parse(child.stdout);
    assert.equal(result.taskCount, 1);
    assert.equal(result.outputPath, path.join(directory, 'memory', 'task-attention.md'));
    assert.match(readFileSync(result.outputPath, 'utf8'), /E2E task/);
  } finally {
    try {
      core.close();
    } catch {
      // The Core is normally closed before invoking the child process.
    }
    rmSync(directory, { recursive: true, force: true });
  }
});
