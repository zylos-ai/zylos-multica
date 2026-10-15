# #30：v0.6.2 执行能力实施计划

状态：首轮 review 已认可四项方向、目录/分支隔离及最小本地状态。附件/评论反馈独立实施中；恢复/worktree 主体契约第二轮 review 已通过，按下面收口规则实施。尚未进行真实平台验收。

基线：组件 v0.3.4 / `21ce159`；官方服务端 v0.6.2 / `7ab92d7622ecd81d179a8d83ae2dea74835a5069`。本轮覆盖任务闭环与恢复、附件与项目上下文、评论触发反馈、worktree 四项，不包含发布部署授权。

## 结论与需要审定的边界

worktree 与“daemon 协议 → C4 → Zylos 活会话”可以兼容，不需要启动官方 daemon 托管的冷会话。已经在隔离仓库用同一个活会话的真实工具调用完成两工作目录并行修改：A/B 修改同名文件但内容互不串扰，原目录保持 baseline；新进程从绑定记录重新定位两目录，未提交修改和未跟踪产物均保留。这个探针只证明文件系统和显式工具 cwd 的可行性，不是 Multica 领取、恢复和平台展示的端到端验收。

当前 C4 接口只交付内容和回复目标，不会为任务切换工具 cwd。建议组件为每个任务准备并持久化目录绑定，执行入口按 task ID 解析 cwd，每次操作显式使用该目录；读取/编辑工具使用绑定内的绝对路径。不得修改整个活会话的全局 cwd。任务卡仅指出绑定位置并按需引用 skill。

**已认可的架构边界：采用上述“任务目录绑定 + 受控执行入口”，不承诺权限沙箱。** 它能隔离正常任务工作，但不能阻止 Agent 绕过入口或向任意绝对路径写文件。如果要求所有原生工具都被强制约束到任务目录，必须增加运行时/核心工具层的任务上下文能力，单靠组件和卡片不能做到。此边界已在 #30 首轮 review 认可，不能把“目录存在”或能力标记当成完成。

另一个变化是：旧方案 §4 的绝对“无状态、重启零恢复成本”不再适用于任务目录绑定。首轮 review 已认可组件保存最小本地执行元数据（任务身份、资源、目录、分支、基线、产物/待确认回传），平台仍是任务终态的真相来源。不是再建一套任务调度系统。

## 代码核对结果

- `src/index.js:308–380`：C4 接收成功后才调用 start；投递成功到 start 确认之间存在中断窗口。当前没有向 C4 传入任务幂等键。实际重投行为须做故障实验，不能只靠调用顺序推断已经解决。
- `scripts/send.js`、`scripts/report.js`、`src/lib/multica-api.js`：最终回传是一次 POST；响应丢失时无法区分未提交和已提交。本地 token 在成功确认后删除。C4 出站审计本身不能证明 Multica 已收到。
- `src/index.js:185–225`：已有恢复仅对 scheduler 失败登记对账；不等于普通任务及活会话重启恢复都已覆盖。
- `src/lib/cards.js`：聊天附件仅列文件名；执行侧尚未消费完整项目资源和 skills。
- 官方 `server/internal/handler/daemon.go:3583–3712`：本机 local_directory 的 worktree 模式在 claim 阶段受 `local-worktree-v1` 能力门控制；未知模式不能回退到原目录执行。
- 官方 `server/internal/daemon/local_directory.go`、`execenv/local_worktree.go`：需要处理 daemon 身份、真实路径、子目录偏移、用户脏改动快照、同一工作线后续任务、分支归属和未交付内容保护。不能用一个裸 `git worktree add` 替代这些语义。
- 官方 `daemon.go:4230–4241`：完成报告有 `work_dir`、`branch_name`、`durable_work_dir`；仅在临时目录确实清理后才可把位置改报为持久目录。

## 实施拆分

