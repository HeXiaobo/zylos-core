# 3AI Memory Governance Profile

This is the exact deployment-specific Memory Sync addendum maintained for the
3AI operating environment. It is mandatory only when the operator explicitly
sets the Deployment Profile to `3ai`. It must never be inferred from an agent
name, runtime, channel, hostname, or repository branch.

Apply the numbered gates below as an overlay on the runtime-neutral Sync Flow
in `zylos-memory/SKILL.md`. Where this addendum repeats a numbered Core step,
the profile version replaces that step. The `5b.` through `6.` markers are
kept contiguous so the deployment's anchor-verification workflow can continue
to hash the governed region after it moved out of the default skill.

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
   ⚠️ This file is Zylos-managed and may be overwritten on upgrade — the
   provenance copy of 5b/5c lives in `memory/reference/preferences.md`;
   restore from there after any upgrade, and re-verify by sha, not by
   "the section is present". Recompute that sha with
   `workspace/scripts/anchor-verify.py`, which locates this region by marker
   (start `5b.`, end `\n(\s*)6.`, trailing newline excluded). **Byte offsets
   are descriptive only** — kept for human cross-checking, not authoritative —
   and they shift with every amendment; re-deriving the sha from a quoted byte
   range gives a different digest and reports a drift that did not happen.

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
6. Audit `references.md` against its content rules
   (`references/references-file-format.md`): relocate rule-violating
   entries to their routed destination (`reference/decisions.md`,
   `archive/`, or a pointer to the config file) instead of leaving or
   appending them. If the file exceeds the 8KB warn threshold
   (`memory-status.js` reports WARN), **do NOT autonomously trim — per
   防复发闸 #1, WARN + hang a 瘦身 task only. Autonomous bulk trim/restructure
   of the always-loaded layer inside sync is forbidden (真瘦身 = full Loop:
   备份 + maker≠checker + 决策人一键拍).** Relocating a single clearly
   rule-violating entry is allowed only if trivially safe.
7. Audit `state.md` against its content rules
   (`references/state-format.md`): relocate rule-violating content to its
   routed destination (`reference/projects.md`, `reference/decisions.md`,
   `archive/`, or a pointer to the on-demand file that already holds it)
   instead of leaving or appending it. If the file exceeds the 10KB warn
   threshold (`memory-status.js` reports WARN), **do NOT autonomously trim —
   per 防复发闸 #1, WARN + hang a 瘦身 task only. Autonomous bulk
   trim/restructure of the always-loaded layer inside sync is forbidden
   (would violate the state.md sync 序闸; 真瘦身 = full Loop: 备份 +
   maker≠checker + 决策人一键拍).** Relocating a single clearly
   rule-violating entry is allowed only if trivially safe.
8. Create checkpoint (only if conversations were fetched in step 2):
   `node ~/zylos/.claude/skills/comm-bridge/scripts/c4-checkpoint.js create <end_id> --summary "SUMMARY"`
   **8-verify — 机械回读闸 (2026-08-07 · veda 提案 → Mylos 采纳 · 接 §113 "报告也可能是空转的验证器"):**
   immediately after create, read the DB back —
   `node ~/zylos/.claude/skills/comm-bridge/scripts/c4-checkpoint.js latest`
   (or `sqlite3 ~/zylos/comm-bridge/c4.db "select id,end_conversation_id from checkpoints order by id desc limit 1;"`)
   — and CONFIRM the returned `id` + `end_conversation_id` match what you just created.
   **Report the DB-read id/bytes/sha, never your own asserted values.** A self-authored
   "compliance"/"success" table is NOT completion evidence — only the DB read is. If they do
   not match, the checkpoint did NOT land: retry or report failure; never claim success.
   Same rule for any deliverable a sync subagent claims (checkpoint / file / sha): the claim
   is unverified until read back from the real artifact (DB / mtime / bytes / recomputed sha).
   Provenance (survives Zylos upgrade): `memory/reference/decisions.md` 机械回读闸条目.
   **8-face — 摘要承载闸 (2026-08-11 · veda 提案 → Mylos 定稿 · veda 签 canon `f86f0eb5bd603d12` · 接 5c(c)「摘要无 amend 路径」+ 判据 659):**
   canonical 全文＋sha 见 3ai-shared `memory-sync-gates/zylos-memory-canon-8face-20260811.md`（本机为副本·勿就地改·改走 canon）。
   checkpoint 摘要是极少数「每次开机必被 session init 注入、却没有修改路径」的载体（`create | list | latest`，无 amend；下一次 sync 覆盖它）。写 step 8 的 summary 字符串时：
   (a) 【取值＝并集，不是只看本窗口】输入 ＝ 本窗口新出现的「口径更正 / 禁写句 / 射程限定」 ∪ 上一份 summary 里仍在生效的同类条目。写前先 `c4-checkpoint.js latest` 读回上一份，逐条判仍生效：仍生效 ⇒ 必须带过来；已失效 ⇒ 显式写"X 已解除"，不许静默丢弃。不许靠"记忆里 / state.md 里有"（两个独立载体·他机可能无对应 state.md 条目）。
   (b) 每轮 sync 都要重跑：写一次 ≠ 永久生效。「每轮重跑」和「重跑什么」是两件事——只带本窗口新增会让上轮保护当天蒸发，故 (a) 取并集。
   (c) 漏写无任何症状（"漏了该护的口径"与"本轮无需护的口径"同形），只能靠 (a) 并集区分（summary 不落磁盘·扫描够不到）。
   (d) 禁字扫描须把 summary 一并纳入（同源）。7b 与本闸合为一个"摘要面"关注点，勿分散。🔴 词表不可用时报 `UNMEASURABLE·未测`，绝不报"0 命中 / 未复发"。
   (e) 完成报告逐条枚举本轮带进 summary 的口径条目（新增 + 带过来 + 标"已解除"），不许只写"已确认"（枚举是产物）。
   为什么卡 step 8 不放 9：9 时 summary 已 create、无 amend 路径 ⇒ 只能再造覆盖 checkpoint（留 start>end）。8 是唯一"改而不是补"的位置。
   当轮"必带禁写句"措辞属 per-window·写在 summary 本身·不进 canon。当前实况：分类层 / 7c 闸"已硬化" ＝ 禁写；凭据面变强、金额面原地不动、对外不得讲整体硬化。
   Provenance (survives Zylos upgrade): `memory/reference/preferences.md` 摘要承载闸条目 · canon `f86f0eb5bd603d12`（veda 签）。
