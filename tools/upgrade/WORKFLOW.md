# Agent 本机升级流程

先按仓库根目录 UPGRADE.md 解析目标并生成独立执行目录，再从这里继续。
所有材料在仓库中取得，Owner 不需要提供 ZIP、台账或额外 prompt。
源码目录和候选台账均为本次准备产物；禁止直接把 NOT_RUN 改成 PASS。
控制工具、源码、台账、registry、证据和补丁备份保存在 runtime 的持久 ops 目录，不能依赖会话临时目录。
若恢复时发现旧控制目录在 scratchpad，先保全到持久路径，按真实对应关系更新外部台账中的本机路径，
重新验证完整 SHA、文件 hash 和门禁；不得只复制目录却继续引用即将消失的旧路径。
先检查已有活动事务，RUNNING 时跟踪原执行单，不重复准备或执行。

## 公开版本资格

prepare 已验证 GitHub Release 的资格 asset、digest、tag 与完整 bundle，并保存在 evidence/published-release.json。
本机 Agent 核验平台、架构、Node 主版本、runtime 及功能配置后生成 environment.json：

```json
{"platform":"linux","arch":"x64","nodeMajor":22,"runtime":"claude","functionalConfigSha256":"<64位SHA256>"}
```

functionalConfigSha256 是与发布者相同规范的功能配置 JSON 的 canonical SHA256，涵盖启用功能及影响
飞书/HXA/task 路由行为的非敏感选项；不包含账号、profile、hostname、凭证或业务消息。
使用 release-channel.mjs 的 canonical/sha256 计算；必须从本机配置读取，不能复制报告指纹冒充一致。
发布者须在发行说明记录该非敏感配置的字段和规范，Agent 自行核对，无需 Owner 填写。
可在 prepare 时传 `--environment /absolute/environment.json`，或准备后执行：

```sh
node qualification.mjs --manifest /absolute/control/governance/release-manifest.json --environment /absolute/environment.json
```

导入匹配资格后自动生成 FLEET reuse plan：版本功能测试为 REUSED，本机 smoke 为 RUN。
它不会将台账改为 READY，也不会把本机身份、dry-run、备份或通信写成 PASS。
部署门重新检查 asset、bundle、环境与 reuse plan；未导入、文件变动或环境不匹配一律停止。
公开版本缺少匹配资格时由发布者补齐，不要求 Owner 重新授权、拷贝旧 PASS 或手填台账。

## 准备

在 actual runtime 下确认以下事实，保存只读证据：

- 当前 Agent、hostname、HXA org/profile ID。用 `cli.js profile-verify --org ... --profile-id ... --hostname ...`
  验证；多组织按已验证的本机部署配置选择，身份矛盾必须停止。根据证据填写本执行目录控制平面的
  employee-runtime-registry.json（employees.<name>.host；identity.profileName、profileId、deploymentOrgLabel、deploymentProfileId）。
- Core/Feishu/HXA 实际版本和完整来源，磁盘、PM2、数据库完整性、队列、技能与关键配置 hash。
  按 UPGRADE.md 检查目标是否会降级。latest 遇到已装较新提交时保持原状；只能选择公开验收覆盖的实际来源组合，
  不得手改公开 bundle 或用旧发布覆盖较新的已装源码。
- 共享 runtime `.zylos/locks` 和活动事务。发现 RUNNING 只跟踪原执行单，不启动第二笔、不杀旧进程。
- HXA 若与固定 repo/version/SHA 完全相同，验证文件来源后记录 reinstall=NOT_APPLICABLE；不用重装。
- 源码测试/版本资格只有 bundle、gateVersion、环境指纹、report/reference hash 都吻合才能复用。
  若另有资格报告，它仅证明报告中对应环境；不能证明当前主机已通过。环境不能证明一致时由发布者补充资格，消费者不得临时充当版本 canary；
  每台主机都必须有新鲜身份/来源/磁盘/队列/dry-run 和真实 host smoke。

