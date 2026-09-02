import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import Database from 'better-sqlite3';

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

test('migrates existing runtime admissions with lifecycle fences', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-runtime-schema-'));
  const dbPath = path.join(directory, 'c4.db');
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const legacy = new Database(dbPath);
  legacy.exec(`
    CREATE TABLE conversations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      direction TEXT NOT NULL,
      channel TEXT NOT NULL,
      content TEXT NOT NULL
    );
    CREATE TABLE runtime_turn_admissions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      singleton_key INTEGER NOT NULL DEFAULT 1,
      conversation_id INTEGER NOT NULL,
      request_id TEXT,
      route_channel TEXT NOT NULL,
      status TEXT NOT NULL,
      runtime_session_id TEXT,
      acquired_at INTEGER NOT NULL,
      started_at INTEGER,
      terminal_at INTEGER,
      updated_at INTEGER NOT NULL,
      terminal_reason TEXT
    );
    INSERT INTO conversations (direction, channel, content)
    VALUES ('inbound', 'feishu', 'legacy active turn');
    INSERT INTO runtime_turn_admissions (
      conversation_id, request_id, route_channel, status, runtime_session_id,
      acquired_at, started_at, updated_at, terminal_reason
    ) VALUES (1, NULL, 'feishu', 'started', 'legacy-session', 1, 2, 3, NULL);
  `);
  legacy.close();

  const migrationObservedAtMs = 1_000_900;
  const stream = openAssistantResponseStream({
    dbPath,
    observationClock: () => migrationObservedAtMs,
  });
  const migratedAdmission = stream.getActiveRuntimeTurn();
  assert.equal(migratedAdmission.lifecycleObservedAtMs, migrationObservedAtMs);
  const sameSecondOldHookMs = 1_000_700;
  assert.ok(sameSecondOldHookMs > Math.floor(migrationObservedAtMs / 1000) * 1000);
  const staleStop = stream.finishRuntimeTurn({
    runtimeSessionId: 'legacy-session',
    reason: 'stop',
    observedAtMs: sameSecondOldHookMs,
  });
  assert.equal(staleStop.finished, false);
  assert.equal(staleStop.reason, 'runtime_turn_observation_stale');
  assert.equal(stream.getActiveRuntimeTurn().status, 'started');
  stream.close();
  const migrated = new Database(dbPath, { readonly: true });
  const columns = migrated.prepare('PRAGMA table_info(runtime_turn_admissions)').all();
  assert.equal(columns.some(column => column.name === 'lifecycle_version'), true);
  assert.equal(columns.some(column => column.name === 'lifecycle_observed_at_ms'), true);
  assert.equal(columns.some(column => column.name === 'recovery_activity_observed_at_ms'), true);
  assert.equal(columns.some(column => column.name === 'recovery_activity_id'), true);
  assert.equal(columns.some(column => column.name === 'binding_mode'), true);
  assert.equal(columns.some(column => column.name === 'binding_projection_pending'), true);
  const candidateColumns = migrated.prepare(
    'PRAGMA table_info(assistant_final_output_candidates)',
  ).all();
  assert.equal(candidateColumns.some(column => column.name === 'observed_at_ms'), true);
  assert.equal(candidateColumns.some(column => column.name === 'activity_id'), true);
  migrated.close();
});

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

test('finds an older started request without treating queued or excluded work as active', () => {
  const stream = openAssistantResponseStream({ dbPath: ':memory:' });
  accept(stream, {
    requestId: 'assistant.feishu.request-a',
    sourceId: 'om_a',
    route: { channel: 'feishu', endpointId: 'oc_1|type:p2p|msg:om_a' },
  });
  stream.execute({ type: 'StartRun', requestId: 'assistant.feishu.request-a' });
  accept(stream, {
    requestId: 'assistant.feishu.request-b',
    sourceId: 'om_b',
    route: { channel: 'feishu', endpointId: 'oc_1|type:p2p|msg:om_b' },
  });

  assert.equal(
    stream.findStartedRequest({ excludingRequestId: 'assistant.feishu.request-b' }).requestId,
    'assistant.feishu.request-a',
  );
  stream.execute({
    type: 'CompleteRun',
    requestId: 'assistant.feishu.request-a',
    output: 'A is complete.',
  });
  assert.equal(
    stream.findStartedRequest({ excludingRequestId: 'assistant.feishu.request-b' }),
    null,
  );

  stream.execute({ type: 'StartRun', requestId: 'assistant.feishu.request-b' });
  assert.equal(stream.findStartedRequest().requestId, 'assistant.feishu.request-b');
  assert.equal(
    stream.findStartedRequest({ excludingRequestId: 'assistant.feishu.request-b' }),
    null,
  );
  stream.close();
});

test('serializes every runtime conversation from submission through terminal hook', () => {
  let now = 100;
  const stream = openAssistantResponseStream({ dbPath: ':memory:', clock: () => now++ });
  const first = accept(stream, {
    requestId: 'assistant.feishu.admission-a',
    sourceId: 'om_admission_a',
    route: { channel: 'feishu', endpointId: 'oc_1|type:p2p|msg:om_admission_a' },
  });
  const second = accept(stream, {
    requestId: 'assistant.feishu.admission-b',
    sourceId: 'om_admission_b',
    route: { channel: 'feishu', endpointId: 'oc_1|type:p2p|msg:om_admission_b' },
  });

  const acquired = stream.acquireRuntimeTurn({
    conversationId: first.request.conversationId,
    requestId: first.request.requestId,
    routeChannel: 'feishu',
  });
  assert.equal(acquired.acquired, true);
  assert.equal(acquired.admission.status, 'submitted');
  assert.equal(
    stream.acquireRuntimeTurn({
      conversationId: second.request.conversationId,
      requestId: second.request.requestId,
      routeChannel: 'feishu',
    }).acquired,
    false,
  );

  const started = stream.startRuntimeTurn({ runtimeSessionId: 'session-admission-a' });
  assert.equal(started.started, true);
  assert.equal(started.admission.status, 'started');
  assert.equal(
    stream.startRuntimeTurn({ runtimeSessionId: 'session-admission-a' }).replayed,
    true,
  );
  assert.equal(
    stream.startRuntimeTurn({ runtimeSessionId: 'session-other' }).reason,
    'runtime_session_conflict',
  );
  assert.equal(
    stream.finishRuntimeTurn({ runtimeSessionId: 'session-other', reason: 'stop' }).finished,
    false,
  );

  const finished = stream.finishRuntimeTurn({
    runtimeSessionId: 'session-admission-a',
    reason: 'stop',
  });
  assert.equal(finished.finished, true);
  assert.equal(finished.admission.status, 'completed');
  assert.equal(stream.getActiveRuntimeTurn(), null);

  const next = stream.acquireRuntimeTurn({
    conversationId: second.request.conversationId,
    requestId: null,
    routeChannel: 'hxa-connect',
  });
  assert.equal(next.acquired, true);
  assert.equal(next.admission.requestId, null);
  assert.equal(next.admission.routeChannel, 'hxa-connect');
  const released = stream.releaseRuntimeTurn({
    conversationId: second.request.conversationId,
    reason: 'tmux_paste_failed',
  });
  assert.equal(released.released, true);
  assert.equal(released.admission.status, 'released');
  assert.equal(stream.getActiveRuntimeTurn(), null);
  stream.close();
});

