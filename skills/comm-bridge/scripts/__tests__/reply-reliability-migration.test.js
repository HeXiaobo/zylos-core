import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import Database from 'better-sqlite3';

import { openAssistantResponseStream } from '../assistant-response-stream.js';
import { openEventSubscriptions } from '../event-subscription.js';
import { openReplyIntentOutbox } from '../reply-intent-outbox.js';
import { openReplyOutcomeTransactions } from '../reply-outcome.js';
import { openRunLedger } from '../run-ledger.js';
import { openRuntimePendingQueue } from '../runtime-pending-queue.js';

function temporaryDatabase(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-reply-migration-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return path.join(directory, 'c4.db');
}

function legacyAccept(stream, requestId) {
  return stream.execute({
    type: 'AcceptAssistantRequest',
    requestId,
    sourceId: `source:${requestId}`,
    route: { channel: 'feishu', endpointId: `opaque:${requestId}` },
    conversation: {
      content: `legacy input ${requestId}`,
      status: 'pending',
      priority: 2,
      requireIdle: false,
    },
  });
}

function acceptMessage() {
  return {
    schemaVersion: 1,
    type: 'AcceptMessage',
    commandId: 'command:migrated-new',
    idempotencyKey: 'idempotency:migrated-new',
    traceId: 'trace:migrated-new',
    causationId: 'cause:migrated-new',
    issuedAt: '2026-09-01T00:00:00.000Z',
    source: {
      adapterId: 'feishu',
      accountRef: 'account-1',
      targetRef: 'opaque:migrated-new',
      conversationKey: 'lane:migrated-new',
      messageId: 'message:migrated-new',
      eventId: 'event:migrated-new',
      eventType: 'message',
      payloadHash: `sha256:${'d'.repeat(64)}`,
    },
    actor: { provider: 'feishu', tenantRef: 'tenant-1', externalId: 'user-1' },
    content: { kind: 'text', text: 'new input after migration' },
    contextHints: {
      threadRef: null,
      rootRef: null,
      parentRef: null,
      quoteRefs: [],
      mentionRefs: [],
      attachmentRefs: [],
    },
    reply: { mode: 'required', targetRef: 'opaque:migrated-new' },
    policy: { priority: 2, requireIdle: false },
  };
}

test('real issue-35 database migrates additively and preserves legacy answer and silent rows', (t) => {
  const dbPath = temporaryDatabase(t);
  const legacy = openAssistantResponseStream({ dbPath, clock: () => 50 });
  legacyAccept(legacy, 'assistant.legacy.answer');
  legacy.execute({ type: 'StartRun', requestId: 'assistant.legacy.answer' });
  legacy.execute({
    type: 'CompleteRun',
    requestId: 'assistant.legacy.answer',
    output: 'Legacy visible answer.',
  });
  legacyAccept(legacy, 'assistant.legacy.silent');
  legacy.execute({ type: 'StartRun', requestId: 'assistant.legacy.silent' });
  legacy.execute({
    type: 'CompleteRun',
    requestId: 'assistant.legacy.silent',
    output: '[SKIP]',
  });
  legacy.close();
  const before = new Database(dbPath, { readonly: true });
  const legacyEventsBefore = before.prepare(`
    SELECT request_id, sequence, event_type, payload_json
    FROM assistant_response_events
    ORDER BY id ASC
  `).all();
  const legacyOutboundBefore = before.prepare(`
    SELECT assistant_request_id, content, status, delivery_action
    FROM conversations WHERE direction = 'out' ORDER BY id ASC
  `).all();
  before.close();

  const ledger = openRunLedger({ dbPath, clock: () => 100 });
  const queue = openRuntimePendingQueue({ dbPath, clock: () => 100 });
  const outcomes = openReplyOutcomeTransactions({ dbPath, clock: () => 101 });
  const outbox = openReplyIntentOutbox({ dbPath, clock: () => 101 });
  const subscriptions = openEventSubscriptions({ dbPath, clock: () => 101 });
  t.after(() => ledger.close());
  t.after(() => queue.close());
  t.after(() => outcomes.close());
  t.after(() => outbox.close());
  t.after(() => subscriptions.close());
  const accepted = ledger.accept(acceptMessage()).request;
  const claim = queue.claimNext();
  const run = queue.confirmStarted({
    admissionId: claim.admission.id,
    requestId: accepted.requestId,
    turnId: accepted.turnId,
    generation: accepted.generation,
    runtimeSessionId: 'runtime:migrated-new',
  }).request;
  const committed = outcomes.commitRunOutcome({
    requestId: run.requestId,
    turnId: run.turnId,
    generation: run.generation,
    traceId: run.traceId,
    causationId: ledger.listEvents(run.requestId).at(-1).eventId,
    producer: 'runtime:shared',
    idempotencyKey: `run:${run.requestId}:completed`,
    outcome: { kind: 'answer', content: { format: 'text', text: 'New canonical answer.' } },
    reply: {
      route: { adapterId: 'feishu', targetRef: 'opaque:migrated-new' },
      disposition: 'send',
    },
  });
  subscriptions.subscribe({ consumerId: 'new-consumer' });

  const after = new Database(dbPath, { readonly: true });
  assert.deepEqual(after.prepare(`
    SELECT request_id, sequence, event_type, payload_json
    FROM assistant_response_events
    WHERE request_id IN ('assistant.legacy.answer', 'assistant.legacy.silent')
    ORDER BY id ASC
  `).all(), legacyEventsBefore);
  assert.deepEqual(after.prepare(`
    SELECT assistant_request_id, content, status, delivery_action
    FROM conversations WHERE direction = 'out' ORDER BY id ASC
  `).all(), legacyOutboundBefore);
  const tables = new Set(after.prepare(`
    SELECT name FROM sqlite_master WHERE type = 'table'
  `).all().map(row => row.name));
  for (const table of [
    'assistant_reply_outcomes',
    'assistant_reply_intents',
    'assistant_delivery_receipts',
    'assistant_delivery_settlements',
    'assistant_event_consumers',
    'assistant_event_deliveries',
  ]) assert.ok(tables.has(table), table);
  assert.deepEqual(after.pragma('foreign_key_check'), []);
  after.close();
  assert.equal(outbox.get(committed.intent.intentId).delivery.state, 'pending');
  assert.equal(ledger.get(run.requestId).status, 'completed');
});
