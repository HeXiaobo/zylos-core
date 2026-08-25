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
- `query({ states?, ownerId?, assigneeId?, cursor?, limit? })` lists Tasks
  ordered by `updatedAt` descending and `id` ascending. Continue a page with
  the last row's `{ updatedAt, taskId }` cursor. The default limit is 50 and
  the maximum is 100. List mode and `taskId` mode are mutually exclusive.
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
- `runs.sweepExpired({ limit? })` atomically marks at most `limit` expired
  active Runs as `expired` and appends one immutable `TaskRunExpired` Event per
  Run. The default limit is 25 and the maximum is 100. It returns
  `{ expiredCount, hasMore }` and never changes Task state; an `in_progress`
  Task remains available for a later explicit `runs.claim` takeover.
- `runs.query({ runId, includeEvents? })` returns one Run, optionally with its
  Run Events. `runs.query({ taskId, statuses?, limit? })` returns stable,
  bounded Run history; the default limit is 50 and the maximum is 100.

Every Run mutation, Run Event, idempotency receipt, and any corresponding Task
transition/Event commits in one SQLite transaction. Exact receipt replay wins
even if versions or time have since advanced; changed content with the same key
returns `IDEMPOTENCY_CONFLICT`. Other stable Run errors include
`LEASE_CONFLICT`, `LEASE_EXPIRED`, `LEASE_NOT_ACTIVE`, `LEASE_FORBIDDEN`,
`RUN_NOT_FOUND`, `RUN_TASK_MISMATCH`, and `RUN_VERSION_CONFLICT`.

Run the opt-in background sweep with
`node scripts/run-lease-sweep-supervisor.js`, or execute one bounded pass with
`node scripts/run-lease-sweep-supervisor.js --once`. The supervisor defaults
to a 2,000 ms interval and batch size 25; set
`COMMITMENT_RUN_SWEEP_INTERVAL_MS` (250..60,000) and
`COMMITMENT_RUN_SWEEP_BATCH_SIZE` (1..100) to change them. It drains
sequentially, logs structured failures and continues with the next cycle,
uses a fenced SQLite singleton lease in
`$ZYLOS_DIR/.zylos/supervisor-leases.db`, and releases it on SIGINT or SIGTERM.
Each owner has a random token; acquisition and expired-lease takeover run in an
immediate transaction and advance a monotonic fencing token. The owner renews
before each sweep cycle and stops before sweeping again if ownership was lost;
an old owner cannot renew or release its successor's lease. The lease lasts at
least 10 seconds and otherwise three sweep intervals. The supervisor is
intentionally absent from the default PM2 ecosystem and does not start unless
an operator explicitly invokes it. The sweep never calls an external backend,
automatically reruns work, or moves a Task to `done`.

After a sweep, new heartbeat, complete, and release requests from the old
worker fail with `LEASE_NOT_ACTIVE`. Exact receipt replays still return their
original result without a second mutation or Event.

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

Task snapshots expose an optional canonical RFC 3339 `dueAt`. It is a Core
business fact shared by every projection; platform Adapters translate it to
their own deadline representation. Existing databases migrate with `dueAt =
null` and task creation remains backward compatible when it is omitted.

Evidence rows, ExternalLink rows, and their receipts commit in their respective
single SQLite transactions. Callers must use these Interfaces instead of the
underlying tables.

## Task conversation, audience, and notification policy

`core.conversation` owns channel-neutral Task comments. It stores append-only
events and never updates or deletes comment history.

- `conversation.record(command)` accepts `AddComment`, `ReviseComment`, or
  `DeleteComment`. Every command includes `taskId`, logical `commentId`,
  authenticated `actorId`, canonical `occurredAt`, and `idempotencyKey`.
  Add/revise also require `body`; replies may include `replyToCommentId`.
- A delete appends `CommentDeleted` with a null body. It is a tombstone, not a
  row deletion. Late older events remain in history but cannot replace a newer
  materialized comment view.
- `conversation.query({ taskId, commentId?, includeHistory?, limit? })` returns
  current comment views and, when requested, their immutable event history.
- Each comment event and exact-replay receipt commits in one transaction.
  Reusing a key with different normalized content returns
  `IDEMPOTENCY_CONFLICT`.

