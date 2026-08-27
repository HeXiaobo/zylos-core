# Zylos Core + Feishu fork 升级手册

本文定义受管 Agent 从 `HeXiaobo/zylos-core` 与
`HeXiaobo/zylos-feishu` 升级的唯一标准流程。目标是把版本选择、升级顺序、
通信连续性和验收证据固化为脚本，让执行 Agent 只负责提供已审核的不可变
提交，不再临场拼接命令或手工覆盖文件。

## 1. 适用边界与发布结论

- Core 与 Feishu 必须作为一组审核，但按 **Core → Feishu** 顺序升级。
- Core fork 是必需的：固定编排器、双向 C4 门禁、关键通信文件门禁和 PM2
  真在线校验都属于 Core 升级基础设施。
- 当前 Feishu 目标使用已经通过测试的 `0.3.7-rc.7` 提交
  `f26ac9b69ebb697a926668c154ff317613d5c8e2`。
- `upstream` 只用于读取和同步；发布只允许推送到 `origin` 对应的
  `HeXiaobo/*` fork。
- 只有结构化报告为 `status: "PASS"` 且外部消息往返验收成功，才可宣告升级
  完成。任何中间状态均为 `HOLD`。

## 2. 今天暴露的问题

### 2.1 主故障：收消息入口在同步中被删除

2026-08-26 16:49–16:54，Skills 同步删除了
`skills/comm-bridge/scripts/c4-receive.js`。飞书 WebSocket 仍在收包，但连续六次
调用 C4 时都报 `Cannot find module`。因此消息没有进入 `c4.db`，也没有触发
Agent turn，自然不会回复。此前只校验出站 `c4-send`，没有校验入站入口与持久化，
这是升级后失联的直接原因。

### 2.2 `PM2 online` 被错误当成健康

旧流程只看进程名和 `online` 状态，没有核验 `pm_exec_path` 指向的文件仍然存在。
进程表可以保持绿色，但实际消息入口已经缺失，形成 fake-online。新流程必须同时
满足：进程在线、执行文件是普通文件、必需服务指向预期脚本。

### 2.3 错误只写本地，没有升级失败告警

六次入站失败都只留在本机日志；上游看不到“已收包但投递 C4 失败”。因此升级
验收不能依赖“没有报错”或“PM2 看起来正常”，必须主动跑本地双向 canary，再做
一次真实外部消息往返。

### 2.4 管理员恢复是二次影响，不是首次失联根因

23:41–23:43 的管理员恢复操作（2342）发生在首次失联之后。它恢复了服务，但
重新安装时覆盖了八个 channel Skill 目录，造成额外的本地改动恢复工作。复盘中
必须把“首次失联根因”和“恢复动作的副作用”分开。

### 2.5 磁盘不是本次根因，但必须作为前置门禁

清理前根分区实际为 74%、尚余约 16 GiB，inode 使用约 9%，日志中也没有
`ENOSPC` 或 `SQLITE_FULL`，所以磁盘不是首次失联原因。审计后清理缓存和临时文件
释放约 5.32 GiB；固定脚本现在要求至少 5 GiB 可用空间，防止真正的磁盘问题与
代码问题混在一起。

同日后续升级中根分区一度被观察到 99%，由管理员 2342 处理。该现象与 16:49
首次失联不是同一时间段，不能倒推为首次根因；但 99% 本身足以让下载、npm、
SQLite、日志和临时备份进入不可预测状态。任何升级前后只要低于 5 GiB 门槛，
统一 `HOLD`，先由管理员清理并复核 `df -Pk` 与 inode，再重跑固定脚本。

### 2.6 严格 stdin 策略与旧 canary 的契约冲突

旧连续性门禁会强制测试 legacy argv，而运行时可能显式设置
`C4_STRICT_STDIN_ONLY=1`。这会把正确的安全策略误判成故障。新 canary 按实际
策略验证：兼容模式要求 argv 可用；严格模式要求 stdin 和 body-file 可用，并
要求 argv 精确拒绝且没有发生投递。

SS 的后续实跑又证明，`--body-file` 当时只存在于历史保留版
`c4-send.js`，不在 Core 正式源代码中；一次成功回滚会恢复出“文件存在但能力丢失”
的旧基线，直到 step 13 才发现。现在该传输已进入 Core 正式实现并发布
`c4.reply.body-file:1`。自升级 step 0 与 fork-pair staging 都在任何写操作前要求
Core 目标具备该能力；它不是 Feishu 源需要重复声明的能力。运行时仍用真实文件
投递做终态验证；禁止再从任意历史备份手工覆盖。

