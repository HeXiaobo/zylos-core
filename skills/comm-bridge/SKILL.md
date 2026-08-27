---
name: comm-bridge
description: >-
  C4 communication bridge — central gateway for ALL external communication (Telegram, Feishu, etc.).
  Use when replying to users via the "reply via" path, sending proactive messages to external channels,
  querying recent conversations or checkpoint status (prefer c4-db.js CLI; sqlite3 OK for unsupported queries),
  fetching conversation history for Memory Sync, or creating checkpoints after sync.
  Incoming messages are queued by channel bots and delivered to Claude via a PM2 dispatcher daemon.
  Session-start hooks automatically provide conversation context and can trigger Memory Sync when unsummarized conversations exceed the configured threshold.
---

# Communication Bridge (C4)

Central message hub - ALL communication with Claude goes through C4.

## Architecture

```
Web Console ──┐
Telegram    ───┼──► C4 Bridge ◄──► Claude
Feishu      ───┘
```

## Components

| Script | Purpose | Reference |
|--------|---------|-----------|
| `c4-receive.js` | External → Claude (queue incoming messages) | [c4-receive](references/c4-receive.md) |
| `c4-intake-supervisor.js` | Bounded periodic intake drain (PM2 core service) | [task intake](references/c4-intake-worker.md) |
| `c4-intake-worker.js` | Claim one durable task envelope → Commitment Core | [task intake](references/c4-intake-worker.md) |
| `c4-send.js` | Claude → External (route outgoing messages) | [c4-send](references/c4-send.md) |
| `c4-control.js` | System control plane (heartbeat, maintenance) | [c4-control](references/c4-control.md) |
| `c4-dispatcher.js` | PM2 daemon: polls pending queue, delivers to tmux | — |
| `c4-session-init.js` | Hook (session start): context + Memory Sync trigger | [hooks](references/hooks.md) |
| `c4-fetch.js` | Fetch conversations by id range | [c4-fetch](references/c4-fetch.md) |
| `c4-db.js` | Database module and CLI for querying conversations and checkpoints | [c4-db](references/c4-db.md) |
| `c4-checkpoint.js` | Create/query checkpoints (sync boundaries) | [c4-checkpoint](references/c4-checkpoint.md) |

## Sending Messages

```bash
# Send to Telegram DM
cat <<'EOF' | node ~/zylos/.claude/skills/comm-bridge/scripts/c4-send.js telegram 8101553026
Hello! Quotes, $vars, **markdown** — all safe via stdin.
EOF

# Send to Feishu group thread
cat <<'EOF' | node ~/zylos/.claude/skills/comm-bridge/scripts/c4-send.js feishu "chat_xxx|type:group|root:msg_yyy"
Report ready.
EOF
```

Always generate new calls with stdin/heredoc. Positional message bodies are
rejected with exit code 2, and `C4_LEGACY_ARG_MODE` cannot re-enable argv body
mode. Do not add new argv callers. See
[c4-send](references/c4-send.md) for the compatibility and recovery policy.
Treat the heredoc wrapper as fixed shell syntax: only the message body goes between the start line and the closing terminator line, and the terminator itself must never be copied into the actual outgoing message.

For a fixed launcher that cannot pipe stdin, write the body to a private file
and pass exactly one `--body-file=/absolute/path` option. This is the only
non-stdin body transport permitted by strict mode; never append message content
as a positional argument.

External delivery also passes through the managed outbound content policy at
`$ZYLOS_DIR/.zylos/c4-outbound-policy.json`; blocked attempts are audited at
`$ZYLOS_DIR/comm-bridge/outbound-policy-audit.jsonl` without recording message
bodies. The paths are fixed and cannot be overridden by callers. The internal
record-only `void` channel is outside this external policy and never dispatches
to an adapter. `--allow-banned` and similarly named environment variables are
rejected or ignored; they cannot bypass the policy.
Channel `send.js` files are adapters behind `c4-send.js`; invoking one directly
bypasses policy and audit and is unsupported for external delivery.

### Streamed reply exception

When an inbound message ends with `---- streamed reply:`, reply directly as
normal assistant text in the current runtime turn. Do **not** call `c4-send`
for that response. For meaningful steps, emit a short requester-safe work note
on its own line with the exact prefix `[PUBLIC_REASONING] `. This is a public
summary protocol, never permission to expose hidden chain-of-thought, tool
inputs, raw tool results, paths, credentials, or secrets. Write the final
answer as normal unprefixed text.

Claude Code's synchronous `MessageDisplay` hook separates those marked work
notes into runtime-neutral `PublicReasoningDelta` events and publishes the
remaining displayed text as `OutputDelta`; `Stop` records the unmarked final
message as canonical `RunCompleted.output`. With Codex, Activity Monitor tails
the active rollout and consumes only public `reasoning.summary`, user-visible
`commentary`, `final_answer`, and `task_complete` fields. It never reads
`raw_content` or `encrypted_content`. The Feishu Adapter renders both streams
on the existing CardKit card.

