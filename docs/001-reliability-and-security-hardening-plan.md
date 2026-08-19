# 001：可靠性与安全加固计划

## 文档信息

- 状态：执行中（0.2.0 首批增量已完成）
- 日期：2026-08-19
- 适用项目：DSH Relay
- 执行优先级：P0，后续 002、003 的发布门槛
- 目标版本：下一个不兼容边界可控的次版本
- 实施原则：只扩展外部 MCP 控制层，不修改 DeepSeek Harness 产品源码
- 验证原则：所有发布门由自动化测试、故障注入和机器可读报告完成；仅当实现需要改变产品需求、安全边界或发布身份时请求用户选择
- 当前落点：已交付模块化 Facade、schema v2 状态校验与迁移、操作日志和幂等键、结构化未知状态、`incomplete`、只读审查入口、危险权限确认及复用会话权限租约；共享 Broker/事务数据库、Host 协议握手、保留策略和完整故障注入仍按本计划后续里程碑推进

## 一、目标

把 DSH Relay 从“单进程可用的 MCP 适配器”提升为可供多个外部 Agent 并发调用、进程崩溃后可恢复、危险权限不会被错误描述的可靠控制层。

本计划完成后应满足：

1. Codex、Claude Code、Cursor、OpenCode 可同时连接，不发生运行记录相互覆盖。
2. `start / status / wait / reply / cancel` 形成可恢复、可审计的完整异步生命周期。
3. 请求超时或进程退出后能够判断“未执行、已执行、结果未知”，避免重复提交。
4. MCP 工具元数据真实表达只读、工作区写入、完全访问三种 Harness 原生权限的风险。
5. `max-tokens`、需要用户介入、取消等终态不再被误报为成功。
6. 本地状态默认仅当前用户可读，并具备损坏隔离、保留期和清理机制。

## 二、当前证据与问题映射

| 编号 | 当前证据 | 风险 | 本计划落点 |
| --- | --- | --- | --- |
| H1 | 多个 stdio 客户端会启动多个 Relay 进程，默认共用一个 JSON 状态文件；锁只在单进程内生效 | 最后写入者覆盖其他进程的运行记录 | 单实例 Broker、SQLite WAL、事务与唯一约束 |
| H2 | `start_run`、`steer_run`、`reply_run` 被标为非破坏性，即使请求可选择写入或完全访问 | MCP 客户端可能跳过应有的风险确认 | 工具拆分、真实 annotations、显式权限确认 |
| H3 | 首次启动会先持久化 RPC，但 steer/reply/cancel 没有统一操作日志 | 超时后无法可靠判断操作是否已执行，可能重复发消息 | `OperationRecord`、幂等键、未知结果协调 |
| H5 | `max-tokens` 被归为 `succeeded` | 部分结果被当作完整结果，后续 Agent 误判 | 新增 `incomplete` 终态与继续执行指引 |
| M1 | Host 连接缺少身份、协议版本与能力握手 | 连接到错误实例或接口漂移时失败方式不明确 | Host 信任与能力协商 |
| M2 | 状态文件继承 Windows ACL，包含工作区路径、会话 ID 和输出 | 本机其他低权限主体可能读取敏感信息 | 用户级 ACL、最小化存储与保留策略 |
| M3 | 状态只做浅层结构检查，文件损坏可能阻止启动 | 故障恢复能力不足 | 完整 schema 校验、隔离与重建 |
| M4 | 会话复用后未保证恢复原权限 | 完全访问可能滞留到后续任务 | 权限租约和 finally 恢复 |

## 三、范围与非目标

### 本期范围

- Relay 内部模块物理边界和 Facade 唯一出口。
- 多客户端共享 Broker 与持久状态仓库。
- 客户端到 Broker 的本地 IPC 身份认证、运行可见性和控制权隔离。
- 所有写操作的持久化操作日志、幂等和恢复协调。
- MCP 工具风险元数据、权限选择、权限恢复。
- Host 身份、版本、能力和工作区握手。
- 状态隐私、保留、损坏恢复及审计字段。
- `incomplete`、`needs_attention` 等生命周期语义的底层支持。
- 单元、集成、并发、崩溃恢复和安全测试。

### 非目标

- 不修改 DeepSeek Harness 源码或其原生会话/权限模型。
- 不在本期实现公网远程控制、监控 UI、成本面板或多 Host 调度。
- 不在本期完成 npm 正式发布和四类 Agent 的一键安装；由 002 负责。
- 不通过浏览器自动化替代 Host 原生 RPC。

## 四、目标架构与物理边界

新增模块必须以目录根 `index.ts` 为唯一对外出口，跨模块不得导入内部文件。主入口只依赖 Facade。

