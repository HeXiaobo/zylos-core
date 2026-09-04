#!/usr/bin/env node
/**
 * C4 Communication Bridge - Database Module
 * Provides database operations for message logging and checkpoint management
 */

import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { DATA_DIR, DB_PATH, CONTROL_MAX_RETRIES } from './c4-config.js';
import { buildReplyViaSuffix, hasLegacyReplyViaSuffix, truncateForDelivery } from './c4-utils.js';
import { serializeTaskEnvelope } from './c4-task-envelope.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const INIT_SQL_PATH = path.join(__dirname, '..', 'init-db.sql');

let db = null;

/**
 * SQLITE_BUSY-class failures that busy_timeout alone may not absorb: WAL
 * snapshot conflicts and schema-lock races between two processes opening the
 * same database in the same second. This is the retryable class for cold-start
 * schema initialization.
 */
export function isSqliteBusyError(error) {
  const code = error?.code ?? '';
  return code === 'SQLITE_BUSY'
    || code === 'SQLITE_BUSY_SNAPSHOT'
    || code === 'SQLITE_LOCKED'
    || /SQLITE_(BUSY|LOCKED)/.test(String(error?.message ?? ''));
}

function sleepSync(ms) {
  // better-sqlite3 is synchronous, so the schema-init backoff must be
  // synchronous as well. Atomics.wait parks the thread without a busy loop.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Open a connection and run schema initialization with bounded backoff around
 * SQLITE_BUSY-class failures. A schema race used to surface as a swallowed
 * per-cycle error, leaving the worker process alive but non-functional; the
 * retry discards the partially-initialized connection and reopens cleanly.
 */
export function openDatabaseWithSchemaRetry(openDatabase, initSchema, {
  attempts = 3,
  baseDelayMs = 250,
  log = null,
} = {}) {
  if (!Number.isInteger(attempts) || attempts < 1) {
    throw new TypeError('attempts must be a positive integer');
  }
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    let database = null;
    try {
      database = openDatabase();
      if (initSchema) initSchema(database);
      return database;
    } catch (error) {
      lastError = error;
      try { database?.close(); } catch { /* already closed */ }
      if (attempt < attempts && isSqliteBusyError(error)) {
        const delayMs = baseDelayMs * 2 ** (attempt - 1);
        log?.({
          event: 'c4_db_schema_init_retry',
          attempt,
          delayMs,
          error: error?.message || String(error),
        });
        sleepSync(delayMs);
        continue;
      }
      throw error;
    }
  }
  throw lastError;
}

/**
 * Get database connection, initializing if needed
 */
export function getDb() {
  if (!db) {
    // Ensure data directory exists
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }

    const isNew = !fs.existsSync(DB_PATH);
    db = openDatabaseWithSchemaRetry(
      () => {
        const connection = new Database(DB_PATH);
        connection.pragma('journal_mode = WAL');  // Better concurrent access
        connection.pragma('busy_timeout = 5000');
        connection.pragma('foreign_keys = ON');
        return connection;
      },
      (connection) => {
        if (isNew) {
          initSchema(connection);
        }

        ensureConversationsSchema(connection);
        ensureControlQueueSchema(connection);
        ensureStatusNoticeCooldownSchema(connection);
        ensureCommitmentIntakeSchema(connection);
        ensureAssistantResponseSchema(connection);
        ensureVoidChannelMigration(connection);
      },
      {
        // Make startup retries visible in pm2 logs; previously backoff only
        // surfaced after all attempts failed, hiding transient lock races.
        log: (event) => console.warn(`[C4-DB] ${event.event} attempt=${event.attempt} delayMs=${event.delayMs} error=${event.error}`),
      },
    );
  }
  return db;
}

/**
 * Initialize database schema from init-db.sql
 */
function initSchema(database) {
  const initSql = fs.readFileSync(INIT_SQL_PATH, 'utf8');
  database.exec(initSql);
  console.log('[C4-DB] Database initialized');
}

export function stripTrailingAckSuffix(content) {
  if (typeof content !== 'string') return content;
  return content.replace(/\s---- ack via: node .+ ack --id \d+$/, '');
}

function ensureControlQueueSchema(database) {
  const columns = database.prepare('PRAGMA table_info(control_queue)').all();
  const columnNames = new Set(columns.map((column) => column.name));

  if (!columnNames.has('raw_content')) {
    database.exec('ALTER TABLE control_queue ADD COLUMN raw_content TEXT');
  }

  const rows = database.prepare(`
    SELECT id, content
    FROM control_queue
    WHERE raw_content IS NULL
  `).all();

  const updateRawContent = database.prepare(`
    UPDATE control_queue
    SET raw_content = ?
    WHERE id = ?
  `);

  const tx = database.transaction((pendingRows) => {
    for (const row of pendingRows) {
      updateRawContent.run(stripTrailingAckSuffix(row.content), row.id);
    }
  });

  tx(rows);
}

function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

function getColumnNames(database, tableName) {
  return new Set(database.prepare(`PRAGMA table_info(${tableName})`).all().map((column) => column.name));
}

function replaceCanonicalEventImmutabilityTriggers(database) {
  const replace = database.transaction(() => database.exec(`
    DROP TRIGGER IF EXISTS assistant_response_events_canonical_immutable;
    DROP TRIGGER IF EXISTS assistant_response_events_canonical_id_immutable;
    DROP TRIGGER IF EXISTS assistant_response_events_canonical_rowid_immutable;
    DROP TRIGGER IF EXISTS assistant_response_events_canonical_no_delete;
    DROP TRIGGER IF EXISTS assistant_response_events_canonical_no_replace;
    DROP TRIGGER IF EXISTS assistant_response_events_no_legacy_promotion;

    CREATE TRIGGER assistant_response_events_canonical_immutable
    BEFORE UPDATE OF
      id, request_id, sequence, event_type, payload_json, idempotency_key,
      event_id, turn_id, generation, trace_id, causation_id, producer, created_at
    ON assistant_response_events
    WHEN OLD.event_id IS NOT NULL
    BEGIN
      SELECT RAISE(ABORT, 'canonical assistant event is immutable');
    END;

    CREATE TRIGGER assistant_response_events_canonical_id_immutable
    BEFORE UPDATE OF id ON assistant_response_events
    WHEN OLD.event_id IS NOT NULL
    BEGIN
      SELECT RAISE(ABORT, 'canonical assistant event is immutable');
    END;

    CREATE TRIGGER assistant_response_events_canonical_rowid_immutable
    BEFORE UPDATE OF rowid ON assistant_response_events
    WHEN OLD.event_id IS NOT NULL
    BEGIN
      SELECT RAISE(ABORT, 'canonical assistant event is immutable');
    END;

    CREATE TRIGGER assistant_response_events_canonical_no_delete
    BEFORE DELETE ON assistant_response_events
    WHEN OLD.event_id IS NOT NULL
    BEGIN
      SELECT RAISE(ABORT, 'canonical assistant event is immutable');
    END;


    CREATE TRIGGER assistant_response_events_canonical_no_replace
    BEFORE INSERT ON assistant_response_events
    WHEN NEW.event_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM assistant_response_events AS existing
      WHERE existing.event_id = NEW.event_id
         OR (existing.request_id = NEW.request_id AND existing.sequence = NEW.sequence)
         OR (NEW.idempotency_key IS NOT NULL
             AND existing.request_id = NEW.request_id
             AND existing.idempotency_key = NEW.idempotency_key)
    )
    BEGIN
      SELECT RAISE(ABORT, 'canonical assistant event is immutable');
    END;

    CREATE TRIGGER assistant_response_events_no_legacy_promotion
    BEFORE UPDATE OF event_id ON assistant_response_events
    WHEN OLD.event_id IS NULL AND NEW.event_id IS NOT NULL
    BEGIN
      SELECT RAISE(ABORT, 'legacy assistant event cannot be promoted to canonical');
    END;
  `));
  replace.immediate();
}

function ensureAssistantRequestsCancelledStatus(database) {
  const definition = database.prepare(`
    SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'assistant_requests'
  `).get()?.sql;
  if (!definition || definition.includes("'cancelled'")) return;
  const foreignKeysEnabled = database.pragma('foreign_keys', { simple: true }) === 1;
  database.pragma('foreign_keys = OFF');
  try {
    const migrate = database.transaction(() => database.exec(`
      CREATE TABLE assistant_requests_v2 (
        request_id TEXT PRIMARY KEY,
        conversation_id INTEGER UNIQUE,
        route_channel TEXT NOT NULL,
        route_endpoint TEXT NOT NULL,
        source_id TEXT NOT NULL,
        status TEXT NOT NULL
          CHECK (status IN ('queued', 'started', 'completed', 'failed', 'cancelled')),
        runtime_session_id TEXT,
        next_sequence INTEGER NOT NULL DEFAULT 1 CHECK (next_sequence >= 1),
        output_text TEXT NOT NULL DEFAULT '',
        accepted_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        terminal_at INTEGER,
        FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE RESTRICT
      );

      INSERT INTO assistant_requests_v2 (
        request_id, conversation_id, route_channel, route_endpoint, source_id,
        status, runtime_session_id, next_sequence, output_text,
        accepted_at, updated_at, terminal_at
      )
      SELECT
        request_id, conversation_id, route_channel, route_endpoint, source_id,
        CASE
          WHEN status = 'failed' AND EXISTS (
            SELECT 1 FROM assistant_response_events AS event
            WHERE event.request_id = assistant_requests.request_id
              AND event.event_type = 'RunCancelled'
          ) THEN 'cancelled'
          ELSE status
        END,
        runtime_session_id, next_sequence, output_text,
        accepted_at, updated_at, terminal_at
      FROM assistant_requests;

      DROP TABLE assistant_requests;
      ALTER TABLE assistant_requests_v2 RENAME TO assistant_requests;
      CREATE INDEX idx_assistant_requests_status_time
        ON assistant_requests(status, accepted_at, request_id);
      CREATE INDEX idx_assistant_requests_runtime
        ON assistant_requests(runtime_session_id, status, updated_at);
      CREATE INDEX idx_assistant_requests_route
        ON assistant_requests(route_channel, route_endpoint, status, updated_at);
    `));
    migrate.immediate();
  } finally {
    if (foreignKeysEnabled) database.pragma('foreign_keys = ON');
  }
}

