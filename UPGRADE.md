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

1. 在独立目录取得可信 Core 仓库完整源码，读取 `tools/upgrade/WORKFLOW.md`。
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
   准备程序只下载源码并生成 NOT_RUN 台账，不停止服务、不安装 runtime、不复用旧 PASS。
4. 按输出目录的 WORKFLOW.md 连续完成准备、范围对应的执行及验收。
   单组件使用 `command.mjs` 在现有部署门通过后生成唯一一个原生更新命令；不执行整套 pair 更新。
   全部升级仍用现有 HXA + Core/Feishu pair 事务。
5. 兼容性检查针对“新组件 + 另外两个已装组件”。不兼容时说明需要的最低配套版本，
   不自动更新未授权组件，不宣称单组件升级成功。验收核对未选组件源码、版本及配置没有变化。

只在真正缺权限、登录、必要的人类测试输入或尚未授权删除时集中请求一次。
旧台账、缺报告、依赖准备由 Agent 处理，不要求 Owner 发 ZIP、Markdown 或另一段授权 prompt。

## 版本规则

最新版按可信 fork 的语义版本标签排序；默认 fork 通道包括 RC，`--channel stable` 排除预发布版。
精确版本必须匹配标签和 package.json；带注释标签解析到完整 commit，并验证属于 origin/main。
版本标签只是候选，不是兼容性或部署资格。执行前固定完整 SHA，不在执行中重新解析 latest。
同一版本号可能对应不同提交。已装源码比标签更新时，latest 不得降级：验证后保留较新源码，
同步本次候选及隔离源码再验证。显式旧版本会回退时按降级处理，不扩大一般升级授权。

## 维护

工具只在 Core 维护；Feishu/HXA 的入口指向这里并明确自己的 scope。下载 Core 工具不升级 Core。
用户始终发送同一个仓库链接。升级前后报告范围、版本、完整 SHA、执行单、备份/回滚与验收结果。

候选只有 `HOLD / deploymentAllowed=false` 而真实检查已齐备时，按 WORKFLOW.md 的
`governance/promote-release.mjs` 正式放行；本机升级不需要等待上游 publicationAllowed。
升级授权已包括这一步，Agent 自行完成，不让 Owner 再填台账或选发布角色。