| 切片 | 修改及结果 | 前置/验收 |
|---|---|---|
| 1. 闭环基线与恢复 | 建立隔离真实 chat/issue/评论追问用例；回传失败先读平台状态和结果，区分确认成功、其他终态、仍未知；只重试可证明安全的回报，不重跑业务执行。对 C4 接收/start 中断点做故障实验后确定去重方案。 | 不依赖 worktree；如需 C4 幂等接收 API，独立提出核心改动，禁止直写其数据库。 |
| 2. 附件与项目上下文 | 保存任务作用域的附件/资源/skills 清单；补充读取 CLI 和明确错误，卡片只给可使用的路径及上下文索引；内容仍按外部数据处理。 | 与 1 可独立开发；按官方对应业务 CLI 与 claim 契约对齐。 |
| 3. 评论触发反馈 | 保留原始 `trigger_outcomes`，给出评论保存与每个目标触发结果的分别说明；缺字段表示未知，不推断触发成功。保留 task token 身份与线程约束。 | 与 1/2 独立；真实覆盖成功触发和未触发。 |
| 4. worktree 和任务绑定 | 资源解析 → 准备目录/分支/基线 → 持久绑定 → 任务执行入口 → 恢复/产物定位 → 最终报告；两任务同时存在仍各用自己的绑定。 | 与 2 共用上下文、与 1 共用回传及恢复；只有整体验证通过才声明相应能力。 |

每个切片提交独立可审查 PR；接口接缝保持在本组件内部。本尊负责范围协调和独立 review；实现由 luna.coco 推进。最终合并、验收与发版按 Howard 授权。

## Worktree 具体规则（拟实现）

1. **资源选择**：GitHub 仓库使用组件受控 checkout/cache，任务从明确 revision 建立工作目录；多仓库分别建立资源目录，不静默挑第一个。local_directory 必须匹配本 daemon；真实路径和 repo 根确定后保留子目录偏移。`in_place` 不偷偷改成 worktree，`worktree` 不回退到原目录，未知 mode 明确失败。
2. **脏工作目录**：按官方语义捕获 tracked/untracked 用户改动，用独立 index，不修改用户 index/工作目录；忽略文件和过量文件不偷拷，给出明确限制与失败原因。源码中的 2000 文件/200 MiB 可作为初始快照上限，但需要测试和文档明确。
3. **身份和并发**：绑定含 workspace、agent、issue/chat、task、resource 的稳定身份，不能用标题或短名判断所有权；同一工作线后续任务复用已确认产物，忙碌分支不得被另一运行抢占。不同任务允许各自 worktree；`in_place` 对同一真实路径协调执行。
4. **执行落点**：新增组件任务执行/定位入口（内部 helper，不伪装官方业务 CLI 命令），以 task ID 查询绑定、设置子进程 cwd；环境变量不携带打印出的凭据。原生编辑工具只能对绑定路径操作。验收记录实际 cwd、git 根和分支，并用故意选错绑定的负例验证；若要求工具层强制隔离，则走前述架构决策。
5. **恢复与交付**：组件重启重新读取绑定并对账平台状态，不重新 fork 或抹去目录。取消、失败、未知回传均保留工作目录、未提交文件和产物清单。先不做自动清理/自动删除；成功报告明确分支、目录和提交，未提交产物明确列出。后续人工确认清理属于单独操作，不作为任务自动完成的副作用。
6. **能力上报**：只有本机 local worktree、任务实际落点、恢复及报告均通过后才启用 `local-worktree-v1`；组件版本与协议能力版本独立，不因服务端已升级就把能力版本跟着提高。未达到的语义不宣称支持。

## 附件、上下文和评论反馈的落点

- 附件拟增加 `attachment download <id> --task <id> --output-dir <dir>`，沿用官方命令名；默认落在受控任务目录。先用任务 token 和 workspace header 取 `/api/attachments/{id}` 元数据，再读取新鲜下载地址。相对同源地址可带认证，绝对签名 URL 不带 Authorization；跨源跳转不泄漏凭据，禁止协议相对 URL 偷换来源。二进制流使用独立下载实现，不复用始终附带 PAT 的 JSON helper。
- 设单附件初始上限 100 MiB，流式计数超限报错而非静默截断；限制路径真实包含关系、文件名、软链接及覆盖，缺 token 时请求前失败；不解压任意附件。读取失败逐项列出，不伪装成没有附件。真实上传可由平台 UI/已有工具完成，本切片首先实现读取，不混入自动上传/发送能力。
- claim 的 `workspace_context`、`repos`、`project_*`、`project_resources` 按服务端已经解析的优先级保留；不把 workspace repos 重新拼回 project repos。`agent.instructions`、inline `agent.skills` 及 supporting files 落为任务作用域材料，不能安装成全局技能或覆盖宿主指令。支持文件路径及内容均作为外部输入处理。
- 当前未声明 `skill-bundles-v1`，服务端默认提供 inline skills，优先消费现有字段而不新增这个能力。意外收到非空 refs 必须明确未解析；如以后支持 refs，需要在 dispatched/waiting_local_directory 阶段通过官方 resolve 接口完成，不能 start 后再取。
- 评论 JSON 输出已保留 `trigger_outcomes`；此次主要补 table/可读提示及 skill。逐目标区分 `queued`、`coalesced`、`deferred`、`steered`、`blocked`，保留 `reason_code`，未知值原样显示。queued 不是执行完成，字段缺省也不是“未触发”。这些 outcomes 主要描述显式 mention，不保证覆盖隐式触发。
- 已保存评论即写入成功，即使某目标 blocked 也不将其变成写失败后自动重试。JSON 结构保持兼容；table/诊断提示明确“保存成功，触发受阻及原因”。

