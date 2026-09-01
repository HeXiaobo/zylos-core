import assert from 'node:assert/strict';
import test from 'node:test';

import {
  COMMON_CONTRACT_FILE,
  COMMON_CONTRACT_SHA256,
  assertCommonContractDigest,
  assertContractVectorSet,
  contractFixtureSha256,
  loadContractFixture,
  readContractFixtureBytes,
  requireText,
} from './helpers/assistant-reply-contract.js';

const contract = loadContractFixture(COMMON_CONTRACT_FILE);
const compatibilityCopy = loadContractFixture('contract-vectors.json');

const RUN_EVENT_TYPES = new Set([
  'RunAccepted',
  'RunQueued',
  'RunStarted',
  'ProgressUpdated',
  'OutputDelta',
  'RunCompleted',
  'RunFailed',
  'RunCancelled',
]);
const TERMINAL_EVENT_TYPES = new Set(['RunCompleted', 'RunFailed', 'RunCancelled']);

function allRunEvents() {
  return contract.runtimeEventStreams.flatMap(stream => stream.events);
}

function eventIndex() {
  return new Map(allRunEvents().map(event => [event.eventId, event]));
}

function outcomeIndex() {
  return new Map(Object.values(contract.replyOutcomes).map(outcome => [outcome.outcomeId, outcome]));
}

test('the checked-in common fixture is an immutable byte-identical v1 copy', () => {
  assert.equal(assertCommonContractDigest(), COMMON_CONTRACT_SHA256);
  assert.equal(contractFixtureSha256('contract-vectors.json'), COMMON_CONTRACT_SHA256);
  assert.deepEqual(
    readContractFixtureBytes(COMMON_CONTRACT_FILE),
    readContractFixtureBytes('contract-vectors.json'),
  );
  assert.deepEqual(compatibilityCopy, contract);
  assertContractVectorSet(contract);
});

test('AcceptMessage keeps derived source keys inside the owning boundary', () => {
  const { command, accepted, replayRules } = contract.acceptMessage;
  assert.equal(command.schemaVersion, 1);
  assert.equal(command.type, 'AcceptMessage');
  for (const field of ['commandId', 'idempotencyKey', 'traceId', 'causationId', 'issuedAt']) {
    requireText(command[field], `AcceptMessage.${field}`);
  }
  for (const field of [
    'adapterId',
    'accountRef',
    'targetRef',
    'conversationKey',
    'messageId',
    'eventId',
    'eventType',
    'payloadHash',
  ]) {
    requireText(command.source?.[field], `AcceptMessage.source.${field}`);
  }
  assert.match(command.source.payloadHash, /^sha256:[a-f0-9]{64}$/);
  assert.equal(Object.hasOwn(command.source, 'transportEventKey'), false);
  assert.equal(Object.hasOwn(command.source, 'logicalMessageKey'), false);
  assert.equal(command.policy.requireIdle, false);
  assert.equal(command.reply.mode, 'required');
  requireText(command.reply.targetRef, 'AcceptMessage.reply.targetRef');

  assert.equal(accepted.schemaVersion, 1);
  assert.equal(accepted.type, 'MessageAccepted');
  requireText(accepted.requestId, 'MessageAccepted.requestId');
  assert.equal(accepted.traceId, command.traceId);
  assert.equal(accepted.orderingMode, 'acceptance');
  assert.equal(accepted.sourceOrder, null);
  assert.equal(Number.isSafeInteger(accepted.laneSequence), true);
  assert.ok(accepted.laneSequence > 0);
  assert.deepEqual(replayRules.transportIdentityFields, [
    'source.adapterId',
    'source.accountRef',
    'source.eventType',
    'source.eventId',
  ]);
  assert.deepEqual(replayRules.logicalMessageIdentityFields, [
    'source.adapterId',
    'source.accountRef',
    'source.eventType',
    'source.messageId',
  ]);
  assert.equal(replayRules.sameKeySamePayload, 'safe_replay');
  assert.equal(replayRules.sameKeyDifferentPayload, 'IDEMPOTENCY_CONFLICT');
});

