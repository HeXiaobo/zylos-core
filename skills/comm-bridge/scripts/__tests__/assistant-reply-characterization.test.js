import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import Database from 'better-sqlite3';

import {
  ASSISTANT_RESPONSE_EVENT_TYPES,
  openAssistantResponseStream,
} from '../assistant-response-stream.js';
import { openIdempotentInboundQueue } from '../c4-idempotent-inbound.js';
import { loadContractFixture } from './helpers/assistant-reply-contract.js';

const upstream = loadContractFixture('upstream-control.json');
const current = loadContractFixture('current-behavior.json');

function accept(stream, requestId, sourceId) {
  return stream.execute({
    type: 'AcceptAssistantRequest',
    requestId,
    sourceId,
    route: { channel: 'feishu', endpointId: `opaque:${sourceId}` },
    conversation: {
      content: `Characterization input for ${sourceId}`,
      status: 'pending',
      priority: 2,
      requireIdle: false,
    },
  });
}

test('official Core control evidence uses immutable object identities and replay commands', () => {
  assert.match(upstream.officialControl.sha, /^[a-f0-9]{40}$/);
  assert.equal(upstream.officialControl.sha, upstream.relationship.mergeBase);
  assert.equal(upstream.relationship.forkCommitsAhead, 35);
  assert.match(upstream.forkBaseline.sha, /^[a-f0-9]{40}$/);
  assert.notEqual(upstream.officialControl.sha, upstream.forkBaseline.sha);
  for (const artifact of upstream.officialControl.artifacts) {
    assert.match(artifact.blob, /^[a-f0-9]{40}$/);
  }
  for (const fact of upstream.facts) {
    assert.ok(['retain', 'fork_only'].includes(fact.classification));
    assert.ok(fact.evidence.length > 0);
    assert.ok(fact.replay.some(command => command.includes(upstream.officialControl.sha)));
    assert.ok(fact.replay.every(command => /[a-f0-9]{40}/.test(command)));
  }
});

test('current fork exposes the recorded Assistant Request event vocabulary', () => {
  assert.deepEqual(ASSISTANT_RESPONSE_EVENT_TYPES, current.current.eventTypes);
  assert.equal(current.current.eventTypes.includes('RunCancelled'), false);
  assert.equal(current.targetVocabulary.includes('RunCancelled'), true);
});

test('current fork persists request/event/admission/candidate tables and one global event ACK axis', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'reply-characterization-'));
  const dbPath = path.join(directory, 'c4.db');
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  const stream = openAssistantResponseStream({ dbPath, clock: () => 100 });
  const accepted = accept(stream, 'assistant.feishu.characterization', 'msg-characterization');
  const replay = accept(stream, 'assistant.feishu.characterization', 'msg-characterization');
  assert.equal(accepted.replayed, false);
  assert.equal(replay.replayed, true);
  stream.execute({ type: 'StartRun', requestId: accepted.request.requestId });
  const completed = stream.execute({
    type: 'CompleteRun',
    requestId: accepted.request.requestId,
    output: 'Current visible answer.',
  });
  stream.close();

  assert.deepEqual(completed.events.map(event => event.type), ['RunCompleted']);
  const database = new Database(dbPath, { readonly: true });
  t.after(() => database.close());
  const tables = database.prepare(`
    SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name
  `).all().map(row => row.name);
  for (const table of current.current.tables) assert.ok(tables.includes(table), table);

  const eventColumns = database.prepare('PRAGMA table_info(assistant_response_events)')
    .all().map(column => column.name);
  assert.ok(eventColumns.includes('delivery_status'));
  assert.equal(eventColumns.includes('consumer_id'), false);
  const outbound = database.prepare(`
    SELECT status, delivery_action
    FROM conversations
    WHERE direction = 'out' AND assistant_request_id = ?
  `).get(accepted.request.requestId);
  assert.deepEqual(outbound, {
    status: 'delivered',
    delivery_action: 'assistant-response',
  });
});

test('current idempotent inbound receipt safely replays equal payload and rejects conflicts', () => {
  const queue = openIdempotentInboundQueue({ dbPath: ':memory:' });
  try {
    const command = {
      idempotencyKey: 'characterization:event-1',
      channel: 'feishu',
      endpointId: 'opaque:target-1',
      content: 'same payload',
      priority: 2,
      requireIdle: false,
    };
    const first = queue.enqueue(command);
    const replay = queue.enqueue(command);
    assert.equal(first.created, true);
    assert.equal(replay.created, false);
    assert.equal(replay.conversation.id, first.conversation.id);
    assert.throws(
      () => queue.enqueue({ ...command, content: 'different payload' }),
      error => error?.code === 'IDEMPOTENCY_CONFLICT',
    );
  } finally {
    queue.close();
  }
});

test('current [SKIP] compatibility suppresses an outbound row', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'reply-silent-characterization-'));
  const dbPath = path.join(directory, 'c4.db');
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const stream = openAssistantResponseStream({ dbPath, clock: () => 200 });
  const accepted = accept(stream, 'assistant.feishu.silent', 'msg-silent');
  stream.execute({ type: 'StartRun', requestId: accepted.request.requestId });
  stream.execute({
    type: 'CompleteRun',
    requestId: accepted.request.requestId,
    output: '[SKIP]',
  });
  stream.close();

  const database = new Database(dbPath, { readonly: true });
  const outboundCount = database.prepare(`
    SELECT COUNT(*) AS count
    FROM conversations
    WHERE direction = 'out' AND assistant_request_id = ?
  `).get(accepted.request.requestId).count;
  database.close();
  assert.equal(outboundCount, 0);
});

for (const gap of current.gaps) {
  test.todo(`${gap.id}: ${gap.targetBehavior}`);
}