test('atomically finalizes the bound request with its runtime admission', () => {
  const stream = openAssistantResponseStream({
    dbPath: ':memory:',
    observationClock: () => 500,
  });
  const accepted = accept(stream, {
    requestId: 'assistant.feishu.atomic-stop',
    sourceId: 'om_atomic_stop',
    route: { channel: 'feishu', endpointId: 'oc_1|type:p2p|msg:om_atomic_stop' },
  });
  stream.acquireRuntimeTurn({
    conversationId: accepted.request.conversationId,
    requestId: accepted.request.requestId,
    routeChannel: 'feishu',
  });
  stream.execute({ type: 'StartRun', requestId: accepted.request.requestId });
  stream.startRuntimeTurn({
    runtimeSessionId: 'atomic-stop-session',
    observedAtMs: 1_000,
  });
  stream.execute({
    type: 'BindTurn',
    requestId: accepted.request.requestId,
    runtimeSessionId: 'atomic-stop-session',
  });

  const finished = stream.finishRuntimeTurn({
    runtimeSessionId: 'atomic-stop-session',
    reason: 'stop',
    observedAtMs: 1_100,
    requestId: accepted.request.requestId,
    output: 'atomic canonical answer',
  });

  assert.equal(finished.finished, true);
  assert.equal(finished.admission.status, 'completed');
  assert.equal(finished.request.status, 'completed');
  assert.equal(finished.request.output, 'atomic canonical answer');
  assert.deepEqual(finished.events.map(event => event.type), ['RunCompleted']);
  assert.equal(stream.getActiveRuntimeTurn(), null);
  stream.close();
});

test('rolls back request finalization when admission terminalization aborts', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-atomic-stop-rollback-'));
  const dbPath = path.join(directory, 'c4.db');
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const stream = openAssistantResponseStream({
    dbPath,
    observationClock: () => 500,
  });
  const accepted = accept(stream, {
    requestId: 'assistant.feishu.atomic-stop-rollback',
    sourceId: 'om_atomic_stop_rollback',
    route: { channel: 'feishu', endpointId: 'oc_1|type:p2p|msg:om_atomic_stop_rollback' },
  });
  stream.acquireRuntimeTurn({
    conversationId: accepted.request.conversationId,
    requestId: accepted.request.requestId,
    routeChannel: 'feishu',
  });
  stream.execute({ type: 'StartRun', requestId: accepted.request.requestId });
  stream.startRuntimeTurn({
    runtimeSessionId: 'atomic-stop-rollback-session',
    observedAtMs: 1_000,
  });
  stream.execute({
    type: 'BindTurn',
    requestId: accepted.request.requestId,
    runtimeSessionId: 'atomic-stop-rollback-session',
  });

  const faultDatabase = new Database(dbPath);
  faultDatabase.exec(`
    CREATE TRIGGER fail_runtime_admission_terminalization
    BEFORE UPDATE OF status ON runtime_turn_admissions
    WHEN NEW.status = 'completed'
    BEGIN
      SELECT RAISE(ABORT, 'injected admission terminalization failure');
    END;
  `);
  faultDatabase.close();

  assert.throws(
    () => stream.finishRuntimeTurn({
      runtimeSessionId: 'atomic-stop-rollback-session',
      reason: 'stop',
      observedAtMs: 1_100,
      requestId: accepted.request.requestId,
      output: 'must roll back with admission',
    }),
    /injected admission terminalization failure/,
  );

  const requestAfterFailure = stream.query({ requestId: accepted.request.requestId });
  assert.equal(requestAfterFailure.request.status, 'started');
  assert.equal(
    requestAfterFailure.events.some(event => event.type === 'RunCompleted'),
    false,
  );
  const admissionAfterFailure = stream.getActiveRuntimeTurn();
  assert.equal(admissionAfterFailure.status, 'started');
  assert.equal(admissionAfterFailure.bindingMode, 'bound');
  assert.equal(admissionAfterFailure.bindingProjectionPending, false);
  stream.close();
});

test('derives a missing best-effort binding from the durable admission owner', () => {
  const stream = openAssistantResponseStream({
    dbPath: ':memory:',
    observationClock: () => 500,
  });
  const accepted = accept(stream, {
    requestId: 'assistant.feishu.durable-stop-owner',
    sourceId: 'om_durable_stop_owner',
    route: { channel: 'feishu', endpointId: 'oc_1|type:p2p|msg:om_durable_stop_owner' },
  });
  stream.acquireRuntimeTurn({
    conversationId: accepted.request.conversationId,
    requestId: accepted.request.requestId,
    routeChannel: 'feishu',
  });
  stream.execute({ type: 'StartRun', requestId: accepted.request.requestId });
  stream.startRuntimeTurn({
    runtimeSessionId: 'durable-stop-owner-session',
    observedAtMs: 1_000,
  });
  stream.execute({
    type: 'BindTurn',
    requestId: accepted.request.requestId,
    runtimeSessionId: 'durable-stop-owner-session',
  });

  const finished = stream.finishRuntimeTurn({
    runtimeSessionId: 'durable-stop-owner-session',
    reason: 'stop',
    observedAtMs: 1_100,
    output: 'answer recovered from durable ownership',
  });

  assert.equal(finished.finished, true);
  assert.equal(finished.request.requestId, accepted.request.requestId);
  assert.equal(finished.request.status, 'completed');
  assert.equal(finished.request.output, 'answer recovered from durable ownership');
  stream.close();
});

test('a requestless HXA admission cannot bind or finalize an unrelated assistant request', () => {
  const stream = openAssistantResponseStream({
    dbPath: ':memory:',
    observationClock: () => 500,
  });
  const accepted = accept(stream, {
    requestId: 'assistant.feishu.must-not-belong-to-hxa',
    sourceId: 'om_must_not_belong_to_hxa',
    route: { channel: 'feishu', endpointId: 'oc_1|type:p2p|msg:om_must_not_belong_to_hxa' },
  });
  stream.execute({ type: 'StartRun', requestId: accepted.request.requestId });
  stream.acquireRuntimeTurn({
    conversationId: accepted.request.conversationId,
    requestId: null,
    routeChannel: 'hxa-connect',
  });
  stream.startRuntimeTurn({
    runtimeSessionId: 'requestless-hxa-session',
    observedAtMs: 1_000,
  });

  assert.throws(
    () => stream.execute({
      type: 'BindTurn',
      requestId: accepted.request.requestId,
      runtimeSessionId: 'requestless-hxa-session',
    }),
    error => error.code === 'ASSISTANT_ADMISSION_OWNERSHIP_CONFLICT',
  );
  const legacy = stream.execute({
    type: 'BindNextRun',
    runtimeSessionId: 'requestless-hxa-session',
  });
  assert.equal(legacy.request, null);

  const finished = stream.finishRuntimeTurn({
    runtimeSessionId: 'requestless-hxa-session',
    reason: 'stop',
    observedAtMs: 1_100,
    requestId: accepted.request.requestId,
    output: 'HXA output must not complete Feishu',
  });
  assert.equal(finished.finished, false);
  assert.equal(finished.reason, 'runtime_request_conflict');
  assert.equal(stream.getActiveRuntimeTurn().status, 'started');
  assert.equal(stream.query({ requestId: accepted.request.requestId }).request.status, 'started');
  stream.close();
});

