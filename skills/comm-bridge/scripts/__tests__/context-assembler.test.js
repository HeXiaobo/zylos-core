import assert from 'node:assert/strict';
import test from 'node:test';

import Database from 'better-sqlite3';

import {
  assertContextSnapshotV1,
  canonicalContextSnapshotBytes,
  contextSnapshotContentHash,
  contextSnapshotIdempotencyKey,
  createContextAssembler,
  estimateContextTokens,
} from '../context-assembler.js';
import { renderContextSnapshot } from '../context-snapshot-renderer.js';
import {
  createInMemoryContextSnapshotStore,
  createSqliteContextSnapshotStore,
} from '../context-snapshot-store.js';

const identity = Object.freeze({
  snapshotId: 'ctx:req-101:1',
  requestId: 'req-101',
  turnId: 'turn:req-101:1',
  traceId: 'trace:req-101',
  conversationLaneKey: 'channel:account:conversation:lane-a',
  asOfLaneSequence: 17,
  authorizationScope: Object.freeze({
    tenantRef: 'opaque:tenant-a',
    routeRef: 'opaque:route-a',
    conversationLaneKey: 'channel:account:conversation:lane-a',
  }),
  contextHints: Object.freeze({
    threadRef: 'opaque:topic-a',
    rootRef: 'opaque:root-a',
    parentRef: 'opaque:parent-a',
    quoteRefs: Object.freeze(['opaque:quote-a']),
    mentionRefs: Object.freeze([]),
    attachmentRefs: Object.freeze(['opaque:attachment-a']),
  }),
});

function channelItem(kind, ref, content, extra = {}) {
  return {
    kind,
    ref,
    content,
    provenance: {
      source: 'channel_context',
      opaqueRef: ref,
      authority: 'authorized_channel_context',
    },
    authorized: true,
    ...extra,
  };
}

function memoryItem(ref, content, extra = {}) {
  return {
    kind: 'memory',
    ref,
    content,
    provenance: {
      source: 'unified_memory',
      opaqueRef: ref,
      authority: 'authorized_memory',
    },
    authorized: true,
    ...extra,
  };
}

function createPorts({
  channelItems = [],
  memoryItems = [],
  memoryResultScope,
  onChannel,
  onMemory,
} = {}) {
  return {
    channelContextPort: {
      async resolve(query, options) {
        onChannel?.(query, options);
        return channelItems;
      },
    },
    memoryPort: {
      async recall(query, options) {
        onMemory?.(query, options);
        return {
          authorizationScope: memoryResultScope || query.authorizationScope,
          items: memoryItems,
        };
      },
    },
  };
}

function createAssembler({
  channelItems,
  memoryItems,
  memoryResultScope,
  store,
  budgetPolicy,
  readTimeoutMs,
  channelContextPort,
  memoryPort,
  onChannel,
  onMemory,
} = {}) {
  const ports = createPorts({
    channelItems,
    memoryItems,
    memoryResultScope,
    onChannel,
    onMemory,
  });
  return createContextAssembler({
    channelContextPort: channelContextPort || ports.channelContextPort,
    memoryPort: memoryPort || ports.memoryPort,
    snapshotStore: store || createInMemoryContextSnapshotStore(),
    readTimeoutMs,
    budgetPolicy: budgetPolicy || {
      maxTokens: 10_000,
      maxItemTokens: 2_000,
      maxAttachmentSummaryTokens: 200,
    },
  });
}

