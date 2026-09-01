import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import Database from 'better-sqlite3';

import { DB_PATH } from './c4-config.js';
import { ensureAssistantReplyReliabilitySchema } from './c4-db.js';

const BOOTSTRAP_MODE = 'canonical_cutover';
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
const EVENT_PRODUCERS = Object.freeze({
  RunAccepted: new Set(['core:message-intake']),
  RunQueued: new Set(['core:runtime-pending-queue']),
  RunStarted: new Set(['core:runtime-lane']),
  ProgressUpdated: new Set(['runtime:shared']),
  OutputDelta: new Set(['runtime:shared']),
  RunCompleted: new Set(['runtime:shared']),
  RunFailed: new Set(['runtime:shared']),
  RunCancelled: new Set(['core:runtime-lane', 'runtime:shared']),
});

function domainError(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  Object.assign(error, details);
  return error;
}

function requireText(value, field, maxLength = 8_192) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`${field} must be a non-empty string`);
  }
  if (Array.from(value).length > maxLength) {
    throw new TypeError(`${field} exceeds ${maxLength} characters`);
  }
  return value;
}

function currentTime(clock) {
  const current = clock();
  if (!Number.isSafeInteger(current) || current < 0) {
    throw new TypeError('clock must return a non-negative safe integer');
  }
  return current;
}

