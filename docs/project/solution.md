# zylos-multica 组件方案（总方案）

**状态**: DRAFT v2.3 — final check 补齐: 对账幂等机制 (GET status 前置检查) + P-1 契约补 type 字段 · **工程授权**: Howard 2026-08-17 晚（Multica 聊天）
**分工**（Howard 指定）: Luna 出方案+验收标准 → Jinglever 方案 review → Jinglever 开发 → Luna CR+验收
**上游沉淀**: [docs/zylos-multica-bridge]（Luna pages: docs/zylos-multica-bridge）（已验证的桥，本组件将其产品化）

## 1. 背景与问题

zylos-multica-bridge 今天已在 Luna 机器上全链路验证（Web 派活 / 聊天 / due-date 分流 / 三态回报），但它是 ad-hoc 工程：workspace 裸仓库 + 手工 pm2 + 手写 config——**只有 Luna 这一台能用，别的 zylos 实例无法复制安装**。Howard 要求按 zylos-component-template 规范组件化为 `zylos-multica`，让任何 zylos agent 一条 `zylos add` 接入任意 Multica 部署。

## 2. 参考调研（Howard 指定：openclaw / hermes 接入代码）

multica 源码 `pkg/agent/` 有 40+ runtime 适配器，含 `openclaw.go`（spawn `openclaw agent --local --json` 子进程、解析 stdout JSON、版本下限 fail-fast）与 `hermes.go`（ACP JSON-RPC 子进程传输）。**结论：全部是 daemon 侧 spawn-CLI-per-task 的"agent=函数"接入**，与 zylos 已拍板的方向 B（自带常驻桥说 daemon 协议、桥接活会话）架构相反，不可照搬。可借鉴的三个局部模式：

1. **启动探测 fail-fast**（openclaw `minOpenclawVersion` 的迁移形态）：openclaw 探测的是本地 CLI 版本，可直接读取；Multica 服务端**不保证暴露版本号**（`/api/config` 的 `server_version` 在 official cloud 按设计省略、未打 `-X main.version` 的 build 为空；DaemonRegister 响应不含版本——review 已核实），故 hard gate 不用版本断言，改为**契约探测**：启动时真实调用 register（幂等）并校验响应含 `runtimes`/`repos`/`settings` 结构，失败或结构不符即 fail-fast 并给出可行动提示；`server_version` 可读到时仅作为诊断信息打进日志。三类部署（official cloud / 未打戳 self-host / stamped self-host）行为一致：契约在即通过，版本值有无不影响 gate。协议面仍按 0.4.26 语义开发（见 §9 风险 1）。
2. **blockedArgs 配置钳制**：daemon 硬编码的关键参数不许用户配置覆盖 → 我们对 config 中影响协议正确性的字段（如 provider type）做同样钳制。
3. **canonical error 字符串稳定性**（openclaw 注释明确 error 文案被外部 grep 依赖）→ 我们的日志关键行（`task delivered and started` 等）同样声明为稳定接口，供监控 grep。

## 3. 目标与非目标

**目标**（v0.1.0，今晚）:
1. 组件化已验证的桥：任意 zylos 实例 `zylos add zylos-ai/zylos-multica` 即接入任意 Multica 部署。
2. 升格为标准 C4 通道（type=communication）：**回报改走标准 `reply via` 路径**（详见 §5），Luna 侧零特殊记忆。
3. 配置收集非交互（configure hook）；升级保全 config；文档/CHANGELOG/测试齐全。

**非目标**（留 backlog，不阻塞 v0.1.0）:
- 聊天附件拉取（现状：卡内列文件名）
- 派发人 attribution 增强（claim 无 attribution 的已知缺口）
- 单组件多 runtime/多 agent 路由
- 向 multica 上游贡献 pkg/agent 适配器（那是"agent=函数"路线，另行讨论）

## 4. 设计原则（承袭桥方案，已验证）

