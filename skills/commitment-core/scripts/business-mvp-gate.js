#!/usr/bin/env node

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { openCommitmentIntakeQueue } from '../../comm-bridge/scripts/c4-db.js';
import { runCommitmentIntakeWorkerOnce } from '../../comm-bridge/scripts/c4-intake-worker.js';
import { openCommitmentCore } from './core.js';
import { processProjectionBatch } from './projection-worker.js';
import { reconcileProjection } from './reconcile-projection.js';

const FEISHU_ENVELOPE = Object.freeze({
  idempotencyKey: 'feishu:om_business_mvp:task-intent',
  source: Object.freeze({
    channel: 'feishu',
    externalId: 'om_business_mvp',
    senderId: 'ou_business_owner',
  }),
  task: Object.freeze({
    title: '完成重点客户回访',
    description: '整理反馈并提交给业务负责人验收',
    ownerId: 'ou_business_owner',
    acceptorId: 'ou_business_acceptor',
    assigneeId: 'agent:yueran',
  }),
});

function createDefaultClock() {
  let milliseconds = Date.parse('2026-08-25T02:00:00.000Z');
  return Object.freeze({
    nowIso: () => new Date(milliseconds).toISOString(),
    nowSeconds: () => Math.floor(milliseconds / 1_000),
    advanceBy: (delta) => { milliseconds += delta; },
  });
}

function defaultProcessBoundary() {
  const error = new Error('offline process-kill simulation');
  error.code = 'SIMULATED_PROCESS_KILL';
  throw error;
}

function createDefaultProjectionAdapter() {
  let attempts = 0;
  let duplicateApplications = 0;
  const appliedEventIds = new Set();
  const tasks = new Map();
  return Object.freeze({
    async publishBatch({ deliveries }) {
      attempts += 1;
      if (attempts === 1) throw new Error('offline injected external outage');
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
      duplicateApplications = 0;
      appliedEventIds.clear();
      tasks.clear();
    },
  });
}

function readIntakeStatus({ dbPath, clock, idempotencyKey }) {
  const queue = openCommitmentIntakeQueue({ dbPath, clock });
  try {
    return queue.get({ idempotencyKey })?.status ?? null;
  } finally {
    queue.close();
  }
}

/**
 * Run the offline, deterministic business-MVP acceptance Module.
 *
 * This Interface deliberately proves local behavior only. It never opens a
 * network connection and never represents an injected Adapter as a live
 * Feishu or other external-system result.
 */
