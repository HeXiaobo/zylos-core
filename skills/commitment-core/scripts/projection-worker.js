import { createHash, randomUUID } from 'node:crypto';

export class ProjectionAdapterError extends Error {
  constructor(message, { retryable = true, cause } = {}) {
    if (typeof retryable !== 'boolean') {
      throw new TypeError('ProjectionAdapterError retryable must be a boolean');
    }
    super(message, { cause });
    this.name = 'ProjectionAdapterError';
    this.retryable = retryable;
  }
}

function requireObject(value, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${field} must be an object`);
  }
  return value;
}

function requireText(value, field) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`${field} must be a non-empty string`);
  }
  return value.trim();
}

function requirePositiveInteger(value, field) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${field} must be a positive integer`);
  }
  return value;
}

function operationKey(parts) {
  const digest = createHash('sha256').update(JSON.stringify(parts)).digest('hex');
  return `projection-worker:${digest}`;
}

function errorDetail(error) {
  const detail = error?.stack || error?.message || String(error);
  return [...detail].slice(0, 4096).join('');
}

function isRetryableAdapterFailure(error) {
  return !(error instanceof ProjectionAdapterError && error.retryable === false);
}

/**
 * Claim and settle one bounded projection batch.
 *
 * The Adapter is called once per non-empty batch. A successful Adapter call
 * makes every leased delivery eligible for acknowledge; a failed call makes
 * every delivery eligible for retry/dead-letter according to one shared
 * failure classification. Settlement remains per delivery so one fenced row
 * cannot prevent the rest of the batch from progressing.
 */
export async function processProjectionBatch({
  core,
  projection,
  workerId,
  leaseMs,
  limit,
  retryAfterMs,
  maxAttempts,
  operationId = randomUUID(),
  adapter,
} = {}) {
  requireObject(core, 'core');
  if (!core.outbox || typeof core.outbox.claim !== 'function'
      || typeof core.outbox.ack !== 'function' || typeof core.outbox.fail !== 'function') {
    throw new TypeError('core.outbox must provide claim, ack, and fail functions');
  }
  requireObject(adapter, 'adapter');
  if (typeof adapter.publishBatch !== 'function') {
    throw new TypeError('adapter.publishBatch must be a function');
  }
  const normalizedProjection = requireText(projection, 'projection');
  const normalizedWorkerId = requireText(workerId, 'workerId');
  const normalizedOperationId = requireText(operationId, 'operationId');
  requirePositiveInteger(leaseMs, 'leaseMs');
  requirePositiveInteger(limit, 'limit');
  requirePositiveInteger(retryAfterMs, 'retryAfterMs');
  requirePositiveInteger(maxAttempts, 'maxAttempts');

  const deliveries = core.outbox.claim({
    projection: normalizedProjection,
    workerId: normalizedWorkerId,
    leaseMs,
    limit,
    idempotencyKey: operationKey({
      operation: 'claim',
      projection: normalizedProjection,
      workerId: normalizedWorkerId,
      operationId: normalizedOperationId,
    }),
  });
  if (!Array.isArray(deliveries)) {
    throw new TypeError('core.outbox.claim must return an array');
  }

  const summary = {
    projection: normalizedProjection,
    claimed: deliveries.length,
    published: 0,
    acknowledged: 0,
    retryWaiting: 0,
    deadLettered: 0,
    settlementFailed: 0,
    idle: deliveries.length === 0,
  };
  if (deliveries.length === 0) return summary;

  let adapterFailure = null;
  try {
    await adapter.publishBatch({ deliveries });
    summary.published = deliveries.length;
  } catch (error) {
    adapterFailure = error;
  }

  for (const delivery of deliveries) {
    try {
      if (adapterFailure === null) {
        core.outbox.ack({
          projection: normalizedProjection,
          eventId: delivery.eventId,
          workerId: normalizedWorkerId,
          idempotencyKey: operationKey({
            operation: 'ack',
            projection: normalizedProjection,
            eventId: delivery.eventId,
            workerId: normalizedWorkerId,
            deliveryVersion: delivery.version,
          }),
        }, delivery.version);
        summary.acknowledged += 1;
      } else {
        const retryable = isRetryableAdapterFailure(adapterFailure);
        const failed = core.outbox.fail({
          projection: normalizedProjection,
          eventId: delivery.eventId,
          workerId: normalizedWorkerId,
          error: errorDetail(adapterFailure),
          ...(retryable ? { retryAfterMs } : {}),
          maxAttempts,
          idempotencyKey: operationKey({
            operation: 'fail',
            projection: normalizedProjection,
            eventId: delivery.eventId,
            workerId: normalizedWorkerId,
            deliveryVersion: delivery.version,
            retryable,
          }),
        }, delivery.version);
        if (failed.status === 'retry_wait') summary.retryWaiting += 1;
        if (failed.status === 'dead_letter') summary.deadLettered += 1;
      }
    } catch {
      summary.settlementFailed += 1;
    }
  }

  return summary;
}
