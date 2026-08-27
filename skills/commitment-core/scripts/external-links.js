import { createHash } from 'node:crypto';

const DEFAULT_QUERY_LIMIT = 50;
const MAX_QUERY_LIMIT = 100;
const BACKEND_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;

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

function normalizeBackend(value) {
  const backend = requireText(value, 'backend').toLowerCase();
  if (!BACKEND_PATTERN.test(backend)) {
    throw new TypeError('backend must be a lowercase identifier');
  }
  return backend;
}

function normalizeLimit(value) {
  const limit = value ?? DEFAULT_QUERY_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_QUERY_LIMIT) {
    throw new TypeError(`limit must be an integer between 1 and ${MAX_QUERY_LIMIT}`);
  }
  return limit;
}

function normalizeLink(rawRequest) {
  const request = requireObject(rawRequest, 'external link request');
  rejectUnknownFields(
    request,
    new Set(['taskId', 'actorId', 'backend', 'externalId', 'idempotencyKey']),
    'external link request',
  );
  return {
    taskId: requireText(request.taskId, 'externalLink.taskId'),
    actorId: requireText(request.actorId, 'externalLink.actorId'),
    backend: normalizeBackend(request.backend),
    externalId: requireText(request.externalId, 'externalLink.externalId'),
    idempotencyKey: requireText(request.idempotencyKey, 'externalLink.idempotencyKey'),
  };
}

function normalizeQuery(rawQuery) {
  const query = requireObject(rawQuery, 'external link query');
  if (Object.hasOwn(query, 'taskId')) {
    rejectUnknownFields(query, new Set(['taskId', 'backend', 'limit']), 'external link query');
    return {
      mode: 'task',
      taskId: requireText(query.taskId, 'taskId'),
      backend: query.backend === undefined ? null : normalizeBackend(query.backend),
      limit: normalizeLimit(query.limit),
    };
  }
  rejectUnknownFields(query, new Set(['backend', 'externalId', 'limit']), 'external link query');
  const backend = normalizeBackend(query.backend);
  if (query.externalId !== undefined) {
    if (query.limit !== undefined) {
      throw new TypeError('unsupported external link query field: limit');
    }
    return {
      mode: 'external',
      backend,
      externalId: requireText(query.externalId, 'externalId'),
    };
  }
  return { mode: 'backend', backend, limit: normalizeLimit(query.limit) };
}