test('runtime events preserve identity, causation, lane binding, and one terminal', () => {
  const eventsById = eventIndex();
  const outcomesById = outcomeIndex();
  const terminalOutcomeIds = new Set();

  for (const stream of contract.runtimeEventStreams) {
    assert.ok(stream.events.length > 0, `${stream.name} must not be empty`);
    const first = stream.events[0];
    const previousIds = new Set();
    let previousSequence = 0;
    let terminalCount = 0;

    for (const [index, event] of stream.events.entries()) {
      assert.equal(event.schemaVersion, 1);
      assert.ok(RUN_EVENT_TYPES.has(event.type), `${stream.name} has unsupported ${event.type}`);
      for (const field of [
        'eventId',
        'idempotencyKey',
        'requestId',
        'turnId',
        'traceId',
        'causationId',
        'producer',
      ]) {
        requireText(event[field], `${stream.name}.${event.type}.${field}`);
      }
      assert.equal(event.requestId, first.requestId);
      assert.equal(event.turnId, first.turnId);
      assert.equal(event.traceId, first.traceId);
      assert.equal(event.generation, first.generation);
      assert.equal(Number.isSafeInteger(event.generation) && event.generation > 0, true);
      assert.equal(Number.isSafeInteger(event.sequence) && event.sequence > previousSequence, true);
      assert.equal(previousIds.has(event.eventId), false, `duplicate eventId ${event.eventId}`);
      previousIds.add(event.eventId);
      assert.equal(eventsById.get(event.eventId), event);
      previousSequence = event.sequence;

      if (index === 0) {
        assert.match(event.causationId, /^cmd:/);
      } else if (event.type === 'RunCancelled') {
        assert.equal(event.causationId, contract.cancelRequest.commandId);
      } else {
        assert.equal(event.causationId, stream.events[index - 1].eventId);
      }

      if (event.type === 'RunQueued' || event.type === 'RunStarted') {
        assert.equal(event.payload.runtimeLaneId, contract.runtimeLane.runtimeLaneId);
      }
      if (event.type === 'OutputDelta') {
        requireText(event.payload.text, `${stream.name}.OutputDelta.payload.text`);
      }
      if (!TERMINAL_EVENT_TYPES.has(event.type)) continue;

      terminalCount += 1;
      assert.equal(index, stream.events.length - 1, `${stream.name} terminal must be last`);
      if (event.type === 'RunCancelled') {
        assert.equal(Object.hasOwn(event.payload, 'outcomeId'), false);
        continue;
      }

      requireText(event.payload.outcomeId, `${stream.name}.${event.type}.payload.outcomeId`);
      const outcome = outcomesById.get(event.payload.outcomeId);
      assert.ok(outcome, `${stream.name} terminal must reference a known outcome`);
      assert.equal(outcome.requestId, event.requestId);
      assert.equal(outcome.turnId, event.turnId);
      assert.equal(outcome.traceId, event.traceId);
      terminalOutcomeIds.add(outcome.outcomeId);
    }
    assert.equal(terminalCount, 1, `${stream.name} must contain exactly one terminal`);
  }

  assert.deepEqual([...terminalOutcomeIds].sort(), [
    'outcome:req-001',
    'outcome:req-002',
    'outcome:req-004',
  ]);
  assert.equal(eventsById.get('evt:req-001:6').type, 'RunCompleted');
  assert.equal(eventsById.get('evt:req-001:6').payload.outcomeId, 'outcome:req-001');
});

test('runtime lane and cancellation semantics retain the official shared-runtime boundary', () => {
  assert.deepEqual(contract.runtimeLane, {
    runtimeLaneId: 'runtime:shared',
    capacity: 1,
    conversationLaneAcceptance: 'concurrent',
    runtimeTurnExecution: 'global_serial',
    scheduler: 'priority_then_acceptance_fifo',
    laneExposure: 'head_only',
    ordinaryMessageDuringActiveTurn: 'queued',
    ordinaryMessageMayAppendOrPreempt: false,
    cancelMode: 'cooperative_with_generation_fence',
  });
  assert.equal(JSON.stringify(contract).includes('runtimeLaneKey'), false);

  const cancel = contract.cancelRequest;
  assert.equal(cancel.type, 'CancelRequest');
  for (const field of [
    'commandId',
    'idempotencyKey',
    'requestId',
    'turnId',
    'traceId',
    'causationId',
    'issuedAt',
    'mode',
    'reason',
  ]) requireText(cancel[field], `CancelRequest.${field}`);
  assert.equal(cancel.mode, 'cooperative');
  assert.equal(cancel.actor.provenance, 'verified_channel_actor');
  assert.equal(cancel.source.adapterId, 'feishu');
  assert.equal(cancel.source.eventId, cancel.causationId);
  assert.equal(cancel.requestId, 'req-003');
  assert.equal(cancel.turnId, 'turn:req-003:1');
  assert.equal(cancel.generation, 1);
  assert.equal(contract.semantics.cancelledCreatesReplyIntent, false);
  assert.equal(contract.semantics.cancelledFinishesPresence, true);
});

