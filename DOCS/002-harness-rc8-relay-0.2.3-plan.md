# Harness rc.8 / Relay MCP 0.2.3 修复与后续演进计划

状态：主进程审定，待实施

审定日期：2026-08-20

目标版本：`harness-relay-mcp 0.2.3`

## 1. 审核来源与结论摘要

本计划综合以下证据形成：

- Harness 已升级到 `dsh-v0.1.0-rc.8`，Relay 当前为 `0.2.2`。
- 实机恢复确认：Web 本身正常；Relay 失效时旧 endpoint 未刷新、POST 路由缺失，stdio proxy 只泄漏 HTTP 405。
- 实机复现确认：不显式设置 `DSH_HOME` 时 Harness Web 可以启动，但 Relay embedded 初始化会在 authority acquire 之前抛错。使用 `DSH_HOME=C:\Users\id-o\.dsh`、`DSH_PROFILE=web` 重启后，owner epoch 从 1 增至 2、endpoint 刷新、POST 路由恢复、doctor 通过。
- Harness K3 通过 Relay MCP 以 `kimi-coding/k3/max`、`read-only` 模式完成独立代码审核，未修改文件。审核会话：<http://127.0.0.1:3080/?sessionId=session-917a31fc-5cd6-4370-9871-1eacc51edab1>。
- K3 会话历史最终存在 `turn/end: completed` 和完整最终消息，但 Relay `get_run` 仍返回 `running`，且只投影了前段进度文本；`get_run_summary` 还出现陈旧 `updatedAt` 与 `elapsedMs: 0`。这是本次审核额外暴露的 0.2.2 缺陷。

主进程结论：**0.2.3 必须发布，但应保持为启动、诊断与终态一致性热修复。** 图片深度校验、interrupted 完整投影、Agent Teams、引用协议等不应挤入同一补丁。

## 2. 根因分层

### 2.1 本次故障的直接根因

`src/harness-entry.ts` 的 embedded 路径解析强制要求显式 `DSH_HOME`，与 Harness 和 Relay proxy 已有的默认 `~/.dsh` 规则不一致。异常发生在异步 `ctx.effect` 内，且早于：

1. authority acquire；
2. Web POST 路由挂载；
3. endpoint descriptor 发布。

因此会出现“插件条目 active，但 owner、endpoint、POST 路由均未更新”的组合症状。

### 2.2 独立存在的升级重启竞态

旧 Web 仍在 drain 时，新 Web acquire 会收到 `AUTHORITY_OWNED` 并立即失败。它不是本次实测的直接根因，但会产生相同外部症状，必须在 0.2.3 一并加固。

### 2.3 独立存在的终态投影缺陷

本次 K3 审核的 Harness 持久历史已经以 `turn/end: completed` 收口，Relay 仍保持 `running`。这说明 Relay 的运行边界识别、steer 后历史归属或终态 reconciliation 至少有一处不正确。持久历史必须是最终真源，不能以过期的 session/list 或内存状态覆盖已落盘终态。

## 3. 对原建议的主进程裁决

| 建议 | 裁决 | 目标版本 | 理由 |
|---|---|---:|---|
| authority 有限重试 | 修改后保留 | 0.2.3 | 只重试 `AUTHORITY_OWNED`；每轮重读 owner 并探测 PID；只有确认死亡后才能按既有 stale recovery 接管，禁止按文件时间强抢 |
| 本地 doctor、远端按需连接 | 保留 | 0.2.3 | 当前 proxy 在本地 MCP 启动前依赖远端，故障时没有任何可用诊断面 |
| status sidecar 或 descriptor v2 | 采用 sidecar，推迟 descriptor v2 | 0.2.3 / 后续 | 0.2.3 保持 descriptor v1 兼容；状态在 endpoint 尚未就绪时也必须可表达。sidecar 用 owner epoch/authorityId 与 descriptor 对账，解决双文件一致性；descriptor v2 留待制定双读迁移后实施 |
| 升级重启交叠集成测试 | 保留 | 0.2.3 | 现有 recovery 测试只覆盖重建 proxy 后恢复，不覆盖双 Web 交叠 |
| rc.8 Host 合同夹具 | 缩小后保留 | 0.2.3 | 只固定 Relay 实际消费的增量 wire：`host.describe.home`、`imageLimits`、终态和 assistant interrupted 等，不复制全量 Host 合同 |
| 图片 MIME/像素/尺寸校验 | 保留但推迟 | 0.2.4 | 需要稳定读取 Host 投影并实现格式头解析；不应扩大 0.2.3 热修复面 |
| interrupted/partial output | 保留但推迟 | 0.2.4 | 先修“completed 仍 running”的终态真源；随后再增加 additive 字段，避免混入状态枚举破坏 |
| doctor 全面增强 | P0/P1 拆分 | 0.2.3 / 0.2.4 | 0.2.3 先覆盖版本、home/profile、owner、status、endpoint、POST 握手、proxy；插件 fiber 等扩展诊断后置 |
| Agent Teams 能力发现 | 仅记录约束 | 后续观察 | rc.8 仍属实验能力，不暴露 `start_team` 等写工具；只有稳定只读能力 API 出现后才考虑发现 |
| 文件/会话引用 | 推迟 | 官方 wire 稳定后 | 不伪造 MCP 内容块，不建立私有协议债务 |
| 弃用 `status_run` | 仅公告 | 0.2.3 公告，0.3.0 再删 | 保留至少一个兼容周期；0.2.3 description/README 指向 `get_run` |
| SQLite、内部透明能力、openBrowser、standalone | 保持克制 | 持续约束 | 不复制 Harness SQLite；不为多查询/PTY/FD3 增加工具；`openBrowser=false`；standalone 暂留但不得自动竞争 embedded |