test('a durable rejected binding cannot be rebound by a later fallback hook', () => {
  const stream = openAssistantResponseStream({
    dbPath: ':memory:',
    observationClock: () => 500,
  });
  const accepted = accept(stream, {
    requestId: 'assistant.feishu.binding-rejected',
    sourceId: 'om_binding_rejected',
    route: { channel: 'feishu', endpointId: 'oc_1|type:p2p|msg:om_binding_rejected' },
  });
  stream.acquireRuntimeTurn({
    conversationId: accepted.request.conversationId,
    requestId: accepted.request.requestId,
    routeChannel: 'feishu',
  });
  stream.execute({ type: 'StartRun', requestId: accepted.request.requestId });
  stream.startRuntimeTurn({
    runtimeSessionId: 'binding-rejected-session',
    observedAtMs: 1_000,
  });
  const rejected = stream.rejectRuntimeTurnBinding({
    runtimeSessionId: 'binding-rejected-session',
    reason: 'missing_terminal_marker',
    observedAtMs: 1_010,
  });
  assert.equal(rejected.rejected, true);
  assert.equal(rejected.admission.bindingMode, 'rejected');

  assert.throws(
    () => stream.execute({
      type: 'BindTurn',
      requestId: accepted.request.requestId,
      runtimeSessionId: 'binding-rejected-session',
    }),
    error => error.code === 'ASSISTANT_ADMISSION_BINDING_REJECTED',
  );
  const replayedRejection = stream.rejectRuntimeTurnBinding({
    runtimeSessionId: 'binding-rejected-session',
    reason: 'missing_terminal_marker',
    observedAtMs: 1_020,
  });
  assert.equal(replayedRejection.rejected, true);
  assert.equal(replayedRejection.replayed, true);
  assert.equal(stream.getActiveRuntimeTurn().bindingMode, 'rejected');
  assert.equal(stream.query({ requestId: accepted.request.requestId }).request.runtimeSessionId, null);
  stream.close();
});

test('rejects misrouted request-scoped mutations before writing any event or output', () => {
  const stream = openAssistantResponseStream({
    dbPath: ':memory:',
    observationClock: () => 500,
  });
  const requestA = accept(stream, {
    requestId: 'assistant.feishu.sqlite-owner-a',
    sourceId: 'om_sqlite_owner_a',
    route: { channel: 'feishu', endpointId: 'oc_1|type:p2p|msg:om_sqlite_owner_a' },
  });
  stream.execute({ type: 'StartRun', requestId: requestA.request.requestId });
  const requestB = accept(stream, {
    requestId: 'assistant.feishu.sqlite-owner-b',
    sourceId: 'om_sqlite_owner_b',
    route: { channel: 'feishu', endpointId: 'oc_1|type:p2p|msg:om_sqlite_owner_b' },
  });
  stream.acquireRuntimeTurn({
    conversationId: requestB.request.conversationId,
    requestId: requestB.request.requestId,
    routeChannel: 'feishu',
  });
  stream.execute({ type: 'StartRun', requestId: requestB.request.requestId });
  stream.startRuntimeTurn({
    runtimeSessionId: 'sqlite-owner-session-b',
    observedAtMs: 1_000,
  });
  stream.execute({
    type: 'BindTurn',
    requestId: requestB.request.requestId,
    runtimeSessionId: 'sqlite-owner-session-b',
  });

  const attempts = [
    {
      type: 'ReportRequestToolProgress',
      requestId: requestA.request.requestId,
      runtimeSessionId: 'sqlite-owner-session-b',
      observedAtMs: 1_100,
      activityId: 'misrouted-tool',
      toolName: 'Read',
      status: 'started',
      idempotencyKey: 'misrouted-tool',
    },
    {
      type: 'AppendPublicReasoningDelta',
      requestId: requestA.request.requestId,
      runtimeSessionId: 'sqlite-owner-session-b',
      observedAtMs: 1_110,
      activityId: 'misrouted-reasoning',
      delta: 'must not persist',
      idempotencyKey: 'misrouted-reasoning',
    },
    {
      type: 'AppendOutputDelta',
      requestId: requestA.request.requestId,
      runtimeSessionId: 'sqlite-owner-session-b',
      observedAtMs: 1_120,
      activityId: 'misrouted-output',
      delta: 'misrouted secret',
      idempotencyKey: 'misrouted-output',
    },
  ];
  for (const command of attempts) {
    const result = stream.execute(command);
    assert.equal(result.reason, 'runtime_admission_conflict');
    assert.deepEqual(result.events, []);
  }

  const unchanged = stream.query({ requestId: requestA.request.requestId });
  assert.equal(unchanged.request.output, '');
  assert.equal(
    unchanged.events.some(event => [
      'ProgressUpdated',
      'PublicReasoningDelta',
      'OutputDelta',
    ].includes(event.type)),
    false,
  );
  stream.close();
});

test('recovers a stale runtime admission before accepting the next conversation', () => {
  let now = 100;
  const stream = openAssistantResponseStream({
    dbPath: ':memory:',
    clock: () => now,
    runtimeTurnSubmittedStaleSeconds: 30,
  });
  const first = accept(stream, {
    requestId: 'assistant.feishu.stale-admission-a',
    sourceId: 'om_stale_admission_a',
    route: { channel: 'feishu', endpointId: 'oc_1|type:p2p|msg:om_stale_admission_a' },
  });
  const second = accept(stream, {
    requestId: 'assistant.feishu.stale-admission-b',
    sourceId: 'om_stale_admission_b',
    route: { channel: 'feishu', endpointId: 'oc_1|type:p2p|msg:om_stale_admission_b' },
  });

  const original = stream.acquireRuntimeTurn({
    conversationId: first.request.conversationId,
    requestId: first.request.requestId,
    routeChannel: 'feishu',
  });
  now = 129;
  assert.equal(stream.acquireRuntimeTurn({
    conversationId: second.request.conversationId,
    requestId: second.request.requestId,
    routeChannel: 'feishu',
  }).acquired, false);

  now = 131;
  const recovered = stream.acquireRuntimeTurn({
    conversationId: second.request.conversationId,
    requestId: second.request.requestId,
    routeChannel: 'feishu',
  });
  assert.equal(recovered.acquired, true);
  assert.equal(recovered.recoveredAdmission.admissionId, original.admission.admissionId);
  assert.equal(recovered.recoveredAdmission.status, 'released');
  assert.equal(recovered.recoveredAdmission.terminalReason, 'stale_before_reacquire');
  assert.equal(recovered.admission.conversationId, second.request.conversationId);
  stream.close();
});