```text
MCP stdio adapters
        |
        v
Authenticated local IPC
        |
        v
RelayBrokerFacade  <- 唯一业务入口
        |
        +-- RunCoordinator
        +-- OperationJournal
        +-- RunReconciler
        +-- PermissionController
        +-- HostGateway
        +-- StateRepository
```

建议物理结构：

```text
src/
  relay-broker/
    index.ts
    relay-broker-facade.ts
    types.ts
  runs/
    index.ts
    run-coordinator.ts
    run-reconciler.ts
    types.ts
  operations/
    index.ts
    operation-journal.ts
    types.ts
  permissions/
    index.ts
    permission-controller.ts
  host/
    index.ts
    host-gateway.ts
    capability-negotiator.ts
  state/
    index.ts
    sqlite-state-repository.ts
    migrations/
  mcp/
    index.ts
    server-adapter.ts
```

现有 `run-manager.ts` 已接近 600 行熔断线。实施时先建立稳定接口，再把本次涉及的职责迁移到上述模块；不主动重构无关历史代码。

## 五、标准接口草案

```ts
export interface RelayBrokerFacade {
  start(request: StartRunRequest): Promise<RunSnapshot>;
  status(runId: string): Promise<RunSnapshot>;
  wait(request: WaitRunRequest): Promise<RunSnapshot>;
  steer(request: SteerRunRequest): Promise<OperationReceipt>;
  reply(request: ReplyRunRequest): Promise<OperationReceipt>;
  cancel(request: CancelRunRequest): Promise<OperationReceipt>;
}

export interface OperationRecord {
  operationId: string;
  clientPrincipalId: string;
  idempotencyKey: string;
  runId: string;
  kind: "start" | "steer" | "reply" | "cancel";
  rpcId?: string;
  fencingEpoch: number;
  state: "prepared" | "submitted" | "acknowledged" | "unknown" | "reconciled" | "failed";
  messageId?: string;
  receiptRef?: string;
  createdAt: string;
  updatedAt: string;
}

export interface PermissionLease {
  leaseId: string;
  sessionId: string;
  ownerOperationId: string;
  previousPermission: "read-only" | "workspace-write" | "danger-full-access";
  grantedPermission: "read-only" | "workspace-write" | "danger-full-access";
  expiresAt: string;
  state: "acquired" | "restoring" | "released" | "needs_attention";
}

export interface HostCapabilities {
  hostInstanceId: string;
  protocolVersion: string;
  providers: string[];
  models: string[];
  reasoningEfforts: string[];
  permissionModes: Array<"read-only" | "workspace-write" | "danger-full-access">;
}
```

接口落地时必须使用项目实际命名规范，并通过模块根 `index.ts` 暴露；内部实现可替换，MCP 层不得直接依赖 SQLite、RPC 或 Harness 内部类型。

## 六、实施阶段

### 里程碑 1：冻结生命周期与模块边界

- 定义 `RunStatus`、`OperationRecord`、错误码和 Facade 接口。
- 定义 `RunSnapshot` 的必填字段、版本和向后兼容规则，不允许各工具自行拼装不同快照。
- 明确运行状态：`queued / running / needs_attention / succeeded / incomplete / failed / cancelled / unknown`。
- 明确允许的状态转换，并为非法转换提供硬失败测试。
- 为每个 MCP 连接建立 `clientPrincipalId`：同一操作系统用户下的已认证客户端默认可监控运行；steer/reply/cancel 仅允许运行所有者或持有显式共享控制授权的客户端。
- 建立模块根 `index.ts`，增加 lint 或 TypeScript 边界检查。
- 将 `run-manager.ts` 的新增职责移出，确保普通功能文件不超过 600 行。

验收：生命周期图、接口类型、状态转换测试和跨模块导入门全部通过。

### 里程碑 2：统一持久化操作日志

- start、steer、reply、cancel 在调用 Host 前写入 `prepared` 记录。
- 幂等唯一约束固定为 `(clientPrincipalId, idempotencyKey)`；调用方未传 key 时由 Broker 生成并在回执中返回，安全重试必须回传同一 key。
- 重复 key 不返回唯一约束错误，而是返回第一次调用的原始 receipt/snapshot；同 key 不同参数返回 `OPERATION_CONFLICT`。
- Host 调用发出后记录 `rpcId` 和 `submitted`，收到确认后记录结果。
- 超时、断线、进程退出统一进入 `unknown`，禁止直接重试产生重复操作。
- Reconciler 是 `unknown` 状态的唯一写者，并通过 run/session 级 fencing epoch 保证原 RPC 与补偿重试不能并发提交。
- Reconciler 通过 Harness 原生会话事件/历史对账；仅在确认原 `rpcId` 已终结后转为 `reconciled` 或可安全重试。无法证明时保持 `unknown` 并进入自动诊断，不猜测成功。