test('assembles the v1 snapshot from generic hints and authorized ports only', async () => {
  let channelQuery;
  let memoryQuery;
  let channelReadOptions;
  let memoryReadOptions;
  const assembler = createAssembler({
    channelItems: [
      channelItem('source_message', 'opaque:message-current', 'Current request'),
      channelItem('quoted_message', 'opaque:quote-a', 'Quoted context'),
      { ...channelItem('channel_history', 'opaque:denied', 'private body'), authorized: false },
    ],
    memoryItems: [memoryItem('memory:user:preference', 'Use concise answers')],
    onChannel(query, options) { channelQuery = query; channelReadOptions = options; },
    onMemory(query, options) { memoryQuery = query; memoryReadOptions = options; },
  });

  const snapshot = await assembler.assemble(identity);

  assert.deepEqual(Object.keys(channelQuery).sort(), [
    'asOfLaneSequence',
    'contextHints',
    'conversationLaneKey',
    'requestId',
    'traceId',
    'turnId',
  ]);
  assert.deepEqual(memoryQuery, {
    authorizationScope: identity.authorizationScope,
    requestId: identity.requestId,
    turnId: identity.turnId,
    traceId: identity.traceId,
  });
  assert.equal(channelReadOptions.signal instanceof AbortSignal, true);
  assert.equal(memoryReadOptions.signal, channelReadOptions.signal);
  assert.equal(JSON.stringify(channelQuery).includes('thread_id'), false);
  assert.equal(snapshot.schemaVersion, 1);
  assert.equal(snapshot.type, 'ContextSnapshot');
  assert.equal(snapshot.snapshotId, identity.snapshotId);
  assert.equal(snapshot.requestId, identity.requestId);
  assert.equal(snapshot.turnId, identity.turnId);
  assert.equal(snapshot.traceId, identity.traceId);
  assert.equal(snapshot.conversationLaneKey, identity.conversationLaneKey);
  assert.equal(snapshot.asOfLaneSequence, identity.asOfLaneSequence);
  assert.equal(snapshot.retryPolicy, 'reuse_same_snapshot');
  assert.equal(snapshot.items.some(item => item.ref === 'opaque:denied'), false);
  assert.deepEqual(snapshot.items.map(item => item.ref), [
    'opaque:message-current',
    'opaque:quote-a',
    'memory:user:preference',
  ]);
  assert.deepEqual(snapshot.items[2].provenance, {
    authority: 'authorized_memory',
    authorizationScope: identity.authorizationScope,
    opaqueRef: 'memory:user:preference',
    source: 'unified_memory',
  });
  assert.match(snapshot.contentHash, /^sha256:[a-f0-9]{64}$/);
  assert.equal(snapshot.contentHash, contextSnapshotContentHash(snapshot));
  assert.equal(Object.isFrozen(snapshot), true);
  assert.equal(Object.isFrozen(snapshot.items), true);
  assert.equal(Object.isFrozen(snapshot.items[0].provenance), true);
});

test('canonical bytes and hash are stable across arrival order, object key order, and Unicode forms', async () => {
  const decomposed = 'Cafe\u0301';
  const composed = 'Caf\u00e9';
  const first = createAssembler({
    channelItems: [
      channelItem('channel_history', 'opaque:history-old', 'old', { laneSequence: 2 }),
      channelItem('source_message', 'opaque:message-current', decomposed),
      channelItem('channel_history', 'opaque:history-new', 'new', { laneSequence: 9 }),
    ],
    memoryItems: [memoryItem('memory:b', 'B'), memoryItem('memory:a', 'A')],
  });
  const second = createAssembler({
    channelItems: [
      { ...channelItem('source_message', 'opaque:message-current', composed), provenance: {
        authority: 'authorized_channel_context',
        opaqueRef: 'opaque:message-current',
        source: 'channel_context',
      } },
      channelItem('channel_history', 'opaque:history-new', 'new', { laneSequence: 9 }),
      channelItem('channel_history', 'opaque:history-old', 'old', { laneSequence: 2 }),
    ],
    memoryItems: [memoryItem('memory:a', 'A'), memoryItem('memory:b', 'B')],
  });

  const [snapshotA, snapshotB] = await Promise.all([
    first.assemble(identity),
    second.assemble(identity),
  ]);

  assert.equal(snapshotA.items[0].content, composed);
  assert.deepEqual(snapshotA, snapshotB);
  assert.deepEqual(canonicalContextSnapshotBytes(snapshotA), canonicalContextSnapshotBytes(snapshotB));
  assert.equal(snapshotA.contentHash, snapshotB.contentHash);
  assert.deepEqual(snapshotA.items.map(item => item.ref), [
    'opaque:message-current',
    'opaque:history-new',
    'opaque:history-old',
    'memory:a',
    'memory:b',
  ]);
});