### 2.7 全文件恢复脚本会把新版本重新覆盖成旧版本

旧 `restore-preserved.sh` 直接回填整个旧文件，曾把 rc.5 内容覆盖为 0.3.2，
随后仍给出假通过。禁止再使用“整文件覆盖 + 看进程状态”的恢复方式。局部定制
只能通过有基线的三方合并处理；发生冲突即 `HOLD`，不得让模型自行选择旧文件。

### 2.8 可移动分支和手工步骤造成目标漂移

分支名可能在检查后移动，模型也可能漏掉版本、fork 路由、升级顺序或验收步骤。
新流程只接受 40 位完整 commit SHA；固定脚本在任何写操作前下载并校验两个目标，
然后统一执行、统一出报告。

### 2.9 组件代码目录缺失会让 Core 升级在服务门回滚

SS 第一次运行固定脚本时，Core step 12 报
`Not online after 30s: zylos-wechat, zylos-wecom` 并完整回滚。机器证据显示
`wechat`、`wecom`、`hxa-connect`、`openmax`、`browser` 的数据目录仍在，但
Skill 代码目录已被恢复操作删除；其中 WeChat/WeCom 在 PM2 中甚至表现为
`online + pid=null + executable missing`。这不是健康状态。固定脚本现在会在任何
安装和停服之前扫描全部 online PM2 条目的真实 executable，发现这种矛盾立即
`HOLD`。

HXA 是升级期间的备用通信面，恢复优先级高于继续重放升级。SS 的 code-only 恢复
固定为 `HeXiaobo/zylos-hxa-connect` 的 `1.7.3` 提交
`160dbaeac86f503b2d1889343354c5aee3b57785`；脚本只补回缺失代码、保留数据和
配置、持久化 fork 路由，并要求 PM2 真进程、profile 和 peers 三门通过。

### 2.10 回滚遗漏新服务会制造下一轮升级的幽灵进程

一次旧版升级已经启动了新目标才有的
`c4-response-stream-supervisor`，随后 step 12 失败并回滚到 Core `0.7.0`。旧回滚
恢复了 Skills 和 ecosystem，却没有删除升级过程中新增的 PM2 条目，也没有重新
`pm2 save`。结果是进程仍显示 `online`，PID 真实存在，但入口文件已随旧 Skills
恢复而消失。下一次严格 preflight 正确地在任何升级写操作前将其拦下。

Core 回滚现在会记录“由本次升级新增、原基线未运行”的服务：失败时精确删除这些
PM2 条目，恢复原服务后再保存最终进程清单。为兼容已经被旧实现污染的机器，固定
pair runner 只对一个可证明的历史残留做自愈：进程名必须是
`c4-response-stream-supervisor`，路径必须是标准 live 路径、live 文件必须缺失，且
不可变目标中必须存在同一路径的替代入口。任何路径漂移或其他坏进程仍然 `HOLD`。

### 2.11 周期任务不能用常驻 daemon 的 `online` 标准判活

SS 的 `task-comment-bridge` 是 PM2 cron one-shot：
`autorestart=false`、`cron_restart="*/3 * * * *"`、最近退出码 0、
`unstable_restarts=0`。它每三分钟启动一次，完成后在两次触发之间正常处于
`stopped`；`restart_time=3690` 表示历史触发次数，不是崩溃 3690 次。旧 step 12
要求所有升级前恰好 online 的进程在 30 秒后仍 online，因此把正常周期任务误判为
坏 daemon。

新事务会单独记录 cron one-shot，停止后使用它自己的 PM2 定义重新激活，不套用
Core daemon ecosystem；升级和回滚两条路径都如此。健康门允许它在成功运行之间
处于 `stopped`，但仍强制要求 cron 配置存在、`autorestart=false`、最近退出码为
0、`unstable_restarts=0`，且 executable 是真实文件。常驻服务仍必须持续
`online`，两类进程不会再共用一个模糊判据。

### 2.12 同一运行轮次被误判空闲，造成跨通道回复落后一轮

