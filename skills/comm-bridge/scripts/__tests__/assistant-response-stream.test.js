import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ASSISTANT_RESPONSE_EVENT_TYPES,
  openAssistantResponseStream,
  safeProgressStageForTool,
} from '../assistant-response-stream.js';
import { createAssistantResponseDeliveryWorker } from '../c4-response-stream-supervisor.js';

function accept(stream, overrides = {}) {
  return stream.execute({
    type: 'AcceptAssistantRequest',
    requestId: 'assistant.feishu.om_1',
    sourceId: 'om_1',
    route: { channel: 'feishu', endpointId: 'oc_1|type:p2p|msg:om_1' },
    conversation: {
      content: '[Feishu DM] User said: hello',
      status: 'pending',
      priority: 3,
      requireIdle: false,
    },
    ...overrides,
  });
}

test('accepts once and exposes only the runtime-neutral event contract', () => {
  const stream = openAssistantResponseStream({ dbPath: ':memory:', clock: () => 100 });
  const first = accept(stream);
  const replay = accept(stream);

  assert.equal(first.replayed, false);
  assert.equal(replay.replayed, true);
  assert.equal(first.request.conversationId, replay.request.conversationId);
  assert.deepEqual(first.events.map(event => event.type), [
    'AssistantRequestAccepted',
    'RunQueued',
  ]);
  assert.deepEqual(first.events.map(event => event.sequence), [1, 2]);
  assert.deepEqual(first.events[0].payload, { sourceId: 'om_1' });
  assert.equal(first.events.every(event => ASSISTANT_RESPONSE_EVENT_TYPES.includes(event.type)), true);
  const serialized = JSON.stringify(first.events).toLowerCase();
  assert.equal(serialized.includes('cardkit'), false);
  assert.equal(serialized.includes('card_id'), false);
  assert.equal(serialized.includes('sequence_id'), false);

  assert.throws(
    () => accept(stream, { route: { channel: 'telegram', endpointId: 'other' } }),
    error => error.code === 'ASSISTANT_REQUEST_CONFLICT',
  );
  stream.close();
});

test('records verified lifecycle, real deltas, and canonical full completion', () => {
  let now = 200;
  const stream = openAssistantResponseStream({ dbPath: ':memory:', clock: () => now++ });
  accept(stream);
  const started = stream.execute({ type: 'StartRun', requestId: 'assistant.feishu.om_1' });
  stream.execute({ type: 'BindNextRun', runtimeSessionId: 'session-1' });
  const progress = stream.execute({
    type: 'ReportProgress',
    runtimeSessionId: 'session-1',
    stage: 'reading',
    idempotencyKey: 'tool:1',
  });
  const delta = stream.execute({
    type: 'AppendOutputDelta',
    requestId: 'assistant.feishu.om_1',
    delta: '真实',
    idempotencyKey: 'delta:1',
  });
  const replay = stream.execute({
    type: 'AppendOutputDelta',
    requestId: 'assistant.feishu.om_1',
    delta: '真实',
    idempotencyKey: 'delta:1',
  });
  const completed = stream.execute({
    type: 'CompleteRun',
    requestId: 'assistant.feishu.om_1',
    output: '真实完整答案',
  });

  assert.equal(started.events[0].type, 'RunStarted');
  assert.deepEqual(progress.events[0].payload, { stage: 'reading' });
  assert.deepEqual(delta.events[0].payload, { delta: '真实' });
  assert.equal(replay.replayed, true);
  assert.deepEqual(completed.events[0].payload, { output: '真实完整答案' });
  assert.deepEqual(stream.query({ requestId: 'assistant.feishu.om_1' }).events.map(event => event.type), [
    'AssistantRequestAccepted',
    'RunQueued',
    'RunStarted',
    'ProgressUpdated',
    'ProgressUpdated',
    'OutputDelta',
    'RunCompleted',
  ]);
  assert.equal(stream.query({ requestId: 'assistant.feishu.om_1' }).request.status, 'completed');
  stream.close();
});

