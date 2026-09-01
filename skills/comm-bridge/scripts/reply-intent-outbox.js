import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import Database from 'better-sqlite3';

import { DB_PATH } from './c4-config.js';
import { ensureAssistantReplyReliabilitySchema } from './c4-db.js';

const RECEIPT_OUTCOMES = new Set(['platform_accepted', 'unknown', 'reconciled', 'rejected']);

function domainError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function requireRecord(value, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${field} must be an object`);
  }
  return value;
}

function requireText(value, field, maxLength = 100_000) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`${field} must be a non-empty string`);
  }
  if (Array.from(value).length > maxLength) {
    throw new TypeError(`${field} exceeds ${maxLength} characters`);
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

function requireAction(value) {
  if (!['send', 'reconcile'].includes(value)) {
    throw new TypeError('action must be send or reconcile');
  }
  return value;
}

function toIntent(row) {
  return row ? JSON.parse(row.envelope_json) : null;
}

function toDelivery(row) {
  return row && {
    intentId: row.intent_id,
    deliveryId: `delivery:${row.intent_id}`,
    state: row.delivery_state,
    attemptCount: row.attempt_count,
    currentAttemptId: row.current_attempt_id,
    claimEpoch: row.claim_epoch,
    availableAt: row.available_at,
    redriveCount: row.redrive_count,
    lastError: row.last_error,
  };
}

function toSettlement(row) {
  return row ? JSON.parse(row.envelope_json) : null;
}

function normalizeReceipt(raw) {
  const receipt = requireRecord(raw, 'DeliveryReceipt');
  if (receipt.schemaVersion !== 1 || receipt.type !== 'DeliveryReceipt') {
    throw new TypeError('receipt must be a DeliveryReceipt v1 envelope');
  }
  const outcome = requireText(receipt.outcome, 'receipt.outcome', 32);
  if (!RECEIPT_OUTCOMES.has(outcome)) {
    throw new TypeError(`unsupported DeliveryReceipt outcome: ${outcome}`);
  }
  const normalized = {
    schemaVersion: 1,
    type: 'DeliveryReceipt',
    receiptId: requireText(receipt.receiptId, 'receipt.receiptId'),
    intentId: requireText(receipt.intentId, 'receipt.intentId'),
    deliveryId: requireText(receipt.deliveryId, 'receipt.deliveryId'),
    requestId: requireText(receipt.requestId, 'receipt.requestId'),
    attemptId: requireText(receipt.attemptId, 'receipt.attemptId'),
    traceId: requireText(receipt.traceId, 'receipt.traceId'),
    adapterId: requireText(receipt.adapterId, 'receipt.adapterId'),
    outcome,
    externalRef: receipt.externalRef === null
      ? null
      : requireText(receipt.externalRef, 'receipt.externalRef'),
    observedAt: requireText(receipt.observedAt, 'receipt.observedAt'),
  };
  if (outcome === 'unknown') {
    if (receipt.nextAction !== 'reconcile_before_retry') {
      throw domainError('INVALID_UNKNOWN_RECEIPT', 'unknown requires reconcile_before_retry');
    }
    normalized.nextAction = 'reconcile_before_retry';
  }
  if (outcome === 'rejected') {
    normalized.errorCode = requireText(receipt.errorCode, 'receipt.errorCode', 128);
    if (typeof receipt.retryable !== 'boolean') {
      throw new TypeError('receipt.retryable must be a boolean');
    }
    normalized.retryable = receipt.retryable;
  }
  if (['platform_accepted', 'reconciled'].includes(outcome) && normalized.externalRef === null) {
    throw domainError('MISSING_EXTERNAL_REF', `${outcome} requires an externalRef`);
  }
  return normalized;
}

export function openReplyIntentOutbox({
  dbPath = DB_PATH,
  clock = () => Math.floor(Date.now() / 1_000),
  leaseTokenFactory = () => `lease:${randomUUID()}`,
  maxAttempts = 3,
  retryDelaySeconds = 0,
} = {}) {
  const normalizedPath = requireText(dbPath, 'dbPath');
  if (typeof clock !== 'function') throw new TypeError('clock must be a function');
  if (typeof leaseTokenFactory !== 'function') {
    throw new TypeError('leaseTokenFactory must be a function');
  }
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1) {
    throw new TypeError('maxAttempts must be a positive safe integer');
  }
  if (!Number.isSafeInteger(retryDelaySeconds) || retryDelaySeconds < 0) {
    throw new TypeError('retryDelaySeconds must be a non-negative safe integer');
  }
  if (normalizedPath !== ':memory:') fs.mkdirSync(path.dirname(normalizedPath), { recursive: true });
  const database = new Database(normalizedPath);
  database.pragma('journal_mode = WAL');
  database.pragma('busy_timeout = 5000');
  database.pragma('foreign_keys = ON');
  ensureAssistantReplyReliabilitySchema(database);

  const selectIntent = database.prepare(`SELECT * FROM assistant_reply_intents WHERE intent_id = ?`);
  database.prepare(`
    UPDATE assistant_reply_intents
    SET claim_epoch = 1,
        delivery_state = CASE
          WHEN delivery_state = 'sending' THEN 'reconcile_required'
          ELSE delivery_state
        END,
        lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL,
        last_error = 'LEGACY_LEASE_EPOCH_UNPROVEN', updated_at = ?
    WHERE claim_epoch = 0
      AND (
        delivery_state IN ('sending', 'reconcile_required')
        OR lease_token IS NOT NULL OR lease_owner IS NOT NULL OR lease_expires_at IS NOT NULL
      )
  `).run(currentTime(clock));

  const selectReceipt = database.prepare(`
    SELECT envelope_json, canonical_hash, attempt_id, claim_action, claim_epoch, lease_token
    FROM assistant_delivery_receipts WHERE receipt_id = ?
  `);
  const selectLatestSettlement = database.prepare(`
    SELECT * FROM assistant_delivery_settlements
    WHERE intent_id = ? ORDER BY rowid DESC LIMIT 1
  `);

  function claimView(row, { replayed }) {
    if (!row) return null;
    return {
      replayed,
      action: row.delivery_state === 'reconcile_required' ? 'reconcile' : 'send',
      intent: toIntent(row),
      deliveryId: `delivery:${row.intent_id}`,
      attemptId: row.current_attempt_id,
      claimEpoch: row.claim_epoch,
      leaseOwner: row.lease_owner,
      leaseToken: row.lease_token,
      leaseExpiresAt: row.lease_expires_at,
    };
  }

  const claimTransaction = database.transaction(({ ownerId, leaseSeconds }) => {
    const current = currentTime(clock);
    const safeOwnerId = requireText(ownerId, 'ownerId');
    if (!Number.isSafeInteger(leaseSeconds) || leaseSeconds < 1) {
      throw new TypeError('leaseSeconds must be a positive safe integer');
    }
    const active = database.prepare(`
      SELECT * FROM assistant_reply_intents
      WHERE lease_owner = ? AND lease_token IS NOT NULL AND lease_expires_at > ?
        AND claim_epoch > 0
        AND delivery_state IN ('sending', 'reconcile_required')
      ORDER BY created_at ASC, intent_id ASC LIMIT 1
    `).get(safeOwnerId, current);
    if (active) return claimView(active, { replayed: true });

    const expiredLeases = database.prepare(`
      SELECT intent_id, delivery_state, current_attempt_id, claim_epoch,
             lease_owner, lease_token, lease_expires_at
      FROM assistant_reply_intents
      WHERE delivery_state IN ('sending', 'reconcile_required')
        AND claim_epoch > 0 AND lease_token IS NOT NULL AND lease_expires_at <= ?
      ORDER BY intent_id ASC
    `).all(current);
    const recoverExpired = database.prepare(`
      UPDATE assistant_reply_intents
      SET delivery_state = 'reconcile_required', lease_owner = NULL,
          lease_token = NULL, lease_expires_at = NULL, updated_at = ?,
          last_error = COALESCE(last_error, 'LEASE_EXPIRED_RECONCILE_REQUIRED')
      WHERE intent_id = ? AND delivery_state = ? AND current_attempt_id IS ?
        AND claim_epoch = ? AND lease_owner = ? AND lease_token = ?
        AND lease_expires_at = ? AND lease_expires_at <= ?
    `);
    for (const expired of expiredLeases) {
      const recovered = recoverExpired.run(
        current,
        expired.intent_id,
        expired.delivery_state,
        expired.current_attempt_id,
        expired.claim_epoch,
        expired.lease_owner,
        expired.lease_token,
        expired.lease_expires_at,
        current,
      );
      if (recovered.changes !== 1) {
        throw domainError('LEASE_CONFLICT', 'expired delivery recovery lost its lease fence');
      }
    }

    const candidate = database.prepare(`
      SELECT * FROM assistant_reply_intents
      WHERE lease_token IS NULL
        AND (
          delivery_state = 'reconcile_required'
          OR (delivery_state IN ('pending', 'retrying') AND available_at <= ?)
        )
      ORDER BY CASE delivery_state WHEN 'reconcile_required' THEN 0 ELSE 1 END,
               available_at ASC, created_at ASC, intent_id ASC
      LIMIT 1
    `).get(current);
    if (!candidate) return null;
    const action = candidate.delivery_state === 'reconcile_required' ? 'reconcile' : 'send';
    const nextAttemptCount = action === 'send'
      ? candidate.attempt_count + 1
      : candidate.attempt_count;
    const attemptId = action === 'send'
      ? `attempt:delivery:${candidate.intent_id}:${nextAttemptCount}`
      : candidate.current_attempt_id;
    if (!attemptId) {
      throw domainError('DELIVERY_STATE_CORRUPT', 'reconciliation has no original attempt identity');
    }
    const leaseToken = requireText(leaseTokenFactory(candidate), 'generated leaseToken');
    const claimEpoch = candidate.claim_epoch + 1;
    const leaseExpiresAt = current + leaseSeconds;
    const updated = database.prepare(`
      UPDATE assistant_reply_intents
      SET delivery_state = ?, attempt_count = ?, current_attempt_id = ?,
          claim_epoch = ?, lease_owner = ?, lease_token = ?, lease_expires_at = ?, updated_at = ?
      WHERE intent_id = ? AND claim_epoch = ? AND current_attempt_id IS ?
        AND lease_token IS NULL AND delivery_state = ?
    `).run(
      action === 'send' ? 'sending' : 'reconcile_required',
      nextAttemptCount,
      attemptId,
      claimEpoch,
      safeOwnerId,
      leaseToken,
      leaseExpiresAt,
      current,
      candidate.intent_id,
      candidate.claim_epoch,
      candidate.current_attempt_id,
      candidate.delivery_state,
    );
    if (updated.changes !== 1) {
      throw domainError('LEASE_CONFLICT', 'delivery claim lost its lease fence');
    }
    return claimView(selectIntent.get(candidate.intent_id), { replayed: false });
  });

  function createSettlement(intent, basis, current) {
    const state = basis === 'retry_exhausted' ? 'unpresentable' : 'accepted';
    const suffix = basis === 'platform_accepted'
      ? 'accepted'
      : basis === 'reconciled' ? 'reconciled' : 'unpresentable';
    const settlement = {
      schemaVersion: 1,
      type: 'DeliverySettlement',
      settlementId: `settlement:delivery:${intent.intent_id}:${suffix}`,
      intentId: intent.intent_id,
      deliveryId: `delivery:${intent.intent_id}`,
      requestId: intent.request_id,
      traceId: intent.trace_id,
      adapterId: JSON.parse(intent.route_json).adapterId,
      state,
      basis,
      presented: state === 'accepted',
    };
    const envelopeJson = canonicalJson(settlement);
    const canonicalHash = sha256(envelopeJson);
    const existing = database.prepare(`
      SELECT canonical_hash FROM assistant_delivery_settlements WHERE settlement_id = ?
    `).get(settlement.settlementId);
    if (existing) {
      if (existing.canonical_hash !== canonicalHash) {
        throw domainError('IDEMPOTENCY_CONFLICT', 'DeliverySettlement identity has another payload');
      }
      return settlement;
    }
    database.prepare(`
      INSERT INTO assistant_delivery_settlements (
        settlement_id, intent_id, delivery_id, request_id, trace_id, adapter_id,
        state, basis, presented, envelope_json, canonical_hash, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      settlement.settlementId, settlement.intentId, settlement.deliveryId,
      settlement.requestId, settlement.traceId, settlement.adapterId,
      settlement.state, settlement.basis, settlement.presented ? 1 : 0,
      envelopeJson, canonicalHash, current,
    );
    return settlement;
  }

  const receiptTransaction = database.transaction(({
    action,
    claimEpoch,
    leaseToken,
    rawReceipt,
  }) => {
    const receipt = normalizeReceipt(rawReceipt);
    const safeAction = requireAction(action);
    const safeClaimEpoch = requireClaimEpoch(claimEpoch);
    const safeLeaseToken = requireText(leaseToken, 'leaseToken');
    const receiptJson = canonicalJson(receipt);
    const receiptHash = sha256(receiptJson);
    const existingReceipt = selectReceipt.get(receipt.receiptId);
    if (existingReceipt) {
      if (existingReceipt.canonical_hash !== receiptHash) {
        throw domainError('IDEMPOTENCY_CONFLICT', 'DeliveryReceipt identity has another payload');
      }
      if (
        existingReceipt.claim_action === null
        || existingReceipt.claim_epoch === null
        || existingReceipt.lease_token === null
      ) {
        throw domainError(
          'LEGACY_RECEIPT_LEASE_UNPROVEN',
          'legacy DeliveryReceipt has no durable lease fence identity',
        );
      }
      if (
        existingReceipt.claim_action !== safeAction
        || existingReceipt.claim_epoch !== safeClaimEpoch
        || existingReceipt.lease_token !== safeLeaseToken
        || existingReceipt.attempt_id !== receipt.attemptId
      ) {
        throw domainError('LEASE_FENCED', 'receipt replay lease does not own this delivery');
      }
      const replayIntent = selectIntent.get(receipt.intentId);
      return {
        replayed: true,
        receipt: JSON.parse(existingReceipt.envelope_json),
        delivery: toDelivery(replayIntent),
        settlement: toSettlement(selectLatestSettlement.get(receipt.intentId)),
      };
    }
    const intent = selectIntent.get(receipt.intentId);
    if (!intent) throw domainError('INTENT_NOT_FOUND', `unknown ReplyIntent: ${receipt.intentId}`);
    const current = currentTime(clock);
    const expectedState = safeAction === 'send' ? 'sending' : 'reconcile_required';
    if (
      intent.delivery_state !== expectedState
      || intent.current_attempt_id !== receipt.attemptId
      || intent.claim_epoch !== safeClaimEpoch
      || intent.lease_token !== safeLeaseToken
    ) {
      throw domainError('LEASE_FENCED', 'receipt lease does not own this delivery');
    }
    if (intent.lease_expires_at <= current) {
      throw domainError('LEASE_EXPIRED', 'receipt lease has expired');
    }
    const route = JSON.parse(intent.route_json);
    const expected = {
      deliveryId: `delivery:${intent.intent_id}`,
      requestId: intent.request_id,
      attemptId: intent.current_attempt_id,
      traceId: intent.trace_id,
      adapterId: route.adapterId,
    };
    for (const [field, value] of Object.entries(expected)) {
      if (receipt[field] !== value) {
        throw domainError('RECEIPT_IDENTITY_CONFLICT', `receipt.${field} does not match its intent`);
      }
    }
    if (receipt.outcome === 'reconciled' && safeAction !== 'reconcile') {
      throw domainError('RECONCILE_REQUIRED', 'reconciled is only valid after an unknown result');
    }
    if (receipt.outcome === 'unknown' && safeAction !== 'send') {
      throw domainError('INVALID_DELIVERY_TRANSITION', 'unknown is only valid for a send attempt');
    }
    if (receipt.outcome === 'platform_accepted' && safeAction !== 'send') {
      throw domainError('INVALID_DELIVERY_TRANSITION', 'platform_accepted requires a send attempt');
    }
    database.prepare(`
      INSERT INTO assistant_delivery_receipts (
        receipt_id, intent_id, delivery_id, request_id, attempt_id,
        claim_action, claim_epoch, lease_token, trace_id,
        adapter_id, outcome, envelope_json, canonical_hash, observed_at, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      receipt.receiptId, receipt.intentId, receipt.deliveryId, receipt.requestId,
      receipt.attemptId, safeAction, safeClaimEpoch, safeLeaseToken,
      receipt.traceId, receipt.adapterId, receipt.outcome,
      receiptJson, receiptHash, receipt.observedAt, current,
    );

    let settlement = null;
    let updated;
    if (receipt.outcome === 'unknown') {
      updated = database.prepare(`
        UPDATE assistant_reply_intents
        SET delivery_state = 'reconcile_required', lease_owner = NULL,
            lease_token = NULL, lease_expires_at = NULL, updated_at = ?,
            last_error = 'UNKNOWN_RECONCILE_REQUIRED'
        WHERE intent_id = ? AND delivery_state = 'sending'
          AND current_attempt_id = ? AND claim_epoch = ? AND lease_token = ?
          AND lease_expires_at > ?
      `).run(
        current,
        intent.intent_id,
        receipt.attemptId,
        safeClaimEpoch,
        safeLeaseToken,
        current,
      );
    } else if (['platform_accepted', 'reconciled'].includes(receipt.outcome)) {
      const basis = receipt.outcome;
      settlement = createSettlement(intent, basis, current);
      updated = database.prepare(`
        UPDATE assistant_reply_intents
        SET delivery_state = 'accepted', lease_owner = NULL, lease_token = NULL,
            lease_expires_at = NULL, updated_at = ?, last_error = NULL
        WHERE intent_id = ? AND delivery_state = ? AND current_attempt_id = ?
          AND claim_epoch = ? AND lease_token = ? AND lease_expires_at > ?
      `).run(
        current,
        intent.intent_id,
        expectedState,
        receipt.attemptId,
        safeClaimEpoch,
        safeLeaseToken,
        current,
      );
    } else {
      const retry = receipt.retryable && intent.attempt_count < maxAttempts;
      if (retry) {
        updated = database.prepare(`
          UPDATE assistant_reply_intents
          SET delivery_state = 'retrying', available_at = ?, lease_owner = NULL,
              lease_token = NULL, lease_expires_at = NULL, updated_at = ?, last_error = ?
          WHERE intent_id = ? AND delivery_state = ? AND current_attempt_id = ?
            AND claim_epoch = ? AND lease_token = ? AND lease_expires_at > ?
        `).run(
          current + retryDelaySeconds,
          current,
          receipt.errorCode,
          intent.intent_id,
          expectedState,
          receipt.attemptId,
          safeClaimEpoch,
          safeLeaseToken,
          current,
        );
      } else {
        settlement = createSettlement(intent, 'retry_exhausted', current);
        updated = database.prepare(`
          UPDATE assistant_reply_intents
          SET delivery_state = 'unpresentable', lease_owner = NULL, lease_token = NULL,
              lease_expires_at = NULL, updated_at = ?, last_error = ?
          WHERE intent_id = ? AND delivery_state = ? AND current_attempt_id = ?
            AND claim_epoch = ? AND lease_token = ? AND lease_expires_at > ?
        `).run(
          current,
          receipt.errorCode,
          intent.intent_id,
          expectedState,
          receipt.attemptId,
          safeClaimEpoch,
          safeLeaseToken,
          current,
        );
      }
    }
    if (updated.changes !== 1) {
      throw domainError('LEASE_CONFLICT', 'receipt update lost its delivery lease fence');
    }
    return {
      replayed: false,
      receipt,
      delivery: toDelivery(selectIntent.get(intent.intent_id)),
      settlement,
    };
  });

  const redriveTransaction = database.transaction(({ intentId }) => {
    const safeIntentId = requireText(intentId, 'intentId');
    const intent = selectIntent.get(safeIntentId);
    if (!intent) throw domainError('INTENT_NOT_FOUND', `unknown ReplyIntent: ${safeIntentId}`);
    if (intent.delivery_state === 'pending' && intent.redrive_count > 0) {
      return { replayed: true, intent: toIntent(intent), delivery: toDelivery(intent) };
    }
    if (intent.delivery_state !== 'unpresentable') {
      throw domainError(
        'INVALID_REDRIVE_STATE',
        `cannot redrive delivery while it is ${intent.delivery_state}`,
      );
    }
    const current = currentTime(clock);
    const updated = database.prepare(`
      UPDATE assistant_reply_intents
      SET delivery_state = 'pending', available_at = ?, redrive_count = redrive_count + 1,
          current_attempt_id = NULL, lease_owner = NULL, lease_token = NULL,
          lease_expires_at = NULL, last_error = NULL, updated_at = ?
      WHERE intent_id = ? AND delivery_state = 'unpresentable'
    `).run(current, current, safeIntentId);
    if (updated.changes !== 1) {
      throw domainError('REDRIVE_CONFLICT', 'delivery changed while redrive was applied');
    }
    const redriven = selectIntent.get(safeIntentId);
    return { replayed: false, intent: toIntent(redriven), delivery: toDelivery(redriven) };
  });

  return Object.freeze({
    claimNext({ ownerId, leaseSeconds = 30 } = {}) {
      return claimTransaction.immediate({ ownerId, leaseSeconds });
    },
    recordReceipt({ action, claimEpoch, leaseToken, receipt } = {}) {
      return receiptTransaction.immediate({ action, claimEpoch, leaseToken, rawReceipt: receipt });
    },
    get(intentId) {
      const row = selectIntent.get(requireText(intentId, 'intentId'));
      return row ? { intent: toIntent(row), delivery: toDelivery(row) } : null;
    },
    listReceipts(intentId) {
      return database.prepare(`
        SELECT envelope_json FROM assistant_delivery_receipts
        WHERE intent_id = ? ORDER BY created_at ASC, receipt_id ASC
      `).all(requireText(intentId, 'intentId')).map(row => JSON.parse(row.envelope_json));
    },
    listSettlements(intentId) {
      return database.prepare(`
        SELECT envelope_json FROM assistant_delivery_settlements
        WHERE intent_id = ? ORDER BY created_at ASC, settlement_id ASC
      `).all(requireText(intentId, 'intentId')).map(row => JSON.parse(row.envelope_json));
    },
    redrive(input = {}) {
      return redriveTransaction.immediate(input);
    },
    close() {
      database.close();
    },
  });
}