SS 升级后的外部验收发现固定“落后一轮”：飞书 B 的答案写入 A 的卡片，随后
HXA 的工作摘要又写入仍待处理的飞书 C 卡片。机器时间线证明 A、B、C 都进入同一个
Claude session，而且 B 在 A 的 `Stop` 之前、C 在 B 的 `Stop` 之前就已投递。
根因不是 HXA 掉线，而是工具完成事件把 `in_prompt` 提前清零，监控器在同一轮的
工具间隙报告 `idle`，dispatcher 因而把下一条普通消息直接塞进仍在运行的旧轮次。

另有一层次生风险：HXA、OpenMax 和本地提示没有 Feishu assistant-request marker；
旧 hook 会按“唯一 started 请求”猜测绑定，使无 marker 轮次抢走尚未绑定的飞书
响应卡。只修 marker 不能阻止消息先进入旧轮次，只修 idle 也不能保证卡片绑定正确。

Core `0.7.2-rc.8` 同时执行三层门禁：

1. 每条普通 conversation 在写入 tmux 前取得唯一、持久化的 runtime-turn
   admission；无论来自飞书、HXA 还是 OpenMax，都只在同一 session 的 `Stop` 后
   释放。dispatcher 重启也不会丢失这把锁。
2. Claude `UserPromptSubmit` 到 `Stop` 始终保持 `in_prompt=true`，tool-to-tool
   间隙不再被判为空闲；旧版本遗留的 started assistant run 还会作为升级期后备门。
3. 飞书响应绑定只接受位于消息末尾的合法 assistant-request marker。无 marker 或
   非末尾 marker 持久化为 fail-closed，后续 tool/display/stop 不得回退猜测；每次
   bound/rejected/closed 决策还会追加到无正文的 per-turn JSONL 审计轨迹，避免再次
   因 last-write-wins 状态文件而无法复盘。

Claude 的 `UserPromptSubmit`、兼容用 `PreToolUse`、`Stop` 和 idle Notification 是
同步边界；PostTool/MessageDisplay 等非启动事件只能触碰已经 started 的 admission，
不能把下一条 submitted 消息提前晋级。每次可信 lifecycle 活动都会推进持久化
generation；sustained-idle 恢复必须同时匹配 generation，并且最后一次活动也已超过
30 秒。generation 只用于保护恢复快照；observation 下界固定为本轮开始时间，不能被
本轮稍后落库的 MessageDisplay/PostTool 继续抬高。事务只拒绝 observation time 早于
本轮开始的迟到 idle/Stop/PostTool；因此升级前遗留的 async hook 不能结束下一轮，
而同一轮内进程启动与 SQLite 落库顺序轻微反转时，合法 Stop 仍可完成当前请求。新
admission 在取得锁时先写下界，Prompt/兼容 PreTool 开始轮次时更新一次后保持不变；
旧库中 active 且为空的基线会在迁移时保守回填。

该 runtime-turn admission 只在 Claude 启用。Codex 当前没有等价的
MessageDisplay 完成边界，因此不会创建无法可靠关闭的 admission；带 assistant
request 的 Codex 消息固定回退到 request-scoped `c4-send --request-id` 完成路径，
并继续使用既有 activity-monitor busy/idle 门禁。manifest 的 `runtimeModes` 明确
公布这一边界，禁止把 Claude display-hook 模式误报为 Codex 已支持。

控制队列仍保留显式 bypass，不会被普通对话 admission 阻断。只有安装中真的缺失
`UserPromptSubmit` hook 时，首个后续 lifecycle hook 才保留单候选兼容绑定。
`SessionStart` 在 settings 中出现三组本身是正确配置，分别对应 `startup`、`clear`、
`compact`；只有同一 matcher 内的同一命令重复才是异常。

发布验收必须交错发送“飞书 nonce A → HXA nonce B → 飞书 nonce C”，逐一核对
回复通道、内容、源消息卡片和终止顺序。仅验证每个通道各自能收发不足以发现串线。

### 2.13 正文已经显示，但 Stop 被静默拒绝后卡片仍会失败

SS 在 `0.7.2-rc.9` 验收中出现过一条“正文完全正确，卡片最终却显示本次处理未完成”。
持久时间线证明 `Stop` 已触发，但没有 `closed` binding；34 秒后下一条消息触发
`RUNTIME_TURN_RECOVERED_AFTER_IDLE`。根因是同一轮的 hook 进程可能按 A→B 启动、
却按 B→A 取得 SQLite 写锁。旧逻辑把“最后落库的 observation time”误作轮次边界，
于是较早启动但逻辑上终止本轮的 Stop 被当成旧轮次静默丢弃。

Core `0.7.2-rc.10` 固定执行五层闭环：

