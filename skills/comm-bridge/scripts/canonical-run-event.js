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

const EVENT_PRODUCERS = Object.freeze({
  RunAccepted: new Set(['core:message-intake']),
  RunQueued: new Set(['core:runtime-pending-queue', 'core:runtime-recovery']),
  RunStarted: new Set(['core:runtime-lane']),
  ProgressUpdated: new Set(['runtime:shared']),
  OutputDelta: new Set(['runtime:shared']),
  RunCompleted: new Set(['runtime:shared']),
  RunFailed: new Set(['runtime:shared']),
  RunCancelled: new Set(['core:runtime-lane', 'runtime:shared']),
});

const PREDECESSOR_TYPES = Object.freeze({
  RunQueued: new Set(['RunAccepted', 'RunQueued', 'RunStarted', 'ProgressUpdated', 'OutputDelta']),
  RunStarted: new Set(['RunQueued']),
  ProgressUpdated: new Set(['RunStarted', 'ProgressUpdated', 'OutputDelta']),
  OutputDelta: new Set(['RunStarted', 'ProgressUpdated', 'OutputDelta']),
  RunCompleted: new Set(['RunStarted', 'ProgressUpdated', 'OutputDelta']),
  RunFailed: new Set(['RunStarted', 'ProgressUpdated', 'OutputDelta']),
  RunCancelled: new Set(['RunQueued', 'RunStarted', 'ProgressUpdated', 'OutputDelta']),
});

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => (
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`
    )).join(',')}}`;
  }
  return JSON.stringify(value);
}

function hasExactKeys(value, keys) {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length
    && actual.every((key, index) => key === expected[index]);
}

function isNonEmptyText(value) {
  return typeof value === 'string' && value.trim() !== '';
}

