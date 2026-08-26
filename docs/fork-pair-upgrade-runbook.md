# Zylos Core + Feishu fork 升级手册

本文定义受管 Agent 从 `HeXiaobo/zylos-core` 与
`HeXiaobo/zylos-feishu` 升级的唯一标准流程。目标是把版本选择、升级顺序、
通信连续性和验收证据固化为脚本，让执行 Agent 只负责提供已审核的不可变
提交，不再临场拼接命令或手工覆盖文件。

## 1. 适用边界与发布结论

- Core 与 Feishu 必须作为一组审核，但按 **Core → Feishu** 顺序升级。
- Core fork 是必需的：固定编排器、双向 C4 门禁、关键通信文件门禁和 PM2
  真在线校验都属于 Core 升级基础设施。
- 当前 Feishu 目标不需要为本流程再改代码；使用已经通过测试的
  `0.3.7-rc.5` 提交 `b1da95bc91663be6e63d9651c7fede7fb66f6301`。
- `upstream` 只用于读取和同步；发布只允许推送到 `origin` 对应的
  `HeXiaobo/*` fork。
- 只有结构化报告为 `status: "PASS"` 且外部消息往返验收成功，才可宣告升级
  完成。任何中间状态均为 `HOLD`。

## 2. 今天暴露的问题

### 2.1 主故障：收消息入口在同步中被删除

2026-08-27 16:49–16:54，Skills 同步删除了
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

### 2.6 严格 stdin 策略与旧 canary 的契约冲突

旧连续性门禁会强制测试 legacy argv，而运行时可能显式设置
`C4_STRICT_STDIN_ONLY=1`。这会把正确的安全策略误判成故障。新 canary 按实际
策略验证：兼容模式要求 argv 可用；严格模式要求 stdin 和 body-file 可用，并
要求 argv 精确拒绝且没有发生投递。

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
3. Core 目标包含四个关键通信入口以及本手册的一键编排器。
4. Feishu 目标通过 native task 评论闭环与完成闭环的测试套件。
5. 不从 `upstream` 直接部署，也不向 `upstream` 推送。

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

## 4. Agent 唯一执行命令

把已经审核并推送的 Core SHA 填入 `CORE_SHA`，不要使用分支名、短 SHA、`main`
或 `latest`。整条命令一次执行，不拆成手工步骤：

```bash
CORE_SHA='<40-hex-core-sha>'
FEISHU_SHA='b1da95bc91663be6e63d9651c7fede7fb66f6301'

curl -fsSL \
  "https://raw.githubusercontent.com/HeXiaobo/zylos-core/${CORE_SHA}/scripts/upgrade-fork-pair.sh" \
  | bash -s -- \
      --core-sha "${CORE_SHA}" \
      --feishu-sha "${FEISHU_SHA}" \
      --core-version '0.7.2-rc.5' \
      --feishu-version '0.3.7-rc.5' \
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

随后脚本按固定顺序升级 Core 和 Feishu，并执行：

- 安装版本与目标版本复核；
- 四个关键通信入口复核；
- PM2 真在线复核，包括 response stream supervisor；
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

脚本 PASS 后，升级负责人必须完成两层外部验收：

1. 由任务负责人向 Agent 发送带唯一标识的飞书消息；Agent 必须回复同一标识。
   同时确认 `c4.db` 有对应入站记录，PM2 restart/unstable 计数没有异常增长。
2. 若本次发布启用飞书原生任务能力，使用预先准备、包含明确 task/comment/member
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

Agent 不应重新设计流程。出现 `HOLD` 时，原样返回 `code` 和 `error`，由发布负责人
处理根因后重跑；不要改脚本、换分支、降级门禁或调用旧恢复脚本。