1. observation fence 只表示本轮开始，不再随同轮活动上移；恢复 CAS 继续使用独立的
   lifecycle generation，因此修 Stop 误拒绝不会放宽 30 秒恢复竞态门。
2. binding 所有权与 pending/bound/rejected/closed 状态都归属于 SQLite admission；
   JSON binding 只是可重建的投影。缺失或损坏 JSON 时只能从当前 admission 的精确
   request/session owner 恢复，requestless HXA admission 禁止猜测或绑定飞书请求。
   request-scoped tool、公开 reasoning 与 output 在任何事件/正文写入前都必须通过
   SQLite 中 active + started + exact request/session + bound 校验；不匹配必须零写入。
3. 带 binding 的 Stop 在同一个 SQLite 事务里同时写入 `RunCompleted/RunFailed` 和
   admission 终态；任一写入失败必须整体回滚，不得先释放 admission 再补 request。
4. `MessageDisplay final=true` 会对本轮累计公开正文记录 admission、session、message
   ID、observation time、精确 activity ID 与 output hash，不立即宣告成功。完全相同
   的 display event 只能生效一次；比已观察工具/输出活动更早的迟到 final 会直接
   失效。同一毫秒出现不同 activity 时无法证明因果先后，必须按歧义 fail-closed；
   out-of-order batch 重放必须保留第一次观察时间，不得用重放时间覆盖。若 Stop 正常
   到达，仍以 `last_assistant_message` 为 canonical；仅在 Stop 真丢失、持续空闲且
   hash/causal fence 全部匹配时，recovery 才允许写 `RunCompleted`。
5. Stop/recovery 在事务内写入 closed-binding outbox；投影成功后才 ack。进程崩溃或
   写文件失败会保留 pending，dispatcher 必须重试成功后才接纳下一条消息。Stop 的
   `observation_stale`、`not_started`、session/request conflict 必须留诊断，禁止无声
   early return。

升级后的通信验收不能只看回复正文。每个 nonce 必须同时满足：request 终态为
`completed`、binding 为 `bound→closed`、卡片为成功终态、下一条消息未触发上一条的
idle recovery。交错 A/B/C 门禁至少重复三轮；任一轮出现“正文正确＋失败横幅”都应
HOLD，先查 `RunFailed.payload.code`、binding audit 与 Stop 诊断。

### 2.14 HXA 的“已发送”与双向通信是两件事

HXA 失联包含两个独立缺口，必须分开修复和验收：

1. 发送端返回 delivered 只能证明 Hub 接受消息，不能证明 SS 的长连接已收取。
   HXA `1.7.4` 增加 15 秒 authoritative inbox reconciliation、restart-safe C4
   spool 与去重 seen 集合，修复 WebSocket 漏帧和停机消息补拉。
2. SS 收到请求并完成 assistant turn，也不等于回复会回到 Hub。旧安装缺少
   `scripts/stream.js`，出现 assistant request `bound → closed` 但没有任何 HXA
   出站。HXA `1.7.5` 增加 response-stream adapter 和持久化的 per-request
   delivery ledger；普通 final 与显式 `c4-send --request-id` 共用同一账本，
   并发或重启也只能投递一次。

HXA 发布至少要跑四类真实 canary：自然 final、显式路径与 final 双触发去重、
停机期间写入后自动补拉、重启 overlap 重扫不重放。终验必须同时核对 Hub
message ID、C4 inbound ID、ledger `attempts=1` 和 spool=0；只看回复正文计数会把
引用 nonce 的对账消息误算成重放。

### 2.15 组件已升级但 source marker 仍旧

SS 的 HXA 已逐文件匹配 `1.7.5@182d7b3...`，但标准 `zylos upgrade` 连续两次
都没有更新 `.zylos-source.json`，仍显示 `1.7.3@160dbae...`。手工改 JSON 会让
代码、merge baseline 与注册表失去共同事务边界，因此禁止作为修复。

Core `0.7.2-rc.9` 用持久 journal 把来源标记绑定到最终 baseline commit：精确
提交会记录 repo、完整 SHA、ref type、实际安装版本、原 installedAt 与 upgradedAt。
baseline commit 之后崩溃会自动向前补齐 marker 与 registry；commit 之前崩溃时，
业务回滚状态无法由 metadata 单独证明，因此保留 journal 并明确 `HOLD`，禁止静默
删除证据或假报成功。正常失败只有在代码、data、Caddy 与 service 回滚全部成功后
才删除未提交 journal。