function ensureConversationsSchema(database) {
  const columnNames = getColumnNames(database, 'conversations');
  if (!columnNames.has('delivery_action')) {
    database.exec('ALTER TABLE conversations ADD COLUMN delivery_action TEXT');
  }
  if (!columnNames.has('assistant_request_id')) {
    database.exec('ALTER TABLE conversations ADD COLUMN assistant_request_id TEXT');
  }
  database.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_conversations_assistant_request_out
      ON conversations(assistant_request_id)
      WHERE direction = 'out' AND assistant_request_id IS NOT NULL
  `);
}

/**
 * #689: session-handoff summaries used to be piggybacked on the web-console
 * channel (channel='web-console', endpoint_id='session-handoff'). They now
 * live on the internal record-only 'void' channel; re-tag existing rows so
 * display surfaces no longer need endpoint-name special cases. Idempotent —
 * once re-tagged, no rows match.
 */
function ensureVoidChannelMigration(database) {
  database.prepare(`
    UPDATE conversations
    SET channel = 'void'
    WHERE channel = 'web-console' AND endpoint_id = 'session-handoff'
  `).run();
}

function ensureStatusNoticeCooldownSchema(database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS status_notice_cooldowns (
      cooldown_key TEXT PRIMARY KEY,
      channel TEXT NOT NULL,
      endpoint TEXT NOT NULL,
      status_type TEXT NOT NULL,
      reason TEXT NOT NULL,
      last_notified_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_status_notice_cooldowns_expires_at
      ON status_notice_cooldowns(expires_at);
  `);
}