test('budgeting preserves semantic priority and newest history with stable tie-breaks', async () => {
  const current = channelItem('source_message', 'opaque:current', 'A');
  const control = channelItem('control_intent', 'opaque:control', 'B');
  const task = channelItem('task_intent', 'opaque:task', 'T');
  const quote = channelItem('quoted_message', 'opaque:quote', 'C');
  const newHistory = channelItem('channel_history', 'opaque:new-history', 'D', { laneSequence: 8 });
  const oldHistory = channelItem('channel_history', 'opaque:old-history', 'E', { laneSequence: 1 });
  const memory = memoryItem('memory:fact', 'F');
  const oneTokenEach = [current, control, task, quote, newHistory, oldHistory, memory]
    .map(item => estimateContextTokens(item.content));
  assert.deepEqual(oneTokenEach, [1, 1, 1, 1, 1, 1, 1]);

  const assembler = createAssembler({
    channelItems: [oldHistory, quote, current, newHistory, task, control],
    memoryItems: [memory],
    budgetPolicy: { maxTokens: 5, maxItemTokens: 4, maxAttachmentSummaryTokens: 2 },
  });
  const snapshot = await assembler.assemble(identity);

  assert.deepEqual(snapshot.items.map(item => item.ref), [
    'opaque:current',
    'opaque:control',
    'opaque:task',
    'opaque:quote',
    'opaque:new-history',
  ]);
  assert.deepEqual(snapshot.truncation, {
    strategy: 'deterministic_budget_v1',
    inputTokens: 7,
    keptTokens: 5,
    droppedItemRefs: [
      'channel_history\u0000opaque:old-history',
      'memory\u0000memory:fact',
    ],
  });
});

test('budget truncation identifies cross-kind items with the same opaque ref independently', async () => {
  const snapshot = await createAssembler({
    channelItems: [
      channelItem('source_message', 'opaque:same', 'A'),
      channelItem('control_intent', 'opaque:same', 'B'),
      channelItem('task_intent', 'opaque:same', 'C'),
    ],
    budgetPolicy: {
      maxTokens: 1,
      maxItemTokens: 100,
      maxAttachmentSummaryTokens: 50,
    },
  }).assemble(identity);

  assert.deepEqual(snapshot.items.map(item => [item.kind, item.ref]), [
    ['source_message', 'opaque:same'],
  ]);
  assert.deepEqual(snapshot.truncation.droppedItemRefs, [
    'control_intent\u0000opaque:same',
    'task_intent\u0000opaque:same',
  ]);
  assert.equal(assertContextSnapshotV1(snapshot), snapshot);
});

test('handles empty history, a missing quote, and a mixed memory/channel snapshot', async () => {
  const assembler = createAssembler({
    channelItems: [channelItem('source_message', 'opaque:current', 'Only current message')],
    memoryItems: [memoryItem('memory:cross-channel', 'Shared fact')],
  });
  const snapshot = await assembler.assemble({
    ...identity,
    contextHints: { ...identity.contextHints, quoteRefs: ['opaque:not-resolved'] },
  });

  assert.deepEqual(snapshot.items.map(item => item.kind), ['source_message', 'memory']);
  assert.equal(snapshot.items.some(item => item.ref === 'opaque:not-resolved'), false);
  assert.deepEqual(snapshot.truncation.droppedItemRefs, []);
});

test('fails closed when authorized channel context omits the current source message', async () => {
  await assert.rejects(
    createAssembler({
      channelItems: [channelItem(
        'channel_history',
        'opaque:history',
        'history only',
        { laneSequence: 1 },
      )],
    }).assemble(identity),
    error => error?.code === 'INVALID_CURRENT_CONTEXT',
  );
});

test('truncates an oversized attachment summary by Unicode code point without splitting text', async () => {
  const summary = '\ud83e\uddea'.repeat(100) + 'ending';
  const assembler = createAssembler({
    channelItems: [
      channelItem('source_message', 'opaque:current', 'go'),
      channelItem('attachment_summary', 'opaque:attachment-a', summary),
    ],
    budgetPolicy: {
      maxTokens: 500,
      maxItemTokens: 500,
      maxAttachmentSummaryTokens: 8,
    },
  });
  const snapshot = await assembler.assemble(identity);
  const attachment = snapshot.items.find(item => item.kind === 'attachment_summary');

  assert.ok(attachment);
  assert.ok(estimateContextTokens(attachment.content) <= 8);
  assert.equal(attachment.content.includes('\ufffd'), false);
  assert.ok(snapshot.truncation.inputTokens > snapshot.truncation.keptTokens);
});

