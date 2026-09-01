import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import Database from 'better-sqlite3';

import { DB_PATH } from './c4-config.js';
import { ensureAssistantReplyReliabilitySchema } from './c4-db.js';

function domainError(code, message) {
  const error = new Error(message);
  error.code = code;
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
    availableAt: row.available_at,
    leaseOwner: row.lease_owner,
    leaseToken: row.lease_token,
    leaseExpiresAt: row.lease_expires_at,
    lastError: row.last_error,
    acknowledgedAt: row.acknowledged_at,
  };
}

export function openEventSubscriptions({
  dbPath = DB_PATH,
  clock = () => Math.floor(Date.now() / 1_000),
  leaseTokenFactory = () => `event-lease:${randomUUID()}`,
} = {}) {
  const normalizedPath = requireText(dbPath, 'dbPath');
  if (typeof clock !== 'function') throw new TypeError('clock must be a function');
  if (typeof leaseTokenFactory !== 'function') {
    throw new TypeError('leaseTokenFactory must be a function');
  }
  if (normalizedPath !== ':memory:') fs.mkdirSync(path.dirname(normalizedPath), { recursive: true });
  const database = new Database(normalizedPath);
  database.pragma('journal_mode = WAL');
  database.pragma('busy_timeout = 5000');
  database.pragma('foreign_keys = ON');
  ensureAssistantReplyReliabilitySchema(database);

  const projection = `
    SELECT d.*, e.event_id, e.request_id, e.sequence, e.event_type,
           e.payload_json, e.idempotency_key, e.turn_id, e.generation,
           e.trace_id, e.causation_id, e.producer, e.created_at AS event_created_at
    FROM assistant_event_deliveries AS d
    JOIN assistant_response_events AS e ON e.id = d.event_row_id
  `;
  const selectState = database.prepare(`
    ${projection} WHERE d.consumer_id = ? AND e.event_id = ?
  `);
  const selectByRow = database.prepare(`
    ${projection} WHERE d.consumer_id = ? AND d.event_row_id = ?
  `);

  function materialize(consumerId, current) {
    database.prepare(`
      INSERT OR IGNORE INTO assistant_event_deliveries (
        consumer_id, event_row_id, status, retry_count, available_at,
        created_at, updated_at
      )
      SELECT ?, id, 'pending', 0, ?, ?, ?
      FROM assistant_response_events
      WHERE event_id IS NOT NULL
    `).run(consumerId, current, current, current);
  }

  const subscribeTransaction = database.transaction(({ consumerId }) => {
    const safeConsumerId = requireText(consumerId, 'consumerId');
    const current = currentTime(clock);
    const inserted = database.prepare(`
      INSERT OR IGNORE INTO assistant_event_consumers (consumer_id, created_at, updated_at)
      VALUES (?, ?, ?)
    `).run(safeConsumerId, current, current);
    materialize(safeConsumerId, current);
    return { consumerId: safeConsumerId, replayed: inserted.changes === 0 };
  });

  const claimTransaction = database.transaction(({ consumerId, ownerId, leaseSeconds }) => {
    const safeConsumerId = requireText(consumerId, 'consumerId');
    const safeOwnerId = requireText(ownerId, 'ownerId');
    if (!Number.isSafeInteger(leaseSeconds) || leaseSeconds < 1) {
      throw new TypeError('leaseSeconds must be a positive safe integer');
    }
    const current = currentTime(clock);
    if (!database.prepare(`
      SELECT 1 FROM assistant_event_consumers WHERE consumer_id = ?
    `).get(safeConsumerId)) {
      throw domainError('CONSUMER_NOT_FOUND', `unknown event consumer: ${safeConsumerId}`);
    }
    materialize(safeConsumerId, current);
    const active = database.prepare(`
      ${projection}
      WHERE d.consumer_id = ? AND d.status = 'processing'
        AND d.lease_expires_at > ?
      ORDER BY d.event_row_id ASC LIMIT 1
    `).get(safeConsumerId, current);
    if (active && active.lease_owner === safeOwnerId) {
      return {
        replayed: true,
        event: toEvent(active),
        leaseOwner: active.lease_owner,
        leaseToken: active.lease_token,
        leaseExpiresAt: active.lease_expires_at,
      };
    }
    if (active) return null;
    database.prepare(`
      UPDATE assistant_event_deliveries
      SET status = 'pending', lease_owner = NULL, lease_token = NULL,
          lease_expires_at = NULL, updated_at = ?,
          last_error = COALESCE(last_error, 'LEASE_EXPIRED_RECOVERED')
      WHERE consumer_id = ? AND status = 'processing'
        AND lease_expires_at <= ?
    `).run(current, safeConsumerId, current);
    const candidate = database.prepare(`
      ${projection}
      WHERE d.consumer_id = ? AND d.status = 'pending' AND d.available_at <= ?
        AND NOT EXISTS (
          SELECT 1 FROM assistant_event_deliveries AS predecessor
          WHERE predecessor.consumer_id = d.consumer_id
            AND predecessor.event_row_id < d.event_row_id
            AND predecessor.status != 'acknowledged'
        )
      ORDER BY d.event_row_id ASC LIMIT 1
    `).get(safeConsumerId, current);
    if (!candidate) return null;
    const leaseToken = requireText(leaseTokenFactory(candidate), 'generated leaseToken');
    const leaseExpiresAt = current + leaseSeconds;
    const updated = database.prepare(`
      UPDATE assistant_event_deliveries
      SET status = 'processing', lease_owner = ?, lease_token = ?,
          lease_expires_at = ?, updated_at = ?
      WHERE consumer_id = ? AND event_row_id = ? AND status = 'pending'
    `).run(
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
      leaseOwner: claimed.lease_owner,
      leaseToken: claimed.lease_token,
      leaseExpiresAt: claimed.lease_expires_at,
    };
  });

  const ackTransaction = database.transaction(({ consumerId, eventId, leaseToken }) => {
    const safeConsumerId = requireText(consumerId, 'consumerId');
    const safeEventId = requireText(eventId, 'eventId');
    const safeLeaseToken = requireText(leaseToken, 'leaseToken');
    const row = selectState.get(safeConsumerId, safeEventId);
    if (!row) throw domainError('EVENT_DELIVERY_NOT_FOUND', 'consumer event delivery does not exist');
    if (row.status === 'acknowledged') {
      if (row.lease_token !== safeLeaseToken) {
        throw domainError('LEASE_FENCED', 'ACK lease does not own this event delivery');
      }
      return { replayed: true, state: toState(row) };
    }
    if (row.lease_token !== safeLeaseToken) {
      throw domainError('LEASE_FENCED', 'ACK lease does not own this event delivery');
    }
    const current = currentTime(clock);
    if (row.lease_expires_at <= current) {
      throw domainError('LEASE_EXPIRED', 'ACK lease has expired');
    }
    const updated = database.prepare(`
      UPDATE assistant_event_deliveries
      SET status = 'acknowledged', acknowledged_at = ?, updated_at = ?, last_error = NULL
      WHERE consumer_id = ? AND event_row_id = ? AND status = 'processing'
        AND lease_token = ? AND lease_expires_at > ?
    `).run(
      current,
      current,
      safeConsumerId,
      row.event_row_id,
      safeLeaseToken,
      current,
    );
    if (updated.changes !== 1) throw domainError('LEASE_CONFLICT', 'ACK lost its lease fence');
    return { replayed: false, state: toState(selectState.get(safeConsumerId, safeEventId)) };
  });

  const failTransaction = database.transaction(({
    consumerId,
    eventId,
    leaseToken,
    error,
    retryDelaySeconds,
  }) => {
    const safeConsumerId = requireText(consumerId, 'consumerId');
    const safeEventId = requireText(eventId, 'eventId');
    const safeLeaseToken = requireText(leaseToken, 'leaseToken');
    const safeError = requireText(error, 'error');
    if (!Number.isSafeInteger(retryDelaySeconds) || retryDelaySeconds < 0) {
      throw new TypeError('retryDelaySeconds must be a non-negative safe integer');
    }
    const row = selectState.get(safeConsumerId, safeEventId);
    if (!row) throw domainError('EVENT_DELIVERY_NOT_FOUND', 'consumer event delivery does not exist');
    if (row.lease_token !== safeLeaseToken) {
      throw domainError('LEASE_FENCED', 'failure lease does not own this event delivery');
    }
    const current = currentTime(clock);
    if (row.status !== 'processing' || row.lease_expires_at <= current) {
      throw domainError('LEASE_EXPIRED', 'failure lease is no longer active');
    }
    database.prepare(`
      UPDATE assistant_event_deliveries
      SET status = 'pending', retry_count = retry_count + 1,
          available_at = ?, lease_owner = NULL, lease_token = NULL,
          lease_expires_at = NULL, last_error = ?, updated_at = ?
      WHERE consumer_id = ? AND event_row_id = ? AND lease_token = ?
    `).run(
      current + retryDelaySeconds,
      safeError,
      current,
      safeConsumerId,
      row.event_row_id,
      safeLeaseToken,
    );
    return toState(selectState.get(safeConsumerId, safeEventId));
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
    close() {
      database.close();
    },
  });
}