`components.json` 的所有写入和 metadata finalize 共用带 process-start identity 与
fencing token 的全局事务；不同组件并发升级不会互相覆盖。commit point 使用
`COMMITTED / PROVABLY_UNCOMMITTED / UNKNOWN` 三态判断，损坏、无权限或 I/O
异常一律保留 journal 并 fail closed。成功后 `components.json.source` 与 branch
更新到同一不可变 ref；`.zylos-source.json` 属于运行时 provenance，已从业务文件
manifest 与本地修改检测中排除。

### 2.16 回复卡片时间不能单独证明运行轮次顺序

飞书 assistant card 会先创建再异步更新，HXA 回复也有独立的 Hub 投递延迟。
因此 A/B/C 的外部 `create_time` 或 `update_time` 只能证明送达，不能单独证明
runtime turn 的先后。若外部顺序与预期不一致，必须读取 C4 conversation、
runtime-turn admission、assistant binding-events 和 HXA delivery ledger 的持久化
时间线；缺少终止字段时结论是 `UNKNOWN/HOLD`，不能用“可能是卡片延迟”猜 PASS。

### 2.17 fork 测试不得触碰真实 `~/zylos/.env`

本次升级窗口内真实 `.env` 三次消失；现有证据把嫌疑收敛到未隔离的 fork CLI
测试/回滚路径，但没有抓到删除调用当场，因此事件结论保持“高置信嫌疑，未定案”。
已确认的危险机制是：部分 rollback 分支在快照认为原文件不存在时会执行删除；若
测试进程继承真实 `ZYLOS_DIR`，测试夹具就可能把生产安装目录当成沙盒。

Core `0.7.2-rc.10` 的 `scripts/run-node-tests.js` 不再信任调用者是否记得传环境变量：
它为每次 Node 套件创建临时 `HOME`，并固定令 `ZYLOS_DIR=$HOME/zylos`，结束时只删除
该临时根目录。测试前后仍须比对真实 `.env` 的 SHA-256、mtime、mode 与 flags；任一
变化立即 `HOLD`。`chflags uchg` 可作为 macOS 事故期的可逆保护和抓现行手段，但不
替代隔离；凭据轮换或合法升级需要写入该文件时，必须先显式解锁，操作后立即复核并
恢复保护。

事故取证必须只读，至少保留 `captured_at`、窗口起止、文件 hash/mtime、目录 mtime、
磁盘与 inode 使用率、当前 flags，以及“查过但不存在”的预期项。flags 是取证时状态，
不能倒推为事发时状态；例如 05:19 才设置的 `uchg` 不能用于证明更早窗口已经上锁。

### 2.18 业务 Skill 连续性与备份 retention 必须由脚本机械判定

SS 在一次成功升级后发现项目级业务 Skill 目录缺失。现有证据只能证明缺失发生在
升级窗口附近，不能证明具体删除源码路径；因此事故根因保持 `EVIDENCE_GAP`，不得
把时间相关性写成已证实机制。Core `0.7.2-rc.11` 在任何 live mutation 前扫描当前
skills root，逐顶层目录记录归属、文件数、`SKILL.md`、`scripts/`、脚本数及
frontmatter 声明入口，并在事务备份完成后用同一口径复扫。备份少一个目录、文件数
不等或关键入口缺失，升级在同步前失败。

Core sync 后及最终 baseline commit 前会再次检查。target-owned Skill 可以按固定目标
更新；foreign/business Skill 必须仍在，文件数和脚本数不得坍缩，原有说明、脚本树和
声明入口不得消失。任一条件失败进入既有 rollback，禁止以总目录数相近或“PM2
online”放行。inventory 必须注明根目录、registered/unregistered、full-tree 或
SKILL-only 口径；不同口径的总数不能相减推断损失。

配对升级只有在完整 postcheck 与 hermetic communication gate 通过后才运行 Core
backup retention。固定保留本次 backup 与最新 prior backup；更旧候选必须位于受管
tmp 顶层，且 path/realpath/dev/ino/mtime、非 symlink 目录和 zylos package signature
全部匹配，并带有绑定本次成功 pair summary 的签名 owner marker。脚本使用全局独占锁，
先把 `PLANNED` 原子写入报告，再同根 rename 到受限 quarantine（路径由随机不可预测
标识生成），复验同一 inode 后标记 `GC_PENDING`。当前 run 新建的 quarantine 不会在
同一 run 硬删除；只有后续成功 pair run 才会在再次核验目录树无 symlink、无跨设备项后
回收。审计写入失败时零移动；任何 rename/GC 失败都保留现场并报告 `WARN`。执行前
仍需按 Owner 授权核对精确候选路径，禁止把 retention 当成泛化清理授权。

