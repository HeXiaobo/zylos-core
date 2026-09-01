import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assertContractVectorSet,
  loadContractFixture,
} from './helpers/assistant-reply-contract.js';

const contract = loadContractFixture('contract-vectors.json');

test('v1 fixture exposes the complete cross-repository reply contract', () => {
  assertContractVectorSet(contract);
  assert.equal(contract.schema, 'zylos.assistant-reply-contract/v1');
  assert.equal(contract.version, 1);

  const eventTypes = new Set(
    contract.runtimeEventStreams.flatMap(stream => stream.events.map(event => event.type)),
  );
  assert.deepEqual(eventTypes, new Set([
    'RunAccepted',
    'RunQueued',
    'RunStarted',
    'ProgressUpdated',
    'RunCompleted',
    'RunFailed',
    'RunCancelled',
  ]));
});

test('transport and logical message identities are namespaced and dedupe before lane order', () => {
  const { command } = contract.acceptMessage.initial;
  const { source } = command;
  assert.notEqual(source.transportEventKey, source.logicalMessageKey);
  assert.equal(
    source.transportEventKey,
    `${source.adapterId}:${source.accountRef}:${source.eventType}:${source.eventId}`,
  );
  assert.equal(
    source.logicalMessageKey,
    `${source.adapterId}:${source.accountRef}:${source.eventType}:${source.messageId}`,
  );

  const initial = contract.acceptMessage.initial.accepted;
  const transportReplay = contract.acceptMessage.transportReplay.accepted;
  assert.equal(transportReplay.requestId, initial.requestId);
  assert.equal(transportReplay.laneSequence, initial.laneSequence);
  assert.equal(contract.acceptMessage.samePayloadReplay.expected, 'safe_replay');
  assert.equal(contract.acceptMessage.conflictingReplay.expectedError, 'IDEMPOTENCY_CONFLICT');
});

test('runtime events preserve complete identity, monotonic sequence, and one final terminal', () => {
  const terminalTypes = new Set(['RunCompleted', 'RunFailed', 'RunCancelled']);
  for (const stream of contract.runtimeEventStreams) {
    let previous = 0;
    let terminalCount = 0;
    stream.events.forEach((event, index) => {
      for (const field of [
        'eventId',
        'idempotencyKey',
        'requestId',
        'turnId',
        'traceId',
        'causationId',
        'producer',
      ]) {
        assert.equal(typeof event[field], 'string', `${stream.name}.${event.type}.${field}`);
        assert.ok(event[field].length > 0, `${stream.name}.${event.type}.${field}`);
      }
      assert.ok(event.sequence > previous, `${stream.name} sequence must be monotonic`);
      previous = event.sequence;
      if (terminalTypes.has(event.type)) {
        terminalCount += 1;
        assert.equal(index, stream.events.length - 1, `${stream.name} terminal must be last`);
      }
    });
    assert.equal(terminalCount, 1, `${stream.name} must contain one terminal`);
  }
});

test('one shared runtime remains globally serial while conversation lanes accept concurrently', () => {
  assert.deepEqual(contract.runtimeLane, {
    runtimeLaneKey: 'runtime:shared',
    capacity: 1,
    conversationLaneAcceptance: 'concurrent',
    runtimeTurnExecution: 'global_serial',
    scheduler: 'priority_then_acceptance_fifo',
    laneExposure: 'head_only',
    ordinaryMessageDuringActiveTurn: 'queued',
    ordinaryMessageMayAppendOrPreempt: false,
  });
  assert.equal(contract.cancelRequest.command.policy.mode, 'cooperative');
  assert.equal(contract.cancelRequest.expected.releaseBeforeConfirmation, false);
  assert.equal(contract.cancelRequest.expected.lateEventFence, 'turnId+generation');
});

