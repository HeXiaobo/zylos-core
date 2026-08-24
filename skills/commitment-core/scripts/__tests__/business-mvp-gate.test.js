import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { runBusinessMvpGate } from '../business-mvp-gate.js';

const GATE_CLI = fileURLToPath(new URL('../business-mvp-gate.js', import.meta.url));

function gate(report, id) {
  return report.gates.find((candidate) => candidate.id === id);
}

function createInjectedProjectionAdapter({ failures = 1 } = {}) {
  let attempts = 0;
  let duplicateApplications = 0;
  const appliedEventIds = new Set();
  const tasks = new Map();
  return {
    async publishBatch({ deliveries }) {
      attempts += 1;
      if (attempts <= failures) throw new Error('injected external outage');
      for (const delivery of deliveries) {
        if (appliedEventIds.has(delivery.eventId)) {
          duplicateApplications += 1;
          continue;
        }
        appliedEventIds.add(delivery.eventId);
        tasks.set(delivery.event.taskId, {
          key: delivery.event.taskId,
          state: delivery.event.toState,
        });
      }
    },
    inspect() {
      return {
        attempts,
        appliedEventIds: [...appliedEventIds],
        duplicateApplications,
        records: [...tasks.values()],
      };
    },
    reset() {
      attempts = failures;
      duplicateApplications = 0;
      appliedEventIds.clear();
      tasks.clear();
    },
  };
}

test('the business MVP gate deduplicates ten replays of one Feishu-shaped source', async () => {
  const report = await runBusinessMvpGate();

  assert.deepEqual(gate(report, 'feishu_source_replay_deduplicated'), {
    id: 'feishu_source_replay_deduplicated',
    passed: true,
    evidence: {
      replayCount: 10,
      intakeRowsCreated: 1,
      coreTasksCreated: 1,
      authoritativeTaskCount: 1,
    },
  });
});

test('a killed intake process replays the durable source without creating another Task', async () => {
  let milliseconds = Date.parse('2026-08-25T02:00:00.000Z');
  let boundaryCalls = 0;
  const report = await runBusinessMvpGate({
    clock: {
      nowIso: () => new Date(milliseconds).toISOString(),
      nowSeconds: () => Math.floor(milliseconds / 1_000),
      advanceBy: (delta) => { milliseconds += delta; },
    },
    processBoundary({ phase }) {
      assert.equal(phase, 'after_core_ingest_before_intake_ack');
      boundaryCalls += 1;
      const error = new Error('injected process kill');
      error.code = 'SIMULATED_PROCESS_KILL';
      throw error;
    },
  });

  assert.equal(boundaryCalls, 1);
  assert.deepEqual(gate(report, 'intake_process_kill_recovered'), {
    id: 'intake_process_kill_recovered',
    passed: true,
    evidence: {
      crashObserved: true,
      queueStatusAfterCrash: 'processing',
      recoveryWorkerStatus: 'completed',
      recoveryIngestCreated: false,
      finalQueueStatus: 'completed',
    },
  });
});

test('an external projection outage cannot roll back Core and recovery applies no duplicate', async () => {
  const projectionAdapter = createInjectedProjectionAdapter();
  const report = await runBusinessMvpGate({ projectionAdapter });

  assert.deepEqual(gate(report, 'projection_failure_isolated_and_recovered'), {
    id: 'projection_failure_isolated_and_recovered',
    passed: true,
    evidence: {
      coreStateDuringOutage: 'ready',
      failedBatchStatus: 'retry_wait',
      recoveredBatchStatus: 'acknowledged',
      uniqueExternalEvents: 1,
      externalTaskCount: 1,
      duplicateApplications: 0,
    },
  });
});

test('the business gate degrades OpenMax 403 to local dispatch and review-only completion', async () => {
  const report = await runBusinessMvpGate();

  assert.deepEqual(gate(report, 'control_plane_403_falls_back_to_local_review'), {
    id: 'control_plane_403_falls_back_to_local_review',
    passed: true,
    evidence: {
      decisionStatus: 'degraded',
      selectedBackend: 'local',
      dispatchAdmission: 'allowed',
      completionPolicy: 'submit_for_review',
      mappedCompletionCommand: 'SubmitForReview',
      stateAfterExecution: 'review',
    },
  });
});

test('the business gate blocks dispatch without rejecting an already ingested Core Task', async () => {
  const report = await runBusinessMvpGate();

  assert.deepEqual(gate(report, 'unavailable_backends_block_dispatch_not_intake'), {
    id: 'unavailable_backends_block_dispatch_not_intake',
    passed: true,
    evidence: {
      decisionStatus: 'blocked',
      selectedBackend: null,
      dispatchAdmission: 'blocked',
      completionPolicy: 'submit_for_review',
      authoritativeTaskCount: 1,
      taskStateAtDecision: 'ready',
    },
  });
});