本版本同时提供正式的 `zylos task set-reminder`。原生任务 reminder 漂移只能通过该
public Core command 修复，必须带 owner/acceptor actor、正整数 expected version、
非负 minutes-before-due 与稳定 idempotency key。禁止用 SQLite 直写伪造 receipt 或
projection event。

SS 业务技能恢复采用冻结观察集而非“全量缺失”口径：当前观察集为 7 个名字，其中
5 个已通过 verify/dry-run/execute 并回读为 `ALREADY_EXACT`，2 个因源不完整保持
`HOLD`。观察集之外的 xiaohongshu、meeting-notes-processor、zsxq-skill 需单独
取证，任何同侪或 HXA 转述都不能替代 Owner 在飞书 user identity 的直接授权。

## 3. 发布前准备

发布负责人在本机完成以下检查，并记录两端的完整 SHA：

```bash
# Core fork worktree
git status --short
git rev-parse HEAD
git ls-remote origin refs/heads/<core-release-branch>
npm test
npm audit --omit=dev
git diff --check

# Feishu fork worktree
git status --short
git rev-parse HEAD
git ls-remote origin refs/heads/<feishu-release-branch>
npm test
npm audit --omit=dev
git diff --check
```

硬要求：

1. 两个 worktree 都无未提交改动；本地 HEAD 与 `origin` 分支头一致。
2. 版本分别与参数完全一致，不能用“版本差不多”代替。
3. Core 目标包含五个关键通信资产（含共享 binding projector）以及本手册的一键编排器。
4. Feishu 目标通过 native task 评论闭环与完成闭环的测试套件。
5. 不从 `upstream` 直接部署，也不向 `upstream` 推送。
6. Core Node 测试由仓库 runner 创建隔离 `HOME/ZYLOS_DIR`，且测试前后真实
   `~/zylos/.env` 的 hash、mtime、mode 与 flags 完全一致。

### 3.1 SS 的 HXA 代码目录缺失时先恢复通信

仅当 SS 的组件登记仍是 HXA `1.7.3`、数据目录存在且 Skill 目录缺失时使用。
`CORE_SHA` 必须指向包含本恢复器的已审核 Core fork 提交：

```bash
CORE_SHA='<40-hex-core-sha>'

curl -fsSL \
  "https://raw.githubusercontent.com/HeXiaobo/zylos-core/${CORE_SHA}/scripts/restore-hxa-connect.sh" \
  | bash -s -- \
      --core-sha "${CORE_SHA}" \
      --agent 'ss' \
      --execute
```

恢复器内置并拒绝偏离以下目标：

- repo：`HeXiaobo/zylos-hxa-connect`；
- commit：`160dbaeac86f503b2d1889343354c5aee3b57785`；
- version：`1.7.3`；
- service/entry：`zylos-hxa-connect` / `src/bot.js`。

它不会读取或输出配置内容，不改 HXA 数据目录；只有配置文件 hash 不变、PM2
具有真实 PID/entry、HXA profile 与 peers API 均成功才给 `PASS`。之后还要用唯一
nonce 做一轮外部 HXA 双向消息，不能用本地 API 成功代替真正通信。
profile/peers 探针不写死 org 名，由 HXA CLI 选择配置里的 default 或首个 enabled
org；若前次已落地完全相同的 source marker 与关键文件，恢复器会安全续跑后置门，
不会再次覆盖代码。

### 3.2 SS 的 Core step 12 阻断组件恢复

只有 HXA 已经真在线后才运行。脚本固定恢复原登记版本，不追 `main`：

```bash
CORE_SHA='<40-hex-core-sha>'

curl -fsSL \
  "https://raw.githubusercontent.com/HeXiaobo/zylos-core/${CORE_SHA}/scripts/restore-ss-upgrade-blockers.sh" \
  | bash -s -- \
      --core-sha "${CORE_SHA}" \
      --agent 'ss' \
      --execute
```

内置目标只有两项：

- WeChat：`zylos-ai/zylos-wechat`，`0.3.2`，
  `67f5142b92e0d67563ac00e3c9e245350e58b280`；