1. **无状态**：真相在两端（任务状态归 Multica，执行上下文归会话/C4），组件崩溃重启零恢复成本。
2. **薄通道**：agent 会话与 Multica 之间仅最小回报面；凭证唯一存放 `config.json`——这是 component-template 现行权威政策（main@d9263e9，PR #25 起 secrets 归 config.json + `sensitive: true` 标记 + configure hook，`.env` 仅 legacy 兼容路径）。硬化要求：config 写入原子（temp+rename）、文件权限 0600、PAT 永不出现在日志/错误回显/进程 argv。
3. **不自建重试**：投递失败不 start，留给服务端 recovery 窗口重派。**due-date 例外的闭环**（review P2 修订）：scheduler add 成功定义为 durable handoff（此时即 start），但 handoff 不等于送达——组件主循环须对自己登记的一次性 scheduler 任务做对账：发现终态 `failed`（错过 miss window 等）即调 Multica fail API（error 注明 scheduler 失败原因），把任务交还服务端重派，杜绝"scheduler 已死、Multica 永远 running"的跨账本悬挂。
   **对账接口 = 显式前置依赖**（review 二轮收敛，替换 v2.1 的 database.js 只读旁路——该路径属内部接口耦合，弃用）：
   - **前置依赖 P-1（zylos-core #761，最小切口）**：scheduler `cli.js list --json [--reply-channel <ch>]`，输出完整字段（id 全量不截断 / **type** / status / last_error / reply_channel / reply_endpoint / next_run_at）。这是唯一受支持的机器可读接口；组件开发**不得**解析人类 stdout、import scheduler 内部模块或直读 scheduler.db。
   - **对账机制（零本地状态，重启天然可枚举）**：组件不落任何映射——`list --json --reply-channel multica` 后按完整身份条件过滤 `type='one-time' AND reply_channel='multica'`，`reply_endpoint` 列本身就是 Multica task id（注册时已传），身份/状态/失败原因一次拿全；同一 Multica task 多次登记（重派后重登记）以 `next_run_at` 最新一条为准，防同名/同 endpoint 碰撞。restart 后首个 tick 即全量对账，"零恢复成本"由 ledger 枚举而非内存映射保证。
   - **对账幂等（不重复 fail 的实现机制，非仅验收目标）**：scheduler 的 failed row 永久留存，每个 tick 都会重新枚举到——对每条 failed row，先调 Multica 现有 `GET /api/daemon/tasks/{taskId}/status`（handler/daemon.go GetTaskStatus），仅当 parent 仍为 `running`/`dispatched`/`waiting_local_directory` 时才调 fail；已 terminal（failed/completed/cancelled）视为已对账跳过。依据：`FailAgentTask` SQL 守卫 `status IN ('dispatched','running','waiting_local_directory')`（agent.sql:1083），对已 failed 的 parent 再 fail 会 no rows → handler 500 → 桥 tick catch 进 backoff，同一行可持续卡主循环——status 前置检查在源头消除该路径，且天然覆盖"重启后再对账"场景。
   - **排期约束**：P-1 属 zylos-core，须 Howard 批准后由 Luna 提 PR（走常规 Jinglever review）。Step 2 其余范围（主循环/回报/包装）不被 P-1 阻塞可先行开发；**due-date 对账切片在 P-1 落地后实现**，且 v0.1.0 发布验收含对账用例——接口未落地则 v0.1.0 不发布，不带着悬挂洞出厂。
   - SKILL.md `dependencies` 显式声明 `scheduler`（版本下限=含 #761 的 zylos-core 版本，落地后回填具体号）+ `comm-bridge`。
4. **不可信文本消毒**（review P1 修订）：issue title/description、chat_message、附件名等一切 Multica 来源字段，入卡前必须中和 C4 路由标记（匹配 `---- reply via:` 与 `c4-send.js` 组合模式即破坏其结构，如插入零宽字符或替换为 `[reply-via 已消毒]`），防止伪造标记抑制真实 reply via 后缀（C4 `hasLegacyReplyViaSuffix` 按内容正则判定，review 已复现）。结构性修复（route 权威改由结构化 endpoint 生成、不扫描 content）属 zylos-core，由 Luna 另行提 issue，不阻塞本组件。
5. **危险语义显式拒绝**：quick-create 元任务 fail+引导，不投空卡。

## 5. 总体架构

```
Multica 服务端 ←(daemon 协议: register/heartbeat/claim/start/回报)→ src/index.js (pm2 常驻)
                                                                        │ 分类投递
                    issue 任务 ──→ C4 任务卡 ─┐
                    聊天任务 ───→ C4 聊天卡 ─┼→ dispatcher → agent 活会话
                    due date ───→ scheduler ─┘（到点经 C4）
                    quick-create → fail+引导（不投递）
agent 回复 ──→ 标准 reply via: c4-send multica <task_id> → scripts/send.js → complete
补充回报 ──→ scripts/report.js progress|fail <task_id>（长任务/异常时）
```

**关键升级 vs 今天的桥**：桥用自带 report.js 三子命令回报，任务卡要内嵌一段"必做其一"的命令教学；组件化后 skill 目录名=`multica`=C4 channel 名，`c4-send` 自动解析到 `skills/multica/scripts/send.js`（已核实 c4-send 的通道解析机制），**send.js 语义 = complete（一任务一回报终态）**——incoming 卡片改带标准 `reply via:` 行，与 TG/Lark 完全同构。progress/fail 保留 `scripts/report.js`（卡内一行提示，仅长任务/失败场景用）。