## 真实验收安排

使用隔离测试项目、任务、仓库和数据；不改变现有生产任务。运行升级候选组件时使用独立测试身份/配置，避免与现用桥抢 claim；需要平台测试资源或独立 daemon 身份时由范围协调方提供/确认。真实 C4 交付使用正常活会话入口，不能把直接调用函数的测试写成真实执行。

| 场景 | 必须保留的证据 |
|---|---|
| chat、普通 issue、评论追问各一条 | 原始输入 → task 身份 → claim/start → C4 接收 → 实际执行 → C4 回传退出码 → 平台最终状态和结果读回；界面展示截图。 |
| 中途进展、线程评论、最终完成 | progress 后仍 running；评论 actor=agent 且 parent 正确；最终结果仅一次；run 完成不被写成 issue 人工验收。 |
| 重启与回传断网 | bridge-only restart 与活会话重启分开；在 C4 接收/start 前后中断；服务端接收完成但响应丢失；取消/重派后旧回报。每条指出已确认事实和仍未知结果。 |
| 附件与上下文 | 真实上传并在对应任务读取，比较内容摘要；拒绝越界路径、跨任务引用、超限、鉴权失败和错误跳转；验证仓库资源及适用 skills 确实进入执行侧。 |
| 评论触发 | 真实一次成功触发和一次明确未触发，保存返回 outcome、CLI 提示与平台实际 task，字段缺省的兼容测试单列。 |
| 两任务 worktree | 同名文件不同修改、实际命令 cwd/branch、原目录 hash 不变；脏源目录快照、子目录、同工作线后续任务、两个任务并存。 |
| worktree 失败/恢复/产物 | 中途未提交修改和未跟踪产物，在进程退出/重启/取消后可定位且不丢；回传位置真实有效；冲突不覆盖原目录。 |

恢复用例的通过条件：最终进入平台权威终态，或进入明确可恢复、可对账的待回报状态；不得丢产物、重复业务执行或重复可见输出。故障发生后的暂时 unknown 必须可追踪，不能把 unresolved unknown 当成恢复验收完成。

证据分三层标注：单元/故障模拟、本机实际工具探针、真实平台往返；不互相替代。记录非敏感关联 ID、操作时间、状态和内容 hash；凭据不进日志、PR 或 issue。非幂等创建/评论在响应不确定时先回读，不能整体重试。

## 交付检查

- [ ] 本尊 review 实施范围与 worktree 目录隔离边界；实质取舍交 Howard。
- [ ] 每个切片的单元/集成测试与已知错误变体测试通过。
- [ ] 更新旧 solution 中已失效的无状态/附件非目标等表述；历史变化只放独立变更记录/简短索引，正文只保留现行规则。
- [ ] 四类能力真实验收完成，失败路径有明确证据。
- [ ] PR、提交、契约对应和端到端证据交本尊复核；未授权前不发布部署。


## Review 补充 A：最终回传及结果核对契约

以下按官方 v0.6.2 源码核对；真实部署的故障验收仍须验证该契约。平台 task 状态唯一权威；本地状态只表示“某个固定回传是否已获确认”。

**接口与身份**：

