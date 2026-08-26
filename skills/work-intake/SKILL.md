---
name: work-intake
description: Channel-neutral natural-language classification for deciding whether inbound work is chat, a task, or needs confirmation.
---

# WorkIntake

WorkIntake is an independent deep module. Its public Interface is:

```text
classify(InboundEnvelope, {
  defaultAssigneeId?,
  agentId?,
  agentAliases?
}) -> chat_only | create_task | confirm
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
- An explicit human or configured Agent assignment always wins. Core has no
  built-in Agent name or logical identity. C4 resolves the deployment from
  `ZYLOS_AGENT_ID` (or `ZYLOS_AGENT_PROFILE`) plus the JSON array
  `ZYLOS_AGENT_ALIASES`; Channel Adapters consume the same logical ID.
- A deployment may set `C4_WORK_INTAKE_DEFAULT_ASSIGNEE_ID` for otherwise
  unassigned tasks. Core validates both explicit Agent assignments and this
  trusted default again when adapting the decision.
- ambiguous people, ambiguous times, and high-risk external actions return
  `confirm`.
- Supported Chinese relative/calendar deadlines are normalized against the
  immutable inbound timestamp and IANA time zone before Commitment ingestion;
  date-only deadlines default to 18:00 local time.
- A bounded natural-language offset such as `提前1小时提醒` becomes
  `TaskDraft.reminderMinutesBeforeDue = 60` only when the same draft has a
  resolvable deadline. A reminder without a deadline returns `confirm` instead
  of creating a degraded Task. Persisted TaskDrafts from before this field was
  introduced remain adaptable with a null reminder.
- ordinary questions and one-shot information requests return `chat_only`.
- `sourceKey` is derived from `channel + message_id + intent_revision`.
- platform SDK/CardKit values never enter this module.
