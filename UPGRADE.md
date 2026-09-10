# 升级 Zylos fork：一个链接即可

给本机 Agent 一句话即可：

- “只升级 Core 到最新版：https://github.com/HeXiaobo/zylos-core”
- “只升级 Feishu 到 0.3.7-rc.20：https://github.com/HeXiaobo/zylos-feishu”
- “只升级 HXA 到最新版：https://github.com/HeXiaobo/zylos-hxa-connect”
- “把 Zylos 三件套全部升级到最新版：https://github.com/HeXiaobo/zylos-core”

三个仓库都提供 UPGRADE.md。只说“升级这个仓库”时仅选择该仓库组件；只有明确要求全部时选择 all。
Core 工具默认只选 Core，不再默认升级三个组件。指定一个版本仅作用于选定组件，不猜测其他组件版本。

## Agent 执行约定

Owner 的明确升级请求授权本次目标解析、准备、正常停服、备份、部署、通信验收及受支持回滚。
链接本身不是部署授权。只处理自己的 runtime，保留账号、模型、配置、技能和业务数据。
先读本机 AGENTS.md；已有 RUNNING 事务则跟踪原单，不重复启动。

1. 在 runtime 的持久工作目录下取得可信 Core 仓库完整源码（例如 `~/zylos/workspace/ops/upgrade-<id>/operator`），
   读取 `tools/upgrade/WORKFLOW.md`。控制目录、`--out`、源码和证据都不得放在会话 scratchpad 或自动清理的 `/tmp`。
   这是执行工具源码，不代表安装或升级 Core。记录工具完整 SHA，保持源码干净；不要在生产目录 git pull。
2. Agent 自行核验本机三个组件的 repo、package version 和完整 SHA，写成本机 `installed.json`。
   格式为 `{ "core": { "repo": "HeXiaobo/zylos-core", "version": "…", "sha": "40位提交" },
   "feishu": { "repo": "HeXiaobo/zylos-feishu", "version": "…", "sha": "40位提交" },
   "hxa": { "repo": "HeXiaobo/zylos-hxa-connect", "packageVersion": "…", "sha": "40位提交" } }`。
   不让 Owner 写这个文件，不用用户名或版本字符串推断 SHA。缺少来源时先自行取证。
3. 按请求选择一个 scope，Agent 自行填写路径和消息引用：

   ```sh
   node tools/upgrade/prepare.mjs --only feishu --feishu latest --installed /absolute/installed.json --out /absolute/new/control-directory --authorization-ref OWNER_MESSAGE_ID
   ```

   Core 用 `--only core --core VERSION`；HXA 用 `--only hxa --hxa VERSION`；三件套用 `--only all`。
   `VERSION` 可为 latest 或精确版本。未选组件保持已装完整 SHA，不重新解析最新版。
   准备程序从公开验收目录固定来源，生成本机 NOT_RUN 台账；匹配的版本资格可导入，本机检查仍须新跑。
4. 按输出目录的 WORKFLOW.md 连续完成准备、范围对应的执行及验收。
   单组件使用 `command.mjs` 在现有部署门通过后生成唯一一个原生更新命令；不执行整套 pair 更新。
   全部升级仍用现有 HXA + Core/Feishu pair 事务。
5. 兼容性检查针对“新组件 + 另外两个已装组件”。不兼容时说明需要的最低配套版本，
   不自动更新未授权组件，不宣称单组件升级成功。验收核对未选组件源码、版本及配置没有变化。

只在真正缺权限、登录、必要的人类测试输入或尚未授权删除时集中请求一次。
旧台账、缺报告、依赖准备由 Agent 处理，不要求 Owner 发 ZIP、Markdown 或另一段授权 prompt。

## 版本规则

“最新版”默认指公开目录中已验收的 stable 版本；RC 需明确 `--channel preview` 或精确 RC 版本。
三个 fork 共用 Core GitHub Release 的 `zylos-release.json`：它绑定三组件 repo、package version、
完整 SHA、验收环境与证据 hash。普通标签、草稿、失败验收或缺少此文件的发布不会进入升级通道。
精确版本也必须已有验收资格。网络、下载或资格校验失败会停止，不回退到 main。
版本号不是身份：同一个组件版本可能出现在更新的 bundle 上（例如只改了代码、没有升版本号）。
此时解析到**最近发布**的那个 bundle，并在准备输出里列出同名版本的其它提交。