`core.audience.resolve({ taskId })` returns the unique business participants
and their merged `owner`, `acceptor`, and `assignee` roles. Platform followers
are deliberately absent: an Adapter may project this audience as followers,
but follower state is not a Core fact.

`core.notifications.decide({ taskId, eventId, kind, actorId?, targetIds? })`
returns channel-neutral deliveries with `recipientId`, `reason`, `urgency`,
`deliveryMode`, `coalesceWindowMs`, and `dedupeKey`.

- `review` immediately targets the Acceptor.
- `blocked`, `failed`, and `overdue` target Owner and Assignee and may be
  coalesced for 30 seconds.
- `action_required` immediately targets explicit Task-audience members.
- `progress` produces no direct-message delivery.
- The event actor is always removed from the recipient set.

These Interfaces make no Feishu SDK calls and do not render or deliver
notifications. Channel Adapters own delivery receipts, rate limits, and UI.

## Transactional projection Outbox

`core.outbox` is the runtime-neutral delivery Interface for projecting Task
Events. Commitment Core never calls Feishu, OpenMax, HXA, or another external
system. A new `TaskCreated` or Task transition Event and its logical Outbox row
commit in the same SQLite transaction as the Task mutation and receipt. An
Outbox persistence failure therefore rolls the whole local mutation back. Once
the local transaction commits, an Adapter failure changes only its delivery
state; it cannot roll the Task back.

The logical Outbox row is keyed by the existing immutable Task Event. An
operator must explicitly register each normalized `projection`; claim, query,
acknowledge, and fail never create one. Delivery rows are then materialized
lazily for registered projections, so `feishu`, `openmax`, and any later
projection each claim and acknowledge the same Event independently instead of
competing for one shared delivery.

- `outbox.register({ projection, bootstrapPolicy, actorId?, idempotencyKey })`
  persists an enabled projection registry entry. `bootstrapPolicy` is required:
  `from_beginning` includes all existing logical Outbox rows, while `from_now`
  persists the current monotonic Outbox row baseline and includes only later
  rows. There is no implicit default to historical replay.
- Exact registration replay returns the same result. Re-registering the same
  projection and policy with a new key returns `{ created: false,
  registration }`; changing its policy fails with
  `PROJECTION_REGISTRATION_CONFLICT`. Registration views include `enabled`,
  `createdAt`, `createdBy`, and `baselineOutboxRowId`.
- `outbox.claim({ projection, workerId, idempotencyKey, leaseMs, limit? })`
  leases up to 50 pending deliveries by default, with a hard maximum of 100.
  `leaseMs` is an integer from 1 through 86,400,000. Results are ordered by
  Event occurrence, Task identity and version, and Event identity.
- A claim returns a stable delivery `version` and `attempt`. An expired lease
  becomes claimable by another worker and increments both values, fencing the
  stale worker.
- `outbox.ack({ projection, eventId, workerId, idempotencyKey },
  expectedVersion)` acknowledges only an unexpired lease owned by that worker.
- `outbox.fail({ projection, eventId, workerId, error, retryAfterMs?,
  maxAttempts?, idempotencyKey }, expectedVersion)` releases an owned lease.
  A bounded `retryAfterMs` schedules retry; reaching `maxAttempts` moves the
  delivery to `dead_letter`. Omitting `retryAfterMs` dead-letters a
  non-retryable failure immediately.
- `outbox.redrive({ projection, eventId, actorId, idempotencyKey },
  expectedVersion)` is an explicit local operator action. It accepts only a
  currently `dead_letter` delivery for a registered, enabled projection at the
  exact delivery version. It creates a new redrive generation in `retry_wait`,
  resets that generation's `attempt` to zero, and never claims or sends it.
  `totalAttempts` remains cumulative across generations.
- `outbox.query({ projection, eventId })` reads one delivery, including a
  synthetic `pending` view before lazy materialization.
  Set `includeRedrives: true` in event mode to return `{ delivery, redrives }`
  with the immutable operator audit ordered by generation.
  `outbox.query({ projection, statuses?, limit? })` provides stable bounded
  operational lists across `pending`, `leased`, `retry_wait`, `acknowledged`,
  and `dead_letter`.

