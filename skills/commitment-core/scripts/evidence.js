import { createHash } from 'node:crypto';

const DEFAULT_QUERY_LIMIT = 50;
const MAX_QUERY_LIMIT = 100;
const KIND_PATTERN = /^[a-z][a-z0-9._-]*$/;
const MAX_URI_LENGTH = 2_048;
const MAX_SUMMARY_LENGTH = 10_000;
const MAX_CONTENT_HASH_LENGTH = 256;

function requireObject(value, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${field} must be an object`);
  }
  return value;
}

function rejectUnknownFields(value, allowed, field) {
  const unknown = Object.keys(value).find((key) => !allowed.has(key));
  if (unknown) throw new TypeError(`unsupported ${field} field: ${unknown}`);
}

function requireText(value, field) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`${field} must be a non-empty string`);
  }
  return value.trim();
}

function optionalText(value, field) {
  if (value === undefined || value === null) return null;
  return requireText(value, field);
}

function optionalBoundedText(value, field, maximumLength) {
  const text = optionalText(value, field);
  if (text !== null && text.length > maximumLength) {
    throw new TypeError(`${field} must be at most ${maximumLength} characters`);
  }
  return text;
}

function normalizeKind(value, field = 'kind') {
  const kind = requireText(value, field).toLowerCase();
  if (!KIND_PATTERN.test(kind)) {
    throw new TypeError(`${field} must be a lowercase identifier`);
  }
  return kind;
}

function normalizeLimit(value) {
  const limit = value ?? DEFAULT_QUERY_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_QUERY_LIMIT) {
    throw new TypeError(`limit must be an integer between 1 and ${MAX_QUERY_LIMIT}`);
  }
  return limit;
}

function normalizeRecord(rawRequest) {
  const request = requireObject(rawRequest, 'evidence request');
  rejectUnknownFields(
    request,
    new Set(['taskId', 'actorId', 'kind', 'uri', 'summary', 'contentHash', 'idempotencyKey']),
    'evidence request',
  );
  const normalized = {
    taskId: requireText(request.taskId, 'evidence.taskId'),
    actorId: requireText(request.actorId, 'evidence.actorId'),
    kind: normalizeKind(request.kind, 'evidence.kind'),
    uri: optionalBoundedText(request.uri, 'evidence.uri', MAX_URI_LENGTH),
    summary: optionalBoundedText(request.summary, 'evidence.summary', MAX_SUMMARY_LENGTH),
    contentHash: optionalBoundedText(
      request.contentHash,
      'evidence.contentHash',
      MAX_CONTENT_HASH_LENGTH,
    ),
    idempotencyKey: requireText(request.idempotencyKey, 'evidence.idempotencyKey'),
  };
  if (!normalized.uri && !normalized.summary && !normalized.contentHash) {
    throw new TypeError('evidence must include at least one of uri, summary, or contentHash');
  }
  return normalized;
}

function normalizeQuery(rawQuery) {
  const query = requireObject(rawQuery, 'evidence query');
  if (Object.hasOwn(query, 'evidenceId')) {
    rejectUnknownFields(query, new Set(['evidenceId']), 'evidence query');
    return { mode: 'evidence', evidenceId: requireText(query.evidenceId, 'evidenceId') };
  }
  rejectUnknownFields(query, new Set(['taskId', 'kind', 'limit']), 'evidence query');
  return {
    mode: 'task',
    taskId: requireText(query.taskId, 'taskId'),
    kind: query.kind === undefined ? null : normalizeKind(query.kind),
    limit: normalizeLimit(query.limit),
  };
}

function fingerprint(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function domainError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function toEvidenceView(row) {
  if (!row) return null;
  return {
    id: row.id,
    taskId: row.task_id,
    actorId: row.actor_id,
    kind: row.kind,
    uri: row.uri,
    summary: row.summary,
    contentHash: row.content_hash,
    createdAt: row.created_at,
  };
}

function canContribute(task, actorId) {
  return actorId === task.ownerId || actorId === task.acceptorId || actorId === task.assigneeId;
}

export function initializeEvidenceSchema(database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS commitment_evidence (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      actor_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      uri TEXT,
      summary TEXT,
      content_hash TEXT,
      created_at TEXT NOT NULL,
      CHECK (uri IS NOT NULL OR summary IS NOT NULL OR content_hash IS NOT NULL),
      FOREIGN KEY (task_id) REFERENCES commitment_tasks(id) ON DELETE RESTRICT
    );

    CREATE INDEX IF NOT EXISTS idx_commitment_evidence_task_created
      ON commitment_evidence(task_id, created_at DESC, id ASC);

    CREATE TABLE IF NOT EXISTS commitment_evidence_receipts (
      idempotency_key TEXT PRIMARY KEY,
      request_fingerprint TEXT NOT NULL,
      task_id TEXT NOT NULL,
      evidence_id TEXT NOT NULL,
      result_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (task_id) REFERENCES commitment_tasks(id) ON DELETE RESTRICT,
      FOREIGN KEY (evidence_id) REFERENCES commitment_evidence(id) ON DELETE RESTRICT
    );
  `);
}