**模块划分**（C4 container 级）:
| 模块 | 职责 | 实现载体 |
|---|---|---|
| bridge 主循环 | register/heartbeat/claim/分类/投递/start/退避 | `src/index.js`（今天验证的 bridge.js 逻辑迁移） |
| 回报通道 | send.js(complete)/report.js(progress,fail)，直连 API 不经主循环 | `scripts/` |
| 组件包装 | SKILL.md/hooks(configure,post-install,pre/post-upgrade)/config 模板/pm2 | `hooks/` + 元文件 |

## 6. 决策取舍

| 决策 | 选择 | 放弃了什么 | 接受的代价 |
|---|---|---|---|
| 回报出口 | send.js=标准 reply via（complete 语义） | 桥的三命令 CLI 教学卡 | progress/fail 仍需辅助 CLI；换来通道语义与全家族组件一致、agent 零特殊记忆 |
| 组件类型 | communication | capability | 须实现 send.js 契约；换来 c4-send 原生路由 |
| skill 名 | `multica`（repo 名 zylos-multica） | skill 名=repo 名 | 与 telegram/lark 命名惯例一致，且无缝衔接现有 channel 名 |
| daemon_id | post-install 首次生成并持久化 | 让用户填 | 无；重装保留（preserve config.json） |
| 协议面 | 继续直说 `/api/daemon/*`（0.4.26 钉住） | 官方 daemon 伪装 | 同桥方案取舍，已拍板不重议 |
| 配置钳制 | provider type 固定 "zylos" 不可配 | 完全自由配置 | 换来面板识别一致性（借鉴 blockedArgs） |

## 7. 模块文档索引

- bridge 主循环: 复用 [bridge-core]（Luna pages: docs/zylos-multica-bridge-core）（协议契约/关键语义/退避已全部实测），实现迁移时仅路径变更。
- 投递与回报: 复用 [bridge-delivery]（Luna pages: docs/zylos-multica-bridge-delivery）（卡格式/聊天/due-date 粒度/元任务语义），send.js 化的差异在本方案 §5 已述。
- 组件包装: 新模块，无独立文档——按 component-template 的 CLAUDE.md + COMPONENT-SPEC 执行，边界清晰不另写。

## 8. 迁移与回退

