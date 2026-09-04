import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import { isSqliteBusyError, openDatabaseWithSchemaRetry } from '../../../skills/comm-bridge/scripts/c4-db.js';
import {
  DEFAULT_CONSECUTIVE_FAILURE_LIMIT,
  superviseCommitmentIntake,
} from '../../../skills/comm-bridge/scripts/c4-intake-supervisor.js';
import { runAssistantResponseDeliveryLoop } from '../../../skills/comm-bridge/scripts/c4-response-stream-supervisor.js';
import { healthMarkerPath, writeHealthMarker } from '../../../skills/comm-bridge/scripts/c4-config.js';

function busyError(message = 'database is locked') {
  const error = new Error(message);
  error.code = 'SQLITE_BUSY';
  return error;
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

describe('c4-db schema-init retry (issue #54)', () => {
  it('classifies SQLITE_BUSY-family errors as retryable', () => {
    assert.equal(isSqliteBusyError(busyError()), true);
    assert.equal(isSqliteBusyError({ code: 'SQLITE_BUSY_SNAPSHOT' }), true);
    assert.equal(isSqliteBusyError({ code: 'SQLITE_LOCKED' }), true);
    assert.equal(isSqliteBusyError(new Error('SQLITE_LOCKED: table is locked')), true);
    assert.equal(isSqliteBusyError(new Error('no such table: conversations')), false);
    assert.equal(isSqliteBusyError({ code: 'SQLITE_CORRUPT' }), false);
    assert.equal(isSqliteBusyError(null), false);
  });

  it('reopens and retries schema init on transient busy errors', () => {
    let attempts = 0;
    const retryLogs = [];
    const database = openDatabaseWithSchemaRetry(
      () => {
        attempts += 1;
        if (attempts < 3) throw busyError();
        return { closed: false, handle: attempts };
      },
      (connection) => {
        if (connection.handle === 2) throw busyError('second attempt raced');
      },
      {
        baseDelayMs: 1,
        log: (event) => retryLogs.push(event),
      },
    );

    assert.equal(attempts, 3);
    assert.equal(database.handle, 3);
    assert.equal(retryLogs.length, 2);
    assert.equal(retryLogs[0].event, 'c4_db_schema_init_retry');
    assert.equal(retryLogs[0].attempt, 1);
  });

  it('fails closed after exhausting retries on persistent busy errors', () => {
    let attempts = 0;
    assert.throws(
      () => openDatabaseWithSchemaRetry(
        () => {
          attempts += 1;
          throw busyError();
        },
        null,
        { attempts: 3, baseDelayMs: 1 },
      ),
      busyError(),
    );
    assert.equal(attempts, 3);
  });

  it('does not retry non-busy failures', () => {
    let attempts = 0;
    assert.throws(
      () => openDatabaseWithSchemaRetry(
        () => {
          attempts += 1;
          throw new Error('no such table: conversations');
        },
        null,
        { attempts: 3, baseDelayMs: 1 },
      ),
      /no such table/,
    );
    assert.equal(attempts, 1);
  });

  it('rejects a non-positive attempt budget', () => {
    assert.throws(
      () => openDatabaseWithSchemaRetry(() => ({}), null, { attempts: 0 }),
      TypeError,
    );
  });
});

describe('intake supervisor fail-closed (issue #54)', () => {
  it('stops with a fatal result after the consecutive-failure limit', async () => {
    let cycles = 0;
    const events = [];
    const instantSleep = async () => {
      sleepSync(1);
    };
    const result = await superviseCommitmentIntake({
      maxItems: 1,
      intervalMs: 1,
      drain: () => {
        cycles += 1;
        throw busyError('schema init failed');
      },
      sleep: instantSleep,
      log: (event) => events.push(event),
      failureLimit: 3,
    });

    assert.equal(result.stopReason, 'consecutive_failures');
    assert.equal(result.consecutiveFailures, 3);
    assert.equal(cycles, 3);
    const fatal = events.find(event => event.event === 'commitment_intake_supervisor_fatal');
    assert.ok(fatal, 'expected a fatal structured log event');
  });

  it('keeps running when failures are transient and reports first success once', async () => {
    const controller = new AbortController();
    let cycles = 0;
    let firstSuccessCalls = 0;
    const result = await superviseCommitmentIntake({
      maxItems: 1,
      intervalMs: 1,
      drain: () => {
        cycles += 1;
        if (cycles <= 2) throw busyError();
        if (cycles >= 4) controller.abort();
        return { attempted: 1, completed: 1, retried: 0, failed: 0, stopReason: 'idle' };
      },
      sleep: async () => sleepSync(1),
      log: () => {},
      signal: controller.signal,
      failureLimit: DEFAULT_CONSECUTIVE_FAILURE_LIMIT,
      onFirstSuccess: () => { firstSuccessCalls += 1; },
    });

    assert.equal(result.stopReason, 'aborted');
    assert.equal(firstSuccessCalls, 1);
    assert.ok(cycles >= 4);
  });

  it('keeps supervising when failureLimit is disabled (0)', async () => {
    const controller = new AbortController();
    let failures = 0;
    const result = await superviseCommitmentIntake({
      maxItems: 1,
      intervalMs: 1,
      drain: () => {
        failures += 1;
        if (failures >= 10) controller.abort();
        throw busyError();
      },
      sleep: async () => sleepSync(1),
      log: () => {},
      signal: controller.signal,
      failureLimit: 0,
    });

    assert.equal(result.stopReason, 'aborted');
    assert.equal(failures, 10);
  });
});

describe('response-stream delivery loop fail-closed (issue #54)', () => {
  it('stops after the consecutive-failure limit', async () => {
    let drains = 0;
    const logger = { log: () => {}, error: () => {} };
    const result = await runAssistantResponseDeliveryLoop({
      worker: { drainOnce: async () => { drains += 1; throw busyError(); } },
      pollMs: 1,
      shouldContinue: () => true,
      failureLimit: 3,
      logger,
    });

    assert.equal(result.stopReason, 'consecutive_failures');
    assert.equal(result.consecutiveFailures, 3);
    assert.equal(drains, 3);
  });

  it('reports first success exactly once and resets the failure counter', async () => {
    let drains = 0;
    let firstSuccessCalls = 0;
    const logged = [];
    const result = await runAssistantResponseDeliveryLoop({
      worker: {
        drainOnce: async () => {
          drains += 1;
          if (drains === 1) throw busyError();
          if (drains >= 3) return { claimed: 1, expired: 0 };
          return { claimed: 0, expired: 0 };
        },
      },
      pollMs: 1,
      shouldContinue: () => drains < 3,
      failureLimit: 5,
      logger: { log: (line) => logged.push(line), error: () => {} },
      onFirstSuccess: () => { firstSuccessCalls += 1; },
    });

    assert.equal(result.stopReason, 'stopped');
    assert.equal(firstSuccessCalls, 1);
    assert.equal(logged.length, 1);
  });
});

describe('health markers (issue #54)', () => {
  it('writes an ok marker with the current pid', () => {
    const name = `test-worker-${process.pid}`;
    const markerPath = writeHealthMarker(name);
    assert.equal(markerPath, healthMarkerPath(name));
    const payload = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
    assert.equal(payload.ok, true);
    assert.equal(payload.pid, process.pid);
    assert.ok(typeof payload.at === 'string');
    fs.rmSync(markerPath, { force: true });
  });

  it('rejects unsafe marker names', () => {
    assert.throws(() => healthMarkerPath('../escape'), TypeError);
    assert.throws(() => healthMarkerPath('a/b'), TypeError);
  });

  it('lands inside the isolated health directory', () => {
    const markerPath = healthMarkerPath('probe');
    const expectedRoot = path.join(process.env.ZYLOS_DIR || path.join(os.homedir(), 'zylos'), '.zylos', 'health');
    assert.equal(path.dirname(markerPath), expectedRoot);
  });
});
