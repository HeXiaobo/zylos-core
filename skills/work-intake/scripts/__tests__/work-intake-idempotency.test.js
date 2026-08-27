import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { openCommitmentCore } from '../../../commitment-core/scripts/core.js';
import { openCommitmentIntakeQueue } from '../../../comm-bridge/scripts/c4-db.js';
import { runCommitmentIntakeWorkerOnce } from '../../../comm-bridge/scripts/c4-intake-worker.js';
import { toCommitmentEnvelope } from '../commitment-adapter.js';
import { classify } from '../work-intake.js';

function inbound(intentRevision = 1) {
  return {
    source: {
      channel: 'feishu',
      messageId: 'om_confirmed_e2e',
      conversationId: 'oc_confirmed_e2e',
      conversationType: 'direct',
      threadId: null,
    },
    sender: { id: 'ou_human_sender', kind: 'human' },
    text: '任务：发送邮件给供应商确认交付时间',
    intentRevision,
    receivedAt: '2026-08-25T02:00:00.000Z',
    timeZone: 'Asia/Shanghai',
    people: [],
  };
}

test('replay, retry, and repeated confirmation clicks create exactly one Core task', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'work-intake-e2e-'));
  const c4DbPath = path.join(directory, 'c4.db');
  const coreDbPath = path.join(directory, 'commitments.db');
  let taskSequence = 0;
  let eventSequence = 0;
  const core = openCommitmentCore({
    dbPath: coreDbPath,
    idGenerator: () => `task-${++taskSequence}`,
    eventIdGenerator: () => `event-${++eventSequence}`,
    clock: () => '2026-08-25T02:05:00.000Z',
  });
  const queue = openCommitmentIntakeQueue({
    dbPath: c4DbPath,
    clock: () => 2_000_000_000,
  });

  try {
    const source = inbound();
    const decision = classify(source);
    assert.equal(decision.decision, 'confirm');
    const commitmentEnvelope = toCommitmentEnvelope(
      { envelope: source, decision },
      { confirmed: true },
    );

    const receipts = [];
    for (let click = 0; click < 10; click += 1) {
      receipts.push(queue.recordInbound({
        conversation: {
          channel: 'feishu',
          endpointId: 'oc_confirmed_e2e|type:p2p|msg:om_confirmed_e2e',
          content: '[confirmed WorkIntake task]',
          status: 'pending',
        },
        envelope: commitmentEnvelope,
      }));
    }
    assert.equal(receipts.filter((receipt) => receipt.created).length, 1);
    assert.equal(new Set(receipts.map((receipt) => receipt.intakeId)).size, 1);

    const firstRun = runCommitmentIntakeWorkerOnce({
      dbPath: c4DbPath,
      core,
      clock: () => 2_000_000_000,
    });
    assert.equal(firstRun.status, 'completed');
    assert.equal(firstRun.coreResult.created, true);
    assert.equal(runCommitmentIntakeWorkerOnce({
      dbPath: c4DbPath,
      core,
      clock: () => 2_000_000_000,
    }).status, 'idle');

    // A retry that reaches Core after C4 completion is still exactly idempotent.
    const directReplay = core.ingest(commitmentEnvelope);
    assert.equal(directReplay.created, false);
    assert.equal(core.query({}).length, 1);
    assert.deepEqual(core.query({})[0], firstRun.coreResult.task);
  } finally {
    queue.close();
    core.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('an explicit edit increments intent_revision and may create one new task', () => {
  const revisionOne = classify(inbound(1));
  const revisionTwo = classify(inbound(2));
  const envelopeOne = toCommitmentEnvelope(
    { envelope: inbound(1), decision: revisionOne },
    { confirmed: true },
  );
  const envelopeTwo = toCommitmentEnvelope(
    { envelope: inbound(2), decision: revisionTwo },
    { confirmed: true },
  );
  assert.notEqual(envelopeOne.idempotencyKey, envelopeTwo.idempotencyKey);
});