test('recovers a stale runtime admission after the dispatcher database is reopened', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-runtime-admission-'));
  const dbPath = path.join(directory, 'c4.db');
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  let now = 100;
  const firstStream = openAssistantResponseStream({
    dbPath,
    clock: () => now,
    runtimeTurnSubmittedStaleSeconds: 30,
  });
  const first = accept(firstStream, {
    requestId: 'assistant.feishu.restart-admission-a',
    sourceId: 'om_restart_admission_a',
    route: { channel: 'feishu', endpointId: 'oc_1|type:p2p|msg:om_restart_admission_a' },
  });
  const second = accept(firstStream, {
    requestId: 'assistant.feishu.restart-admission-b',
    sourceId: 'om_restart_admission_b',
    route: { channel: 'feishu', endpointId: 'oc_1|type:p2p|msg:om_restart_admission_b' },
  });
  const original = firstStream.acquireRuntimeTurn({
    conversationId: first.request.conversationId,
    requestId: first.request.requestId,
    routeChannel: 'feishu',
  });
  firstStream.close();

  now = 131;
  const restartedStream = openAssistantResponseStream({
    dbPath,
    clock: () => now,
    runtimeTurnSubmittedStaleSeconds: 30,
  });
  const recovered = restartedStream.acquireRuntimeTurn({
    conversationId: second.request.conversationId,
    requestId: second.request.requestId,
    routeChannel: 'feishu',
  });
  assert.equal(recovered.acquired, true);
  assert.equal(recovered.recoveredAdmission.admissionId, original.admission.admissionId);
  assert.equal(recovered.recoveredAdmission.status, 'released');
  assert.equal(restartedStream.getActiveRuntimeTurn().conversationId, second.request.conversationId);
  restartedStream.close();
});

test('never age-expires a started turn and requires explicit idle reconciliation', () => {
  let now = 100;
  const stream = openAssistantResponseStream({
    dbPath: ':memory:',
    clock: () => now,
    runtimeTurnSubmittedStaleSeconds: 30,
  });
  const first = accept(stream, {
    requestId: 'assistant.feishu.long-running-a',
    sourceId: 'om_long_running_a',
    route: { channel: 'feishu', endpointId: 'oc_1|type:p2p|msg:om_long_running_a' },
  });
  const second = accept(stream, {
    requestId: 'assistant.feishu.long-running-b',
    sourceId: 'om_long_running_b',
    route: { channel: 'feishu', endpointId: 'oc_1|type:p2p|msg:om_long_running_b' },
  });
  const original = stream.acquireRuntimeTurn({
    conversationId: first.request.conversationId,
    requestId: first.request.requestId,
    routeChannel: 'feishu',
  });
  stream.startRuntimeTurn({ runtimeSessionId: 'long-running-session' });

  now = 10_000;
  assert.equal(stream.acquireRuntimeTurn({
    conversationId: second.request.conversationId,
    requestId: second.request.requestId,
    routeChannel: 'feishu',
  }).acquired, false);
  assert.equal(stream.getActiveRuntimeTurn().admissionId, original.admission.admissionId);
  assert.equal(stream.getActiveRuntimeTurn().status, 'started');

  const reconciled = stream.recoverRuntimeTurn({
    admissionId: original.admission.admissionId,
    expectedLifecycleVersion: stream.getActiveRuntimeTurn().lifecycleVersion,
    reason: 'runtime_sustained_idle',
  });
  assert.equal(reconciled.recovered, true);
  assert.equal(reconciled.admission.status, 'released');
  assert.equal(reconciled.admission.terminalReason, 'runtime_sustained_idle');
  assert.equal(reconciled.request.status, 'failed');
  assert.deepEqual(reconciled.events.map(event => event.type), ['RunFailed']);
  assert.equal(stream.acquireRuntimeTurn({
    conversationId: second.request.conversationId,
    requestId: second.request.requestId,
    routeChannel: 'feishu',
  }).acquired, true);
  stream.close();
});

test('idle recovery completes a fenced final-output candidate when Stop is lost', () => {
  let now = 100;
  const stream = openAssistantResponseStream({
    dbPath: ':memory:',
    clock: () => now++,
    observationClock: () => 500,
  });
  const accepted = accept(stream, {
    requestId: 'assistant.feishu.final-output-recovery',
    sourceId: 'om_final_output_recovery',
    route: { channel: 'feishu', endpointId: 'oc_1|type:p2p|msg:om_final_output_recovery' },
  });
  stream.acquireRuntimeTurn({
    conversationId: accepted.request.conversationId,
    requestId: accepted.request.requestId,
    routeChannel: 'feishu',
  });
  stream.execute({ type: 'StartRun', requestId: accepted.request.requestId });
  stream.startRuntimeTurn({
    runtimeSessionId: 'final-output-recovery-session',
    observedAtMs: 1_000,
  });
  stream.execute({
    type: 'BindTurn',
    requestId: accepted.request.requestId,
    runtimeSessionId: 'final-output-recovery-session',
  });
  stream.execute({
    type: 'AppendOutputDelta',
    requestId: accepted.request.requestId,
    delta: 'durable final answer',
    idempotencyKey: 'display:final-output-recovery:0',
  });
  const candidate = stream.execute({
    type: 'MarkFinalOutputCandidate',
    requestId: accepted.request.requestId,
    runtimeSessionId: 'final-output-recovery-session',
    messageId: 'message-final-output-recovery',
    observedAtMs: 1_100,
  });
  assert.equal(candidate.marked, true);

  const active = stream.getActiveRuntimeTurn();
  const recovered = stream.recoverRuntimeTurn({
    admissionId: active.admissionId,
    expectedLifecycleVersion: active.lifecycleVersion,
    reason: 'runtime_sustained_idle',
  });

  assert.equal(recovered.recovered, true);
  assert.equal(recovered.disposition, 'completed_from_final_output');
  assert.equal(recovered.request.status, 'completed');
  assert.equal(recovered.request.output, 'durable final answer');
  assert.deepEqual(recovered.events.map(event => event.type), ['RunCompleted']);
  assert.equal(recovered.admission.status, 'released');
  assert.equal(recovered.admission.terminalReason, 'runtime_sustained_idle_final_output');
  assert.equal(stream.getActiveRuntimeTurn(), null);
  assert.equal(stream.queryFinalOutputCandidates({ requestId: accepted.request.requestId })[0].status, 'consumed');
  const [projection] = stream.queryPendingRuntimeTurnBindingProjections();
  assert.equal(projection.admissionId, recovered.admission.admissionId);
  assert.equal(projection.bindingMode, 'closed');
  assert.equal(projection.bindingProjectionPending, true);
  assert.equal(stream.ackRuntimeTurnBindingProjection({
    admissionId: projection.admissionId,
  }).acknowledged, true);
  assert.deepEqual(stream.queryPendingRuntimeTurnBindingProjections(), []);
  stream.close();
});