K3 建议在 0.2.3 直接写 descriptor v2。主进程未采纳，原因如下：

1. 失败状态可能发生在 endpoint URL、token 或路由尚不存在时，状态对象不应被迫伪装成可连接的 endpoint descriptor。
2. 0.2.2 proxy 对 descriptor schema 的兼容性有限，补丁版直接升 v2 会增加升级、降级和安装层不同步风险。
3. sidecar 与 descriptor 可通过 `authorityId + ownerEpoch + processStartedAt` 明确对账；不一致时报告 `STALE_ENDPOINT_DESCRIPTOR`，不需要假设两个文件原子提交。
4. descriptor v2 仍可在后续版本实施，但必须先定义 v1/v2 双读、写入顺序和回滚策略。

## 4. 0.2.3 P0 实施计划

### P0-1 统一 home/profile 解析并前置校验

内容：

- 建立单一解析函数，embedded、proxy、doctor 共用。
- `DSH_HOME`：非空环境变量优先，否则使用 `join(homedir(), '.dsh')`。
- `DSH_PROFILE`：非空环境变量优先，否则使用 `web`。
- 自定义 `stateDirectory` 仍保持显式配置优先，不改变现有语义。
- 路径解析失败时返回结构化错误码、实际解析来源和修复建议，不依赖不可见的 effect rejection。

理由：这是本次事故的直接根因；同时消除 embedded 与 proxy 的规则漂移。

验收标准：

- 未设置 `DSH_HOME` 时，默认 home 下可正常 acquire、挂载 POST 路由并发布 endpoint。
- 显式自定义 `DSH_HOME` 与 `DSH_PROFILE` 时，所有运行态文件落在预期 profile。
- 解析或目录准备失败时，不残留新 owner/token/endpoint，status 明确为 `failed`。

最小测试：默认 home、显式 home、空白 env、显式 stateDirectory、目录不可用五组参数化用例；至少一条真实 rc.8 隔离 profile smoke。

### P0-2 新增 `relay-status.json` 状态 sidecar

建议 schema v1 字段：

- `schemaVersion`；
- `state`: `starting | ready | failed | stopped`；
- `authorityId`、`mode`、`instanceId`；
- `ownerPid`、`processStartedAt`、`ownerEpoch`；
- `hostIdentity`、`profile`、解析后的 `dshHome`；
- `updatedAt`；
- `lastError`: `code`、`message`、`remediation`，成功状态为 `null`。

约束：

- 原子 UTF-8 写入，不含 token 或任何凭证。
- `starting` 在 acquire 前写入；acquire 后补齐 epoch/owner；路由和 endpoint 成功后写 `ready`；异常写 `failed`；正常 dispose 写 `stopped`。
- `ready` 只允许在 endpoint descriptor 已原子发布且 POST 握手成功后出现。
- proxy 比较 status、owner、descriptor 的 authority/epoch/process identity；不一致或握手失败时返回 `STALE_ENDPOINT_DESCRIPTOR`，不得只透传 405。
- descriptor v1 暂不改 schema；旧 descriptor 不因文件年龄直接删除或抢占。

理由：让异步 effect 的失败在 Relay 自己的控制面可见，同时维持 0.2.2 descriptor 消费者兼容。

验收标准：每个启动失败点都留下无敏感信息的 `failed` 状态；正常生命周期产生可验证的状态序列；status/owner/endpoint 任一错配都被 doctor 精确指出。

最小测试：状态 schema、原子写、无 token、各失败点注入、正常启停、三类错配和 v1 descriptor 回归。

### P0-3 authority 有界退避与安全接管

内容：

