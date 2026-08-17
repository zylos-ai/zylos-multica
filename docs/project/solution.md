# zylos-multica 组件方案（总方案）

**状态**: DRAFT v1 — 待 Jinglever review · **工程授权**: Howard 2026-08-17 晚（Multica 聊天）
**分工**（Howard 指定）: Luna 出方案+验收标准 → Jinglever 方案 review → Jinglever 开发 → Luna CR+验收
**上游沉淀**: [docs/zylos-multica-bridge]（Luna pages: docs/zylos-multica-bridge）（已验证的桥，本组件将其产品化）

## 1. 背景与问题

zylos-multica-bridge 今天已在 Luna 机器上全链路验证（Web 派活 / 聊天 / due-date 分流 / 三态回报），但它是 ad-hoc 工程：workspace 裸仓库 + 手工 pm2 + 手写 config——**只有 Luna 这一台能用，别的 zylos 实例无法复制安装**。Howard 要求按 zylos-component-template 规范组件化为 `zylos-multica`，让任何 zylos agent 一条 `zylos add` 接入任意 Multica 部署。

## 2. 参考调研（Howard 指定：openclaw / hermes 接入代码）

multica 源码 `pkg/agent/` 有 40+ runtime 适配器，含 `openclaw.go`（spawn `openclaw agent --local --json` 子进程、解析 stdout JSON、版本下限 fail-fast）与 `hermes.go`（ACP JSON-RPC 子进程传输）。**结论：全部是 daemon 侧 spawn-CLI-per-task 的"agent=函数"接入**，与 zylos 已拍板的方向 B（自带常驻桥说 daemon 协议、桥接活会话）架构相反，不可照搬。可借鉴的三个局部模式：

1. **版本下限 fail-fast**（openclaw `minOpenclawVersion`）：启动时断言对端版本并给出可行动的升级提示 → 我们对 Multica 服务端做启动探测（协议钉住 0.4.26，见风险 1）。
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
2. **薄通道**：agent 会话与 Multica 之间仅最小回报面；凭证唯一存放 `config.json`。
3. **不自建重试**：投递失败不 start，留给服务端 recovery 窗口重派。
4. **危险语义显式拒绝**：quick-create 元任务 fail+引导，不投空卡。

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

1. **内部协议漂移**（承袭桥方案）: 版本钉住 0.4.26；启动探测失败 fail-fast（借鉴 openclaw 模式）；Multica 升级列回归清单。
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
- [ ] quick-create → fail + 引导文案（面板可见）
- [ ] report.js progress/fail 实打各一次，面板状态核对
- [ ] 投递失败不 start（构造 c4-receive 不可用）→ 任务留 dispatched
- [ ] pm2 restart → 幂等 re-register，任务不丢
**C. 升级与迁移**:
- [ ] `zylos upgrade` 保全 config.json；post-upgrade 重跑 no-op
- [ ] Luna 机器按 §8 迁移完成，旧桥退役，面板无感
**D. 评审流程**: Jinglever 开发 PR → Luna CR（引用 crew 标准: finding 须引源码行）→ 合并 → 验收 → TG 向 Howard 交付带证据

## 11. 开放问题（附 Luna 预判，review 时一并表态）

1. **send.js 收到 `[MEDIA:...]` 前缀怎么办**（communication 契约含媒体）: 预判 v0.1.0 明确拒绝（Multica complete 是纯文本 output），错误文案引导改发文字；媒体支持连同附件拉取进 backlog。
2. **心跳与 claim 合并轮询间隔默认值**: 预判沿用 15s（今天实测响应体感良好，聊天延迟可接受）。
3. **runtime 显示名默认值**: 预判 `{agent 名} (zylos)`，从 config 读，configure 收集。

---

*方向 B、分流规则、daemon 协议面为桥方案已拍板前提，不在本方案重议。*