test('idle recovery fails when later activity invalidates a final-output candidate', () => {
  const stream = openAssistantResponseStream({
    dbPath: ':memory:',
    observationClock: () => 500,
  });
  const accepted = accept(stream, {
    requestId: 'assistant.feishu.invalidated-final-output',
    sourceId: 'om_invalidated_final_output',
    route: { channel: 'feishu', endpointId: 'oc_1|type:p2p|msg:om_invalidated_final_output' },
  });
  stream.acquireRuntimeTurn({
    conversationId: accepted.request.conversationId,
    requestId: accepted.request.requestId,
    routeChannel: 'feishu',
  });
  stream.execute({ type: 'StartRun', requestId: accepted.request.requestId });
  stream.startRuntimeTurn({
    runtimeSessionId: 'invalidated-final-output-session',
    observedAtMs: 2_000,
  });
  stream.execute({
    type: 'BindTurn',
    requestId: accepted.request.requestId,
    runtimeSessionId: 'invalidated-final-output-session',
  });
  stream.execute({
    type: 'AppendOutputDelta',
    requestId: accepted.request.requestId,
    delta: 'intermediate answer',
    idempotencyKey: 'display:invalidated-final-output:0',
  });
  stream.execute({
    type: 'MarkFinalOutputCandidate',
    requestId: accepted.request.requestId,
    runtimeSessionId: 'invalidated-final-output-session',
    messageId: 'message-invalidated-final-output',
    observedAtMs: 2_100,
  });
  stream.execute({
    type: 'InvalidateFinalOutputCandidate',
    requestId: accepted.request.requestId,
    runtimeSessionId: 'invalidated-final-output-session',
    reason: 'SUBSEQUENT_TOOL_ACTIVITY',
  });

  const active = stream.getActiveRuntimeTurn();
  const recovered = stream.recoverRuntimeTurn({
    admissionId: active.admissionId,
    expectedLifecycleVersion: active.lifecycleVersion,
    reason: 'runtime_sustained_idle',
  });
  assert.equal(recovered.disposition, 'failed_without_final_output');
  assert.equal(recovered.request.status, 'failed');
  assert.deepEqual(recovered.events.map(event => event.type), ['RunFailed']);
  assert.equal(stream.queryFinalOutputCandidates({ requestId: accepted.request.requestId })[0].status, 'invalidated');
  stream.close();
});

test('a replayed older tool event does not invalidate a newer final-output candidate', () => {
  const stream = openAssistantResponseStream({
    dbPath: ':memory:',
    observationClock: () => 500,
  });
  const accepted = accept(stream, {
    requestId: 'assistant.feishu.replayed-tool-before-final',
    sourceId: 'om_replayed_tool_before_final',
    route: { channel: 'feishu', endpointId: 'oc_1|type:p2p|msg:om_replayed_tool_before_final' },
  });
  stream.acquireRuntimeTurn({
    conversationId: accepted.request.conversationId,
    requestId: accepted.request.requestId,
    routeChannel: 'feishu',
  });
  stream.execute({ type: 'StartRun', requestId: accepted.request.requestId });
  stream.startRuntimeTurn({
    runtimeSessionId: 'replayed-tool-before-final-session',
    observedAtMs: 3_000,
  });
  stream.execute({
    type: 'BindTurn',
    requestId: accepted.request.requestId,
    runtimeSessionId: 'replayed-tool-before-final-session',
  });
  const toolProgress = {
    type: 'ReportRequestToolProgress',
    requestId: accepted.request.requestId,
    toolName: 'Read',
    status: 'started',
    idempotencyKey: 'hook:pre_tool:toolu_before_final',
  };
  stream.execute(toolProgress);
  stream.execute({
    type: 'AppendOutputDelta',
    requestId: accepted.request.requestId,
    delta: 'answer after tool',
    idempotencyKey: 'display:replayed-tool-before-final:0',
  });
  stream.execute({
    type: 'MarkFinalOutputCandidate',
    requestId: accepted.request.requestId,
    runtimeSessionId: 'replayed-tool-before-final-session',
    messageId: 'message-replayed-tool-before-final',
    observedAtMs: 3_100,
  });

  const replay = stream.execute(toolProgress);
  assert.equal(replay.replayed, true);
  assert.equal(
    stream.queryFinalOutputCandidates({ requestId: accepted.request.requestId })[0].status,
    'active',
  );
  stream.close();
});

test('an invalidated final-output event cannot be replayed into a new active candidate', () => {
  const stream = openAssistantResponseStream({
    dbPath: ':memory:',
    observationClock: () => 500,
  });
  const accepted = accept(stream, {
    requestId: 'assistant.feishu.final-candidate-exact-replay',
    sourceId: 'om_final_candidate_exact_replay',
    route: { channel: 'feishu', endpointId: 'oc_1|type:p2p|msg:om_final_candidate_exact_replay' },
  });
  stream.acquireRuntimeTurn({
    conversationId: accepted.request.conversationId,
    requestId: accepted.request.requestId,
    routeChannel: 'feishu',
  });
  stream.execute({ type: 'StartRun', requestId: accepted.request.requestId });
  stream.startRuntimeTurn({
    runtimeSessionId: 'final-candidate-exact-replay-session',
    observedAtMs: 4_000,
  });
  stream.execute({
    type: 'BindTurn',
    requestId: accepted.request.requestId,
    runtimeSessionId: 'final-candidate-exact-replay-session',
  });
  stream.execute({
    type: 'AppendOutputDelta',
    requestId: accepted.request.requestId,
    runtimeSessionId: 'final-candidate-exact-replay-session',
    observedAtMs: 4_100,
    delta: 'answer before a later tool',
    idempotencyKey: 'display:final-candidate-exact-replay:0',
  });
  const mark = {
    type: 'MarkFinalOutputCandidate',
    requestId: accepted.request.requestId,
    runtimeSessionId: 'final-candidate-exact-replay-session',
    messageId: 'message-final-candidate-exact-replay',
    observedAtMs: 4_100,
    activityId: 'display:final-candidate-exact-replay:0',
  };
  assert.equal(stream.execute(mark).marked, true);
  stream.execute({
    type: 'ReportRequestToolProgress',
    requestId: accepted.request.requestId,
    runtimeSessionId: 'final-candidate-exact-replay-session',
    observedAtMs: 4_200,
    toolName: 'Read',
    status: 'started',
    idempotencyKey: 'hook:pre_tool:final-candidate-exact-replay',
  });

  const replay = stream.execute(mark);
  assert.equal(replay.replayed, true);
  assert.equal(replay.marked, false);
  const candidates = stream.queryFinalOutputCandidates({ requestId: accepted.request.requestId });
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].status, 'invalidated');
  stream.close();
});