- issue / 评论追问：`GET /api/issues/{issue_id}/task-runs`，默认 scope，不带 `active=true`；用组件已有 PAT + `X-Workspace-Id`，按完整 task ID 找记录。
- chat 或上述历史未找到：`GET /api/agents/{agent_id}/tasks?limit=200`，同样 PAT/workspace，读取 `X-Agent-Tasks-Next-Cursor` 并以 `before` 翻页。要补 HTTP helper 的响应头读取能力；未遍历完不能断言不存在。私有 Agent 权限拒绝明确保留为不可读取。
- 先核对返回的 `id`、workspace/agent/issue/chat 身份及 `status`，再按终态分支核对正文。completed 时，`result` 是服务端序列化的完整 TaskCompleteRequest：按字段比较冻结payload与 `result.output`、`result.pr_url`、`result.work_dir`、`result.branch_name`、`result.durable_work_dir` 等实际提交字段；`pr_url` 不在响应顶层。未提交字段按该请求结构的空字符串/false/omitempty默认语义归一，不比较原始 JSON 字节顺序，正文不 trim、不模糊匹配。顶层 work_dir / branch_name / durable_work_dir 是任务当前元数据（部分更新采用COALESCE，也可能由后续session回报更新），须另按对应字段语义核对，不把未传字段一律要求为空，也不以顶层字段替代冻结请求的result证据。
- `/api/daemon/tasks/{id}/status` 只有 status，只用作判断是否继续查询，不作正文成功证据。活跃 task token 的 `/api/chat/history` 不是终态回读渠道；聊天界面读取还受创建者权限限制，须用测试用户单独验收展示。
- `POST /api/daemon/tasks/{id}/complete` 返回 `AgentTaskResponse`。v0.6.2 首次成功与相同任务重放都返回已有任务；不同正文也不会 409，甚至 cancelled/failed/非 running 可 HTTP 200。因此任何 200 都必须检查结果。服务端只从 running 做完成转换，已完成重放不覆盖原结果。

**记录与先后顺序**：在第一次 POST 前冻结 payload 并原子持久化 pending（目录0700、文件0600，临时文件写入/fsync/rename；token不放记录）。记录包含 schema、平台来源/workspace/daemon/runtime/agent/task/issue/chat ID、action、原始payload及摘要、绑定 generation、created_at、当前本地状态、最后可验证的响应摘要。非法NUL/无效字符串在冻结前拒绝，不偷偷改用户正文；同一 task 重试只能发送同一固定 payload，新正文与 pending 不一致时直接报告冲突，不覆盖旧记录。进程重启从这份记录恢复回报，不重新运行任务。

**generation 写入门**：平台 complete 只识别 task ID，不识别本地 generation，不能把本地代号当成服务端 fencing token。为同一来源/workspace/task 设置原子互斥，生成新执行代、冻结 pending、发送回报均经此门；pending / pending_unknown / pending_not_running 尚未按权威结果收口时，禁止新执行 generation、禁止覆盖 pending。回报发送前在锁内检查调用方 generation 与当前绑定、冻结记录及原始 claim 的 `runtime_id` / `dispatched_at` 一致；旧代只能回读已存在结果，不能 POST（包括人工重放）。运行中已有 pending 时只能由仍属当前代的对账器重放原 payload。发生 claim 更替、当前代无法确定或旧请求可能仍在途中时，保持待对账，不允许给同一 task 开新代再接受旧请求；重派 child 用新 task ID。这个本地门只能约束本组件，不声称能阻挡其他客户端直接写同一 task。

| 本地观察 | 下一状态/动作 | token / pending / 产物 |
|---|---|---|
| 旧代回报 / 同task已有pending却申请新代 | POST前拒绝旧代写入；拒绝新执行代；只允许按原task回读 | 冻结payload和绑定不替换，不清理产物 |
| pending 尚未写成 | 不发 POST，明确本地保存失败 | token、工作目录保留 |
| POST 返回同 task、completed、正文及已提交字段匹配 | confirmed；先原子保存确认结果，再清理活跃回报记录 | 移除该task token；保留去敏确认凭据和产物定位，不删除worktree |
| 同身份且completed，但结果正文/已提交元数据不一致 | conflict；展示已有结果与本次待回报差异摘要，不覆盖、不重跑 | 已核对平台终态后移除失效token；pending转冲突记录，原payload/产物保留 |
| 平台 failed/cancelled 或完成被服务端改判失败 | superseded；明确真实终态，不能报告完成成功 | 移除已失效token；保留原payload、终态证据及产物，禁止把旧结果交给重派child |
| 超时/断网/500/无效响应 | pending_unknown；调用上述结果GET回读 | 不清理token/pending/产物，不重新执行业务 |
| GET 找到匹配结果/冲突/其他终态 | 按前三条处理 | 同上 |
| GET 权限不足、分页失败、尚未找到 | 继续 pending_unknown，输出可恢复原因 | 不把 completed 状态或未找到等同成功/失败；保留记录 |
| 平台仍为 running | 本地代与冻结记录一致且原执行已有start确认时，先以原claim的精确 runtime_id/dispatched_at 重放generation-aware start，得到同身份running成功响应后才重放冻结的complete；start 409或响应不明则只保留待对账。随后再次核对complete返回结果 | 回调重试有上限/退避，耗尽仍pending；不重做claim、执行、创建或评论 |
| 平台 queued/dispatched/waiting | pending_not_running；先处理start/领取对账，不宣称完成 | 原payload保留；不以该状态自动重做执行 |

