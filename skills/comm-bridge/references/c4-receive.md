# c4-receive.js — Receive Interface

Receives messages from external channels and queues them for delivery to Claude.

Messages are written to DB with `status='pending'`. The c4-dispatcher daemon handles serial delivery to Claude via tmux.

## Usage

```bash
~/zylos/.claude/skills/comm-bridge/scripts/c4-receive.js \
    --channel <channel> [options] --content "<message>"
```

## Options

| Option | Description |
|--------|-------------|
| `--channel <name>` | Channel name (required unless `--no-reply`) |
| `--endpoint <id>` | Endpoint identifier. Can contain multiple space-separated parts (e.g., `"chat_id topic_id"` for Feishu topics) |
| `--content <text>` | Message content (required) |
| `--priority <1-3>` | Priority level (default: 3) |
| `--no-reply` | Mark the message as having no reply target; defaults channel to `system` |
| `--block-queue-until-idle` | Wait for sustained idle, then block later dispatch until execution settles |
| `--task-envelope-json <json>` | Atomically persist a normalized task intent for Commitment Core |
| `--work-intake-envelope-json <json>` | Classify a channel-neutral natural-language `InboundEnvelope` |
| `--work-intake-confirmation-json <json>` | Resolve one persisted confirmation choice through Core |
| `--json` | Output structured JSON instead of plain text |

## Priority Levels

| Priority | Type | Description |
|----------|------|-------------|
| 1 | Urgent | System alerts, immediate execution |
| 2 | High | Important user messages |
| 3 | Normal | Default priority |

## Examples

```bash
# Standard user message from Telegram
~/zylos/.claude/skills/comm-bridge/scripts/c4-receive.js \
    --channel telegram --endpoint 8101553026 \
    --content '[TG DM] user said: hello'

# System message (no reply routing)
~/zylos/.claude/skills/comm-bridge/scripts/c4-receive.js \
    --channel system --priority 1 --no-reply \
    --content '[System] Check context usage'

# Idle-only delivery
~/zylos/.claude/skills/comm-bridge/scripts/c4-receive.js \
    --channel scheduler --block-queue-until-idle \
    --content 'Run daily report'

# Feishu topic (endpoint with multiple parts)
~/zylos/.claude/skills/comm-bridge/scripts/c4-receive.js \
    --channel feishu --endpoint "chat_xxx topic_yyy" \
    --content '[Feishu] user said: hello'

# Feishu task intent (canonical channel name is `feishu`)
~/zylos/.claude/skills/comm-bridge/scripts/c4-receive.js \
    --channel feishu --endpoint "chat_xxx|msg:om_xxx" \
    --content '[Feishu] 请创建客户回访任务' \
    --task-envelope-json '{"idempotencyKey":"feishu:om_xxx:task-intent","source":{"channel":"feishu","externalId":"om_xxx","senderId":"ou_owner"},"task":{"title":"客户回访","ownerId":"ou_owner"}}'
```

## Task Envelope Intake

`--task-envelope-json` is optional. Its JSON value must be an object with a
non-empty string `idempotencyKey` plus `source` and `task` objects. Required
non-empty strings are `source.channel`, `source.externalId`, `task.title`, and
`task.ownerId`. Optional `source.senderId`, `task.description`, and
`task.assigneeId` normalize to `null`; omitted `task.acceptorId` normalizes to
`task.ownerId`. Malformed JSON or field errors return `INVALID_ARGS` before any
database write.

For an explicit task intent, C4 commits the inbound conversation and
`commitment_intake_queue` row in one SQLite transaction before consulting the
health router. A router timeout or process crash after that commit cannot lose
the task intent. Router handling only updates the already-persisted conversation
and never creates a second row.

Replaying the same idempotency key with the same normalized JSON returns the
original intake and conversation. While that intake is `pending` or
`processing`, the response reports the already-accepted state; after
`completed` it reports a durable replay. A terminal `failed` intake returns
`TASK_INTAKE_FAILED` and requires explicit local operator retry; source
redelivery does not silently reset its retry budget. Reusing the key for
different content raises `IDEMPOTENCY_CONFLICT`. Property order, omitted
optional fields versus explicit `null`, and omitted acceptor versus acceptor
equal to owner do not change normalized identity.
The intake worker and retry lifecycle are documented in
[c4-intake-worker](c4-intake-worker.md).

## WorkIntake Envelope

`--work-intake-envelope-json`, `--work-intake-confirmation-json`, and
`--task-envelope-json` are mutually exclusive. The WorkIntake envelope carries a stable channel/message identity,
human sender, conversation type, plain text, and positive `intentRevision`.
Its result is returned under `workIntake` in JSON output:

- `chat_only`: store and dispatch as an ordinary message; no task intake row.
- `create_task`: adapt the `TaskDraft` to Commitment intake using
  `channel + message_id + intent_revision` as the permanent key.
- `confirm`: store the conversation and decision as delivered, do not dispatch,
  and do not create a task. A platform callback later submits only its stable
  `sourceKey`, chosen `action`, and authenticated `actorId` through
  `--work-intake-confirmation-json`; C4 reloads the original draft and performs
  the Core conversion.

Exact replay of a confirmation returns `confirmation_replayed` and the original
conversation ID. The first human choice is durable and mutually exclusive;
exact retries are idempotent, while a different later choice fails closed.
Reusing its source key for different content fails with
`IDEMPOTENCY_CONFLICT`.

## Message Storage

Inbound content is stored in the conversations DB exactly as received. `c4-receive.js` does not append reply-routing text and does not replace large messages with attachment previews.

## Health Routing

Before queuing a message, `c4-receive.js` asks the activity monitor MessageRouter how the current message should be routed. If health is `ok` or the router reports recovery, the message is queued normally. If health is unavailable, rate limited, or authentication failed, the message is recorded as delivered and the current channel receives an immediate status reply when replies are enabled. `--no-reply` messages are recorded as delivered without sending a status reply.

If the MessageRouter IPC is unavailable, `c4-receive.js` reads `~/zylos/activity-monitor/agent-status.json` and applies the same fallback behavior. Missing, unreadable, or malformed status files fail open as `ok`.

## JSON Output

When `--json` is passed, all output uses structured JSON on stdout.

**Success:**

```json
{"ok": true, "action": "queued", "id": 42}
```

**Error:**

```json
{"ok": false, "error": {"code": "INVALID_ARGS", "message": "--content is required"}}
```

Error codes include `INVALID_ARGS`, `IDEMPOTENCY_CONFLICT`, and `INTERNAL_ERROR`.

## Fail-Open Behavior

If the status file is missing, unreadable, or contains malformed JSON, health defaults to `ok` and the message passes through normally. This ensures a broken status file never blocks message intake.

## Reply Protocol

When a queued message is delivered to the agent, c4-dispatcher adds a `reply via` suffix for inbound messages that have an endpoint. Session startup context uses the same agent-facing formatting. Stored DB content and `c4-fetch` output remain clean:

```
[TG DM] user said: hello ---- reply via: node ~/zylos/.claude/skills/comm-bridge/scripts/c4-send.js "telegram" "8101553026"
```
