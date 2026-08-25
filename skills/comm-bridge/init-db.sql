-- C4 Communication Bridge Database Schema
-- SQLite database for message logging and session management

-- Checkpoints table
CREATE TABLE IF NOT EXISTS checkpoints (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
    summary TEXT,
    start_conversation_id INTEGER, -- first conversation id in this checkpoint's range
    end_conversation_id INTEGER    -- last conversation id in this checkpoint's range
);

CREATE INDEX IF NOT EXISTS idx_checkpoints_timestamp ON checkpoints(timestamp);

-- Conversations table
CREATE TABLE IF NOT EXISTS conversations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
    direction TEXT NOT NULL,        -- 'in' | 'out'
    channel TEXT NOT NULL,          -- 'telegram' | 'lark' | 'scheduler' | 'system'
    endpoint_id TEXT,               -- chat_id, can be NULL (e.g., scheduler)
    content TEXT NOT NULL,          -- message content (large messages: preview + file path)
    status TEXT DEFAULT 'pending',  -- 'pending' | 'delivered' | 'failed' (for direction='in' queue)
    delivery_action TEXT,           -- optional action outcome, e.g. 'queued' | 'delivered' | 'suppressed'
    priority INTEGER DEFAULT 3,     -- 1=urgent, 2=high, 3=normal
    require_idle INTEGER DEFAULT 0, -- legacy/internal name for block_queue_until_idle behavior
    retry_count INTEGER DEFAULT 0   -- delivery retries for incoming queue
);

CREATE INDEX IF NOT EXISTS idx_conversations_timestamp ON conversations(timestamp);
CREATE INDEX IF NOT EXISTS idx_conversations_channel ON conversations(channel);
CREATE INDEX IF NOT EXISTS idx_conversations_status ON conversations(status);
CREATE INDEX IF NOT EXISTS idx_conversations_priority ON conversations(priority);

-- Control queue table (heartbeat/system control plane)
CREATE TABLE IF NOT EXISTS control_queue (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    raw_content TEXT NOT NULL,
    content TEXT NOT NULL,
    priority INTEGER DEFAULT 3,
    require_idle INTEGER DEFAULT 0, -- legacy/internal name for block_queue_until_idle behavior
    bypass_state INTEGER DEFAULT 0,
    ack_deadline_at INTEGER,
    status TEXT DEFAULT 'pending',
    retry_count INTEGER DEFAULT 0,
    available_at INTEGER,
    last_error TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_control_queue_status_priority_time
  ON control_queue(status, priority, created_at);
CREATE INDEX IF NOT EXISTS idx_control_queue_available_at
  ON control_queue(available_at);
CREATE INDEX IF NOT EXISTS idx_control_queue_ack_deadline
  ON control_queue(ack_deadline_at);
CREATE INDEX IF NOT EXISTS idx_control_queue_updated_at
  ON control_queue(updated_at);

-- C4 unhealthy/status notice cooldowns
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

-- Durable handoff from channel intake to Commitment Core
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

-- Runtime-neutral assistant response streams.  The event payloads in this
-- ledger are consumed by channel adapters; no channel SDK/CardKit fields live
-- here.
CREATE TABLE IF NOT EXISTS assistant_requests (
    request_id TEXT PRIMARY KEY,
    conversation_id INTEGER UNIQUE,
    route_channel TEXT NOT NULL,
    route_endpoint TEXT NOT NULL,
    source_id TEXT NOT NULL,
    status TEXT NOT NULL
      CHECK (status IN ('queued', 'started', 'completed', 'failed')),
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

-- Create initial checkpoint
INSERT INTO checkpoints (summary) VALUES ('initial');
