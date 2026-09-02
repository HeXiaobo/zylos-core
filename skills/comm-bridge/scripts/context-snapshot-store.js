import {
  assertContextSnapshotV1,
  canonicalContextSnapshotBytes,
  contextSnapshotIdempotencyKey,
  deepFreezeContextValue,
} from './context-assembler.js';

function domainError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function requireText(value, field) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`${field} must be non-empty text`);
  }
  return value.normalize('NFC');
}

function validateSnapshot(snapshot) {
  assertContextSnapshotV1(snapshot);
  const snapshotId = requireText(snapshot.snapshotId, 'snapshot.snapshotId');
  const contentHash = requireText(snapshot.contentHash, 'snapshot.contentHash');
  return { snapshotId, contentHash, bytes: canonicalContextSnapshotBytes(snapshot) };
}

function conflict(identity) {
  return domainError('CONTEXT_SNAPSHOT_CONFLICT', `immutable context snapshot conflict for ${identity}`);
}

function corrupt(snapshotId) {
  return domainError('CONTEXT_SNAPSHOT_CORRUPT', `stored context snapshot is corrupt: ${snapshotId}`);
}

function parseStoredSnapshot(row) {
  if (!row) return null;
  let snapshot;
  try {
    snapshot = JSON.parse(row.canonical_json);
  } catch {
    throw corrupt(row.snapshot_id);
  }
  let validated;
  try {
    validated = validateSnapshot(snapshot);
  } catch {
    throw corrupt(row.snapshot_id);
  }
  if (
    validated.snapshotId !== row.snapshot_id
    || contextSnapshotIdempotencyKey(snapshot) !== row.idempotency_key
    || snapshot.requestId !== row.request_id
    || snapshot.turnId !== row.turn_id
    || snapshot.traceId !== row.trace_id
    || snapshot.conversationLaneKey !== row.conversation_lane_key
    || snapshot.asOfLaneSequence !== row.as_of_lane_sequence
    || validated.contentHash !== row.content_hash
    || validated.bytes.toString('utf8') !== row.canonical_json
  ) {
    throw corrupt(row.snapshot_id);
  }
  return deepFreezeContextValue(snapshot);
}

function normalizeLookup({ snapshotId, idempotencyKey } = {}) {
  if (snapshotId === undefined && idempotencyKey === undefined) {
    throw new TypeError('snapshot lookup requires snapshotId or idempotencyKey');
  }
  return {
    snapshotId: snapshotId === undefined ? null : requireText(snapshotId, 'snapshotId'),
    idempotencyKey: idempotencyKey === undefined
      ? null
      : requireText(idempotencyKey, 'idempotencyKey'),
  };
}

export function createInMemoryContextSnapshotStore() {
  const bySnapshotId = new Map();
  const byIdempotencyKey = new Map();

  function load(rawLookup) {
    const lookup = normalizeLookup(rawLookup);
    const byId = lookup.snapshotId ? bySnapshotId.get(lookup.snapshotId) : null;
    const byKey = lookup.idempotencyKey ? byIdempotencyKey.get(lookup.idempotencyKey) : null;
    if (lookup.snapshotId && lookup.idempotencyKey) {
      if (!byId && !byKey) return null;
      if (!byId || !byKey || byId !== byKey) throw conflict(lookup.idempotencyKey);
      return byId.snapshot;
    }
    return (byId || byKey)?.snapshot || null;
  }

  return Object.freeze({
    load,
    save({ idempotencyKey, snapshot } = {}) {
      const key = requireText(idempotencyKey, 'idempotencyKey');
      const validated = validateSnapshot(snapshot);
      if (key !== contextSnapshotIdempotencyKey(snapshot)) throw conflict(key);
      const existing = load({ snapshotId: validated.snapshotId, idempotencyKey: key });
      if (existing) {
        if (!canonicalContextSnapshotBytes(existing).equals(validated.bytes)) throw conflict(key);
        return existing;
      }
      const immutable = deepFreezeContextValue(JSON.parse(validated.bytes.toString('utf8')));
      const record = Object.freeze({ idempotencyKey: key, snapshot: immutable });
      bySnapshotId.set(validated.snapshotId, record);
      byIdempotencyKey.set(key, record);
      return immutable;
    },
    count() {
      return bySnapshotId.size;
    },
  });
}

