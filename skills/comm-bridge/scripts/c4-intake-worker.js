#!/usr/bin/env node

import { fileURLToPath } from 'node:url';

import { openCommitmentCore } from '../../commitment-core/scripts/core.js';
import { DB_PATH } from './c4-config.js';
import { openCommitmentIntakeQueue } from './c4-db.js';

export const INTAKE_MAX_RETRIES = 3;
export const INTAKE_STALE_AFTER_SECONDS = 60;
export const INTAKE_RETRY_DELAY_SECONDS = 5;

function systemClock() {
  return Math.floor(Date.now() / 1000);
}

export function runCommitmentIntakeWorkerOnce({
  dbPath = DB_PATH,
  core = null,
  clock = systemClock,
  afterIngest = null,
} = {}) {
  const queue = openCommitmentIntakeQueue({ dbPath, clock });
  const activeCore = core || openCommitmentCore();
  const ownsCore = !core;

  try {
    const intake = queue.claimNext({
      staleAfterSeconds: INTAKE_STALE_AFTER_SECONDS,
    });
    if (!intake) return { status: 'idle' };

    let coreResult;
    try {
      coreResult = activeCore.ingest(intake.envelope);
    } catch (error) {
      const transition = queue.retryOrFail(intake.id, error.message || error, {
        maxRetries: INTAKE_MAX_RETRIES,
        delaySeconds: INTAKE_RETRY_DELAY_SECONDS,
      });
      return {
        status: transition.status,
        intakeId: intake.id,
        retryCount: transition.retryCount,
      };
    }
    if (afterIngest) afterIngest({ intake, coreResult });
    queue.markCompleted(intake.id);
    return {
      status: 'completed',
      intakeId: intake.id,
      coreResult,
    };
  } finally {
    queue.close();
    if (ownsCore) activeCore.close();
  }
}

const isMainModule = process.argv[1]
  && fileURLToPath(import.meta.url) === process.argv[1];

if (isMainModule) {
  try {
    console.log(JSON.stringify(runCommitmentIntakeWorkerOnce()));
  } catch (error) {
    console.error(`[C4-Intake] ${error.stack || error.message}`);
    process.exitCode = 1;
  }
}