function ensureCommitmentIntakeSchema(database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS commitment_intake_queue (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id INTEGER NOT NULL UNIQUE,
      idempotency_key TEXT NOT NULL UNIQUE,
      payload_json TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'processing', 'completed', 'failed')),
      retry_count INTEGER NOT NULL DEFAULT 0 CHECK (retry_count >= 0),
      retry_generation INTEGER NOT NULL DEFAULT 0 CHECK (retry_generation >= 0),
      available_at INTEGER NOT NULL,
      last_error TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE RESTRICT
    );

    CREATE INDEX IF NOT EXISTS idx_commitment_intake_queue_ready
      ON commitment_intake_queue(status, available_at, id);
    CREATE INDEX IF NOT EXISTS idx_commitment_intake_queue_stale
      ON commitment_intake_queue(status, updated_at);
  `);

  const columnNames = getColumnNames(database, 'commitment_intake_queue');
  if (!columnNames.has('retry_generation')) {
    database.exec(`
      ALTER TABLE commitment_intake_queue
      ADD COLUMN retry_generation INTEGER NOT NULL DEFAULT 0
        CHECK (retry_generation >= 0)
    `);
  }
}

export function ensureAssistantResponseSchema(database, { observationClock = Date.now } = {}) {
  if (typeof observationClock !== 'function') {
    throw new TypeError('observationClock must be a function');
  }
  const migrationObservedAtMs = observationClock();
  if (!Number.isSafeInteger(migrationObservedAtMs) || migrationObservedAtMs < 0) {
    throw new TypeError('observationClock result must be a non-negative safe integer');
  }
  database.exec(`
    CREATE TABLE IF NOT EXISTS assistant_requests (
      request_id TEXT PRIMARY KEY,
      conversation_id INTEGER UNIQUE,
      route_channel TEXT NOT NULL,
      route_endpoint TEXT NOT NULL,
      source_id TEXT NOT NULL,
      status TEXT NOT NULL
        CHECK (status IN ('queued', 'started', 'completed', 'failed', 'cancelled')),
      runtime_session_id TEXT,
      next_sequence INTEGER NOT NULL DEFAULT 1 CHECK (next_sequence >= 1),
      output_text TEXT NOT NULL DEFAULT '',
      accepted_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      terminal_at INTEGER,
      FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE RESTRICT
    );

    CREATE INDEX IF NOT EXISTS idx_assistant_requests_status_time
      ON assistant_requests(status, accepted_at, request_id);
    CREATE INDEX IF NOT EXISTS idx_assistant_requests_runtime
      ON assistant_requests(runtime_session_id, status, updated_at);
    CREATE INDEX IF NOT EXISTS idx_assistant_requests_route
      ON assistant_requests(route_channel, route_endpoint, status, updated_at);

    CREATE TABLE IF NOT EXISTS assistant_response_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      request_id TEXT NOT NULL,
      sequence INTEGER NOT NULL CHECK (sequence >= 1),
      event_type TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      idempotency_key TEXT,
      delivery_status TEXT NOT NULL DEFAULT 'pending'
        CHECK (delivery_status IN ('pending', 'processing', 'delivered', 'dead_letter')),
      retry_count INTEGER NOT NULL DEFAULT 0 CHECK (retry_count >= 0),
      redrive_count INTEGER NOT NULL DEFAULT 0 CHECK (redrive_count >= 0),
      available_at INTEGER NOT NULL,
      lease_token TEXT,
      lease_expires_at INTEGER,
      last_error TEXT,
      created_at INTEGER NOT NULL,
      delivered_at INTEGER,
      FOREIGN KEY (request_id) REFERENCES assistant_requests(request_id) ON DELETE RESTRICT,
      UNIQUE (request_id, sequence),
      UNIQUE (request_id, idempotency_key)
    );

    CREATE INDEX IF NOT EXISTS idx_assistant_response_events_delivery
      ON assistant_response_events(delivery_status, available_at, id);
    CREATE INDEX IF NOT EXISTS idx_assistant_response_events_request
      ON assistant_response_events(request_id, sequence);

    CREATE TABLE IF NOT EXISTS runtime_turn_admissions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      singleton_key INTEGER NOT NULL DEFAULT 1 CHECK (singleton_key = 1),
      conversation_id INTEGER NOT NULL,
      request_id TEXT,
      route_channel TEXT NOT NULL,
      status TEXT NOT NULL
        CHECK (status IN ('submitted', 'started', 'completed', 'released')),
      runtime_session_id TEXT,
      acquired_at INTEGER NOT NULL,
      started_at INTEGER,
      terminal_at INTEGER,
      updated_at INTEGER NOT NULL,
      lifecycle_version INTEGER NOT NULL DEFAULT 0 CHECK (lifecycle_version >= 0),
      lifecycle_observed_at_ms INTEGER
        CHECK (lifecycle_observed_at_ms IS NULL OR lifecycle_observed_at_ms >= 0),
      recovery_activity_observed_at_ms INTEGER
        CHECK (recovery_activity_observed_at_ms IS NULL OR recovery_activity_observed_at_ms >= 0),
      recovery_activity_id TEXT,
      binding_mode TEXT NOT NULL DEFAULT 'pending'
        CHECK (binding_mode IN ('pending', 'bound', 'rejected', 'closed')),
      binding_reason TEXT,
      binding_projection_pending INTEGER NOT NULL DEFAULT 0
        CHECK (binding_projection_pending IN (0, 1)),
      binding_projection_observed_at_ms INTEGER
        CHECK (
          binding_projection_observed_at_ms IS NULL
          OR binding_projection_observed_at_ms >= 0
        ),
      binding_projected_at INTEGER,
      terminal_reason TEXT,
      FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE RESTRICT,
      FOREIGN KEY (request_id) REFERENCES assistant_requests(request_id) ON DELETE RESTRICT
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_runtime_turn_admissions_one_active
      ON runtime_turn_admissions(singleton_key)
      WHERE status IN ('submitted', 'started');
    CREATE INDEX IF NOT EXISTS idx_runtime_turn_admissions_conversation
      ON runtime_turn_admissions(conversation_id, id);
    CREATE INDEX IF NOT EXISTS idx_runtime_turn_admissions_session
      ON runtime_turn_admissions(runtime_session_id, status, id);

    CREATE TABLE IF NOT EXISTS assistant_final_output_candidates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      request_id TEXT NOT NULL,
      admission_id INTEGER NOT NULL,
      runtime_session_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      activity_id TEXT NOT NULL,
      output_hash TEXT NOT NULL CHECK (length(output_hash) = 64),
      observed_at_ms INTEGER NOT NULL CHECK (observed_at_ms >= 0),
      status TEXT NOT NULL
        CHECK (status IN ('active', 'consumed', 'invalidated')),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      terminal_reason TEXT,
      FOREIGN KEY (request_id) REFERENCES assistant_requests(request_id) ON DELETE RESTRICT,
      FOREIGN KEY (admission_id) REFERENCES runtime_turn_admissions(id) ON DELETE RESTRICT
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_assistant_final_output_one_active
      ON assistant_final_output_candidates(request_id)
      WHERE status = 'active';
    CREATE UNIQUE INDEX IF NOT EXISTS idx_assistant_final_output_exact_event
      ON assistant_final_output_candidates(request_id, admission_id, message_id);
    CREATE INDEX IF NOT EXISTS idx_assistant_final_output_request
      ON assistant_final_output_candidates(request_id, id);
  `);

  ensureAssistantRequestsCancelledStatus(database);

  const eventColumns = getColumnNames(database, 'assistant_response_events');
  if (!eventColumns.has('redrive_count')) {
    database.exec(`
      ALTER TABLE assistant_response_events
      ADD COLUMN redrive_count INTEGER NOT NULL DEFAULT 0
        CHECK (redrive_count >= 0)
    `);
  }

  const finalOutputColumns = getColumnNames(database, 'assistant_final_output_candidates');
  if (!finalOutputColumns.has('observed_at_ms')) {
    database.exec(`
      ALTER TABLE assistant_final_output_candidates
      ADD COLUMN observed_at_ms INTEGER CHECK (observed_at_ms IS NULL OR observed_at_ms >= 0)
    `);
    database.prepare(`
      UPDATE assistant_final_output_candidates
      SET observed_at_ms = ?
      WHERE observed_at_ms IS NULL
    `).run(observationClock());
  }
  if (!finalOutputColumns.has('activity_id')) {
    database.exec('ALTER TABLE assistant_final_output_candidates ADD COLUMN activity_id TEXT');
    database.prepare(`
      UPDATE assistant_final_output_candidates
      SET activity_id = 'legacy-candidate:' || id
      WHERE activity_id IS NULL
    `).run();
  }

  const runtimeTurnColumns = getColumnNames(database, 'runtime_turn_admissions');
  if (!runtimeTurnColumns.has('lifecycle_version')) {
    database.exec(`
      ALTER TABLE runtime_turn_admissions
      ADD COLUMN lifecycle_version INTEGER NOT NULL DEFAULT 0
        CHECK (lifecycle_version >= 0)
    `);
  }
  if (!runtimeTurnColumns.has('lifecycle_observed_at_ms')) {
    database.exec(`
      ALTER TABLE runtime_turn_admissions
      ADD COLUMN lifecycle_observed_at_ms INTEGER
        CHECK (lifecycle_observed_at_ms IS NULL OR lifecycle_observed_at_ms >= 0)
    `);
  }
  if (!runtimeTurnColumns.has('recovery_activity_observed_at_ms')) {
    database.exec(`
      ALTER TABLE runtime_turn_admissions
      ADD COLUMN recovery_activity_observed_at_ms INTEGER
        CHECK (recovery_activity_observed_at_ms IS NULL OR recovery_activity_observed_at_ms >= 0)
    `);
  }
  if (!runtimeTurnColumns.has('recovery_activity_id')) {
    database.exec('ALTER TABLE runtime_turn_admissions ADD COLUMN recovery_activity_id TEXT');
  }
  if (!runtimeTurnColumns.has('binding_mode')) {
    database.exec(`
      ALTER TABLE runtime_turn_admissions
      ADD COLUMN binding_mode TEXT NOT NULL DEFAULT 'pending'
        CHECK (binding_mode IN ('pending', 'bound', 'rejected', 'closed'))
    `);
  }
  if (!runtimeTurnColumns.has('binding_reason')) {
    database.exec('ALTER TABLE runtime_turn_admissions ADD COLUMN binding_reason TEXT');
  }
  if (!runtimeTurnColumns.has('binding_projection_pending')) {
    database.exec(`
      ALTER TABLE runtime_turn_admissions
      ADD COLUMN binding_projection_pending INTEGER NOT NULL DEFAULT 0
        CHECK (binding_projection_pending IN (0, 1))
    `);
  }
  if (!runtimeTurnColumns.has('binding_projection_observed_at_ms')) {
    database.exec(`
      ALTER TABLE runtime_turn_admissions
      ADD COLUMN binding_projection_observed_at_ms INTEGER
        CHECK (
          binding_projection_observed_at_ms IS NULL
          OR binding_projection_observed_at_ms >= 0
        )
    `);
  }
  if (!runtimeTurnColumns.has('binding_projected_at')) {
    database.exec('ALTER TABLE runtime_turn_admissions ADD COLUMN binding_projected_at INTEGER');
  }
  // A NULL observation baseline would let the first delayed hook after an
  // upgrade define the new generation. Conservatively fence every active
  // legacy admission at migration time; a hook process observed before this
  // point must not mutate it.
  database.prepare(`
    UPDATE runtime_turn_admissions
    SET lifecycle_observed_at_ms = ?
    WHERE status IN ('submitted', 'started') AND lifecycle_observed_at_ms IS NULL
  `).run(migrationObservedAtMs);
}

/**
 * Additive storage for the Assistant Reply v1 Run Ledger.  The canonical
 * request and event rows remain in assistant_requests and
 * assistant_response_events; this schema only adds the identities, lane
 * ordering, runtime fencing, and cancellation facts that those legacy tables
 * cannot represent.
 */
export function ensureAssistantRunLedgerSchema(database, options = {}) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS conversations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
      direction TEXT NOT NULL,
      channel TEXT NOT NULL,
      endpoint_id TEXT,
      content TEXT NOT NULL,
      status TEXT DEFAULT 'pending',
      delivery_action TEXT,
      priority INTEGER DEFAULT 3,
      require_idle INTEGER DEFAULT 0,
      retry_count INTEGER DEFAULT 0
    )
  `);
  ensureAssistantResponseSchema(database, options);

  database.exec(`
    CREATE TABLE IF NOT EXISTS assistant_run_ledger (
      acceptance_order INTEGER PRIMARY KEY AUTOINCREMENT,
      request_id TEXT NOT NULL UNIQUE,
      conversation_lane_key TEXT NOT NULL,
      lane_sequence INTEGER NOT NULL CHECK (lane_sequence >= 1),
      payload_hash TEXT NOT NULL,
      trace_id TEXT NOT NULL,
      causation_id TEXT NOT NULL,
      request_class TEXT NOT NULL DEFAULT 'ordinary'
        CHECK (request_class IN ('ordinary', 'maintenance', 'control')),
      priority INTEGER NOT NULL CHECK (priority BETWEEN 1 AND 3),
      require_idle INTEGER NOT NULL DEFAULT 0 CHECK (require_idle IN (0, 1)),
      reply_mode TEXT NOT NULL DEFAULT 'required'
        CHECK (reply_mode IN ('required', 'optional', 'none')),
      reply_route_json TEXT NOT NULL,
      runtime_lane_id TEXT NOT NULL DEFAULT 'runtime:shared'
        CHECK (runtime_lane_id = 'runtime:shared'),
      turn_id TEXT NOT NULL,
      generation INTEGER NOT NULL DEFAULT 1 CHECK (generation >= 1),
      status TEXT NOT NULL
        CHECK (status IN (
          'queued', 'active', 'cancel_requested',
          'completed', 'failed', 'cancelled'
        )),
      accepted_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      terminal_at INTEGER,
      FOREIGN KEY (request_id) REFERENCES assistant_requests(request_id) ON DELETE RESTRICT,
      UNIQUE (conversation_lane_key, lane_sequence)
    );

    CREATE INDEX IF NOT EXISTS idx_assistant_run_ledger_pending
      ON assistant_run_ledger(status, priority, acceptance_order);
    CREATE INDEX IF NOT EXISTS idx_assistant_run_ledger_lane
      ON assistant_run_ledger(conversation_lane_key, lane_sequence, status);

    CREATE TABLE IF NOT EXISTS assistant_source_receipts (
      identity_kind TEXT NOT NULL
        CHECK (identity_kind IN ('idempotency', 'transport', 'logical')),
      identity_key TEXT NOT NULL,
      request_id TEXT NOT NULL,
      payload_hash TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (identity_kind, identity_key),
      FOREIGN KEY (request_id) REFERENCES assistant_requests(request_id) ON DELETE RESTRICT
    );

    CREATE INDEX IF NOT EXISTS idx_assistant_source_receipts_request
      ON assistant_source_receipts(request_id);

    CREATE TABLE IF NOT EXISTS assistant_cancel_requests (
      idempotency_key TEXT PRIMARY KEY,
      command_id TEXT,
      request_id TEXT NOT NULL,
      turn_id TEXT NOT NULL,
      generation INTEGER NOT NULL CHECK (generation >= 1),
      payload_hash TEXT NOT NULL,
      trace_id TEXT NOT NULL,
      causation_id TEXT NOT NULL,
      confirmation_causation_id TEXT,
      status TEXT NOT NULL CHECK (status IN ('requested', 'confirmed')),
      requested_at INTEGER NOT NULL,
      confirmed_at INTEGER,
      FOREIGN KEY (request_id) REFERENCES assistant_requests(request_id) ON DELETE RESTRICT
    );

    CREATE INDEX IF NOT EXISTS idx_assistant_cancel_requests_request
      ON assistant_cancel_requests(request_id, generation);
  `);

  const cancelColumns = getColumnNames(database, 'assistant_cancel_requests');
  if (!cancelColumns.has('command_id')) {
    database.exec('ALTER TABLE assistant_cancel_requests ADD COLUMN command_id TEXT');
  }
  if (!cancelColumns.has('confirmation_causation_id')) {
    database.exec(`
      ALTER TABLE assistant_cancel_requests ADD COLUMN confirmation_causation_id TEXT
    `);
  }

  const runLedgerColumns = getColumnNames(database, 'assistant_run_ledger');
  if (!runLedgerColumns.has('reply_mode')) {
    database.exec(`
      ALTER TABLE assistant_run_ledger
      ADD COLUMN reply_mode TEXT NOT NULL DEFAULT 'required'
        CHECK (reply_mode IN ('required', 'optional', 'none'))
    `);
  }
  if (!runLedgerColumns.has('reply_route_json')) {
    database.exec('ALTER TABLE assistant_run_ledger ADD COLUMN reply_route_json TEXT');
  }
  database.prepare(`
    UPDATE assistant_run_ledger
    SET reply_route_json = json_object(
      'adapterId', (
        SELECT route_channel FROM assistant_requests
        WHERE assistant_requests.request_id = assistant_run_ledger.request_id
      ),
      'targetRef', (
        SELECT route_endpoint FROM assistant_requests
        WHERE assistant_requests.request_id = assistant_run_ledger.request_id
      )
    )
    WHERE reply_route_json IS NULL
  `).run();

  const eventColumns = getColumnNames(database, 'assistant_response_events');
  const eventColumnDefinitions = {
    event_id: 'TEXT',
    turn_id: 'TEXT',
    generation: 'INTEGER CHECK (generation IS NULL OR generation >= 1)',
    trace_id: 'TEXT',
    causation_id: 'TEXT',
    producer: 'TEXT',
  };
  for (const [column, definition] of Object.entries(eventColumnDefinitions)) {
    if (!eventColumns.has(column)) {
      database.exec(`ALTER TABLE assistant_response_events ADD COLUMN ${column} ${definition}`);
    }
  }
  database.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_assistant_response_events_event_id
      ON assistant_response_events(event_id)
      WHERE event_id IS NOT NULL;
  `);

  const admissionColumns = getColumnNames(database, 'runtime_turn_admissions');
  const admissionColumnDefinitions = {
    turn_id: 'TEXT',
    generation: 'INTEGER CHECK (generation IS NULL OR generation >= 1)',
    runtime_lane_id: 'TEXT CHECK (runtime_lane_id IS NULL OR runtime_lane_id = \'runtime:shared\')',
  };
  for (const [column, definition] of Object.entries(admissionColumnDefinitions)) {
    if (!admissionColumns.has(column)) {
      database.exec(`ALTER TABLE runtime_turn_admissions ADD COLUMN ${column} ${definition}`);
    }
  }
  replaceCanonicalEventImmutabilityTriggers(database);
}

/**
 * Additive Core-owned storage for canonical reply outcomes and delivery facts.
 * Adapter-local network attempts remain outside this database; these tables
 * only hold the durable intent, adapter observations, and Core settlement.
 */
export function ensureAssistantReplyReliabilitySchema(database, options = {}) {
  ensureAssistantRunLedgerSchema(database, options);
  database.exec(`
    CREATE TABLE IF NOT EXISTS assistant_reply_outcomes (
      outcome_id TEXT PRIMARY KEY,
      request_id TEXT NOT NULL UNIQUE,
      turn_id TEXT NOT NULL,
      generation INTEGER NOT NULL CHECK (generation >= 1),
      trace_id TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('answer', 'silent', 'failure')),
      envelope_json TEXT NOT NULL,
      canonical_hash TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (request_id) REFERENCES assistant_requests(request_id) ON DELETE RESTRICT
    );

    CREATE TABLE IF NOT EXISTS assistant_reply_intents (
      intent_id TEXT PRIMARY KEY,
      request_id TEXT NOT NULL,
      trace_id TEXT NOT NULL,
      cause_kind TEXT NOT NULL CHECK (cause_kind IN ('run_terminal', 'task_effect')),
      cause_event_id TEXT NOT NULL,
      route_json TEXT NOT NULL,
      route_hash TEXT NOT NULL,
      disposition TEXT NOT NULL
        CHECK (disposition IN ('send', 'failure_notice', 'task_receipt')),
      payload_json TEXT NOT NULL,
      envelope_json TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      idempotency_key TEXT NOT NULL UNIQUE,
      canonical_hash TEXT NOT NULL,
      delivery_state TEXT NOT NULL DEFAULT 'pending'
        CHECK (delivery_state IN (
          'pending', 'sending', 'reconcile_required', 'retrying',
          'accepted', 'unpresentable'
        )),
      attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
      current_attempt_id TEXT,
      claim_epoch INTEGER NOT NULL DEFAULT 0 CHECK (claim_epoch >= 0),
      lease_owner TEXT,
      lease_token TEXT,
      lease_expires_at INTEGER,
      available_at INTEGER NOT NULL,
      redrive_count INTEGER NOT NULL DEFAULT 0 CHECK (redrive_count >= 0),
      delivery_generation INTEGER NOT NULL DEFAULT 0 CHECK (delivery_generation >= 0),
      generation_attempt_count INTEGER NOT NULL DEFAULT 0
        CHECK (generation_attempt_count >= 0),
      last_error TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (request_id) REFERENCES assistant_requests(request_id) ON DELETE RESTRICT
    );

    CREATE INDEX IF NOT EXISTS idx_assistant_reply_intents_ready
      ON assistant_reply_intents(delivery_state, available_at, created_at, intent_id);
    CREATE INDEX IF NOT EXISTS idx_assistant_reply_intents_request
      ON assistant_reply_intents(request_id, created_at, intent_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_assistant_reply_intents_run_terminal
      ON assistant_reply_intents(cause_event_id)
      WHERE cause_kind = 'run_terminal';

    CREATE TABLE IF NOT EXISTS assistant_verified_task_effects (
      event_id TEXT PRIMARY KEY,
      effect_id TEXT NOT NULL UNIQUE,
      task_id TEXT NOT NULL,
      request_id TEXT NOT NULL,
      trace_id TEXT NOT NULL,
      route_json TEXT NOT NULL,
      disposition TEXT NOT NULL CHECK (disposition = 'task_receipt'),
      payload_json TEXT NOT NULL,
      fact_json TEXT NOT NULL,
      canonical_hash TEXT NOT NULL,
      applied_at INTEGER NOT NULL,
      FOREIGN KEY (request_id) REFERENCES assistant_requests(request_id) ON DELETE RESTRICT
    );

    CREATE TABLE IF NOT EXISTS assistant_delivery_receipts (
      receipt_id TEXT PRIMARY KEY,
      intent_id TEXT NOT NULL,
      delivery_id TEXT NOT NULL,
      request_id TEXT NOT NULL,
      attempt_id TEXT NOT NULL,
      claim_action TEXT NOT NULL CHECK (claim_action IN ('send', 'reconcile')),
      claim_epoch INTEGER NOT NULL CHECK (claim_epoch >= 1),
      delivery_generation INTEGER NOT NULL DEFAULT 0 CHECK (delivery_generation >= 0),
      lease_token TEXT NOT NULL,
      trace_id TEXT NOT NULL,
      adapter_id TEXT NOT NULL,
      outcome TEXT NOT NULL
        CHECK (outcome IN ('platform_accepted', 'unknown', 'reconciled', 'rejected')),
      envelope_json TEXT NOT NULL,
      canonical_hash TEXT NOT NULL,
      observed_at TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (intent_id) REFERENCES assistant_reply_intents(intent_id) ON DELETE RESTRICT
    );

    CREATE INDEX IF NOT EXISTS idx_assistant_delivery_receipts_intent
      ON assistant_delivery_receipts(intent_id, created_at, receipt_id);

    CREATE TABLE IF NOT EXISTS assistant_delivery_settlements (
      settlement_id TEXT PRIMARY KEY,
      intent_id TEXT NOT NULL,
      delivery_id TEXT NOT NULL,
      request_id TEXT NOT NULL,
      trace_id TEXT NOT NULL,
      adapter_id TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('accepted', 'unpresentable')),
      basis TEXT NOT NULL CHECK (basis IN ('platform_accepted', 'reconciled', 'retry_exhausted')),
      presented INTEGER NOT NULL CHECK (presented IN (0, 1)),
      delivery_generation INTEGER NOT NULL DEFAULT 0 CHECK (delivery_generation >= 0),
      envelope_json TEXT NOT NULL,
      canonical_hash TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (intent_id) REFERENCES assistant_reply_intents(intent_id) ON DELETE RESTRICT
    );

    CREATE INDEX IF NOT EXISTS idx_assistant_delivery_settlements_intent
      ON assistant_delivery_settlements(intent_id, created_at, settlement_id);
    CREATE TABLE IF NOT EXISTS assistant_event_consumers (
      consumer_id TEXT PRIMARY KEY,
      bootstrap_mode TEXT NOT NULL DEFAULT 'canonical_cutover'
        CHECK (bootstrap_mode = 'canonical_cutover'),
      start_event_row_id INTEGER NOT NULL DEFAULT 1 CHECK (start_event_row_id >= 1),
      cutover_event_row_id INTEGER NOT NULL DEFAULT 0 CHECK (cutover_event_row_id >= 0),
      legacy_skipped_count INTEGER NOT NULL DEFAULT 0 CHECK (legacy_skipped_count >= 0),
      health_status TEXT NOT NULL DEFAULT 'active'
        CHECK (health_status IN ('active', 'degraded')),
      degraded_reason TEXT,
      degraded_event_row_id INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS assistant_event_deliveries (
      consumer_id TEXT NOT NULL,
      event_row_id INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'processing', 'acknowledged')),
      retry_count INTEGER NOT NULL DEFAULT 0 CHECK (retry_count >= 0),
      claim_epoch INTEGER NOT NULL DEFAULT 0 CHECK (claim_epoch >= 0),
      available_at INTEGER NOT NULL,
      lease_owner TEXT,
      lease_token TEXT,
      lease_expires_at INTEGER,
      last_error TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      acknowledged_at INTEGER,
      event_fingerprint TEXT NOT NULL,
      PRIMARY KEY (consumer_id, event_row_id),
      FOREIGN KEY (consumer_id) REFERENCES assistant_event_consumers(consumer_id) ON DELETE RESTRICT,
      FOREIGN KEY (event_row_id) REFERENCES assistant_response_events(id) ON DELETE RESTRICT
    );

    CREATE INDEX IF NOT EXISTS idx_assistant_event_deliveries_ready
      ON assistant_event_deliveries(consumer_id, status, available_at, event_row_id);
    CREATE INDEX IF NOT EXISTS idx_assistant_event_deliveries_stream
      ON assistant_event_deliveries(consumer_id, event_row_id, status);

    CREATE TABLE IF NOT EXISTS assistant_event_stream_health (
      consumer_id TEXT NOT NULL,
      request_id TEXT NOT NULL,
      health_status TEXT NOT NULL DEFAULT 'active'
        CHECK (health_status IN ('active', 'degraded')),
      degraded_reason TEXT,
      degraded_event_row_id INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (consumer_id, request_id),
      FOREIGN KEY (consumer_id) REFERENCES assistant_event_consumers(consumer_id) ON DELETE RESTRICT,
      FOREIGN KEY (request_id) REFERENCES assistant_requests(request_id) ON DELETE RESTRICT
    );

    CREATE INDEX IF NOT EXISTS idx_assistant_event_stream_health_status
      ON assistant_event_stream_health(consumer_id, health_status, request_id);

    CREATE TRIGGER IF NOT EXISTS assistant_response_events_canonical_immutable
    BEFORE UPDATE OF
      id, request_id, sequence, event_type, payload_json, idempotency_key,
      event_id, turn_id, generation, trace_id, causation_id, producer, created_at
    ON assistant_response_events
    WHEN OLD.event_id IS NOT NULL
    BEGIN
      SELECT RAISE(ABORT, 'canonical assistant event is immutable');
    END;

    CREATE TRIGGER IF NOT EXISTS assistant_response_events_canonical_id_immutable
    BEFORE UPDATE OF id ON assistant_response_events
    WHEN OLD.event_id IS NOT NULL
    BEGIN
      SELECT RAISE(ABORT, 'canonical assistant event is immutable');
    END;

    CREATE TRIGGER IF NOT EXISTS assistant_response_events_canonical_no_delete
    BEFORE DELETE ON assistant_response_events
    WHEN OLD.event_id IS NOT NULL
    BEGIN
      SELECT RAISE(ABORT, 'canonical assistant event is immutable');
    END;

    CREATE TRIGGER IF NOT EXISTS assistant_reply_outcomes_immutable
    BEFORE UPDATE ON assistant_reply_outcomes
    BEGIN
      SELECT RAISE(ABORT, 'canonical ReplyOutcome is immutable');
    END;

    CREATE TRIGGER IF NOT EXISTS assistant_reply_outcomes_no_delete
    BEFORE DELETE ON assistant_reply_outcomes
    BEGIN
      SELECT RAISE(ABORT, 'canonical ReplyOutcome is immutable');
    END;
  `);

  const intentColumns = getColumnNames(database, 'assistant_reply_intents');
  const migratedUnfencedIntentLeases = !intentColumns.has('claim_epoch');
  if (migratedUnfencedIntentLeases) {
    database.exec(`
      ALTER TABLE assistant_reply_intents
      ADD COLUMN claim_epoch INTEGER NOT NULL DEFAULT 0 CHECK (claim_epoch >= 0)
    `);
    database.prepare(`
      UPDATE assistant_reply_intents
      SET claim_epoch = 1
    `).run();
    database.prepare(`
      UPDATE assistant_reply_intents
      SET delivery_state = CASE
            WHEN delivery_state = 'sending' THEN 'reconcile_required'
            ELSE delivery_state
          END,
          lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL,
          last_error = 'LEGACY_LEASE_EPOCH_UNPROVEN'
      WHERE delivery_state IN ('sending', 'reconcile_required')
        OR lease_token IS NOT NULL OR lease_owner IS NOT NULL OR lease_expires_at IS NOT NULL
    `).run();
  }

  if (!intentColumns.has('delivery_generation')) {
    database.exec(`
      ALTER TABLE assistant_reply_intents
      ADD COLUMN delivery_generation INTEGER NOT NULL DEFAULT 0 CHECK (delivery_generation >= 0)
    `);
    database.exec(`
      UPDATE assistant_reply_intents SET delivery_generation = redrive_count
    `);
  }
  if (!intentColumns.has('generation_attempt_count')) {
    database.exec(`
      ALTER TABLE assistant_reply_intents
      ADD COLUMN generation_attempt_count INTEGER NOT NULL DEFAULT 0
        CHECK (generation_attempt_count >= 0)
    `);
    database.exec(`
      UPDATE assistant_reply_intents
      SET generation_attempt_count = CASE
        WHEN redrive_count = 0 THEN attempt_count
        WHEN current_attempt_id IS NOT NULL THEN 1
        ELSE 0
      END
    `);
  }

  const receiptColumns = getColumnNames(database, 'assistant_delivery_receipts');
  const receiptColumnDefinitions = {
    claim_action: "TEXT CHECK (claim_action IN ('send', 'reconcile'))",
    claim_epoch: 'INTEGER CHECK (claim_epoch >= 1)',
    delivery_generation: 'INTEGER NOT NULL DEFAULT 0 CHECK (delivery_generation >= 0)',
    lease_token: 'TEXT',
  };
  for (const [column, definition] of Object.entries(receiptColumnDefinitions)) {
    if (!receiptColumns.has(column)) {
      database.exec(`ALTER TABLE assistant_delivery_receipts ADD COLUMN ${column} ${definition}`);
    }
  }
  if (!receiptColumns.has('delivery_generation')) {
    const migrateReceiptGenerations = database.transaction(() => database.exec(`
      DROP TRIGGER IF EXISTS assistant_delivery_receipts_immutable;
      UPDATE assistant_delivery_receipts AS receipt
      SET delivery_generation = COALESCE((
        SELECT CASE
          WHEN intent.redrive_count = 0 THEN 0
          WHEN CAST(substr(
            receipt.attempt_id,
            length('attempt:delivery:' || receipt.intent_id) + 2
          ) AS INTEGER) > COALESCE((
            SELECT MAX(CAST(substr(
              prior.attempt_id,
              length('attempt:delivery:' || prior.intent_id) + 2
            ) AS INTEGER))
            FROM assistant_delivery_receipts AS prior
            WHERE prior.intent_id = receipt.intent_id AND prior.outcome = 'rejected'
          ), 0) THEN intent.redrive_count
          ELSE 0
        END
        FROM assistant_reply_intents AS intent
        WHERE intent.intent_id = receipt.intent_id
      ), 0)
      ;
      CREATE TRIGGER assistant_delivery_receipts_immutable
      BEFORE UPDATE ON assistant_delivery_receipts
      BEGIN
        SELECT RAISE(ABORT, 'canonical DeliveryReceipt is immutable');
      END;
    `));
    migrateReceiptGenerations.immediate();
  }

  const settlementColumns = getColumnNames(database, 'assistant_delivery_settlements');
  if (!settlementColumns.has('delivery_generation')) {
    database.exec(`
      ALTER TABLE assistant_delivery_settlements
      ADD COLUMN delivery_generation INTEGER NOT NULL DEFAULT 0 CHECK (delivery_generation >= 0)
    `);
  }
  database.exec(`
    DROP INDEX IF EXISTS idx_assistant_delivery_settlements_one_terminal;
    CREATE UNIQUE INDEX idx_assistant_delivery_settlements_one_terminal
      ON assistant_delivery_settlements(intent_id, delivery_generation);
  `);

  // Trigger definitions are deliberately replaced, rather than guarded by
  // IF NOT EXISTS. Older databases may already have a trigger with the same
  // name but a narrower protected-column set.
  const replaceCanonicalImmutabilityTriggers = database.transaction(() => database.exec(`
    DROP TRIGGER IF EXISTS assistant_reply_outcomes_immutable;
    DROP TRIGGER IF EXISTS assistant_reply_outcomes_no_delete;
    DROP TRIGGER IF EXISTS assistant_reply_intents_canonical_immutable;
    DROP TRIGGER IF EXISTS assistant_reply_intents_canonical_no_delete;
    DROP TRIGGER IF EXISTS assistant_reply_intents_canonical_rowid_immutable;
    DROP TRIGGER IF EXISTS assistant_reply_intents_canonical_no_replace;
    DROP TRIGGER IF EXISTS assistant_verified_task_effects_immutable;
    DROP TRIGGER IF EXISTS assistant_verified_task_effects_no_delete;
    DROP TRIGGER IF EXISTS assistant_delivery_receipts_immutable;
    DROP TRIGGER IF EXISTS assistant_delivery_receipts_no_delete;
    DROP TRIGGER IF EXISTS assistant_delivery_settlements_immutable;
    DROP TRIGGER IF EXISTS assistant_delivery_settlements_no_delete;
    DROP TRIGGER IF EXISTS assistant_reply_outcomes_no_replace;
    DROP TRIGGER IF EXISTS assistant_verified_task_effects_no_replace;
    DROP TRIGGER IF EXISTS assistant_delivery_receipts_no_replace;
    DROP TRIGGER IF EXISTS assistant_delivery_settlements_no_replace;

    CREATE TRIGGER assistant_reply_outcomes_immutable
    BEFORE UPDATE ON assistant_reply_outcomes
    BEGIN
      SELECT RAISE(ABORT, 'canonical ReplyOutcome is immutable');
    END;

    CREATE TRIGGER assistant_reply_outcomes_no_delete
    BEFORE DELETE ON assistant_reply_outcomes
    BEGIN
      SELECT RAISE(ABORT, 'canonical ReplyOutcome is immutable');
    END;

    CREATE TRIGGER assistant_reply_outcomes_no_replace
    BEFORE INSERT ON assistant_reply_outcomes
    WHEN EXISTS (
      SELECT 1 FROM assistant_reply_outcomes
      WHERE outcome_id = NEW.outcome_id OR request_id = NEW.request_id
    )
    BEGIN
      SELECT RAISE(ABORT, 'canonical ReplyOutcome is immutable');
    END;

    CREATE TRIGGER assistant_reply_intents_canonical_immutable
    BEFORE UPDATE OF
      intent_id, request_id, trace_id, cause_kind, cause_event_id,
      route_json, route_hash, disposition, payload_json, envelope_json,
      content_hash, idempotency_key, canonical_hash, created_at
    ON assistant_reply_intents
    BEGIN
      SELECT RAISE(ABORT, 'canonical ReplyIntent is immutable');
    END;

    CREATE TRIGGER assistant_reply_intents_canonical_no_delete
    BEFORE DELETE ON assistant_reply_intents
    BEGIN
      SELECT RAISE(ABORT, 'canonical ReplyIntent is immutable');
    END;

    CREATE TRIGGER assistant_reply_intents_canonical_rowid_immutable
    BEFORE UPDATE OF rowid ON assistant_reply_intents
    BEGIN
      SELECT RAISE(ABORT, 'canonical ReplyIntent is immutable');
    END;

    CREATE TRIGGER assistant_reply_intents_canonical_no_replace
    BEFORE INSERT ON assistant_reply_intents
    WHEN EXISTS (
      SELECT 1 FROM assistant_reply_intents
      WHERE intent_id = NEW.intent_id OR idempotency_key = NEW.idempotency_key
        OR (NEW.cause_kind = 'run_terminal' AND cause_kind = 'run_terminal'
            AND cause_event_id = NEW.cause_event_id)
    )
    BEGIN
      SELECT RAISE(ABORT, 'canonical ReplyIntent is immutable');
    END;

    CREATE TRIGGER assistant_verified_task_effects_immutable
    BEFORE UPDATE ON assistant_verified_task_effects
    BEGIN
      SELECT RAISE(ABORT, 'verified TaskEffect fact is immutable');
    END;

    CREATE TRIGGER assistant_verified_task_effects_no_delete
    BEFORE DELETE ON assistant_verified_task_effects
    BEGIN
      SELECT RAISE(ABORT, 'verified TaskEffect fact is immutable');
    END;

    CREATE TRIGGER assistant_verified_task_effects_no_replace
    BEFORE INSERT ON assistant_verified_task_effects
    WHEN EXISTS (
      SELECT 1 FROM assistant_verified_task_effects
      WHERE event_id = NEW.event_id OR effect_id = NEW.effect_id
    )
    BEGIN
      SELECT RAISE(ABORT, 'verified TaskEffect fact is immutable');
    END;

    CREATE TRIGGER assistant_delivery_receipts_immutable
    BEFORE UPDATE ON assistant_delivery_receipts
    BEGIN
      SELECT RAISE(ABORT, 'canonical DeliveryReceipt is immutable');
    END;

    CREATE TRIGGER assistant_delivery_receipts_no_delete
    BEFORE DELETE ON assistant_delivery_receipts
    BEGIN
      SELECT RAISE(ABORT, 'canonical DeliveryReceipt is immutable');
    END;

    CREATE TRIGGER assistant_delivery_receipts_no_replace
    BEFORE INSERT ON assistant_delivery_receipts
    WHEN EXISTS (
      SELECT 1 FROM assistant_delivery_receipts WHERE receipt_id = NEW.receipt_id
    )
    BEGIN
      SELECT RAISE(ABORT, 'canonical DeliveryReceipt is immutable');
    END;

    CREATE TRIGGER assistant_delivery_settlements_immutable
    BEFORE UPDATE ON assistant_delivery_settlements
    BEGIN
      SELECT RAISE(ABORT, 'canonical DeliverySettlement is immutable');
    END;

    CREATE TRIGGER assistant_delivery_settlements_no_delete
    BEFORE DELETE ON assistant_delivery_settlements
    BEGIN
      SELECT RAISE(ABORT, 'canonical DeliverySettlement is immutable');
    END;

    CREATE TRIGGER assistant_delivery_settlements_no_replace
    BEFORE INSERT ON assistant_delivery_settlements
    WHEN EXISTS (
      SELECT 1 FROM assistant_delivery_settlements
      WHERE settlement_id = NEW.settlement_id
         OR (intent_id = NEW.intent_id AND delivery_generation = NEW.delivery_generation)
    )
    BEGIN
      SELECT RAISE(ABORT, 'canonical DeliverySettlement is immutable');
    END;
  `));
  replaceCanonicalImmutabilityTriggers.immediate();

  const consumerColumns = getColumnNames(database, 'assistant_event_consumers');
  const migratedUnprovenConsumers = !consumerColumns.has('bootstrap_mode');
  const consumerColumnDefinitions = {
    bootstrap_mode: "TEXT NOT NULL DEFAULT 'canonical_cutover' CHECK (bootstrap_mode = 'canonical_cutover')",
    start_event_row_id: 'INTEGER NOT NULL DEFAULT 1 CHECK (start_event_row_id >= 1)',
    cutover_event_row_id: 'INTEGER NOT NULL DEFAULT 0 CHECK (cutover_event_row_id >= 0)',
    legacy_skipped_count: 'INTEGER NOT NULL DEFAULT 0 CHECK (legacy_skipped_count >= 0)',
    health_status: "TEXT NOT NULL DEFAULT 'active' CHECK (health_status IN ('active', 'degraded'))",
    degraded_reason: 'TEXT',
    degraded_event_row_id: 'INTEGER',
  };
  for (const [column, definition] of Object.entries(consumerColumnDefinitions)) {
    if (!consumerColumns.has(column)) {
      database.exec(`ALTER TABLE assistant_event_consumers ADD COLUMN ${column} ${definition}`);
    }
  }
  if (migratedUnprovenConsumers) {
    database.prepare(`
      UPDATE assistant_event_consumers
      SET health_status = 'degraded',
          degraded_reason = 'LEGACY_SUBSCRIPTION_STATE_UNPROVEN'
    `).run();
  }

  const deliveryColumns = getColumnNames(database, 'assistant_event_deliveries');
  if (!deliveryColumns.has('claim_epoch')) {
    database.exec(`
      ALTER TABLE assistant_event_deliveries
      ADD COLUMN claim_epoch INTEGER NOT NULL DEFAULT 0 CHECK (claim_epoch >= 0)
    `);
  }
  if (!deliveryColumns.has('event_fingerprint')) {
    database.exec('ALTER TABLE assistant_event_deliveries ADD COLUMN event_fingerprint TEXT');
  }
}

function toCommitmentIntakeView(row) {
  if (!row) return null;
  return {
    id: row.id,
    conversationId: row.conversation_id,
    idempotencyKey: row.idempotency_key,
    envelope: JSON.parse(row.payload_json),
    status: row.status,
    retryCount: row.retry_count,
    retryGeneration: row.retry_generation,
    availableAt: row.available_at,
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Open the durable C4 → Commitment Core intake Module.
 *
 * The Interface owns the conversation/intake transaction and exposes queue
 * state without leaking SQL or payload serialization to callers.
 */
export function openCommitmentIntakeQueue({
  dbPath = null,
  clock = nowSeconds,
  beforeQueueInsert = null,
} = {}) {
  let ownsDatabase = false;
  let database;
  if (dbPath) {
    if (dbPath !== ':memory:') {
      fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    }
    const isNew = dbPath === ':memory:' || !fs.existsSync(dbPath);
    database = openDatabaseWithSchemaRetry(
      () => {
        const connection = new Database(dbPath);
        connection.pragma('busy_timeout = 5000');
        connection.pragma('foreign_keys = ON');
        if (dbPath !== ':memory:') connection.pragma('journal_mode = WAL');
        return connection;
      },
      (connection) => {
        if (isNew) connection.exec(fs.readFileSync(INIT_SQL_PATH, 'utf8'));
        ensureConversationsSchema(connection);
        ensureControlQueueSchema(connection);
        ensureStatusNoticeCooldownSchema(connection);
        ensureCommitmentIntakeSchema(connection);
        ensureVoidChannelMigration(connection);
      },
      {
        log: (event) => console.warn(`[C4-DB] ${event.event} attempt=${event.attempt} delayMs=${event.delayMs} error=${event.error}`),
      },
    );
    ownsDatabase = true;
  } else {
    database = getDb();
  }
  const selectByIdempotencyKey = database.prepare(`
    SELECT id, conversation_id, idempotency_key, payload_json, status,
           retry_count, retry_generation, available_at, last_error, created_at, updated_at
    FROM commitment_intake_queue
    WHERE idempotency_key = ?
  `);
  const selectIntakeById = database.prepare(`
    SELECT id, conversation_id, idempotency_key, payload_json, status,
           retry_count, retry_generation, available_at, last_error, created_at, updated_at
    FROM commitment_intake_queue
    WHERE id = ?
  `);
  const selectConversationById = database.prepare(`
    SELECT id, direction, channel, endpoint_id, content, status,
           delivery_action, priority, require_idle, retry_count
    FROM conversations
    WHERE id = ?
  `);

  const recordInboundTransaction = database.transaction(({ conversation, envelope }) => {
    const current = clock();
    const payloadJson = serializeTaskEnvelope(envelope);
    const existingIntake = selectByIdempotencyKey.get(envelope.idempotencyKey);
    if (existingIntake) {
      if (existingIntake.payload_json !== payloadJson) {
        const error = new Error(`intake idempotency key belongs to different payload: ${envelope.idempotencyKey}`);
        error.code = 'IDEMPOTENCY_CONFLICT';
        throw error;
      }
      return {
        created: false,
        conversation: selectConversationById.get(existingIntake.conversation_id),
        intake: toCommitmentIntakeView(existingIntake),
        intakeId: existingIntake.id,
      };
    }
    const finalStatus = conversation.status || 'pending';
    const requireIdle = conversation.requireIdle ? 1 : 0;
    const conversationResult = database.prepare(`
      INSERT INTO conversations (
        direction, channel, endpoint_id, content, status, delivery_action,
        priority, require_idle
      ) VALUES ('in', ?, ?, ?, ?, ?, ?, ?)
    `).run(
      conversation.channel,
      conversation.endpointId ?? null,
      conversation.content,
      finalStatus,
      conversation.deliveryAction ?? null,
      conversation.priority ?? 3,
      requireIdle,
    );
    const conversationId = Number(conversationResult.lastInsertRowid);

    if (beforeQueueInsert) beforeQueueInsert({ conversationId, envelope });

    const intakeResult = database.prepare(`
      INSERT INTO commitment_intake_queue (
        conversation_id, idempotency_key, payload_json, status, retry_count, retry_generation,
        available_at, last_error, created_at, updated_at
      ) VALUES (?, ?, ?, 'pending', 0, 0, ?, NULL, ?, ?)
    `).run(
      conversationId,
      envelope.idempotencyKey,
      payloadJson,
      current,
      current,
      current,
    );
    const intake = selectByIdempotencyKey.get(envelope.idempotencyKey);

    return {
      created: true,
      conversation: {
        id: conversationId,
        direction: 'in',
        channel: conversation.channel,
        endpoint_id: conversation.endpointId ?? null,
        content: conversation.content,
        status: finalStatus,
        delivery_action: conversation.deliveryAction ?? null,
        priority: conversation.priority ?? 3,
        require_idle: requireIdle,
        retry_count: 0,
      },
      intake: toCommitmentIntakeView(intake),
      intakeId: Number(intakeResult.lastInsertRowid),
    };
  });
  const claimNextTransaction = database.transaction(({ staleAfterSeconds }) => {
    const current = clock();
    const staleBefore = current - staleAfterSeconds;
    database.prepare(`
      UPDATE commitment_intake_queue
      SET status = 'pending', available_at = ?, updated_at = ?,
          last_error = COALESCE(last_error, 'STALE_PROCESSING_RECOVERED')
      WHERE status = 'processing' AND updated_at <= ?
    `).run(current, current, staleBefore);

    const candidate = database.prepare(`
      SELECT id
      FROM commitment_intake_queue
      WHERE status = 'pending' AND available_at <= ?
      ORDER BY available_at ASC, id ASC
      LIMIT 1
    `).get(current);
    if (!candidate) return null;

    const claimed = database.prepare(`
      UPDATE commitment_intake_queue
      SET status = 'processing', updated_at = ?
      WHERE id = ? AND status = 'pending'
    `).run(current, candidate.id);
    if (claimed.changes !== 1) return null;
    return toCommitmentIntakeView(selectIntakeById.get(candidate.id));
  });
  const retryFailedTransaction = database.transaction(({ idempotencyKey }) => {
    if (typeof idempotencyKey !== 'string' || idempotencyKey.trim() === '') {
      throw new TypeError('idempotencyKey must be a non-empty string');
    }
    const existing = selectByIdempotencyKey.get(idempotencyKey.trim());
    if (!existing) {
      const error = new Error(`commitment intake not found: ${idempotencyKey.trim()}`);
      error.code = 'TASK_INTAKE_NOT_FOUND';
      throw error;
    }
    if (existing.status !== 'failed') {
      const error = new Error(`commitment intake is ${existing.status}, not failed`);
      error.code = 'TASK_INTAKE_NOT_FAILED';
      throw error;
    }
    const current = clock();
    const updated = database.prepare(`
      UPDATE commitment_intake_queue
      SET status = 'pending', retry_count = 0,
          retry_generation = retry_generation + 1,
          available_at = ?, last_error = NULL, updated_at = ?
      WHERE id = ? AND status = 'failed'
    `).run(current, current, existing.id);
    if (updated.changes !== 1) {
      const error = new Error(`commitment intake changed while retrying: ${existing.id}`);
      error.code = 'TASK_INTAKE_RETRY_CONFLICT';
      throw error;
    }
    database.prepare(`
      UPDATE conversations
      SET delivery_action = NULL
      WHERE id = ? AND delivery_action = 'task-intake-failed'
    `).run(existing.conversation_id);
    return toCommitmentIntakeView(selectIntakeById.get(existing.id));
  });

  return Object.freeze({
    recordInbound(input) {
      return recordInboundTransaction.immediate(input);
    },
    get({ idempotencyKey } = {}) {
      return toCommitmentIntakeView(selectByIdempotencyKey.get(idempotencyKey));
    },
    claimNext({ staleAfterSeconds = 60 } = {}) {
      return claimNextTransaction.immediate({ staleAfterSeconds });
    },
    retryFailed(request) {
      return retryFailedTransaction.immediate(request || {});
    },
    markCompleted(intakeId) {
      const current = clock();
      const updated = database.prepare(`
        UPDATE commitment_intake_queue
        SET status = 'completed', last_error = NULL, updated_at = ?
        WHERE id = ? AND status = 'processing'
      `).run(current, intakeId);
      if (updated.changes !== 1) {
        throw new Error(`cannot complete commitment intake ${intakeId}`);
      }
      return toCommitmentIntakeView(selectIntakeById.get(intakeId));
    },
    retryOrFail(intakeId, lastError, { maxRetries = 3, delaySeconds = 5 } = {}) {
      const transition = database.transaction(() => {
        const currentRow = selectIntakeById.get(intakeId);
        if (!currentRow || currentRow.status !== 'processing') return null;

        const current = clock();
        const nextRetryCount = currentRow.retry_count + 1;
        const nextStatus = nextRetryCount >= maxRetries ? 'failed' : 'pending';
        const availableAt = nextStatus === 'pending' ? current + delaySeconds : current;
        database.prepare(`
          UPDATE commitment_intake_queue
          SET status = ?, retry_count = ?, available_at = ?,
              last_error = ?, updated_at = ?
          WHERE id = ? AND status = 'processing'
        `).run(
          nextStatus,
          nextRetryCount,
          availableAt,
          String(lastError),
          current,
          intakeId,
        );
        if (nextStatus === 'failed') {
          database.prepare(`
            UPDATE conversations
            SET delivery_action = 'task-intake-failed'
            WHERE id = ?
          `).run(currentRow.conversation_id);
        }
        return toCommitmentIntakeView(selectIntakeById.get(intakeId));
      }).immediate();
      return transition;
    },
    updateConversation({ conversationId, content, status, deliveryAction = null }) {
      database.prepare(`
        UPDATE conversations
        SET content = ?, status = ?, delivery_action = ?
        WHERE id = ? AND direction = 'in'
      `).run(content, status, deliveryAction, conversationId);
      return selectConversationById.get(conversationId) || null;
    },
    close() {
      if (ownsDatabase) {
        database.close();
        ownsDatabase = false;
      }
    },
  });
}

/**
 * Insert a conversation record
 * @param {string} direction - 'in' or 'out'
 * @param {string} channel - 'telegram', 'lark', 'scheduler', 'system', etc.
 * @param {string|null} endpointId - chat_id or null
 * @param {string} content - message content
 * @param {string} status - 'pending' or 'delivered' (default: 'pending' for in, 'delivered' for out)
 * @param {number} priority - 1=urgent, 2=high, 3=normal (default: 3)
 * @param {boolean} requireIdle - whether to wait for Claude idle state (default: false)
 * @param {string|null} deliveryAction - optional delivery/audit action label
 * @param {string|null} assistantRequestId - durable assistant response identity, when applicable
 * @returns {object} - inserted record with id
 */
export function insertConversation(
  direction,
  channel,
  endpointId,
  content,
  status = null,
  priority = 3,
  requireIdle = false,
  deliveryAction = null,
  assistantRequestId = null,
) {
  const db = getDb();

  // Default status: 'pending' for incoming, 'delivered' for outgoing
  const finalStatus = status || (direction === 'in' ? 'pending' : 'delivered');

  const requireIdleVal = requireIdle ? 1 : 0;

  const stmt = db.prepare(`
    INSERT INTO conversations (
      direction, channel, endpoint_id, content, status, delivery_action,
      priority, require_idle, assistant_request_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const result = stmt.run(
    direction,
    channel,
    endpointId,
    content,
    finalStatus,
    deliveryAction,
    priority,
    requireIdleVal,
    assistantRequestId,
  );

  return {
    id: result.lastInsertRowid,
    direction,
    channel,
    endpoint_id: endpointId,
    content,
    status: finalStatus,
    delivery_action: deliveryAction,
    assistant_request_id: assistantRequestId,
    priority,
    require_idle: requireIdleVal,
    retry_count: 0
  };
}

