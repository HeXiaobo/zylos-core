#!/usr/bin/env node

import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { openCommitmentIntakeQueue } from '../../comm-bridge/scripts/c4-db.js';
import { runCommitmentIntakeWorkerOnce } from '../../comm-bridge/scripts/c4-intake-worker.js';
import { workIntakeProfileFromEnv } from '../../comm-bridge/scripts/c4-work-intake-profile.js';
import { openCommitmentCore } from './core.js';
import { decideExecutionControlPlane } from './execution-control-plane-gate.js';
import { mapExternalExecutionEvent } from './external-execution-adapter.js';
import { processProjectionBatch } from './projection-worker.js';
import { reconcileProjection } from './reconcile-projection.js';

function createFeishuEnvelope(agentId) {
  return Object.freeze({
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
      assigneeId: agentId,
    }),
  });
}

function resolveBusinessGateAgentId({ agentId, agentProfile }) {
  const profile = workIntakeProfileFromEnv({
    ...(agentId === undefined || agentId === null ? {} : { ZYLOS_AGENT_ID: agentId }),
    ...(agentProfile === undefined || agentProfile === null
      ? {}
      : { ZYLOS_AGENT_PROFILE: agentProfile }),
  });
  if (!profile.agentId) {
    const error = new Error('business MVP gate requires an explicit Agent identity');
    error.code = 'AGENT_ID_REQUIRED';
    throw error;
  }
  return profile.agentId;
}

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

