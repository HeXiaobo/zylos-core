# C4 Commitment Intake Worker

`c4-intake-worker.js` is the durable handoff from an explicit C4 task intent to
Commitment Core. One invocation atomically claims at most one available row:

```bash
node ~/zylos/.claude/skills/comm-bridge/scripts/c4-intake-worker.js
```

Run it repeatedly through the runtime supervisor or scheduler. The script does
not contact Feishu, HXA, OpenMax, or any other network service.

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
- `processing` rows older than 60 seconds are recovered before the next claim.
- If Core ingest committed but the worker crashed before marking completion,
  stale recovery replays the same envelope. Commitment Core's
  `idempotencyKey` contract returns the original Task instead of creating a
  duplicate.

## Programmatic Interface

Tests and host runtimes can call:

```js
runCommitmentIntakeWorkerOnce({ dbPath, core, clock, afterIngest })
```

`dbPath`, `core`, and `clock` are injectable. `afterIngest` is a crash-testing
seam and runs after Core commits but before queue completion. Production callers
normally omit all options.