function idempotencyFailure(row) {
  const requestPrefix = `run:${row.request_id}`;
  const exact = {
    RunAccepted: `${requestPrefix}:accepted`,
    RunStarted: `${requestPrefix}:started:g${row.generation}`,
    RunCompleted: `${requestPrefix}:completed`,
    RunFailed: `${requestPrefix}:failed`,
  }[row.event_type];
  if (exact && row.idempotency_key !== exact) return 'NONCANONICAL_EVENT_IDEMPOTENCY';
  if (
    row.event_type === 'RunQueued'
    && (
      (row.producer === 'core:runtime-pending-queue'
        && row.idempotency_key !== `${requestPrefix}:queued`)
      || (row.producer === 'core:runtime-recovery'
        && row.idempotency_key !== `${requestPrefix}:recovered:g${row.generation}`)
    )
  ) {
    return 'NONCANONICAL_EVENT_IDEMPOTENCY';
  }
  if (
    row.event_type === 'ProgressUpdated'
    && !new RegExp(`^run:${escapeRegExp(row.request_id)}:progress:[1-9][0-9]*$`).test(row.idempotency_key)
  ) {
    return 'NONCANONICAL_EVENT_IDEMPOTENCY';
  }
  if (
    row.event_type === 'OutputDelta'
    && !new RegExp(`^run:${escapeRegExp(row.request_id)}:delta:[1-9][0-9]*$`).test(row.idempotency_key)
  ) {
    return 'NONCANONICAL_EVENT_IDEMPOTENCY';
  }
  if (
    row.event_type === 'RunCancelled'
    && row.idempotency_key !== `${requestPrefix}:cancelled`
    && row.idempotency_key !== `${requestPrefix}:cancelled:g${row.generation}`
  ) {
    return 'NONCANONICAL_EVENT_IDEMPOTENCY';
  }
  return null;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function payloadFailure(row, payload) {
  if (row.event_type === 'RunAccepted' && !hasExactKeys(payload, [])) {
    return 'NONCANONICAL_ACCEPTED_PAYLOAD';
  }
  if (
    row.event_type === 'RunQueued'
    && payload.runtimeLaneId !== 'runtime:shared'
  ) {
    return 'NONCANONICAL_RUNTIME_LANE';
  }
  if (
    row.event_type === 'RunQueued'
    && row.producer === 'core:runtime-pending-queue'
    && !hasExactKeys(payload, ['runtimeLaneId'])
  ) {
    return 'NONCANONICAL_QUEUED_PAYLOAD';
  }
  if (
    row.event_type === 'RunQueued'
    && row.producer === 'core:runtime-recovery'
    && (
      !hasExactKeys(payload, [
        'runtimeLaneId',
        'recoveredFromTurnId',
        'recoveredAdmissionStatus',
      ])
      || !isNonEmptyText(payload.recoveredFromTurnId)
      || !['submitted', 'started'].includes(payload.recoveredAdmissionStatus)
    )
  ) {
    return 'NONCANONICAL_RECOVERY_PAYLOAD';
  }
  if (row.event_type === 'RunStarted') {
    if (payload.runtimeLaneId !== 'runtime:shared') return 'NONCANONICAL_RUNTIME_LANE';
    if (!isNonEmptyText(payload.runtimeSessionId)) return 'NONCANONICAL_RUNTIME_SESSION';
    const allowedKeys = new Set([
      'runtimeLaneId',
      'runtimeSessionId',
      'contextSnapshotId',
      'contextSnapshotHash',
    ]);
    if (Object.keys(payload).some(key => !allowedKeys.has(key))) {
      return 'NONCANONICAL_STARTED_PAYLOAD';
    }
    const hasSnapshotId = Object.hasOwn(payload, 'contextSnapshotId');
    const hasSnapshotHash = Object.hasOwn(payload, 'contextSnapshotHash');
    if (
      hasSnapshotId !== hasSnapshotHash
      || (hasSnapshotId && !isNonEmptyText(payload.contextSnapshotId))
      || (hasSnapshotHash && !isNonEmptyText(payload.contextSnapshotHash))
    ) {
      return 'NONCANONICAL_STARTED_PAYLOAD';
    }
  }
  if (
    row.event_type === 'ProgressUpdated'
    && (!hasExactKeys(payload, ['stage']) || !isNonEmptyText(payload.stage))
  ) {
    return 'NONCANONICAL_PROGRESS_PAYLOAD';
  }
  if (
    row.event_type === 'OutputDelta'
    && (
      !hasExactKeys(payload, ['deltaIndex', 'text'])
      || !Number.isSafeInteger(payload.deltaIndex)
      || payload.deltaIndex < 1
      || !isNonEmptyText(payload.text)
    )
  ) {
    return 'NONCANONICAL_DELTA_PAYLOAD';
  }
  if (['RunCompleted', 'RunFailed'].includes(row.event_type)) {
    if (!isNonEmptyText(payload.outcomeId)) return 'TERMINAL_OUTCOME_ID_REQUIRED';
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
      !hasExactKeys(payload, ['outcomeId', 'code', 'retryable'])
      || !isNonEmptyText(payload.code)
      || typeof payload.retryable !== 'boolean'
    )
  ) {
    return 'NONCANONICAL_FAILED_PAYLOAD';
  }
  if (
    row.event_type === 'RunCompleted'
    && !hasExactKeys(payload, ['outcomeId'])
  ) {
    return 'NONCANONICAL_COMPLETED_PAYLOAD';
  }
  if (
    row.event_type === 'RunCancelled'
    && (
      !hasExactKeys(payload, ['mode'])
      || !['queued', 'active'].includes(payload.mode)
      || (payload.mode === 'queued' && row.producer !== 'core:runtime-lane')
      || (payload.mode === 'active' && row.producer !== 'runtime:shared')
    )
  ) {
    return 'NONCANONICAL_CANCELLED_PAYLOAD';
  }
  return null;
}

