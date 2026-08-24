---
name: zylos-memory
description: >-
  Core memory system. Maintains persistent memory across sessions via tiered
  markdown files following the Inside Out model. Handles Memory Sync (processing
  conversations into structured memory), session rotation, consolidation, and
  context-aware state saving. Must be launched via a runtime-appropriate
  background subagent mechanism — do not invoke with the Skill tool.
disable-model-invocation: true
user-invocable: false
---

# Memory System

Maintains persistent memory across sessions via tiered markdown files.
This skill must be run via a runtime-appropriate background subagent mechanism. For Claude, use the Task tool (`subagent_type: general-purpose`, `model: sonnet`, `run_in_background: true`). For Codex, prefer the session's native subagent tools `spawn_agent`/`wait_agent` (host session tools — they do not appear in `codex --help`) with a Codex-supported model; do not hardcode `sonnet`.

## Architecture

```text
~/zylos/memory/
├── identity.md              # Bot soul + digital assets (always loaded)
├── state.md                 # Active working state (always loaded)
├── references.md            # Pointers to config files (always loaded)
├── users/
│   └── <id>/profile.md      # Per-user preferences
├── reference/
│   ├── decisions.md         # Key decisions with rationale
│   ├── projects.md          # Active/planned projects
│   ├── preferences.md       # Shared team preferences
│   └── ideas.md             # Uncommitted plans and ideas
├── sessions/
│   ├── current.md           # Today's session log
│   └── YYYY-MM-DD.md        # Past session logs
└── archive/                 # Cold storage
```

## Memory Sync

### Priority

Memory Sync is the highest-priority internal maintenance task.
When triggered, run it before handling queued user messages.

### Trigger Paths

1. Session init: if C4 unsummarized count is over threshold, launch memory sync.
2. Scheduled context check: if context usage is high, launch memory sync.

Both launch a background subagent using the current runtime's supported subagent mechanism with this file's Sync Flow as the prompt.

### Codex Background Execution

In Codex, use the session's native subagent tools: `spawn_agent` to
launch the sync subagent and `wait_agent` to collect its result. These are
host session tools — they do not appear in `codex --help`. For a single
long-running command, an async exec session (`exec_command` +
`write_stdin`) also works. Bare `nohup ... &` does NOT survive the
tool-call boundary and must never be used for sync. Never use PM2 for
sync — do not create PM2 services, run `pm2 start ... codex exec ...`, or
fork an extra `codex exec` sidecar: one-shot sync processes leave stopped
services piling up in the PM2 list. If the session exposes no native
background-agent capability, run the sync inline as a last resort and note
that in the handoff/status.

### Sync Flow

1. Rotate session log if needed:
   `node ~/zylos/.claude/skills/zylos-memory/scripts/rotate-session.js`
2. Fetch unsummarized conversations from C4:
   `node ~/zylos/.claude/skills/comm-bridge/scripts/c4-fetch.js --unsummarized`
   If output says "No unsummarized conversations.", skip to step 5
   (still save current state). Otherwise, note the `end_id` from the
   `[Unsummarized Range]` line.
3. Read memory files (`identity.md`, `state.md`, `references.md`, user profiles, `reference/*`, `sessions/current.md`).
4. Extract and classify updates from conversations into the correct files.
5. Write memory updates (always — even without new conversations,
   update `state.md` and `sessions/current.md` with current context).
   <!-- 5b:canon:start -->