test('publish-before-ack crash replay applies the external event exactly once', async () => {
  const report = await runBusinessMvpGate();

  assert.deepEqual(gate(report, 'publish_before_ack_replays_without_duplicate_effect'), {
    id: 'publish_before_ack_replays_without_duplicate_effect',
    passed: true,
    evidence: {
      publishedBeforeCrash: 1,
      settlementFailedBeforeCrash: 1,
      deliveryStatusAfterCrash: 'leased',
      recoveredDeliveryStatus: 'acknowledged',
      publishAttempts: 2,
      uniqueExternalEvents: 1,
      duplicatePublishAttempts: 1,
      externalTaskCount: 1,
    },
  });
});

test('Agent completion stops at review instead of closing the business Task', async () => {
  const report = await runBusinessMvpGate();

  assert.deepEqual(gate(report, 'agent_completion_requires_review'), {
    id: 'agent_completion_requires_review',
    passed: true,
    evidence: {
      runStatus: 'completed',
      stateAfterAgentCompletion: 'review',
      doneByAgent: false,
    },
  });
});

test('only the configured business Acceptor can move review to done', async () => {
  const report = await runBusinessMvpGate();

  assert.deepEqual(gate(report, 'acceptor_authority_enforced'), {
    id: 'acceptor_authority_enforced',
    passed: true,
    evidence: {
      unauthorizedActor: 'agent:yueran',
      rejectedWith: 'FORBIDDEN',
      stateAfterRejectedAcceptance: 'review',
      authorizedAcceptor: 'ou_business_acceptor',
      finalState: 'done',
    },
  });
});

test('a deleted derived projection rebuilds from Core events and reconciles cleanly', async () => {
  const projectionAdapter = createInjectedProjectionAdapter();
  const report = await runBusinessMvpGate({ projectionAdapter });

  assert.deepEqual(gate(report, 'derived_projection_rebuilt_and_reconciled'), {
    id: 'derived_projection_rebuilt_and_reconciled',
    passed: true,
    evidence: {
      taskCountAfterDelete: 0,
      replayedEventCount: 4,
      rebuiltTaskCount: 1,
      authoritativeState: 'done',
      rebuiltState: 'done',
      reconciliationConsistent: true,
      discrepancyCount: 0,
    },
  });
});

test('the gate report is machine-readable and does not claim live-environment proof', async () => {
  const report = await runBusinessMvpGate({
    executionClock: () => '2026-08-25T06:30:00.000Z',
    sourceRevision: 'revision-under-test',
  });

  assert.equal(report.schemaVersion, 'zylos.task-management.business-mvp-gate/v2');
  assert.equal(report.mode, 'offline_injected_adapters');
  assert.equal(report.passed, true);
  assert.deepEqual(report.summary, { total: 9, passed: 9, failed: 0 });
  assert.deepEqual(report.liveEnvironmentProof, {
    feishuNetwork: false,
    aiEmployeeFleet: false,
    productionSupervisor: false,
  });
  assert.deepEqual(report.remainingProof, [
    'live_feishu_card_send_and_callback',
    'real_agent_runtime_claim_and_completion',
    'production_restart_and_external_outage_drill',
  ]);
  assert.equal(report.executedAt, '2026-08-25T06:30:00.000Z');
  assert.equal(report.scenarioTime, '2026-08-25T02:02:02.001Z');
  assert.equal(report.sourceRevision, 'revision-under-test');
  assert.equal(Object.hasOwn(report, 'generatedAt'), false);
  assert.doesNotThrow(() => JSON.parse(JSON.stringify(report)));
});

test('the CLI emits and optionally persists the same machine-readable gate report', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-mvp-gate-cli-'));
  const outputPath = path.join(directory, 'gate-report.json');
  fs.writeFileSync(outputPath, 'stale report', { mode: 0o644 });
  try {
    const result = spawnSync(process.execPath, [GATE_CLI, '--output', outputPath], {
      encoding: 'utf8',
    });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const stdoutReport = JSON.parse(result.stdout);
    const persistedReport = JSON.parse(fs.readFileSync(outputPath, 'utf8'));
    assert.deepEqual(persistedReport, stdoutReport);
    assert.equal(stdoutReport.passed, true);
    assert.equal(stdoutReport.mode, 'offline_injected_adapters');
    assert.equal(fs.statSync(outputPath).mode & 0o777, 0o600);
    assert.deepEqual(fs.readdirSync(directory), ['gate-report.json']);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('the CLI rejects a symlink output without modifying its target', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-mvp-gate-symlink-'));
  const victimPath = path.join(directory, 'victim.txt');
  const outputPath = path.join(directory, 'gate-report.json');
  fs.writeFileSync(victimPath, 'keep this content', { mode: 0o600 });
  fs.symlinkSync(victimPath, outputPath);
  try {
    const result = spawnSync(process.execPath, [GATE_CLI, '--output', outputPath], {
      encoding: 'utf8',
    });

    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.equal(fs.readFileSync(victimPath, 'utf8'), 'keep this content');
    assert.equal(fs.lstatSync(outputPath).isSymbolicLink(), true);
    const failure = JSON.parse(result.stderr);
    assert.equal(failure.error.code, 'OUTPUT_PATH_UNSAFE');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