普通历史GET的dispatched_at仅整秒，不能作为自动回调重放的精确claim证明。complete本身不做claim fencing；本地记录无法确定当前claim时宁可保持pending，不猜测原claim仍有效。上述start确认只能在已观察running且原执行曾确认start的恢复路径使用，不适用于从未开始的任务。

判定顺序为身份 → status → 对应结果字段；queued/dispatched/running 或未知状态的HTTP200不能因为result为空落入conflict，failed/cancelled优先归superseded。身份不符/结构缺失属于无效响应，保留pending_unknown。

同样的 fail 回报需检查对应 `failed` 状态与 error/failure_reason；不把 fail 的正文拿去比较 `result.output`。自动重放先只覆盖源码证明幂等的 complete，fail 在独立核对其重派副作用前保持待对账，不套用 complete 结论。查询不可用时，人工也不能仅凭本地generation或整秒历史时间戳重放complete；先恢复权威读取并核对终态，或在已知running且原执行已有start确认时通过上述精确claim start确认。不能用start将queued/dispatched任务重新启动以补交旧结果。任何回调重放都是写操作，不包装成GET；仍须通过generation写入门，不得绕过身份权限或改发新正文。confirm落盘后token删除失败只记清理待办，不重发完成正文。

源码依据：`handler/daemon.go:4229–4380,4959–4987,5585–5685`；`handler/agent.go:2684–2769`；`service/task.go:4411–4507`；路由 `router.go:2057,2241–2255`。验收加入取消/failed/非running返回200、不同正文重复POST、结果在第二页、权限拒绝及服务端已提交但响应丢失。

## Review 补充 B：工作线身份、占用和恢复

“工作线”只标识可以续接的历史，不等于一个永久复用的可写目录。**worktree 模式下每个 task 使用独立目录和独立分支；同工作线后续任务复用已确认提交作为基线，不复用上一轮的物理目录/分支。in_place 模式保持声明资源的真实路径，按真实路径排他占用，不另建 worktree。** 这样晚到的旧执行即使还向旧目录写，也不会直接写进新任务目录。

身份：`lineKey = hash(serverOrigin, workspaceId, agentId, conversationKind, conversationId, resourceId, canonicalRepoIdentity)`。conversationKind 为 issue/chat/task；有 issue 用完整 issue UUID，chat用session UUID，无关联则task UUID；不使用标题、短identifier或资源标签。resource身份变更即新工作线。任务绑定主键为来源+workspace+完整taskID+resourceID，重派child是新task，不冒用parent绑定。

示例（均为虚构标识）：

```json
{
  "schema": 1,
  "line_key": "sha256(full-line-identity)",
  "task_id": "task-A", "parent_task_id": null,
  "resource_id": "repo-1", "generation": "unique-execution-A",
  "phase": "prepared",
  "repo": "<controlled-repo>",
  "cwd": "<task-root>/task-A/repo-1/worktree/subdir",
  "branch": "zylos/task-A/repo-1",
  "base_commit": "<immutable-sha>",
  "source_snapshot": "<snapshot-sha-or-null>",
  "execution": {"accepted": false, "quiesced": false},
  "report": {"state": "none"}
}
```

工作线另存 `active_task` / generation 和 `last_confirmed_delivery`（task/commit/branch）；PID只作诊断，不是所有权。原生文件编辑无法由组件证明停止，因此退出证明必须来自任务执行入口与活会话的明确结束确认；目录/分支隔离不是对恶意越界写入的防护。

申请/执行步骤：

