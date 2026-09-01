import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import Database from 'better-sqlite3';

import {
  canonicalRunEventFailure as canonicalEventFailure,
  canonicalRunEventLinkFailure,
  canonicalRunPersistenceFailure,
} from './canonical-run-event.js';
import {
  canonicalReplyIntentFailure,
  canonicalReplyOutcomeFailure,
} from './canonical-reply-records.js';
import { DB_PATH } from './c4-config.js';
import { ensureAssistantReplyReliabilitySchema } from './c4-db.js';

const BOOTSTRAP_MODE = 'canonical_cutover';
const TERMINAL_EVENT_TYPES = new Set(['RunCompleted', 'RunFailed', 'RunCancelled']);

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

function requireRecord(value, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${field} must be an object`);
  }
  return value;
}

function assertAllowedKeys(value, allowed, field) {
  const unknown = Object.keys(value).filter(key => !allowed.includes(key));
  if (unknown.length > 0) {
    throw domainError(
      'NONCANONICAL_V1_SHAPE',
      `${field} contains unknown v1 fields: ${unknown.sort().join(', ')}`,
    );
  }
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

function toStream(row, consumerId, requestId) {
  return row ? {
    consumerId: row.consumer_id,
    requestId: row.request_id,
    status: row.health_status,
    degradedReason: row.degraded_reason,
    degradedEventRowId: row.degraded_event_row_id,
  } : {
    consumerId,
    requestId,
    status: 'active',
    degradedReason: null,
    degradedEventRowId: null,
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
  const selectStreamHealth = database.prepare(`
    SELECT * FROM assistant_event_stream_health
    WHERE consumer_id = ? AND request_id = ?
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
    SELECT outcome_id, request_id, turn_id, generation, trace_id, kind,
           envelope_json, canonical_hash
    FROM assistant_reply_outcomes
    WHERE outcome_id = ?
  `);
  const selectIntentByCause = database.prepare(`
    SELECT * FROM assistant_reply_intents
    WHERE cause_kind = 'run_terminal' AND cause_event_id = ?
    ORDER BY created_at ASC, intent_id ASC LIMIT 1
  `);
  const selectRunFacts = database.prepare(`
    SELECT * FROM assistant_run_ledger WHERE request_id = ?
  `);
  const selectRequestFacts = database.prepare(`
    SELECT request_id, status, runtime_session_id, next_sequence
    FROM assistant_requests WHERE request_id = ?
  `);
  const selectAdmissionFacts = database.prepare(`
    SELECT request_id, turn_id, generation, runtime_lane_id, runtime_session_id, status
    FROM runtime_turn_admissions
    WHERE request_id = ? AND turn_id = ? AND generation = ?
    ORDER BY id DESC LIMIT 1
  `);
  const selectRunChain = database.prepare(`${eventProjection} WHERE request_id = ? ORDER BY sequence ASC`);
  const selectConfirmedCancellation = database.prepare(`
    SELECT command_id, causation_id, confirmation_causation_id, status
    FROM assistant_cancel_requests
    WHERE request_id = ? AND turn_id = ? AND generation = ? AND status = 'confirmed'
    ORDER BY requested_at DESC LIMIT 1
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

  function degrade(consumerId, requestId, reason, eventRowId, current) {
    database.prepare(`
      INSERT INTO assistant_event_stream_health (
        consumer_id, request_id, health_status, degraded_reason,
        degraded_event_row_id, created_at, updated_at
      ) VALUES (?, ?, 'degraded', ?, ?, ?, ?)
      ON CONFLICT(consumer_id, request_id) DO UPDATE SET
        health_status = 'degraded',
        degraded_reason = COALESCE(assistant_event_stream_health.degraded_reason, excluded.degraded_reason),
        degraded_event_row_id = COALESCE(
          assistant_event_stream_health.degraded_event_row_id,
          excluded.degraded_event_row_id
        ),
        updated_at = excluded.updated_at
    `).run(consumerId, requestId, reason, eventRowId ?? null, current, current);
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
    if (
      consumer.health_status === 'degraded'
      && consumer.degraded_reason === 'LEGACY_SUBSCRIPTION_STATE_UNPROVEN'
    ) return consumer;

    const postCutoverRows = database.prepare(`
      ${eventProjection}
      WHERE id > ?
      ORDER BY id ASC
    `).all(consumer.cutover_event_row_id);
    for (const event of postCutoverRows) {
      const failure = canonicalEventFailure(event);
      if (failure) {
        degrade(consumerId, event.request_id, failure, event.id, current);
      }
    }

    const canonicalRows = database.prepare(`
      ${eventProjection}
      WHERE id >= ? AND event_id IS NOT NULL
      ORDER BY id ASC
    `).all(consumer.start_event_row_id);
    const validatedRequests = new Set();
    for (const event of canonicalRows) {
      if (selectStreamHealth.get(consumerId, event.request_id)?.health_status === 'degraded') {
        continue;
      }
      const failure = canonicalEventFailure(event);
      if (failure) {
        degrade(consumerId, event.request_id, failure, event.id, current);
        continue;
      }
      if (event.sequence > 1) {
        const predecessor = selectEventBySequence.get(event.request_id, event.sequence - 1);
        if (!predecessor) {
          degrade(consumerId, event.request_id, 'CANONICAL_SEQUENCE_GAP', event.id, current);
          continue;
        }
        const predecessorFailure = canonicalEventFailure(predecessor);
        if (predecessorFailure) {
          degrade(
            consumerId,
            event.request_id,
            'NONCANONICAL_SEQUENCE_PREDECESSOR',
            predecessor.id,
            current,
          );
          continue;
        }
        const linkFailure = canonicalRunEventLinkFailure(event, predecessor);
        if (linkFailure) {
          degrade(consumerId, event.request_id, linkFailure, event.id, current);
          continue;
        }
      }
      if (TERMINAL_EVENT_TYPES.has(event.event_type)) {
        if (selectLaterEvent.get(event.request_id, event.sequence)) {
          degrade(consumerId, event.request_id, 'EVENT_AFTER_TERMINAL', event.id, current);
          continue;
        }
        if (event.event_type === 'RunCancelled') {
          const payload = JSON.parse(event.payload_json);
          const cancellation = selectConfirmedCancellation.get(
            event.request_id,
            event.turn_id,
            event.generation,
          );
          if (
            !cancellation
            || (payload.mode === 'queued' && event.causation_id !== cancellation.command_id)
            || (payload.mode === 'active'
              && event.causation_id !== cancellation.confirmation_causation_id)
          ) {
            degrade(consumerId, event.request_id, 'RUN_CANCEL_CAUSE_NOT_FOUND', event.id, current);
            continue;
          }
        } else {
          const payload = JSON.parse(event.payload_json);
          const outcome = selectOutcome.get(payload.outcomeId);
          const expectedKind = event.event_type === 'RunFailed' ? 'failure' : null;
          const outcomeFailure = outcome ? canonicalReplyOutcomeFailure(outcome) : null;
          if (
            !outcome
            || outcome.request_id !== event.request_id
            || outcome.turn_id !== event.turn_id
            || outcome.generation !== event.generation
            || outcome.trace_id !== event.trace_id
            || (expectedKind ? outcome.kind !== expectedKind : outcome.kind === 'failure')
          ) {
            degrade(consumerId, event.request_id, 'TERMINAL_OUTCOME_NOT_FOUND', event.id, current);
            continue;
          }
          if (outcomeFailure) {
            degrade(consumerId, event.request_id, outcomeFailure, event.id, current);
            continue;
          }
          const intent = selectIntentByCause.get(event.event_id);
          if (outcome.kind === 'silent') {
            if (intent) {
              degrade(consumerId, event.request_id, 'SILENT_TERMINAL_HAS_INTENT', event.id, current);
              continue;
            }
          } else {
            const intentFailure = intent ? canonicalReplyIntentFailure(intent) : null;
            if (!intent || intent.request_id !== event.request_id || intent.trace_id !== event.trace_id) {
              degrade(consumerId, event.request_id, 'TERMINAL_INTENT_NOT_FOUND', event.id, current);
              continue;
            }
            if (intentFailure) {
              degrade(consumerId, event.request_id, intentFailure, event.id, current);
              continue;
            }
          }
        }
      }
      if (!validatedRequests.has(event.request_id)) {
        const chain = selectRunChain.all(event.request_id);
        if (chain.at(-1)?.id === event.id) {
          const run = selectRunFacts.get(event.request_id);
          const request = selectRequestFacts.get(event.request_id);
          const persistenceFailure = canonicalRunPersistenceFailure({
            rows: chain,
            run,
            request,
            admission: run
              ? selectAdmissionFacts.get(event.request_id, run.turn_id, run.generation)
              : null,
          });
          if (persistenceFailure) {
            degrade(consumerId, event.request_id, persistenceFailure, event.id, current);
            continue;
          }
          validatedRequests.add(event.request_id);
        }
      }
      const fingerprint = eventFingerprint(event);
      const delivery = selectDeliveryFingerprint.get(consumerId, event.id);
      if (!delivery) {
        insertDelivery.run(consumerId, event.id, current, current, current, fingerprint);
      } else if (!delivery.event_fingerprint) {
        degrade(consumerId, event.request_id, 'EVENT_FINGERPRINT_MISSING', event.id, current);
        continue;
      } else if (delivery.event_fingerprint !== fingerprint) {
        degrade(consumerId, event.request_id, 'CANONICAL_EVENT_MUTATED', event.id, current);
        continue;
      }
    }
    consumer = selectConsumer.get(consumerId);
    return consumer;
  }

  function requireActiveConsumer(consumerId, current) {
    const consumer = materializeAndValidate(consumerId, current);
    if (
      consumer.health_status !== 'active'
      && consumer.degraded_reason === 'LEGACY_SUBSCRIPTION_STATE_UNPROVEN'
    ) {
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

  function requireActiveStream(consumerId, requestId) {
    const stream = selectStreamHealth.get(consumerId, requestId);
    if (stream?.health_status === 'degraded') {
      throw domainError(
        'EVENT_STREAM_DEGRADED',
        `event stream is degraded: ${stream.degraded_reason}`,
        {
          degradedReason: stream.degraded_reason,
          degradedEventRowId: stream.degraded_event_row_id,
          requestId,
        },
      );
    }
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
      FROM assistant_event_deliveries AS d
      JOIN assistant_response_events AS e ON e.id = d.event_row_id
      WHERE d.consumer_id = ? AND d.status = 'processing' AND d.lease_expires_at > ?
        AND NOT EXISTS (
          SELECT 1 FROM assistant_event_stream_health AS stream
          WHERE stream.consumer_id = d.consumer_id
            AND stream.request_id = e.request_id
            AND stream.health_status = 'degraded'
        )
    `).get(safeConsumerId, current).count;
    if (activeCount >= maxInFlightPerConsumer) return null;

    const candidate = database.prepare(`
      ${deliveryProjection}
      WHERE d.consumer_id = ? AND d.status = 'pending' AND d.available_at <= ?
        AND NOT EXISTS (
          SELECT 1 FROM assistant_event_stream_health AS stream
          WHERE stream.consumer_id = d.consumer_id
            AND stream.request_id = e.request_id
            AND stream.health_status = 'degraded'
        )
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
    if (!candidate) {
      const degraded = database.prepare(`
        SELECT * FROM assistant_event_stream_health
        WHERE consumer_id = ? AND health_status = 'degraded'
        ORDER BY degraded_event_row_id ASC, request_id ASC LIMIT 1
      `).get(safeConsumerId);
      if (degraded) {
        throw domainError(
          'EVENT_SUBSCRIPTION_DEGRADED',
          `only degraded event streams remain: ${degraded.degraded_reason}`,
          {
            degradedReason: degraded.degraded_reason,
            degradedEventRowId: degraded.degraded_event_row_id,
            requestId: degraded.request_id,
          },
        );
      }
      return null;
    }
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
    requireActiveStream(safeConsumerId, row.request_id);
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
    requireActiveStream(safeConsumerId, row.request_id);
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

  const getStreamTransaction = database.transaction(({ consumerId, requestId }) => {
    const safeConsumerId = requireText(consumerId, 'consumerId');
    const safeRequestId = requireText(requestId, 'requestId');
    materializeAndValidate(safeConsumerId, currentTime(clock));
    return toStream(
      selectStreamHealth.get(safeConsumerId, safeRequestId),
      safeConsumerId,
      safeRequestId,
    );
  });

  return Object.freeze({
    subscribe(input = {}) {
      const command = requireRecord(input, 'subscribe input');
      assertAllowedKeys(command, ['consumerId', 'bootstrap'], 'subscribe input');
      return subscribeTransaction.immediate(command);
    },
    claimNext(input = {}) {
      const command = requireRecord(input, 'claimNext input');
      assertAllowedKeys(command, ['consumerId', 'ownerId', 'leaseSeconds'], 'claimNext input');
      const { consumerId, ownerId, leaseSeconds = 30 } = command;
      return claimTransaction.immediate({ consumerId, ownerId, leaseSeconds });
    },
    ack(input = {}) {
      const command = requireRecord(input, 'ack input');
      assertAllowedKeys(
        command,
        ['consumerId', 'eventId', 'claimEpoch', 'leaseToken'],
        'ack input',
      );
      return ackTransaction.immediate(command);
    },
    fail(input = {}) {
      const command = requireRecord(input, 'fail input');
      assertAllowedKeys(
        command,
        ['consumerId', 'eventId', 'claimEpoch', 'leaseToken', 'error', 'retryDelaySeconds'],
        'fail input',
      );
      const { retryDelaySeconds = 0, ...rest } = command;
      return failTransaction.immediate({ ...rest, retryDelaySeconds });
    },
    getState(input = {}) {
      const command = requireRecord(input, 'getState input');
      assertAllowedKeys(command, ['consumerId', 'eventId'], 'getState input');
      const { consumerId, eventId } = command;
      return toState(selectState.get(
        requireText(consumerId, 'consumerId'),
        requireText(eventId, 'eventId'),
      ));
    },
    getConsumer(input = {}) {
      const command = requireRecord(input, 'getConsumer input');
      assertAllowedKeys(command, ['consumerId'], 'getConsumer input');
      return getConsumerTransaction.immediate(command);
    },
    getStream(input = {}) {
      const command = requireRecord(input, 'getStream input');
      assertAllowedKeys(command, ['consumerId', 'requestId'], 'getStream input');
      return getStreamTransaction.immediate(command);
    },
    close() {
      database.close();
    },
  });
}
