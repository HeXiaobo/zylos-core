---
name: commitment-core
description: Internal durable commitment and task state for Zylos adapters and runtimes.
user-invocable: false
---

# Commitment Core

Use this internal Module as the single owner of user commitments and task state.

Callers cross the Interface in `scripts/core.js`; they must not query or mutate
the SQLite tables directly. Channel-specific Feishu, OpenMax, HXA, and runtime
fields belong in Adapters, not in this Module.

## Interface

Open the Module with `openCommitmentCore({ dbPath, clock, idGenerator })` and
close it when the runtime stops. Production callers normally omit the options;
the injectable clock and ID generator exist for deterministic tests.

- `ingest(envelope)` atomically creates one `ready` task for a new
  `idempotencyKey` and returns `{ created: true, task }`.
- Replaying the same normalized envelope returns the original task with
  `created: false`.
- Reusing the key with different normalized content throws an error whose
  `code` is `IDEMPOTENCY_CONFLICT`; callers must not retry it unchanged.
- `query({ taskId })` returns the task view or `null`.

The envelope owns only channel-neutral task fields. `source.channel` and
`source.externalId` provide provenance; Adapters are responsible for deriving
a stable idempotency key from their native event identity.

This first tranche intentionally supports only creation in `ready`. State
transitions, assignment policy, acceptance, reconciliation, and channel
projection are later slices and must extend this Interface deliberately.