test('appends displayed answer batches and completes through the bound runtime session', () => {
  const stream = openAssistantResponseStream({ dbPath: ':memory:' });
  accept(stream);
  stream.execute({ type: 'StartRun', requestId: 'assistant.feishu.om_1' });
  stream.execute({ type: 'BindNextRun', runtimeSessionId: 'session-display' });

  const first = stream.execute({
    type: 'AppendRuntimeOutputDelta',
    runtimeSessionId: 'session-display',
    delta: '第一段\n',
    idempotencyKey: 'display:message-1:0',
  });
  const replay = stream.execute({
    type: 'AppendRuntimeOutputDelta',
    runtimeSessionId: 'session-display',
    delta: '第一段\n',
    idempotencyKey: 'display:message-1:0',
  });
  const second = stream.execute({
    type: 'AppendRuntimeOutputDelta',
    runtimeSessionId: 'session-display',
    delta: '第二段',
    idempotencyKey: 'display:message-1:1',
  });
  const completed = stream.execute({
    type: 'CompleteRuntimeRun',
    runtimeSessionId: 'session-display',
    output: '第一段\n第二段',
  });

  assert.deepEqual(first.events[0].payload, { delta: '第一段\n' });
  assert.equal(replay.replayed, true);
  assert.deepEqual(second.events[0].payload, { delta: '第二段' });
  assert.deepEqual(completed.events[0].payload, { output: '第一段\n第二段' });
  const result = stream.query({ requestId: 'assistant.feishu.om_1' });
  assert.equal(result.request.status, 'completed');
  assert.equal(result.request.output, '第一段\n第二段');
  assert.deepEqual(result.events.slice(-3).map(event => event.type), [
    'OutputDelta',
    'OutputDelta',
    'RunCompleted',
  ]);
  stream.close();
});

test('rejects fabricated stages, unsafe identifiers, and changed idempotent deltas', () => {
  const stream = openAssistantResponseStream({ dbPath: ':memory:' });
  assert.throws(
    () => accept(stream, { requestId: 'bad";rm' }),
    /unsafe characters/,
  );
  accept(stream);
  stream.execute({ type: 'StartRun', requestId: 'assistant.feishu.om_1' });
  stream.execute({ type: 'BindNextRun', runtimeSessionId: 'session-1' });
  assert.throws(() => stream.execute({
    type: 'ReportProgress',
    runtimeSessionId: 'session-1',
    stage: 'thinking_about_hidden_reasoning',
    idempotencyKey: 'tool:unsafe',
  }), /safe public progress stage/);
  assert.throws(() => stream.execute({
    type: 'ReportToolProgress',
    runtimeSessionId: 'session-1',
    toolName: 'WebSearch',
    status: 'started',
    toolInput: { query: 'must never reach the public event' },
    idempotencyKey: 'tool:input-forbidden',
  }), /unsupported fields/);
  stream.execute({
    type: 'AppendOutputDelta',
    requestId: 'assistant.feishu.om_1',
    delta: 'a',
    idempotencyKey: 'delta:stable',
  });
  assert.throws(() => stream.execute({
    type: 'AppendOutputDelta',
    requestId: 'assistant.feishu.om_1',
    delta: 'b',
    idempotencyKey: 'delta:stable',
  }), error => error.code === 'ASSISTANT_EVENT_CONFLICT');
  stream.close();
});

test('maps actual tool names to a fixed public stage without carrying parameters', () => {
  assert.equal(safeProgressStageForTool('Read'), 'reading');
  assert.equal(safeProgressStageForTool('WebSearch'), 'searching');
  assert.equal(safeProgressStageForTool('mcp__lark__calendar_get'), 'querying');
  assert.equal(safeProgressStageForTool('Bash'), 'executing');
  assert.equal(safeProgressStageForTool('Bash', { failed: true }), 'recovering');
});

test('turns an observed tool start into a fixed public progress summary', () => {
  const stream = openAssistantResponseStream({ dbPath: ':memory:' });
  accept(stream);
  stream.execute({ type: 'StartRun', requestId: 'assistant.feishu.om_1' });
  stream.execute({ type: 'BindNextRun', runtimeSessionId: 'session-1' });

  const progress = stream.execute({
    type: 'ReportToolProgress',
    runtimeSessionId: 'session-1',
    toolName: 'WebSearch',
    status: 'started',
    idempotencyKey: 'tool:start:1',
  });

  assert.deepEqual(progress.events[0].payload, {
    stage: 'searching',
    action: 'search_sources',
    status: 'started',
    summary: 'Searching relevant sources',
  });
  assert.equal(JSON.stringify(progress.events[0]).includes('WebSearch'), false);
  stream.close();
});

test('binding the runtime emits a safe analysis summary even when no tools are needed', () => {
  const stream = openAssistantResponseStream({ dbPath: ':memory:' });
  accept(stream);
  stream.execute({ type: 'StartRun', requestId: 'assistant.feishu.om_1' });

  const bound = stream.execute({ type: 'BindNextRun', runtimeSessionId: 'session-no-tools' });

  assert.deepEqual(bound.events.map(event => event.payload), [{
    stage: 'organizing',
    action: 'analyze_request',
    status: 'started',
    summary: 'Analyzing the request',
  }]);
  stream.close();
});