Claim, acknowledge, fail, and redrive mutations have durable exact-replay receipts.
Changing normalized content under a used key returns `IDEMPOTENCY_CONFLICT`.
Other stable errors include `DELIVERY_NOT_FOUND`, `DELIVERY_NOT_LEASED`,
`DELIVERY_FORBIDDEN`, `DELIVERY_LEASE_EXPIRED`, and
`DELIVERY_VERSION_CONFLICT`. Redrive additionally returns
`DELIVERY_NOT_DEAD_LETTER` for a current non-dead-letter delivery. Every worker
or operator operation against a projection that is not registered and enabled
fails with `UNKNOWN_PROJECTION` before scanning Outbox history.

Each redrive stores the actor, caller key, prior and resulting delivery
versions, prior generation attempt count, cumulative attempt count, prior
error/dead-letter time, and redrive time in the same transaction as the
delivery update and exact-replay receipt. A pre-redrive database migrates to
generation zero and initializes `totalAttempts` from its existing attempt
count without losing delivery state.

Existing Task Events are backfilled into the logical Outbox when the schema is
first installed; this is a migration path, not a claim that their original
historical transactions contained Outbox rows. A pre-registry database safely
backfills every projection found in an existing delivery or idempotency receipt
as `from_beginning`, preserving existing and pending work; arbitrary new names
are never inferred from Event history. Task Run operations that change Task
state already create a Task Event and therefore an Outbox row. Run-only Events,
Evidence, and ExternalLink writes deliberately do not create projection records
in this slice. Disable/enable lifecycle and external platform projection
Adapters remain later slices.

After inspecting a dead-letter delivery and recording its current version, an
operator can run one local redrive explicitly:

```sh
node "$ZYLOS_DIR/.claude/skills/commitment-core/scripts/outbox-redrive.js" \
  --projection feishu \
  --event-id <event-id> \
  --actor <operator-id> \
  --idempotency-key <stable-key> \
  --expected-version <delivery-version> \
  --json
```

The command exits non-zero for stale versions, unknown projections,
non-dead-letter state, or malformed input. It does not run a worker cycle,
contact an external backend, or automatically retry the delivery.

## Projection Worker

`processProjectionBatch(...)` in `scripts/projection-worker.js` is the
runtime-neutral worker Interface. It claims one bounded delivery batch for one
`projection`, invokes the injected Adapter, and settles each delivery with its
claimed version. An Adapter may expose either `publishBatch({ deliveries })`
or `publishDelivery({ delivery })`. Batch publication retains all-or-nothing
failure classification. Per-delivery publication isolates a failed external
effect so later deliveries are still attempted and successful rows can be
acknowledged immediately. If both functions exist, the worker selects
`publishDelivery`.

A retryable Adapter failure moves only the affected settlement unit to
`retry_wait`; an error carrying `retryable: false` (including
`ProjectionAdapterError`) or exhaustion of `maxAttempts` moves it to
`dead_letter`. This structural flag lets platform Adapters honor the worker
Interface without importing Core implementation classes. Settlement fencing
on one row is counted and does not prevent settlement attempts for the rest of
the batch.

Every worker cycle must use a fresh `operationId`; the default is a random
UUID. Reusing an operation identity would replay the durable claim receipt,
including an earlier empty result. Acknowledge/fail receipt identities are
derived deterministically from the delivery identity and version, so an exact
settlement replay is safe.

The batch Adapter Interface has one critical invariant: `publishBatch({
deliveries })` must either publish the batch atomically, or make every
per-delivery effect idempotent under a replay of the same delivery version. If
the Adapter throws, the worker treats the whole batch as failed and it may
later be replayed. Non-atomic external Adapters should expose
`publishDelivery` so one poison event does not hold back unrelated deliveries;
each individual effect must still be idempotent because a process exit after
publish but before acknowledge is recovered by lease expiry and republish.
The worker Interface intentionally has no redrive operation. Only the explicit
operator Interface above can create a new redrive generation.

## Business MVP offline gate

Run the repeatable task-management business gate from the repository root:

```sh
npm --prefix skills/commitment-core run gate:business-mvp -- \
  --output /tmp/zylos-business-mvp-gate.json
```

