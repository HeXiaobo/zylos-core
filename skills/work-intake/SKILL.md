---
name: work-intake
description: Channel-neutral natural-language classification for deciding whether inbound work is chat, a task, or needs confirmation.
---

# WorkIntake

WorkIntake is an independent deep module. Its public Interface is:

```text
classify(InboundEnvelope) -> chat_only | create_task | confirm
```

The returned value always includes a stable `reasonCode`, `intentRevision`, and
`sourceKey`. Task decisions include a structured `TaskDraft`.

WorkIntake is not part of the Commitment Core state machine. It has no database
or platform dependency and cannot create a task by itself. C4 may adapt an
automatic or user-confirmed decision into Commitment Core's existing durable
`ingest` Interface. Platform adapters own event authentication, tenant access,
identity resolution, mentions, and confirmation-card rendering.

Invariants:

- `ownerId = acceptorId =` the human sender by default.
- `assigneeId = agent:yueran` only when the text explicitly assigns work to 玥然.
- ambiguous people, ambiguous times, and high-risk external actions return
  `confirm`.
- ordinary questions and one-shot information requests return `chat_only`.
- `sourceKey` is derived from `channel + message_id + intent_revision`.
- platform SDK/CardKit values never enter this module.