5b. **Commitment gate (2026-07-29, veda proposal + SS adoption): sweep this
   session for anything still in "commitment state" and make sure it is on
   disk.** Go through the conversation window for **new assignments, new
   requests-for-decision, and new promises** ("I will do X", "I am waiting on
   X", "you are now the owner of X") and check each one against `state.md`.
   Land the ones that are missing; if one cannot be landed, **report it
   explicitly** in the sync result. Rationale: completed actions leave
   artifacts, **commitments only live in the conversation** — so they are the
   class that silently evaporates on session switch. This gate is here (and
   not in anyone's memory) because the sync trigger is exactly the moment a
   session is about to end.
   <!-- 5b:canon:end -->
   ⚠️ This file is Zylos-managed and may be overwritten on upgrade — the
   provenance copy of this gate's canon region lives in
   `memory/reference/preferences.md`, section **"canonical 5b/5c/5d v4"**;
   restore from there by BYTES after any upgrade, and re-verify by sha, not by
   "the section is present". Recompute that sha with `canon-slice.py`, over the
   region between this gate's `canon:start` / `canon:end` markers (the script
   requires each marker to occur exactly once, so do not spell either of them
   out in prose). **Never re-derive it from a quoted byte range or line
   number**:
   those are descriptive only, they shift with every amendment, and a sha
   re-derived from them reports a drift that did not happen.

   <!-- 5c:canon:start -->
5c. **Retraction gate (2026-07-30, veda observation + SS structural fix):
   before writing any finding to disk, check whether a later message in the
   same window retracted or corrected it — and record the FINAL state, never
   the first version.** Scan the window for retraction markers (`推翻` /
   `更正` / `撤回` / `作废` / `我错了` / `retract` / `correct`) and, for every
   conclusion you are about to land, verify no later message overturned it.
   Rationale: **"I corrected it in the conversation" does NOT protect the
   record** — the wrong claim and its retraction are two independent rows in
   `c4.db`, and a summary can touch one without the other, storing a refuted
   claim as established fact. Three hard rules:
   (a) **never split a claim/retraction pair across a checkpoint boundary.**
   **Execution point = the `end_id` chosen in step 8**: if that `end_id` would
   split such a pair, either **extend it past the retraction**, or **roll it
   back to before the claim**. Never checkpoint a range that contains a claim
   but not its retraction. (The roll-back option matters: when the retraction
   has not happened yet — the point is still under debate — extending is
   impossible, and without a second exit the rule would force the bad choice.)
   A third path — **patching by creating a follow-on checkpoint** — is an
   allowed fallback, but it **must be labelled as not equivalent to an `end_id`
   exit**, and it **must be completed inside the same session**: session init
   injects only the last checkpoint, so between the two there is a window in
   which the only thing a fresh session reads is the refuted claim.
   (b) **contested-but-unresolved findings must be written with a status
   marker** (`待核`, or `已验` + anchor), never as a bare factual sentence,
   because a bare sentence is indistinguishable from a verified one.
   (c) when a landed entry is later refuted, **do not delete it** — mark
   "作废勿引" in place and state what refuted it.
   ⚠️ (c) does not cover checkpoint summaries: they have no rewrite path
   (`create | list | latest`, no amend), so marking-in-place is not executable
   on them — **for checkpoints, (a) is the only line of defence.**
   Empirical basis for (a): two machines independently hit this on the same
   night, on the same claim — in each case the wrong assertion and its
   retraction sat 3–5 records apart, both inside the not-yet-summarised range,
   i.e. exactly where a checkpoint boundary can fall between them. (Stated
   without machine or record ids on purpose: a shared artefact must not carry
   single-machine facts.)
   Why gate placement matters: a claim travels
   `thread → operator digest → c4.db log → memory → canonical → client-facing`.
   The further along it gets, the lower the chance anyone re-reads the source
   and the higher the chance it is cited as established fact — the two move
   together, so a leak caught late is disproportionately more expensive than
   one caught early.
   <!-- 5c:canon:end -->
   <!-- 5d:canon:start -->
5d. **Completion-boundary gate (2026-08-07, SS proposal + veda rationale;
   maker veda / checker SS, two-sign complete): before fixing `end_id`, look at
   `end_id` AND THE FEW RECORDS AFTER IT, and check whether any of them CLOSED a
   pending item still listed in `state.md` / `reference/projects.md`.** If one
   did, mark it closed on the spot and note "closed outside the checkpoint
   window", so a later reader knows why the checkpoint summary does not contain
   it. **This is the action/completion mirror of 5c's claim/retraction.**
   🔴 **Why this must be a deliberate "take one look" step and cannot be a
   scan**: 5c is scannable because it has negation markers (`推翻` / `更正` /
   `撤回` / `作废`); **"it got done" carries no negation word at all — it reads
   exactly like an ordinary progress note. It is not detectable by pattern.**
   🔴 **Inverse-error guard (SS, required):** completion judgements can be wrong
   too, and once something is marked closed nobody revisits it. **When the
   evidence is not sufficient to confirm closure, mark it `疑似已闭·待核`
   rather than closed**; and follow 5c(c) — **never delete the original entry;
   annotate in place and state WHICH record closed it.**
   <!-- 5d:canon:end -->
   ⚠️ Same managed-file caveat as 5b/5c: this file is Zylos-managed and may be
   overwritten on upgrade — the provenance copy of this gate's canon region
   lives in `memory/reference/preferences.md`, section **"canonical 5b/5c/5d
   v4"** (v2 and v3 are retired: v3 predates the canon-boundary change and
   contains no 5d at all). Restore from there by BYTES, not by rewording, and
   re-verify with `canon-slice.py` — not by "the section is present".