- WeCom：`zylos-ai/zylos-wecom`，`0.1.5`，
  `781a51f957ee38bdfa48939b4e3d1c52d70f0722`。

WeCom 的 `main` 已在 `0.1.5` 之后，禁止以 `main` 代替固定提交。脚本在修改前把
两项依赖都装进 staging，保留原 data/config，启动后要求两个 PM2 服务均具有真实
PID 和正确 executable，并在前后都复核 HXA 真在线。OpenMax/Browser 不属于本次
Core step 12 的阻断，不在这个脚本中顺手恢复。

### 3.3 HXA 固定 SHA 升级与 source marker 回填

必须先让 Core 达到 `0.7.2-rc.9` 或更高，再用标准组件事务升级 HXA；禁止覆盖
Skill 目录或手工改 marker：

```bash
HXA_SHA='182d7b3ed55fd758981c8edc7ae923e3bc03614b'
CORE_CLI="$(npm root -g)/zylos/cli/zylos.js"

test -f "${CORE_CLI}" || { echo 'HOLD: installed Core CLI missing'; exit 1; }
node "${CORE_CLI}" upgrade hxa-connect \
  --branch "${HXA_SHA}" \
  --yes \
  --skip-eval \
  --json
```

成功后同时核对：安装版本 `1.7.5`、`components.json.source.ref` 与
`.zylos-source.json.sha` 都等于 `HXA_SHA`、PM2 executable 存在、四组织 WS
恢复、Feishu PID/restart 未变化。再跑 2.14 的真实 HXA canary；CLI 退出 0 不能
代替外部双向通信。

### 3.4 registry lock 崩溃后的安全处理

若 CLI 报 `components registry lock recovery required`，先停止同一 Agent 上所有
component add/remove/upgrade 操作，禁止直接 `rm` lock。用已部署 Core 的同一套
process-start identity 只读判定 owner：

```bash
CORE_IDENTITY="$HOME/zylos/cli/lib/process-identity.js"
OWNER_FILE="$HOME/zylos/.zylos/locks/components-registry.lock/owner.json"

CORE_IDENTITY="$CORE_IDENTITY" OWNER_FILE="$OWNER_FILE" \
  node --input-type=module - <<'NODE'
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
const { inspectProcessIdentity } = await import(pathToFileURL(process.env.CORE_IDENTITY));
const owner = JSON.parse(fs.readFileSync(process.env.OWNER_FILE, 'utf8'));
process.stdout.write(`${JSON.stringify({ owner, status: inspectProcessIdentity(owner.process) }, null, 2)}\n`);
NODE
```

`ALIVE` 表示仍有写者，继续 `HOLD`；`UNKNOWN` 也必须保留现场并交管理员。
只有结果精确为 `DEAD`，且再次确认没有 component CLI 在运行，才把准确的 lock
目录移动到带时间戳的隔离名（可恢复，不删除），然后从固定脚本开头重跑：

```bash
LOCK_DIR="$HOME/zylos/.zylos/locks/components-registry.lock"
LOCK_QUARANTINE="${LOCK_DIR}.stale-$(date -u +%Y%m%dT%H%M%SZ)"
mv -- "$LOCK_DIR" "$LOCK_QUARANTINE"
```

把 identity 输出与隔离路径写入升级报告。该步骤只处理 registry mutex，不代表
业务升级已成功；仍需执行全部 preflight、pair upgrade 和外部通信门禁。

## 4. Agent 唯一执行命令

把已经审核并推送的 Core SHA 填入 `CORE_SHA`，不要使用分支名、短 SHA、`main`
或 `latest`。整条命令一次执行，不拆成手工步骤：

```bash
CORE_SHA='<40-hex-core-sha>'
FEISHU_SHA='f26ac9b69ebb697a926668c154ff317613d5c8e2'

curl -fsSL \
  "https://raw.githubusercontent.com/HeXiaobo/zylos-core/${CORE_SHA}/scripts/upgrade-fork-pair.sh" \
  | bash -s -- \
      --core-sha "${CORE_SHA}" \
      --feishu-sha "${FEISHU_SHA}" \
      --core-version '0.7.2-rc.11' \
      --feishu-version '0.3.7-rc.7' \
      --agent '<agent-id>' \
      --execute
```

脚本会在第一次修改前完成：

- 两个不可变归档的下载、版本、产品、协议和关键文件校验；
- 持久化 fork 路由校验：Core 必须是 `HeXiaobo/zylos-core`，Feishu 必须是
  `HeXiaobo/zylos-feishu`；