旧台账已完成、新版未登记、验证依赖缺失、可修复的工具输出格式，不需要找 Owner 重新授权。
Agent 自行准备或修复后重跑原门禁。不能把缺失证据写成 PASS，也不能从旧台账复制另一机器的 PASS。
单组件准备的 stable 来自 Agent 核验的 installed.json；all 未提供基线时 stable 为空。Agent 自行读取本机升级前的三组件完整来源，
填入本次外部台账的 stable.core/feishu/hxa 并保存来源证据；不是要求 Owner 填表。
无法验证的来源写 UNKNOWN，先做来源恢复取证，不虚构 stable 资格或通过部署门。
登记与已验证源码不一致时先取证，使用支持的锁定/原子更新 API 做可审计修复，不手改源码来迎合版本号。

HXA 非目标版本时使用 pinned Core 的 `scripts/upgrade-hxa-connect.js` 做 check/dry-run/execute，
遵守中央 `deploy --stage hxa` 门。HXA 已完成前置之后再执行 Core/Feishu pair。
运行归档里的 HXA 脚本前，在隔离源码目录用 `npm ci --omit=dev --ignore-scripts --no-audit --no-fund`
准备它的依赖；不要触发 Core 的 postinstall 来修改 runtime。
所有 stage 报告使用中央 gate 规定的 releaseId、executionId、target 和真实原始报告 hash。

原生报告与台账的 ID 字段不同是正常的：HXA 每次调用有自己的 executionId，
pair 原生输出 transactionId。不要覆盖原始 ID 或为统一 ID 重装。用以下绑定器产生新证据文件：

```sh
node governance/bind-report.mjs --manifest /absolute/control/governance/release-manifest.json --raw /absolute/original/summary.json --kind hxa.dryRun --execution-id EXISTING_HXA_PARENT_ID --out /absolute/evidence/hxa-dryrun-bound.json
```

支持 `hxa.dryRun`、`hxa.execute`、`pair.dryRun`、`pair.execute`。
HXA 两阶段使用台账 evidence.hxa.executionId 的同一父 ID；pair 使用对应 evidence 执行 ID。
首次建立父 ID 时生成一次并保存，恢复会话后沿用；原始调用 ID 保留在 rawReport.executionId。
绑定器只接受已成功的对应原生阶段、相同 release（原生提供时）及固定来源，保留原文 hash。
将新文件登记到对应证据 report 字段；gate 会重新核验原件 hash、字段映射和新鲜主机身份。
它不生成 check、provenance 或 canary 的 PASS，不把 dry-run 当 execute，不修改原件。
已完成的人工归一化报告可保留；不为采用新格式重跑安装。

备份清理在执行前一次性列出本机精确来源路径。已有该路径的 Owner 授权则直接继续；没有则只问一次。
不要把“允许升级”扩展为删除业务文件。按设计新建且身份验证通过的 GC_PENDING 是正常隔离保留，
不是失败；不要为了获得“已删除”而手工清空它。未知旧 quarantine 或越界清理仍然阻塞。

### 恢复已有状态后继续原请求

准备阶段遇到可恢复状态时，先完成取证和受支持修复，再重跑原门禁；不要把每份中间 HOLD
当成一次新的授权请求。授权沿用范围和影响不变的原请求，不能凭升级授权取消业务任务或删除备份。

- 已安装 Core 缺少 source marker 时，可以对可信完整提交逐一核对实际随包文件的 Git blob hash，
  保存匹配、缺失和差异清单。仅有 package 版本不能证明来源；npm 排除文件须逐项解释，
  未解释的缺失或差异仍为 UNKNOWN。不得为通过检查伪造 marker。
- 原生任务 gate 报告孤立映射或缺失卡片时，先备份本机状态，使用实际应用身份读取精确远端 GUID。
  通过受支持的 native-task-convergence 计划核对接管关系；变更须在已有明确授权范围内执行。
  取消任务须有覆盖这些精确任务的 Owner 授权，不从“升级”推断。已有授权则不重复询问。
  写入后若验证超时或快照不稳定，先重新只读核验真实状态，不重放取消或接管；重跑完整任务保全门。
- 旧 quarantine 缺少回收凭证时，回收器 HOLD 不等于已确定本次安装失败。先只读取证原事务终态、
  来源签名、路径及 dev/ino 和当前完整清单；来源或状态仍未知则停止部署。
  仅当来源和当前状态已验证、固定升级器明确支持跳过该对象、所有实际部署门均通过且没有未授权
  移动/删除候选时，才可保留原物继续升级。保留原有 GC HOLD/WARN，不补造凭证、不改成 GC_PENDING、
  不添加绕过参数。升级后比较完整清单，分别报告 retained、quarantined、removed。