6. Audit `references.md` against its content rules
   (`references/references-file-format.md`): relocate rule-violating
   entries to their routed destination (`reference/decisions.md`,
   `archive/`, or a pointer to the config file) instead of leaving or
   appending them. If the file exceeds the 8KB warn threshold
   (`memory-status.js` reports WARN), trim until it is back under.
   🔴 **Before ANY block leaves this file, EVERY gate below applies — (a)
   through (d), count them off the list, not off this heading; none optional
   (2026-08-14, veda; provenance copy in `memory/reference/preferences.md`,
   section "references 群禁令误移"; restore after any upgrade).**
   Why it is spelled out here, at the exact point where the thought "I should
   compress this file" forms: Sync#830 moved the whole Feishu-groups section
   out and left one pointer line. It went 8,853 → 6,680 B **on the machine
   where that happened** (that incident's numbers, not a claim about yours) and
   was **green on every check — green because it had deleted the alarm bell.**
   What went out was the list of
   what must never be sent into a chat with the client present, "trust the
   chat_id, never the group name", and the external-group ban list. The
   destination file did not contain any of them. Restored verbatim from the
   03:00 git snapshot.
   (a) **Prohibitions and scope qualifiers stay where they are.** Move only
   reasons, history and narrative. A prohibition plus the basis that makes it
   decidable plus the evidence that makes it credible is ONE atomic unit —
   splitting it across files is the single most dangerous move available here.
   (b) **"Moved to X and left a pointer" is TWO independent claims:** ① it
   went out ② X really contains it. Before removing anything from the source,
   **read the destination file and confirm that content is actually there**
   (grep the distinctive sentence, or bytes/sha). If the destination cannot be
   read, the only reportable result is "source untouched · destination
   unverified" — 🚫 never write PASS.
   (c) **Acceptance is not "how big is it now", it is "where did the removed
   text go, and is it really there".** Also check the deletion side directly:
   `memory/` is a git repo, so `git log -p` the removed lines and ask of every
   ban word, qualifier and ticket number in them: does it still have a home?
   (d) 🔴 **The warn line does not authorize removing prohibition content.**
   When the two conflict, **go over the line**. If this machine has parked a
   file above its warn line on purpose, or has a freeze on it, that is recorded
   in **this machine's** provenance section in
   `memory/reference/preferences.md` — read it there and treat it as a
   decision, not a backlog item.
   🚫 **Never hardcode one machine's byte figure, warn line or freeze ticket id
   into this file.** It is the same base file on every machine, so a
   single-machine fact written here is simply false on the others — and it
   reads as canonical. (Caught by SS as checker, 2026-08-14: this gate's own
   first draft hardcoded one machine's parked size and freeze ticket. On his
   machine the size, the ticket id and even the KIND of freeze were all
   different — so both sentences were false there while reading as rules. A
   gate's own example is the most likely place for the thing it bans to leak
   in; that is why the numbers are not repeated here either.)
7. Audit `state.md` against its content rules
   (`references/state-format.md`): relocate rule-violating content to its
   routed destination (`reference/projects.md`, `reference/decisions.md`,
   `archive/`, or a pointer to the on-demand file that already holds it)
   instead of leaving or appending it. If the file exceeds the 10KB warn
   threshold (`memory-status.js` reports WARN), trim until it is back
   under.
   🔴 **How to trim — this half is not optional (2026-08-04, SS; provenance
   copy in `memory/reference/preferences.md`, restore after any upgrade).**
   Trim by **moving whole blocks out to `reference/*` and leaving a pointer
   in place**. **Never** trim by shortening sentences: the words that get
   cut first are qualifiers ("unverified", "pending owner"), scope markers,
   and the second half of an action — exactly the parts that carry the
   risk. Measure with `wc -c` (bytes, not characters) after each move.
   🔴 **Every gate in step 6 applies here verbatim — (a) through (d)**
   (prohibitions stay in place · read the destination before removing the
   source · acceptance = where did the removed text go · the warn line does not
   authorize removing prohibitions). Moving a whole block and leaving a pointer
   satisfies this step's letter and still deleted live redlines in Sync#830,
   because nobody checked claim ② — the destination.
   ⚠️ If this machine has a freeze on `state.md`, **its kind, its ticket id and
   its owner differ per machine** — read this machine's provenance section
   before writing, and do only what that freeze allows. Where a freeze applies,
   over-budget is **reported, not fixed**: raise the EXIT flag instead of
   trimming.
   ⚠️ Why this is spelled out here rather than left to the caller: step 5b
   (commitment gate) is a **monotonic writer** against this budget — it
   appends on every run, while the budget was being enforced only by
   whatever the invoking brief happened to say. A rule that lives in a
   hand-written brief has a failure point on **every** invocation; one that
   lives in this flow does not. (Observed on a peer machine: `state.md` grew
   +2,448 B across two syncs, over the warn line, with no human edits —
   every append individually correct.)
7b. **Banned-character gate — write-side rule, not just a scan.**
   `custom-hooks/session-start/01-banned-words.md` lists characters that must
   never appear anywhere in `memory/`. When a sync needs to *document* such a
   rule or a violation, **never type the literal character** — refer to it by
   pointer (`01-banned-words.md`) plus a pinyin/structural gloss.
   🔴 Why this is a numbered step and not a note: two consecutive sync runs
   (2026-08-02, 2026-08-03) each wrote the literal character **while writing
   the audit note about that very character**, and both were caught only by
   the final scan. The scan works; the generating side had no guard. A ban's
   own examples are its most likely leak — the writer skips them because they
   look like the rule rather than a violation.
   Then run the scan and require **0 hits** before step 8:
   `grep -rn "<char from 01-banned-words.md>" ~/zylos/memory/` → expect exit 1.
   🔴 **Scope is NOT limited to `memory/` — it explicitly includes the step-8
   checkpoint summary (2026-08-04, SS; third occurrence, same shape as the two
   above).** Observed: a sync wrote a clean audit line for every file in
   `memory/` and then typed the literal character **inside the checkpoint
   summary itself**, in the very sentence reporting "banned-char scan: 0 hits".
   The `memory/` scan cannot catch it — the summary lives in `c4.db`, not on
   disk — yet **session init injects the latest checkpoint summary into every
   new session**, so it reaches context on every single start, and
   `c4-checkpoint.js` has **no amend path** (`create | list | latest`), so it
   cannot be fixed in place.
   ⇒ Two hard requirements:
   (a) **Before calling `create`, scan the summary string itself** (by code
   point, not by eyeballing) and require 0 hits; report the character only by
   pointer + gloss, exactly as above.
   (b) If a landed checkpoint is found to contain it, the only remedy is to
   **create a superseding checkpoint with a clean summary** so session init
   stops injecting the offending text; say so explicitly in the new summary.
   📌 Judgement: the standing ban's own scope is "any channel, any context"
   (`01-banned-words.md`), but this step used to say "anywhere in `memory/`".
   **A rule stated narrower than the standing rule becomes the one that gets
   followed** — and the gap sits exactly where the carrier is not a file.

7c. **Resident-tier customer-money scan** (per `03-crm-single-source.md`):
   `state.md` / `references.md` / `identity.md` must hold **no** customer
   amounts, payment status, commission rates, or renewal figures — pointer to
   CRM only. Report the scan result explicitly; do not report a bare "clean".

8. Create checkpoint (only if conversations were fetched in step 2):
   `node ~/zylos/.claude/skills/comm-bridge/scripts/c4-checkpoint.js create <end_id> --summary "SUMMARY"`
9. Confirm completion. **Report measured byte sizes taken from
   `memory-status.js` at that moment** — never a size quoted from the task
   brief or remembered from earlier in the run (files grow mid-run; a stale
   number read as current is how a WARN gets missed).

## Classification Rules

- `reference/decisions.md`: committed choices that close alternatives.
- `reference/projects.md`: scoped work efforts with status.
- `reference/preferences.md`: standing team-wide preferences.
- `reference/ideas.md`: uncommitted proposals.
- `users/<id>/profile.md`: user-specific preferences.
- `state.md`: active focus, pending items, and blockers only, per the
  content rules in `references/state-format.md`; completed-task narrative,
  decisions, and run history are routed out, never accumulated.
- `references.md`: pointers and stable identifiers only, per the content
  rules in `references/references-file-format.md`; never duplicate config
  values, never accumulate narrative history.

## File Formats and Examples

Each memory file type has a format definition in `references/` and a
worked example in `examples/`:

| File | Format | Example |
|------|--------|---------|
| `identity.md` | `references/identity-format.md` | `examples/identity.md` |
| `state.md` | `references/state-format.md` | `examples/state.md` |
| `references.md` | `references/references-file-format.md` | `examples/references.md` |
| `users/<id>/profile.md` | `references/user-profile-format.md` | `examples/user-profile.md` |
| `reference/decisions.md` | `references/decisions-format.md` | `examples/decisions.md` |
| `reference/projects.md` | `references/projects-format.md` | `examples/projects.md` |
| `reference/preferences.md` | `references/preferences-format.md` | `examples/preferences.md` |
| `reference/ideas.md` | `references/ideas-format.md` | `examples/ideas.md` |
| `sessions/current.md` | `references/session-log-format.md` | `examples/session-log.md` |

## Supporting Scripts

- `session-start-inject.js`: prints core memory context blocks for hooks.
- `rotate-session.js`: rotates `sessions/current.md` at day boundary.
- `daily-commit.js`: local git snapshot for `memory/` if changed.
- `consolidate.js`: JSON consolidation report (sizes, age, budget checks).
  Use for deliberate memory maintenance, or for scheduler-triggered
  consolidation when such a task is configured. Review the report and apply
  the Consolidation Review rules below.
- `memory-status.js`: quick health summary.
  Use when you need a fast manual check of core file sizes and budget status.
  If it reports `OVER`, run `consolidate.js` and perform the needed cleanup.

C4 scripts used by sync flow (provided by comm-bridge skill):
- `c4-fetch.js --unsummarized`: fetch unsummarized conversations and range.
- `c4-checkpoint.js create <end_id> --summary "..."`: create sync checkpoint.

## Consolidation Review

The weekly consolidation task runs `consolidate.js` and outputs a JSON report.
Review the report and apply these rules:

### Core File Budgets
- Files over 100% budget: summarize and trim older entries.
  Move historical content to `reference/` or `archive/`.
- `identity.md`, `state.md`, and `references.md` must stay under 16KB.
- Apply file-specific cleanup:
  - `identity.md`: keep only stable identity traits, principles, durable
    collaboration style, and digital asset references. Move operational state
    and one-off lessons elsewhere.
  - `state.md`: keep active focus, pending tasks, and recent completions.
    Move completed or historical detail to `sessions/current.md` or
    `reference/`. Apply the content rules in `references/state-format.md`;
    the sync-time audit (Sync Flow step 7) should keep it under the 10KB
    warn threshold.
  - `references.md`: keep pointers and lookup facts only. Move prose,
    project history, and detailed decisions to `reference/`. Apply the
    content rules in `references/references-file-format.md`; the sync-time
    audit (Sync Flow step 6) should keep it under the 8KB warn threshold.

### Session Logs
- Logs in `archiveCandidatesOlderThan30Days`: move from `sessions/` to `archive/`.

### Reference Files (`reference/*.md`)
These files have no size cap. Maintenance is at the entry level.
Freshness is reported by file mtime (Phase 1 limitation):
- **active** (< 7 days): no action.
- **aging** (7–30 days): no action.
- **fading** (30–90 days): open the file. Review entries by their dates
  and status fields. Update or confirm still-relevant entries; move
  obsolete entries (superseded/completed/abandoned/dropped) to `archive/`.
- **stale** (> 90 days): same as fading, but prioritize review.
  Entries that are clearly still critical may remain.

**Immunity:** Entries with importance 1-2 (defined in entry metadata) are
immune to automatic fading suggestions. They may still be reviewed but
should not be archived based on age alone.

### User Profiles
- Profiles over ~1KB: summarize older notes.

### General Rules
1. Never delete — always move to `archive/`. Content is recoverable
   from `archive/` or git history.
2. Log consolidation actions in `sessions/current.md`.

## Best Practices

1. Keep `state.md` lean (tight context budget).
2. Prefer updates over duplication.
3. Use explicit dates/timestamps for entries.
4. Archive instead of deleting historical data.
5. Route user data to user profiles.
6. Keep configuration values in config files; use `references.md` as an index.
