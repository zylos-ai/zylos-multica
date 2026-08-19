# AGENTS.md — zylos-multica 工程规范约束

本文件是本仓库对所有参与开发/评审的 agent 的规范约束，与 `docs/project/solution.md`（顶层方案）互补：solution 定架构与验收，本文定日常工程纪律。冲突时以 Howard 的最新裁决为准。

## 1. 定位与硬边界

- 本组件是 **zylos 活会话与 Multica 平台之间的桥**（方向 B，Howard 2026-08-17 拍板）：对 Multica 说 daemon 协议，任务投入 C4 进入持续会话。**不采用官方"daemon 托管冷启动 agent"的执行模型**。
- **不安装、不依赖官方 multica CLI**。官方 CLI 本体是 runtime 托管器（40+ 适配器/worktree 管理等），我们只需要业务操作；直连自托管锁版服务端的 HTTP API，契约以锁定版本的服务端源码为准。
- 组件保持零外部 npm 依赖、几百行量级的简单性。

## 2. 对齐面：官方业务 CLI 命令（Howard 2026-08-19 定案）

我们自建的 CLI 切片（`scripts/`）**按官方 CLI 业务命令的命名与参数语义设计**，做到后续加命令即插即入：

- **业务组（对齐范围）**：`issue`（list/get/create/update/assign/status/comment/label/subscriber…）、`chat`（history/thread）、`attachment`、`project`、`label`、`property`、`agent`/`squad`（查询类）、`workspace`。
- **托管组（永不做）**：`daemon`、`runtime`、`runtime_profile`、`setup`、`plugin`、`skill`、`update`。
- 实现分期：**按实际用到的操作加批**，不求命令面求全。首批（v0.2.0）：quick-create + `issue create/get/list/comment` + `chat history`。

## 3. "瞄 CLI"原则：官方实现是坑解参考库

每实现一条业务命令，**必须先读官方对应的 `cmd_*.go`**（自托管源码 `server/cmd/multica/`），把其中踩坑后的防御性语义抄进我们的实现。已确认的核心安全语义（来自 quick-create 线核实，2026-08-19）：

1. **附件先预校验再建 issue** — 防"半建成功后整条重试 → 双建"。
2. **origin 溯源戳** — quick-create 建 issue 必须带 `origin_type=quick_create` + `origin_id=<task_id>`（对应官方 `MULTICA_QUICK_CREATE_TASK_ID` 环境戳），服务端靠它在并发下确定归属。
3. **失败不盲重试** — 建 issue 等写操作非幂等；失败后禁止自动整条重试（官方 PR#1851 教训）。
4. **外部文件路径隔离** — 凡读文件入参，限制在受控目录内（官方 MUL-4252 跨 run /tmp 脏文件泄漏教训）。

## 4. 版本上报政策

- **组件版本与官方能力对照版本双轨独立**。`package.json` / `SKILL.md` 表示 zylos-multica 自身发布版本；`src/lib/upstream-version.js` 的 `UPSTREAM_VERSION` 表示已实现到官方 Multica CLI 的哪一档业务语义。daemon `cli_version` 与 runtime version 一律使用后者，不得从 package 版本推导。
- 当前官方对照版本 = 0.2.21（quick-create 附件/双建语义）；priority/due 透传档 = 0.4.3。只有完成对应官方业务语义的实现、服务端核对与回归验证后才更新 `UPSTREAM_VERSION`，未实现前不得上报更高档位。

## 5. 升级同步锚点

- 锚点是**自托管服务端升级**，不是官方 CLI 的发布节奏。
- 每次升级自托管服务端：diff 该版本区间内**业务 CLI 命令**的改动（`server/cmd/multica/cmd_*.go`），把语义变更同步进我们的切片；托管组改动忽略。

## 6. 测试规范

- **服务入口冒烟测试必选**：spawn 真实服务入口（含 PM2-like `argv[1]` 边界）断言启动日志出现。单测直调函数不算入口覆盖（issue #3 教训；参见 zylos-component-template#29）。
- **三入口一致性测试必选**：SKILL.md `lifecycle.service.entry`、`ecosystem.config.cjs` `script`、package.json `start` 必须指向同一入口，测试锁死。
- 写操作/对账逻辑须配 known-bad mutant 判别测试（PR#2 惯例：遏制 catch 改 throw 必须打红）。
- 凭证纪律：PAT 不落进程参数、不落日志、错误信息 redact；config 原子写 + 0600。

## 7. 流程

- 开发 = Jinglever，CR = Luna（crew 标准：finding 必须引源码行，证据独立重放）。评审载体走 OpenMax Issue/Blueprint。
- 发版硬门：solution §10 验收通过 + Howard 明确 go。CHANGELOG 在发版 PR 中由 `[Unreleased]` 切版本号。
- 发版 PR 必须同 commit 更新四个文件（zylos-component-template CLAUDE.md "Release Process" 的仓库本地化，v0.3.0 漏执行教训）：①`package.json` bump version；②`package-lock.json` 随后 `npm install` 同步；③`SKILL.md` frontmatter `version` 对齐（core 以此登记与判断升级，漏 bump 导致重复升级提示）；④CHANGELOG 由 `[Unreleased]` 切版。`UPSTREAM_VERSION` 是独立协议能力值，只在对齐新官方契约时才动。
- 卡片中一切 Multica 来源文本必须过 route-marker 消毒（solution §4.4）。