test('ContextSnapshot is request-scoped, immutable by convention, and reused by the turn', () => {
  const snapshot = contract.contextSnapshot;
  assert.equal(snapshot.schemaVersion, 1);
  assert.equal(snapshot.type, 'ContextSnapshot');
  for (const field of [
    'snapshotId',
    'requestId',
    'turnId',
    'traceId',
    'conversationLaneKey',
    'contentHash',
    'retryPolicy',
  ]) requireText(snapshot[field], `ContextSnapshot.${field}`);
  assert.equal(Number.isSafeInteger(snapshot.asOfLaneSequence), true);
  assert.match(snapshot.contentHash, /^sha256:[a-f0-9]{64}$/);
  assert.ok(Array.isArray(snapshot.items));
  assert.deepEqual(Object.keys(snapshot.truncation).sort(), [
    'droppedItemRefs',
    'inputTokens',
    'keptTokens',
    'strategy',
  ]);
  assert.equal(snapshot.retryPolicy, 'reuse_same_snapshot');

  const started = contract.runtimeEventStreams
    .find(stream => stream.name === 'answer-completed')
    .events.find(event => event.type === 'RunStarted');
  assert.equal(started.payload.contextSnapshotId, snapshot.snapshotId);
  assert.equal(started.payload.contextSnapshotHash, snapshot.contentHash);
  assert.equal(snapshot.requestId, started.requestId);
  assert.equal(snapshot.turnId, started.turnId);
  assert.equal(snapshot.traceId, started.traceId);
});

test('ReplyOutcome and ReplyIntent keep terminal causes and trace identities explicit', () => {
  const outcomes = Object.values(contract.replyOutcomes);
  const eventsById = eventIndex();
  const intents = Object.values(contract.replyIntents);

  for (const outcome of outcomes) {
    for (const field of ['outcomeId', 'requestId', 'turnId', 'traceId', 'kind']) {
      requireText(outcome[field], `ReplyOutcome.${field}`);
    }
    assert.equal(outcome.schemaVersion, 1);
    assert.equal(outcome.type, 'ReplyOutcome');
  }
  assert.equal(contract.replyOutcomes.silent.explicit, true);
  assert.equal(contract.replyOutcomes.silent.kind, 'silent');
  assert.equal(contract.replyOutcomes.failure.kind, 'failure');
  assert.equal(contract.replyOutcomes.invalidEmptyAnswer.expectedError, 'MISSING_OUTPUT');
  assert.equal(contract.replyOutcomes.invalidEmptyAnswer.content.text, '');

  const terminalIds = new Set(
    allRunEvents().filter(event => TERMINAL_EVENT_TYPES.has(event.type)).map(event => event.eventId),
  );
  const referencedIntentIds = new Set();
  for (const intent of intents) {
    assert.equal(intent.schemaVersion, 1);
    assert.equal(intent.type, 'ReplyIntent');
    for (const field of ['intentId', 'requestId', 'traceId', 'contentHash', 'idempotencyKey']) {
      requireText(intent[field], `ReplyIntent.${field}`);
    }
    assert.match(intent.contentHash, /^sha256:[a-f0-9]{64}$/);
    assert.ok(['send', 'failure_notice', 'task_receipt'].includes(intent.disposition));
    assert.equal(intent.route.targetRef.startsWith('opaque:'), true);
    assert.equal(Object.hasOwn(intent.route, 'chatId'), false);
    assert.equal(Object.hasOwn(intent.route, 'threadId'), false);
    assert.ok(intent.payload && typeof intent.payload === 'object');
    requireText(intent.payload.text, `${intent.intentId}.payload.text`);
    assert.ok(!referencedIntentIds.has(intent.intentId));
    referencedIntentIds.add(intent.intentId);

    if (intent.cause.kind === 'run_terminal') {
      assert.ok(terminalIds.has(intent.cause.eventId), `${intent.intentId} cause must be a terminal`);
      const terminal = eventsById.get(intent.cause.eventId);
      assert.equal(intent.requestId, terminal.requestId);
      assert.equal(intent.traceId, terminal.traceId);
      assert.notEqual(terminal.type, 'RunCancelled');
      assert.equal(intent.disposition === 'task_receipt', false);
    } else {
      assert.equal(intent.cause.kind, 'task_effect');
      assert.equal(intent.disposition, 'task_receipt');
      assert.equal(intent.cause.eventId, 'task-effect-applied-001');
    }
  }
  assert.equal(Object.values(contract.replyIntents).some(intent => intent.requestId === 'req-004'), false);
  assert.equal(Object.values(contract.replyIntents).some(intent => intent.requestId === 'req-003'), false);
});

