import { createHash } from 'node:crypto';

import {
  canonicalRunEventChainFailure,
  canonicalRunPersistenceFailure,
} from './canonical-run-event.js';

const RECEIPT_OUTCOMES = new Set(['platform_accepted', 'unknown', 'reconciled', 'rejected']);
const SETTLEMENT_BASES = new Set(['platform_accepted', 'reconciled', 'retry_exhausted']);

export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => (
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`
    )).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function parsedCanonical(row, label) {
  if (typeof row?.envelope_json !== 'string') return { failure: `${label}_ENVELOPE_MISSING` };
  if (sha256(row.envelope_json) !== row.canonical_hash) {
    return { failure: `${label}_CANONICAL_HASH_MISMATCH` };
  }
  try {
    const envelope = JSON.parse(row.envelope_json);
    if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) {
      return { failure: `${label}_ENVELOPE_INVALID` };
    }
    if (canonicalJson(envelope) !== row.envelope_json) {
      return { failure: `${label}_CANONICAL_BYTES_MISMATCH` };
    }
    return { envelope };
  } catch {
    return { failure: `${label}_ENVELOPE_INVALID` };
  }
}

function isText(value) {
  return typeof value === 'string' && value.trim() !== '';
}

function exactKeys(value, keys) {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

export function canonicalReplyOutcomeFailure(row) {
  const parsed = parsedCanonical(row, 'OUTCOME');
  if (parsed.failure) return parsed.failure;
  const envelope = parsed.envelope;
  if (
    envelope.schemaVersion !== 1
    || envelope.type !== 'ReplyOutcome'
    || envelope.outcomeId !== row.outcome_id
    || envelope.requestId !== row.request_id
    || envelope.turnId !== row.turn_id
    || envelope.traceId !== row.trace_id
    || envelope.kind !== row.kind
    || envelope.outcomeId !== `outcome:${row.request_id}`
  ) return 'OUTCOME_IDENTITY_MISMATCH';
  if (
    row.kind === 'answer'
    && (!exactKeys(envelope, ['schemaVersion', 'type', 'outcomeId', 'requestId', 'turnId', 'traceId', 'kind', 'content'])
      || !exactKeys(envelope.content ?? {}, ['format', 'text'])
      || envelope.content.format !== 'text' || !isText(envelope.content.text))
  ) return 'OUTCOME_PAYLOAD_INVALID';
  if (
    row.kind === 'silent'
    && (!exactKeys(envelope, ['schemaVersion', 'type', 'outcomeId', 'requestId', 'turnId', 'traceId', 'kind', 'explicit', 'reason'])
      || envelope.explicit !== true || !isText(envelope.reason))
  ) return 'OUTCOME_PAYLOAD_INVALID';
  if (
    row.kind === 'failure'
    && (!exactKeys(envelope, ['schemaVersion', 'type', 'outcomeId', 'requestId', 'turnId', 'traceId', 'kind', 'code', 'retryable'])
      || !isText(envelope.code) || typeof envelope.retryable !== 'boolean')
  ) return 'OUTCOME_PAYLOAD_INVALID';
  return ['answer', 'silent', 'failure'].includes(row.kind) ? null : 'OUTCOME_KIND_INVALID';
}

export function canonicalReplyIntentFailure(row) {
  const parsed = parsedCanonical(row, 'INTENT');
  if (parsed.failure) return parsed.failure;
  const envelope = parsed.envelope;
  if (!exactKeys(envelope, [
    'schemaVersion', 'type', 'intentId', 'requestId', 'traceId', 'cause',
    'route', 'disposition', 'payload', 'contentHash', 'idempotencyKey',
  ])) return 'INTENT_ENVELOPE_SHAPE_INVALID';
  if (
    envelope.schemaVersion !== 1 || envelope.type !== 'ReplyIntent'
    || envelope.intentId !== row.intent_id || envelope.requestId !== row.request_id
    || envelope.traceId !== row.trace_id || envelope.idempotencyKey !== row.idempotency_key
    || envelope.disposition !== row.disposition || envelope.contentHash !== row.content_hash
    || envelope.cause?.kind !== row.cause_kind || envelope.cause?.eventId !== row.cause_event_id
  ) return 'INTENT_IDENTITY_MISMATCH';
  if (
    !exactKeys(envelope.cause ?? {}, ['kind', 'eventId'])
    || !['run_terminal', 'task_effect'].includes(envelope.cause.kind)
    || !isText(envelope.cause.eventId)
    || !exactKeys(envelope.route ?? {}, ['adapterId', 'targetRef'])
    || !isText(envelope.route.adapterId) || !isText(envelope.route.targetRef)
    || !exactKeys(envelope.payload ?? {}, ['format', 'text'])
    || envelope.payload.format !== 'text' || !isText(envelope.payload.text)
  ) return 'INTENT_PAYLOAD_INVALID';
  const routeJson = canonicalJson(envelope.route);
  const payloadJson = canonicalJson(envelope.payload);
  const routeHash = sha256(routeJson);
  const contentHash = `sha256:${sha256(payloadJson)}`;
  const expectedIntentId = envelope.cause.kind === 'run_terminal'
    ? `reply:${envelope.requestId}:${routeHash}`
    : `reply:${envelope.cause.eventId}:${routeHash}`;
  if (
    row.route_json !== routeJson || row.payload_json !== payloadJson
    || row.route_hash !== routeHash || row.content_hash !== contentHash
    || row.intent_id !== expectedIntentId || row.idempotency_key !== expectedIntentId
  ) return 'INTENT_DERIVED_IDENTITY_MISMATCH';
  if (
    (row.cause_kind === 'run_terminal' && !['send', 'failure_notice'].includes(row.disposition))
    || (row.cause_kind === 'task_effect' && row.disposition !== 'task_receipt')
  ) return 'INTENT_CAUSE_DISPOSITION_MISMATCH';
  return null;
}

export function canonicalDeliveryReceiptFailure(row, intentRow = null) {
  const parsed = parsedCanonical(row, 'RECEIPT');
  if (parsed.failure) return parsed.failure;
  const envelope = parsed.envelope;
  const commonKeys = [
    'schemaVersion', 'type', 'receiptId', 'intentId', 'deliveryId', 'requestId',
    'attemptId', 'traceId', 'adapterId', 'outcome', 'externalRef', 'observedAt',
  ];
  const extraKeys = envelope.outcome === 'unknown' ? ['nextAction']
    : envelope.outcome === 'rejected' ? ['errorCode', 'retryable'] : [];
  if (!exactKeys(envelope, [...commonKeys, ...extraKeys])) return 'RECEIPT_ENVELOPE_SHAPE_INVALID';
  if (
    envelope.schemaVersion !== 1 || envelope.type !== 'DeliveryReceipt'
    || envelope.receiptId !== row.receipt_id || envelope.intentId !== row.intent_id
    || envelope.deliveryId !== row.delivery_id || envelope.requestId !== row.request_id
    || envelope.attemptId !== row.attempt_id || envelope.traceId !== row.trace_id
    || envelope.adapterId !== row.adapter_id || envelope.outcome !== row.outcome
    || envelope.observedAt !== row.observed_at
  ) return 'RECEIPT_IDENTITY_MISMATCH';
  if (!RECEIPT_OUTCOMES.has(envelope.outcome) || !isText(envelope.observedAt)) {
    return 'RECEIPT_PAYLOAD_INVALID';
  }
  if (envelope.outcome === 'unknown' && (envelope.externalRef !== null || envelope.nextAction !== 'reconcile_before_retry')) {
    return 'RECEIPT_PAYLOAD_INVALID';
  }
  if (envelope.outcome === 'rejected' && (envelope.externalRef !== null || !isText(envelope.errorCode) || typeof envelope.retryable !== 'boolean')) {
    return 'RECEIPT_PAYLOAD_INVALID';
  }
  if (['platform_accepted', 'reconciled'].includes(envelope.outcome) && !isText(envelope.externalRef)) {
    return 'RECEIPT_PAYLOAD_INVALID';
  }
  if (!['send', 'reconcile'].includes(row.claim_action) || !Number.isSafeInteger(row.claim_epoch) || row.claim_epoch < 1 || !isText(row.lease_token)) {
    return 'RECEIPT_LEASE_IDENTITY_INVALID';
  }
  if (
    (['platform_accepted', 'unknown'].includes(row.outcome) && row.claim_action !== 'send')
    || (row.outcome === 'reconciled' && row.claim_action !== 'reconcile')
  ) return 'RECEIPT_CLAIM_ACTION_MISMATCH';
  if (intentRow) {
    const intentFailure = canonicalReplyIntentFailure(intentRow);
    if (intentFailure) return `RECEIPT_INTENT_${intentFailure}`;
    const route = JSON.parse(intentRow.route_json);
    if (
      row.intent_id !== intentRow.intent_id || row.delivery_id !== `delivery:${intentRow.intent_id}`
      || row.request_id !== intentRow.request_id || row.trace_id !== intentRow.trace_id
      || row.adapter_id !== route.adapterId
      || !new RegExp(`^attempt:delivery:${intentRow.intent_id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:[1-9][0-9]*$`).test(row.attempt_id)
    ) return 'RECEIPT_INTENT_LINK_MISMATCH';
  }
  return null;
}

export function canonicalDeliverySettlementFailure(row, intentRow = null) {
  const parsed = parsedCanonical(row, 'SETTLEMENT');
  if (parsed.failure) return parsed.failure;
  const envelope = parsed.envelope;
  if (!exactKeys(envelope, [
    'schemaVersion', 'type', 'settlementId', 'intentId', 'deliveryId', 'requestId',
    'traceId', 'adapterId', 'state', 'basis', 'presented',
  ])) return 'SETTLEMENT_ENVELOPE_SHAPE_INVALID';
  if (
    envelope.schemaVersion !== 1 || envelope.type !== 'DeliverySettlement'
    || envelope.settlementId !== row.settlement_id || envelope.intentId !== row.intent_id
    || envelope.deliveryId !== row.delivery_id || envelope.requestId !== row.request_id
    || envelope.traceId !== row.trace_id || envelope.adapterId !== row.adapter_id
    || envelope.state !== row.state || envelope.basis !== row.basis
    || envelope.presented !== Boolean(row.presented)
  ) return 'SETTLEMENT_IDENTITY_MISMATCH';
  const suffix = envelope.basis === 'platform_accepted' ? 'accepted'
    : envelope.basis === 'reconciled' ? 'reconciled' : 'unpresentable';
  const expectedState = envelope.basis === 'retry_exhausted' ? 'unpresentable' : 'accepted';
  if (
    !SETTLEMENT_BASES.has(envelope.basis) || envelope.state !== expectedState
    || envelope.presented !== (expectedState === 'accepted')
    || envelope.settlementId !== `settlement:delivery:${envelope.intentId}:${suffix}`
    || envelope.deliveryId !== `delivery:${envelope.intentId}`
  ) return 'SETTLEMENT_DERIVED_IDENTITY_MISMATCH';
  if (intentRow) {
    const intentFailure = canonicalReplyIntentFailure(intentRow);
    if (intentFailure) return `SETTLEMENT_INTENT_${intentFailure}`;
    const route = JSON.parse(intentRow.route_json);
    if (
      row.intent_id !== intentRow.intent_id || row.request_id !== intentRow.request_id
      || row.trace_id !== intentRow.trace_id || row.adapter_id !== route.adapterId
    ) return 'SETTLEMENT_INTENT_LINK_MISMATCH';
  }
  return null;
}

export function canonicalRunTerminalIntentCauseFailure({
  intentRow,
  terminal,
  outcome,
  run,
  request,
  admission,
  events,
}) {
  const intentFailure = canonicalReplyIntentFailure(intentRow);
  if (intentFailure) return intentFailure;
  if (intentRow.cause_kind !== 'run_terminal') return null;
  if (!terminal || !['RunCompleted', 'RunFailed'].includes(terminal.event_type)) {
    return 'RUN_TERMINAL_CAUSE_NOT_FOUND';
  }
  if (
    terminal.event_id !== intentRow.cause_event_id
    || terminal.request_id !== intentRow.request_id
    || terminal.trace_id !== intentRow.trace_id
  ) return 'RUN_TERMINAL_CAUSE_IDENTITY_MISMATCH';
  const chainFailure = canonicalRunEventChainFailure(events);
  if (chainFailure) return chainFailure.reason;
  if (events.at(-1)?.event_id !== terminal.event_id) return 'RUN_TERMINAL_NOT_CHAIN_HEAD';
  const persistenceFailure = canonicalRunPersistenceFailure({
    rows: events,
    run,
    request,
    admission,
  });
  if (persistenceFailure) return persistenceFailure;
  const outcomeFailure = canonicalReplyOutcomeFailure(outcome);
  if (outcomeFailure) return outcomeFailure;
  const terminalPayload = JSON.parse(terminal.payload_json);
  if (
    outcome.outcome_id !== terminalPayload.outcomeId
    || outcome.request_id !== terminal.request_id
    || outcome.turn_id !== terminal.turn_id
    || outcome.generation !== terminal.generation
    || outcome.trace_id !== terminal.trace_id
    || (terminal.event_type === 'RunFailed' && outcome.kind !== 'failure')
    || (terminal.event_type === 'RunCompleted' && outcome.kind === 'failure')
  ) return 'RUN_TERMINAL_OUTCOME_LINK_MISMATCH';
  const intent = JSON.parse(intentRow.envelope_json);
  let durableRoute;
  try {
    durableRoute = JSON.parse(run.reply_route_json);
  } catch {
    return 'RUN_REPLY_ROUTE_INVALID';
  }
  if (canonicalJson(intent.route) !== canonicalJson(durableRoute)) {
    return 'RUN_REPLY_ROUTE_MISMATCH';
  }
  if (
    outcome.kind === 'silent'
    || run.reply_mode === 'none'
    || (outcome.kind === 'answer' && intent.disposition !== 'send')
    || (outcome.kind === 'failure' && intent.disposition !== 'failure_notice')
    || (outcome.kind === 'answer' && canonicalJson(intent.payload) !== canonicalJson(JSON.parse(outcome.envelope_json).content))
  ) return 'RUN_TERMINAL_INTENT_POLICY_MISMATCH';
  return null;
}