test('reports observed tool completion without exposing the runtime tool name', () => {
  const stream = openAssistantResponseStream({ dbPath: ':memory:' });
  accept(stream);
  stream.execute({ type: 'StartRun', requestId: 'assistant.feishu.om_1' });
  stream.execute({ type: 'BindNextRun', runtimeSessionId: 'session-1' });

  const progress = stream.execute({
    type: 'ReportToolProgress',
    runtimeSessionId: 'session-1',
    toolName: 'mcp__lark__calendar_get',
    status: 'completed',
    idempotencyKey: 'tool:completed:1',
  });

  assert.deepEqual(progress.events[0].payload, {
    stage: 'querying',
    action: 'query_data',
    status: 'completed',
    summary: 'Relevant data checked',
  });
  assert.equal(JSON.stringify(progress.events[0]).includes('calendar_get'), false);
  stream.close();
});

test('reports tool failure as generic recovery without leaking custom tool identity', () => {
  const stream = openAssistantResponseStream({ dbPath: ':memory:' });
  accept(stream);
  stream.execute({ type: 'StartRun', requestId: 'assistant.feishu.om_1' });
  stream.execute({ type: 'BindNextRun', runtimeSessionId: 'session-1' });

  const progress = stream.execute({
    type: 'ReportToolProgress',
    runtimeSessionId: 'session-1',
    toolName: 'mcp__private_customer__lookup',
    status: 'failed',
    idempotencyKey: 'tool:failed:1',
  });

  assert.deepEqual(progress.events[0].payload, {
    stage: 'recovering',
    action: 'recover_tool',
    status: 'failed',
    summary: 'Adjusting after a tool issue',
  });
  assert.equal(JSON.stringify(progress.events[0]).includes('private_customer'), false);
  stream.close();
});

test('reports root-agent delegation as safe coordination rather than hidden reasoning', () => {
  const stream = openAssistantResponseStream({ dbPath: ':memory:' });
  accept(stream);
  stream.execute({ type: 'StartRun', requestId: 'assistant.feishu.om_1' });
  stream.execute({ type: 'BindNextRun', runtimeSessionId: 'session-1' });

  const progress = stream.execute({
    type: 'ReportToolProgress',
    runtimeSessionId: 'session-1',
    toolName: 'Agent',
    status: 'started',
    idempotencyKey: 'tool:agent:1',
  });

  assert.deepEqual(progress.events[0].payload, {
    stage: 'organizing',
    action: 'coordinate_work',
    status: 'started',
    summary: 'Coordinating work',
  });
  stream.close();
});

test('leases deliveries with fencing and recovers stale requests as RunFailed', () => {
  let now = 1_000;
  let token = 0;
  const stream = openAssistantResponseStream({
    dbPath: ':memory:',
    clock: () => now,
    leaseToken: () => `lease-${++token}`,
  });
  accept(stream);
  stream.execute({ type: 'StartRun', requestId: 'assistant.feishu.om_1' });
  now = 2_000;
  const expired = stream.execute({ type: 'ExpireStaleRuns', staleBefore: 1_500 });
  assert.equal(expired.events[0].type, 'RunFailed');
  assert.deepEqual(expired.events[0].payload, {
    code: 'RUN_STALE_AFTER_RESTART',
    retryable: true,
  });

  const deliveries = stream.claimDeliveries({ limit: 20, leaseSeconds: 10 });
  assert.equal(deliveries.length, 4);
  assert.deepEqual(deliveries.map(item => item.event.sequence), [1, 2, 3, 4]);
  assert.equal(stream.acknowledgeDeliveries([{ deliveryId: deliveries[0].deliveryId, leaseToken: 'wrong' }])[0].acknowledged, false);
  const acknowledgements = stream.acknowledgeDeliveries(deliveries.map(item => ({
    deliveryId: item.deliveryId,
    leaseToken: item.leaseToken,
  })));
  assert.equal(acknowledgements.every(item => item.acknowledged), true);
  stream.close();
});

test('delivery worker coalesces one request batch and retries adapter failure', async () => {
  const stream = openAssistantResponseStream({ dbPath: ':memory:', clock: () => 5_000 });
  accept(stream);
  const payloads = [];
  const worker = createAssistantResponseDeliveryWorker({
    responseStream: stream,
    adapterForChannel: channel => `/adapters/${channel}/stream.js`,
    adapterExists: () => true,
    deliver: async (_adapter, payload) => payloads.push(payload),
    clock: () => 5_000,
    staleSeconds: 1_000,
  });
  const result = await worker.drainOnce();
  assert.deepEqual(result, {
    expired: 0,
    claimed: 2,
    groups: 1,
    acknowledged: 2,
    retried: 0,
    deadLettered: 0,
  });
  assert.equal(payloads.length, 1);
  assert.deepEqual(payloads[0].events.map(event => event.type), [
    'AssistantRequestAccepted',
    'RunQueued',
  ]);
  worker.close();

  const failedStream = openAssistantResponseStream({ dbPath: ':memory:', clock: () => 6_000 });
  accept(failedStream);
  const failedWorker = createAssistantResponseDeliveryWorker({
    responseStream: failedStream,
    adapterForChannel: () => '/missing',
    adapterExists: () => false,
    clock: () => 6_000,
    staleSeconds: 1_000,
    maxAttempts: 1,
    logger: { warn() {} },
  });
  const failed = await failedWorker.drainOnce();
  assert.equal(failed.deadLettered, 2);
  failedWorker.close();
});