9. Confirm completion.

## 防复发闸 (Anti-Recurrence Gates · v2.3 · Formalized 2026-07-08)

> 治本机制（波总 2026-06-16 定）。**每次 Memory Sync 都要跑这 8 道闸**，把"乱"挡在源头，而不是等乱了再大扫除。完整方法论见 `~/zylos/workspace/记忆健康Loop方法论-SOP-v2.md`（记忆健康 Loop v2.2）。

1. **瘦身检查**：sync 后检查常驻层大小（identity+state+references）。超阈值 **只报警 + 挂一个瘦身 task，绝不在 sync 里自动重构**（真瘦身走完整 Loop：备份 + maker≠checker + 决策人一键拍）。
2. **Profile 查重**：建 `users/<id>/profile.md` 前先查通讯录/已有档案，防同人多档。
3. **state/projects 单一真源**：同一项目只在一处记详细（state=1-2 行摘要+指针，明细在 projects.md），sync 时发现双源即收敛。
4. **decisions 去重**：sync 时扫同主题多版本——纯重复删旧；决策进化旧新都留、旧标 superseded。
5. **体检 SOP 强制执行**：保鲜 Loop / 周度体检挂 scheduler 定时跑（SOP 存在但不跑 = 形同虚设）。
6. **归档清干净**：归档 = copy + delete，不留双份。
7. **源头入口闸**：有人让"记住 X"时，写入前先归位——①属什么**分类** ②存**哪个文件** ③用**什么形式**（摘要+指针/明细/决策条目）。入口规则边用边积累。
8. **关键标识符全文一致性核**（veda 2026-07-07 提案·Mylos 2026-07-08 formalize·防"canonical 一处更新、余处残留旧口径"）：sync 的"全文旧数字/旧口径扫描"里，对关键标识符（revId / 单号 / 表数 / 金额口径 等）做**全文一致性核**——同一标识符在多处出现时，校"终版/最新"标注**唯一**，不留"一处改对、余处残留旧值"（根因族=同"双源矛盾"；尤其紧邻禁报到账/单号等敏感区风险高）。做法：改 canonical 值时全文 grep 该标识符所有出现处、逐处对齐或标 superseded。**实战案例**：Veda 2026-07-07 发现 state.md L12 改对(revId100=终版) 但 L60/L68 未改(仍寫旧口径)→ 当场修正·revId100=终版·revId93=early版·机制自愈。

**自运行目标**：上面尽量全自动；唯一人工点 = 不可逆改动的决策人**一键拍**（ESCALATE 给人的是"改啥+为啥+建议"决策清单，不是原始 findings——省决策成本）。**跨 tenant 修复**（给别的组织的 bot 改记忆）：存疑标"待确认"、不按外部推断删改、先取对方组织 owner 授权（组织边界 > 技术可行）。

## Consolidation Review Override

### Core File Budgets
- Files over 100% budget: **WARN + hang a 瘦身 task; do NOT auto-trim the
  always-loaded layer (identity/state/references) inside sync — per 防复发闸 #1
  (绝不在 sync 里自动重构). Real 瘦身 = full Loop: 备份 + maker≠checker +
  决策人一键拍.** Move historical content to `reference/` or `archive/` only
  through that reviewed Loop, never autonomously.
