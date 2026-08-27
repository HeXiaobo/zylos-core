# c4-send.js — Send Interface

Sends messages from Claude to external channels. Records the outgoing message in DB, then delegates to the channel's `send.js` script.

## Usage

```bash
cat <<'EOF' | node ~/zylos/.claude/skills/comm-bridge/scripts/c4-send.js <channel> <endpoint_id>
Your message here. Quotes, $vars, `backticks` — all safe.
EOF
```

New callers pipe messages via stdin using a heredoc. This bypasses shell argument parsing entirely, so any content (quotes, variables, markdown) is delivered verbatim.

Launchers that cannot pipe stdin may write the body to a private temporary file
and pass one content-free option. The option is safe in strict mode and is part
of the published Core capability contract:

```bash
node ~/zylos/.claude/skills/comm-bridge/scripts/c4-send.js \
  <channel> <endpoint_id> --body-file=/absolute/path/to/reply.txt
```

Use exactly one `--body-file=<path>` option. Do not combine it with `--stdin` or
a positional message. An unreadable or empty file fails before dispatch. The
body itself never appears in argv.

## Outbound content policy

Before channel validation, C4 loads the optional policy at
`$ZYLOS_DIR/.zylos/c4-outbound-policy.json`. This is the only policy path; the
caller cannot redirect it with environment variables or command-line options.
A missing default file means that no rules are configured; a present but
invalid or unsafe file fails closed.

The policy is a versioned JSON object containing literal rules. Each rule must
have a safe `id` and may use either a non-empty `contains` string or a
`codePoints` array of Unicode scalar values:

```json
{
  "version": 1,
  "rules": [
    {"id": "restricted-marker", "contains": "DO_NOT_SEND"},
    {"id": "restricted-code-point", "codePoints": [128640]}
  ]
}
```

Rules are applied at the single outbound send seam, including for an unknown
or nonstandard channel name. A match exits with status 3 before a C4 database
row or channel adapter is created. Blocked attempts append a JSONL audit record
to `$ZYLOS_DIR/comm-bridge/outbound-policy-audit.jsonl` containing route
metadata, UTF-8 byte length, hashes, and opaque rule references only; the
message body and configured rule values are never written. The policy file and
audit path must be regular files under the runtime directory, owned by the
runtime user, and not writable by group or other users.

`--allow-banned` is intentionally rejected. There is no unaudited bypass for
the outbound policy; similarly named options and environment variables do not
change the decision.

The virtual `void` channel is intentionally outside this external policy. It
is an internal record-only handoff and never invokes an external adapter; do
not use it as an external delivery route.

Channel `send.js` files are adapters behind this seam. Calling one directly
bypasses the C4 policy, audit, and delivery identity, and is unsupported for
external delivery; all external sends must use `c4-send.js`.

Message bodies supplied as positional arguments are rejected with exit code 2;
`C4_LEGACY_ARG_MODE` cannot re-enable argv body mode. Use stdin or
`--body-file` instead.

### Compatibility and recovery policy

Positional message bodies are not accepted in any channel mode. Broadcast and
`void` arg-mode remain disabled.

After all callers have demonstrably migrated, an operator may opt in to strict
mode. The script reads both flags directly from `~/zylos/.env`, so changes take
effect on the next send without restarting the runtime:

```dotenv
C4_STRICT_STDIN_ONLY=1
```

Self-upgrade runs a hermetic reply-path canary. It proves stdin and body-file
delivery, then proves that a positional body is rejected without dispatch.
Before mutation, the target must declare both `c4.reply.argv-compat:1` and
`c4.reply.body-file:1`. A failed canary restores the backed-up Core Skills and
restarts the previously running services.

### Important safety rule

- The heredoc terminator line (for example `EOF`) is shell wrapper syntax, not part of the message body.
- Do not include the terminator token itself as a standalone line inside the message content.
- When generating a send command, treat the wrapper as fixed boilerplate and only substitute `<channel>`, `<endpoint_id>`, and the message body.

### How it works

1. When stdin is piped, c4-send.js reads the full message from stdin; when
   `--body-file=<path>` is present, it reads that file instead.
2. Neither safe transport places the body in argv.
3. c4-send.js passes the message to the channel's `send.js` script via `spawn()`.
   The child receives `C4_DELIVERY_ID=c4.outbound.<conversation-id>`, derived
   from the persisted outbound C4 row before dispatch. Channel adapters may
   use this opaque, content-free identity to make an ambiguous transport retry
   idempotent. Streamed assistant replies additionally receive their separate
   `C4_ASSISTANT_REQUEST_ID`; the two identities are not interchangeable.
   Core advertises this channel contract as `c4.outbound-delivery-id:1` through
   `zylos capabilities --json`; components that depend on proactive delivery
   idempotency must require it before install or upgrade.

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
