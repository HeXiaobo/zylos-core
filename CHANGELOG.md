# Changelog

All notable changes to zylos-core will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.7.2-rc.14] - 2026-08-27

### Fixed
- Immutable fork-pair, HXA recovery, and SS blocker bootstraps now identify
  their downloaded Node entrypoints by filesystem identity. macOS aliases
  `/var` as `/private/var`; comparing unresolved path strings previously made
  a valid temporary entrypoint look like an imported module, causing a silent
  zero-exit no-op with no report. The fixed scripts execute normally through
  either path and retain their structured fail-closed reports.

## [0.7.2-rc.13] - 2026-08-27

### Fixed
- WorkIntake delivered directly to a managed Agent now defaults otherwise
  unassigned tasks to that Agent's logical identity. An explicit
  `C4_WORK_INTAKE_DEFAULT_ASSIGNEE_ID` still takes precedence, so deployments
  can intentionally route intake elsewhere without changing classification.
- The fixed communication-continuity postcheck now submits an isolated direct
  WorkIntake task and reads its durable queue envelope back from SQLite. A
  missing deployment identity, a non-task decision, or a missing/wrong
  `assigneeId` fails the upgrade closed instead of allowing projection
  dead-letters to appear after an apparently successful upgrade.

## [0.7.2-rc.12] - 2026-08-27

### Fixed
- Self-upgrade now detects when `pm2 start ecosystem --only <service>` exits
  successfully without starting a service that is absent from the ecosystem.
  Existing component workers are reactivated through their cached PM2
  definition and must read back as online before step 11 can succeed. Missing
  status, inspection failures, failed cached restarts, and workers that remain
  stopped now fail closed before the PM2 dump is saved.
- Component upgrades and `zylos service restart` now use the same managed
  online postcondition; a zero-exit ecosystem no-op cannot be reported or
  persisted as success.
- Self-upgrade rollback now saves the restored PM2 state after reactivating
  baseline services, including failures that introduced no target-only process.

## [0.7.2-rc.11] - 2026-08-27

### Fixed
- Core now exposes `UpdateTaskReminder` through the supported
  `zylos task set-reminder` command. Reminder changes require a canonical due
  date, owner/acceptor authorization, expected-version CAS and a stable
  idempotency key; the Task, event, command receipt and projection outbox are
  committed atomically, while same-value requests are durable zero-write
  replays.
- Self-upgrade now inventories every live top-level skill before mutation,
  verifies that the transaction backup covers the same directories and file
  counts, and enforces foreign/business-skill continuity both immediately
  after Core sync and again before committing merge baselines. A missing
  directory, collapsed tree, missing `SKILL.md`/`scripts` tree or missing
  declared entrypoint fails the upgrade and enters the existing rollback path.
- A successful pinned Core + Feishu pair upgrade now retains only the current
  and immediately preceding verified Core rollback snapshots. Cleanup runs
  only after the complete post-upgrade communication gate passes, recognizes
  exact upgrader-owned top-level backup directories, revalidates each path
  immediately before deletion, and reports every retained, removed, or
  skipped path. Failed or partial upgrades preserve all rollback snapshots.

## [0.7.2-rc.10] - 2026-08-27

### Fixed
- Claude runtime admissions now keep an immutable turn-start observation
  fence while lifecycle activity advances a separate recovery generation.
  Same-turn hook processes may persist out of timestamp order without causing
  a valid `Stop` to be silently rejected, while hooks observed before the next
  turn began remain fenced out.
- A bound request and its runtime admission now reach terminal state in one
  SQLite transaction. Binding ownership and its pending/bound/rejected/closed
  lifecycle are admission-scoped durable state, so a requestless HXA turn can
  never bind or finalize an unrelated Feishu request. Request-scoped tool,
  public-reasoning, and output mutations now verify that exact active
  request/session and bound admission before any event or output write; a
  stale or misrouted hook is a zero-write conflict.
- A durable, admission- and session-fenced final-output candidate provides a
  conservative idle-recovery fallback when a real final display was recorded
  but `Stop` is lost. Exact display events are idempotent, an observation-time
  plus exact activity-identity high-water fence prevents a late old final from
  becoming active, and later output or tool activity invalidates the
  candidate. Different activities observed in the same millisecond are
  intentionally ambiguous and fail closed. Pending out-of-order display
  batches retain their first causal timestamp when replayed. Normal `Stop`
  remains the canonical answer.
- Closed binding projection is now a retryable SQLite outbox. Stop or idle
  recovery commits request/admission terminal state first, then atomically
  projects the content-free binding JSON; the dispatcher will not admit the
  next conversation until any pending projection succeeds. Rejected Stop
  fences are written to diagnostics instead of failing silently.
- The Node test runner always creates an isolated temporary `HOME` and
  `ZYLOS_DIR`, preventing rollback-path tests from deleting or overwriting the
  live `~/zylos/.env`.
- The pinned fork-pair orchestrator now verifies the complete Feishu/Core
  protocol contract and treats the shared binding projector as a critical
  communication asset, so an incomplete archive is held before mutation.

## [0.7.2-rc.9] - 2026-08-27

### Fixed
- Component upgrades now commit `.zylos-source.json` from the actual immutable
  ref through a durable journal tied to the authoritative baseline commit.
  Exact commits persist `repo`, full `sha`, ref type, installed version, and
  upgrade time. A crash after the baseline commit rolls metadata forward; a
  crash before it preserves the journal and fails closed instead of erasing
  evidence while business rollback is unknown.
- `components.json` source routing is updated under one process-identity and
  fencing-token protected registry transaction, so concurrent component
  writers cannot lose one another's updates. Commit-point recovery distinguishes
  committed, provably uncommitted, and unknown/corrupt baseline states; unknown
  state is always retained for recovery. Runtime provenance is excluded from
  business-file change detection and no longer appears as a local modification
  on the next upgrade.

## [0.7.2-rc.8] - 2026-08-27

### Added
- The capability manifest now declares runtime modes explicitly: Claude uses
  display-hook response streaming and runtime-turn admission, while Codex uses
  request-scoped `c4-send` completion until it has an equivalent display/turn
  completion boundary.

### Fixed
- Submitted admissions abandoned by a failed or ambiguous tmux verification
  can be reclaimed after 60 seconds. Started turns never expire by age; they
  recover only after 30 seconds of both healthy monitor idle and lifecycle
  inactivity, with a persisted generation compare-and-swap preventing a new
  Prompt or tool event from racing an old idle snapshot.
- Claude prompt, legacy PreTool, Stop, and idle-notification hooks are
  synchronous lifecycle fences. Tool completion and display events can touch only an already
  started admission, so late events from turn A cannot start, bind, or finish
  turn B. Missing/corrupt best-effort binding state remains fail-closed while B
  is still submitted. Every durable lifecycle mutation also compares its
  process observation time inside the admission transaction, so an upgrade-era
  asynchronous Stop or PostTool from A cannot finish or publish progress into
  B after B has started. New admissions establish that lower bound at
  acquisition, and active legacy rows receive a conservative migration-time
  baseline before any hook may mutate them.
- Long-running tools remain busy even when their hook timestamp exceeds the
  short freshness window. Prompt-only state has a bounded one-hour lifetime so
  a missing Stop cannot keep the runtime busy forever, and legacy installs
  missing UserPromptSubmit can still start safely at synchronous PreToolUse.
- Codex no longer creates Claude-only runtime admissions that would remain
  submitted. Assistant requests use the explicit `--request-id` reply command,
  preserving durable completion without claiming unsupported display hooks.

## [0.7.2-rc.7] - 2026-08-27

### Added
- C4 now persists a single active runtime-turn admission for every ordinary
  conversation, including HXA and OpenMax messages that have no assistant
  request ID. Admission begins before tmux submission and closes only on the
  matching runtime `Stop`; the durable lifecycle ledger makes cross-channel
  queueing observable and survives a dispatcher restart. Control-plane items retain
  their existing bypass behavior.
- `c4.assistant-response-stream:3` advertises serialized Claude conversation
  admission so paired deployments can distinguish this release from response
  streaming that only isolated Feishu request IDs.
- Assistant turn binding decisions now append a content-free per-turn JSONL
  audit record while retaining the compact last-known-state file. Future reply
  attribution incidents can reconstruct marker acceptance and rejection instead
  of reporting that historical hook visibility is unknowable.

### Fixed
- Claude prompt activity now remains busy through tool-to-tool gaps until the
  terminal `Stop` hook. The dispatcher also defers every ordinary conversation
  behind an older started assistant run. Together these gates prevent a new
  Feishu, HXA, OpenMax, or other channel message from being inserted into a
  still-running turn and shifting replies back by one request.
- A tmux paste that definitely did not submit releases its admission for a safe
  retry; an ambiguous Enter verification remains fail-closed instead of risking
  a second prompt in the same runtime turn.

## [0.7.2-rc.6] - 2026-08-27

### Fixed
- Claude `UserPromptSubmit` hooks now require the terminal assistant-request
  marker before binding a turn to a streamed response. Unmarked HXA, OpenMax,
  local, and control turns fail closed instead of claiming the only pending
  Feishu response card and shifting every later answer back by one request.
  The compatibility fallback remains available only when the prompt hook was
  genuinely absent, where later lifecycle hooks can still bind an unambiguous
  request.

## [0.7.2-rc.5] - 2026-08-27

### Added
- A deterministic Core + Feishu fork-pair upgrade runner stages both targets
  by immutable commit SHA, validates fork routing and critical assets before
  mutation, and writes structured `PASS`/`HOLD` evidence for operators.
- The communication continuity canary now proves that deployed `c4-receive`
  durably persists a hermetic inbound message as well as proving outbound reply
  contracts.