- HXA org 名是本机配置别名，不能照搬给 trusted peer。依据已验证 org/profile/channel 身份选路，
  对端使用其本机对应别名。通信探针需远端回读；本地 send success 不能替代实际送达。

以上是取证与恢复流程，不放宽任何原生 hard gate。依赖缺失在隔离验证目录中解决；
例如忽略安装脚本导致原生 SQLite binding 缺失，先完成必要依赖构建再重跑失败测试，不能记为 PASS。

## 本机候选放行（无需另找发布人）

prepare 生成的 HOLD / deploymentAllowed=false 表示准备未完成，不表示要等上游 publish。
Owner 明确要求升级已包含本机候选准备及部署授权；publicationAllowed=false 不阻止本机升级。
完成对应阶段真实证据后，运行正式放行入口，不要手改 READY，也不要重复向 Owner 要授权：

```sh
node governance/promote-release.mjs --manifest /absolute/control/governance/release-manifest.json --zylos-dir /absolute/runtime --stage pair
```

HXA 尚需安装时先用 `--stage hxa`；HXA 完成后再用 `--stage pair`。
工具持有共享治理锁，在独立副本上运行完整原部署门及新鲜主机身份检查。
仅全部通过才原子更新本机台账，并保留前后快照与门禁报告；任何失败保留原台账。
它不修改来源、不生成 PASS 证据、不授予上游发布权限、不安装或重启服务。
发现 RUNNING 或已有锁则跟踪原执行单，不能删除锁或重放。
已有控制目录没有此入口时，从已审查的最新 Core 控制工具取得完整 governance 目录，
保留原 manifest、registry 和 evidence；不要重跑 prepare 或重装 HXA 来获取工具。

## 2. 执行（按授权范围）

先核对 `manifest.upgradeScope.components`。只含一个组件时按下面单组件流程；
明确选 all 时才使用后面的 HXA + pair 事务。不得把未选组件填成 latest。
准备程序下载的其他组件只是兼容性验证材料，operatorTools 只是控制工具，不代表部署授权。

### 单组件执行

1. 确认未选组件 candidate 与 stable 的 repo/version/SHA 完全一致；记录本机未选组件
   的源码清单/hash、package 版本、组件注册来源和配置 hash，升级后逐项比较。
   只比较版本号不够；运行日志和消息数据库等业务活动不当作源码变更。
2. 在准备阶段跑 Core/Feishu 组合 dry-run 与兼容性检查，但不运行 pair --execute。
   更新 HXA 时跑 HXA wrapper 的 check/dry-run；不更新 HXA 时验证其本机来源和通信，
   按真实证据记为保持现状，绝不假造 HXA 安装报告。
3. 在独立 operatorTools Core 源码目录用 `npm ci --omit=dev --ignore-scripts --no-audit --no-fund`
   准备 CLI 依赖，不触发 postinstall，不安装到 runtime。
   准备授权、身份、备份、通信及 source 证据，用上述 promote-release 入口将本机台账放行。
   Core/Feishu 单独执行用中央 `deploy --stage pair` 前置门；HXA 用 `deploy --stage hxa`。
   `pair` 是兼容性/前置门名称，不表示获准安装两组件。
4. 使用执行目录内的命令生成器（仅生成，不启动服务操作）：

   ```sh
   node command.mjs --manifest /absolute/control/governance/release-manifest.json --zylos-dir /absolute/runtime
   ```

   HXA 另加 `--report-root /absolute/runtime/.zylos/upgrade-reports/NEW_EXECUTION_DIRECTORY`。
   生成器再次校验固定源码和 scope，运行现有部署门并使用新鲜 HXA 身份；失败不输出执行命令。
5. Agent 在共享事务管理下确认无并发升级，持有本次执行权，建立持久 RUNNING 执行单，
   五分钟内按输出的 command/args/env 在持久后台执行且仅执行一次；保存 PID、stdout 和退出码，
   避免前台会话超时杀掉安装。超过窗口或源码/身份变化时重跑前置。
   保留 stdout、退出码和标准更新器的备份/回滚结果，重启后继续原单；不另起 pair 更新。
   Core 使用原生 --self，Feishu 使用原生 upgrade feishu，HXA 使用已有 upgrade-hxa-connect wrapper。
   Core 单独更新不运行 pair 备份清理器；保留已有备份，不以单组件报告冒充 pair 清理证明。