The command always writes the same JSON report to stdout and optionally to the
explicit `--output` path. Exit status is zero only when all nine local gates
pass. The report uses schema
`zylos.task-management.business-mvp-gate/v2` and covers:

- ten replays of one Feishu-shaped source creating one intake and one Task;
- replay after a simulated process exit between Core ingest and intake ack;
- external projection outage isolation, retry, and idempotent recovery;
- OpenMax 403 fallback to local dispatch with review-only completion;
- both execution backends unavailable blocking dispatch after, never before,
  durable Core intake;
- publish success followed by an ack-window failure and lease-expiry replay
  with one external effect;
- Agent execution completion stopping at `review`;
- unauthorized acceptance rejection and authorized Acceptor transition to
  `done`;
- deletion, event replay, rebuild, and reconciliation of derived task state.

The gate opens only temporary local SQLite databases and uses injected clock,
process, and projection Adapter seams. It performs no network operation. Its
report separates the real, injectable `executedAt` audit timestamp from the
deterministic `scenarioTime`; `sourceRevision` may be supplied through the
Interface or `ZYLOS_SOURCE_REVISION`. The optional output is written through a
same-directory atomic replace with mode `0600`; an existing symbolic-link or
non-regular target is rejected. The report sets every `liveEnvironmentProof`
field to `false` and lists
the remaining real-environment proofs: live Feishu card send/callback, a real
AI employee Runtime claim/completion, and a production restart plus external
outage drill. Passing this gate is a prerequisite for those drills, not a
claim that they already succeeded.
## Feishu Task projection

`createFeishuTaskProjectionAdapter(...)` in
`scripts/feishu-task-projection.js` is the deep Core-to-Feishu projection
Module. Its only worker-facing Interface is `publishBatch({ deliveries })`.
The Module hides current Task snapshot reads, target resolution, create/update
selection, remote idempotency identities, and durable `ExternalLink` writes.
Commitment Core remains the fact source; Feishu is a replaceable projection and
must never drive Task state directly through this Module.

The injected publisher Interface is deliberately SDK-free:

- `createTask({ target, task, idempotencyKey })` must return one stable
  `{ externalId }`. Its idempotency key is stable for the Core Task, including
  retries after a remote create succeeds but the local `ExternalLink` write or
  Outbox acknowledgement does not.
- `updateTask({ target, externalId, task, idempotencyKey })` receives the current
  authoritative Task snapshot. Its idempotency key is stable for that Task
  version.
- Replaying either operation with the same key must not create another remote
  object or apply a non-idempotent effect. This remains mandatory when a batch
  partially publishes before another item fails.
- A publisher may set `error.retryable = false` for a permanent remote
  rejection. Other thrown errors are retryable and follow normal Outbox attempt
  bounds.

An absent `ExternalLink` selects create; a single `backend=feishu` link selects
update. The create result is linked locally before the delivery is eligible for
acknowledgement. A missing/malformed target, missing Core Task, malformed remote
identity, or ExternalLink identity conflict is non-retryable and becomes a
dead-letter instead of being acknowledged. Operators may fix configuration and
use the explicit Outbox redrive Interface.

The MVP default target resolver only accepts `task.acceptorId` values shaped as
a Feishu `open_id` (`ou_...`) and projects to that person's DM. Other actor ID
formats fail closed. A runtime may inject `resolveTarget({ task })` returning
`{ receiveId, receiveIdType }` for controlled routing. Group-chat mapping is
not inferred by Core and remains an explicit later routing configuration.

`scripts/feishu-projection-worker.js` provides registration, one-cycle, and
continuous worker seams without importing a Feishu SDK or reading Feishu
credentials. Registration makes history scope explicit:

```sh
node "$ZYLOS_DIR/.claude/skills/commitment-core/scripts/feishu-projection-worker.js" \
  register --bootstrap-policy from_now
```

Use `from_beginning` only after reviewing the existing Task population and the
resulting messages. Re-registering a different policy is rejected by the
projection registry.

Production assembly is supplied through an operator-selected local runtime
Module rather than a hard-coded component path. It must export:

```js
export async function createFeishuProjectionRuntime() {
  return {
    publisher: {
      async createTask({ target, task, idempotencyKey }) {},
      async updateTask({ target, externalId, task, idempotencyKey }) {},
    },
    // Optional. Omit to use acceptorId/open_id DM canary routing.
    resolveTarget({ task }) {},
  };
}
```