- An immutable SS HXA recovery runner restores the exact audited
  `zylos-hxa-connect@1.7.3` source from the user fork without replacing its data
  or configuration, then verifies a real PM2 PID/executable and live profile and
  peer API access.
- A second immutable SS recovery runner restores only the two code trees that
  block Core step 12: WeChat `0.3.2@67f5142` and WeCom
  `0.1.5@781a51f`. It stages and installs both before mutation, preserves their
  data/config hashes, keeps HXA genuinely online, and rejects PM2 fake-online
  states after restart.
- `c4-send` now provides a canonical `--body-file=<path>` transport for strict
  runtimes and advertises it as `c4.reply.body-file:1`; launchers that cannot
  pipe stdin no longer depend on an untracked per-host patch.

### Fixed
- Self-upgrade rejects a target or post-sync deployment that lacks a critical
  communication entrypoint, including `c4-receive` and the response supervisor.
- PM2 service verification rejects fake-online processes whose executable is
  missing or whose required service points at the wrong script.
- The fork-pair preflight now rejects every PM2 process that claims to be online
  while its executable is missing, preventing a later Core step-12 rollback for
  already-broken component services.
- HXA recovery probes no longer assume an org label named `hxa`; the component
  CLI selects its configured default (or first enabled) org. A recovery that
  already installed the exact pinned code can safely resume postchecks instead
  of being rejected as an unexpected existing directory.
- GitHub component and Core downloads accept full commit SHAs through immutable
  archive URLs, so a checked target cannot drift with a movable branch.
- Failed self-upgrades now remove target-only PM2 services before restoring the
  baseline, restart the original services, and persist the final rollback
  process list. This prevents a new-release daemon from surviving with an
  executable that the restored release no longer contains.
- The immutable pair runner can repair that exact historical response-supervisor
  rollback orphan when its canonical live entrypoint is absent and the pinned
  target contains the replacement. All path drift and unrelated broken
  processes remain fail-closed.
- Core upgrade and rollback now preserve PM2 cron one-shots through their own
  process definitions. Service verification accepts a scheduled task while it
  is normally stopped between successful runs, but still requires a real
  executable, `autorestart: false`, a cron expression, exit code zero, and zero
  unstable restarts; long-running daemons still must be online.
- Both self-upgrade step 0 and the immutable fork-pair runner reject a Core target
  that does not declare the body-file reply contract, preventing a late
  rollback after a host-local copy silently loses that historical patch.
- The pair runner keeps Core target capabilities separate from the protocols a
  Feishu release requires from Core, so a new Core-only safety seam cannot be
  misclassified as a missing capability in an otherwise compatible Feishu SHA.

## [0.7.2-rc.4] - 2026-08-26

### Fixed
- Self-upgrade communication continuity now honors an explicit strict-stdin
  runtime policy without enabling the legacy argv break-glass override. It
  proves stdin and body-file delivery, plus the exact policy rejection and
  zero-delivery outcome for an argv body; compatibility-mode deployments keep
  the existing argv delivery canary.

## [0.7.2-rc.3] - 2026-08-26

### Added
- Canonical Tasks can persist a `reminderMinutesBeforeDue` policy alongside an
  RFC 3339 deadline; `task-reminder:1` lets paired components reject an older
  Core before they start reminder-aware projection.
- `zylos task create --reminder-minutes-before-due <n>` exposes the same
  channel-neutral reminder policy through the supported CLI Adapter.
- Natural-language WorkIntake recognizes offsets such as `提前1小时提醒`,
  carries them through C4's strict Task envelope, and asks for confirmation
  instead of dropping a reminder that has no deadline.

### Fixed
- Existing Task databases add the nullable reminder column in place, preserve
  older idempotency fingerprints, and keep reminder-free Tasks replayable.

## [0.7.2-rc.2] - 2026-08-26

### Fixed
- Self-upgrade and bootstrap installs now suppress npm lifecycle scripts before the transaction owns live state; `ZYLOS_SKIP_POSTINSTALL=1` is also a strict zero-write guard.
- The installed finalizer has a 15-minute default timeout with a three-minute minimum, and timeout failures report their real elapsed duration instead of zero.
- Self-upgrade snapshots and restores the complete globally installed Core package on both partial npm-install failures and later finalizer failures.

## [0.7.2-rc.1] - 2026-08-26

### Added
- Runtime-neutral Agent/Deployment Profile selection. The default loads no organization-specific governance; managed deployments can explicitly opt in through `.zylos/config.json` or environment variables.
- Stable C4 outbound delivery identities let channel components update one proactive message instead of creating mixed card/plain-text replies; `c4.outbound-delivery-id:1` exposes that contract to component upgrade gates.
- `external-task-adapter:1` advertises the validated external completion mapper so channel upgrades fail before mutation when the installed Core cannot map native completion to review.

### Changed
- Mylos/3AI Memory Sync governance is packaged as the optional `3ai` Deployment Profile instead of changing the Core default for every local, Codex, Claude, or COCO-hosted agent.
- Fork release metadata now uses a runtime-neutral release-candidate name.

### Fixed
- Claude and Codex streamed replies bind to the exact assistant request for the active turn and fail closed for unknown, terminal, conflicting, ambiguous, or unmarked follow-up turns.
- Component upgrades enforce capability checks before mutation and roll back code, configuration, data, Caddy, PM2, and installed-finalizer failures within the supported transaction boundary.
- Work intake resolves Agent identity from deployment configuration instead of embedding a 玥然-specific default.
- The offline business-MVP gate requires an explicit Agent ID or Agent Profile and fails closed when neither is selected.
- Task comment authorship now waits for canonical `CommentAdded` evidence during out-of-order delivery, and audience resolution no longer truncates participants at the ordinary conversation query limit.

## [0.7.2-3ai.6] - 2026-08-26

### Fixed
- Claude streamed replies now persist a synchronous turn-level binding or rejection before tool hooks run. Unknown, terminal, conflicting, and non-terminal request markers remain fail-closed through tool progress, displayed output, and stop handling instead of falling back to a session candidate.
- A valid explicit new turn atomically supersedes an abandoned active request on the same Claude session, while every later event writes by the saved request ID rather than re-resolving the session.
- Codex accepts only the terminal system-appended request marker and clears the previous association on every new user turn, preventing an earlier user-authored marker or an unmarked next turn from inheriting response output.

## [0.7.2-3ai.5] - 2026-08-26

### Fixed
- Claude response streams now bind the runtime session to the explicit `assistant request` marker carried by the delivered prompt, so a newer request cannot inherit output merely because an older request was queued first.
- The legacy single-candidate binding path now fails closed when more than one unbound run is eligible. Ambiguous output is withheld instead of being projected into an arbitrary response card.

## [0.7.2-3ai.4] - 2026-08-25

### Fixed
- Self-upgrade, doctor, changelog lookup, and the detached activity-monitor upgrade check now resolve `ZYLOS_SELF_UPGRADE_REPO` from the target instance's `ZYLOS_DIR/.env` when the live process does not override it. This keeps fork routing persistent across global npm installs, non-Git working directories, different home directories, shells, and service restarts without loading unrelated `.env` credentials into child processes.
- Missing or unreadable persisted configuration retains the canonical repository fallback instead of making the CLI unusable.

## [0.7.2-3ai.3] - 2026-08-25

### Added
- A pre-mutation self-upgrade capability gate plus a hermetic post-install communication canary. Future targets must declare rolling reply compatibility before services stop, and deployed code must prove both stdin and exact legacy argv replies without contacting an external channel.
- The `c4.reply.argv-compat` capability declares rolling-upgrade compatibility for older endpoint-addressed callers.

### Fixed
- Self-upgrade now restores backed-up Core Skills and PM2 configuration, then restarts previously running services, when any installed-finalizer step fails or the finalizer crashes.
- Exact legacy `<channel> <endpoint_id> <message>` calls remain accepted by default, preventing a Core upgrade from disconnecting agents whose callers have not migrated yet. `C4_STRICT_STDIN_ONLY=1` is an explicit post-migration policy; `C4_LEGACY_ARG_MODE=1` overrides it as a no-restart break-glass recovery.

### Changed
- New and generated callers continue to use stdin; compatibility mode is deprecated and emits content-free telemetry.

## [0.7.2-3ai.2] - 2026-08-25

### Added
- A machine-readable `zylos capabilities --json` protocol contract for paired component upgrades.
- A bounded `C4_LEGACY_ARG_MODE=1` migration path for endpoint-addressed legacy replies, loaded directly from the Zylos env file and recorded with content-free deprecation telemetry.

### Changed
- C4 reply-route instructions now state the stdin-only message contract explicitly.

## [0.7.2-3ai.1] - 2026-08-25

### Added
- Commitment Core task/run state, durable SQLite intake, projection outbox, WorkIntake, response streaming, and Feishu task integration seams from the task-management MVP integration branch.
- Mylos memory anti-recurrence gates, crash-loop diagnosis guidance, and fork-aware self-upgrade routing through `ZYLOS_SELF_UPGRADE_REPO`.

### Changed
- `c4-send` now accepts message bodies through stdin only. CLI argument mode fails before dispatch with exit code 2.
- Core upgrade checks, changelog reads, doctor output, activity-monitor checks, and branch installs consistently honor the configured fork repository.

## [0.7.1] - 2026-08-18