/**
 * SQLite adapter for ContextSnapshotStore. Schema ownership is deliberately
 * local to this adapter so WT07 can inject the shared connection without a
 * c4-db.js change in this worktree.
 */
export function createSqliteContextSnapshotStore({ database } = {}) {
  if (
    !database
    || typeof database.exec !== 'function'
    || typeof database.prepare !== 'function'
    || typeof database.transaction !== 'function'
  ) {
    throw new TypeError('database must be an injected SQLite connection');
  }
  database.exec(`
    CREATE TABLE IF NOT EXISTS context_snapshots (
      snapshot_id TEXT PRIMARY KEY,
      idempotency_key TEXT NOT NULL UNIQUE,
      request_id TEXT NOT NULL,
      turn_id TEXT NOT NULL,
      trace_id TEXT NOT NULL,
      conversation_lane_key TEXT NOT NULL,
      as_of_lane_sequence INTEGER NOT NULL,
      content_hash TEXT NOT NULL,
      canonical_json TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_context_snapshots_request_turn
      ON context_snapshots(request_id, turn_id);
    CREATE TRIGGER IF NOT EXISTS context_snapshots_immutable_update
      BEFORE UPDATE ON context_snapshots
      BEGIN
        SELECT RAISE(ABORT, 'context snapshots are immutable');
      END;
    CREATE TRIGGER IF NOT EXISTS context_snapshots_immutable_delete
      BEFORE DELETE ON context_snapshots
      BEGIN
        SELECT RAISE(ABORT, 'context snapshots are immutable');
      END;
    CREATE TRIGGER IF NOT EXISTS context_snapshots_immutable_reinsert
      BEFORE INSERT ON context_snapshots
      WHEN EXISTS (
        SELECT 1 FROM context_snapshots
        WHERE snapshot_id = NEW.snapshot_id OR idempotency_key = NEW.idempotency_key
      )
      BEGIN
        SELECT RAISE(ABORT, 'context snapshots are immutable');
      END;
  `);

  const selectBySnapshotId = database.prepare(`
    SELECT * FROM context_snapshots WHERE snapshot_id = ?
  `);
  const selectByIdempotencyKey = database.prepare(`
    SELECT * FROM context_snapshots WHERE idempotency_key = ?
  `);
  const insert = database.prepare(`
    INSERT INTO context_snapshots (
      snapshot_id, idempotency_key, request_id, turn_id, trace_id,
      conversation_lane_key, as_of_lane_sequence, content_hash, canonical_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  function lookupRows({ snapshotId, idempotencyKey }) {
    const byId = snapshotId ? selectBySnapshotId.get(snapshotId) : null;
    const byKey = idempotencyKey ? selectByIdempotencyKey.get(idempotencyKey) : null;
    if (snapshotId && idempotencyKey) {
      if (!byId && !byKey) return null;
      if (!byId || !byKey || byId.snapshot_id !== byKey.snapshot_id) {
        throw conflict(idempotencyKey);
      }
      return byId;
    }
    return byId || byKey || null;
  }

  const saveTransaction = database.transaction(({ idempotencyKey, snapshot }) => {
    const key = requireText(idempotencyKey, 'idempotencyKey');
    const validated = validateSnapshot(snapshot);
    if (key !== contextSnapshotIdempotencyKey(snapshot)) throw conflict(key);
    const existingRow = lookupRows({ snapshotId: validated.snapshotId, idempotencyKey: key });
    if (existingRow) {
      if (
        existingRow.idempotency_key !== key
        || existingRow.canonical_json !== validated.bytes.toString('utf8')
      ) throw conflict(key);
      return parseStoredSnapshot(existingRow);
    }
    insert.run(
      validated.snapshotId,
      key,
      requireText(snapshot.requestId, 'snapshot.requestId'),
      requireText(snapshot.turnId, 'snapshot.turnId'),
      requireText(snapshot.traceId, 'snapshot.traceId'),
      requireText(snapshot.conversationLaneKey, 'snapshot.conversationLaneKey'),
      snapshot.asOfLaneSequence,
      validated.contentHash,
      validated.bytes.toString('utf8'),
    );
    return parseStoredSnapshot(selectBySnapshotId.get(validated.snapshotId));
  });

  return Object.freeze({
    load(rawLookup) {
      const lookup = normalizeLookup(rawLookup);
      return parseStoredSnapshot(lookupRows(lookup));
    },
    save(record) {
      return saveTransaction.immediate(record);
    },
  });
}