Run one canary cycle or the continuous supervisor:

```sh
node "$ZYLOS_DIR/.claude/skills/commitment-core/scripts/feishu-projection-worker.js" \
  run --runtime-module /absolute/path/to/zylos-feishu-runtime.mjs --once

node "$ZYLOS_DIR/.claude/skills/commitment-core/scripts/feishu-projection-worker.js" \
  run --runtime-module /absolute/path/to/zylos-feishu-runtime.mjs
```

The runtime Module owns SDK construction and credential access. Core only sees
the narrow publisher and optional resolver Interfaces. Worker tuning is bounded
through `COMMITMENT_FEISHU_PROJECTION_WORKER_ID`,
`COMMITMENT_FEISHU_PROJECTION_BATCH_SIZE`,
`COMMITMENT_FEISHU_PROJECTION_LEASE_MS`,
`COMMITMENT_FEISHU_PROJECTION_RETRY_AFTER_MS`,
`COMMITMENT_FEISHU_PROJECTION_MAX_ATTEMPTS`, and
`COMMITMENT_FEISHU_PROJECTION_INTERVAL_MS`. The continuous worker emits one
JSON record per cycle. Outbox leases make multiple workers safe when the
publisher honors the replay contract above; no separate projection state
machine is introduced.
## External execution Adapter seam

`scripts/external-execution-adapter.js` defines the reusable Interface for
OpenMax, Paperclip, local workers, and later execution backends. Call
`mapExternalExecutionEvent({ backend, eventId, eventType, taskId, actorId,
expectedVersion })`; it returns `{ command, expectedVersion }`, ready for
`command(command, expectedVersion)`. `backend` is a canonical lowercase
identifier, and the stable command key is
`<backend>:<eventId>:task-command`. Raw backend metadata must be normalized
outside this Adapter; extra or malformed fields fail closed.

Only `work_started` becomes `StartTask`. `deliverable_submitted`, `delivered`,
`completed`, `done`, and `succeeded` become `SubmitForReview`. Backend
completion is evidence for review, never acceptance: this Adapter never
produces `AcceptTask`, and unknown or human-acceptance event types fail closed.
Only an explicit, authorized acceptor action may move a reviewed Task to `done`.

## Execution control-plane gate

`scripts/execution-control-plane-gate.js` is the runtime-neutral selection
Interface for optional control planes and a local runtime fallback. Platform
Adapters first normalize their own authenticated health probes to:

- control plane `ready`, `disabled`, `unreachable`, or `http_error` (a 4xx/5xx
  status is required for `http_error`); and
- local runtime `ready` or `unavailable`.

The two observations must identify different canonical backends. Contradictory
health states for one backend fail closed instead of masquerading as fallback.

`decideExecutionControlPlane({ controlPlane, localRuntime })` returns one
machine-readable decision. Its `status` is `available` when the control plane
is selected, `degraded` when a non-ready control plane falls back to the local
runtime, and `blocked` only when neither backend can execute. A 403 therefore
selects local execution when local is ready; it never discards or rolls back a
Task already committed in Core. This gate must run only after Core ingest has
durably accepted the Task. Every non-blocked decision has
`dispatchAdmission: "allowed"`, while a blocked decision pauses dispatch but
never rejects Core intake. Every decision declares
`completionPolicy: "submit_for_review"`.

This Module deliberately performs no HTTP request, process probe, task claim,
or dispatch. OpenMax, HXA, Paperclip, and local runtime details stay in their
Adapters. An execution dispatcher must obtain fresh normalized observations,
call this gate before selecting a backend, and continue to map backend events
through `external-execution-adapter.js`. Therefore a selected backend's
`delivered`, `completed`, `done`, or `succeeded` signal still moves the Task
only to `review`; it cannot produce `AcceptTask`.

Operators and Adapter acceptance tests can evaluate the exact gate with the
side-effect-free diagnostic CLI. For example, a control-plane 403 with a ready
local runtime exits zero and reports `degraded` with `selectedBackend: "local"`:

```sh
node scripts/execution-control-plane-doctor.js \
  --control-plane openmax \
  --control-plane-state http_error \
  --http-status 403 \
  --local-runtime local \
  --local-runtime-state ready \
  --json
```