function createDefaultProjectionAdapter({ failFirst = true } = {}) {
  let attempts = 0;
  let duplicateApplications = 0;
  const appliedEventIds = new Set();
  const tasks = new Map();
  return Object.freeze({
    async publishBatch({ deliveries }) {
      attempts += 1;
      if (failFirst && attempts === 1) throw new Error('offline injected external outage');
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

function normalizeExecutedAt(executionClock) {
  if (typeof executionClock !== 'function') {
    throw new TypeError('executionClock must be a function');
  }
  const value = executionClock();
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) {
    throw new TypeError('executionClock must return a valid timestamp');
  }
  return new Date(Date.parse(value)).toISOString();
}

function normalizeSourceRevision(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || value.trim() === '' || value.length > 256) {
    throw new TypeError('sourceRevision must be a non-empty string of at most 256 characters');
  }
  if (/[^\x21-\x7e]/.test(value)) {
    throw new TypeError('sourceRevision must contain printable ASCII without spaces');
  }
  return value;
}

/**
 * Run the offline, deterministic business-MVP acceptance Module.
 *
 * This Interface deliberately proves local behavior only. It never opens a
 * network connection and never represents an injected Adapter as a live
 * Feishu or other external-system result.
 */
export async function runBusinessMvpGate({
  agentId = null,
  agentProfile = null,
  clock = createDefaultClock(),
  executionClock = () => new Date().toISOString(),
  sourceRevision = process.env.ZYLOS_SOURCE_REVISION ?? null,
  processBoundary = defaultProcessBoundary,
  projectionAdapter = createDefaultProjectionAdapter(),
  replayProjectionAdapter = createDefaultProjectionAdapter({ failFirst: false }),
} = {}) {
  const effectiveAgentId = resolveBusinessGateAgentId({ agentId, agentProfile });
  const feishuEnvelope = createFeishuEnvelope(effectiveAgentId);
  const executedAt = normalizeExecutedAt(executionClock);
  const normalizedSourceRevision = normalizeSourceRevision(sourceRevision);
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
          envelope: feishuEnvelope,
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
      idempotencyKey: feishuEnvelope.idempotencyKey,
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
      idempotencyKey: feishuEnvelope.idempotencyKey,
    });
    const tasks = core.query({ limit: 100 });
    const fallbackDecision = decideExecutionControlPlane({
      controlPlane: { backend: 'openmax', state: 'http_error', httpStatus: 403 },
      localRuntime: { backend: 'local', state: 'ready' },
    });
    const blockedDecision = decideExecutionControlPlane({
      controlPlane: { backend: 'openmax', state: 'unreachable', httpStatus: null },
      localRuntime: { backend: 'local', state: 'unavailable' },
    });
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
    core.outbox.register({
      projection: 'business-mvp-publish-crash',
      bootstrapPolicy: 'from_beginning',
      actorId: 'operator:business-mvp-gate',
      idempotencyKey: 'business-mvp:register:publish-crash',
    });
    let acknowledgeAttempts = 0;
    const crashBeforeAckCore = {
      ...core,
      outbox: {
        ...core.outbox,
        ack(request, expectedVersion) {
          acknowledgeAttempts += 1;
          if (acknowledgeAttempts === 1) {
            throw new Error('simulated process exit before durable ack');
          }
          return core.outbox.ack(request, expectedVersion);
        },
      },
    };
    const interruptedProjectionBatch = await processProjectionBatch({
      core: crashBeforeAckCore,
      projection: 'business-mvp-publish-crash',
      workerId: 'business-mvp-crashing-worker',
      leaseMs: 60_000,
      limit: 100,
      retryAfterMs: 1_000,
      maxAttempts: 3,
      operationId: 'business-mvp:projection:before-ack-crash',
      adapter: replayProjectionAdapter,
    });
    const deliveryAfterPublishCrash = core.outbox.query({
      projection: 'business-mvp-publish-crash',
      eventId: creationEventId,
    });
    clock.advanceBy(60_000);
    const replayedProjectionBatch = await processProjectionBatch({
      core,
      projection: 'business-mvp-publish-crash',
      workerId: 'business-mvp-recovery-worker',
      leaseMs: 60_000,
      limit: 100,
      retryAfterMs: 1_000,
      maxAttempts: 3,
      operationId: 'business-mvp:projection:after-ack-crash',
      adapter: replayProjectionAdapter,
    });
    const deliveryAfterPublishReplay = core.outbox.query({
      projection: 'business-mvp-publish-crash',
      eventId: creationEventId,
    });
    const replayProjectionState = replayProjectionAdapter.inspect();
    const readyTask = core.query({ taskId: 'task-business-mvp' });
    const claimed = core.runs.claim({
      taskId: readyTask.id,
      actorId: effectiveAgentId,
      workerId: 'local-runtime:business-mvp',
      leaseMs: 60_000,
      idempotencyKey: 'business-mvp:run:claim',
    }, readyTask.version);
    const mappedCompletion = mapExternalExecutionEvent({
      backend: fallbackDecision.selectedBackend,
      eventId: 'business-mvp-local-delivered',
      eventType: 'delivered',
      taskId: claimed.task.id,
      actorId: effectiveAgentId,
      expectedVersion: claimed.task.version,
    });
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
        actorId: effectiveAgentId,
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
        id: 'control_plane_403_falls_back_to_local_review',
        passed: fallbackDecision.status === 'degraded'
          && fallbackDecision.selectedBackend === 'local'
          && fallbackDecision.dispatchAdmission === 'allowed'
          && fallbackDecision.completionPolicy === 'submit_for_review'
          && mappedCompletion.command.type === 'SubmitForReview'
          && completed.task.state === 'review',
        evidence: {
          decisionStatus: fallbackDecision.status,
          selectedBackend: fallbackDecision.selectedBackend,
          dispatchAdmission: fallbackDecision.dispatchAdmission,
          completionPolicy: fallbackDecision.completionPolicy,
          mappedCompletionCommand: mappedCompletion.command.type,
          stateAfterExecution: completed.task.state,
        },
      },
      {
        id: 'unavailable_backends_block_dispatch_not_intake',
        passed: blockedDecision.status === 'blocked'
          && blockedDecision.selectedBackend === null
          && blockedDecision.dispatchAdmission === 'blocked'
          && blockedDecision.completionPolicy === 'submit_for_review'
          && tasks.length === 1
          && tasks[0].state === 'ready',
        evidence: {
          decisionStatus: blockedDecision.status,
          selectedBackend: blockedDecision.selectedBackend,
          dispatchAdmission: blockedDecision.dispatchAdmission,
          completionPolicy: blockedDecision.completionPolicy,
          authoritativeTaskCount: tasks.length,
          taskStateAtDecision: tasks[0]?.state ?? null,
        },
      },
      {
        id: 'publish_before_ack_replays_without_duplicate_effect',
        passed: interruptedProjectionBatch.published === 1
          && interruptedProjectionBatch.settlementFailed === 1
          && deliveryAfterPublishCrash.status === 'leased'
          && replayedProjectionBatch.acknowledged === 1
          && deliveryAfterPublishReplay.status === 'acknowledged'
          && replayProjectionState.attempts === 2
          && replayProjectionState.appliedEventIds.length === 1
          && replayProjectionState.duplicateApplications === 1
          && replayProjectionState.records.length === 1,
        evidence: {
          publishedBeforeCrash: interruptedProjectionBatch.published,
          settlementFailedBeforeCrash: interruptedProjectionBatch.settlementFailed,
          deliveryStatusAfterCrash: deliveryAfterPublishCrash.status,
          recoveredDeliveryStatus: deliveryAfterPublishReplay.status,
          publishAttempts: replayProjectionState.attempts,
          uniqueExternalEvents: replayProjectionState.appliedEventIds.length,
          duplicatePublishAttempts: replayProjectionState.duplicateApplications,
          externalTaskCount: replayProjectionState.records.length,
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
          unauthorizedActor: effectiveAgentId,
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
      schemaVersion: 'zylos.task-management.business-mvp-gate/v2',
      mode: 'offline_injected_adapters',
      executedAt,
      scenarioTime: clock.nowIso(),
      sourceRevision: normalizedSourceRevision,
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
  const parsed = { outputPath: null, agentId: null, agentProfile: null };
  const fields = new Map([
    ['--agent-id', 'agentId'],
    ['--agent-profile', 'agentProfile'],
    ['--output', 'outputPath'],
  ]);
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const field = fields.get(flag);
    const value = args[index + 1];
    if (!field || typeof value !== 'string' || value.trim() === '') {
      throw new TypeError(
        'usage: business-mvp-gate.js (--agent-id <agent:id> | --agent-profile <profile>) [--output <report.json>]',
      );
    }
    if (parsed[field] !== null) throw new TypeError(`${flag} may be specified only once`);
    parsed[field] = field === 'outputPath' ? path.resolve(value) : value;
  }
  return parsed;
}

