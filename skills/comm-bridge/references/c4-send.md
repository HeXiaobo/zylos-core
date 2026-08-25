# c4-send.js — Send Interface

Sends messages from Claude to external channels. Records the outgoing message in DB, then delegates to the channel's `send.js` script.

## Usage

```bash
cat <<'EOF' | node ~/zylos/.claude/skills/comm-bridge/scripts/c4-send.js <channel> <endpoint_id>
Your message here. Quotes, $vars, `backticks` — all safe.
EOF
```

New callers pipe messages via stdin using a heredoc. This bypasses shell argument parsing entirely, so any content (quotes, variables, markdown) is delivered verbatim.

The exact endpoint-addressed legacy form remains accepted by default during
the compatibility phase. It exists to keep older HXA/OpenMAX/channel callers
working during rolling upgrades; do not use it for new calls.

### Compatibility and recovery policy

Only the unambiguous legacy form `<channel> <endpoint_id> <message>` is
accepted. Broadcast and `void` arg-mode remain disabled. Every use writes a
`legacy_arg_mode_used` deprecation event without the message body, so operators
can verify that old callers have been removed.

After all callers have demonstrably migrated, an operator may opt in to strict
mode. The script reads both flags directly from `~/zylos/.env`, so changes take
effect on the next send without restarting the runtime:

```dotenv
C4_STRICT_STDIN_ONLY=1
```

If strict mode interrupts communication, add the break-glass override
immediately; it takes precedence over strict mode:

```dotenv
C4_LEGACY_ARG_MODE=1
```

Self-upgrade runs a hermetic reply-path canary for both stdin and exact legacy
calls. Under explicit strict mode, the legacy check temporarily applies the
break-glass override only inside the canary to prove recovery remains possible.
A failed canary restores the backed-up Core Skills and restarts the previously
running services.

### Important safety rule

- The heredoc terminator line (for example `EOF`) is shell wrapper syntax, not part of the message body.
- Do not include the terminator token itself as a standalone line inside the message content.
- When generating a send command, treat the wrapper as fixed boilerplate and only substitute `<channel>`, `<endpoint_id>`, and the message body.

### How it works

1. When stdin is piped, c4-send.js reads the full message from stdin.
2. The heredoc content is raw bytes — no shell escaping needed.
3. c4-send.js passes the message to the channel's `send.js` script via `spawn()`.
   The child receives `C4_DELIVERY_ID=c4.outbound.<conversation-id>`, derived
   from the persisted outbound C4 row before dispatch. Channel adapters may
   use this opaque, content-free identity to make an ambiguous transport retry
   idempotent. Streamed assistant replies additionally receive their separate
   `C4_ASSISTANT_REQUEST_ID`; the two identities are not interchangeable.

## Examples

```bash
# Send to Telegram DM
cat <<'EOF' | node ~/zylos/.claude/skills/comm-bridge/scripts/c4-send.js telegram 8101553026
Hello! This message has "quotes" and $100 safely.
EOF

# Send to Lark group thread (multi-part endpoint)
cat <<'EOF' | node ~/zylos/.claude/skills/comm-bridge/scripts/c4-send.js lark "chat_xxx|type:group|root:msg_yyy"
Report ready. Contains **markdown** and "special chars".
EOF

# Broadcast to all subscribers (no endpoint)
cat <<'EOF' | node ~/zylos/.claude/skills/comm-bridge/scripts/c4-send.js telegram
Hello everyone!
EOF
```

If the message body itself may contain a line like `EOF`, use a different terminator token for the wrapper, for example:

```bash
cat <<'C4MSG' | node ~/zylos/.claude/skills/comm-bridge/scripts/c4-send.js telegram 8101553026
This message can mention EOF safely.
C4MSG
```

**Note**: Endpoint structure depends on the channel implementation. Some channels use multi-part endpoints with pipe-separated values. Always quote multi-part endpoints as a single argument.

## The `void` Channel (internal-only messages)

`void` is a virtual channel for internal memos (e.g. session handoffs). Messages sent to it are recorded in c4.db like any other conversation row — so session-start context injection and Memory Sync pick them up — but they are **never dispatched** to any channel send script, and display surfaces (web console, etc.) never show them. The endpoint carries the purpose/topic and is **mandatory**:

```bash
cat <<'EOF' | node ~/zylos/.claude/skills/comm-bridge/scripts/c4-send.js "void" "session-handoff"
Handoff summary for the next session...
EOF
```

## Channel Interface Contract

Channels are skills installed in `~/zylos/.claude/skills/`. Each channel must provide:

- **Send script**: `~/zylos/.claude/skills/<channel>/scripts/send.js <endpoint_id> <message>`
- **Config**: `~/zylos/<channel>/config.json` (for data like `primary_dm`)

The send script must return exit code 0 on success, non-zero on failure.
