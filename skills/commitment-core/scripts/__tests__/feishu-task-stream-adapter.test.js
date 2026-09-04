import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createFeishuTaskStreamAdapter,
  resolveFeishuOrigin,
  commandsForTaskEvent,
} from '../feishu-task-stream-adapter.js';

function delivery(event) {
  return {
    projection: 'feishu-task-stream',
    eventId: event.id,
    event: { id: event.id, type: event.type, taskId: 'task-1', version: event.version ?? 1, ...event },
  };
}

test('commandsForTaskEvent maps task lifecycle to assistant-stream commands', () => {
  const created = commandsForTaskEvent({ event: { type: 'TaskCreated' }, title: 'T' })
    .map(c => c.kind);
  // Accept only: the request stays 'queued' (not stale-timed) until the task starts.
  assert.deepEqual(created, ['accept']);

  const started = commandsForTaskEvent({ event: { type: 'TaskStarted' } })
    .map(c => c.kind);
  assert.deepEqual(started, ['start', 'tool']);
  assert.equal(commandsForTaskEvent({ event: { type: 'TaskStarted' } })[1].payload.status, 'started');

  const review = commandsForTaskEvent({ event: { type: 'TaskSubmittedForReview' } });
  assert.equal(review[0].payload.toolName, 'task-review-notify');
  assert.equal(review[0].payload.status, 'completed');

  const accepted = commandsForTaskEvent({ event: { type: 'TaskAccepted' }, title: '写周报' });
  assert.equal(accepted[0].kind, 'complete');
  assert.match(accepted[0].payload.output, /已完成/);
  assert.match(accepted[0].payload.output, /写周报/);

  const cancelled = commandsForTaskEvent({ event: { type: 'TaskCancelled' } });
  assert.equal(cancelled[0].kind, 'fail');
  assert.equal(cancelled[0].payload.retryable, false);

  // Non-streamed events are ignored.
  assert.deepEqual(commandsForTaskEvent({ event: { type: 'TaskDueUpdated' } }), []);
  assert.deepEqual(commandsForTaskEvent({ event: { type: 'TaskReminderUpdated' } }), []);
});

test('resolveFeishuOrigin returns null when the task has no Feishu source', () => {
  const result = resolveFeishuOrigin({
    sources: [{ channel: 'web-console', externalId: 'session-1', idempotencyKey: 'k' }],
    openC4Db: () => { throw new Error('c4 should not be opened'); },
  });
  assert.equal(result, null);
});

test('resolveFeishuOrigin derives the requestId/sourceId/endpoint from the intake join', () => {
  const sources = [{
    channel: 'feishu',
    externalId: 'om_test_123',
    idempotencyKey: 'feishu:om_test_123:work-intake:r1',
  }];
  const fakeC4 = {
    prepare() {
      return {
        get: () => ({ channel: 'feishu', endpoint: 'oc_chat_1|type:p2p|msg:om_test_123' }),
      };
    },
    close() {},
  };
  const result = resolveFeishuOrigin({ sources, openC4Db: () => fakeC4 });
  assert.equal(result.sourceId, 'om_test_123');
  assert.equal(result.endpoint, 'oc_chat_1|type:p2p|msg:om_test_123');
  assert.match(result.requestId, /^assistant\.feishu\.[0-9a-f]{40}$/);
  assert.equal(result.requestId, `assistant.feishu.${
    // deterministic from sha256(om_test_123)
    result.requestId.split('.')[2]}`);
});

test('publishDelivery skips non-streamed events and tasks without a Feishu origin', async () => {
  const executed = [];
  const core = {
    queryTaskSources: () => [{ channel: 'web-console', externalId: 'x', idempotencyKey: 'k' }],
    query: () => ({ title: 'T' }),
  };
  const adapter = createFeishuTaskStreamAdapter({
    core,
    exec: async (_cmd, _args, opts) => {
      executed.push(JSON.parse(opts.input));
      return { stdout: JSON.stringify({ ok: true }) };
    },
  });

  await adapter.publishDelivery({ delivery: delivery({ id: 'e1', type: 'TaskDueUpdated' }) });
  await adapter.publishDelivery({ delivery: delivery({ id: 'e2', type: 'TaskStarted' }) });
  assert.equal(executed.length, 0, 'no assistant events for a non-feishu task');
});

test('publishDelivery emits accept+start on create and a completing new message on accept', async () => {
  const executed = [];
  const sources = [{
    channel: 'feishu',
    externalId: 'om_test_456',
    idempotencyKey: 'feishu:om_test_456:work-intake:r1',
  }];
  const fakeC4 = {
    prepare: () => ({
      get: () => ({ channel: 'feishu', endpoint: 'oc_chat_1|type:p2p|msg:om_test_456' }),
    }),
    close() {},
  };
  const core = {
    queryTaskSources: () => sources,
    query: () => ({ title: '整理报告' }),
  };
  const adapter = createFeishuTaskStreamAdapter({
    core,
    openC4Db: () => fakeC4,
    exec: async (_cmd, _args, opts) => {
      executed.push(JSON.parse(opts.input));
      return { stdout: JSON.stringify({ ok: true }) };
    },
  });

  await adapter.publishDelivery({
    delivery: delivery({ id: 'e-created', type: 'TaskCreated' }),
  });
  assert.equal(executed.length, 1);
  assert.equal(executed[0].type, 'AcceptAssistantRequest');
  assert.equal(executed[0].sourceId, 'om_test_456');
  assert.equal(executed[0].route.channel, 'feishu');

  executed.length = 0;
  await adapter.publishDelivery({
    delivery: delivery({ id: 'e-done', type: 'TaskAccepted', version: 5 }),
  });
  assert.equal(executed.length, 1);
  assert.equal(executed[0].type, 'CompleteRun');
  assert.match(executed[0].output, /整理报告/);
  assert.match(executed[0].output, /已完成/);
});

test('a terminal/already-owned request is treated as non-retryable', async () => {
  const sources = [{
    channel: 'feishu',
    externalId: 'om_test_789',
    idempotencyKey: 'feishu:om_test_789:work-intake:r1',
  }];
  const core = {
    queryTaskSources: () => sources,
    query: () => ({ title: 'T' }),
  };
  const adapter = createFeishuTaskStreamAdapter({
    core,
    resolveOrigin: () => ({
      requestId: 'assistant.feishu.abc',
      sourceId: 'om_test_789',
      endpoint: 'oc_chat_1|type:p2p|msg:om_test_789',
    }),
    exec: async () => ({
      stdout: JSON.stringify({ ok: false, error: { code: 'X', message: 'assistant request already completed' } }),
    }),
  });
  await assert.doesNotReject(
    adapter.publishDelivery({ delivery: delivery({ id: 'e', type: 'TaskAccepted' }) }),
    'an already-terminal request is swallowed rather than retried',
  );
});
