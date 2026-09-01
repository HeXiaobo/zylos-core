import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  createReplyComposition,
  replyRefactorEnabled,
  requireIdleForRequest,
} from '../reply-composition.js';

function acceptMessage({ eventId, messageId, lane = 'lane:one' }) {
  return {
    schemaVersion: 1,
    type: 'AcceptMessage',
    commandId: `cmd:${eventId}`,
    idempotencyKey: `accept:${eventId}`,
    traceId: `trace:${eventId}`,
    causationId: `cause:${eventId}`,
    issuedAt: '2026-09-01T00:00:00.000Z',
    requestClass: 'ordinary',
    conversationLaneKey: lane,
    source: {
      adapterId: 'fake', accountRef: 'acct', targetRef: 'target', conversationKey: lane,
      messageId, eventId, eventType: 'message',
      payloadHash: `sha256:${'a'.repeat(64)}`,
    },
    actor: { provider: 'fake', tenantRef: 'tenant', externalId: 'user' },
    content: { kind: 'text', text: `message ${eventId}` },
    contextHints: { threadRef: null, rootRef: null, parentRef: null, quoteRefs: [], mentionRefs: [], attachmentRefs: [] },
    reply: { mode: 'required', targetRef: 'target' },
    policy: { priority: 3, requireIdle: true },
  };
}

test('feature flag preserves legacy intake and canonical cutover accepts concurrent lanes', (t) => {
  assert.equal(replyRefactorEnabled({ C4_REPLY_REFACTOR_V1: 'true' }), true);
  assert.equal(replyRefactorEnabled({}), false);
  const legacy = createReplyComposition({ enabled: false, legacy: { accept: value => ({ legacy: value }) } });
  assert.deepEqual(legacy.accept({ id: 'old' }), { legacy: { id: 'old' } });

  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-reply-composition-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const composition = createReplyComposition({ dbPath: path.join(directory, 'c4.db'), enabled: true, clock: () => 100 });
  t.after(() => composition.close());

  const first = composition.accept(acceptMessage({ eventId: 'one', messageId: 'one', lane: 'lane:a' }));
  const second = composition.accept(acceptMessage({ eventId: 'two', messageId: 'two', lane: 'lane:b' }));
  assert.equal(first.request.requireIdle, false);
  assert.equal(second.request.requireIdle, false);
  assert.notEqual(first.request.requestId, second.request.requestId);
  assert.equal(first.request.status, 'queued');
  assert.equal(second.request.status, 'queued');
});

test('only explicit maintenance and control requests retain idle gating', () => {
  assert.equal(requireIdleForRequest({ requestClass: 'ordinary', requireIdle: true }), false);
  assert.equal(requireIdleForRequest({ requestClass: 'maintenance' }), true);
  assert.equal(requireIdleForRequest({ requestClass: 'maintenance', requireIdle: false }), false);
  assert.equal(requireIdleForRequest({ requestClass: 'control' }), true);
});
