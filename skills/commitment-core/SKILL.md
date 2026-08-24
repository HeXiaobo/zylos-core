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
`openCommitmentCore({ dbPath, clock, idGenerator, eventIdGenerator,
runIdGenerator, runEventIdGenerator, evidenceIdGenerator,
externalLinkIdGenerator })` and close it when the runtime stops.
Production callers normally omit the options; the injectable clock and ID
generators exist for deterministic tests.
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
- `query({ states?, ownerId?, assigneeId?, limit? })` lists Tasks ordered by
  `updatedAt` descending and `id` ascending. The default limit is 50 and the
  maximum is 100. List mode and `taskId` mode are mutually exclusive.
- `command({ type, taskId, actorId, idempotencyKey }, expectedVersion)` applies
  one state transition and returns `{ task, event }`. `expectedVersion` must be
  a positive integer.

## Task Run leases

`core.runs` is the only Interface for durable execution leases. `actorId` is
the logical assignee acting on the Task; `workerId` identifies the concrete
runtime process and may change after lease expiry.

- `runs.claim({ taskId, actorId, workerId, idempotencyKey, leaseMs },
  expectedTaskVersion)` atomically creates one active Run. Claiming a `ready`
  Task also moves it to `in_progress`; claiming an `in_progress` Task is used
  for recovery and does not advance its Task version.
- Only one `active` Run row may exist for a Task. An unexpired lease returns
  `LEASE_CONFLICT`; an expired lease is marked `expired` before a new worker is
  admitted in the same transaction. `leaseMs` is an integer from 1 through
  86,400,000.
- `runs.heartbeat({ taskId, runId, workerId, idempotencyKey, leaseMs },
  expectedRunVersion)` renews an unexpired lease owned by that worker only
  while the Task remains `in_progress`.
- `runs.complete({ taskId, runId, workerId, idempotencyKey },
  { runVersion, taskVersion })` ends the Run and submits the Task to `review`.
  Execution completion never accepts a Task or moves it directly to `done`.
- `runs.release(...)` takes the same arguments as `complete`, ends the Run,
  and returns the Task from `in_progress` to `ready`.
- `runs.query({ runId, includeEvents? })` returns one Run, optionally with its
  Run Events. `runs.query({ taskId, statuses?, limit? })` returns stable,
  bounded Run history; the default limit is 50 and the maximum is 100.

Every Run mutation, Run Event, idempotency receipt, and any corresponding Task
transition/Event commits in one SQLite transaction. Exact receipt replay wins
even if versions or time have since advanced; changed content with the same key
returns `IDEMPOTENCY_CONFLICT`. Other stable Run errors include
`LEASE_CONFLICT`, `LEASE_EXPIRED`, `LEASE_NOT_ACTIVE`, `LEASE_FORBIDDEN`,
`RUN_NOT_FOUND`, `RUN_TASK_MISMATCH`, and `RUN_VERSION_CONFLICT`.

The legacy Task command Interface coordinates with Run ownership. Direct
`SubmitForReview` fails with `ACTIVE_RUN_CONFLICT` while a Run is active; the
worker must call `runs.complete`. An authorized `CancelTask` atomically moves
the Task to `cancelled`, marks its active Run `interrupted`, and records
`TaskRunInterrupted`. Later heartbeat, complete, and release calls reject that
Run as `LEASE_NOT_ACTIVE`. Exact Task command receipt replay still returns the
original result without writing a second Run Event.

The envelope owns only channel-neutral task fields. `source.channel` and
`source.externalId` provide provenance; Adapters are responsible for deriving
a stable idempotency key from their native event identity.

## Evidence

`core.evidence` owns immutable proof attached to a Task. It does not expose an
update or delete operation.

- `evidence.record({ taskId, actorId, kind, uri?, summary?, contentHash?,
  idempotencyKey })` atomically appends Evidence and its receipt. At least one
  of `uri`, `summary`, or `contentHash` is required. Inputs are bounded: URI is
  at most 2,048 characters, summary 10,000, and content hash 256.
