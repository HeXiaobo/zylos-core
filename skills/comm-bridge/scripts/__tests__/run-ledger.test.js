import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import Database from 'better-sqlite3';

import { openAssistantResponseStream } from '../assistant-response-stream.js';
import { openRunLedger } from '../run-ledger.js';

function temporaryDatabase(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-run-ledger-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return path.join(directory, 'c4.db');
}

function acceptMessage(overrides = {}) {
  const source = {
    adapterId: 'feishu',
    accountRef: 'account-1',
    targetRef: 'opaque:chat-1:message-1',
    conversationKey: 'feishu:account-1:p2p:chat-1:chat',
    messageId: 'message-1',
    eventId: 'event-1',
    eventType: 'im.message.receive_v1',
    payloadHash: `sha256:${'1'.repeat(64)}`,
    ...overrides.source,
  };
  return {
    schemaVersion: 1,
    type: 'AcceptMessage',
    commandId: `command:${source.eventId}`,
    idempotencyKey: `feishu:account-1:${source.eventType}:${source.eventId}`,
    traceId: `trace:${source.messageId}`,
    causationId: source.eventId,
    issuedAt: '2026-09-01T00:00:00.000Z',
    source,
    actor: {
      provider: 'feishu',
      tenantRef: 'tenant-1',
      externalId: 'user-1',
    },
    content: { kind: 'text', text: `message ${source.messageId}` },
    contextHints: {
      threadRef: null,
      rootRef: null,
      parentRef: null,
      quoteRefs: [],
      mentionRefs: [],
      attachmentRefs: [],
    },
    reply: { mode: 'required', targetRef: source.targetRef },
    policy: { priority: 2, requireIdle: false },
    ...overrides,
    source,
  };
}

test('accept safely replays transport and logical duplicates before allocating another lane sequence', (t) => {
  const ledger = openRunLedger({ dbPath: temporaryDatabase(t), clock: () => 100 });
  t.after(() => ledger.close());

  const command = acceptMessage();
  const first = ledger.accept(command);
  const transportReplay = ledger.accept(command);
  const logicalReplay = ledger.accept(acceptMessage({
    idempotencyKey: 'feishu:account-1:im.message.receive_v1:event-2',
    commandId: 'command:event-2',
    causationId: 'event-2',
    source: { eventId: 'event-2' },
  }));
  const second = ledger.accept(acceptMessage({
    idempotencyKey: 'feishu:account-1:im.message.receive_v1:event-3',
    commandId: 'command:event-3',
    causationId: 'event-3',
    traceId: 'trace:message-2',
    source: { eventId: 'event-3', messageId: 'message-2' },
  }));

  assert.equal(first.replayed, false);
  assert.equal(transportReplay.replayed, true);
  assert.equal(logicalReplay.replayed, true);
  assert.equal(transportReplay.accepted.requestId, first.accepted.requestId);
  assert.equal(logicalReplay.accepted.requestId, first.accepted.requestId);
  assert.equal(first.accepted.laneSequence, 1);
  assert.deepEqual(first.request.replyPolicy, {
    mode: 'required',
    route: { adapterId: 'feishu', targetRef: 'opaque:chat-1:message-1' },
  });
  assert.equal(second.accepted.laneSequence, 2);
  assert.deepEqual(
    ledger.listEvents(first.accepted.requestId).map(event => [event.type, event.sequence]),
    [['RunAccepted', 1], ['RunQueued', 2]],
  );
});

test('accept fails closed when an idempotency or logical identity is reused with another payload', (t) => {
  const ledger = openRunLedger({ dbPath: temporaryDatabase(t) });
  t.after(() => ledger.close());
  const command = acceptMessage();
  ledger.accept(command);

  assert.throws(
    () => ledger.accept({
      ...command,
      source: { ...command.source, payloadHash: `sha256:${'2'.repeat(64)}` },
    }),
    error => error?.code === 'IDEMPOTENCY_CONFLICT',
  );
  assert.throws(
    () => ledger.accept(acceptMessage({
      idempotencyKey: 'feishu:account-1:im.message.receive_v1:event-2',
      commandId: 'command:event-2',
      causationId: 'event-2',
      source: {
        eventId: 'event-2',
        payloadHash: `sha256:${'3'.repeat(64)}`,
      },
    })),
    error => error?.code === 'IDEMPOTENCY_CONFLICT',
  );
  assert.throws(
    () => ledger.accept({
      ...command,
      reply: { ...command.reply, mode: 'none' },
    }),
    error => error?.code === 'IDEMPOTENCY_CONFLICT',
  );
  assert.throws(
    () => ledger.accept({
      ...command,
      reply: { ...command.reply, targetRef: 'opaque:changed-route' },
    }),
    error => error?.code === 'IDEMPOTENCY_CONFLICT',
  );
});

test('different conversation lanes complete durable acceptance independently', async (t) => {
  const dbPath = temporaryDatabase(t);
  const firstLedger = openRunLedger({ dbPath });
  const secondLedger = openRunLedger({ dbPath });
  t.after(() => firstLedger.close());
  t.after(() => secondLedger.close());

  const [first, second] = await Promise.all([
    Promise.resolve().then(() => firstLedger.accept(acceptMessage())),
    Promise.resolve().then(() => secondLedger.accept(acceptMessage({
      idempotencyKey: 'hxa:account-2:message:event-2',
      commandId: 'command:event-2',
      traceId: 'trace:message-2',
      causationId: 'event-2',
      source: {
        adapterId: 'hxa-connect',
        accountRef: 'account-2',
        targetRef: 'opaque:hxa-thread-2',
        conversationKey: 'hxa:account-2:thread-2',
        messageId: 'message-2',
        eventId: 'event-2',
        eventType: 'message',
        payloadHash: `sha256:${'2'.repeat(64)}`,
      },
    }))),
  ]);

  assert.equal(first.accepted.laneSequence, 1);
  assert.equal(second.accepted.laneSequence, 1);
  assert.notEqual(first.accepted.requestId, second.accepted.requestId);
  assert.equal(firstLedger.get(first.accepted.requestId).status, 'queued');
  assert.equal(secondLedger.get(second.accepted.requestId).status, 'queued');
});

test('the v1 ledger extends the existing issue-35 request and event tables in place', (t) => {
  const dbPath = temporaryDatabase(t);
  const legacy = openAssistantResponseStream({ dbPath, clock: () => 50 });
  legacy.execute({
    type: 'AcceptAssistantRequest',
    requestId: 'assistant.legacy.request',
    sourceId: 'legacy-message',
    route: { channel: 'legacy', endpointId: 'opaque:legacy' },
    conversation: {
      content: 'legacy request',
      status: 'pending',
      priority: 2,
      requireIdle: false,
    },
  });
  legacy.close();

  const ledger = openRunLedger({ dbPath, clock: () => 100 });
  const accepted = ledger.accept(acceptMessage());
  ledger.close();
  const database = new Database(dbPath, { readonly: true });
  t.after(() => database.close());

  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM assistant_requests').get().count, 2);
  assert.equal(
    database.prepare('SELECT COUNT(*) AS count FROM assistant_response_events').get().count,
    4,
  );
  assert.equal(
    database.prepare(`
      SELECT COUNT(*) AS count FROM assistant_run_ledger WHERE request_id = ?
    `).get(accepted.accepted.requestId).count,
    1,
  );
  assert.equal(
    database.prepare(`
      SELECT COUNT(*) AS count FROM assistant_run_ledger
      WHERE request_id = 'assistant.legacy.request'
    `).get().count,
    0,
  );
});