test('deduplicates equal items and fails closed on the same item identity with different content', async () => {
  const duplicate = channelItem('source_message', 'opaque:current', 'same');
  const snapshot = await createAssembler({ channelItems: [duplicate, { ...duplicate }] })
    .assemble(identity);
  assert.equal(snapshot.items.length, 1);

  await assert.rejects(
    createAssembler({
      channelItems: [duplicate, { ...duplicate, content: 'different secret body' }],
    }).assemble(identity),
    error => {
      assert.equal(error?.code, 'CONTEXT_ITEM_CONFLICT');
      assert.equal(error.message.includes('different secret body'), false);
      assert.equal(error.message.includes('same'), false);
      return true;
    },
  );
});

test('SQLite adapter persists immutable snapshots, replays after restart, and rejects identity conflicts', async (t) => {
  const database = new Database(':memory:');
  t.after(() => database.close());
  const firstStore = createSqliteContextSnapshotStore({ database });
  const first = await createAssembler({
    channelItems: [channelItem('source_message', 'opaque:current', 'persisted body')],
    store: firstStore,
  }).assemble(identity);

  let contextReads = 0;
  const reopenedStore = createSqliteContextSnapshotStore({ database });
  const replayed = await createAssembler({
    channelItems: [channelItem('source_message', 'opaque:current', 'mutable newer body')],
    store: reopenedStore,
    onChannel() { contextReads += 1; },
  }).assemble(identity);
  assert.deepEqual(replayed, first);
  assert.equal(contextReads, 0);

  const conflictingSnapshot = {
    ...first,
    items: [{ ...first.items[0], content: 'tampered' }],
  };
  const conflictingTokens = estimateContextTokens(conflictingSnapshot.items[0].content);
  conflictingSnapshot.truncation = {
    ...first.truncation,
    inputTokens: conflictingTokens,
    keptTokens: conflictingTokens,
  };
  conflictingSnapshot.contentHash = contextSnapshotContentHash(conflictingSnapshot);
  assert.throws(
    () => reopenedStore.save({
      idempotencyKey: contextSnapshotIdempotencyKey(first),
      snapshot: conflictingSnapshot,
    }),
    error => {
      assert.equal(error?.code, 'CONTEXT_SNAPSHOT_CONFLICT');
      assert.equal(error.message.includes('tampered'), false);
      assert.equal(error.message.includes('persisted body'), false);
      return true;
    },
  );
});

test('concurrent create/replay converges on one frozen snapshot', async () => {
  const store = createInMemoryContextSnapshotStore();
  const assembler = createAssembler({
    channelItems: [channelItem('source_message', 'opaque:current', 'one body')],
    memoryItems: [memoryItem('memory:one', 'one memory')],
    store,
  });

  const results = await Promise.all(Array.from({ length: 20 }, () => assembler.assemble(identity)));
  assert.ok(results.every(snapshot => snapshot === results[0]));
  assert.equal(store.count(), 1);
  assert.throws(
    () => store.save({ idempotencyKey: 'context:v1:wrong-key', snapshot: results[0] }),
    error => error?.code === 'CONTEXT_SNAPSHOT_CONFLICT',
  );
});