All messages without the streamed marker continue to use `c4-send` exactly as
described above.

## Database

SQLite at `~/zylos/comm-bridge/c4.db`:
- `conversations`: All messages (in/out) with priority, status, retry tracking
- `checkpoints`: Recovery points with conversation id ranges
- `control_queue`: System control messages (heartbeat, maintenance) with priority, ack deadlines, and status lifecycle
- `commitment_intake_queue`: Durable task envelopes linked 1:1 to inbound conversations, consumed idempotently by Commitment Core
- `work_intake_decisions`: First classifier result for each immutable source key, retained across classifier upgrades
- `work_intake_confirmations`: Durable ambiguous WorkIntake decisions; no Task exists until the human confirms

## Commitment Intake

Channel Adapters may add `--task-envelope-json <json>` to `c4-receive.js`.
Use the canonical channel name `feishu` for Feishu events and idempotency keys.
Explicit task intents are atomically stored as a conversation plus intake row
before health routing or any later trigger runs. Plain C4 messages keep their
existing behavior and do not create intake rows.

Natural-language adapters instead add `--work-intake-envelope-json <json>`.
C4 invokes the channel-neutral WorkIntake `classify` Interface. `chat_only`
continues through ordinary C4 dispatch, `create_task` is atomically adapted to
the same durable Commitment intake above, and `confirm` is recorded with
`delivery_action=work-intake-confirmation-required` without dispatch or task
creation. The two envelope flags are mutually exclusive.
The strict Task envelope preserves optional canonical `dueAt` and
`reminderMinutesBeforeDue`; a reminder without a deadline fails before queue
persistence.

Confirmation callbacks use `--work-intake-confirmation-json <json>` with exact
fields `sourceKey`, `action`, authenticated `actorId`, and `capability`. The
capability is a short-lived HMAC attestation issued by the trusted Channel
Adapter after platform callback verification. Both processes must receive the
same `C4_WORK_INTAKE_CAPABILITY_SECRET` (at least 32 bytes). C4 binds the token
to the source, action, and actor without importing a platform SDK, then loads
the persisted envelope/decision, records the first choice durably, rejects
conflicting later choices, and performs any Commitment conversion inside Core.

Confirmation effects have a durable `pending`/`applied` receipt. Chat promotion
reuses the original conversation and task promotion acknowledges only after the
Commitment intake exists. An `edit` response includes a stable `effectKey` and
remains redrivable until the adapter durably sends its guidance, then calls
`--work-intake-confirmation-effect-json` with exact fields `sourceKey`, `action`,
`actorId`, `effectKey`, and a fresh `capability`.

The `c4-intake-supervisor` PM2 core service consumes the queue in isolated,
bounded batches. It does not share a loop or failure domain with
`c4-dispatcher`, so intake failures cannot interrupt ordinary C4 delivery.
See [task intake](references/c4-intake-worker.md) for the envelope contract,
retry lifecycle, and recovery guarantees.

## Health & Status

The activity monitor writes `~/zylos/activity-monitor/agent-status.json` which includes a `health` field:

| Value | Meaning |
|-------|---------|
| `ok` | System healthy, messages accepted normally |
| `recovering` | Legacy persisted liveness state; normalized to unavailable at runtime |
| `down` | Legacy persisted liveness state; normalized to unavailable at runtime |

**Fail-open semantics**: If the status file is missing or malformed, health is assumed `ok` — intake is never blocked by a read failure.

When health is not `ok`, `c4-receive.js` asks the activity monitor MessageRouter how to route the current message. Unhealthy messages are recorded as delivered and receive an immediate status reply when replies are enabled; `--no-reply` messages are accepted silently. If the MessageRouter IPC is unavailable, `c4-receive.js` falls back to the status file with the same delivered/current-message behavior.

## Keystroke Delivery

The dispatcher supports `[KEYSTROKE]` control messages for sending raw keystrokes to the tmux session. This is an **ops-level capability** — no source gating is applied.

When a control message content starts with `[KEYSTROKE]`, the dispatcher:
- Extracts the key name (e.g., `Enter`, `Tab`, `Escape`)
- Sends it directly via `tmux send-keys` (no buffer paste, no "Meanwhile" prefix, no verification)
- Auto-acks the control immediately after delivery

Example: the permission auto-approve hook enqueues `[KEYSTROKE]Enter` at priority 0 with bypass-state to auto-confirm Claude Code's permission prompts.

Any process with access to `c4-control.js` can enqueue keystroke controls. This mirrors the existing reality that any process can call `tmux send-keys` directly — the C4 queue adds priority ordering and delivery guarantees, not access control.

## Service Management

```bash
pm2 status c4-dispatcher
pm2 logs c4-dispatcher
pm2 restart c4-dispatcher

pm2 status c4-intake-supervisor
pm2 logs c4-intake-supervisor
```