1. 按工作线原子申请占用（排他创建/锁），记录claim原始 `runtime_id` / `dispatched_at` 后即开启下述服务端prepare lease；获得占用者先落 `preparing` 绑定与唯一 generation，再进行Git目录操作。同线同时到达只有一个获得执行占用，其余在服务端仍为dispatched并持续续租，同时本地标记等待原因；不能仅放本地队列不续租。不同工作线可并行。
2. 从原始资源/上一轮确认交付commit确定不可变base。为本task创建唯一分支/worktree，校验真实git根、branch和子目录；完成后原子写 `prepared`。未准备完成不得投递可执行任务卡。准备及排队期间持续续租；获得工作线、准备完毕后，用原claim身份调用generation-aware start并确认响应，才允许执行业务。
3. 执行入口以task ID+generation读绑定。已在执行的同task重复投递不再启动第二份；失效generation或未取得原claim start确认的绑定拒绝执行。若C4接收仍先于start，该投递只能是不可执行的准备通知，入口在start确认前必须拒绝业务命令；start响应不明时先对账，不能凭C4接收成功放行。每条受控命令显式cwd；原生读写显式绝对路径。登记正在执行的命令，返回实际cwd/branch作为诊断。
4. 执行方结束前等待自己的命令完成，明确标记quiesced并记录git状态及产物清单，然后才进入最终回报流程。代码提交由执行Agent按任务需要完成，组件不把任意未提交文件自动提交/推送。未提交产物保留并在结果中说明。
5. 在确认quiesced且命令均结束后释放活跃执行占用；回传可能仍pending，此时工作线处于待交付确认，后续任务不从未确认/脏产物自动续接。成功且已提交的交付在平台回读确认后更新last_confirmed_delivery。未提交交付、失败或冲突需明确恢复/续接选择，不能静默丢掉改动后假装延续。该取舍只影响同一工作线，不阻塞其他工作线。

恢复/取消规则：

- 桥进程重启：读取占用和绑定，核对Git实际目录/分支以及平台状态；**不因桥PID已死、锁文件旧、TTL到期或平台cancelled自动释放**。旧Agent/命令可能仍活着。未知执行状态显示“等待执行停止确认”，保留全部产物。
- preparing中断：只认本task/generation创建的目录与分支。目录尚无则可继续准备；已有且身份吻合则补齐prepared；目录已存在但归属不清则冲突停止，不清空或强占。
- 同task恢复：只有执行方确认旧一轮已经停止，才恢复该绑定；如果需新的执行generation，须同时确认旧代已停止且不存在未收口pending或在途旧回报，再持久化旧代结束并分配新代；旧代只读核对，任何旧代POST都在发请求前拒绝。重派child使用自己的task目录。
- cancelled：先停止该任务经执行入口启动的命令并等待退出，通知活会话停止后续原生写入，收到quiesced确认后才释放占用。不能保证停止的旧任务保留占用，不重用其目录；另开隔离工作线/显式选定提交恢复需明确授权，而非自动覆盖。
- 回传晚到：只处理其原task与generation，不推进当前child的状态，也不能改写新工作线头。失败/取消/冲突时目录、未提交内容与产物保留；不自动remove worktree、reset或gc。

### 服务端准备租约与等待：锁版源码契约

- `POST /api/daemon/runtimes/{runtimeId}/tasks/{taskId}/prepare-lease`，body `{}`，使用组件daemon API已有的合法认证与workspace身份（不是任务业务token）。服务端验证runtime/task归属；SQL要求同runtime、status为`dispatched`或`waiting_local_directory`、`started_at IS NULL`，成功把租约设为服务端now + 45秒并返回任务。官方客户端每15秒续租、单次请求超时10秒；本组件沿用该节奏，从claim后立即续一次，贯穿本地等待、Git准备和start响应确认。普通runtime heartbeat不能替代每task准备续租。
- 通用工作线排队采用 **dispatched + prepare lease + 本地等待原因**，不是臆造平台waiting状态。续租失败或响应中的task/runtime与原claim不符，暂停新准备/投递/执行并对账；不得把超时当作仍有所有权。保留已有目录；续租恢复后可继续准备，但执行仍须下述精确claim start门确认。排队取消/进程重启也先对账，不直接重新claim或开新执行代。
- `POST /api/daemon/tasks/{taskId}/wait-local-directory`，body `{"reason":"..."}`，确实存在，但其语义是local_directory路径互斥等待；只从dispatched转为`waiting_local_directory`，重复请求会400。此状态被普通过期reclaim/timeout排除，daemon重启的orphan recovery仍可终结它。**本轮通用工作线等待不调用此接口**：不能将Git工作线或待交付确认伪装成local_directory路径等待。
- 特别限制：prepare-lease SQL只比较task/runtime，wait-local-directory只比较task/status，二者都没有`dispatched_at`条件。成功续租不是“当前claim代仍归我”的最终证明，过期后同runtime重领时旧续租甚至可能续到新代。响应中的task/runtime可核对，但普通taskToResponse（prepare-lease、start及历史GET共用）将dispatched_at格式化为RFC3339整秒；只有claim响应单独覆盖为RFC3339Nano。不能把普通响应时间戳与原claim微秒串做等值检查，否则正常租约也会被误判；整秒明显不同可提示更替，同秒相等却不能证明claim未变。不得用回读值覆盖原claim，也不能靠先GET后POST声称消除了竞态。精确所有权仅由携带原claim微秒值的start请求在服务端判定。
- 真正的开始门是 `POST /api/daemon/tasks/{taskId}/start`，body含 **原claim** 的 `runtime_id`、精确保留的`dispatched_at`（PostgreSQL微秒时间戳，不用JS Date往返丢精度）。服务端事务按task/runtime/dispatched_at锁行；同代running可幂等确认，旧claim返回409。不得退回旧版空body start，不得把新回读的dispatched_at替换到旧绑定骗过检查。业务命令必须在本地占用和此start确认同时具备后开始；续租维持至确认（start响应丢失时保留未知状态，并用同一精确claim重试start确认；普通GET的running及整秒时间戳不足以证明是原claim，禁止据此启动第二份）。因此租约到期并被重领即使与续租、排队唤醒相撞，也不能让旧代开始业务执行。

