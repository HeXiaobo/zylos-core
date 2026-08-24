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
  const report = await runBusinessMvpGate();

  assert.equal(report.schemaVersion, 'zylos.task-management.business-mvp-gate/v1');
  assert.equal(report.mode, 'offline_injected_adapters');
  assert.equal(report.passed, true);
  assert.deepEqual(report.summary, { total: 6, passed: 6, failed: 0 });
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
  assert.match(report.generatedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.doesNotThrow(() => JSON.parse(JSON.stringify(report)));
});

test('the CLI emits and optionally persists the same machine-readable gate report', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-mvp-gate-cli-'));
  const outputPath = path.join(directory, 'gate-report.json');
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
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