test('fails closed when final output and different tool activity share one timestamp', () => {
  const stream = openAssistantResponseStream({
    dbPath: ':memory:',
    observationClock: () => 500,
  });
  const accepted = accept(stream, {
    requestId: 'assistant.feishu.same-ms-causality',
    sourceId: 'om_same_ms_causality',
    route: { channel: 'feishu', endpointId: 'oc_1|type:p2p|msg:om_same_ms_causality' },
  });
  stream.acquireRuntimeTurn({
    conversationId: accepted.request.conversationId,
    requestId: accepted.request.requestId,
    routeChannel: 'feishu',
  });
  stream.execute({ type: 'StartRun', requestId: accepted.request.requestId });
  stream.startRuntimeTurn({
    runtimeSessionId: 'same-ms-causality-session',
    observedAtMs: 1_000,
  });
  stream.execute({
    type: 'BindTurn',
    requestId: accepted.request.requestId,
    runtimeSessionId: 'same-ms-causality-session',
  });
  stream.execute({
    type: 'ReportRequestToolProgress',
    requestId: accepted.request.requestId,
    runtimeSessionId: 'same-ms-causality-session',
    observedAtMs: 1_100,
    activityId: 'tool:same-ms',
    toolName: 'Read',
    status: 'started',
    idempotencyKey: 'tool:same-ms',
  });
  stream.execute({
    type: 'AppendOutputDelta',
    requestId: accepted.request.requestId,
    runtimeSessionId: 'same-ms-causality-session',
    observedAtMs: 1_100,
    activityId: 'display:same-ms',
    delta: 'ambiguous final answer',
    idempotencyKey: 'display:same-ms',
  });
  const candidate = stream.execute({
    type: 'MarkFinalOutputCandidate',
    requestId: accepted.request.requestId,
    runtimeSessionId: 'same-ms-causality-session',
    messageId: 'message-same-ms',
    observedAtMs: 1_100,
    activityId: 'display:same-ms',
  });
  assert.equal(candidate.marked, false);
  assert.equal(candidate.reason, 'RECOVERY_ACTIVITY_AFTER_OUTPUT');
  assert.equal(candidate.candidate.status, 'invalidated');

  const active = stream.getActiveRuntimeTurn();
  const recovered = stream.recoverRuntimeTurn({
    admissionId: active.admissionId,
    expectedLifecycleVersion: active.lifecycleVersion,
  });
  assert.equal(recovered.disposition, 'failed_without_final_output');
  assert.equal(recovered.request.status, 'failed');
  assert.equal(
    stream.query({ requestId: accepted.request.requestId }).events
      .some(event => event.type === 'RunCompleted'),
    false,
  );
  stream.close();
});

test('idle recovery is fenced by lifecycle activity after the status snapshot', () => {
  let now = 100;
  const stream = openAssistantResponseStream({ dbPath: ':memory:', clock: () => now });
  const accepted = accept(stream, {
    requestId: 'assistant.feishu.recovery-fence',
    sourceId: 'om_recovery_fence',
    route: { channel: 'feishu', endpointId: 'oc_1|type:p2p|msg:om_recovery_fence' },
  });
  stream.acquireRuntimeTurn({
    conversationId: accepted.request.conversationId,
    requestId: accepted.request.requestId,
    routeChannel: 'feishu',
  });
  const started = stream.startRuntimeTurn({ runtimeSessionId: 'recovery-fence-session' });
  const idleSnapshotVersion = started.admission.lifecycleVersion;

  now = 101;
  const touched = stream.startRuntimeTurn({ runtimeSessionId: 'recovery-fence-session' });
  assert.equal(touched.replayed, true);
  assert.ok(touched.admission.lifecycleVersion > idleSnapshotVersion);

  const staleRecovery = stream.recoverRuntimeTurn({
    admissionId: started.admission.admissionId,
    expectedLifecycleVersion: idleSnapshotVersion,
    reason: 'runtime_sustained_idle',
  });
  assert.equal(staleRecovery.recovered, false);
  assert.equal(staleRecovery.reason, 'runtime_turn_lifecycle_changed');
  assert.equal(stream.getActiveRuntimeTurn().status, 'started');
  stream.close();
});

test('a delayed Stop cannot complete the next turn before its prompt starts', () => {
  const stream = openAssistantResponseStream({ dbPath: ':memory:' });
  const first = accept(stream, {
    requestId: 'assistant.feishu.fenced-stop-a',
    sourceId: 'om_fenced_stop_a',
    route: { channel: 'feishu', endpointId: 'oc_1|type:p2p|msg:om_fenced_stop_a' },
  });
  const second = accept(stream, {
    requestId: 'assistant.feishu.fenced-stop-b',
    sourceId: 'om_fenced_stop_b',
    route: { channel: 'feishu', endpointId: 'oc_1|type:p2p|msg:om_fenced_stop_b' },
  });

  stream.acquireRuntimeTurn({
    conversationId: first.request.conversationId,
    requestId: first.request.requestId,
    routeChannel: 'feishu',
  });
  stream.startRuntimeTurn({ runtimeSessionId: 'shared-runtime-session' });
  stream.finishRuntimeTurn({ runtimeSessionId: 'shared-runtime-session', reason: 'stop' });

  const next = stream.acquireRuntimeTurn({
    conversationId: second.request.conversationId,
    requestId: second.request.requestId,
    routeChannel: 'feishu',
  });
  const delayedStop = stream.finishRuntimeTurn({
    runtimeSessionId: 'shared-runtime-session',
    reason: 'stop',
  });

  assert.equal(delayedStop.finished, false);
  assert.equal(delayedStop.reason, 'runtime_turn_not_started');
  assert.equal(stream.getActiveRuntimeTurn().admissionId, next.admission.admissionId);
  assert.equal(stream.getActiveRuntimeTurn().status, 'submitted');
  stream.close();
});

test('observation time fences delayed lifecycle hooks after the next turn starts', () => {
  const stream = openAssistantResponseStream({
    dbPath: ':memory:',
    observationClock: () => 500,
  });
  const first = accept(stream, {
    requestId: 'assistant.feishu.observation-fence-a',
    sourceId: 'om_observation_fence_a',
    route: { channel: 'feishu', endpointId: 'oc_1|type:p2p|msg:om_observation_fence_a' },
  });
  const second = accept(stream, {
    requestId: 'assistant.feishu.observation-fence-b',
    sourceId: 'om_observation_fence_b',
    route: { channel: 'feishu', endpointId: 'oc_1|type:p2p|msg:om_observation_fence_b' },
  });

  stream.acquireRuntimeTurn({
    conversationId: first.request.conversationId,
    requestId: first.request.requestId,
    routeChannel: 'feishu',
  });
  stream.startRuntimeTurn({
    runtimeSessionId: 'shared-observation-session',
    observedAtMs: 1_000,
  });
  stream.finishRuntimeTurn({
    runtimeSessionId: 'shared-observation-session',
    reason: 'stop',
    observedAtMs: 1_100,
  });

  const next = stream.acquireRuntimeTurn({
    conversationId: second.request.conversationId,
    requestId: second.request.requestId,
    routeChannel: 'feishu',
  });
  const started = stream.startRuntimeTurn({
    runtimeSessionId: 'shared-observation-session',
    observedAtMs: 2_000,
  });
  assert.equal(started.started, true);

  const delayedTool = stream.touchRuntimeTurn({
    runtimeSessionId: 'shared-observation-session',
    observedAtMs: 1_500,
  });
  assert.equal(delayedTool.touched, false);
  assert.equal(delayedTool.reason, 'runtime_turn_observation_stale');
  const delayedStop = stream.finishRuntimeTurn({
    runtimeSessionId: 'shared-observation-session',
    reason: 'stop',
    observedAtMs: 1_600,
  });
  assert.equal(delayedStop.finished, false);
  assert.equal(delayedStop.reason, 'runtime_turn_observation_stale');

  const active = stream.getActiveRuntimeTurn();
  assert.equal(active.admissionId, next.admission.admissionId);
  assert.equal(active.status, 'started');
  assert.equal(active.lifecycleVersion, started.admission.lifecycleVersion);
  assert.equal(active.lifecycleObservedAtMs, 2_000);
  stream.close();
});

