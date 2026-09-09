import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { describe, it } from 'node:test';

import { openAssistantResponseStream } from '../../../skills/comm-bridge/scripts/assistant-response-stream.js';

// better-sqlite3 is installed at the skill level, not the repo root; resolve
// it from the skill's own module graph (same pattern as PR #80's suite).
const require = createRequire(
  new URL('../../../skills/comm-bridge/scripts/assistant-response-stream.js', import.meta.url),
);
const Database = require('better-sqlite3');

function accept(stream, requestId = 'assistant.feishu.sup_1', sourceId = 'sup_1') {
  return stream.execute({
    type: 'AcceptAssistantRequest',
    requestId,
    sourceId,
    route: { channel: 'feishu', endpointId: 'oc_sup|type:p2p|msg:sup_1' },
    conversation: {
      content: '[Feishu DM] User said: hello',
      status: 'pending',
      priority: 3,
      requireIdle: false,
    },
  });
}

describe('suppressed is a first-class terminal delivery status (issue #778)', () => {
  it('acknowledges leased events as suppressed instead of delivered', () => {
    const stream = openAssistantResponseStream({ dbPath: ':memory:', clock: () => 1_000 });
    try {
      accept(stream);
      const leased = stream.claimDeliveries({ limit: 10 });
      assert.equal(leased.length, 2);

      const results = stream.acknowledgeDeliveries(leased.map(item => ({
        deliveryId: item.deliveryId,
        leaseToken: item.leaseToken,
      })), { status: 'suppressed' });
      assert.equal(results.filter(item => item.acknowledged).length, 2);

      const suppressed = stream.queryDeliveries({
        requestId: 'assistant.feishu.sup_1',
        status: 'suppressed',
        limit: 10,
      });
      assert.deepEqual(suppressed.map(item => item.event.sequence), [1, 2]);
      assert.ok(suppressed.every(item => item.deliveredAt === 1_000));

      // The conflation is the defect: suppressed must not be queryable as
      // delivered, and a terminal suppressed row must never be re-claimed.
      assert.equal(stream.queryDeliveries({
        requestId: 'assistant.feishu.sup_1',
        status: 'delivered',
        limit: 10,
      }).length, 0);
      assert.equal(stream.claimDeliveries({ limit: 10 }).length, 0);
    } finally {
      stream.close();
    }
  });

  it('keeps delivered acknowledgements the default outcome', () => {
    const stream = openAssistantResponseStream({ dbPath: ':memory:', clock: () => 2_000 });
    try {
      accept(stream);
      const leased = stream.claimDeliveries({ limit: 10 });
      const results = stream.acknowledgeDeliveries(leased.map(item => ({
        deliveryId: item.deliveryId,
        leaseToken: item.leaseToken,
      })));
      assert.equal(results.filter(item => item.acknowledged).length, 2);
      assert.equal(stream.queryDeliveries({
        requestId: 'assistant.feishu.sup_1',
        status: 'delivered',
        limit: 10,
      }).length, 2);
    } finally {
      stream.close();
    }
  });

  it('rejects acknowledgement outcomes outside delivered/suppressed', () => {
    const stream = openAssistantResponseStream({ dbPath: ':memory:' });
    try {
      accept(stream);
      const leased = stream.claimDeliveries({ limit: 10 });
      assert.throws(
        () => stream.acknowledgeDeliveries(leased.map(item => ({
          deliveryId: item.deliveryId,
          leaseToken: item.leaseToken,
        })), { status: 'bogus' }),
        TypeError,
      );
      // The lease survived the rejected acknowledgement.
      const again = stream.claimDeliveries({ limit: 10 });
      assert.equal(again.length, 0, 'events must stay leased after an invalid outcome');
    } finally {
      stream.close();
    }
  });

  it('does not let a suppressed prior sequence fence later events', () => {
    const stream = openAssistantResponseStream({ dbPath: ':memory:', clock: () => 3_000 });
    try {
      accept(stream);
      const leased = stream.claimDeliveries({ limit: 10 });
      stream.acknowledgeDeliveries(leased.map(item => ({
        deliveryId: item.deliveryId,
        leaseToken: item.leaseToken,
      })), { status: 'suppressed' });

      stream.execute({ type: 'StartRun', requestId: 'assistant.feishu.sup_1' });
      const later = stream.claimDeliveries({ limit: 10 });
      assert.deepEqual(later.map(item => item.event.type), ['RunStarted'],
        'a suppressed event is terminal but must not block later sequences');
    } finally {
      stream.close();
    }
  });

  it('keeps suppressed rows out of dead-letter redrive', () => {
    const stream = openAssistantResponseStream({ dbPath: ':memory:', clock: () => 4_000 });
    try {
      accept(stream);
      const leased = stream.claimDeliveries({ limit: 10 });
      stream.acknowledgeDeliveries(leased.map(item => ({
        deliveryId: item.deliveryId,
        leaseToken: item.leaseToken,
      })), { status: 'suppressed' });

      const redrive = stream.redriveDeadLetters({ requestId: 'assistant.feishu.sup_1' });
      assert.deepEqual(redrive, { requestId: 'assistant.feishu.sup_1', redriven: 0 });
      assert.equal(stream.queryDeliveries({
        requestId: 'assistant.feishu.sup_1',
        status: 'suppressed',
        limit: 10,
      }).length, 2);
    } finally {
      stream.close();
    }
  });
});