test('DeliveryReceipt and DeliverySettlement use separate, non-overclaiming records', () => {
  const receipts = Object.values(contract.deliveryReceipts);
  const settlements = Object.values(contract.deliverySettlements);
  const receiptIndex = new Map(receipts.map(receipt => [receipt.receiptId, receipt]));

  for (const receipt of receipts) {
    assert.equal(receipt.schemaVersion, 1);
    assert.equal(receipt.type, 'DeliveryReceipt');
    for (const field of [
      'receiptId',
      'intentId',
      'deliveryId',
      'requestId',
      'attemptId',
      'traceId',
      'adapterId',
      'outcome',
      'observedAt',
    ]) requireText(receipt[field], `DeliveryReceipt.${field}`);
    assert.ok(['platform_accepted', 'unknown', 'reconciled', 'rejected'].includes(receipt.outcome));
    assert.equal(Object.hasOwn(receipt, 'result'), false);
    assert.equal(Object.hasOwn(receipt, 'externalReceiptRef'), false);
    assert.equal(Object.hasOwn(receipt, 'userRead'), false);
  }

  const accepted = contract.deliveryReceipts.platformAccepted;
  const unknown = contract.deliveryReceipts.unknown;
  const reconciled = contract.deliveryReceipts.reconciled;
  assert.equal(accepted.externalRef.startsWith('opaque:'), true);
  assert.equal(unknown.externalRef, null);
  assert.equal(unknown.nextAction, 'reconcile_before_retry');
  assert.equal(unknown.deliveryId, accepted.deliveryId);
  assert.equal(reconciled.deliveryId, unknown.deliveryId);
  assert.equal(reconciled.attemptId, unknown.attemptId);
  assert.equal(reconciled.externalRef, accepted.externalRef);
  assert.equal(receiptIndex.get(unknown.receiptId), unknown);

  for (const settlement of settlements) {
    assert.equal(settlement.schemaVersion, 1);
    assert.equal(settlement.type, 'DeliverySettlement');
    for (const field of [
      'settlementId',
      'intentId',
      'deliveryId',
      'requestId',
      'traceId',
      'adapterId',
      'state',
      'basis',
    ]) requireText(settlement[field], `DeliverySettlement.${field}`);
    assert.equal(Object.hasOwn(settlement, 'outcome'), false);
    assert.equal(Object.hasOwn(settlement, 'externalRef'), false);
  }
  assert.deepEqual(contract.deliverySettlements.accepted, {
    ...contract.deliverySettlements.accepted,
    state: 'accepted',
    basis: 'platform_accepted',
    presented: true,
  });
  assert.equal(contract.deliverySettlements.reconciled.basis, 'reconciled');
  assert.equal(contract.deliverySettlements.unpresentable.state, 'unpresentable');
  assert.equal(contract.deliverySettlements.unpresentable.basis, 'retry_exhausted');
  assert.equal(contract.deliverySettlements.unpresentable.presented, false);
});

test('TaskCommand carries structured source and verified actor provenance', () => {
  const { command, authorizationDecision } = contract.taskCommand;
  assert.equal(command.schemaVersion, 1);
  assert.equal(command.type, 'TaskCommand');
  for (const field of [
    'commandId',
    'idempotencyKey',
    'requestId',
    'turnId',
    'traceId',
    'taskId',
    'command',
    'capability',
  ]) requireText(command[field], `TaskCommand.${field}`);
  assert.equal(typeof command.source, 'object');
  assert.deepEqual(Object.keys(command.source).sort(), [
    'accountRef',
    'adapterId',
    'eventId',
    'eventType',
    'messageId',
  ]);
  assert.equal(command.source.adapterId, 'feishu');
  assert.equal(typeof command.actor, 'object');
  assert.equal(command.actor.provenance, 'verified_channel_actor');
  assert.equal(Number.isSafeInteger(command.expectedVersion), true);
  assert.equal(command.aiMayConstructActor, false);
  assert.equal(command.aiMayWriteDatabase, false);

  assert.equal(authorizationDecision.schemaVersion, 1);
  assert.equal(authorizationDecision.type, 'AuthorizationDecision');
  assert.equal(authorizationDecision.commandId, command.commandId);
  assert.equal(authorizationDecision.enforcedBy, 'TaskCore');
  assert.deepEqual(authorizationDecision.checked, [
    'actor_role',
    'capability',
    'task_state',
    'expected_version',
  ]);
});
