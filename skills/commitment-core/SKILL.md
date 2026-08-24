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

Open the Module with
`openCommitmentCore({ dbPath, clock, idGenerator, eventIdGenerator })` and close
it when the runtime stops. Production callers normally omit the options; the
injectable clock and ID generators exist for deterministic tests.
The default database is `$ZYLOS_DIR/commitments/commitments.db`, falling back
to `~/zylos/commitments/commitments.db` when `ZYLOS_DIR` is unset.

- `ingest(envelope)` atomically creates one `ready` task, its Source receipt,
  and a `TaskCreated` event for a new `idempotencyKey`; it returns
  `{ created: true, task }`.
- Replaying the same normalized envelope returns the original task with
  `created: false`.
- Reusing the key with different normalized content throws an error whose
  `code` is `IDEMPOTENCY_CONFLICT`; callers must not retry it unchanged.
- `query({ taskId })` returns the task view or `null`.
- `query({ taskId, includeEvents: true })` returns `{ task, events }`, with
  events ordered by Task version.
- `command({ type, taskId, actorId, idempotencyKey }, expectedVersion)` applies
  one state transition and returns `{ task, event }`. `expectedVersion` must be
  a positive integer.

The envelope owns only channel-neutral task fields. `source.channel` and
`source.externalId` provide provenance; Adapters are responsible for deriving
a stable idempotency key from their native event identity.

## External execution Adapter seam

`scripts/external-execution-adapter.js` defines the reusable Interface for
OpenMax, Paperclip, local workers, and later execution backends. Call
`mapExternalExecutionEvent({ backend, eventId, eventType, taskId, actorId,
expectedVersion })`; it returns `{ command, expectedVersion }`, ready for
`command(command, expectedVersion)`. `backend` is a canonical lowercase
identifier, and the stable command key is
`<backend>:<eventId>:task-command`. Raw backend metadata must be normalized
outside this Adapter; extra or malformed fields fail closed.

Only `work_started` becomes `StartTask`. `deliverable_submitted`, `completed`,
`done`, and `succeeded` become `SubmitForReview`. Backend completion is evidence
for review, never acceptance: this Adapter never produces `AcceptTask`, and
unknown or human-acceptance event types fail closed. Only an explicit,
authorized acceptor action may move a reviewed Task to `done`.

## Command policy

| Command | Transition | Authorized actor |
| --- | --- | --- |
| `StartTask` | `ready → in_progress` | assignee, or owner when unassigned |
| `SubmitForReview` | `in_progress → review` | assignee, or owner when unassigned |
| `AcceptTask` | `review → done` | acceptor |
| `RequestChanges` | `review → ready` | acceptor |
| `CancelTask` | `ready/in_progress/review → cancelled` | owner or acceptor |
| `ReopenTask` | `done → ready` | owner or acceptor |

Initial Task, Source receipt, and `TaskCreated` event commit in one SQLite
transaction. The creation event has `fromState: null`, `toState: ready`, and
version `1`; its actor is `source.senderId`, falling back to the owner. Source
replay does not create another event.

Each Task state update, command receipt, and Domain Event also commits in one
SQLite transaction. An exact command replay returns its original result even
when the Task has since advanced. A changed command with the same key fails
with `IDEMPOTENCY_CONFLICT`.

Callers handle stable error codes: `VERSION_CONFLICT`, `INVALID_TRANSITION`,
`FORBIDDEN`, `IDEMPOTENCY_CONFLICT`, and `TASK_NOT_FOUND`. Malformed Interface
values throw `TypeError`.

Assignment changes, reconciliation, and channel projection remain later slices
and must extend this Interface deliberately.