验收：在操作提交前、提交后未确认、确认后未落盘三个故障点强制杀进程，并模拟原 RPC 在补偿判断后延迟到达；恢复后均不重复提交，重复 key 始终返回原回执。

### 里程碑 3：共享 Broker 与事务状态仓库

- 引入本机单实例 Relay Broker；各 stdio MCP 进程仅作为薄适配器。
- Windows 优先使用当前用户 ACL 保护的命名管道，macOS/Linux 优先使用用户专属 Unix socket；loopback TCP 只作为显式兼容回退且必须配对认证。
- 使用 SQLite WAL 或等价的事务存储，建立 run、operation、event、client 索引。
- 通过数据库唯一约束保证 operation 幂等，通过事务保证 run 与 operation 一致更新。
- Broker 启动包含系统级互斥/存活探测、stale lock 处理、健康检查、并发自动拉起仲裁和版本兼容检查。
- SQLite 状态必须位于本地磁盘，显式配置 `busy_timeout`、WAL checkpoint/增长上限；数据库保存单调 schema 版本，旧二进制遇到新 schema 必须拒绝写入。
- Broker 有活动 run 时不得因 idle policy 退出；无活动任务时的退出与自动拉起策略由机器可读健康检查验证。
- 提供旧 JSON 状态的一次性迁移、备份和可回滚路径。

验收：至少三个独立 MCP 客户端并发创建、等待、回复和取消 100 轮，整个测试连续通过 10 次；未授权本机进程无法连接 Broker，且无丢失、覆盖、重复或交叉污染。

### 里程碑 4：真实风险标注与权限租约

- 提供固定只读的 `start_review`，其权限不可被调用方升级。
- 通用 `start_run` 明确标为可能产生外部副作用，写入和完全访问必须显式传参。
- `danger-full-access` 要求客户端传递明确确认字段；`start_run`、steer、reply、cancel 的 MCP annotations 均不得错误标为只读或幂等，`start_review` 的不可升级约束由 Broker 服务端强制执行。
- 权限设置在提交首条提示词前完成，并把 Host 实际返回的权限写入快照。
- 权限租约作为持久记录保存先前权限、目标权限、所有者、fencing epoch 和到期时间；同一 session 的获取→提交→释放必须单写者串行化。
- 操作结束、失败或取消后在 `finally` 恢复先前权限；Broker 重启和会话复用前必须自动协调未释放租约，无法恢复时将会话置为 `needs_attention` 并禁止复用。

验收：只读工具无法写工作区；写入/完全访问在支持确认的客户端出现风险提示；在提权后强制杀进程、并发请求不同权限和恢复 RPC 失败三种情况下，均不会让后续任务静默继承提升权限。

### 里程碑 5：Host 信任与能力协商

- 连接后先查询 Host 实例 ID、协议版本、工作区、Provider、模型、推理强度、preset 和权限能力。
- 将用户请求与 Host 返回目录匹配；不再进行 K3 到其他模型的猜测映射。
- 使用系统凭据库保存且可轮换的本机配对令牌或等价机制，拒绝未配对进程和非 loopback 地址。
- 协议协商定义最低/最高兼容版本；超出范围时在提交任务前返回稳定错误码。
- 不支持的能力返回稳定错误码和可选值，不提交首条提示词。

验收：连接错误实例、旧协议、模型不存在、权限不支持时均在启动任务前失败，并给出机器可读原因。

### 里程碑 6：状态隐私、保留与损坏恢复

- 状态目录和数据库采用当前用户专用 ACL；安装和升级时验证 ACL。
- 输出、路径和会话标识按最小化原则存储，并支持关闭内容持久化；字段级加密需先完成威胁模型，密钥不得与数据库同目录，令牌只能进入系统凭据库。
- 完整 schema 校验；损坏数据库自动隔离为带时间戳的备份，并优先从 Host 历史/操作日志重建。无法重建时创建新库、保留隔离副本并输出自动诊断报告。
- 支持保留期、归档、按 run 清除和全量清理；默认保留天数、清理周期和活动 run 例外必须在配置 schema、README 与自动化测试中保持一致。
- `max-tokens` 映射为 `incomplete`，保留部分结果并返回继续执行建议。

验收：非当前用户主体不能读取状态；损坏注入不会导致静默丢失；过期清理不影响活动运行；`max-tokens` 不再报告成功。

## 七、错误与结果契约

所有 MCP 工具同时返回稳定 `structuredContent` 和人类可读文本。错误至少包含：