### Added
- **Structured scheduler CLI output**: `scheduler cli.js list --json` emits a JSON array of full task rows (untruncated `id`, `type`, `status`, `last_error`, `reply_channel`, `reply_endpoint`, `next_run_at`, ...), and `--reply-channel <ch>` filters rows in both human and JSON modes. Human output is unchanged by default. Gives components a supported machine-readable interface to the scheduler ledger instead of parsing human tables or reading the DB. (#761)

### Fixed
- **Actionable error for Codex CLI versions without `currentHash`**: on Codex CLI ≤ 0.128.0, `hooks/list` does not report `currentHash` (field added in 0.129.0), so the hook trust gate found zero trustable hooks and failed with an opaque `empty_trust_snapshot` error. The trust helper now counts candidate hooks and missing hashes, and the gate reports a clear `missing_current_hash` error naming the detected Codex version and the minimum supported one (0.129.0+, 0.146+ recommended). Behavior stays fail-closed: no hash-less trust downgrade. (#752)

## [0.7.0] - 2026-08-14

### Added
- **Official component file delivery**: `zylos add <name>[@<version>] --file <tar.gz>` installs an official (registry) component from a local tarball, fully offline. The tarball is transport only — the persisted `source` keeps the `github-release` identity, so `zylos upgrade` works unchanged. Verification is mandatory and fail-closed: `--sha256 <hex>` verifies the archive before any unpacking (mismatch leaves no residue), or `--trust-file` explicitly skips verification and is recorded (and flagged by `zylos list`) as unverified. Name/version consistency between the command, the archive metadata, and the offline registry is enforced fail-closed. Delivery details are recorded in `components.json` under audit-only `deliveredVia`. (#707, #751)
- **Web console as default owner channel**: the built-in web console is now treated as the default owner channel, giving every install an owner communication path with no external platform setup. (#740)
- **Search engine isolation by default**: the generated Caddyfile now sends `X-Robots-Tag: noindex` on all responses by default, keeping agent-hosted pages out of search indexes unless explicitly opted in. (#744)

### Fixed
- **Duplicate early Memory Sync triggers**: context-monitor now persists Memory Sync request state durably and gates re-triggering behind three checks — cooldown, in-flight TTL (30 min), and threshold clearance — so monitor restarts no longer re-fire a sync that is already requested or running. Applies to both the Claude statusLine path and the Codex polling path; legacy state files are migrated on first read. Port of #628 by Daniel. (#756, #628)
- **C4 truncation notice made imperative**: the truncated-message notice now instructs agents to read the spilled file, preventing decisions based on partial message content. (#750)
- **System-template hash pins**: test pins updated for template changes missed by #742. (#749, #755)
- **Post-upgrade hook double-run**: eliminated the double execution of post-upgrade hooks and the redundant manual-restart instruction. (#738)

### Changed
- **Codex kick prompt is now a stateless internal startup sentinel**: the synthetic first message that fires `SessionStart` no longer reads as a human `hello` — it is now the constant one-liner "System startup trigger, not a user message. Continue with startup context.", which self-identifies as non-human (removing the route-misattribution hazard tracked in #745 at its source) and reads coherently across fresh starts, restarts, context rotations, and runtime switches. Codex-only. (#743, #757)
- **Date-verification rule in system template**: outbound weekday/date pairings and date arithmetic must be verified with the `date` command; added to Critical Reminders in the system instruction template. (#742)

### Security
- **js-yaml upgraded to 4.3.1 / 3.15.1** (GHSA-5p4m-2wfm-xmqj, HIGH — quadratic CPU in `!!omap` resolution): direct dependency bumped to 4.3.1; the dev transitive `@istanbuljs/load-nyc-config → js-yaml` forced to 3.15.1 via npm `overrides`. Contributed by @anupamme. (#753)

## [0.6.0] - 2026-07-14

### Added
- **Split-layer instruction architecture**: `ZYLOS.md` (runtime-agnostic core) + runtime-specific addon (`CLAUDE.md` / `AGENTS.md`) replace the monolithic generated instruction file. Assembler hooks in `settings.json` rebuild the output file on every session start. (#722, #723)
- **Template content redraft**: ZYLOS.md template rewritten for the split-layer architecture with restructured behavioral rules, memory system documentation, and communication guidelines. (#726)
- **Instruction migration tool** (`zylos migrate-instructions`): classifies existing instruction files as A (byte-identical to known template), B (template + separable edits), or C (cannot auto-separate). Conservation verification ensures no user content is lost. SHA-256 verified backup before any mutation. A3 hook normalization reconciles assembler settings. (#722 P2, #728)
- **Upgrade-path auto-migration**: `zylos upgrade --self` (step 7) automatically migrates A-class machines during upgrade. C-class machines receive a migration prompt written to `custom-hooks/session-start/90-migration-prompt.md` for agent-guided migration on next startup. Shared engine (`executeMigrationApply`) guarantees backup-first execution for both paths. Instruction format version marker (`.zylos/instruction-format-version`) tracks migration state; future format versions are protected by early-return gates in both engine and CLI. (#729, #732)
- **Auto-trigger pending migration on session start**: `session-start-prompt.js` now detects when a C-class migration prompt exists and sends a migration-specific prompt that instructs the agent to execute the migration immediately, rather than the generic startup prompt. The migration prompt file is cleaned up on success and retained on failure for automatic retry. (#736)
- **Session-start shard injection**: monolithic session-start orchestrator replaced by an ordered shard chain — each shard runs as an independent hook process, with a flag-chain mechanism ensuring deterministic injection order. Component shards register via `shards.d/*.json` declarations. (#686, #698, #651, #668)
- **Custom session-start injection**: operator-placed `.md` files in `~/zylos/custom-hooks/session-start/` are injected at every session start (chain position 2, after identity). Filename-ordered (conf.d style), no registration needed. (#703, #719, #721)
- **Local component installation**: `zylos add --from <path>` installs components from a local directory while preserving the GitHub upgrade path. (#700)
- **C4 void channel**: first-class internal message channel for system-generated messages (scheduler events, health checks) that don't originate from an external platform. (#689, #690)
- **Memory content rules**: sync-time audit enforcement for `state.md` and `references.md` — structural validation, size budgets, and classification rules checked during Memory Sync. (#697, #702, #704)

### Fixed
- **Content filtering API error detection**: activity monitor now detects "API Error: 400 Output blocked by content filtering policy" and triggers automatic session restart. Widened the `APIError:` regex to also match `API Error:` (with space) and added a dedicated content filtering pattern. (#737)
- **C-class migration prompt includes system template path**: the migration prompt now passes the installed `claude-system.md` path so the agent can read the actual system template and accurately separate system-managed content from user additions. Empty user content is accepted for C-class migrations where the old file contains no customizations. (#735)
- **Session-start emits full original messages**: the c4-conversations shard now injects full original message content instead of compressed preview+pointer form. Messages are packed whole-message newest-first into the shard budget; only a lone message exceeding the entire budget falls back to preview. (#724, #725)
- **Self-upgrade conflict backup preservation**: conflict backups are no longer silently deleted after a successful upgrade; identical-content conflicts are short-circuited without generating backup noise. (#717, #718)
- **Manifest generation from authoritative source**: upgrade manifests are now generated from the package source directory, not destination-dir scans that could include stale or user-modified files. (#715, #716)
- **Spill-file path collision**: `truncateForDelivery` now uses unique directory names per message to prevent concurrent spill-file overwrites. (#713, #714)
- **Duplicate public API requests**: removed same-round duplicate unauthenticated GitHub API requests in the no-token fallback path. (#705, #711)
- **Prefer authenticated GitHub API**: all GitHub API requests now prefer authenticated mode when a token is available, reducing rate-limit exposure. (#699)
- **Comm-bridge full message storage**: inbound messages are stored in full in `c4.db`; the `reply-via` routing directive is stripped from the stored content. (#618)
- **Web console session-handoff messages hidden**: internal session-handoff messages no longer appear in the web console UI. (#687)
- **Claude hooks generated at runtime**: hook commands are now generated dynamically instead of being hardcoded, eliminating path-quoting mismatches across platforms. (#682, #678, #679, #684)
- **Codex native SessionStart hook**: Codex bootstrap migrated from a custom mechanism to the native SessionStart hook with a kick message to trigger it. (#675, #681)
- **Memory Sync checkpoint threshold**: lowered from 30 to 15 unsummarized conversations as the single source of truth. (#674)
- **Session-start context format**: unified format across memory and C4 shards; failures and null summaries are now surfaced instead of silently swallowed. (#671)
- **PM2 dump persistence**: `pm2 save` is now called after component upgrade restarts to ensure the updated process list survives reboots. (#669)
- **Rate limit detection**: broadened detection patterns and reset-time parsing to handle additional rate-limit response formats. (#666, #667)
- **Opus[1m] model backfill guard**: prevents incompatible `new_session_threshold` values from being applied during model backfill. (#662)

### Changed
- **⚠️ BEHAVIOR CHANGE — `zylos upgrade --all` exit code**: non-JSON mode now exits **1** when any component check fails, matching the `--json` contract (previously it printed warnings and exited 0). Shell scripts and CI that relied on exit 0 despite failed component checks must be updated (the standard `|| true` idiom opts out). (#706)
- **Session-start orchestrator consolidated**: all session-start hooks consolidated into a single orchestrator with per-shard hooks replacing the previous per-section approach. (#651, #668)

## [0.5.3] - 2026-06-17

### Added
- **Default to opus[1m] model**: new installs default to `opus[1m]` model and pair Claude new-session threshold with model backfill. (#638)
- **Web console image and file upload**: web console now supports image and file upload with in-browser display. (#629, #636)
- **Local runtime integration-test harness**: Docker-based integration test runner with env-injected scenarios for runtime auth, post-init, and service-health validation. (#645, #646)
- **Real-smoke and service-health integration scenarios**: opt-in live credential smoke tests for Claude and Codex runtimes, plus `better-sqlite3` per-skill isolation validation. (#647, #650)

### Fixed
- **Tmux clean PATH node resolution**: `buildCleanEnv()` now prepends `dirname(process.execPath)` into the tmux clean PATH, and the tmux launcher command uses the absolute node binary path instead of bare `node`. Fixes `ERR_DLOPEN_FAILED` when PM2 strips nvm from PATH. (#445, #653)
- **Runtime auth tristate**: `checkAuth()` unified into an explicit tristate (`authenticated` / `unauthenticated` / `uncertain`) with `--no-validate` flag, replacing ambiguous exit-code-based detection. (#640, #641, #642)
- **GitHub API rate limiting**: `zylos add` and `zylos upgrade` now auto-retry GitHub API calls on rate limiting (HTTP 403/429) with exponential backoff. (#633)

### Changed
- **Memory file budgets**: zylos-memory core file budgets raised to 16KB. (#623)

## [0.5.2] - 2026-06-02

### Fixed
- **Codex config merge**: `writeCodexConfig()` now merges with existing configuration instead of overwriting it. Uses `smol-toml` for TOML parsing with four ownership semantics: always-overwrite, backfill, conditional, and exact-replacement. Adds managed defaults for `model`, `model_reasoning_effort` (backfill), and `fast_mode` (always-overwrite). (#606)
- **C4 status notification dedup**: repeated status notices are now throttled with a cooldown mechanism persisted to SQLite, preventing notification flooding across service restarts. (#599, #604)
- **Caddy route configuration**: graceful fallback to manual configuration guidance when Caddy API is unavailable, instead of throwing an error. (#602)

## [0.5.1] - 2026-05-25

### Changed
- **Activity Monitor user-facing messages**: translated runtime-facing status and route messages to English for consistency. (#591)

### Fixed
- **Component upgrade post-upgrade hooks**: component upgrades now run `lifecycle.hooks.post-upgrade` inside the CLI upgrade pipeline before service restart, while preserving `--json` output as a single parseable JSON object. Hook stdout/stderr are captured into bounded step metadata, replayed only in human output mode, and hook failures remain non-fatal with diagnostics. Hook path validation now rejects both lexical escapes and symlink escapes outside the component directory. (#589)
- **Web console dependencies**: updated `qs` to 6.15.2 via npm overrides to address CVE-2026-8723 / GHSA-q8mj-m7cp-5q26, and updated `ws` to 8.21.0 to clear the current web-console npm audit report.

## [0.5.0] - 2026-05-14

### Added
- **Tmux-launcher clean env**: agent sessions launch in a minimal, allowlisted environment instead of inheriting the full parent process env. Controlled by `ZYLOS_CLEAN_ENV` (default: `true`); set to `false` to fall back to compat mode. Includes `runtime-env.manifest` for declarative env var injection. (#576)
- **Component configure hooks**: components can declare `lifecycle.hooks.configure` in SKILL.md to receive config values via stdin JSON during installation, replacing manual `.env` injection for supported components (#578)
- **Health check toggle**: 24h health check can be disabled via `zylos config set health_check_enabled false` (default: on) (#586)
- **Tool watchdog**: detects Claude web tool-use hangs and hardens tool event recovery (#500)

### Changed
- **Activity Monitor v3 — modular architecture**: extracted MonitorOrchestrator, HealthEngine, Guardian, MessageRouter, ToolPipeline, ProcSampler, and UsageMonitor into standalone modules with full unit test coverage. No behavioral changes to external APIs. (#545)

### Fixed
- **PATH deduplication**: prevent PATH bloat across tmux session restarts (#499)
- **Codex /exit treated as lifecycle control**: C4 dispatcher correctly handles Codex exit commands (#517)
- **Caddy route prefix forwarding**: stripped route prefix now forwarded to upstream (#521)
- **npm install timeout**: increased timeout and added progress indicator for slow networks (#522)
- **Claude default model**: settings model defaults to Opus 4.6 on fresh installs (#567)
- **Web console timezone**: respects TZ config for timestamp display (#568)
- **Upgrade: activity monitor env verification**: verifies AM environment via `pm2 jlist` after restart (#570)
- **Session handoff routing**: handoff summaries routed to internal web-console channel only (#571)
- **Upgrade: post-install from new package**: self-upgrade runs post-install steps from the newly installed package (#572)
- **Upgrade: symlinked skills rollback**: hardened rollback for symlinked skill directories (#577)
- **Activity monitor: image dimension errors**: detects and handles image dimension limit errors from API (#579)

### Upgrade Notes
- **⚠️ Upgrading from v0.4.13 or earlier**: you must stop the activity monitor before upgrading, then restart it after. Run: `pm2 stop activity-monitor`, then `zylos upgrade --self -y`, then `pm2 start activity-monitor`. Upgrading without stopping AM first will fail with `failed to verify activity-monitor PM2 env after restart`.
- Clean env is now the default. If your setup relies on inherited environment variables, set `ZYLOS_CLEAN_ENV=false` in `~/zylos/.env` or add needed variables to `~/zylos/.zylos/runtime-env.manifest`.
- **⚠️ Upgrading from v0.4.13 or earlier**: the `runtime-env.manifest` file will not be created automatically (the deploy logic runs from the old version which lacks it). After upgrading, copy the template manually: `cp $(npm root -g)/zylos/templates/runtime-env.manifest.example ~/zylos/.zylos/runtime-env.manifest`. Without this file, the agent session will lack `TZ` and any other manifest-declared variables.

## [0.4.13] - 2026-04-12

### Fixed
- **C4 dispatcher: Claude input-box fallback detection**: when running under the Claude runtime, the cursor-only input-box probe can misreport `has_content` due to a known tmux cursor-Y quirk with wrapped input. `checkInputBox()` now falls back to a text-window parser (`checkClaudeFallbackInputBox`) that reads the 10 characters to the right of the prompt marker to disambiguate. The Codex runtime path is unchanged (cursor-only). (#493)

### Changed
- **C4 send retry reduced from 5 to 2**: repeated send retries past 2 attempts almost always indicated a stuck input state rather than a transient failure, so the outer `MAX_RETRIES` budget has been cut to fail faster and surface real delivery problems sooner. (#493)

## [0.4.12] - 2026-04-08

> **⚠️ UPGRADE STRONGLY RECOMMENDED for all instances.** This release hardens temporary directory handling across all upgrade paths. Previous versions could fail silently or leave orphaned temp directories when the system tmpdir was not writable, and the `--temp-dir` flag created a fragile cross-step state that risked accidental directory deletion.

### Changed
- **`--temp-dir` flag removed**: the two-step upgrade flow (`--check` → `--yes --temp-dir <path>`) has been simplified. `--check` now performs preview analysis only and cleans up its temp artifacts automatically; the confirm step always performs a fresh download instead of reusing check-phase artifacts. Passing `--temp-dir` now exits immediately with an error. The `tempDir` field has been removed from `--check --json` output. (#487)

### Fixed
- **Fallback to `~/tmp` when system tmpdir is not writable**: all code paths that create temporary directories — archive download, self-upgrade backup, `copyTree` self-copy, and `diff3` merge workspace — now probe the system tmpdir for write access first. If unavailable (e.g. containerized or restricted environments), they fall back to `~/tmp` (created automatically). (#488, #489, #490)
- **`cleanupTemp()` path safety validation**: temporary directory cleanup now verifies the target path is under an allowed temp root (system tmpdir or `~/tmp`) before deletion, preventing accidental removal of arbitrary directories. (#487)

## [0.4.11] - 2026-04-02

### Added
- **PreToolUse auth prompt logging hook**: logs permission request events for audit and analysis (#466)
- **Codex project-level config**: split Codex configuration into project-level and global locations for multi-project support (#475)
- **Control message supersede**: equivalent pending control messages are automatically superseded, reducing duplicate processing (#465, closes #454)
- **Claude default model backfill on upgrade**: self-upgrade now ensures the Claude default model is configured (#456)
- **Daily Claude Code upgrade opt-in**: automatic daily upgrade is now disabled by default, configurable via settings (#460)

### Changed
- **Unified input box detection**: cursor_x fast path with cursor_y/prompt_y fallback replaces previous detection logic, improving accuracy for multi-line edge cases (#473)
- **Memory sync decoupled from new-session**: faster session switching by running memory sync independently (#449)
- **autoMemory and autoDream disabled by default**: both features now opt-in to reduce unnecessary background processing (#476)
- **Periodic heartbeat disabled by default for Claude runtime**: reduces unnecessary heartbeat traffic when not needed (#472)
- **Usage sidecar probes removed**: simplified architecture by removing the dedicated usage sidecar probe flow (#471)
- **check-context hidden from user menu**: skill remains available to Claude but not shown in user-facing skill list (#453)
- **c4 require-idle flag renamed**: external flag name updated for clarity (#409)

### Fixed
- **block-queue-until-idle removed from non-exit messages**: context threshold, startup fallback, usage notification, and session handoff messages no longer wait for idle state before delivery — only `/exit` commands retain the flag (#478)
- **heartbeatEnabled scope corrected**: `heartbeatEnabled=false` now only disables primary polling dispatch — recovery, detection, and immediate probe paths remain active for both Claude and Codex runtimes (#477)
- **Periodic probe gated behind heartbeatEnabled**: 30-min periodic health probe now respects the `heartbeat_enabled` config flag — disabled by default along with primary heartbeat (#479)
- **PM2 restart semantics**: ecosystem-managed services now restart correctly with proper fallback paths for runtime recovery (#450, closes #443)
- **Self-upgrade settings.json restart**: Claude auto-restarts after settings.json changes during upgrade (#463)
- **SessionStart hook matcher split**: matchers correctly exclude resume events, preventing duplicate hook execution (#458)
- **Hook sync forward pass**: matcher-aware forward pass prevents incorrect hook synchronization (#462)
- **Bootstrap restart enqueue**: restart enqueue moved into sync-settings-hooks to fix bootstrap ordering (#464)
- **Codex input box detection**: empty prompt and status-line layout correctly recognized (#440)
- **Activity-monitor health checks**: now run daily instead of being skipped (#459)
- **Activity-monitor statusline format**: handles five_hour/seven_day format variants correctly
- **Recent conversations order**: C4 recent conversations now print chronologically (#457)
- **Early memory sync guard**: prevents memory sync from triggering before sufficient unsummarized content exists (#455)
- **Self-upgrade step11 service restart**: repaired service restart step in self-upgrade flow (#456)

## [0.4.10] - 2026-03-28

### Added
- **Usage sidecar probe**: moved `/usage` checks out of the main runtime input path into a dedicated sidecar flow, preventing message loss and session blocking during usage probing. New modules: sidecar probe runner, probe lock (ownership token + stale lock recovery), usage parser. Codex-specific: rollout rate-limit reader and `/status` endpoint parser as dual data sources (#429, closes #376)
- **Heartbeat config module**: extracted heartbeat configuration (enabled/disabled, default per-runtime) into dedicated `heartbeat-config.js` for cleaner separation (#439)

### Fixed
- **Codex heartbeat disabled by default**: Codex runtime now defaults to heartbeat off, preventing false liveness timeouts on a runtime that doesn't support interactive heartbeat probing (#439)
- **Codex runtime auth checks for custom base URL**: auth validation now works correctly when a custom API base URL is configured (#435)
- **Idle heartbeat auto-ack full version**: complete implementation with primary probe limitation, phase markers, and atomic write/retry-read (full #431, previously cherry-picked partially into v0.4.9)

## [0.4.9] - 2026-03-27

### Fixed
- **Idle heartbeat auto-ack limited to primary probes**: only periodic `primary` heartbeat probes are auto-acked when the agent is healthy and stably idle; `stuck`, `recovery`, and `down-check` phases still require full end-to-end delivery to verify liveness (#431)
- **Auth probe diagnostics improved**: `checkAuth()` fallback branch now includes the CLI output (truncated to 500 chars) in the result, and Guardian logs the actual error text for easier remote debugging (#432)
- **Spurious auth-failure C4 notification removed**: Guardian no longer enqueues a control message on auth failure — the existing passive reply in `c4-receive.js` already notifies users when they send a message during auth_failed state (#432)

### Added
- **Heartbeat phase tagging**: heartbeat content now includes `[phase=primary|stuck|recovery|down-check]` markers, enabling phase-aware dispatch decisions (#431)
- **Atomic status file writes**: `atomicWriteJson()` in activity-monitor prevents torn writes to the agent status file; `readJsonFileWithRetry()` in c4-dispatcher adds retry-on-parse-failure for robustness (#431)

## [0.4.8] - 2026-03-26

### Added
- Base URL support (#418)

## [0.4.7] - 2026-03-26

### Fixed
- **Periodic probe interval corrected to 30 minutes**: activity-monitor periodic liveness checks were unintentionally reduced from 5 minutes to 3 minutes in v0.4.1. They now run every 30 minutes as intended, avoiding unnecessary idle probe traffic while preserving message-triggered and heartbeat-based recovery paths (#426)

## [0.4.6] - 2026-03-26 _(superseded by 0.4.7 — restores the intended periodic probe interval after the previous over-aggressive reduction)_ ⚠️ UPGRADE STRONGLY RECOMMENDED

> **All instances should upgrade to this version.** Heartbeat probes previously used normal priority (3), which could be delayed behind queued conversation messages. This caused false liveness timeouts and unnecessary kill-restart cycles. v0.4.6 sets heartbeat priority to 0 (highest), ensuring timely delivery regardless of queue depth.

### Fixed
- **Heartbeat probe priority elevated to highest (0)**: both `claude-probe` and `codex-probe` now enqueue heartbeat checks at priority 0 instead of 3, preventing false timeout kills when the C4 queue has pending conversation messages (#421)

## [0.4.5] - 2026-03-26 _(superseded by 0.4.6 — heartbeat priority fix prevents false timeout kills)_

### Fixed
- **Codex self-upgrade config backfill**: `0.4.3 -> 0.4.4` upgrades now also backfill `~/.codex/config.toml` through the installed `sync-settings-hooks.js` path, so Codex sessions get `[features] multi_agent = true` even when the running upgrader is still the old 11-step flow (#415)
- **Symlinked skills-root backup path**: self-upgrade now handles installations where the top-level `skills/` directory is itself a symlink, avoiding `EEXIST` failures during `backup_core_skills` (#414)

## [0.4.4] - 2026-03-26 _(superseded by 0.4.5 — self-upgrade compatibility fixes for symlinked skills roots and Codex config backfill)_

### Added
- **Codex multi-agent config bootstrap**: `init`, runtime switching, and self-upgrade now ensure `~/.codex/config.toml` contains `[features] multi_agent = true` for Codex sessions (#407)

### Fixed
- **Codex startup bootstrap flow**: startup hooks now inject session context reliably, and the startup control prompt avoids redundant recent-conversation fetching during bootstrap (#400, #404)
- **Codex heartbeat delivery behavior**: heartbeat ack handling stays silent, and periodic heartbeat controls now use normal priority instead of the previous overly aggressive queue priority (#384, #408)
- **Codex context rotation / new-session flow**: context rotation now routes through the `new-session` skill, enforces handoff behavior correctly, and uses `/exit` as the Codex session switch command (#401, #403, #406)
- **Codex Memory Sync / new-session guidance**: runtime instructions now distinguish Claude vs Codex behavior correctly, remove the invalid Codex `model: sonnet` guidance, and require Memory Sync to finish before enqueueing Codex `/exit` (#411)

## [0.4.3] - 2026-03-22 _(superseded by 0.4.4 — Codex session rotation, Memory Sync, and heartbeat flow fixes)_

### Added
- **OpenClaw ecosystem compatibility**: documentation for skill installation, capability mapping, and natural-language skill messaging (#372)

### Fixed
- **Codex heartbeat kill-restart loop**: replaced tmux stdin injection with C4 control queue delivery, matching Claude's architecture. Eliminates false timeouts from `rollout_path` null after restart and user conversation disruption (#379)
- **checkAuth over-engineered**: removed Stage 1 (`claude auth status`) and Stage 2 (HTTP `/v1/models`) — neither validates setup tokens or API keys reliably. Now uses only `claude -p ping --max-turns 1` for end-to-end auth verification (#378)
- **Hardcoded Chinese in context rotation message**: replaced with English — zylos-core is open source, the agent translates at runtime (#377)
- **Codex heartbeat ack instruction too vague**: updated `codex-addon.md` to explicitly instruct Codex to execute the ack command, matching Claude's template (#379)

## [0.4.2] - 2026-03-20

### Added
- **Beta version upgrades (`--beta` flag)**: `zylos upgrade --self --beta` and `zylos upgrade <component> --beta` now check for prerelease versions. Without `--beta`, only stable releases are shown — default behavior unchanged (#368)
- **Tag-based version detection for zylos-core**: self-upgrade now uses GitHub tags (unified with component upgrades) instead of reading `package.json` from the main branch (#368)

### Fixed
- **Downgrade suggestion when on beta**: `hasUpdate` now uses semver directional comparison instead of string inequality, preventing false "update available" when the user is on a higher beta version than the latest stable (e.g. 0.6.0-beta.1 → 0.5.0) (#368)
- **Chinese example messages in templates**: all example messages in `claude-addon.md`, `codex-addon.md`, and `ZYLOS.md` are now in English — the bot adapts to the user's language at runtime (#369)
- **Onboarding security copy**: refined security disclosure for cloud deployment scenarios (#364)

### Changed
- **Version query instructions**: added `zylos --version` and `zylos upgrade --self --check` guidance to ZYLOS.md and component-management SKILL.md (#365)

## [0.4.1] - 2026-03-19

### Added
- **`auth_failed` health state**: authentication failures now set a dedicated health state instead of silently staying `ok`. Users see "authentication issues — please check credentials" instead of a generic error. User messages trigger immediate auth retry with no 3-minute wait (#359)
- **Proactive API error scan**: detects API errors (HTTP 400/401/403/500) within ~15 seconds via tmux pane scanning, triggering fast heartbeat recovery instead of waiting for the next periodic probe (#355)
- **/proc context-switch sampling**: frozen-process detection via `/proc/<pid>/status` context-switch counters — catches stuck Claude processes that appear alive but aren't processing (#351)
- **API error fast-detection for heartbeat recovery**: `detectApiError` callback in HeartbeatEngine — on heartbeat failure, scans for API errors before triggering kill+restart, enabling targeted recovery (#352)

### Fixed
- **Auth recovery delayed by 3 minutes**: user messages during auth failure now clear the backoff timer immediately via the existing signal file mechanism (#359)
- **`notifyPendingChannels` skipped after auth recovery**: health was prematurely cleared to `ok` before heartbeat verification, causing queued users to miss the "service recovered" notification. Health now stays `auth_failed` until heartbeat confirms the agent is alive (#359)
- **Signal acceleration missing for `auth_failed`**: process signal detection (`_trackAgentRunning`) and acceleration (`processHeartbeat`) now include `auth_failed`, ensuring immediate heartbeat verification after auth-recovered restart instead of waiting up to 30 minutes (#359)
- **Init fails to accept Claude terms**: `zylos init` now creates `settings.json` with autonomous mode consent regardless of auth state, fixing "NOT READY — autonomous mode not yet accepted" after adding a token post-init (#357)
- **Stale heartbeat pending on new session**: `startAgent()` now clears leftover `heartbeat-pending.json` before launching, preventing false "recovering" transitions from a previous session's timed-out heartbeat (#354)
- **.env parsing breaks on special characters**: regex-based `.env` parser now handles values with spaces, quotes, and special characters; 3-minute startup grace period prevents false alarms during slow launches (#353)
- **Auth check failure causes infinite restart loop**: Guardian now suppresses restart attempts for 3 minutes after auth failure, with owner notification rate-limited to once per hour (#346)
- **Auto-restart service after upgrade**: post-upgrade hook now restarts PM2 services automatically (#345)
- **HTTP validation for API keys**: replaced 30-second ping-based validation with direct HTTP header check (`x-api-key`) for faster, more reliable auth verification (#341, #344)
- **Guard /usage against active prompts**: `/usage` check skips when an active prompt is in progress, preventing interference with ongoing Claude operations (#343)
- **`--temp-dir` contents validation before smart merge**: prevents corrupted temp directories from breaking the upgrade merge step (#342)
- **`checkAuth()` false-positive with no credentials**: handles non-zero exit and missing credentials in Claude v2.1.76+ (#336, #339, #340)
- **Codex API key leaked to .env**: API key now stored only in `~/.codex/auth.json` (#338)
- **`execSync` hangs in monitor/dispatcher**: added timeouts to all `execSync` calls to prevent indefinite blocking (#335)
- **Periodic probe interval too long**: reduced from 5 minutes to 3 minutes for faster liveness detection (#334)
- **PM2 systemd unit instability**: stable systemd integration with consistent `zylos start` behavior (#331)
- **Guardian tightly coupled to heartbeat engine**: decoupled Guardian restart logic from HeartbeatEngine internals via `canRestart()` API, live auth check before each restart, and periodic probe scheduling (#332)
- **Boot-time service discovery**: component PM2 services are now auto-discovered and started on boot (#317)

## [0.4.0] - 2026-03-15

### Added
- **OpenAI Codex runtime support**: run Zylos on Codex CLI instead of Claude Code. Switch anytime with `zylos runtime codex` — memory, skills, and channels are fully preserved across the switch (#311)
- **`zylos runtime <name>` command**: switch AI runtime at any time without reinstalling. Handles install, auth, and tmux session management automatically
- **`--runtime` and `--codex-api-key` install flags**: non-interactive Codex install support — `curl | bash -s -- --runtime codex --codex-api-key sk-xxx`. `ZYLOS_RUNTIME` and `OPENAI_API_KEY` env vars also supported (key is stored in `~/.codex/auth.json`, not `.env`)
- **RuntimeAdapter abstraction**: `ClaudeAdapter` and `CodexAdapter` implement a shared interface — all core systems (heartbeat, context monitoring, guardian) are now runtime-agnostic
- **Per-runtime instruction files**: `ZYLOS.md` (shared core) + `claude-addon.md` / `codex-addon.md` runtime addons, assembled into `CLAUDE.md` (Claude) or `AGENTS.md` (Codex) at setup time
- **Codex skill discovery**: `.agents/skills/` symlink created at Codex launch so Codex discovers all installed skills natively via the Agent Skills spec
- **Context rotation notifications**: when context is near full, the activity monitor sends a user notification before rotating to a new session — works across all communication channels
- **Per-runtime heartbeat probes**: `ClaudeProbe` and `CodexProbe` handle liveness detection for each runtime's specific behavior

### Changed
- **Layered instruction files**: `CLAUDE.md` is now assembled from `ZYLOS.md` + `claude-addon.md` on each install/upgrade. Existing `CLAUDE.md` is migrated to `ZYLOS.md` on first upgrade to v0.4.0

### Fixed
- **activity-monitor crash after upgrade from 0.3.x**: when upgrading from a pre-v0.4.0 version, the old upgrade code restarted PM2 services before deploying the new ecosystem config, leaving `ZYLOS_PACKAGE_ROOT` unset. activity-monitor now falls back to `npm root -g` to locate the runtime package, preventing the crash
- **self-upgrade rollback on slow services**: step 11 (verify services) used a one-shot 2-second check, causing false rollbacks when component services (Lark, Telegram, BotsHub) took longer than 2 seconds to restart. Now polls every 2 seconds for up to 30 seconds

## [0.3.7] - 2026-03-11

### Added
- **Comprehensive onboarding flow**: guided first-run experience with step-by-step setup wizard covering auth, channels, and Caddy configuration (#291)
- **Interactive security consent**: users must explicitly accept autonomous mode permissions during installation, replacing silent opt-in (#306)

### Fixed
- **API key exposed in process command line**: replaced `execSync` string interpolation with `execFileSync` + temp env file pattern — secrets no longer visible in `ps aux` or `/proc/cmdline` (#289)
- **Web console URL shows /console/ without Caddy**: `zylos init` and `zylos doctor` now show direct `ip:port` URL when Caddy is not configured, instead of the Caddy-only `/console/` path (#307)
- **Context rotation delivery deadlock**: fixed deadlock where context rotation and message delivery could block each other, causing session restart failures (#274)
- **PM2 daemon foreign cgroup warning**: detect and warn when PM2 daemon runs in a different cgroup (e.g., after system upgrade), which can cause silent service failures (#302)
- **Local address detection for Caddy**: automatically detect localhost/private IPs and configure HTTP on a high port instead of requesting HTTPS certificates (#298)
- **Recovery notification dedup failure**: fix dedup key parsing when message contains `|req:xxx` suffix, preventing duplicate recovery notifications (#270)
- **Docker entrypoint working directory**: fix Claude starting in wrong directory inside Docker container (#292)

## [0.3.6] - 2026-03-09

### Added
- **Interactive CLI mode (`zylos shell`)**: minimal-dependency REPL that communicates with Claude via C4 — the simplest way to talk to your agent (#278)
- **Docker deployment**: full Docker support with Dockerfile, docker-compose.yml, entrypoint script, and deployment guide. Supports OAuth tokens and API keys, persistent volumes, Telegram/Lark channel passthrough, and Synology NAS (#276)
- **Docker image auto-publish to GHCR**: CI workflow builds and pushes multi-platform images (amd64 + arm64) on push to main (`:main` tag) and on version tags (`:x.y.z` + `:latest`) (#283)
- **Friendly Docker startup progress**: entrypoint now shows step-by-step progress (Step 1/4 ~ 4/4) with color-coded output, version banner, and web console URL on completion (#285)
- **Pre-uninstall lifecycle hook**: components can define a `pre-uninstall` script in their registry entry, executed before removal (#284)
- **SSH install method for unsupported platforms**: documented how to install Zylos on Windows/NAS via `claude --ssh` (#275)

### Fixed
- **Docker stop hangs**: rewrote entrypoint shutdown logic — sleep loop replaces `wait` on child PID, allowing SIGTERM trap to fire reliably (#282)

### Documentation
- Web console password retrieval guide for Docker (#286)
- `zylos shell` added as primary interaction method in README (EN + CN) and Docker docs (#287)

## [0.3.5] - 2026-03-06

### Added
- **User message triggers recovery in all unavailable states**: user messages now trigger recovery attempts in `recovering` and `down` states (not just `rate_limited`). Recovery cooldown reduced from 5 minutes to 1 minute. Error messages are honest about the bot's actual state instead of always claiming "rate limited" (#254)

### Fixed
- **False positive rate limit detection**: replaced aggressive tick-level tmux text scanning with dual-signal detection — rate limit is now only detected when both heartbeat failure AND specific rate-limit text are present in the tmux pane. Prevents conversation content containing "rate limit" keywords from triggering false positives. Includes 71 tests (#257, closes #256)
- **Rate-limited recovery deadlock**: `triggerRecovery` was blocked by a `rate_limited` guard that prevented recovery even when cooldown expired. Recovery now correctly proceeds after cooldown (#253)

## [0.3.4] - 2026-03-05

### Added
- **Exponential backoff for activity monitor**: replaces fixed 30-second retry with exponential backoff (30s → 60s → 120s → 240s, max 5 min) when Claude crashes or exits unexpectedly. Backoff resets after 60 seconds of stable runtime. Process signals (SIGTERM → SIGKILL escalation) ensure clean restarts. Includes 50 tests (#241, closes #177)
- **RATE_LIMITED health state**: activity monitor now detects Anthropic rate-limit responses (429/529), enters a dedicated `RATE_LIMITED` state with parsed reset time, and automatically recovers — either when the reset time expires or when a user message arrives (whichever comes first). Channel bots show human-readable wait times. Includes 67 tests (#242, closes #233)

### Fixed
- **Install script defaults to latest release tag**: `install.sh` without `--branch` now installs the latest GitHub release tag instead of `main`, preventing accidental installation of unreleased code (#239)
- **macOS curl|bash install PTY issue**: `zylos init` failed to authenticate on macOS when run via `curl | bash` because stdin was a pipe, not a TTY. Now allocates a fresh PTY for the Claude auth step (#231)
- **Component routes inserted into wrong Caddy block**: `zylos install` placed reverse_proxy routes outside the primary server block, causing Caddy to reject the config. Now correctly inserts into the main HTTPS block (#236)
- **Built-in registry lark description**: clarified "Lark/Feishu" → "Lark (international)" to prevent confusion with the separate `feishu` component (#244)
- **Web console password env var mismatch**: `zylos init` wrote `ZYLOS_WEB_PASSWORD` but `server.js` only read `WEB_CONSOLE_PASSWORD`. Now reads `ZYLOS_WEB_PASSWORD` with fallback to legacy name for backward compatibility (#248)

## [0.3.3] - 2026-03-04

### Added
- **Plan usage monitoring**: activity monitor periodically checks `/usage` via tmux capture during idle periods, parses session/weekly usage percentages, and sends owner notifications when thresholds are exceeded (80% warning, 90% high, 95% critical). Only checks during active hours when Claude is idle with no pending work. Configurable via `zylos config` (#225, closes #206)

### Fixed
- **Startup prompt blocking**: `ensureOnboardingComplete()` now also sets `effortCalloutDismissed` in `~/.claude.json` and `skipDangerousModePermissionPrompt` in `~/.claude/settings.json` — prevents new Claude Code interactive prompts from blocking automated startup on VMs (#227, closes #226)
- **Usage monitor fires immediately on fresh install**: `lastUsageCheckAt` defaulted to 0, causing `/usage` to trigger 30 seconds after first startup instead of waiting the full check interval. Now defaults to current time when no persisted state exists (#229)

## [0.3.2] - 2026-03-04

### Fixed
- **Auth conflict with `claude login` + `.env` API key**: Guardian now detects native `claude login` auth (credentials.json on Linux, system Keychain on macOS) and skips `.env` token injection when present — prevents "Auth conflict: Both a token and an API key are set" error. Stale tokens are also stripped from existing tmux sessions (#219, closes #218)
- **Onboarding prompts block native auth startup**: onboarding and workspace trust pre-acceptance was embedded inside `approveApiKey()`, so native auth users without `.env` tokens saw interactive prompts in tmux. Extracted `ensureOnboardingComplete()` as a standalone function called for all auth methods (#219, supersedes #217)

## [0.3.1] - 2026-03-04 _(superseded by 0.3.2 — auth conflict fix was incomplete)_

### Fixed
- **Guardian token override causes 401**: `startClaude()` always injected the static `CLAUDE_CODE_OAUTH_TOKEN` from `.env` into tmux, overriding `~/.claude/.credentials.json` which supports automatic token refresh. Once the static token expired, Claude got stuck on 401 errors despite having valid auto-refreshable credentials. Guardian now checks for `credentials.json` first and skips `.env` token injection when present. All three auth methods (claude login, setup token, API key) remain fully supported (#215, closes #211)

## [0.3.0] - 2026-03-04

### Added
- **`zylos doctor` command**: two-layer diagnostic and auto-repair system — Layer 1 runs health checks (tmux, PM2, network, Claude CLI, services, versions), Layer 2 delegates fixes to Claude when available, otherwise shows manual hints. Supports `--check` flag for diagnosis-only mode (#205, closes #202)
- **`zylos uninstall --self`**: cleanly remove zylos from the system — stops all services (tmux + PM2), uninstalls the npm package, removes `~/zylos/` and shell PATH entries, with optional interactive cleanup of PM2 and Claude CLI. PM2 service detection uses runtime path matching instead of hardcoded names. `--force` flag for non-interactive mode (#213, closes #212)

### Fixed
- `zylos init` no longer asks "Start services now?" — services always start unconditionally after init, removing an unnecessary prompt (#210)
- Install script always shows the `source` reminder after install, regardless of whether the PATH was already configured (#209, closes #207, #208)
- Resolved 3 Dependabot security alerts: minimatch ReDoS and qs prototype pollution/DoS vulnerabilities (#204)

## [0.2.7] - 2026-02-28

### Added
- **Non-interactive init**: deploy Zylos without manual intervention — pass flags like `--setup-token`, `--timezone`, `--domain` directly through `curl | bash`, and the installer handles everything unattended. Designed for Docker images, CI/CD pipelines, and batch provisioning across multiple servers. See `zylos init --help` for the full flag and environment variable list (#196, closes #195)
- **Auto-detect headless mode**: non-interactive mode activates automatically when there's no TTY (Docker, CI runners), or when `CI=true` / `NONINTERACTIVE=1` is set — no need to pass `-y` explicitly in truly headless environments (#196)
- **Setup token verification**: setup tokens are validated via an actual API call before being accepted — invalid or expired tokens are caught immediately, rolled back, and reported with a clear error instead of silently failing later (#196)
- **`install.sh --no-init`**: install dependencies and the zylos CLI without running `zylos init`, for cases where initialization needs to happen separately (#196)
- **Structured exit codes**: exit code 1 for fatal errors (invalid token, bad config), exit code 2 for partial success (e.g. Caddy download failed but core setup succeeded) — useful for scripted deployments that need to distinguish between failure modes (#196)

### Fixed
- Caddy download failed on macOS due to incorrect platform name in the URL — `darwin` now correctly maps to `mac` (#188, closes #185)
- PM2 startup `sudo` failed silently on wrong password — now prompts interactively with retry, and shows a clear message explaining auto-start is optional if it still fails (#190, closes #186)
- Authentication failure was easy to miss in init output — now shows a prominent yellow warning box at the end with the exact fix command (#196)
- Validation errors now include actionable recovery commands — each error tells you exactly what to run to fix it (e.g. "Generate one with: `claude setup-token`") (#196)
- Docker's default `TZ=UTC` could silently overwrite a user-configured timezone on re-init — `zylos init` no longer reads `TZ` from the environment, only from the `--timezone` flag (#196)

### Changed
- `WEB_CONSOLE_PASSWORD` renamed to `ZYLOS_WEB_PASSWORD` for naming consistency (old name still works as fallback) (#196)
- Logo updated to official Zylos brand logo (#184)
- README: added pronunciation guide (/ˈzaɪ.lɒs/ 赛洛丝) and non-interactive install documentation (#192, #193, #197)

## [0.2.6] - 2026-02-27

### Added
- **Setup token authentication**: authenticate on headless servers without a browser — pass a Claude setup token during `zylos init` or set `CLAUDE_SETUP_TOKEN` in `.env`, and the agent handles the rest (#174)
- **Branch install**: test unreleased changes before they land on main — `curl ... | bash -s -- --branch <name>` installs directly from any Git branch (#182)
- **Zero-step first run**: fresh installs now auto-run `zylos init` immediately after setup, so new users go from `curl | bash` to a running agent with no extra commands (#176)

### Fixed
- `curl | bash` install no longer swallows interactive prompts — stdin is properly redirected from `/dev/tty` so `zylos init` questions work inside a pipe (#179)
- Web console now shows Local + Network URL (vite-style) when no domain is configured, instead of a blank info section (#181)
- Post-install reminder box wording clarified to better guide users on next steps (#180)

## [0.2.5] - 2026-02-26

### Added
- **One-click install**: single `curl | bash` command to get Zylos up and running (#150)
- **API key authentication**: use your own `ANTHROPIC_API_KEY` as an alternative to `claude login` — key is validated on entry and all startup dialogs are auto-resolved (#165)
- **`zylos attach` command**: connect to the Claude session with a friendly UX — persistent status bar hint and 3-second overlay remind new users how to detach, with context-aware error messages when no session is running (#168)
- **Smoother first-run experience**: autonomous mode terms are pre-accepted during init, and the web console password is now prominently highlighted so it won't get lost in output (#158)
- **Smarter `zylos status`**: detects and clearly reports when Claude Code is stuck on an unaccepted prompt, instead of just showing "OFFLINE" (#158)

### Fixed
- `zylos upgrade --check --branch` now correctly compares against the branch version instead of the latest release tag (#166)
- Long messages sent via communication bridge no longer get truncated (#162)
- Caddy setup no longer warns about missing `sudo` when running as root in Docker (#171)

## [0.2.4] - 2026-02-22

### Fixed
- **Activity monitor Intl.DateTimeFormat memory leak**: `getLocalHour()` and `getLocalDate()` created new `Intl.DateTimeFormat` instances on every call (~3/sec from DailySchedule). V8/ICU allocates native memory per instance that GC never reclaims, causing unbounded RSS growth (~18 MB per 1 000 instantiations). Hoisted formatters to module-level constants. Activity monitor bumped to v15.

## [0.2.3] - 2026-02-22

### Added
- Three-way smart merge for upgrades: non-conflicting changes auto-merge via diff3, conflicts backed up with timestamps for manual review
- Manifest originals storage: saves installed file copies in `.zylos/originals/` as merge base for future upgrades
- File deletion during upgrades: files removed in new version are cleaned up (user-added files preserved)
- `--mode overwrite` flag for `zylos upgrade`: skip smart merge, force-overwrite all files
- Event-driven context monitoring via statusLine hook: replaces hourly polling with instant, zero-turn-cost detection
- `new-session` skill: graceful context handoff via `/clear` — preserves background tasks and hands off state to new session
- Session cost tracking: logs per-session cost to `cost-log.jsonl` on session change
- Unit tests for smart merge pipeline (43 tests via Jest)
- Activity monitor exit code logging: each Claude exit logged to `claude-exit.log` with timestamp and exit code
- Activity monitor critical events now output to stdout (visible in `pm2 logs`)

### Fixed
- `zylos upgrade --self --check --branch`: version check now reads from specified branch instead of always main
- File deletion no longer removes user-added files — only files tracked in the old manifest
- Path traversal guard in manifest originals (`assertWithinDir`)
- Binary file detection to prevent corruption during text merge
- Predictable temp file path replaced with `mkdtempSync`
- Busy-wait replaced with `sleep` in self-upgrade pipeline
- Deprecated `--production` flag replaced with `--omit=dev`
- Context monitor: reduce cooldown from 10min to 5min, atomic writes (write-then-rename) to prevent state file corruption
- Context monitor: fix cost carry-over bug on session change, track `used_percentage` every turn
- Self-upgrade: step 8 shells out to newly installed `sync-settings-hooks.js` to avoid bootstrap problem
- **Postinstall bootstrap fix**: settings sync now runs even during self-upgrade, ensuring new config fields (e.g. statusLine) are synced when upgrading from any old version
- **Activity monitor PATH fix**: pass PATH to tmux session via `-e` flag — tmux server may not inherit activity-monitor's PATH, causing "command not found"
- **Activity monitor CLAUDECODE env fix**: strip `CLAUDECODE` and `CLAUDE_CODE_ENTRYPOINT` env vars before starting Claude in tmux — fixes infinite restart loop when PM2 inherits Claude's runtime environment
- **Activity monitor startupGrace bypass**: grace period now checked in offline branch (tmux not found), preventing 5s retry loop when Claude crashes immediately
- **Activity monitor exponential backoff**: restart delay escalates 5s → 10s → 20s → 40s → 60s cap; requires 60s stable running before reset

### Changed
- Upgrade pipeline uses smart merge instead of brute-force overwrite for both components and core skills
- C4 upgrade reply includes auto-merged files and conflict details
- `check-context` skill simplified: reads `statusline.json` directly (always current)
- Activity monitor bumped to v14: env cleanup, exponential backoff, exit logging, stdout output
- statusLine config added to settings template with auto-sync on upgrade
- `postinstall.js` restructured: skill sync and settings sync separated; settings sync always runs when zylos is initialized

### Removed
- Polling-based context check (check-context script + activity monitor hourly poll)

## [0.2.2] - 2026-02-22 _(superseded by 0.2.3 — activity monitor env pollution bug caused infinite restart loop on affected instances)_

## [0.2.1] - 2026-02-22 _(superseded by 0.2.2 — postinstall did not sync settings during self-upgrade from older versions)_

## [0.2.0] - 2026-02-21

### Added
- Heartbeat v2: replace verify phase with stuck detection — no activity for 5 min triggers immediate probe with 2 min timeout
- Hook-based activity tracking: Claude Code hooks (PreToolUse, PostToolUse, Stop, UserPromptSubmit) replace non-functional fetch-preload
- Recovery backoff: failed recovery attempts wait progressively longer (1 min, 2 min, ... up to 5 min cap)
- DOWN state periodic retry: after exhausting recovery budget, check back every 30 min
- Daily upgrade check: queries GitHub at 6 AM for newer versions of core and all installed components, notifies via C4
- Diagnostic logging: hook timing, delivery failures, and tmux captures logged to activity-monitor directory
- Recovery notices: notify pending channels when Claude comes back online after downtime
- Auto-sync settings.json hooks on upgrade: template is now the single source of truth for all hook configurations
- `applyMigrationHints()` in self-upgrade pipeline (step 8): automatically adds missing hooks, updates modified hooks, removes obsolete core hooks
- `sync-settings-hooks.js` standalone script for postinstall path
- `hook-utils.js` shared module for hook matching utilities

### Fixed
- Stuck probe cooldown: short retry (60s) on probe failure, full cooldown on success
- Heartbeat state machine: prevent deadlock when enqueue fails during recovery
- Reset hook activity state on Claude restart to prevent false busy detection
- Deduplicate recovery notices for same chat with different message IDs
- Preserve failed notifications in pending-channels file instead of discarding
- postinstall.js: use execFileSync instead of execSync to prevent shell injection
- Tmux capture truncation: keep last 8KB (most recent content) instead of first 8KB
- Upgrade check: normalize v-prefix on both sides of version comparison
- Upgrade check: return false on C4 enqueue failure to allow DailySchedule retry
- DOWN state retry: only advance lastDownCheckAt after successful enqueue
- Settings.json hooks not updated during `zylos upgrade core`

### Changed
- `postinstall.js` uses template-based hook sync instead of `setup-hooks.js`
- `templates/.claude/settings.json` now includes all hooks (SessionStart + activity-monitor)
- Upgrade check runs as detached child process to avoid blocking monitor loop
- Safety-net heartbeat interval relaxed to 2 hours (stuck detection is primary mechanism)
- Activity monitor bumped to v12

### Removed
- `setup-hooks.js`: replaced by `sync-settings-hooks.js` which handles all hooks from the template

## [0.1.9] - 2026-02-21 _(superseded by 0.2.0 — settings.json hooks were not synced on upgrade)_

## [0.1.8] - 2026-02-18

### Added
- restart-claude: structured 5-step pre-restart session handoff checklist — stop background tasks, sync memory, write handoff summary, send to user/console, enqueue /exit (#117)
- upgrade-claude: same 5-step pre-upgrade session handoff checklist (#117)
- CLAUDE.md: context overflow protection rule — research tasks with many searches must use background subagents (#116)
- upgrade-claude: ISO timestamps on all log output for post-mortem analysis (#118)

### Fixed
- `zylos add`: try public URL first before authenticated GitHub API — fixes 403 on public repos when token lacks org access (#115)
- `fetchRawFile` and `fetchLatestTag`: same public-first fallback pattern (#115)

## [0.1.7] - 2026-02-17

### Added
- Dispatcher `REQUIRE_IDLE_MIN_SECONDS` config: sustained idle check before delivering require_idle messages (#113)

### Fixed
- Remove endpoint format restriction from C4 validation — endpoint format is now channel-specific (#113)
- restart-claude: use c4-control enqueue instead of nohup script to prevent race condition (#113)
- upgrade-claude: use c4-control enqueue instead of script-level idle detection (#113)
- upgrade-claude: cancel queued /exit on timeout abort to prevent orphaned restarts (#113)
- upgrade-claude: add ack-deadline to /exit enqueue to prevent stale running records (#113)
- check-context: use c4-control enqueue with `--with-restart-check` flag (#113)
- Dispatcher: require `idle_seconds >= 3` (sustained idle) before delivering require_idle messages (#113)

### Changed
- Increase file attachment threshold from 1KB to 2KB (#113)
- Simplify activity-monitor `enqueueContextCheck()` to delegate to check-context.js (#113)
- Delete legacy `restart.js` script (no remaining callers) (#113)
- Session-start-prompt: enqueue via c4-control instead of direct c4-receive (#113)

## [0.1.6] - 2026-02-17

### Added
- `zylos upgrade --branch <name>` flag for testing PR branches before merge (#111)
- Session startup hook (`session-start-prompt.js`) for injecting context at session start (#111)
- Upgrade migration hints: detect new, modified, and removed hooks by script path matching (#111)
- `hasStartupHook()` with fallback to C4 control enqueue when hook is not configured (#111)

### Changed
- Context check split into two-step flow with deadline spacing (600s/630s) (#111)
- Write context check state before enqueue to prevent retry flooding (#111)
- Control queue dispatch uses ORDER BY id for deterministic FIFO ordering (#111)

### Fixed
- Resolve repo fallback for `--branch` upgrade when version check fails (#111)
- Reject flag-like values (e.g. `--self`) as branch names (#111)
- Anchor `hasStartupHook()` regex to path separator to prevent false matches (#111)
- Extract last path-like token in hook commands to skip shell prefixes (#111)

## [0.1.5] - 2026-02-15

### Added
- Default to latest release tag instead of main branch when installing components (#105)

### Fixed
- Distinguish network errors from missing releases in `zylos add` (#105)
- Run daily memory commit in `~/zylos/memory/` instead of `~/zylos/` (#106)
- Remove timeout on post-install hook execution to support interactive hooks (#107)

## [0.1.4] - 2026-02-14

### Added
- Terminal color highlighting for all CLI commands — zero-dependency ANSI colors (#102)
- Web console: auto-configure Caddy route, password generation, and URL display (#101)

### Fixed
- Fix PM2 startup: use spawnSync to capture output on non-zero exit (#99)
- Adapt auth flow to new Claude Code CLI commands (#100)
- Redirect bare `/console` to `/console/` for Caddy wildcard routes (#103)

## [0.1.3] - 2026-02-13

### Added
- PM2 boot auto-start during `zylos init` — services survive reboot (#98)

## [0.1.2] - 2026-02-13

### Added
- Activity monitor: enqueue startup control after launching Claude (#94)
- Web console: read password from .env file directly (#97)

### Fixed
- Add nextSteps and SKILL.md guidance to C4 install flow (#95)
- Make nextSteps handling explicit and actionable in install workflow (#96)

## [0.1.1] - 2026-02-12

### Added
- Configurable HTTP/HTTPS protocol for Caddy (`zylos config set protocol http/https`) (#90)
- `zylos add --branch` flag for installing components from specific git branches (#92)
- Behavioral rule: isolate web operations from main loop (#89)
- Recommend nvm for Node.js installation in docs (#88)

### Fixed
- Strip `\r\n` from user input during interactive config collection (#91)
- Prevent Ctrl+C during `claude auth` from killing `zylos init` process (#93)

## [0.1.0] - 2026-02-11

Initial public release.

### Added
- Complete CLI: `zylos init`, `add`, `upgrade`, `remove`, `info`, `list`, `search`
- Component registry with GitHub-based distribution
- 8-step upgrade pipeline with backup, rollback, and manifest-based preservation
- Memory v5 (Inside Out architecture): tiered persistence with identity, state, references
- Memory Sync as forked subagent — runs in background without blocking main agent
- C4 Communication Bridge with control queue, heartbeat liveness, periodic task dispatch
- User-space Caddy: download binary, prompt for domain, generate Caddyfile, PM2-managed
- Caddy auto-configuration for components declaring `http_routes`
- Interactive component setup: `zylos add` prompts for config, writes `.env`, starts service
- SKILL.md `bin` field support: component CLIs symlinked to `~/zylos/bin/`
- Self-upgrade support for IM channels with two-step confirmation
- Claude Code auth flow in `zylos init`
- Timezone selection during init (auto-detect + confirm)
- Core Skills sync with user modification detection
- Lock-based concurrency control for upgrades
- `--json` output mode for programmatic consumption
- ESM-only codebase

### Infrastructure
- GitHub Actions CI workflow
- Modular lib/ architecture (config, components, download, github, manifest, skill, etc.)