- 仅捕获 `AUTHORITY_OWNED` 进入退避，默认总预算建议 20 秒，可配置但上限不超过 30 秒。
- 使用短退避并带小幅 jitter；每轮重新读取 owner，重新探测其 PID，不复用旧判断。
- 只有 `dead` 才允许 `recoverStale`；`alive` 和 `unknown` 均不接管。
- owner 内容变化时以新记录重新判断；不能只盯旧 PID。
- `AUTHORITY_STALE_OWNER`、`AUTHORITY_REGISTRY_INVALID` 和其他初始化错误不得盲目重试。
- 等待可被 plugin dispose/AbortSignal 立即取消。
- 任何情况下禁止按 owner/endpoint 文件时间强抢活 owner。

理由：修复升级重启交叠，但不降低单 authority 安全边界。

验收标准：alive→dead 在预算内自动恢复并增加 epoch；持续 alive/unknown 超时后结构化失败，错误含 PID、epoch 和建议；dispose 立即结束等待。

最小测试：alive→dead、持续 alive、持续 unknown、owner 轮换、注册表损坏、等待取消六组确定性时钟/探针用例。

### P0-4 stdio proxy 本地优先与结构化降级

内容：

- 先启动本地 MCP Server，再读取 status/descriptor 并尝试远端连接。
- `doctor` 在 proxy 本地实现，不依赖远端 `tools/list`。
- 本地 doctor 区分：descriptor 缺失、status failed、owner 冲突、descriptor 陈旧、token 不可读、POST 路由缺失、认证失败、远端 draining。
- 远端不可用时，调用远端工具统一返回结构化 `RELAY_ROUTE_UNAVAILABLE`，包含原因码、最近状态和 remediation；不得透传裸 404/405。
- `tools/list` 在不健康时至少暴露本地 doctor。已知远端工具是否静态暴露应通过构建期生成清单决定，禁止手工复制 schema；若 0.2.3 不引入生成清单，则恢复后发送 `tools/list_changed`，并明确客户端需重新发现工具。
- 远端连接按需建立并允许恢复，不要求重启 stdio proxy。

理由：故障时必须先有诊断面；同时正视 MCP 工具发现语义，不能只写“懒连接”而忽略 fresh client 看不到远端工具的问题。

验收标准：endpoint 缺失、POST 405、401、503、status failed 五种情况下客户端均能 initialize 并调用本地 doctor；远端恢复后同一 proxy 可重新连接。

最小测试：扩展 `stdio-proxy-recovery.test.ts`，覆盖上述失败、结构化错误、恢复、tools list 变化与无裸 HTTP 错误泄漏。

### P0-5 修复持久历史终态与最终输出投影

内容：

- 持久 `session.history` 中属于本 run 的 `turn/end` 是终态真源；不得被陈旧 `session.list.running` 或内存快照降级回 `running`。
- 校正 original prompt、steer/reply 插入消息和 turn 边界的归属算法，确保 steer 不会截断同一 run 的最终 assistant 消息。
- 最终文本从 rc.8 `assistant/message.data.message.content` 提取；终态 reconcile 后立即刷新 `status`、`finishedAt`、`lastProgressAt`、`assistantText`。
- 修复 `get_run_summary` 的 `updatedAt`、`elapsedMs` 与 `nextAction`，不得对已完成 run 返回 `wait`。
- 若 Host 最终消息带 `interrupted: true`，0.2.3 至少不能把它当完整成功；完整 additive 字段设计放 0.2.4。

理由：本次 K3 审核已真实复现“Host completed、Relay 永久 running”，属于控制面正确性缺陷。

验收标准：使用本次事件形状的脱敏夹具后，Relay 返回 `succeeded`、完整 A/B/C/D 文本、非空 `finishedAt`，summary 的 elapsed/nextAction 正确；重复 reconcile 幂等。

最小测试：普通完成、运行中 steer 后完成、最终消息晚于先前 assistant 进度、session.list 陈旧 running、重复 reconcile、proxy 断线后重读六组用例。

### P0-6 rc.8 消费面合同夹具与升级交叠集成测试

合同夹具只固定 Relay 真实消费字段：

- `host.describe.home` 及既有字段的加法兼容；
- `session.history.projections.values.imageLimits`，含 `maxImageDimension`、像素、数量、消息总字节和 media types；
- `turn/end` 的已知 reason kind；
- `assistant/message.data.message.content` 与 `interrupted?: true`；
- `session.prompt` 既有响应形状。

升级交叠测试流程：

1. 启动旧 authority/Web 路由；
2. 新 authority 开始并收到 `AUTHORITY_OWNED`；
3. 旧 authority 退出；
4. 新 authority 在预算内接管；
5. 断言 endpoint `updatedAt` 刷新、owner epoch 增长、POST 可用、stdio doctor 恢复；
6. 断言 live/unknown owner 永不被强抢。

Windows 门：进程探针测试不依赖系统默认编码；真实 smoke 使用 UTF-8 环境。PID 启动时间无法可靠核验时保持 fail-closed，不以文件时间替代。