The CLI exits `0` for `available` and `degraded`, `2` for a valid `blocked`
decision, and `1` for malformed or contradictory observations. It does not
read credentials, contact a backend, mutate Core, claim a Task, start a
runtime, or publish a message. A platform Adapter remains responsible for
authenticated probing and for converting its result into these strict fields.

## Derived attention view

`scripts/render-attention-view.js` rebuilds the dedicated
`$ZYLOS_DIR/memory/task-attention.md` from the Core list-query Interface. It
never writes `memory/state.md`: that file also contains non-task memory and is
not owned by this Module. The dedicated file is a disposable, read-only
attention view: never parse it to create or update Tasks, and never treat edits
to it as authoritative state. The zylos-memory
`task-attention-context.js` provider can load it through an explicit component
shard declaration. The file's presence alone never enables SessionStart
injection, and the provider never merges it into or replaces `memory/state.md`.

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
does not replace the previous view. Before replacing an existing destination,
the publisher requires its exact version 1 ownership marker and fails closed
with `ATTENTION_VIEW_NOT_OWNED` when the file is foreign or malformed.

The Attention Adapter uses the transactional Outbox projection name
`attention`. One batch of Task Events is only a wake-up signal: the Adapter
rebuilds the current view once, then the worker acknowledges each Event. Atomic
file replacement makes an expired-lease replay safe after publication but
before all acknowledgements.

Supervisor initialization explicitly calls
`outbox.register({ projection: 'attention', bootstrapPolicy: 'from_now', ... })`
before publishing the current snapshot. Register-first prevents an Event from
falling into a gap between the snapshot and the registration baseline: Events
after the baseline remain claimable, while the immediately following full
snapshot covers all earlier state. Registration and publication repeat
idempotently at every process start so a crash between those two operations is
repaired on restart. The worker never relies on claim to create an implicit
projection. Compatibility with a pre-registry Core is temporary; once the
registry Interface is present, unknown projections fail closed.

Run the opt-in worker with
`node scripts/attention-projection-supervisor.js`, or one bounded cycle with
`node scripts/attention-projection-supervisor.js --once`. Defaults are a 2,000
ms interval, batch size 25, 30,000 ms lease, 5,000 ms retry delay, and five
attempts. Override them with
`COMMITMENT_ATTENTION_PROJECTION_INTERVAL_MS` (250..60,000),
`COMMITMENT_ATTENTION_PROJECTION_BATCH_SIZE` (1..100),
`COMMITMENT_ATTENTION_PROJECTION_LEASE_MS` (1..86,400,000),
`COMMITMENT_ATTENTION_PROJECTION_RETRY_AFTER_MS` (1..604,800,000), and
`COMMITMENT_ATTENTION_PROJECTION_MAX_ATTEMPTS` (1..100). The optional
`COMMITMENT_ATTENTION_VIEW_PATH` selects a reviewed alternate destination.
The supervisor uses one fresh operation identity per cycle, logs errors and
continues, and holds a fenced singleton lease in
`$ZYLOS_DIR/.zylos/supervisor-leases.db`. The lease owner is a random token,
not a PID; a live lease rejects a contender, an expired lease can be taken over,
and release is conditional on the owner token. The process renews the lease
while active and releases it on SIGINT/SIGTERM. It is absent from the default
PM2 ecosystem and does not run until an operator explicitly invokes it.

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

Assignment changes, reconciliation, external state synchronization, and
platform-specific projection Adapters remain later slices and must extend this
Interface deliberately.

The local `zylos task` CLI is an Adapter over this Interface. It must not query
or mutate the SQLite tables directly. It lazily loads the deployed Module from
`$ZYLOS_DIR/.claude/skills/commitment-core`, where Skill dependencies are
installed, so unrelated root CLI commands do not require SQLite at startup.
Task state commands are `create/list/show/start/submit/accept/rework/cancel/reopen`.
Run operations are exposed separately as `claim`, `heartbeat`, `complete-run`,
`release-run`, and `runs`; `complete-run` intentionally submits for review and
does not accept the Task. Every mutating Run command requires explicit Task/Run
versions and a worker identity, and accepts a stable caller idempotency key.