/**
 * Reserve or suppress an unhealthy/status notice cooldown.
 * Uses SQLite as the comm-bridge persistence/concurrency boundary so
 * concurrent c4-receive processes cannot both reserve the same cooldown key.
 */
export function reserveStatusNoticeCooldown({
  cooldownKey,
  channel,
  endpoint,
  statusType,
  reason,
  ttl,
  now = nowSeconds()
}) {
  const database = getDb();
  const expiresAt = now + ttl;

  const tx = database.transaction(() => {
    database.prepare('DELETE FROM status_notice_cooldowns WHERE expires_at <= ?').run(now);

    const insertResult = database.prepare(`
      INSERT OR IGNORE INTO status_notice_cooldowns (
        cooldown_key, channel, endpoint, status_type, reason,
        last_notified_at, expires_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(cooldownKey, channel, endpoint, statusType, reason, now, expiresAt, now);

    if (insertResult.changes === 1) {
      return { suppressed: false, key: cooldownKey, ttl, reservedAt: now, expiresAt };
    }

    const previous = database.prepare(`
      SELECT cooldown_key, channel, endpoint, status_type, reason,
             last_notified_at, expires_at, updated_at
      FROM status_notice_cooldowns
      WHERE cooldown_key = ?
    `).get(cooldownKey);

    return { suppressed: true, key: cooldownKey, ttl, previous };
  });

  return tx();
}

export function clearStatusNoticeCooldownReservation(cooldownKey, reservedAt) {
  const database = getDb();
  database.prepare(`
    DELETE FROM status_notice_cooldowns
    WHERE cooldown_key = ? AND last_notified_at = ?
  `).run(cooldownKey, reservedAt);
}

export function getStatusNoticeCooldowns() {
  const database = getDb();
  return database.prepare(`
    SELECT cooldown_key, channel, endpoint, status_type, reason,
           last_notified_at, expires_at, updated_at
    FROM status_notice_cooldowns
    ORDER BY cooldown_key ASC
  `).all();
}

/**
 * Get next pending message from queue (priority-based, then FIFO)
 * @returns {object|null} - highest priority pending message or null
 */
export function getNextPending() {
  const db = getDb();
  return db.prepare(`
    SELECT c.id, c.direction, c.channel, c.endpoint_id, c.content, c.timestamp,
           c.priority, c.require_idle, c.retry_count,
           ar.request_id AS assistant_request_id
    FROM conversations c
    LEFT JOIN assistant_requests ar ON ar.conversation_id = c.id
    WHERE c.direction = 'in' AND c.status = 'pending'
    ORDER BY COALESCE(c.priority, 3) ASC, c.timestamp ASC
    LIMIT 1
  `).get() || null;
}

/**
 * Atomically claim a pending conversation message to running
 * @param {number} id - conversation id
 * @returns {boolean}
 */
export function claimConversation(id) {
  const db = getDb();
  const result = db.prepare(`
    UPDATE conversations
    SET status = 'running'
    WHERE id = ? AND direction = 'in' AND status = 'pending'
  `).run(id);
  return result.changes > 0;
}

/**
 * Return a running message back to pending state
 * @param {number} id - conversation id
 */
export function requeueConversation(id) {
  const db = getDb();
  db.prepare(`
    UPDATE conversations
    SET status = 'pending'
    WHERE id = ? AND direction = 'in' AND status = 'running'
  `).run(id);
}

/**
 * Mark a message as delivered
 * @param {number} id - message id
 */
export function markDelivered(id) {
  const db = getDb();
  db.prepare('UPDATE conversations SET status = ? WHERE id = ?').run('delivered', id);
}

/**
 * Increment retry count for a message
 * @param {number} id - message id
 * @returns {number} - new retry count
 */
export function incrementRetryCount(id) {
  const db = getDb();
  db.prepare('UPDATE conversations SET retry_count = COALESCE(retry_count, 0) + 1 WHERE id = ?').run(id);
  const row = db.prepare('SELECT retry_count FROM conversations WHERE id = ?').get(id);
  return row?.retry_count || 0;
}

/**
 * Mark a message as failed
 * @param {number} id - message id
 */
export function markFailed(id) {
  const db = getDb();
  db.prepare('UPDATE conversations SET status = ? WHERE id = ?').run('failed', id);
}

/**
 * Get count of pending messages
 * @returns {number}
 */
export function getPendingCount() {
  const db = getDb();
  const result = db.prepare(`
    SELECT COUNT(*) as count FROM conversations
    WHERE direction = 'in' AND status = 'pending'
  `).get();
  return result?.count || 0;
}

/**
 * Get count of pending control items
 * @returns {number}
 */
export function getPendingControlCount() {
  const db = getDb();
  const result = db.prepare(`
    SELECT COUNT(*) as count FROM control_queue
    WHERE status = 'pending'
  `).get();
  return result?.count || 0;
}

/**
 * Insert a control queue record
 * @param {string} content - instruction content
 * @param {object} options - queue options
 * @param {boolean} [options.appendAckSuffix=true] - append "ack via" suffix to content
 * @returns {object} inserted control record
 */
export function insertControl(content, options = {}) {
  const database = getDb();
  const {
    priority = 3,
    requireIdle = false,
    bypassState = false,
    ackDeadlineAt = null,
    availableAt = null,
    appendAckSuffix = true
  } = options;

  const tx = database.transaction(() => {
    const current = nowSeconds();
    const insertStmt = database.prepare(`
      INSERT INTO control_queue (
        raw_content, content, priority, require_idle, bypass_state, ack_deadline_at,
        status, retry_count, available_at, last_error, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, 'pending', 0, ?, NULL, ?, ?)
    `);

    const result = insertStmt.run(
      content,
      content,
      priority,
      requireIdle ? 1 : 0,
      bypassState ? 1 : 0,
      ackDeadlineAt,
      availableAt,
      current,
      current
    );

    const id = Number(result.lastInsertRowid);

    let finalContent = content;
    if (appendAckSuffix) {
      // Control acknowledgements are stored with the queued control item so
      // the ack ID remains attached to the exact work item being delivered.
      const controlScriptPath = path.join(__dirname, 'c4-control.js');
      const ackSuffix = ` ---- ack via: node ${controlScriptPath} ack --id ${id}`;
      finalContent = content + ackSuffix;
    }

    database.prepare(`
      UPDATE control_queue
      SET content = ?, updated_at = ?
      WHERE id = ?
    `).run(finalContent, current, id);

    const supersedeResult = database.prepare(`
      UPDATE control_queue
      SET status = 'superseded', updated_at = ?, last_error = NULL
      WHERE id != ?
        AND status = 'pending'
        AND raw_content = ?
    `).run(
      current,
      id,
      content
    );

    const row = database.prepare(`
      SELECT id, raw_content, content, priority, require_idle, bypass_state, ack_deadline_at,
             status, retry_count, available_at, last_error, created_at, updated_at
      FROM control_queue
      WHERE id = ?
    `).get(id);

    return {
      ...row,
      superseded_count: supersedeResult.changes || 0
    };
  });

  return tx();
}

/**
 * Get one control record by id
 * @param {number} id - control id
 * @returns {object|null}
 */
export function getControlById(id) {
  const database = getDb();
  return database.prepare(`
    SELECT id, raw_content, content, priority, require_idle, bypass_state, ack_deadline_at,
           status, retry_count, available_at, last_error, created_at, updated_at
    FROM control_queue
    WHERE id = ?
  `).get(id) || null;
}

/**
 * Get next pending control item by priority/FIFO order
 * @param {number} current - unix seconds
 * @returns {object|null}
 */
export function getNextPendingControl(current = nowSeconds()) {
  const database = getDb();
  return database.prepare(`
    SELECT id, raw_content, content, priority, require_idle, bypass_state, ack_deadline_at,
           status, retry_count, available_at, last_error, created_at, updated_at
    FROM control_queue
    WHERE status = 'pending'
      AND (available_at IS NULL OR available_at <= ?)
    ORDER BY COALESCE(priority, 3) ASC, id ASC
    LIMIT 1
  `).get(current) || null;
}

/**
 * Atomically claim a pending control item to running
 * @param {number} id - control id
 * @returns {boolean}
 */
export function claimControl(id) {
  const database = getDb();
  const result = database.prepare(`
    UPDATE control_queue
    SET status = 'running', updated_at = ?, last_error = NULL
    WHERE id = ? AND status = 'pending'
  `).run(nowSeconds(), id);
  return result.changes > 0;
}

/**
 * Return a running control record back to pending
 * @param {number} id - control id
 * @param {string|null} lastError - optional reason
 */
export function requeueControl(id, lastError = null) {
  const database = getDb();
  database.prepare(`
    UPDATE control_queue
    SET status = 'pending', updated_at = ?, last_error = COALESCE(?, last_error)
    WHERE id = ? AND status = 'running'
  `).run(nowSeconds(), lastError, id);
}

/**
 * Mark control as done via ack (idempotent for final states)
 * @param {number} id - control id
 * @returns {object} result
 */
export function ackControl(id) {
  const database = getDb();
  const tx = database.transaction((controlId) => {
    const row = database.prepare('SELECT status, ack_deadline_at FROM control_queue WHERE id = ?').get(controlId);
    if (!row) {
      return { found: false };
    }

    const current = nowSeconds();
    if (
      (row.status === 'pending' || row.status === 'running') &&
      row.ack_deadline_at !== null &&
      row.ack_deadline_at < current
    ) {
      database.prepare(`
        UPDATE control_queue
        SET status = 'timeout', updated_at = ?, last_error = COALESCE(last_error, 'ACK_DEADLINE_EXCEEDED')
        WHERE id = ?
      `).run(current, controlId);
      return { found: true, alreadyFinal: true, status: 'timeout' };
    }

    if (row.status === 'done' || row.status === 'failed' || row.status === 'timeout' || row.status === 'superseded') {
      return { found: true, alreadyFinal: true, status: row.status };
    }

    database.prepare(`
      UPDATE control_queue
      SET status = 'done', updated_at = ?, last_error = NULL
      WHERE id = ? AND status IN ('pending', 'running')
    `).run(current, controlId);

    return { found: true, alreadyFinal: false, status: 'done' };
  });

  return tx(id);
}

/**
 * Retry control delivery, or mark as failed when retries exceed max
 * @param {number} id - control id
 * @param {string} lastError - failure reason
 * @param {number} maxRetries - max retries before failure
 * @returns {object|null} transition info
 */
export function retryOrFailControl(id, lastError, maxRetries = CONTROL_MAX_RETRIES) {
  const database = getDb();
  const tx = database.transaction((controlId, errorMsg, retries) => {
    const row = database.prepare(`
      SELECT retry_count, status
      FROM control_queue
      WHERE id = ?
    `).get(controlId);

    if (!row) {
      return null;
    }

    const nextRetryCount = (row.retry_count || 0) + 1;
    const current = nowSeconds();

    if (nextRetryCount >= retries) {
      database.prepare(`
        UPDATE control_queue
        SET status = 'failed', retry_count = ?, last_error = ?, updated_at = ?
        WHERE id = ?
      `).run(nextRetryCount, errorMsg, current, controlId);
      return { status: 'failed', retry_count: nextRetryCount };
    }

    database.prepare(`
      UPDATE control_queue
      SET status = 'pending', retry_count = ?, last_error = ?, updated_at = ?
      WHERE id = ?
    `).run(nextRetryCount, errorMsg, current, controlId);

    return { status: 'pending', retry_count: nextRetryCount };
  });

  return tx(id, lastError, maxRetries);
}

/**
 * Mark matching control records timeout based on ack deadline
 * @param {number} current - unix seconds
 * @returns {number} updated rows
 */
export function expireTimedOutControls(current = nowSeconds()) {
  const database = getDb();
  const result = database.prepare(`
    UPDATE control_queue
    SET status = 'timeout', updated_at = ?, last_error = COALESCE(last_error, 'ACK_DEADLINE_EXCEEDED')
    WHERE status IN ('pending', 'running')
      AND ack_deadline_at IS NOT NULL
      AND ack_deadline_at < ?
  `).run(current, current);
  return result.changes || 0;
}

/**
 * Cleanup final control records older than cutoff
 * @param {number} cutoff - unix seconds
 * @returns {number} deleted rows
 */
export function cleanupControlQueue(cutoff) {
  const database = getDb();
  const result = database.prepare(`
    DELETE FROM control_queue
    WHERE status IN ('done', 'failed', 'timeout', 'superseded')
      AND updated_at < ?
  `).run(cutoff);
  return result.changes || 0;
}

/**
 * Create a checkpoint
 * @param {number} endConversationId - last conversation id covered by this checkpoint (caller determines the boundary)
 * @param {string|null} summary - checkpoint summary
 * @returns {object} - checkpoint record with id, start/end conversation ids
 */
export function createCheckpoint(endConversationId, summary = null) {
  const db = getDb();

  // start = previous checkpoint's end + 1 (or 1 if first checkpoint)
  const prevCheckpoint = db.prepare(
    'SELECT end_conversation_id FROM checkpoints ORDER BY id DESC LIMIT 1'
  ).get();

  const startId = prevCheckpoint ? (prevCheckpoint.end_conversation_id || 0) + 1 : 1;

  const stmt = db.prepare('INSERT INTO checkpoints (summary, start_conversation_id, end_conversation_id) VALUES (?, ?, ?)');
  const result = stmt.run(summary, startId, endConversationId);

  return {
    id: result.lastInsertRowid,
    start_conversation_id: startId,
    end_conversation_id: endConversationId,
    timestamp: new Date().toISOString()
  };
}

/**
 * Get the most recent checkpoint
 * @returns {object|null} - checkpoint record or null
 */
export function getLastCheckpoint() {
  const db = getDb();
  return db.prepare(
    'SELECT id, timestamp, summary, start_conversation_id, end_conversation_id FROM checkpoints ORDER BY id DESC LIMIT 1'
  ).get() || null;
}

/**
 * Get range and count of unsummarized conversations (after last checkpoint)
 * @returns {object} - { begin_id, end_id, count }
 */
export function getUnsummarizedRange() {
  const db = getDb();
  const lastCheckpoint = db.prepare(
    'SELECT end_conversation_id FROM checkpoints ORDER BY id DESC LIMIT 1'
  ).get();
  const afterId = lastCheckpoint?.end_conversation_id || 0;
  const result = db.prepare(
    'SELECT MIN(id) as begin_id, MAX(id) as end_id, COUNT(*) as count FROM conversations WHERE id > ?'
  ).get(afterId);
  return {
    begin_id: result?.begin_id || null,
    end_id: result?.end_id || null,
    count: result?.count || 0
  };
}

/**
 * Get unsummarized conversations (after last checkpoint)
 * @param {number|null} limit - if set, return only the most recent N records
 * @returns {array} - conversation records in chronological order
 */
export function getUnsummarizedConversations(limit = null) {
  const db = getDb();
  const lastCheckpoint = db.prepare(
    'SELECT end_conversation_id FROM checkpoints ORDER BY id DESC LIMIT 1'
  ).get();
  const afterId = lastCheckpoint?.end_conversation_id || 0;

  if (limit) {
    return db.prepare(
      'SELECT * FROM (SELECT * FROM conversations WHERE id > ? ORDER BY id DESC LIMIT ?) ORDER BY id ASC'
    ).all(afterId, limit);
  }

  return db.prepare(
    'SELECT * FROM conversations WHERE id > ? ORDER BY id ASC'
  ).all(afterId);
}

/**
 * Get conversations by id range (inclusive)
 * @param {number} beginId - start conversation id
 * @param {number} endId - end conversation id
 * @returns {array} - conversation records in chronological order
 */
export function getConversationsByRange(beginId, endId) {
  const db = getDb();
  return db.prepare(
    'SELECT * FROM conversations WHERE id >= ? AND id <= ? ORDER BY id ASC'
  ).all(beginId, endId);
}

/**
 * Get recent conversations (for debugging/testing)
 * @param {number} limit - max records to return
 * @returns {array} - latest N conversation records in chronological order
 */
export function getRecentConversations(limit = 20) {
  const db = getDb();
  return db.prepare(
    'SELECT * FROM (SELECT * FROM conversations ORDER BY timestamp DESC LIMIT ?) ORDER BY timestamp ASC, id ASC'
  ).all(limit);
}

/**
 * Get all checkpoints
 * @returns {array} - array of checkpoint records
 */
export function getCheckpoints() {
  const db = getDb();
  return db.prepare('SELECT * FROM checkpoints ORDER BY timestamp DESC').all();
}

/**
 * Format conversation records into readable text
 * @param {array} conversations - array of conversation records
 * @returns {string} - formatted text
 */
export function formatConversations(conversations) {
  if (!conversations || conversations.length === 0) {
    return '';
  }

  const lines = [];
  for (const conv of conversations) {
    const dir = conv.direction === 'in' ? 'IN' : 'OUT';
    const endpoint = conv.endpoint_id ? `:${conv.endpoint_id}` : '';
    lines.push(`[${conv.timestamp}] ${dir} (${conv.channel}${endpoint}):`);
    lines.push(conv.content);
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Format conversation records for agent-facing context. Unlike
 * formatConversations(), this adds reply routing only while each original
 * record is still available, never by post-processing the flattened output.
 * @param {array} conversations - array of conversation records
 * @param {object} [options]
 * @param {boolean} [options.spill=true] - when true, messages over the
 *   per-message delivery threshold are replaced by a preview + attachment
 *   pointer (dispatch-style). Pass false when a caller has its own size
 *   control (e.g. the session-start shard's whole-message budget packer)
 *   and wants original content inline (#724).
 * @returns {string} - formatted text for agent delivery/session init
 */
export function formatConversationsForAgent(conversations, { spill = true } = {}) {
  if (!conversations || conversations.length === 0) {
    return '';
  }

  const lines = [];
  for (const conv of conversations) {
    const dir = conv.direction === 'in' ? 'IN' : 'OUT';
    const endpoint = conv.endpoint_id ? `:${conv.endpoint_id}` : '';
    const content = conv.content || '';
    const replyViaSuffix = (
      conv.direction === 'in' &&
      conv.endpoint_id &&
      !hasLegacyReplyViaSuffix(content)
    ) ? buildReplyViaSuffix(conv.channel, conv.endpoint_id) : '';
    lines.push(`[${conv.timestamp}] ${dir} (${conv.channel}${endpoint}):`);
    lines.push(spill
      ? truncateForDelivery(content, replyViaSuffix, conv.id)
      : content + replyViaSuffix);
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Close database connection
 */
export function close() {
  if (db) {
    db.close();
    db = null;
  }
}

// CLI mode
const isMainModule = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];

if (isMainModule) {
  const args = process.argv.slice(2);
  const command = args[0];

  switch (command) {
    case 'init':
      getDb();
      console.log('Database initialized at:', DB_PATH);
      break;

    case 'insert':
      // insert <direction> <channel> <endpoint_id> <content>
      if (args.length < 5) {
        console.error('Usage: c4-db.js insert <direction> <channel> <endpoint_id> <content>');
        process.exit(1);
      }
      const record = insertConversation(args[1], args[2], args[3] === 'null' ? null : args[3], args[4]);
      console.log('Inserted:', JSON.stringify(record));
      break;

    case 'checkpoint':
      // checkpoint <end_conversation_id> [summary]
      if (args.length < 2) {
        console.error('Usage: c4-db.js checkpoint <end_conversation_id> [summary]');
        process.exit(1);
      }
      const cpEndId = parseInt(args[1]);
      if (isNaN(cpEndId)) {
        console.error('end_conversation_id must be a number');
        process.exit(1);
      }
      const cpSummary = args[2] || null;
      const cp = createCheckpoint(cpEndId, cpSummary);
      console.log('Checkpoint created:', JSON.stringify(cp));
      break;

    case 'unsummarized':
      const range = getUnsummarizedRange();
      console.log(JSON.stringify(range, null, 2));
      break;

    case 'recent':
      const limit = parseInt(args[1]) || 20;
      const recent = getRecentConversations(limit);
      console.log(JSON.stringify(recent, null, 2));
      break;

    case 'checkpoints':
      const cps = getCheckpoints();
      console.log(JSON.stringify(cps, null, 2));
      break;

    default:
      console.log(`C4 Database CLI

Usage: c4-db.js <command> [args]

Commands:
  init                                  Initialize database
  insert <dir> <channel> <endpoint> <content>  Insert conversation
  checkpoint <end_id> [summary]          Create checkpoint up to conversation id
  unsummarized                          Show unsummarized conversation range and count
  recent [limit]                        Get recent conversations
  checkpoints                           List all checkpoints
`);
  }

  close();
}