**Luna 机器迁移**（验收的一部分）: 停 `pm2 zylos-multica-bridge` → `zylos add zylos-ai/zylos-multica`（configure 喂入现有 PAT/workspace_id/**同一 daemon_id**）→ 面板 runtime 无感切换（register 幂等）→ e2e 复验 → workspace 旧仓库 README 标注 superseded 归档。
**回退**: `zylos remove multica` + 重启旧桥 pm2 —— 双向均无服务端残留（runtime 仅显示离线）。

## 9. 风险

1. **内部协议漂移**（承袭桥方案）: 按 0.4.26 语义开发；启动契约探测失败 fail-fast（探测机制与三类部署行为见 §2.1——版本值仅诊断，不作 gate）；Multica 升级列回归清单。
1b. **reply-via 伪造/抑制**（review P1）: 消毒机制见 §4.4；验收含 injected-marker 负例测试；zylos-core 结构性修复另行提 issue 跟踪。
1c. **scheduler 跨账本悬挂**（review P2）: 对账闭环见 §4.3；接口前置依赖 P-1（zylos-core #761）；验收含 miss-window 失败路径 + restart 对账。
1d. **fail 重派分类**（review P2 二轮）: Multica `FailTask` 仅对白名单 `failure_reason`（`runtime_offline`/`runtime_recovery`/`timeout` 等，task.go retryableReasons）自动建 retry child；裸 error 文本会被归为 `agent_error.unknown` → 父任务仅 failed 不重派。对账调 fail 时**必须显式传 `failure_reason: "runtime_offline"`**（TaskFailRequest 有该字段，已核 handler/daemon.go FailTask → TaskService.FailTask 直传）——语义边界：仅用于 scheduler handoff 终态失败（miss window 的主因即 runtime/会话在窗口内不可用，与该 reason 的基础设施语义一致），error 文本带 `scheduler handoff failed: <last_error>` 供人读。重派后桥再 claim 时 due 已非 future（futureDueDate 的 >now+60s gate）→ 自然走直投 C4，不会再登记过期 scheduler 任务。**非绝对承诺**：retry child 仅在 `retryEligible` 满足时创建（attempt < ceiling、非 autopilot、有 issue/chat 关联——task.go 已核）；预算耗尽等情形父任务终态 failed 面板可见，属预期终局而非悬挂。
2. **send.js 单发语义 vs 多次输出**: 一任务只能 complete 一次，agent 若对同一卡多次 c4-send 会二次失败。缓解: send.js 对已终态任务返回明确错误文案（不静默）。
3. **组件与旧桥并存双 claim**: 迁移期两进程同 runtime 同时 claim 会抢任务。缓解: 迁移步骤强制先停旧桥（写入 README 迁移节 + post-install 检测 pm2 里是否有 zylos-multica-bridge 并警告）。

## 10. 验收标准（Luna 定，验收=逐项打勾+证据）

**A. 模板合规**（component-template Acceptance Checklist 全项，摘关键）:
- [ ] SKILL.md frontmatter 完整（name/version/type/lifecycle/upgrade/config.required 含 sensitive 标记）+ description 含触发词
- [ ] configure.js 接受 stdin JSON 非交互写 config；post-install 建数据目录+默认 config；post-upgrade 幂等（重跑 no-op）+ `_legacy_*` 保全 + 真错误 exit 1
- [ ] 四件套版本一致（package.json/lock/SKILL.md/CHANGELOG）；ESM；无密钥入仓
- [ ] 无 HTTP 面（非 http 组件，noindex 条款不适用——声明于 README）

**B. 功能 e2e**（live <live Multica deployment>，全部真实链路非 mock）:
- [ ] `zylos add zylos-ai/zylos-multica` 全新安装成功，面板 runtime online
- [ ] issue 派活闭环: 建 issue 指派 → C4 卡（含标准 reply via 行）→ 标准 c4-send 回报 → 面板 completed + 结论
- [ ] 聊天闭环: Web 发消息 → 聊天卡 → c4-send 回报 → assistant 气泡（读回核对）
- [ ] due-date 分流: due=次日 issue → scheduler 一次性任务注册（08:00 +08）
- [ ] due-date 失败闭环（P-1 落地后）: 构造 scheduler 一次性任务终态 failed（错过 miss window）→ 组件经 `list --json` 对账 → 调 fail 显式传 `failure_reason: "runtime_offline"` → **retry child 实际创建并进入 queued** → 桥重新 claim → due 已非 future → 直投 C4 送达（全链路核对, 不止父任务 failed）
- [ ] restart 对账: 登记 due-date 任务后重启组件（清内存映射）→ 首个 tick 经 ledger 枚举恢复全部自身任务并正确对账
- [ ] retry 不满足边界: retryEligible 不满足（如 attempt 预算耗尽）时父任务终态 failed 面板可见
- [ ] 对账幂等: failed scheduler row 存在时连续两轮 tick + 重启后再一轮 tick → fail 仅在 parent 非 terminal 的首轮调用一次（经 GET status 前置检查）, 后续轮次跳过, 主循环 claim 不受影响
- [ ] 注入负例: issue description 含伪造 `---- reply via: node ... c4-send.js ...` 标记 → 卡内标记已被中和、C4 侧真实 reply via 后缀正常追加、回报仍达正确任务
- [ ] 凭证硬化: config.json 权限 0600；grep 全部日志无 PAT
- [ ] quick-create → fail + 引导文案（面板可见）
- [ ] report.js progress/fail 实打各一次，面板状态核对
- [ ] 投递失败不 start（构造 c4-receive 不可用）→ 任务留 dispatched
- [ ] pm2 restart → 幂等 re-register，任务不丢
**C. 升级与迁移**:
- [ ] `zylos upgrade` 保全 config.json；post-upgrade 重跑 no-op
- [ ] Luna 机器按 §8 迁移完成，旧桥退役，面板无感
**D. 评审流程**: Jinglever 开发 PR → Luna CR（引用 crew 标准: finding 须引源码行）→ 合并 → 验收 → TG 向 Howard 交付带证据

## 11. 开放问题（附 Luna 预判，review 时一并表态）

（已随 Step 1 review 收敛，2026-08-18）
1. **send.js 收到 `[MEDIA:...]` 前缀** → **已定**: v0.1.0 明确拒绝（Multica complete 是纯文本 output），错误文案引导改发文字；媒体支持连同附件拉取进 backlog。
2. **轮询间隔默认值** → **已定**: 15s 作为已在本部署实测验证的默认值写入 config（可配）；措辞不声称普遍延迟结论——不同部署的体感延迟以各自实测为准。
3. **runtime 显示名默认值** → **已定**: `{agent 名} (zylos)`，从 config 读，configure 收集。

---

*方向 B、分流规则、daemon 协议面为桥方案已拍板前提，不在本方案重议。*