- The owner, acceptor, or assignee may record Evidence. Other actors receive
  `FORBIDDEN`; a missing Task returns `TASK_NOT_FOUND`.
- `kind` is normalized to a lowercase identifier containing only letters,
  digits, `.`, `_`, and `-` (and beginning with a letter).
- `evidence.query({ evidenceId })` returns one Evidence or `null`.
  `evidence.query({ taskId, kind?, limit? })` returns immutable Evidence ordered
  by `createdAt` descending and `id` ascending. The default limit is 50 and
  maximum is 100.
- Exact receipt replay returns the original result. Reusing the key for
  different normalized content returns `IDEMPOTENCY_CONFLICT`.

## External links

`core.externalLinks` owns durable identity mappings, not external task state.
It never calls or synchronizes Feishu, OpenMax, Paperclip, or another backend.

- `externalLinks.link({ taskId, actorId, backend, externalId,
  idempotencyKey })` maps one backend object to one Task. The owner, acceptor,
  or assignee may create a mapping.
- `backend` is trimmed, lowercased, and restricted to letters, digits, `.`,
  `_`, and `-`. `externalId` retains the backend's native casing.
- `(backend, externalId)` is globally unique, and a Task has at most one link
  per backend. Conflicts return `EXTERNAL_LINK_CONFLICT`.
- Repeating the same mapping with a new key returns `{ created: false, link }`
  and still records that key as an idempotency receipt. Exact replay returns
  the same result; changed content under that key returns
  `IDEMPOTENCY_CONFLICT`.
- `externalLinks.query({ taskId, backend?, limit? })` lists mappings for a Task.
  `externalLinks.query({ backend, externalId })` resolves one external object;
  omitting `externalId` lists mappings for a backend. Lists have a default
  limit of 50, maximum of 100, and deterministic identity ordering.

Evidence rows, ExternalLink rows, and their receipts commit in their respective
single SQLite transactions. Callers must use these Interfaces instead of the
underlying tables.

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

## Derived attention view

`scripts/render-attention-view.js` rebuilds `$ZYLOS_DIR/memory/state.md` from the
Core list-query Interface. This file is a disposable, read-only attention
view: never parse it to create or update Tasks, and never treat edits to it as
authoritative state.

Run it directly with:

```sh
node scripts/render-attention-view.js --json
```

`--output <path>` selects another destination for inspection or migration;
`--max-bytes <512..16384>` may lower, but never raise, the 16KB hard limit.
Arguments are strict, and `--json` returns the publish result for automation.
The publisher queries only `review`, `in_progress`, and `ready` Tasks, then
orders them by attention state in that order, oldest `updatedAt`, and Task ID.
`done` and `cancelled` Tasks never appear.

The document declares view version 1 and its generation timestamp. Core text
is Markdown-escaped and bounded before rendering; the whole result is also
byte-bounded. Truncation markers distinguish known byte-budget omissions from
an unknown count when Core's 100-Task query limit is reached. Publication uses
a same-directory temporary file, fsync, and atomic rename, so a failed publish
does not replace the previous view.

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

Assignment changes, reconciliation, external state synchronization, and channel
projection remain later slices and must extend this Interface deliberately.

The local `zylos task` CLI is an Adapter over this Interface. It must not query
or mutate the SQLite tables directly. It lazily loads the deployed Module from
`$ZYLOS_DIR/.claude/skills/commitment-core`, where Skill dependencies are
installed, so unrelated root CLI commands do not require SQLite at startup.
Task state commands are `create/list/show/start/submit/accept/rework/cancel/reopen`.
Run operations are exposed separately as `claim`, `heartbeat`, `complete-run`,
`release-run`, and `runs`; `complete-run` intentionally submits for review and
does not accept the Task. Every mutating Run command requires explicit Task/Run
versions and a worker identity, and accepts a stable caller idempotency key.
