# Assistant Reply contract v1 fixtures

This directory freezes the Gate 0 cross-repository vocabulary. The canonical
fixture is `common-contract-vectors.json`, copied byte-for-byte from the parent
contract source. `contract-vectors.json` remains an identical compatibility copy
for the original Core test path; both copies are checked against the same fixed
SHA-256. The fixture is the target contract, not a claim that the current Core
fork implements it.
`assistant-reply-contract.test.js` validates the target invariants, while
`assistant-reply-characterization.test.js` records current support and leaves
unimplemented target behavior as `test.todo`.

## Official control

`upstream-control.json` uses only immutable Git object identities. Reproduce
the relationship and inspect the cited code with:

```text
git merge-base 0b0d6c86e80f42df6abf7e8d177f97601835317e ec0b851c22cbb2dd57e461c4cb7229908a12d887
git rev-list --count ec0b851c22cbb2dd57e461c4cb7229908a12d887..0b0d6c86e80f42df6abf7e8d177f97601835317e
git diff --name-status ec0b851c22cbb2dd57e461c4cb7229908a12d887..0b0d6c86e80f42df6abf7e8d177f97601835317e -- skills/comm-bridge
```

The official control establishes the unified C4 SQLite entry, priority/FIFO,
one dispatcher over the shared Runtime, opt-in `requireIdle`, and explicit
`c4-send`. Assistant Request lifecycle, automatic final-output candidates and
event-row delivery leases are fork-only extensions.

The common v1 contract keeps the official shared-runtime boundary while making
the fork's additional lifecycle explicit: source-derived deduplication keys are
not sent across the Core boundary; RunCompleted/RunFailed reference an
independent outcome; RunCancelled is execution-only; ReplyIntent and
DeliveryReceipt are separate from DeliverySettlement; and `runtimeLaneId` is
the only public runtime lane field.

## Current fork

The fork already provides durable Assistant Request/event rows, one active
runtime admission, monotonic event sequence, idempotent inbound wake receipts,
terminal replay, delivery retry fields and `[SKIP]` suppression. It does not
yet implement dual transport/logical identity, Conversation Lane sequence,
immutable Context Snapshot, cooperative cancel/generation fencing, explicit
Outcome/Intent/Receipt settlement, per-consumer progress cursors, or the v1
Task Command authorization envelope.

Current `CompleteRun` also records a non-silent outbound conversation as
`delivered`. That is characterization evidence, not the v1 contract:
`RunCompleted` must remain independent from Delivery Settlement.
