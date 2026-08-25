# c4-send.js — Send Interface

Sends messages from Claude to external channels. Records the outgoing message in DB, then delegates to the channel's `send.js` script.

## Usage

```bash
cat <<'EOF' | node ~/zylos/.claude/skills/comm-bridge/scripts/c4-send.js <channel> <endpoint_id>
Your message here. Quotes, $vars, `backticks` — all safe.
EOF
```

Messages are piped via stdin using a heredoc. This bypasses shell argument parsing entirely, so any content (quotes, variables, markdown) is delivered verbatim.

Passing the message body as a CLI argument is disabled and exits with status 2 by default.

### Bounded legacy migration

`C4_LEGACY_ARG_MODE=1` temporarily accepts only the unambiguous legacy form
`<channel> <endpoint_id> <message>`. Broadcast and `void` arg-mode remain
disabled. Every use writes a `legacy_arg_mode_used` deprecation event without
the message body, so operators can verify that old callers have been removed.

The script reads this flag directly from `~/zylos/.env`, so it takes effect for
the next send without restarting the current runtime:

```dotenv
C4_LEGACY_ARG_MODE=1
```

Remove the override after HXA/OpenMAX callers use stdin.

### Important safety rule

- The heredoc terminator line (for example `EOF`) is shell wrapper syntax, not part of the message body.
- Do not include the terminator token itself as a standalone line inside the message content.
- When generating a send command, treat the wrapper as fixed boilerplate and only substitute `<channel>`, `<endpoint_id>`, and the message body.

### How it works

1. When stdin is piped, c4-send.js reads the full message from stdin.
2. The heredoc content is raw bytes — no shell escaping needed.
3. c4-send.js passes the message to the channel's `send.js` script via `spawn()`.

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