单组件只选择与已装另外两组件完整来源共同通过验收的组合；all 选择一个完整组合。
已装版本更高或同版本来源更新/分叉时保持原状，不覆盖较新源码，也不把未经验收的新组合写进候选。
首次安装可用仓库 `scripts/install.sh`；已有员工 runtime 继续走这里的 Agent 流程。

发布者在发布前完成版本验收并附上凭证，见 [发布流程](tools/upgrade/PUBLISH.md)。
消费者导入凭证后只执行本机身份、备份、来源、兼容性、数据及通信 smoke；
Owner 不需要填写发布台账，也不需要重复为同一个版本做完整版本验收。
本机环境描述符是必需步骤，不是可选保险：平台、架构、Node 大版本与 runtime 命中公开资格只说明矩阵覆盖了本机；
部署门另外要求「已导入发布方资格」，而资格按本机环境指纹匹配。所以先运行一次仓库自带的权威探针，
把探针输出的结果文件直接作为 `--environment` 传入（发布说明里可能嵌着更早的描述符版本，只以仓库这份为准；
漏传会被部署门拒绝，`prepare.mjs` 现在会在准备阶段直接报错并给出这条命令）：

```sh
# 探针从当前这份 Core 源码里取，输出的结果文件可直接作为 --environment。
# --runtime 填本机真实 runtime（claude 或 codex）：探针不会拿它跟主机核对，
# 而 runtime 参与环境指纹，填错会得到一个匹配不上任何已发布资格的描述符，
# 静默落到完整本机 canary 路径。
node tools/upgrade/functional-config-probe.mjs \
  --zylos-dir "$ZYLOS_DIR" --core-source "$CORE_SOURCE" --feishu-source "$FEISHU_SOURCE" \
  --hxa-source "$HXA_SOURCE" --runtime "$RUNTIME" --out /absolute/probe-result.json

node tools/upgrade/prepare.mjs --only core --core latest --installed /absolute/installed.json \
  --environment /absolute/probe-result.json \
  --out /absolute/new/control-directory --authorization-ref OWNER_MESSAGE_ID
```

指纹命中公开资格时这条就是常规路径：导入发布方资格，版本功能测试记为 `REUSED`，
本机身份、备份、来源、兼容性、数据与通信 smoke 仍须新跑。

当前环境或来源组合未覆盖时，先看公开资格矩阵里是不是已经覆盖；没有覆盖也不要伪造指纹、
不要让 Owner 补授权、更不要回退到 main。同一份描述符再加 `--environment-policy newest-qualified`：

```sh
node tools/upgrade/prepare.mjs --only core --core latest --installed /absolute/installed.json \
  --environment /absolute/probe-result.json --environment-policy newest-qualified \
  --out /absolute/new/control-directory --authorization-ref OWNER_MESSAGE_ID
```

来源仍然是已验收 bundle，但发布方的功能验收不可复用：本机必须完整跑身份、备份、来源、
dry-run 与 canary，`deploy --stage final` 才会通过。`prepare.mjs` 的返回值里
`environmentVerified` 为 `false` 时即为此路径。反过来，只要某个环境已经被发布方验收，
就不要用这个开关绕过矩阵。

## 维护

工具只在 Core 维护；Feishu/HXA 的入口指向这里并明确自己的 scope。下载 Core 工具不升级 Core。
用户始终发送同一个仓库链接。升级前后报告范围、版本、完整 SHA、执行单、备份/回滚与验收结果。

候选只有 `HOLD / deploymentAllowed=false` 而真实检查已齐备时，按 WORKFLOW.md 的
`governance/promote-release.mjs` 正式放行；本机升级不需要等待上游 publicationAllowed。
升级授权已包括这一步，Agent 自行完成，不让 Owner 再填台账或选发布角色。

历史任务映射、缺少安装来源标记或旧隔离目录等情况，先按 WORKFLOW.md 的
“恢复已有状态后继续原请求”取证处理。已经授权的修复完成后连续升级，不在正常步骤重复确认；
任务取消和备份删除仍须各自覆盖精确对象的授权。直接升级是由 Agent 完成必要检查和恢复，
不是跳过门禁或保证任何历史状态都能无人干预。