test('SQLite lookup requires snapshotId and idempotencyKey to resolve to the same row', async (t) => {
  const database = new Database(':memory:');
  t.after(() => database.close());
  const store = createSqliteContextSnapshotStore({ database });
  const first = await createAssembler({
    channelItems: [channelItem('source_message', 'opaque:current-a', 'request A')],
    store,
  }).assemble(identity);
  const secondIdentity = {
    ...identity,
    snapshotId: 'ctx:req-202:1',
    requestId: 'req-202',
    turnId: 'turn:req-202:1',
    traceId: 'trace:req-202',
    conversationLaneKey: 'channel:account:conversation:lane-b',
    authorizationScope: {
      ...identity.authorizationScope,
      routeRef: 'opaque:route-b',
      conversationLaneKey: 'channel:account:conversation:lane-b',
    },
  };
  const second = await createAssembler({
    channelItems: [channelItem('source_message', 'opaque:current-b', 'request B')],
    store,
  }).assemble(secondIdentity);

  assert.throws(
    () => store.load({
      snapshotId: first.snapshotId,
      idempotencyKey: contextSnapshotIdempotencyKey(second),
    }),
    error => error?.code === 'CONTEXT_SNAPSHOT_CONFLICT',
  );
  assert.throws(
    () => store.load({
      snapshotId: 'ctx:missing',
      idempotencyKey: contextSnapshotIdempotencyKey(first),
    }),
    error => error?.code === 'CONTEXT_SNAPSHOT_CONFLICT',
  );
});

test('SQLite rows reject UPDATE and DELETE and validate every duplicated metadata column on read', async (t) => {
  const database = new Database(':memory:');
  t.after(() => database.close());
  const store = createSqliteContextSnapshotStore({ database });
  const snapshot = await createAssembler({
    channelItems: [channelItem('source_message', 'opaque:current', 'immutable')],
    store,
  }).assemble(identity);

  assert.throws(
    () => database.prepare('UPDATE context_snapshots SET request_id = ? WHERE snapshot_id = ?')
      .run('req-corrupt', snapshot.snapshotId),
    /immutable/i,
  );
  assert.throws(
    () => database.prepare('DELETE FROM context_snapshots WHERE snapshot_id = ?')
      .run(snapshot.snapshotId),
    /immutable/i,
  );
  assert.throws(
    () => database.prepare(`
      INSERT OR REPLACE INTO context_snapshots
      SELECT * FROM context_snapshots WHERE snapshot_id = ?
    `).run(snapshot.snapshotId),
    /immutable/i,
  );
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM context_snapshots').get().count, 1);

  database.exec('DROP TRIGGER context_snapshots_immutable_update');
  database.prepare('UPDATE context_snapshots SET request_id = ? WHERE snapshot_id = ?')
    .run('req-corrupt', snapshot.snapshotId);
  createSqliteContextSnapshotStore({ database });
  assert.throws(
    () => store.load({
      snapshotId: snapshot.snapshotId,
      idempotencyKey: contextSnapshotIdempotencyKey(snapshot),
    }),
    error => error?.code === 'CONTEXT_SNAPSHOT_CORRUPT',
  );
});

test('ContextSnapshot v1 validation rejects unknown fields, malformed envelopes, and invalid enums', async () => {
  const snapshot = await createAssembler({
    channelItems: [channelItem('source_message', 'opaque:current', 'strict shape')],
  }).assemble(identity);
  const mutations = [
    candidate => { candidate.unknown = true; },
    candidate => { candidate.schemaVersion = 2; },
    candidate => { candidate.type = 'MutableContext'; },
    candidate => { candidate.retryPolicy = 'rebuild_on_retry'; },
    candidate => { candidate.items[0].kind = 'platform_message'; },
    candidate => { candidate.items[0].unknown = 'no'; },
    candidate => { candidate.items[0].provenance.unknown = 'no'; },
    candidate => { candidate.truncation.strategy = 'arrival_order'; },
    candidate => { candidate.truncation.unknown = true; },
    candidate => { candidate.truncation.keptTokens = candidate.truncation.inputTokens + 1; },
  ];

  assert.equal(assertContextSnapshotV1(snapshot), snapshot);
  for (const mutate of mutations) {
    const candidate = structuredClone(snapshot);
    mutate(candidate);
    candidate.contentHash = contextSnapshotContentHash(candidate);
    assert.throws(
      () => assertContextSnapshotV1(candidate),
      error => error?.code === 'INVALID_CONTEXT_SNAPSHOT',
    );
  }
});