describe('legacy assistant_response_events are rebuilt for the suppressed status (issue #778)', () => {
  it('migrates a pre-suppressed table in place and preserves its rows', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-suppressed-migration-'));
    const dbPath = path.join(directory, 'c4.db');
    const legacy = new Database(dbPath);
    // Shape of assistant_response_events before this change: the delivery
    // CHECK without 'suppressed', no redrive_count, no canonical columns.
    legacy.exec(`
      CREATE TABLE conversations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        direction TEXT NOT NULL,
        channel TEXT NOT NULL,
        content TEXT NOT NULL
      );
      CREATE TABLE assistant_requests (
        request_id TEXT PRIMARY KEY,
        conversation_id INTEGER UNIQUE,
        route_channel TEXT NOT NULL,
        route_endpoint TEXT NOT NULL,
        source_id TEXT NOT NULL,
        status TEXT NOT NULL
          CHECK (status IN ('queued', 'started', 'completed', 'failed')),
        runtime_session_id TEXT,
        next_sequence INTEGER NOT NULL DEFAULT 1 CHECK (next_sequence >= 1),
        output_text TEXT NOT NULL DEFAULT '',
        accepted_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        terminal_at INTEGER,
        FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE RESTRICT
      );
      CREATE TABLE assistant_response_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        request_id TEXT NOT NULL,
        sequence INTEGER NOT NULL CHECK (sequence >= 1),
        event_type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        idempotency_key TEXT,
        delivery_status TEXT NOT NULL DEFAULT 'pending'
          CHECK (delivery_status IN ('pending', 'processing', 'delivered', 'dead_letter')),
        retry_count INTEGER NOT NULL DEFAULT 0 CHECK (retry_count >= 0),
        available_at INTEGER NOT NULL,
        lease_token TEXT,
        lease_expires_at INTEGER,
        last_error TEXT,
        created_at INTEGER NOT NULL,
        delivered_at INTEGER,
        FOREIGN KEY (request_id) REFERENCES assistant_requests(request_id) ON DELETE RESTRICT,
        UNIQUE (request_id, sequence),
        UNIQUE (request_id, idempotency_key)
      );
      INSERT INTO conversations (direction, channel, content)
        VALUES ('in', 'feishu', 'legacy inbound');
      INSERT INTO assistant_requests (
        request_id, conversation_id, route_channel, route_endpoint, source_id,
        status, next_sequence, output_text, accepted_at, updated_at
      ) VALUES ('assistant.feishu.legacy_1', 1, 'feishu', 'oc_legacy', 'legacy_1',
        'started', 3, '', 900, 900);
      INSERT INTO assistant_response_events (
        request_id, sequence, event_type, payload_json, delivery_status,
        available_at, created_at, delivered_at
      ) VALUES
        ('assistant.feishu.legacy_1', 1, 'AssistantRequestAccepted', '{}', 'delivered', 900, 900, 905),
        ('assistant.feishu.legacy_1', 2, 'RunQueued', '{}', 'pending', 900, 900, NULL);
    `);
    legacy.close();

    const stream = openAssistantResponseStream({ dbPath, clock: () => 1_500 });
    try {
      // The rebuilt table accepts 'suppressed' and preserved both legacy rows.
      const leased = stream.claimDeliveries({ limit: 10 });
      assert.deepEqual(leased.map(item => item.event.sequence), [2]);

      const suppressedAck = stream.acknowledgeDeliveries(leased.map(item => ({
        deliveryId: item.deliveryId,
        leaseToken: item.leaseToken,
      })), { status: 'suppressed' });
      assert.equal(suppressedAck.filter(item => item.acknowledged).length, 1);

      const suppressed = stream.queryDeliveries({
        requestId: 'assistant.feishu.legacy_1',
        status: 'suppressed',
        limit: 10,
      });
      assert.deepEqual(suppressed.map(item => item.event.sequence), [2]);

      const delivered = stream.queryDeliveries({
        requestId: 'assistant.feishu.legacy_1',
        status: 'delivered',
        limit: 10,
      });
      assert.deepEqual(delivered.map(item => item.event.sequence), [1]);
      assert.equal(delivered[0].deliveredAt, 905, 'legacy delivered_at must survive the rebuild');
    } finally {
      stream.close();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});