- `c4-receive.js` 仍存在、可用磁盘不少于 5 GiB；
- 现有关键 PM2 进程在线且执行文件真实存在。
- 所有声称 online 的 PM2 进程都有真实 executable；组件代码缺失会在事务前
  `HOLD`，不会等 Core step 12 再回滚。
- 若检测到旧回滚留下的、路径和目标均完全匹配的 response supervisor 幽灵条目，
  execute 模式会先精确删除并保存 PM2 清单，再回读确认；dry-run 只报告
  `WOULD_APPLY`，不会修改机器。除此之外不自动删除任何进程。

随后脚本按固定顺序升级 Core 和 Feishu，并执行：

- 安装版本与目标版本复核；
- 五个关键通信资产复核；
- PM2 真在线复核，包括 response stream supervisor；
- cron one-shot 以“有效 cron + 成功退出 + 真实入口”判活，并显式恢复其调度；
- hermetic 出站 stdin/策略兼容 canary；
- hermetic 入站 `c4-receive` 与 `c4.db` 持久化 canary。

报告写入：

```text
~/zylos/.zylos/upgrade-reports/fork-pair-<timestamp>/summary.json
```

报告不记录完整 PM2 环境变量或消息正文，只记录必要状态、版本、散列和结构化结果。

## 5. PASS、HOLD 与回滚语义

### PASS

必须同时满足：

- `summary.json.status == "PASS"`；
- `result == "UPGRADE_COMPLETE"`；
- Core 与 Feishu 版本均精确匹配；
- 所有 PM2 与双向 C4 canary 通过；
- 外部真实消息往返通过；
- 需要启用原生任务能力时，评论通知与完成闭环的 live gate 也通过。

### HOLD

任一前置或后置条件失败即 `HOLD`。不要继续手工覆盖文件，不要把“Core 已升级但
Feishu 未升级”描述为成功。两层升级事务各自负责本层失败回滚；若 Core 已成功而
Feishu 随后失败，报告会明确写
`CORE_UPGRADED_FEISHU_ROLLED_BACK_OR_UNCHANGED`。此时较新的 Core 保持向后兼容，
但整组发布仍处于 `HOLD`，须依据报告修复后重新执行同一个不可变目标。

禁止用以下信号代替 PASS：

- PM2 只显示 `online`；
- Agent 说“应该好了”；
- 只测发消息、不测收消息；
- 只看到飞书 WebSocket 收包；
- 手工恢复后没有立即报错；
- 分支 HEAD 与检查时“看起来一样”。

## 6. 外部闭环验收

脚本 PASS 后，升级负责人必须完成三层外部验收：

1. 由任务负责人向 Agent 发送带唯一标识的飞书消息；Agent 必须回复同一标识。
   同时确认 `c4.db` 有对应入站记录，PM2 restart/unstable 计数没有异常增长。
2. 交错发送飞书 A → HXA B → 飞书 C 三个唯一 nonce。三条都必须精确回复到原
   通道；再按 2.16 的持久化证据核对运行轮次终止顺序。HXA 还必须覆盖自然回复、
   停机补拉和重启重放去重，不能只测在线收发。
3. 若本次发布启用飞书原生任务能力，使用预先准备、包含明确 task/comment/member
   ID 的 gate 输入运行：

   ```bash
   cd ~/zylos/.claude/skills/feishu
   npm run task-comments:gate -- --input /absolute/path/comment-gate.json
   npm run task-status:gate -- --input /absolute/path/completion-gate.json
   ```

   两份报告都必须 PASS。不得让执行 Agent 猜测试对象、临时创建业务任务或把缺失
   ID 当成可跳过项。

## 7. 面向其他 Agent 的执行提示词

下发给 Agent 的指令应只包含已审核的 SHA、版本、Agent ID 与上面的一键命令，并
要求回传：

- 命令退出码；
- `summary.json` 的绝对路径；
- `status`、`result`、两个安装版本；
- 四个 PM2 关键进程的状态与执行路径是否存在；
- 双向通信 canary 的每项结果；
- 外部消息往返的唯一标识。
- 每个精确提交组件在 `components.json.source` 与 `.zylos-source.json` 中的完整
  SHA、版本和一致性结果。

Agent 不应重新设计流程。出现 `HOLD` 时，原样返回 `code` 和 `error`，由发布负责人
处理根因后重跑；不要改脚本、换分支、降级门禁或调用旧恢复脚本。