test('idempotency encoding is unambiguous and stores reject non-canonical keys', async () => {
  const left = contextSnapshotIdempotencyKey({ requestId: 'a:b', turnId: 'c' });
  const right = contextSnapshotIdempotencyKey({ requestId: 'a', turnId: 'b:c' });
  assert.notEqual(left, right);
  assert.match(left, /^context:v1:[A-Za-z0-9_-]+$/);

  const store = createInMemoryContextSnapshotStore();
  const snapshot = await createAssembler({
    channelItems: [channelItem('source_message', 'opaque:current', 'canonical key')],
    store,
  }).assemble(identity);
  assert.throws(
    () => store.save({ idempotencyKey: 'context:req-101:turn:req-101:1', snapshot }),
    error => error?.code === 'CONTEXT_SNAPSHOT_CONFLICT',
  );
});

test('lane watermark rejects future context and channel history without a durable sequence', async () => {
  await assert.rejects(
    createAssembler({
      channelItems: [
        channelItem('source_message', 'opaque:current', 'current'),
        channelItem('channel_history', 'opaque:future', 'future body', { laneSequence: 999 }),
      ],
    }).assemble(identity),
    error => error?.code === 'CONTEXT_WATERMARK_VIOLATION',
  );
  await assert.rejects(
    createAssembler({
      channelItems: [
        channelItem('source_message', 'opaque:current', 'current'),
        channelItem('channel_history', 'opaque:no-sequence', 'unordered history'),
      ],
    }).assemble(identity),
    error => error?.code === 'INVALID_CONTEXT_ITEM',
  );
});

test('MemoryPort result scope must match tenant, route, and lane authorization', async () => {
  await assert.rejects(
    createAssembler({
      channelItems: [channelItem('source_message', 'opaque:current', 'current')],
      memoryItems: [memoryItem('memory:wrong-scope', 'must not enter')],
      memoryResultScope: {
        ...identity.authorizationScope,
        routeRef: 'opaque:another-route',
      },
    }).assemble(identity),
    error => error?.code === 'MEMORY_SCOPE_MISMATCH',
  );
  await assert.rejects(
    createAssembler({
      channelItems: [channelItem('source_message', 'opaque:current', 'current')],
    }).assemble({ ...identity, authorizationScope: undefined }),
    error => error?.code === 'INVALID_AUTHORIZATION_SCOPE',
  );

  const snapshot = await createAssembler({
    channelItems: [channelItem('source_message', 'opaque:current', 'current')],
    memoryItems: [memoryItem('memory:a', 'A'), memoryItem('memory:b', 'B')],
  }).assemble(identity);
  const mixedScope = structuredClone(snapshot);
  mixedScope.items.find(item => item.ref === 'memory:b').provenance.authorizationScope.routeRef =
    'opaque:another-route';
  mixedScope.contentHash = contextSnapshotContentHash(mixedScope);
  assert.throws(
    () => assertContextSnapshotV1(mixedScope),
    error => error?.code === 'INVALID_CONTEXT_SNAPSHOT',
  );
});

test('snapshot replay binds trace, lane watermark, and the complete authorization scope', async () => {
  const store = createInMemoryContextSnapshotStore();
  await createAssembler({
    channelItems: [channelItem('source_message', 'opaque:current', 'original request')],
    memoryItems: [memoryItem('memory:bound', 'bound memory')],
    store,
  }).assemble(identity);

  let portReads = 0;
  const replayAssembler = createAssembler({
    store,
    onChannel() { portReads += 1; },
    onMemory() { portReads += 1; },
  });
  const conflicts = [
    { ...identity, traceId: 'trace:changed' },
    { ...identity, asOfLaneSequence: identity.asOfLaneSequence + 1 },
    {
      ...identity,
      conversationLaneKey: 'channel:account:conversation:lane-b',
      authorizationScope: {
        ...identity.authorizationScope,
        conversationLaneKey: 'channel:account:conversation:lane-b',
      },
    },
    {
      ...identity,
      authorizationScope: { ...identity.authorizationScope, tenantRef: 'opaque:tenant-b' },
    },
    {
      ...identity,
      authorizationScope: { ...identity.authorizationScope, routeRef: 'opaque:route-b' },
    },
  ];

  for (const conflictIdentity of conflicts) {
    await assert.rejects(
      replayAssembler.assemble(conflictIdentity),
      error => error?.code === 'IDEMPOTENCY_CONFLICT',
    );
  }
  assert.equal(portReads, 0);
});