test('the turn-start fence accepts a Stop observed before a later same-turn hook persists', () => {
  const stream = openAssistantResponseStream({
    dbPath: ':memory:',
    observationClock: () => 500,
  });
  const accepted = accept(stream, {
    requestId: 'assistant.feishu.same-turn-stop-order',
    sourceId: 'om_same_turn_stop_order',
    route: { channel: 'feishu', endpointId: 'oc_1|type:p2p|msg:om_same_turn_stop_order' },
  });

  stream.acquireRuntimeTurn({
    conversationId: accepted.request.conversationId,
    requestId: accepted.request.requestId,
    routeChannel: 'feishu',
  });
  const started = stream.startRuntimeTurn({
    runtimeSessionId: 'same-turn-stop-session',
    observedAtMs: 1_000,
  });
  assert.equal(started.started, true);

  const laterPersistedHook = stream.touchRuntimeTurn({
    runtimeSessionId: 'same-turn-stop-session',
    observedAtMs: 1_300,
  });
  assert.equal(laterPersistedHook.touched, true);

  const stop = stream.finishRuntimeTurn({
    runtimeSessionId: 'same-turn-stop-session',
    reason: 'stop',
    observedAtMs: 1_200,
  });
  assert.equal(stop.finished, true);
  assert.equal(stop.admission.status, 'completed');
  assert.equal(stream.getActiveRuntimeTurn(), null);
  stream.close();
});