export function canonicalRunEventFailure(row) {
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
    if (!isNonEmptyText(row[field])) return `NONCANONICAL_${field.toUpperCase()}`;
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
  if (!RUN_EVENT_TYPES.has(row.event_type)) return 'NONCANONICAL_EVENT_TYPE';
  if (!EVENT_PRODUCERS[row.event_type].has(row.producer)) return 'NONCANONICAL_PRODUCER';
  if (
    (row.sequence === 1 && row.event_type !== 'RunAccepted')
    || (row.sequence !== 1 && row.event_type === 'RunAccepted')
  ) {
    return 'NONCANONICAL_ACCEPT_SEQUENCE';
  }
  const idempotency = idempotencyFailure(row);
  if (idempotency) return idempotency;
  let payload;
  try {
    payload = JSON.parse(row.payload_json);
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      return 'NONCANONICAL_PAYLOAD';
    }
  } catch {
    return 'NONCANONICAL_PAYLOAD';
  }
  if (canonicalJson(payload) !== row.payload_json) return 'NONCANONICAL_PAYLOAD_BYTES';
  return payloadFailure(row, payload);
}

export function canonicalRunEventLinkFailure(event, predecessor) {
  if (event.sequence === 1) return predecessor ? 'NONCANONICAL_SEQUENCE_PREDECESSOR' : null;
  if (!predecessor) return 'CANONICAL_SEQUENCE_GAP';
  if (
    predecessor.request_id !== event.request_id
    || predecessor.sequence !== event.sequence - 1
    || predecessor.event_id !== `evt:${event.request_id}:${event.sequence - 1}`
  ) {
    return 'NONCANONICAL_SEQUENCE_PREDECESSOR';
  }
  if (!PREDECESSOR_TYPES[event.event_type]?.has(predecessor.event_type)) {
    return 'NONCANONICAL_EVENT_TRANSITION';
  }
  if (
    event.event_type === 'RunQueued'
    && event.producer === 'core:runtime-pending-queue'
    && predecessor.event_type !== 'RunAccepted'
  ) {
    return 'NONCANONICAL_EVENT_TRANSITION';
  }
  if (event.event_type === 'RunQueued') {
    const payload = JSON.parse(event.payload_json);
    if (event.producer === 'core:runtime-recovery') {
      if (
        event.generation !== predecessor.generation + 1
        || event.turn_id !== `turn:${event.request_id}:${event.generation}`
        || payload.recoveredFromTurnId !== predecessor.turn_id
      ) return 'NONCANONICAL_RECOVERY_FENCE_CHAIN';
    } else if (
      event.generation !== predecessor.generation
      || event.turn_id !== predecessor.turn_id
    ) {
      return 'NONCANONICAL_RUN_FENCE_CHAIN';
    }
  }
  if (
    event.event_type === 'RunQueued'
    && event.producer === 'core:runtime-recovery'
    && predecessor.event_type === 'RunAccepted'
  ) {
    return 'NONCANONICAL_EVENT_TRANSITION';
  }
  if (event.trace_id !== predecessor.trace_id) return 'NONCANONICAL_TRACE_CHAIN';
  if (
    !['RunQueued', 'RunCancelled'].includes(event.event_type)
    && (
      event.turn_id !== predecessor.turn_id
      || event.generation !== predecessor.generation
    )
  ) {
    return 'NONCANONICAL_RUN_FENCE_CHAIN';
  }
  if (event.event_type !== 'RunCancelled' && event.causation_id !== predecessor.event_id) {
    return 'NONCANONICAL_CAUSATION_CHAIN';
  }
  return null;
}

export function canonicalRunEventChainFailure(rows) {
  for (let index = 0; index < rows.length; index += 1) {
    const event = rows[index];
    const structural = canonicalRunEventFailure(event);
    if (structural) return { reason: structural, event };
    const link = canonicalRunEventLinkFailure(event, rows[index - 1] ?? null);
    if (link) return { reason: link, event };
  }
  return null;
}