function fingerprint(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function domainError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function toLinkView(row) {
  if (!row) return null;
  return {
    id: row.id,
    taskId: row.task_id,
    actorId: row.actor_id,
    backend: row.backend,
    externalId: row.external_id,
    createdAt: row.created_at,
  };
}

function canLink(task, actorId) {
  return actorId === task.ownerId || actorId === task.acceptorId || actorId === task.assigneeId;
}

export function initializeExternalLinkSchema(database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS commitment_external_links (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      actor_id TEXT NOT NULL,
      backend TEXT NOT NULL,
      external_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE (backend, external_id),
      UNIQUE (task_id, backend),
      FOREIGN KEY (task_id) REFERENCES commitment_tasks(id) ON DELETE RESTRICT
    );

    CREATE INDEX IF NOT EXISTS idx_commitment_external_links_task
      ON commitment_external_links(task_id, backend, id);

    CREATE TABLE IF NOT EXISTS commitment_external_link_receipts (
      idempotency_key TEXT PRIMARY KEY,
      request_fingerprint TEXT NOT NULL,
      task_id TEXT NOT NULL,
      external_link_id TEXT NOT NULL,
      result_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (task_id) REFERENCES commitment_tasks(id) ON DELETE RESTRICT,
      FOREIGN KEY (external_link_id) REFERENCES commitment_external_links(id) ON DELETE RESTRICT
    );
  `);
}

export function createExternalLinkModule({
  database,
  clock,
  externalLinkIdGenerator,
  taskStore,
}) {
  const selectLinkById = database.prepare(`
    SELECT id, task_id, actor_id, backend, external_id, created_at
    FROM commitment_external_links
    WHERE id = ?
  `);
  const selectLinkByExternal = database.prepare(`
    SELECT id, task_id, actor_id, backend, external_id, created_at
    FROM commitment_external_links
    WHERE backend = ? AND external_id = ?
  `);
  const selectLinkByTaskBackend = database.prepare(`
    SELECT id, task_id, actor_id, backend, external_id, created_at
    FROM commitment_external_links
    WHERE task_id = ? AND backend = ?
  `);
  const selectReceipt = database.prepare(`
    SELECT request_fingerprint, result_json
    FROM commitment_external_link_receipts
    WHERE idempotency_key = ?
  `);
  const insertLink = database.prepare(`
    INSERT INTO commitment_external_links (
      id, task_id, actor_id, backend, external_id, created_at
    ) VALUES (?, ?, ?, ?, ?, ?)
  `);
  const insertReceipt = database.prepare(`
    INSERT INTO commitment_external_link_receipts (
      idempotency_key, request_fingerprint, task_id, external_link_id, result_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?)
  `);

  function linkWithinTransaction(rawRequest) {
    const request = normalizeLink(rawRequest);
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
    if (!canLink(task, request.actorId)) {
      throw domainError('FORBIDDEN', `${request.actorId} cannot link ${request.taskId}`);
    }

    const byExternal = selectLinkByExternal.get(request.backend, request.externalId);
    const byTask = selectLinkByTaskBackend.get(request.taskId, request.backend);
    let link;
    let created;
    if (byExternal || byTask) {
      const existing = byExternal ?? byTask;
      if (
        existing.task_id !== request.taskId
        || existing.backend !== request.backend
        || existing.external_id !== request.externalId
        || (byExternal && byTask && byExternal.id !== byTask.id)
      ) {
        throw domainError(
          'EXTERNAL_LINK_CONFLICT',
          `${request.backend}:${request.externalId} cannot be linked to ${request.taskId}`,
        );
      }
      link = toLinkView(existing);
      created = false;
    } else {
      const linkId = requireText(externalLinkIdGenerator(), 'generated external link id');
      const timestamp = requireText(clock(), 'clock result');
      try {
        insertLink.run(
          linkId,
          request.taskId,
          request.actorId,
          request.backend,
          request.externalId,
          timestamp,
        );
      } catch (error) {
        if (error?.code === 'SQLITE_CONSTRAINT_UNIQUE') {
          throw domainError(
            'EXTERNAL_LINK_CONFLICT',
            `${request.backend}:${request.externalId} cannot be linked to ${request.taskId}`,
          );
        }
        throw error;
      }
      link = toLinkView(selectLinkById.get(linkId));
      created = true;
    }

    const timestamp = requireText(clock(), 'clock result');
    const result = { created, link };
    insertReceipt.run(
      request.idempotencyKey,
      requestFingerprint,
      request.taskId,
      link.id,
      JSON.stringify(result),
      timestamp,
    );
    return result;
  }

  const linkTransaction = database.transaction(linkWithinTransaction);

  const publicInterface = Object.freeze({
    link(request) {
      return linkTransaction.immediate(request);
    },
    query(query) {
      const normalized = normalizeQuery(query);
      if (normalized.mode === 'external') {
        return toLinkView(selectLinkByExternal.get(normalized.backend, normalized.externalId));
      }
      if (normalized.mode === 'task') {
        const backendClause = normalized.backend ? 'AND backend = ?' : '';
        const parameters = normalized.backend
          ? [normalized.taskId, normalized.backend, normalized.limit]
          : [normalized.taskId, normalized.limit];
        return database.prepare(`
          SELECT id, task_id, actor_id, backend, external_id, created_at
          FROM commitment_external_links
          WHERE task_id = ? ${backendClause}
          ORDER BY backend ASC, external_id ASC, id ASC
          LIMIT ?
        `).all(...parameters).map(toLinkView);
      }
      return database.prepare(`
        SELECT id, task_id, actor_id, backend, external_id, created_at
        FROM commitment_external_links
        WHERE backend = ?
        ORDER BY external_id ASC, id ASC
        LIMIT ?
      `).all(normalized.backend, normalized.limit).map(toLinkView);
    },
  });

  // Core-only seam: adoption composes the same normalization, authorization,
  // uniqueness, and receipt logic without opening a nested SQLite transaction.
  return Object.freeze({ publicInterface, linkWithinTransaction });
}