export async function runBusinessMvpGate({
  clock = createDefaultClock(),
  processBoundary = defaultProcessBoundary,
  projectionAdapter = createDefaultProjectionAdapter(),
} = {}) {
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-business-mvp-'));
  const c4DbPath = path.join(workspaceDir, 'comm-bridge', 'c4.db');
  const coreDbPath = path.join(workspaceDir, 'commitments', 'commitments.db');
  let eventIndex = 0;
  let runEventIndex = 0;
  let core;

  try {
    core = openCommitmentCore({
      dbPath: coreDbPath,
      clock: clock.nowIso,
      idGenerator: () => 'task-business-mvp',
      eventIdGenerator: () => `event-business-mvp-${++eventIndex}`,
      runIdGenerator: () => 'run-business-mvp',
      runEventIdGenerator: () => `run-event-business-mvp-${++runEventIndex}`,
    });
    core.outbox.register({
      projection: 'business-mvp-primary',
      bootstrapPolicy: 'from_beginning',
      actorId: 'operator:business-mvp-gate',
      idempotencyKey: 'business-mvp:register:primary',
    });
    const intake = openCommitmentIntakeQueue({
      dbPath: c4DbPath,
      clock: clock.nowSeconds,
    });
    let intakeRowsCreated = 0;
    try {
      for (let replay = 0; replay < 10; replay += 1) {
        const recorded = intake.recordInbound({
          conversation: {
            channel: 'feishu',
            endpointId: 'oc_business_owner|type:p2p|msg:om_business_mvp',
            content: '请完成重点客户回访并提交验收',
          },
          envelope: FEISHU_ENVELOPE,
        });
        if (recorded.created) intakeRowsCreated += 1;
      }
    } finally {
      intake.close();
    }

    let crashObserved = false;
    try {
      runCommitmentIntakeWorkerOnce({
        dbPath: c4DbPath,
        core,
        clock: clock.nowSeconds,
        afterIngest() {
          processBoundary({ phase: 'after_core_ingest_before_intake_ack' });
        },
      });
    } catch (error) {
      if (error?.code !== 'SIMULATED_PROCESS_KILL') throw error;
      crashObserved = true;
    }

    const queueStatusAfterCrash = readIntakeStatus({
      dbPath: c4DbPath,
      clock: clock.nowSeconds,
      idempotencyKey: FEISHU_ENVELOPE.idempotencyKey,
    });

    clock.advanceBy(61_000);
    const workerResult = runCommitmentIntakeWorkerOnce({
      dbPath: c4DbPath,
      core,
      clock: clock.nowSeconds,
    });
    const finalQueueStatus = readIntakeStatus({
      dbPath: c4DbPath,
      clock: clock.nowSeconds,
      idempotencyKey: FEISHU_ENVELOPE.idempotencyKey,
    });
    const tasks = core.query({ limit: 100 });
    const coreEvents = tasks.length === 1
      ? core.query({ taskId: tasks[0].id, includeEvents: true }).events
      : [];
    const coreTasksCreated = coreEvents.filter((event) => event.type === 'TaskCreated').length;
    const failedProjectionBatch = await processProjectionBatch({
      core,
      projection: 'business-mvp-primary',
      workerId: 'business-mvp-worker',
      leaseMs: 60_000,
      limit: 100,
      retryAfterMs: 1_000,
      maxAttempts: 3,
      operationId: 'business-mvp:projection:outage',
      adapter: projectionAdapter,
    });
    const creationEventId = coreEvents.find((event) => event.type === 'TaskCreated')?.id;
    const failedDelivery = creationEventId
      ? core.outbox.query({
        projection: 'business-mvp-primary',
        eventId: creationEventId,
      })
      : null;
    const coreStateDuringOutage = tasks[0]?.state ?? null;

    clock.advanceBy(1_001);
    const recoveredProjectionBatch = await processProjectionBatch({
      core,
      projection: 'business-mvp-primary',
      workerId: 'business-mvp-worker',
      leaseMs: 60_000,
      limit: 100,
      retryAfterMs: 1_000,
      maxAttempts: 3,
      operationId: 'business-mvp:projection:recovery',
      adapter: projectionAdapter,
    });
    const recoveredDelivery = creationEventId
      ? core.outbox.query({
        projection: 'business-mvp-primary',
        eventId: creationEventId,
      })
      : null;
    const projectionState = projectionAdapter.inspect();
    const readyTask = core.query({ taskId: 'task-business-mvp' });
    const claimed = core.runs.claim({
      taskId: readyTask.id,
      actorId: 'agent:yueran',
      workerId: 'local-runtime:business-mvp',
      leaseMs: 60_000,
      idempotencyKey: 'business-mvp:run:claim',
    }, readyTask.version);
    const completed = core.runs.complete({
      taskId: readyTask.id,
      runId: claimed.run.id,
      workerId: 'local-runtime:business-mvp',
      idempotencyKey: 'business-mvp:run:complete',
    }, {
      runVersion: claimed.run.version,
      taskVersion: claimed.task.version,
    });
    let rejectedWith = null;
    try {
      core.command({
        type: 'AcceptTask',
        taskId: completed.task.id,
        actorId: 'agent:yueran',
        idempotencyKey: 'business-mvp:accept:unauthorized-agent',
      }, completed.task.version);
    } catch (error) {
      rejectedWith = error?.code ?? 'UNKNOWN_ERROR';
    }
    const stateAfterRejectedAcceptance = core.query({ taskId: completed.task.id }).state;
    const accepted = core.command({
      type: 'AcceptTask',
      taskId: completed.task.id,
      actorId: 'ou_business_acceptor',
      idempotencyKey: 'business-mvp:accept:authorized',
    }, completed.task.version);
    projectionAdapter.reset();
    const taskCountAfterDelete = projectionAdapter.inspect().records.length;
    core.outbox.register({
      projection: 'business-mvp-rebuild',
      bootstrapPolicy: 'from_beginning',
      actorId: 'operator:business-mvp-gate',
      idempotencyKey: 'business-mvp:register:rebuild',
    });
    const rebuiltBatch = await processProjectionBatch({
      core,
      projection: 'business-mvp-rebuild',
      workerId: 'business-mvp-rebuild-worker',
      leaseMs: 60_000,
      limit: 100,
      retryAfterMs: 1_000,
      maxAttempts: 3,
      operationId: 'business-mvp:projection:rebuild',
      adapter: projectionAdapter,
    });
    const rebuiltProjection = projectionAdapter.inspect();
    const authoritativeProjection = core.query({ limit: 100 }).map((task) => ({
      key: task.id,
      state: task.state,
    }));
    const reconciliation = reconcileProjection({
      expected: authoritativeProjection,
      actual: rebuiltProjection.records,
    });
    const discrepancyCount = reconciliation.missing.length
      + reconciliation.unexpected.length
      + reconciliation.stateMismatches.length
      + reconciliation.duplicateKeys.length;
    const gates = [
      {
        id: 'feishu_source_replay_deduplicated',
        passed: intakeRowsCreated === 1
          && coreTasksCreated === 1
          && tasks.length === 1,
        evidence: {
          replayCount: 10,
          intakeRowsCreated,
          coreTasksCreated,
          authoritativeTaskCount: tasks.length,
        },
      },
      {
        id: 'intake_process_kill_recovered',
        passed: crashObserved
          && queueStatusAfterCrash === 'processing'
          && workerResult.status === 'completed'
          && workerResult.coreResult?.created === false
          && finalQueueStatus === 'completed',
        evidence: {
          crashObserved,
          queueStatusAfterCrash,
          recoveryWorkerStatus: workerResult.status,
          recoveryIngestCreated: workerResult.coreResult?.created ?? null,
          finalQueueStatus,
        },
      },
      {
        id: 'projection_failure_isolated_and_recovered',
        passed: coreStateDuringOutage === 'ready'
          && failedProjectionBatch.retryWaiting === 1
          && failedDelivery?.status === 'retry_wait'
          && recoveredProjectionBatch.acknowledged === 1
          && recoveredDelivery?.status === 'acknowledged'
          && projectionState.appliedEventIds.length === 1
          && projectionState.records.length === 1
          && projectionState.duplicateApplications === 0,
        evidence: {
          coreStateDuringOutage,
          failedBatchStatus: failedDelivery?.status ?? null,
          recoveredBatchStatus: recoveredDelivery?.status ?? null,
          uniqueExternalEvents: projectionState.appliedEventIds.length,
          externalTaskCount: projectionState.records.length,
          duplicateApplications: projectionState.duplicateApplications,
        },
      },
      {
        id: 'agent_completion_requires_review',
        passed: completed.run.status === 'completed'
          && completed.task.state === 'review'
          && completed.task.state !== 'done',
        evidence: {
          runStatus: completed.run.status,
          stateAfterAgentCompletion: completed.task.state,
          doneByAgent: completed.task.state === 'done',
        },
      },
      {
        id: 'acceptor_authority_enforced',
        passed: rejectedWith === 'FORBIDDEN'
          && stateAfterRejectedAcceptance === 'review'
          && accepted.task.state === 'done',
        evidence: {
          unauthorizedActor: 'agent:yueran',
          rejectedWith,
          stateAfterRejectedAcceptance,
          authorizedAcceptor: 'ou_business_acceptor',
          finalState: accepted.task.state,
        },
      },
      {
        id: 'derived_projection_rebuilt_and_reconciled',
        passed: taskCountAfterDelete === 0
          && rebuiltBatch.acknowledged === 4
          && rebuiltProjection.records.length === 1
          && authoritativeProjection[0]?.state === 'done'
          && rebuiltProjection.records[0]?.state === 'done'
          && reconciliation.consistent
          && discrepancyCount === 0,
        evidence: {
          taskCountAfterDelete,
          replayedEventCount: rebuiltBatch.acknowledged,
          rebuiltTaskCount: rebuiltProjection.records.length,
          authoritativeState: authoritativeProjection[0]?.state ?? null,
          rebuiltState: rebuiltProjection.records[0]?.state ?? null,
          reconciliationConsistent: reconciliation.consistent,
          discrepancyCount,
        },
      },
    ];
    const passedCount = gates.filter((gate) => gate.passed).length;
    return {
      schemaVersion: 'zylos.task-management.business-mvp-gate/v1',
      mode: 'offline_injected_adapters',
      generatedAt: clock.nowIso(),
      passed: passedCount === gates.length,
      summary: {
        total: gates.length,
        passed: passedCount,
        failed: gates.length - passedCount,
      },
      liveEnvironmentProof: {
        feishuNetwork: false,
        aiEmployeeFleet: false,
        productionSupervisor: false,
      },
      remainingProof: [
        'live_feishu_card_send_and_callback',
        'real_agent_runtime_claim_and_completion',
        'production_restart_and_external_outage_drill',
      ],
      gates,
    };
  } finally {
    try {
      core?.close();
    } finally {
      fs.rmSync(workspaceDir, { recursive: true, force: true });
    }
  }
}

function parseCliArgs(args) {
  if (args.length === 0) return { outputPath: null };
  if (args.length === 2 && args[0] === '--output') {
    if (typeof args[1] !== 'string' || args[1].trim() === '') {
      throw new TypeError('--output requires a file path');
    }
    return { outputPath: path.resolve(args[1]) };
  }
  throw new TypeError('usage: business-mvp-gate.js [--output <report.json>]');
}

const isMainModule = process.argv[1]
  && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);

if (isMainModule) {
  try {
    const { outputPath } = parseCliArgs(process.argv.slice(2));
    const report = await runBusinessMvpGate();
    const serialized = `${JSON.stringify(report, null, 2)}\n`;
    if (outputPath) fs.writeFileSync(outputPath, serialized, { mode: 0o600 });
    process.stdout.write(serialized);
    if (!report.passed) process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`${JSON.stringify({
      schemaVersion: 'zylos.task-management.business-mvp-gate-error/v1',
      passed: false,
      error: {
        code: error?.code ?? 'GATE_EXECUTION_FAILED',
        message: error?.message ?? String(error),
      },
    })}\n`);
    process.exitCode = 1;
  }
}