test('the acquisition observation fence rejects a delayed PreTool before prompt start', () => {
  const stream = openAssistantResponseStream({
    dbPath: ':memory:',
    observationClock: () => 2_000,
  });
  const accepted = accept(stream, {
    requestId: 'assistant.feishu.acquisition-fence',
    sourceId: 'om_acquisition_fence',
    route: { channel: 'feishu', endpointId: 'oc_1|type:p2p|msg:om_acquisition_fence' },
  });
  const acquired = stream.acquireRuntimeTurn({
    conversationId: accepted.request.conversationId,
    requestId: accepted.request.requestId,
    routeChannel: 'feishu',
  });
  assert.equal(acquired.admission.lifecycleObservedAtMs, 2_000);

  const delayedPreTool = stream.startRuntimeTurn({
    runtimeSessionId: 'acquisition-fence-session',
    observedAtMs: 1_999,
  });
  assert.equal(delayedPreTool.started, false);
  assert.equal(delayedPreTool.reason, 'runtime_turn_observation_stale');
  assert.equal(stream.getActiveRuntimeTurn().status, 'submitted');

  const prompt = stream.startRuntimeTurn({
    runtimeSessionId: 'acquisition-fence-session',
    observedAtMs: 2_001,
  });
  assert.equal(prompt.started, true);
  assert.equal(prompt.admission.status, 'started');
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

test('streams public reasoning separately from the canonical answer', () => {
  const stream = openAssistantResponseStream({ dbPath: ':memory:' });
  accept(stream);
  stream.execute({ type: 'StartRun', requestId: 'assistant.feishu.om_1' });
  stream.execute({ type: 'BindNextRun', runtimeSessionId: 'session-public-reasoning' });

  const first = stream.execute({
    type: 'AppendRuntimePublicReasoningDelta',
    runtimeSessionId: 'session-public-reasoning',
    delta: '先核对任务边界。\n',
    idempotencyKey: 'reasoning:summary:0',
  });
  const replay = stream.execute({
    type: 'AppendRuntimePublicReasoningDelta',
    runtimeSessionId: 'session-public-reasoning',
    delta: '先核对任务边界。\n',
    idempotencyKey: 'reasoning:summary:0',
  });
  stream.execute({
    type: 'AppendRuntimeOutputDelta',
    runtimeSessionId: 'session-public-reasoning',
    delta: '这是最终答案。',
    idempotencyKey: 'answer:0',
  });

  assert.deepEqual(first.events[0], {
    ...first.events[0],
    type: 'PublicReasoningDelta',
    payload: { delta: '先核对任务边界。\n' },
  });
  assert.equal(replay.replayed, true);
  const result = stream.query({ requestId: 'assistant.feishu.om_1' });
  assert.equal(result.request.output, '这是最终答案。');
  assert.deepEqual(result.events.slice(-2).map(event => event.type), [
    'PublicReasoningDelta',
    'OutputDelta',
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

test('binds an explicit request and refuses to guess or share a runtime session', () => {
  const stream = openAssistantResponseStream({ dbPath: ':memory:' });
  accept(stream);
  accept(stream, {
    requestId: 'assistant.feishu.om_2',
    sourceId: 'om_2',
    route: { channel: 'feishu', endpointId: 'oc_1|type:p2p|msg:om_2' },
  });
  stream.execute({ type: 'StartRun', requestId: 'assistant.feishu.om_1' });
  stream.execute({ type: 'StartRun', requestId: 'assistant.feishu.om_2' });

  const ambiguous = stream.execute({
    type: 'BindNextRun',
    runtimeSessionId: 'session-explicit',
  });
  assert.equal(ambiguous.request, null);
  assert.equal(ambiguous.ambiguous, true);

  const bound = stream.execute({
    type: 'BindRun',
    requestId: 'assistant.feishu.om_2',
    runtimeSessionId: 'session-explicit',
  });
  assert.equal(bound.request.requestId, 'assistant.feishu.om_2');
  assert.equal(bound.request.runtimeSessionId, 'session-explicit');
  assert.equal(stream.query({ requestId: 'assistant.feishu.om_1' }).request.runtimeSessionId, null);
  assert.throws(
    () => stream.execute({
      type: 'BindRun',
      requestId: 'assistant.feishu.om_1',
      runtimeSessionId: 'session-explicit',
    }),
    error => error.code === 'ASSISTANT_RUN_BINDING_CONFLICT',
  );
  stream.close();
});

test('retains an explicit binding when the prompt hook wins the RunStarted race', () => {
  const stream = openAssistantResponseStream({ dbPath: ':memory:' });
  accept(stream);

  const bound = stream.execute({
    type: 'BindRun',
    requestId: 'assistant.feishu.om_1',
    runtimeSessionId: 'session-queued-binding',
  });
  assert.equal(bound.request.status, 'queued');
  assert.equal(bound.request.runtimeSessionId, 'session-queued-binding');
  assert.deepEqual(bound.events, []);

  stream.execute({ type: 'StartRun', requestId: 'assistant.feishu.om_1' });
  stream.execute({
    type: 'AppendRuntimeOutputDelta',
    runtimeSessionId: 'session-queued-binding',
    delta: 'Bound before start.',
    idempotencyKey: 'queued-binding:delta:1',
  });
  assert.equal(
    stream.query({ requestId: 'assistant.feishu.om_1' }).request.output,
    'Bound before start.',
  );
  stream.close();
});

test('rejects explicit binding to a terminal request', () => {
  const stream = openAssistantResponseStream({ dbPath: ':memory:' });
  accept(stream);
  stream.execute({ type: 'StartRun', requestId: 'assistant.feishu.om_1' });
  stream.execute({
    type: 'CompleteRun',
    requestId: 'assistant.feishu.om_1',
    output: 'Already finished.',
  });

  assert.throws(
    () => stream.execute({
      type: 'BindRun',
      requestId: 'assistant.feishu.om_1',
      runtimeSessionId: 'session-terminal-binding',
    }),
    error => error.code === 'ASSISTANT_RUN_BINDING_TERMINAL',
  );
  stream.close();
});

test('atomically switches an explicit new turn to its request and fails the abandoned owner', () => {
  const stream = openAssistantResponseStream({ dbPath: ':memory:' });
  accept(stream);
  accept(stream, {
    requestId: 'assistant.feishu.om_2',
    sourceId: 'om_2',
    route: { channel: 'feishu', endpointId: 'oc_1|type:p2p|msg:om_2' },
  });
  stream.execute({ type: 'StartRun', requestId: 'assistant.feishu.om_1' });
  stream.execute({ type: 'StartRun', requestId: 'assistant.feishu.om_2' });
  stream.execute({
    type: 'BindRun',
    requestId: 'assistant.feishu.om_1',
    runtimeSessionId: 'session-turn-switch',
  });

  const switched = stream.execute({
    type: 'BindTurn',
    requestId: 'assistant.feishu.om_2',
    runtimeSessionId: 'session-turn-switch',
  });

  assert.equal(stream.query({ requestId: 'assistant.feishu.om_1' }).request.status, 'failed');
  assert.equal(stream.query({ requestId: 'assistant.feishu.om_1' }).request.output, '');
  assert.equal(switched.request.requestId, 'assistant.feishu.om_2');
  assert.equal(switched.request.runtimeSessionId, 'session-turn-switch');
  assert.equal(switched.request.status, 'started');
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

test('never age-expires a queued request that still awaits runtime delivery', () => {
  let now = 1_000;
  const stream = openAssistantResponseStream({ dbPath: ':memory:', clock: () => now });
  accept(stream, {
    requestId: 'assistant.feishu.queued-follow-up',
    sourceId: 'om_queued_follow_up',
  });

  now = 100_000;
  const expired = stream.execute({ type: 'ExpireStaleRuns', staleBefore: 99_000 });

  assert.deepEqual(expired.events, []);
  assert.equal(
    stream.query({ requestId: 'assistant.feishu.queued-follow-up' }).request.status,
    'queued',
  );
  stream.close();
});

test('recovers an unchanged started request after sustained runtime idle', () => {
  let now = 100;
  const stream = openAssistantResponseStream({ dbPath: ':memory:', clock: () => now });
  const accepted = accept(stream, {
    requestId: 'assistant.hxa.idle-recovery',
    sourceId: 'hxa.dm.idle-recovery',
    route: { channel: 'hxa', endpointId: 'agent:mylos' },
  });
  stream.execute({ type: 'StartRun', requestId: accepted.request.requestId });

  now = 130;
  const recovered = stream.execute({
    type: 'RecoverIdleRun',
    requestId: accepted.request.requestId,
    staleBefore: 100,
  });

  assert.equal(recovered.recovered, true);
  assert.equal(recovered.request.status, 'failed');
  assert.deepEqual(recovered.events.map(event => event.type), ['RunFailed']);
  assert.deepEqual(recovered.events[0].payload, {
    code: 'RUN_ABANDONED_WHILE_RUNTIME_IDLE',
    retryable: true,
  });
  stream.close();
});

test('idle recovery does not terminate a request that changed after observation', () => {
  let now = 100;
  const stream = openAssistantResponseStream({ dbPath: ':memory:', clock: () => now });
  const accepted = accept(stream, {
    requestId: 'assistant.hxa.idle-recovery-race',
    sourceId: 'hxa.dm.idle-recovery-race',
    route: { channel: 'hxa', endpointId: 'agent:mylos' },
  });
  stream.execute({ type: 'StartRun', requestId: accepted.request.requestId });
  now = 101;
  stream.execute({
    type: 'AppendOutputDelta',
    requestId: accepted.request.requestId,
    delta: 'still working',
    idempotencyKey: 'idle-recovery-race-progress',
  });

  now = 130;
  const recovery = stream.execute({
    type: 'RecoverIdleRun',
    requestId: accepted.request.requestId,
    staleBefore: 100,
  });

  assert.equal(recovery.recovered, false);
  assert.equal(recovery.request.status, 'started');
  assert.deepEqual(recovery.events, []);
  stream.close();
});

test('keeps a started request alive while its runtime admission sends a fresh heartbeat', () => {
  let now = 100;
  const stream = openAssistantResponseStream({
    dbPath: ':memory:',
    clock: () => now,
  });
  const accepted = accept(stream, {
    requestId: 'assistant.feishu.heartbeat-protected',
    sourceId: 'om_heartbeat_protected',
    route: { channel: 'feishu', endpointId: 'oc_1|type:p2p|msg:om_heartbeat_protected' },
  });
  stream.acquireRuntimeTurn({
    conversationId: accepted.request.conversationId,
    requestId: accepted.request.requestId,
    routeChannel: 'feishu',
  });
  stream.execute({ type: 'StartRun', requestId: accepted.request.requestId });
  stream.startRuntimeTurn({ runtimeSessionId: 'heartbeat-session' });
  stream.execute({
    type: 'BindTurn',
    requestId: accepted.request.requestId,
    runtimeSessionId: 'heartbeat-session',
  });

  now = 2_000;
  const heartbeat = stream.touchRuntimeTurn({ runtimeSessionId: 'heartbeat-session' });
  assert.equal(heartbeat.touched, true);

  const protectedRun = stream.execute({
    type: 'ExpireStaleRuns',
    staleBefore: 1_500,
  });
  assert.deepEqual(protectedRun.events, []);
  assert.equal(stream.query({ requestId: accepted.request.requestId }).request.status, 'started');

  now = 4_000;
  const expired = stream.execute({
    type: 'ExpireStaleRuns',
    staleBefore: 2_500,
  });
  assert.equal(expired.events[0].type, 'RunFailed');
  assert.equal(stream.query({ requestId: accepted.request.requestId }).request.status, 'failed');
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