function requireClaimEpoch(value) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError('claimEpoch must be a positive safe integer');
  }
  return value;
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => (
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`
    )).join(',')}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function canonicalEventFailure(row) {
  for (const field of [
    'event_id',
    'request_id',
    'event_type',
    'idempotency_key',
    'turn_id',
    'trace_id',
    'causation_id',
    'producer',
  ]) {
    if (typeof row[field] !== 'string' || row[field].trim() === '') {
      return `NONCANONICAL_${field.toUpperCase()}`;
    }
  }
  if (!Number.isSafeInteger(row.sequence) || row.sequence < 1) {
    return 'NONCANONICAL_SEQUENCE';
  }
  if (!Number.isSafeInteger(row.generation) || row.generation < 1) {
    return 'NONCANONICAL_GENERATION';
  }
  if (!Number.isSafeInteger(row.created_at) || row.created_at < 0) {
    return 'NONCANONICAL_CREATED_AT';
  }
  if (row.event_id !== `evt:${row.request_id}:${row.sequence}`) {
    return 'NONCANONICAL_EVENT_ID';
  }
  if (!RUN_EVENT_TYPES.has(row.event_type)) {
    return 'NONCANONICAL_EVENT_TYPE';
  }
  if (!EVENT_PRODUCERS[row.event_type].has(row.producer)) {
    return 'NONCANONICAL_PRODUCER';
  }
  if (
    (row.sequence === 1 && row.event_type !== 'RunAccepted')
    || (row.sequence !== 1 && row.event_type === 'RunAccepted')
  ) {
    return 'NONCANONICAL_ACCEPT_SEQUENCE';
  }
  let payload;
  try {
    payload = JSON.parse(row.payload_json);
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      return 'NONCANONICAL_PAYLOAD';
    }
  } catch {
    return 'NONCANONICAL_PAYLOAD';
  }
  if (
    ['RunQueued', 'RunStarted'].includes(row.event_type)
    && payload.runtimeLaneId !== 'runtime:shared'
  ) {
    return 'NONCANONICAL_RUNTIME_LANE';
  }
  if (
    row.event_type === 'RunStarted'
    && (typeof payload.runtimeSessionId !== 'string' || payload.runtimeSessionId.trim() === '')
  ) {
    return 'NONCANONICAL_RUNTIME_SESSION';
  }
  if (['RunCompleted', 'RunFailed'].includes(row.event_type)) {
    if (typeof payload.outcomeId !== 'string' || payload.outcomeId.trim() === '') {
      return 'TERMINAL_OUTCOME_ID_REQUIRED';
    }
    if (payload.outcomeId !== `outcome:${row.request_id}`) {
      return 'TERMINAL_OUTCOME_ID_MISMATCH';
    }
    for (const field of ['text', 'content', 'output', 'outputText']) {
      if (Object.hasOwn(payload, field)) return 'NONCANONICAL_TERMINAL_PAYLOAD';
    }
  }
  if (
    row.event_type === 'RunFailed'
    && (
      typeof payload.code !== 'string'
      || payload.code.trim() === ''
      || typeof payload.retryable !== 'boolean'
    )
  ) {
    return 'NONCANONICAL_FAILED_PAYLOAD';
  }
  if (
    row.event_type === 'RunCancelled'
    && (Object.hasOwn(payload, 'outcomeId') || Object.hasOwn(payload, 'outcome'))
  ) {
    return 'NONCANONICAL_CANCELLED_PAYLOAD';
  }
  if (
    row.event_type === 'RunCompleted'
    && row.idempotency_key !== `run:${row.request_id}:completed`
  ) {
    return 'NONCANONICAL_TERMINAL_IDEMPOTENCY';
  }
  if (
    row.event_type === 'RunFailed'
    && row.idempotency_key !== `run:${row.request_id}:failed`
  ) {
    return 'NONCANONICAL_TERMINAL_IDEMPOTENCY';
  }
  return null;
}

function eventFingerprint(row) {
  return sha256(canonicalJson({
    eventId: row.event_id,
    requestId: row.request_id,
    sequence: row.sequence,
    type: row.event_type,
    payload: JSON.parse(row.payload_json),
    idempotencyKey: row.idempotency_key,
    turnId: row.turn_id,
    generation: row.generation,
    traceId: row.trace_id,
    causationId: row.causation_id,
    producer: row.producer,
    createdAt: row.created_at,
  }));
}

function toEvent(row) {
  return row && {
    schemaVersion: 1,
    type: row.event_type,
    eventId: row.event_id,
    idempotencyKey: row.idempotency_key,
    requestId: row.request_id,
    turnId: row.turn_id,
    generation: row.generation,
    sequence: row.sequence,
    traceId: row.trace_id,
    causationId: row.causation_id,
    producer: row.producer,
    payload: JSON.parse(row.payload_json),
    createdAt: row.event_created_at,
  };
}

function toState(row) {
  return row && {
    consumerId: row.consumer_id,
    eventId: row.event_id,
    status: row.status,
    retryCount: row.retry_count,
    claimEpoch: row.claim_epoch,
    availableAt: row.available_at,
    leaseOwner: row.lease_owner,
    leaseToken: row.lease_token,
    leaseExpiresAt: row.lease_expires_at,
    lastError: row.last_error,
    acknowledgedAt: row.acknowledged_at,
  };
}

function toConsumer(row) {
  return row && {
    consumerId: row.consumer_id,
    bootstrap: row.bootstrap_mode,
    startEventRowId: row.start_event_row_id,
    cutoverEventRowId: row.cutover_event_row_id,
    legacySkippedCount: row.legacy_skipped_count,
    status: row.health_status,
    degradedReason: row.degraded_reason,
    degradedEventRowId: row.degraded_event_row_id,
  };
}

export function openEventSubscriptions({
  dbPath = DB_PATH,
  clock = () => Math.floor(Date.now() / 1_000),
  leaseTokenFactory = () => `event-lease:${randomUUID()}`,
  maxInFlightPerConsumer = 4,
} = {}) {
  const normalizedPath = requireText(dbPath, 'dbPath');
  if (typeof clock !== 'function') throw new TypeError('clock must be a function');
  if (typeof leaseTokenFactory !== 'function') {
    throw new TypeError('leaseTokenFactory must be a function');
  }
  if (!Number.isSafeInteger(maxInFlightPerConsumer) || maxInFlightPerConsumer < 1) {
    throw new TypeError('maxInFlightPerConsumer must be a positive safe integer');
  }
  if (normalizedPath !== ':memory:') fs.mkdirSync(path.dirname(normalizedPath), { recursive: true });
  const database = new Database(normalizedPath);
  database.pragma('journal_mode = WAL');
  database.pragma('busy_timeout = 5000');
  database.pragma('foreign_keys = ON');
  ensureAssistantReplyReliabilitySchema(database);

  const eventProjection = `
    SELECT id, event_id, request_id, sequence, event_type, payload_json,
           idempotency_key, turn_id, generation, trace_id, causation_id,
           producer, created_at
    FROM assistant_response_events
  `;
  const deliveryProjection = `
    SELECT d.*, e.event_id, e.request_id, e.sequence, e.event_type,
           e.payload_json, e.idempotency_key, e.turn_id, e.generation,
           e.trace_id, e.causation_id, e.producer, e.created_at AS event_created_at
    FROM assistant_event_deliveries AS d
    JOIN assistant_response_events AS e ON e.id = d.event_row_id
  `;
  const selectConsumer = database.prepare(`
    SELECT * FROM assistant_event_consumers WHERE consumer_id = ?
  `);
  const selectState = database.prepare(`
    ${deliveryProjection} WHERE d.consumer_id = ? AND e.event_id = ?
  `);
  const selectByRow = database.prepare(`
    ${deliveryProjection} WHERE d.consumer_id = ? AND d.event_row_id = ?
  `);
  const selectEventBySequence = database.prepare(`
    ${eventProjection} WHERE request_id = ? AND sequence = ?
  `);
  const selectLaterEvent = database.prepare(`
    ${eventProjection}
    WHERE request_id = ? AND sequence > ?
    ORDER BY sequence ASC LIMIT 1
  `);
  const selectOutcome = database.prepare(`
    SELECT outcome_id, request_id, turn_id, generation, trace_id, kind
    FROM assistant_reply_outcomes
    WHERE outcome_id = ?
  `);
  const selectDeliveryFingerprint = database.prepare(`
    SELECT event_fingerprint
    FROM assistant_event_deliveries
    WHERE consumer_id = ? AND event_row_id = ?
  `);
  const insertDelivery = database.prepare(`
    INSERT INTO assistant_event_deliveries (
      consumer_id, event_row_id, status, retry_count, available_at,
      created_at, updated_at, event_fingerprint
    ) VALUES (?, ?, 'pending', 0, ?, ?, ?, ?)
  `);

  function degrade(consumerId, reason, eventRowId, current) {
    database.prepare(`
      UPDATE assistant_event_consumers
      SET health_status = 'degraded', degraded_reason = ?,
          degraded_event_row_id = ?, updated_at = ?
      WHERE consumer_id = ? AND health_status = 'active'
    `).run(reason, eventRowId ?? null, current, consumerId);
  }

  function materializeAndValidate(consumerId, current) {
    let consumer = selectConsumer.get(consumerId);
    if (!consumer) {
      throw domainError('CONSUMER_NOT_FOUND', `unknown event consumer: ${consumerId}`);
    }
    if (consumer.health_status === 'degraded') return consumer;

    const postCutoverRows = database.prepare(`
      ${eventProjection}
      WHERE id > ?
      ORDER BY id ASC
    `).all(consumer.cutover_event_row_id);
    for (const event of postCutoverRows) {
      const failure = canonicalEventFailure(event);
      if (failure) {
        degrade(consumerId, failure, event.id, current);
        return selectConsumer.get(consumerId);
      }
    }

    const canonicalRows = database.prepare(`
      ${eventProjection}
      WHERE id >= ? AND event_id IS NOT NULL
      ORDER BY id ASC
    `).all(consumer.start_event_row_id);
    for (const event of canonicalRows) {
      const failure = canonicalEventFailure(event);
      if (failure) {
        degrade(consumerId, failure, event.id, current);
        return selectConsumer.get(consumerId);
      }
      if (event.sequence > 1) {
        const predecessor = selectEventBySequence.get(event.request_id, event.sequence - 1);
        if (!predecessor) {
          degrade(consumerId, 'CANONICAL_SEQUENCE_GAP', event.id, current);
          return selectConsumer.get(consumerId);
        }
        const predecessorFailure = canonicalEventFailure(predecessor);
        if (predecessorFailure) {
          degrade(consumerId, 'NONCANONICAL_SEQUENCE_PREDECESSOR', predecessor.id, current);
          return selectConsumer.get(consumerId);
        }
        if (
          event.event_type !== 'RunCancelled'
          && event.causation_id !== predecessor.event_id
        ) {
          degrade(consumerId, 'NONCANONICAL_CAUSATION_CHAIN', event.id, current);
          return selectConsumer.get(consumerId);
        }
      }
      if (TERMINAL_EVENT_TYPES.has(event.event_type)) {
        if (selectLaterEvent.get(event.request_id, event.sequence)) {
          degrade(consumerId, 'EVENT_AFTER_TERMINAL', event.id, current);
          return selectConsumer.get(consumerId);
        }
        if (event.event_type !== 'RunCancelled') {
          const payload = JSON.parse(event.payload_json);
          const outcome = selectOutcome.get(payload.outcomeId);
          const expectedKind = event.event_type === 'RunFailed' ? 'failure' : null;
          if (
            !outcome
            || outcome.request_id !== event.request_id
            || outcome.turn_id !== event.turn_id
            || outcome.generation !== event.generation
            || outcome.trace_id !== event.trace_id
            || (expectedKind ? outcome.kind !== expectedKind : outcome.kind === 'failure')
          ) {
            degrade(consumerId, 'TERMINAL_OUTCOME_NOT_FOUND', event.id, current);
            return selectConsumer.get(consumerId);
          }
        }
      }
      const fingerprint = eventFingerprint(event);
      const delivery = selectDeliveryFingerprint.get(consumerId, event.id);
      if (!delivery) {
        insertDelivery.run(consumerId, event.id, current, current, current, fingerprint);
      } else if (!delivery.event_fingerprint) {
        degrade(consumerId, 'EVENT_FINGERPRINT_MISSING', event.id, current);
        return selectConsumer.get(consumerId);
      } else if (delivery.event_fingerprint !== fingerprint) {
        degrade(consumerId, 'CANONICAL_EVENT_MUTATED', event.id, current);
        return selectConsumer.get(consumerId);
      }
    }
    consumer = selectConsumer.get(consumerId);
    return consumer;
  }

  function requireActiveConsumer(consumerId, current) {
    const consumer = materializeAndValidate(consumerId, current);
    if (consumer.health_status !== 'active') {
      throw domainError(
        'EVENT_SUBSCRIPTION_DEGRADED',
        `event subscription is degraded: ${consumer.degraded_reason}`,
        {
          degradedReason: consumer.degraded_reason,
          degradedEventRowId: consumer.degraded_event_row_id,
        },
      );
    }
    return consumer;
  }

  const subscribeTransaction = database.transaction(({ consumerId, bootstrap }) => {
    const safeConsumerId = requireText(consumerId, 'consumerId');
    if (bootstrap !== BOOTSTRAP_MODE) {
      throw new TypeError(`bootstrap must be ${BOOTSTRAP_MODE}`);
    }
    const current = currentTime(clock);
    let consumer = selectConsumer.get(safeConsumerId);
    if (consumer) {
      if (consumer.bootstrap_mode !== bootstrap) {
        throw domainError('IDEMPOTENCY_CONFLICT', 'consumer replay changes bootstrap mode');
      }
      consumer = materializeAndValidate(safeConsumerId, current);
      return { ...toConsumer(consumer), replayed: true };
    }
    const cutoverEventRowId = database.prepare(`
      SELECT COALESCE(MAX(id), 0) AS value FROM assistant_response_events
    `).get().value;
    const legacySkippedCount = database.prepare(`
      SELECT COUNT(*) AS count
      FROM assistant_response_events
      WHERE id <= ? AND event_id IS NULL
    `).get(cutoverEventRowId).count;
    database.prepare(`
      INSERT INTO assistant_event_consumers (
        consumer_id, bootstrap_mode, start_event_row_id, cutover_event_row_id,
        legacy_skipped_count, health_status, created_at, updated_at
      ) VALUES (?, ?, 1, ?, ?, 'active', ?, ?)
    `).run(
      safeConsumerId,
      bootstrap,
      cutoverEventRowId,
      legacySkippedCount,
      current,
      current,
    );
    consumer = materializeAndValidate(safeConsumerId, current);
    return { ...toConsumer(consumer), replayed: false };
  });

  const claimTransaction = database.transaction(({ consumerId, ownerId, leaseSeconds }) => {
    const safeConsumerId = requireText(consumerId, 'consumerId');
    const safeOwnerId = requireText(ownerId, 'ownerId');
    if (!Number.isSafeInteger(leaseSeconds) || leaseSeconds < 1) {
      throw new TypeError('leaseSeconds must be a positive safe integer');
    }
    const current = currentTime(clock);
    requireActiveConsumer(safeConsumerId, current);
    database.prepare(`
      UPDATE assistant_event_deliveries
      SET status = 'pending', lease_owner = NULL, lease_token = NULL,
          lease_expires_at = NULL, updated_at = ?,
          last_error = COALESCE(last_error, 'LEASE_EXPIRED_RECOVERED')
      WHERE consumer_id = ? AND status = 'processing'
        AND lease_expires_at <= ?
    `).run(current, safeConsumerId, current);
    const activeCount = database.prepare(`
      SELECT COUNT(*) AS count
      FROM assistant_event_deliveries
      WHERE consumer_id = ? AND status = 'processing' AND lease_expires_at > ?
    `).get(safeConsumerId, current).count;
    if (activeCount >= maxInFlightPerConsumer) return null;

    const candidate = database.prepare(`
      ${deliveryProjection}
      WHERE d.consumer_id = ? AND d.status = 'pending' AND d.available_at <= ?
        AND NOT EXISTS (
          SELECT 1
          FROM assistant_event_deliveries AS predecessor
          JOIN assistant_response_events AS predecessor_event
            ON predecessor_event.id = predecessor.event_row_id
          WHERE predecessor.consumer_id = d.consumer_id
            AND predecessor_event.request_id = e.request_id
            AND predecessor_event.sequence < e.sequence
            AND predecessor.status != 'acknowledged'
        )
      ORDER BY (
        SELECT COALESCE(MAX(stream_delivery.claim_epoch), 0)
        FROM assistant_event_deliveries AS stream_delivery
        JOIN assistant_response_events AS stream_event
          ON stream_event.id = stream_delivery.event_row_id
        WHERE stream_delivery.consumer_id = d.consumer_id
          AND stream_event.request_id = e.request_id
      ) ASC, d.available_at ASC, d.event_row_id ASC
      LIMIT 1
    `).get(safeConsumerId, current);
    if (!candidate) return null;
    const claimEpoch = database.prepare(`
      SELECT COALESCE(MAX(claim_epoch), 0) + 1 AS value
      FROM assistant_event_deliveries
      WHERE consumer_id = ?
    `).get(safeConsumerId).value;
    const leaseToken = requireText(leaseTokenFactory(candidate), 'generated leaseToken');
    const leaseExpiresAt = current + leaseSeconds;
    const updated = database.prepare(`
      UPDATE assistant_event_deliveries
      SET status = 'processing', claim_epoch = ?, lease_owner = ?, lease_token = ?,
          lease_expires_at = ?, updated_at = ?
      WHERE consumer_id = ? AND event_row_id = ? AND status = 'pending'
    `).run(
      claimEpoch,
      safeOwnerId,
      leaseToken,
      leaseExpiresAt,
      current,
      safeConsumerId,
      candidate.event_row_id,
    );
    if (updated.changes !== 1) {
      throw domainError('LEASE_CONFLICT', 'event claim lost its lease fence');
    }
    const claimed = selectByRow.get(safeConsumerId, candidate.event_row_id);
    return {
      replayed: false,
      event: toEvent(claimed),
      claimEpoch: claimed.claim_epoch,
      leaseOwner: claimed.lease_owner,
      leaseToken: claimed.lease_token,
      leaseExpiresAt: claimed.lease_expires_at,
    };
  });

  const ackTransaction = database.transaction(({
    consumerId,
    eventId,
    claimEpoch,
    leaseToken,
  }) => {
    const safeConsumerId = requireText(consumerId, 'consumerId');
    const safeEventId = requireText(eventId, 'eventId');
    const safeClaimEpoch = requireClaimEpoch(claimEpoch);
    const safeLeaseToken = requireText(leaseToken, 'leaseToken');
    const current = currentTime(clock);
    requireActiveConsumer(safeConsumerId, current);
    const row = selectState.get(safeConsumerId, safeEventId);
    if (!row) throw domainError('EVENT_DELIVERY_NOT_FOUND', 'consumer event delivery does not exist');
    if (row.status === 'acknowledged') {
      if (row.claim_epoch !== safeClaimEpoch || row.lease_token !== safeLeaseToken) {
        throw domainError('LEASE_FENCED', 'ACK lease does not own this event delivery');
      }
      return { replayed: true, state: toState(row) };
    }
    if (row.claim_epoch !== safeClaimEpoch || row.lease_token !== safeLeaseToken) {
      throw domainError('LEASE_FENCED', 'ACK lease does not own this event delivery');
    }
    if (row.lease_expires_at <= current) {
      throw domainError('LEASE_EXPIRED', 'ACK lease has expired');
    }
    const updated = database.prepare(`
      UPDATE assistant_event_deliveries
      SET status = 'acknowledged', acknowledged_at = ?, updated_at = ?, last_error = NULL
      WHERE consumer_id = ? AND event_row_id = ? AND status = 'processing'
        AND claim_epoch = ? AND lease_token = ? AND lease_expires_at > ?
    `).run(
      current,
      current,
      safeConsumerId,
      row.event_row_id,
      safeClaimEpoch,
      safeLeaseToken,
      current,
    );
    if (updated.changes !== 1) throw domainError('LEASE_CONFLICT', 'ACK lost its lease fence');
    return { replayed: false, state: toState(selectState.get(safeConsumerId, safeEventId)) };
  });

  const failTransaction = database.transaction(({
    consumerId,
    eventId,
    claimEpoch,
    leaseToken,
    error,
    retryDelaySeconds,
  }) => {
    const safeConsumerId = requireText(consumerId, 'consumerId');
    const safeEventId = requireText(eventId, 'eventId');
    const safeClaimEpoch = requireClaimEpoch(claimEpoch);
    const safeLeaseToken = requireText(leaseToken, 'leaseToken');
    const safeError = requireText(error, 'error');
    if (!Number.isSafeInteger(retryDelaySeconds) || retryDelaySeconds < 0) {
      throw new TypeError('retryDelaySeconds must be a non-negative safe integer');
    }
    const current = currentTime(clock);
    requireActiveConsumer(safeConsumerId, current);
    const row = selectState.get(safeConsumerId, safeEventId);
    if (!row) throw domainError('EVENT_DELIVERY_NOT_FOUND', 'consumer event delivery does not exist');
    if (row.claim_epoch !== safeClaimEpoch || row.lease_token !== safeLeaseToken) {
      throw domainError('LEASE_FENCED', 'failure lease does not own this event delivery');
    }
    if (row.status !== 'processing' || row.lease_expires_at <= current) {
      throw domainError('LEASE_EXPIRED', 'failure lease is no longer active');
    }
    const updated = database.prepare(`
      UPDATE assistant_event_deliveries
      SET status = 'pending', retry_count = retry_count + 1,
          available_at = ?, lease_owner = NULL, lease_token = NULL,
          lease_expires_at = NULL, last_error = ?, updated_at = ?
      WHERE consumer_id = ? AND event_row_id = ?
        AND status = 'processing' AND claim_epoch = ? AND lease_token = ?
    `).run(
      current + retryDelaySeconds,
      safeError,
      current,
      safeConsumerId,
      row.event_row_id,
      safeClaimEpoch,
      safeLeaseToken,
    );
    if (updated.changes !== 1) {
      throw domainError('LEASE_CONFLICT', 'failure update lost its lease fence');
    }
    return toState(selectState.get(safeConsumerId, safeEventId));
  });

  const getConsumerTransaction = database.transaction(({ consumerId }) => {
    const safeConsumerId = requireText(consumerId, 'consumerId');
    const current = currentTime(clock);
    const consumer = materializeAndValidate(safeConsumerId, current);
    return toConsumer(consumer);
  });

  return Object.freeze({
    subscribe(input = {}) {
      return subscribeTransaction.immediate(input);
    },
    claimNext({ consumerId, ownerId, leaseSeconds = 30 } = {}) {
      return claimTransaction.immediate({ consumerId, ownerId, leaseSeconds });
    },
    ack(input = {}) {
      return ackTransaction.immediate(input);
    },
    fail({ retryDelaySeconds = 0, ...input } = {}) {
      return failTransaction.immediate({ ...input, retryDelaySeconds });
    },
    getState({ consumerId, eventId } = {}) {
      return toState(selectState.get(
        requireText(consumerId, 'consumerId'),
        requireText(eventId, 'eventId'),
      ));
    },
    getConsumer(input = {}) {
      return getConsumerTransaction.immediate(input);
    },
    close() {
      database.close();
    },
  });
}