## 5. 0.2.3 doctor 最小输出合同

doctor 至少报告：

- Relay 安装版本、运行模式；
- resolved `dshHome`、profile、state directory；
- profile bundle 是否包含 Relay；
- authority owner PID、processStartedAt、epoch、mode 及探针结果；
- status state、更新时间、最近错误和建议；
- endpoint schema、authority/epoch 对账、新鲜度；
- token 文件存在性/可读性，但不输出 token；
- POST 路由握手结果，并区分 401、404、405、503；
- stdio proxy 本地状态、远端连接状态、最后一次连接错误；
- 综合 `ok` 与稳定错误码，例如 `STALE_ENDPOINT_DESCRIPTOR`、`RELAY_ROUTE_UNAVAILABLE`。

插件 fiber/Host 内部加载进度只有在 rc.8 提供稳定只读接口时才加入；不能通过不稳定内部结构硬取。

## 6. 0.2.4 / 0.3.0 后续计划

### 0.2.4

- 图片校验对齐 Host `imageLimits`：以投影为真源，Relay 配置只在投影缺失时兜底；校验真实 MIME、宽高、像素和 `maxImageDimension`。优先实现格式头解析，避免引入完整图像解码器。
- interrupted/部分输出：增加 additive 的 `assistantInterrupted`、`partialOutput` 或等价字段，映射到现有 `incomplete`；不在补丁中新增破坏性状态枚举。
- doctor 扩展：安装来源、profile bundle 版本、稳定 plugin 状态、限制来源（Host 投影或本地 fallback）。
- standalone doctor 告警：检测同 HostIdentity 的 embedded owner，但不自动抢占。
- 评估 descriptor v2：明确 v1/v2 双读周期、写入顺序、降级和回滚后再实施。

### 0.3.0 或官方协议稳定后

- 删除已公告弃用的 `status_run`，保留迁移说明。
- 设计 standalone 与 embedded 的统一 authority 注册和显式互斥语义。
- 评估 interrupted 独立状态枚举。
- Agent Teams 仅在官方稳定只读能力 API 存在时加入能力发现；写工具单独安全评审。
- 文件/会话引用仅使用官方稳定 Host wire，不自造 MCP 块。

## 7. 明确不做

- 不复制或依赖 Harness SQLite 内部布局。
- 不为 Web 搜索多查询、PowerShell PTY、Python FD3 创建 Relay MCP 工具。
- 不把 `openBrowser` 默认值改为 `true`。
- 不删除 standalone 模式。
- 不按 owner、status 或 endpoint 的文件时间抢占进程。
- 不在 descriptor/status/doctor 中输出 token、Authorization header 或其他凭证。
- 不在 0.2.3 暴露 Agent Teams 写操作或自造文件/会话引用协议。

## 8. 实施顺序与质量门

建议顺序：P0-1 → P0-2 → P0-3 → P0-4 → P0-5 → P0-6 → 文档/版本/发布验证。

代码实施前必须先补齐并读取项目根 `AI-CDL Spec.md`；当前仓库审查时未发现该文件，因此本次只生成计划，不开始代码修改，也不代填 Tier。

代码实施的最低质量门：

1. 按 AI-CDL Tier 完成 PRE-FLIGHT；
2. `pnpm test`；
3. `pnpm run build`；
4. `pnpm run test:mcp`；
5. `pnpm run check:package`；
6. 真实 rc.8 隔离 profile 安装/启动 smoke；
7. 未设置 `DSH_HOME` 的默认启动 smoke；
8. Windows 升级重启交叠 smoke；
9. endpoint epoch、POST 路由、stdio local doctor、终态 reconcile 全部通过；
10. 按项目规范用真实 `Get-Date -Format 'yyyy-MM-dd HH:mm'` 更新 `CHANGELOG.md`。

## 9. 实施前仍需回答的开放问题

1. Cordis 对异步 `ctx.effect` rejection 的稳定日志/UI 合同是什么；Relay status 是补充诊断还是唯一可靠诊断面？
2. `webServer.register` 在 plugin reload 和 dispose 交叠时的路由替换保证是什么？
3. Windows 下是否有不依赖外部 PowerShell/CIM、可可靠校验 PID 启动时间的 Node 原生方案？没有时维持 fail-closed。
4. proxy 不健康时采用“doctor-only tools/list + 恢复通知”，还是引入构建期生成的完整工具清单？0.2.3 实施前必须二选一并写契约测试。
5. `imageLimits` 投影缺失时，本地 fallback 的具体优先级和 doctor 表达应如何固定？
6. 本次 steer 后完成却仍 running 的精确边界错误位于 run 事件归属、session/list 覆盖还是状态持久化合并；实施 P0-5 前用脱敏事件夹具锁定。