test('delivery retry fences later sequences until the earlier batch is available', async () => {
  let now = 7_000;
  const stream = openAssistantResponseStream({ dbPath: ':memory:', clock: () => now });
  accept(stream);
  const failedWorker = createAssistantResponseDeliveryWorker({
    responseStream: stream,
    adapterForChannel: () => '/adapter/feishu/stream.js',
    adapterExists: () => true,
    deliver: async () => { throw new Error('temporary adapter failure'); },
    clock: () => now,
    staleSeconds: 1_000,
    retryDelaySeconds: 2,
    logger: { warn() {} },
  });
  const failed = await failedWorker.drainOnce();
  assert.equal(failed.retried, 2);

  stream.execute({ type: 'StartRun', requestId: 'assistant.feishu.om_1' });
  const payloads = [];
  const succeedingWorker = createAssistantResponseDeliveryWorker({
    responseStream: stream,
    adapterForChannel: () => '/adapter/feishu/stream.js',
    adapterExists: () => true,
    deliver: async (_adapter, payload) => payloads.push(payload),
    clock: () => now,
    staleSeconds: 1_000,
  });
  assert.equal((await succeedingWorker.drainOnce()).claimed, 0);
  now += 2;
  assert.equal((await succeedingWorker.drainOnce()).claimed, 3);
  assert.deepEqual(payloads[0].events.map(item => item.sequence), [1, 2, 3]);
  succeedingWorker.close();
});

test('delivery worker bounds a hung adapter and returns the leased events to retry', async () => {
  const stream = openAssistantResponseStream({ dbPath: ':memory:', clock: () => 8_000 });
  accept(stream);
  const worker = createAssistantResponseDeliveryWorker({
    responseStream: stream,
    adapterForChannel: () => '/adapter/feishu/stream.js',
    adapterExists: () => true,
    deliver: async () => new Promise(() => {}),
    clock: () => 8_000,
    staleSeconds: 1_000,
    deliveryTimeoutMs: 10,
    logger: { warn() {} },
  });

  const result = await Promise.race([
    worker.drainOnce(),
    new Promise((_, reject) => setTimeout(() => reject(new Error('worker did not time out')), 200)),
  ]);
  assert.equal(result.retried, 2);
  assert.equal(result.deadLettered, 0);
  worker.close();
});

test('dead-letter deliveries are observable and can be explicitly redriven in order', () => {
  let now = 9_000;
  const stream = openAssistantResponseStream({ dbPath: ':memory:', clock: () => now });
  accept(stream);
  const leased = stream.claimDeliveries({ limit: 10 });
  stream.retryDeliveries(leased.map(item => ({
    deliveryId: item.deliveryId,
    leaseToken: item.leaseToken,
    error: 'Feishu unavailable',
  })), { maxAttempts: 1 });

  const failed = stream.queryDeliveries({
    requestId: 'assistant.feishu.om_1',
    status: 'dead_letter',
    limit: 10,
  });
  assert.deepEqual(failed.map(item => ({
    sequence: item.event.sequence,
    status: item.status,
    retryCount: item.retryCount,
    redriveCount: item.redriveCount,
  })), [
    { sequence: 1, status: 'dead_letter', retryCount: 1, redriveCount: 0 },
    { sequence: 2, status: 'dead_letter', retryCount: 1, redriveCount: 0 },
  ]);

  now += 1;
  const redrive = stream.redriveDeadLetters({
    requestId: 'assistant.feishu.om_1',
    limit: 10,
  });
  assert.deepEqual(redrive, { requestId: 'assistant.feishu.om_1', redriven: 2 });
  const pending = stream.queryDeliveries({
    requestId: 'assistant.feishu.om_1',
    status: 'pending',
    limit: 10,
  });
  assert.deepEqual(pending.map(item => ({
    sequence: item.event.sequence,
    retryCount: item.retryCount,
    redriveCount: item.redriveCount,
  })), [
    { sequence: 1, retryCount: 0, redriveCount: 1 },
    { sequence: 2, retryCount: 0, redriveCount: 1 },
  ]);
  assert.deepEqual(
    stream.claimDeliveries({ limit: 10 }).map(item => item.event.sequence),
    [1, 2],
  );
  stream.close();
});