test('snapshot top-level authorization scope binds every memory item and request replay', async () => {
  const snapshot = await createAssembler({
    channelItems: [channelItem('source_message', 'opaque:current', 'current')],
    memoryItems: [memoryItem('memory:a', 'A'), memoryItem('memory:b', 'B')],
  }).assemble(identity);
  assert.deepEqual(snapshot.authorizationScope, identity.authorizationScope);
  assert.equal(Object.isFrozen(snapshot.authorizationScope), true);

  const itemScopeForgery = structuredClone(snapshot);
  for (const item of itemScopeForgery.items.filter(item => item.kind === 'memory')) {
    item.provenance.authorizationScope = {
      ...item.provenance.authorizationScope,
      tenantRef: 'opaque:attacker-tenant',
      routeRef: 'opaque:attacker-route',
    };
  }
  itemScopeForgery.contentHash = contextSnapshotContentHash(itemScopeForgery);
  assert.throws(
    () => assertContextSnapshotV1(itemScopeForgery),
    error => error?.code === 'INVALID_CONTEXT_SNAPSHOT',
  );

  const selfConsistentForgery = structuredClone(itemScopeForgery);
  selfConsistentForgery.authorizationScope = {
    ...selfConsistentForgery.authorizationScope,
    tenantRef: 'opaque:attacker-tenant',
    routeRef: 'opaque:attacker-route',
  };
  selfConsistentForgery.contentHash = contextSnapshotContentHash(selfConsistentForgery);
  assert.equal(assertContextSnapshotV1(selfConsistentForgery), selfConsistentForgery);
  await assert.rejects(
    createAssembler({
      store: {
        load() { return selfConsistentForgery; },
        save() { throw new Error('save must not run'); },
      },
    }).assemble(identity),
    error => error?.code === 'IDEMPOTENCY_CONFLICT',
  );
});

test('assembler validates and deep-freezes untrusted snapshot store load and save results', async () => {
  const trusted = await createAssembler({
    channelItems: [channelItem('source_message', 'opaque:current', 'trusted')],
  }).assemble(identity);
  const mutableLoadResult = structuredClone(trusted);
  const replayed = await createAssembler({
    store: {
      load() { return mutableLoadResult; },
      save() { throw new Error('save must not run'); },
    },
  }).assemble(identity);
  assert.notEqual(replayed, mutableLoadResult);
  assert.equal(Object.isFrozen(replayed), true);
  assert.equal(Object.isFrozen(replayed.items[0]), true);
  assert.equal(Object.isFrozen(replayed.authorizationScope), true);

  const invalidLoadResult = structuredClone(trusted);
  invalidLoadResult.contentHash = `sha256:${'0'.repeat(64)}`;
  await assert.rejects(
    createAssembler({
      store: {
        load() { return invalidLoadResult; },
        save() { throw new Error('save must not run'); },
      },
    }).assemble(identity),
    error => error?.code === 'CONTEXT_SNAPSHOT_HASH_MISMATCH',
  );

  let mutableSaveResult;
  const saved = await createAssembler({
    channelItems: [channelItem('source_message', 'opaque:current', 'newly saved')],
    store: {
      load() { return null; },
      save({ snapshot }) {
        mutableSaveResult = structuredClone(snapshot);
        return mutableSaveResult;
      },
    },
  }).assemble(identity);
  assert.notEqual(saved, mutableSaveResult);
  assert.equal(Object.isFrozen(saved), true);
  assert.equal(Object.isFrozen(saved.items[0].provenance), true);

  await assert.rejects(
    createAssembler({
      channelItems: [channelItem('source_message', 'opaque:current', 'must conflict')],
      store: {
        load() { return null; },
        save({ snapshot }) {
          const wrongIdentity = structuredClone(snapshot);
          wrongIdentity.traceId = 'trace:store-substitution';
          wrongIdentity.contentHash = contextSnapshotContentHash(wrongIdentity);
          return wrongIdentity;
        },
      },
    }).assemble(identity),
    error => error?.code === 'IDEMPOTENCY_CONFLICT',
  );

  await assert.rejects(
    createAssembler({
      channelItems: [channelItem('source_message', 'opaque:current', 'expected payload')],
      store: {
        load() { return null; },
        save({ snapshot }) {
          const substituted = structuredClone(snapshot);
          substituted.items[0].content = 'different payload';
          const substitutedTokens = estimateContextTokens(substituted.items[0].content);
          substituted.truncation = {
            ...substituted.truncation,
            inputTokens: substitutedTokens,
            keptTokens: substitutedTokens,
          };
          substituted.contentHash = contextSnapshotContentHash(substituted);
          return substituted;
        },
      },
    }).assemble(identity),
    error => error?.code === 'CONTEXT_SNAPSHOT_CONFLICT',
  );
});