test('context snapshots are immutable, watermarked, hashed, truncated deterministically, and replayed', () => {
  const { hints, snapshot, retry } = contract.context;
  assert.equal(hints.type, 'ContextHints');
  assert.equal(snapshot.type, 'ContextSnapshot');
  assert.equal(snapshot.immutable, true);
  assert.ok(Number.isSafeInteger(snapshot.asOfLaneSequence));
  assert.match(snapshot.contentHash, /^sha256:[a-f0-9]{64}$/);
  assert.deepEqual(Object.keys(snapshot.truncation).sort(), [
    'applied',
    'omittedCount',
    'policyVersion',
    'preservedRefs',
  ]);
  assert.equal(retry.contextSnapshotId, snapshot.snapshotId);
  assert.equal(retry.contextSnapshotHash, snapshot.contentHash);
  assert.equal(snapshot.runtimeSessionScope, 'runtime:shared');
  assert.equal(snapshot.conversationLaneCreatesSession, false);
});

test('explicit outcomes stay independent from reply intent and delivery settlement', () => {
  assert.equal(contract.outcomes.answer.type, 'ReplyOutcome');
  assert.equal(contract.outcomes.answer.kind, 'answer');
  assert.ok(contract.outcomes.answer.content.text.trim().length > 0);
  assert.equal(contract.outcomes.silent.kind, 'silent');
  assert.equal(contract.outcomes.silent.explicit, true);
  assert.equal(contract.outcomes.failure.kind, 'failure');
  assert.equal(contract.outcomes.missingOutput.expectedError, 'MISSING_OUTPUT');

  for (const intent of contract.replyIntents) {
    assert.ok(['run_terminal', 'task_effect'].includes(intent.cause.kind));
    if (intent.disposition === 'task_receipt') {
      assert.equal(intent.cause.kind, 'task_effect');
    }
  }

  assert.equal(contract.delivery.runCompleted.executionState, 'completed');
  assert.equal(contract.delivery.runCompleted.deliveryState, 'pending');
  assert.equal(contract.delivery.deadLetter.executionState, 'completed');
  assert.equal(contract.delivery.deadLetter.deliveryState, 'dead_letter');
});

test('delivery receipts do not overclaim read state and progress ACK is consumer-local', () => {
  assert.ok(contract.delivery.receipts.every(receipt => receipt.type === 'DeliveryReceipt'));
  assert.ok(contract.delivery.settlements.every(
    settlement => settlement.type === 'DeliverySettlement',
  ));
  const accepted = contract.delivery.receipts.find(
    receipt => receipt.outcome === 'platform_accepted',
  );
  assert.ok(accepted);
  assert.equal(accepted.meaning, 'platform accepted the request');
  assert.equal(Object.hasOwn(accepted, 'userRead'), false);
  const unknown = contract.delivery.receipts.find(receipt => receipt.outcome === 'unknown');
  assert.equal(unknown.nextAction, 'reconcile_before_retry');

  const consumers = contract.delivery.progressConsumers;
  assert.equal(consumers.length, 2);
  assert.notEqual(consumers[0].consumerId, consumers[1].consumerId);
  assert.notEqual(consumers[0].highWatermark, consumers[1].highWatermark);
  assert.equal(contract.delivery.progressAckScope, 'consumer_route');
});

test('task commands preserve actor provenance and require Core authorization', () => {
  const { command, decision } = contract.task;
  assert.equal(command.type, 'TaskCommand');
  assert.ok(command.actor.provider);
  assert.ok(command.actor.externalId);
  assert.ok(command.source.adapterId);
  assert.ok(command.source.messageId);
  assert.ok(command.capability);
  assert.ok(Number.isSafeInteger(command.expectedVersion));
  assert.equal(command.actor.provenance, 'verified_channel_actor');
  assert.equal(command.aiMayConstructActor, false);
  assert.equal(command.aiMayWriteDatabase, false);
  assert.equal(decision.type, 'AuthorizationDecision');
  assert.equal(decision.enforcedBy, 'TaskCore');
  assert.deepEqual(decision.checked, [
    'actor_role',
    'capability',
    'task_state',
    'expected_version',
  ]);
});
