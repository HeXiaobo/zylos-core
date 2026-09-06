import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { describe, it } from 'node:test';

import { openAssistantResponseStream } from '../../../skills/comm-bridge/scripts/assistant-response-stream.js';

// better-sqlite3 is installed at the skill level, not the repo root; resolve
// it from the skill's own module graph.
const require = createRequire(
  new URL('../../../skills/comm-bridge/scripts/assistant-response-stream.js', import.meta.url),
);
const Database = require('better-sqlite3');

function accept(stream, requestId = 'assistant.feishu.fail_1', sourceId = 'fail_1') {
  return stream.execute({
    type: 'AcceptAssistantRequest',
    requestId,
    sourceId,
    route: { channel: 'feishu', endpointId: 'oc_fail|type:p2p|msg:fail_1' },
    conversation: {
      content: '[Feishu DM] User said: hello',
      status: 'pending',
      priority: 3,
      requireIdle: false,
    },
  });
}

function outboundRow(dbPath, requestId) {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db.prepare(`
      SELECT content, status, delivery_action
      FROM conversations
      WHERE direction = 'out' AND assistant_request_id = ?
    `).get(requestId);
  } finally {
    db.close();
  }
}

function withFileDb(callback) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-failed-run-'));
  const dbPath = path.join(directory, 'c4.db');
  try {
    callback(dbPath);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

describe('failed assistant runs preserve the drafted reply (issue #79)', () => {
  it('persists the drafted output into the failed outbound row', () => {
    withFileDb((dbPath) => {
      const stream = openAssistantResponseStream({ dbPath });
      try {
        accept(stream);
        stream.execute({ type: 'StartRun', requestId: 'assistant.feishu.fail_1' });
        stream.execute({
          type: 'AppendOutputDelta',
          requestId: 'assistant.feishu.fail_1',
          delta: 'the complete researched answer',
          idempotencyKey: 'draft:1',
        });
        stream.execute({
          type: 'FailRun',
          requestId: 'assistant.feishu.fail_1',
          code: 'RUNTIME_TURN_BINDING_NOT_VERIFIED',
          retryable: true,
        });

        const row = outboundRow(dbPath, 'assistant.feishu.fail_1');
        assert.ok(row, 'expected an outbound conversations row');
        assert.equal(row.status, 'failed');
        assert.equal(row.content, 'the complete researched answer');
        assert.equal(row.delivery_action, 'assistant-response-failed:RUNTIME_TURN_BINDING_NOT_VERIFIED');
      } finally {
        stream.close();
      }
    });
  });

  it('keeps an empty draft empty — no phantom content is invented', () => {
    withFileDb((dbPath) => {
      const stream = openAssistantResponseStream({ dbPath });
      try {
        accept(stream);
        stream.execute({ type: 'StartRun', requestId: 'assistant.feishu.fail_1' });
        stream.execute({
          type: 'FailRun',
          requestId: 'assistant.feishu.fail_1',
          code: 'RUNTIME_TURN_FINISHED_WITHOUT_RESPONSE',
          retryable: false,
        });

        const row = outboundRow(dbPath, 'assistant.feishu.fail_1');
        assert.equal(row.status, 'failed');
        assert.equal(row.content, '');
      } finally {
        stream.close();
      }
    });
  });

  it('preserves the partial draft of stale runs after a runtime restart', () => {
    withFileDb((dbPath) => {
      let now = 1_000;
      const stream = openAssistantResponseStream({ dbPath, clock: () => now });
      try {
        accept(stream);
        stream.execute({ type: 'StartRun', requestId: 'assistant.feishu.fail_1' });
        stream.execute({
          type: 'AppendOutputDelta',
          requestId: 'assistant.feishu.fail_1',
          delta: 'partial answer before the restart',
          idempotencyKey: 'draft:stale',
        });
        now += 10_000;
        stream.execute({ type: 'ExpireStaleRuns', staleBefore: now });

        const row = outboundRow(dbPath, 'assistant.feishu.fail_1');
        assert.equal(row.status, 'failed');
        assert.equal(row.content, 'partial answer before the restart');
        assert.equal(row.delivery_action, 'assistant-response-failed:RUN_STALE_AFTER_RESTART');
      } finally {
        stream.close();
      }
    });
  });

  it('queryFailedRuns surfaces failed runs with their drafted reply and retryable flag', () => {
    withFileDb((dbPath) => {
      const stream = openAssistantResponseStream({ dbPath });
      try {
        accept(stream, 'assistant.feishu.fail_a', 'fail_a');
        stream.execute({ type: 'StartRun', requestId: 'assistant.feishu.fail_a' });
        stream.execute({
          type: 'AppendOutputDelta',
          requestId: 'assistant.feishu.fail_a',
          delta: 'recoverable answer',
          idempotencyKey: 'draft:a',
        });
        stream.execute({
          type: 'FailRun',
          requestId: 'assistant.feishu.fail_a',
          code: 'RUNTIME_TURN_BINDING_NOT_VERIFIED',
          retryable: true,
        });

        // A completed run must not appear in the failed listing.
        accept(stream, 'assistant.feishu.ok_b', 'ok_b');
        stream.execute({ type: 'StartRun', requestId: 'assistant.feishu.ok_b' });
        stream.execute({
          type: 'CompleteRun',
          requestId: 'assistant.feishu.ok_b',
          output: 'delivered fine',
        });

        const failed = stream.queryFailedRuns();
        assert.equal(failed.length, 1);
        assert.equal(failed[0].requestId, 'assistant.feishu.fail_a');
        assert.equal(failed[0].code, 'RUNTIME_TURN_BINDING_NOT_VERIFIED');
        assert.equal(failed[0].retryable, true);
        assert.equal(failed[0].outputText, 'recoverable answer');
        assert.equal(failed[0].outputChars, 'recoverable answer'.length);
        assert.equal(failed[0].route.channel, 'feishu');
      } finally {
        stream.close();
      }
    });
  });

  it('queryFailedRuns validates its limit', () => {
    withFileDb((dbPath) => {
      const stream = openAssistantResponseStream({ dbPath });
      try {
        assert.throws(() => stream.queryFailedRuns({ limit: 0 }), TypeError);
        assert.throws(() => stream.queryFailedRuns({ limit: 501 }), TypeError);
      } finally {
        stream.close();
      }
    });
  });
});