源码：`server/cmd/server/router.go:1557–1593`；`internal/handler/daemon.go:4052–4193`；`internal/service/task.go:197,4274–4340`；`pkg/db/queries/agent.sql:871–1016,1320–1400`；`internal/daemon/daemon.go:149–150,7243–7280,8467–8496`；claim时间戳覆盖 `internal/handler/daemon.go:2358–2361`、普通响应 `internal/handler/agent.go:846`、整秒格式化 `internal/util/pgx.go:97–102`。这是锁版源码依据，不代表已在部署环境验证。

新增故障验收：等待时间超过45秒仍持续续租时不能被重领；阻断续租使租约过期，触发同runtime同task重新claim（新的dispatched_at），再释放本地工作线并送达旧续租/start，必须看到旧start409且零业务执行；负对照将start改为空body应使该测试失败。覆盖原claim含微秒而lease/start/历史返回整秒仍不误判、同秒重领无法靠GET区分但旧claim start仍409、start已成功但响应丢失、续租中断/取消、等待中桥重启、旧代在pending期间尝试新generation及旧POST（请求计数必须为0）。保留未提交产物，确认新旧代不能同时执行；仅mock计时不算真实平台过期验收。

验收增加：同issue两task并发申请、同task重复投递、preparing三个中断点、桥重启但旧执行仍在写、cancelled后旧进程继续写/晚回报、释放后新task独立目录、两个同时存在分支及同工作线确认续接。上述仅为待review实施契约，尚未声称执行入口和占用逻辑已实现。

## 可复跑探针与最小测试环境

探针：`node scripts/probes/worktree-isolation.mjs --output <不存在的新目录>`。只需Node和Git，不需要任何凭据。它保留源仓库、A/B worktree、bindings和evidence.json，执行并行写入、新进程绑定读回及错误绑定负对照；不修改/重启服务、不自动删除输出。已复跑通过，示例结果见 `docs/evidence/issue-30-worktree-probe.json`。这是本机子进程/cwd实验，不是组件恢复机制或平台E2E。

真实环境最小需求：

- 一个v0.6.2测试workspace/project和专用Agent/runtime/daemon身份；项目只绑定隔离测试仓库/本机目录，不能复用现用桥daemon ID。
- 最小权限的测试用户PAT：该workspace成员、可查看专用Agent任务历史，可新建/指派测试issue和评论；凭据仅通过私有安全配置交付，不放issue/命令参数。测试聊天由该用户创建，确保有查看聊天展示的权限。
- 一个能成功触发的受控测试Agent，以及一个可控未触发场景（例如明确离线的测试runtime）；均不向真实业务Agent发测试评论。
- 独立数据根/任务目录、独立测试桥进程及C4测试入口。正常链路可交给现有活会话处理隔离测试任务；会话崩溃/强制终止测试必须使用另一个可销毁测试会话/实例，不能对生产活会话注入故障。
- 可控HTTP故障代理用于请求未送达、服务端提交后响应丢失；只截测试实例流量。浏览器测试登录或对应测试人配合提供聊天/任务展示证据。

在这些资源可用前继续mock HTTP、CLI子进程和本机文件系统测试；不得将它们写成真实平台验收。


## 第二轮收口与目录职责（Howard 最新指示）