test('context port reads expose one AbortSignal and fail closed on timeout or caller abort', async () => {
  let rejectedSiblingAborted = false;
  await assert.rejects(
    createAssembler({
      channelContextPort: {
        resolve() {
          const error = new Error('channel read failed');
          error.code = 'CHANNEL_READ_FAILED';
          throw error;
        },
      },
      memoryPort: {
        recall(query, { signal }) {
          return new Promise((resolve, reject) => {
            signal.addEventListener('abort', () => {
              rejectedSiblingAborted = true;
              reject(signal.reason);
            }, { once: true });
          });
        },
      },
    }).assemble(identity),
    error => error?.code === 'CHANNEL_READ_FAILED',
  );
  assert.equal(rejectedSiblingAborted, true);

  const timeoutAborts = [];
  const waitForAbort = ({ signal }) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => {
      timeoutAborts.push(signal.reason?.code);
      reject(signal.reason);
    }, { once: true });
  });
  const timeoutAssembler = createAssembler({
    readTimeoutMs: 10,
    channelContextPort: { resolve: (query, options) => waitForAbort(options) },
    memoryPort: {
      recall: (query, options) => waitForAbort(options),
    },
  });
  await assert.rejects(
    timeoutAssembler.assemble(identity),
    error => error?.code === 'CONTEXT_PORT_TIMEOUT',
  );
  assert.deepEqual(timeoutAborts, ['CONTEXT_PORT_TIMEOUT', 'CONTEXT_PORT_TIMEOUT']);

  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    createAssembler({
      channelItems: [channelItem('source_message', 'opaque:current', 'current')],
    }).assemble(identity, { signal: controller.signal }),
    error => error?.code === 'CONTEXT_ASSEMBLY_ABORTED',
  );
});

test('renderer is deterministic, verifies the hash, and does not imply session ownership', async () => {
  const snapshot = await createAssembler({
    channelItems: [channelItem('source_message', 'opaque:current', 'Hello\nworld')],
  }).assemble(identity);
  const first = renderContextSnapshot(snapshot);
  const second = renderContextSnapshot(snapshot);

  assert.equal(first, second);
  assert.match(first, /Zylos Context Snapshot v1/);
  assert.match(first, /Hello\\nworld/);
  assert.equal(first.includes('new session'), false);

  const tampered = { ...snapshot, requestId: 'req-tampered' };
  assert.throws(
    () => renderContextSnapshot(tampered),
    error => error?.code === 'CONTEXT_SNAPSHOT_HASH_MISMATCH',
  );
});

test('rejects platform-shaped ContextHints at the Core boundary without echoing values', async () => {
  const assembler = createAssembler();
  await assert.rejects(
    assembler.assemble({
      ...identity,
      contextHints: { thread_id: 'platform-secret-thread' },
    }),
    error => {
      assert.equal(error?.code, 'INVALID_CONTEXT_HINTS');
      assert.equal(error.message.includes('platform-secret-thread'), false);
      return true;
    },
  );
  await assert.rejects(
    assembler.assemble({
      ...identity,
      cardkitPayload: 'platform-secret-card-body',
    }),
    error => {
      assert.equal(error.message.includes('platform-secret-card-body'), false);
      return true;
    },
  );
});