function unsafeOutputError(message) {
  const error = new Error(message);
  error.code = 'OUTPUT_PATH_UNSAFE';
  return error;
}

function assertSafeOutputTarget(outputPath) {
  let target;
  try {
    target = fs.lstatSync(outputPath);
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    throw error;
  }
  if (target.isSymbolicLink()) {
    throw unsafeOutputError('output path must not be a symbolic link');
  }
  if (!target.isFile()) {
    throw unsafeOutputError('output path must be a regular file or not exist');
  }
}

function writeReportAtomically(outputPath, serialized) {
  assertSafeOutputTarget(outputPath);
  const directory = path.dirname(outputPath);
  const temporaryPath = path.join(
    directory,
    `.${path.basename(outputPath)}.${process.pid}.${randomUUID()}.tmp`,
  );
  let descriptor = null;
  try {
    descriptor = fs.openSync(
      temporaryPath,
      fs.constants.O_WRONLY
        | fs.constants.O_CREAT
        | fs.constants.O_EXCL
        | fs.constants.O_NOFOLLOW,
      0o600,
    );
    fs.writeFileSync(descriptor, serialized, 'utf8');
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = null;
    fs.chmodSync(temporaryPath, 0o600);
    fs.renameSync(temporaryPath, outputPath);
  } catch (error) {
    if (descriptor !== null) fs.closeSync(descriptor);
    fs.rmSync(temporaryPath, { force: true });
    throw error;
  }
}

const isMainModule = process.argv[1]
  && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);

if (isMainModule) {
  try {
    const { outputPath, agentId, agentProfile } = parseCliArgs(process.argv.slice(2));
    const report = await runBusinessMvpGate({
      agentId: agentId ?? process.env.ZYLOS_AGENT_ID ?? null,
      agentProfile: agentProfile ?? process.env.ZYLOS_AGENT_PROFILE ?? null,
    });
    const serialized = `${JSON.stringify(report, null, 2)}\n`;
    if (outputPath) writeReportAtomically(outputPath, serialized);
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