6. 升级器退出成功仅表示安装完成。按下一节核验实际目标来源、通信、数据和未选组件不变，
   然后运行中央 final 门。单组件记录独立执行报告，未运行的 pairExecute 标记未运行，
   不捏造 coreUpgraded/feishuUpgraded 或全量 pair 成功。最终报告写清 selected、preserved。
   失败只走该原生更新器的受支持回滚；未选组件发生意外变化时停止并报告，不能补装掩盖。

### 全部组件执行（仅 all）

通过 HXA 前置、通信预检查和 pair dry-run 后，生成本次授权报告，用上述 promote-release 入口将本机台账放行；
保存已完成旧事务的快照，持共享治理锁切换，不能覆盖 RUNNING 事务。

```sh
node governance/agent-preflight.mjs inspect
node governance/agent-preflight.mjs deploy --stage pair
```

`deploy --stage pair` 必须在实际目标主机通过。五分钟内重新核验身份/来源。只有门禁通过后
才构造 execute 命令。正式入口从固定 Core SHA 的归档解出的目录启动：

```sh
bash <PINNED_CORE_ARCHIVE>/scripts/upgrade-fork-pair.sh \
  --dry-run --core-sha <bundle.core.sha> --feishu-sha <bundle.feishu.sha> \
  --core-version <bundle.core.version> --feishu-version <bundle.feishu.version> \
  --agent <已验证本机Agent> --report-dir <新的dry-run报告目录>
```

PASS / PRECHECK_ONLY 且其他前置完成后，使用同一固定来源与目标替换为 --execute，
给新的执行目录。不要重用 dry-run 目录。不得裸 npm install -g、git pull 或手工复制 skills 替代。
所有安装默认使用能脱离当前会话超时和 Agent 重启的持久后台执行方式（例如受控 nohup 或服务任务），
不要把安装挂在两分钟等短超时的前台工具调用上。持久保存 executionId、PID、stdout、exit/summary，
恢复后读取同一个 executionId；不要因会话掉线重复启动升级。

## 3. 验收（完成后再汇报成功）

验证实际包版本、完整来源、技能/配置/数据保留、SQLite、PM2 当前与保存配置、登录与 runtime。
完成飞书 user→Agent→reply、HXA trusted peer→Agent→reply，首次版本资格还要交错隔离测试。
缺少飞书 user 凭证时不要冒充用户或用 bot 自发自收替代：集中请 Owner 发一条给定 nonce 的测试消息，
Agent 自动完成链路与回复验收；同一必要输入只请求一次。不要要求 Owner 手工填写报告。

保存 C4、turn/run、外部 message/delivery ID 和终态。仅 PM2 online 或版本输出不等于验收通过。
有适用且验证通过的 FLEET 资格才能省去重复完整版本测试，本机 smoke 仍须新跑。
执行失败时检查事务终态、是否真实回滚以及服务恢复；只走工具支持的恢复入口。

最后运行最终 deploy gate，报告 SUCCESS / ROLLED_BACK / BLOCKED 之一，附三组件 repo/version/
完整 SHA、实际 Agent/host、executionId、证据路径、测试结果与是否发生安装/回滚/删除。
把“已安装但验收未完成”和“未安装”说清楚。未知事实写 UNKNOWN。

升级代码不等于启用新开关。记录升级前后的功能配置；未启用功能不应声称验收通过，
也不要为测试擅自启用它。尤其要区分飞书 CLI 直接创建任务与 WorkIntake→Commitment 的受理链路；
前者成功不能证明后者、任务状态卡或任务评论回调已启用。测试任务明确负责人和验收人，
测试结束关闭，不留下实际待办。

## 对 Owner 的沟通

只在阶段变化或发现实质问题时简短更新。准备中的报告、登记、依赖安装由 Agent 处理，
不逐项抛出 HOLD。身份/来源不明、活动事务不明、无法解决的测试/迁移失败、登录/权限缺失、
没有删除授权等真正需要外部输入时，一次列全：原因、已完成工作、需要 Owner 做的最小动作。
任何需要的真实检查仍未通过时不得 execute。