export function createEvidenceModule({ database, clock, evidenceIdGenerator, taskStore }) {
  const selectEvidence = database.prepare(`
    SELECT id, task_id, actor_id, kind, uri, summary, content_hash, created_at
    FROM commitment_evidence
    WHERE id = ?
  `);
  const selectReceipt = database.prepare(`
    SELECT request_fingerprint, result_json
    FROM commitment_evidence_receipts
    WHERE idempotency_key = ?
  `);
  const insertEvidence = database.prepare(`
    INSERT INTO commitment_evidence (
      id, task_id, actor_id, kind, uri, summary, content_hash, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertReceipt = database.prepare(`
    INSERT INTO commitment_evidence_receipts (
      idempotency_key, request_fingerprint, task_id, evidence_id, result_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?)
  `);

  const recordTransaction = database.transaction((rawRequest) => {
    const request = normalizeRecord(rawRequest);
    const requestFingerprint = fingerprint(request);
    const receipt = selectReceipt.get(request.idempotencyKey);
    if (receipt) {
      if (receipt.request_fingerprint !== requestFingerprint) {
        throw domainError(
          'IDEMPOTENCY_CONFLICT',
          `idempotency key already belongs to different content: ${request.idempotencyKey}`,
        );
      }
      return JSON.parse(receipt.result_json);
    }

    const task = taskStore.get(request.taskId);
    if (!task) throw domainError('TASK_NOT_FOUND', `task not found: ${request.taskId}`);
    if (!canContribute(task, request.actorId)) {
      throw domainError('FORBIDDEN', `${request.actorId} cannot record evidence for ${request.taskId}`);
    }

    const evidenceId = requireText(evidenceIdGenerator(), 'generated evidence id');
    const timestamp = requireText(clock(), 'clock result');
    insertEvidence.run(
      evidenceId,
      request.taskId,
      request.actorId,
      request.kind,
      request.uri,
      request.summary,
      request.contentHash,
      timestamp,
    );
    const result = { created: true, evidence: toEvidenceView(selectEvidence.get(evidenceId)) };
    insertReceipt.run(
      request.idempotencyKey,
      requestFingerprint,
      request.taskId,
      evidenceId,
      JSON.stringify(result),
      timestamp,
    );
    return result;
  });

  return Object.freeze({
    record(request) {
      return recordTransaction.immediate(request);
    },
    query(query) {
      const normalized = normalizeQuery(query);
      if (normalized.mode === 'evidence') {
        return toEvidenceView(selectEvidence.get(normalized.evidenceId));
      }
      const kindClause = normalized.kind ? 'AND kind = ?' : '';
      const parameters = normalized.kind
        ? [normalized.taskId, normalized.kind, normalized.limit]
        : [normalized.taskId, normalized.limit];
      return database.prepare(`
        SELECT id, task_id, actor_id, kind, uri, summary, content_hash, created_at
        FROM commitment_evidence
        WHERE task_id = ? ${kindClause}
        ORDER BY created_at DESC, id ASC
        LIMIT ?
      `).all(...parameters).map(toEvidenceView);
    },
  });
}