export function canonicalRunPersistenceFailure({ rows, run, request, admission, admissions = [] }) {
  if (!run || !request) return 'RUN_LEDGER_FACTS_MISSING';
  if (!Array.isArray(rows) || rows.length === 0) return 'RUN_EVENT_CHAIN_MISSING';
  const chainFailure = canonicalRunEventChainFailure(rows);
  if (chainFailure) return chainFailure.reason;
  const accepted = rows[0];
  const head = rows.at(-1);
  if (
    accepted.request_id !== run.request_id
    || accepted.turn_id !== `turn:${run.request_id}:1`
    || accepted.generation !== 1
    || accepted.trace_id !== run.trace_id
    || accepted.causation_id !== run.causation_id
  ) return 'RUN_ACCEPTED_LEDGER_MISMATCH';
  if (
    request.request_id !== run.request_id
    || request.next_sequence !== head.sequence + 1
    || head.request_id !== run.request_id
  ) return 'RUN_REQUEST_SEQUENCE_MISMATCH';
  if (
    head.turn_id !== run.turn_id
    || head.generation !== run.generation
    || head.trace_id !== run.trace_id
  ) return 'RUN_HEAD_LEDGER_FENCE_MISMATCH';
  const terminalStatus = {
    RunCompleted: 'completed',
    RunFailed: 'failed',
    RunCancelled: 'cancelled',
  }[head.event_type];
  if (terminalStatus && run.status !== terminalStatus) {
    return 'RUN_TERMINAL_LEDGER_STATUS_MISMATCH';
  }
  if (!terminalStatus && ['completed', 'failed', 'cancelled'].includes(run.status)) {
    return 'RUN_LEDGER_TERMINAL_WITHOUT_EVENT';
  }
  if (
    ['RunStarted', 'ProgressUpdated', 'OutputDelta'].includes(head.event_type)
    && (!['active', 'cancel_requested'].includes(run.status) || request.status !== 'started')
  ) {
    return 'RUN_STARTED_STATUS_MISMATCH';
  }
  const expectedRequestStatus = {
    queued: 'queued', active: 'started', completed: 'completed', failed: 'failed', cancelled: 'cancelled',
  }[run.status];
  if (expectedRequestStatus && request.status !== expectedRequestStatus) {
    return 'RUN_REQUEST_STATUS_MISMATCH';
  }
  const started = [...rows].reverse().find(event => event.event_type === 'RunStarted');
  for (const recovered of rows.filter(event => (
    event.event_type === 'RunQueued' && event.producer === 'core:runtime-recovery'
  ))) {
    const payload = JSON.parse(recovered.payload_json);
    const priorAdmission = admissions.find(candidate => (
      candidate.request_id === run.request_id
      && candidate.turn_id === payload.recoveredFromTurnId
      && candidate.generation === recovered.generation - 1
    ));
    const expectedReason = payload.recoveredAdmissionStatus === 'submitted'
      ? 'stale_unconfirmed_submission_generation_fence'
      : 'stale_started_generation_fence';
    if (
      !priorAdmission
      || priorAdmission.status !== 'released'
      || priorAdmission.runtime_lane_id !== 'runtime:shared'
      || priorAdmission.terminal_reason !== expectedReason
    ) return 'RUN_RECOVERY_ADMISSION_MISMATCH';
  }
  if (started) {
    const payload = JSON.parse(started.payload_json);
    if (
      !admission
      || admission.request_id !== run.request_id
      || admission.turn_id !== run.turn_id
      || admission.generation !== run.generation
      || admission.runtime_lane_id !== 'runtime:shared'
      || admission.runtime_session_id !== payload.runtimeSessionId
      || request.runtime_session_id !== payload.runtimeSessionId
      || !['started', 'completed'].includes(admission.status)
    ) return 'RUN_STARTED_ADMISSION_MISMATCH';
  } else if (run.status === 'active') {
    return 'RUN_ACTIVE_WITHOUT_STARTED';
  }
  return null;
}