- `code`：稳定错误码。
- `retryable`：当前是否允许安全重试。
- `operationId`：存在写操作时必填。
- `runId`：已建立运行时必填。
- `lastKnownState`：最后可信状态。
- `nextAction`：例如 wait、reply、reconcile、重新选择模型。

本期至少定义：`HOST_UNREACHABLE`、`HOST_UNTRUSTED`、`CAPABILITY_UNSUPPORTED`、`OPERATION_UNKNOWN`、`OPERATION_CONFLICT`、`CLIENT_UNAUTHORIZED`、`RUN_CONTROL_FORBIDDEN`、`PERMISSION_DENIED`、`STATE_CORRUPT`、`RUN_INCOMPLETE`。

## 八、测试与质量门

- 单元测试：状态转换、幂等键、权限租约、能力匹配、错误映射。
- 集成测试：真实 Broker + SQLite + 模拟 Host，覆盖全生命周期。
- 故障注入：每个持久化边界前后杀进程、断开 RPC、重复响应、乱序事件。
- 并发测试：Codex、Claude、Cursor 风格的三个独立 stdio 进程同时运行。
- 安全测试：IPC ACL、未配对连接、非 loopback、跨客户端越权控制、危险权限确认、提权后崩溃恢复、状态清理。
- 兼容测试：旧 JSON 状态迁移、旧客户端缺省参数、旧 Host 能力不足。
- 可行性门：实施操作日志前自动验证 Harness 历史事件能否提供 `rpcId/messageId/终态` 对账证据；不足时先穷尽自动对账并为永久 `unknown` 启用 TTL 与诊断报告，只有继续重试会改变安全/幂等要求时才请求用户选择，且绝不自动重试。
- 文档门：README、中文 README、MCP 工具 schema、JSDoc 与 CHANGELOG 同步。
- 编码门：所有新增文件 UTF-8 无 BOM，跨进程通信显式 UTF-8。

## 九、迁移、灰度与回滚

1. 首次启动先只读检查旧 JSON，生成数据库并校验条目数量和关键字段。
2. 校验通过后把旧文件重命名为备份，不立即删除。
3. 用功能开关允许单机开发环境暂时回退旧存储，但正式发布默认 Broker；回退属于灾难恢复，必须生成状态时点与数据差异报告。
4. 数据库 schema 使用向前迁移；降级时只读取兼容字段，禁止旧版本覆盖新数据。
5. 若回退旧存储，必须先从 SQLite 反向导出兼容快照；无法导出时拒绝回退，禁止让旧库和 SQLite 双向分叉。
6. 危险权限策略不得通过回滚关闭；回滚只能恢复实现，不能降低安全门槛。

## 十、风险登记

| 风险 | 级别 | 缓解措施 |
| --- | --- | --- |
| Broker 成为单点故障 | 高 | 健康检查、自动拉起、WAL 恢复、客户端重连 |
| 幂等与 Harness 事件无法完全对应 | 高 | 保留 `unknown`，不猜测成功；通过历史事件和消息 ID 对账 |
| SQLite 打包增加平台差异 | 中 | 选择成熟跨平台驱动，Windows/macOS/Linux CI 验证 |
| 权限恢复失败 | 高 | 显式暴露 `needs_attention`，阻止会话复用并提示用户 |
| 旧状态迁移遗漏 | 中 | 双读校验、备份、迁移报告和可逆切换 |
| Broker IPC 被同机未授权进程调用 | 高 | 用户级 IPC ACL、配对认证、主体归属和越权测试 |
| 权限租约期间进程崩溃 | 高 | 持久租约、启动协调、session fencing、失败时禁止复用 |

## 十一、完成定义

- H1、H2、H3、H5 及 M1–M4 均有实现、自动化测试和用户文档。
- 三客户端并发与崩溃恢复测试连续通过。
- 幂等重复提交、延迟 RPC、权限租约崩溃、IPC 越权和 schema 降级测试全部自动通过。
- 所有工具具备 `outputSchema`、稳定错误码和准确 annotations。
- 没有修改 DeepSeek Harness 产品源码。
- 代码实施时已按真实时间更新插件根 `CHANGELOG.md`。
- 主审确认可冻结 `RelayBrokerFacade`、运行状态和操作记录契约，002 才可进入实现。

## 十二、交付物

- `RelayBrokerFacade` 及各模块根出口。
- Broker 进程、SQLite 状态仓库和迁移工具。
- 完整异步生命周期与操作日志。
- Host 信任/能力握手和权限租约。
- 自动化测试、故障注入测试和安全测试报告。
- 更新后的 MCP schema、README、README.zh-CN、JSDoc 和 CHANGELOG。

> 风险编号说明：H4 专属于 002 的分发与发布风险，本计划保留 H1/H2/H3/H5，不做重复编号或重新编号。
