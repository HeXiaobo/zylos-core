# C4 Commitment Intake Worker

`c4-intake-worker.js` is the durable handoff from an explicit C4 task intent to
Commitment Core. One invocation atomically claims at most one available row:

```bash
node ~/zylos/.claude/skills/comm-bridge/scripts/c4-intake-worker.js
```

The normal runtime entry is `c4-intake-supervisor.js`, registered as the
single-instance `c4-intake-supervisor` core process in the PM2 ecosystem. The
one-shot worker remains useful for focused diagnostics. Neither script contacts
Feishu, HXA, OpenMax, or any other network service.

## Supervisor contract

The supervisor drains at most 25 rows per two-second cycle by default. Each
cycle waits for the previous cycle to finish, so there is no in-process
re-entry. PM2 uses fork mode with exactly one instance; SQLite immediate claims
remain the cross-process safety backstop if an operator also runs a manual
worker.

Environment overrides are deliberately bounded:

| Variable | Default | Allowed |
|----------|---------|---------|
| `C4_INTAKE_INTERVAL_MS` | `2000` | `250`–`60000` |
| `C4_INTAKE_BATCH_SIZE` | `25` | `1`–`100` |

Each cycle writes one JSON log event with completed, retried, failed, and total
attempt counts. A cycle exception writes `commitment_intake_drain_failed` and
the next cycle still runs. Invalid startup configuration writes
`commitment_intake_supervisor_fatal` and exits `1`. `SIGINT`/`SIGTERM` interrupts
the current sleep, writes `commitment_intake_supervisor_stopped`, and exits `0`.

The supervisor is an independent PM2 process rather than part of
`c4-dispatcher`; Core or intake-DB failures therefore do not block normal C4
message routing.

## Queue lifecycle

```text
pending → processing → completed
                     ↘ pending (retry)
                     ↘ failed (third failure)
```

- New rows start `pending` with `retry_count=0`.
- Claim is a SQLite immediate transaction, so concurrent workers cannot claim
  the same row.
- A Core ingest failure records `last_error` and becomes available again after
  5 seconds. The third failure is terminal `failed`.
- Exact source redelivery while a row is `pending` or `processing` returns an
  explicit already-accepted result; `completed` returns the durable replay
  result. A `failed` row never masquerades as a successful replay: intake
  returns `TASK_INTAKE_FAILED` until a local operator explicitly retries it.
- Retry a terminal row with
  `node c4-intake-worker.js --retry-failed <idempotency-key>`. This atomically
  increments `retry_generation`, resets that generation's retry budget, and
  returns it to `pending`. Webhook redelivery cannot create unlimited retry
  generations by itself.
- `processing` rows older than 60 seconds are recovered before the next claim.
- If Core ingest committed but the worker crashed before marking completion,
  stale recovery replays the same envelope. Commitment Core's
  `idempotencyKey` contract returns the original Task instead of creating a
  duplicate.

## Programmatic Interface

Tests and host runtimes can call:

```js
runCommitmentIntakeWorkerOnce({ dbPath, core, clock, afterIngest })
retryFailedCommitmentIntake({ dbPath, idempotencyKey })
drainCommitmentIntake({ maxItems, runOnce })
await superviseCommitmentIntake({ maxItems, intervalMs, signal, drain, sleep, log })
```

`dbPath`, `core`, and `clock` are injectable. `afterIngest` is a crash-testing
seam and runs after Core commits but before queue completion. Production callers
normally omit all worker options. The supervisor's injected `drain`, `sleep`,
and `log` are host/test adapters; production uses the defaults and supplies an
abort signal wired to process shutdown.