第二轮计划 review 已认可恢复/worktree 主体实施契约。start 成功但响应丢失时，prepare-lease 会因已有 started_at 被拒；此拒绝不能直接判 claim 失效。用**原始精确 claim** 重试 claim-aware start：同代 running 可确认，409 则拒绝执行，响应不明保持待对账。start 确认后停止准备续租。complete 无服务端 claim fencing 的限制不变，本地互斥不承诺跨客户端原子性。

目录遵循现有职责：工作内容在 workspace，组件运行数据在 components/multica。此前全部放 components 的临时提议已撤回。不新增 Zylos 顶层目录、不改变 core/C4/session 布局、不移动既有业务仓库。

| 内容 | 标准位置（相对 ~/zylos） | 生命周期 |
|---|---|---|
| 组件代码、skill、CLI、hooks | .claude/skills/multica/ | 标准 zylos component 安装/升级；不把业务产物写进代码目录 |
| 配置、任务 token | components/multica/config.json、task-tokens/ | 私有权限；仅确认终态后清理失效 token |
| task generation、start/执行确认、冻结 pending 和回读凭据 | components/multica/task-state/ | 跨进程/升级保留；不以重启为新任务 |
| 任务→资源/cwd/branch 绑定、占用、运行命令、确认提交头 | components/multica/execution/{bindings,operations,owners,heads}/ | 跨升级保留；不因 PID/TTL/cancelled 自动释放 |
| 附件允许清单 | components/multica/task-downloads/<task-hash>/attachments.json | 运行授权记录；不混入正文和凭据 |
| 下载的附件内容 | workspace/multica/tasks/<task-hash>/attachments/ | 工作材料；不自动删除或覆盖 |
| 上下文、instructions、inline skills 及支持文件 | workspace/multica/tasks/<来源-workspace-task-hash>/context-<snapshot>/ | 工作材料，仅当前 task 适用，不全局安装 |
| 受控 repo cache | workspace/multica/repos/<repo-hash>/ | 工作仓库；不移入组件代码目录 |
| worktree、快照专用临时 index、未提交产物 | workspace/multica/tasks/<task-hash>/<generation-hash>/<resource-hash>/ | 独立任务工作区，保留待交付材料，不自动清理 |
| in_place 工作区 | 平台明确声明的既有本地真实路径 | 外部资源，非组件所有，不搬动/自动清理 |

路径 hash 使用完整稳定身份，不能以外部标题直接拼路径。上表子路径会与最终实现逐项核对；workspace 的任务工作路径由绑定记录定位，不能靠猜目录恢复。

升级保留：运行数据与工作内容均在 skill 代码目录之外；lifecycle.data_dir 保持 components/multica，preserve 显式列出配置、日志、task-tokens、task-state、task-downloads、execution 等运行子目录。workspace 工作材料不靠复制进 skill 备份保留，升级 hooks 不迁移/删除它们。测试须覆盖升级 hooks 前后绑定、pending、下载和工作产物仍存在。不存在自动 worktree remove/reset/gc 或业务仓库搬迁。

### local_directory：原仓库影响与待决定取舍

以下是临时测试仓库中的实现评估，不是对业务仓库的写入授权；该选择尚未由 Howard 定案。

| 项目 | 直接共享原仓库 Git 元数据 | 组件受控副本 |
|---|---|---|
| 原工作区源码/未跟踪文件 | 准备时只读，任务在独立 worktree 修改 | 准备时只读，任务在副本 worktree 修改 |
| 原 .git/index | 不修改；快照用 workspace 中独立 GIT_INDEX_FILE | 不修改 |
| 原 Git 对象库 | 写入脏工作区快照的 blob/tree/commit | 新对象只写受控副本；需把源内容与所需历史复制进去 |
| 原 refs | 新建 zylos/task 专用分支，可在原仓库直接发现 | 分支只在副本；交付回原仓库需显式 fetch/import/push |
| 原 .git/worktrees | git worktree add 登记新工作区及其 HEAD/index 等元数据 | 登记仅在受控副本 |
| 空间/同步成本 | 共用对象较省；原仓库存在元数据变化 | 对象/快照额外占空间，源变更与交付有同步成本 |

建议：先向 Howard 展示上述实际影响再决定 local_directory 后端；不把“工作区文件未改”说成“原仓库完全未变”。GitHub 来源仍使用受控仓库。当前临时仓库实验可继续，但不得根据此比较扩大实现范围或写业务仓库；若要求原 .git 也完全只读，必须采用受控副本并单独落实该实现，不能假称共享 worktree 满足要求。
