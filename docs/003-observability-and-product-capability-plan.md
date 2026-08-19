# 003：监控与产品能力演进计划

## 文档信息

- 状态：执行中（0.2.0 并行准备已完成）
- 日期：2026-08-19
- 适用项目：DSH Relay
- 执行优先级：P2
- 前置依赖：001 可靠性和安全门已通过；002 的四客户端接入与发布通道已稳定
- 产品定位：The MCP control plane for DeepSeek Harness
- 验证原则：状态、通知、产物、多 Host 与远程安全均以自动化契约测试、故障注入和跨客户端 E2E 验收；仅改变产品需求、安全策略或远程信任模型时请求用户选择
- 当前落点：已交付状态投影、稳定 attention reason/next action、有界通知缓冲、`CURSOR_EXPIRED`/gap/重同步元数据和轮询降级能力；真实 MCP 通知 transport、产物、多 Host、历史索引和受控远程模式尚未启用

## 一、目标

在可靠异步底座和跨 Agent 接入稳定后，把 DSH Relay 建设为成熟的 DeepSeek Harness 对外控制层：长任务可持续监控、需要介入时可被发现、结果和产物可消费、多 Host 可选择，并为经过认证的远程模式预留标准接口。

本计划完成后应满足：

1. 外部 Agent 能获取结构化进度、耗时、模型、权限、token/成本信息及下一步操作。
2. Harness 等待输入、达到 token 上限、Host 断开时不会悄悄结束，而会触发明确关注状态。
3. 报告、diff、图片和其他产物通过 MCP Resource/ResourceLink 返回，不把大对象全部塞进文本。
4. 多个本地 Harness Host 可发现、验证和显式选择，不依赖猜端口。
5. 远程能力只通过认证、授权、加密的 MCP 传输暴露，绝不直接公开 Harness 3080 端口。

## 二、范围与非目标

### 本期范围

- 结构化运行摘要、进度与关注状态。
- MCP logging/progress 通知和断线补发。
- 产物索引、ResourceLink 和受控读取。
- 本地多 Host 发现、选择和健康状态。
- 运行历史、保留、筛选和诊断统计。
- 认证 Streamable HTTP 远程网关的受限版本。
- 面向客户端的能力发现和兼容降级。

### 非目标

- 不修改 Harness Web UI 或原生事件格式。
- 不自行实现模型推理、Provider 代理或浏览器遥控。
- 不默认启用公网访问，不把配对令牌当作完整企业身份系统。
- 不在未经用户许可时上传提示词、源码、输出或遥测。
- 不在本期引入自动执行任意工作区写入的策略引擎。

## 三、目标架构与物理边界

```text
MCP clients
    |
    v
RelayBrokerFacade (001)
    |
    +-- MonitoringFacade
    +-- ArtifactFacade
    +-- HostDiscoveryFacade
    +-- NotificationFacade
    +-- RemoteGatewayFacade
```

职责边界：

- `MonitoringFacade`：聚合运行事件并产生摘要，不直接访问 MCP transport。
- `ArtifactFacade`：登记、授权和解析产物，不负责任务生命周期。
- `HostDiscoveryFacade`：发现及选择 Host，不保存运行结果。
- `NotificationFacade`：把内部事件转换为 MCP logging/progress，不改变运行状态。
- `RemoteGatewayFacade`：认证、会话绑定、速率限制和策略执行，只调用 `RelayBrokerFacade`。

建议物理结构：

```text
src/
  monitoring/
    index.ts
    monitoring-facade.ts
    summary-builder.ts
  artifacts/
    index.ts
    artifact-facade.ts
    resource-resolver.ts
  discovery/
    index.ts
    host-discovery-facade.ts
  notifications/
    index.ts
    notification-facade.ts
  remote/
    index.ts
    remote-gateway-facade.ts
    policy-enforcer.ts
```

各模块通过根 `index.ts` 唯一暴露。远程层不得导入 Host RPC 内部实现，也不得绕过 001 的权限、操作日志和状态仓库。

## 四、标准接口草案

```ts
export interface MonitoringFacade {
  getSummary(runId: string): Promise<RunSummary>;
  list(query: RunQuery): Promise<RunPage>;
  subscribe(request: SubscriptionRequest): AsyncIterable<RunNotification>;
}

export interface RunSummary {
  runId: string;
  status: RunStatus;
  attention?: { reason: AttentionReason; detail?: string; requestedInput?: string };
  provider?: string;
  model?: string;
  reasoningEffort?: string;
  permissionMode: PermissionMode;
  startedAt?: string;
  updatedAt: string;
  elapsedMs?: number;
  progress?: { completed?: number; total?: number; message?: string };
  usage?: { inputTokens?: number; outputTokens?: number; estimatedCost?: number };
  nextAction: "wait" | "reply" | "cancel" | "open-session" | "none";
}

export interface ArtifactDescriptor {
  artifactId: string;
  runId: string;
  kind: "file" | "diff" | "image" | "report" | "log";
  mimeType: string;
  size: number;
  resourceUri: `relay+artifact://${string}`;
  expiresAt?: string;
}

export interface HostDescriptor {
  hostInstanceId: string;
  hostIdentity?: string;
  workspace: string;
  webUrl?: string;
  health: "healthy" | "degraded" | "unreachable";
  capabilitiesHash: string;
}

export type AttentionReason =
  | "await_user_answer"
  | "permission_confirm"
  | "host_disconnected"
  | "permission_restore_failed";

export interface RelayCapabilities {
  contractVersion: string;
  features: Record<string, { enabled: boolean; version: string; fallback?: string }>;
}
```

usage 字段只能报告 Harness/Provider 明确提供的数据；缺失时保持未知，不做伪精确估算。

`RunStatus`、`PermissionMode` 及状态迁移由 001 的模块根出口唯一提供，003 不重复定义第二套状态机。`MonitoringFacade` 只维护版本化的状态投影：

| 001 状态 | 默认 `nextAction` | 允许的例外 |
| --- | --- | --- |
| `queued` / `running` / `unknown` | `wait` | `unknown` 可返回自动诊断入口，但不得自动重试 |
| `needs_attention` | `reply` | 权限恢复失败时只允许 `open-session` 或诊断，不继续复用 |
| `incomplete` | `reply` | 无可继续上下文时为 `open-session` |
| `succeeded` / `failed` / `cancelled` | `none` | 仅当存在可验证 Web 会话时可附加 `open-session` |

投影规则、例外原因和版本必须通过 `RelayCapabilities` 可发现，客户端不得解析自然语言决定下一步。

## 五、功能阶段

### 里程碑 1：运行摘要与关注状态

- 从 001 的事件和状态生成稳定 `RunSummary`。
- `needs_attention` 使用稳定的 `AttentionReason` 枚举区分等待用户回答、权限确认、Host 断开、权限恢复失败，附加说明写入 `detail`。
- `incomplete` 区分：Host 明确因 max tokens 或执行预算结束并保留部分结果；客户端停止读取但 Host 仍执行时继续保持 `running`。
- 摘要返回最后活动时间、Provider、模型、推理强度、权限、进度和下一步。
- Web 会话链接必须先通过 Host 实例和可达性校验；不可达时返回原因而非坏链接。

验收：每个非终态和终态均按版本化投影表产生唯一、可执行的 `nextAction`；V4-Flash/MAX 结果被丢弃类故障能通过事件日志自动定位到事件、连接或结果持久化阶段，不要求用户查看浏览器控制台。

### 里程碑 2：通知与断线续传

- 通过 MCP progress/logging 通知状态变化、阶段进度和关注事件。
- 每条通知带递增 cursor/eventId，客户端重连后可从游标补发。
- 通知 cursor 具有明确保留水位；默认补发缓冲至少 24 小时且不得短于事件保留期中承诺的重连窗口。过期返回 `CURSOR_EXPIRED`，客户端自动执行 `getSummary` 快照同步并取得新 cursor。
- 支持按 run、客户端和严重级别订阅，避免全局噪声。
- 通知仅是投影，真实状态仍以 Broker 数据库为准。
- 客户端不支持通知时自动降级为 `wait/status` 轮询。
- 每个订阅使用有界队列；初始默认上限为 1000 条或 8 MiB。溢出时发送 `resync-required`/gap 标记并关闭旧游标，不静默丢事件，也不阻塞 Harness 事件采集。
- 能力降级根据 MCP initialize capabilities、progress token 支持和显式 client profile 自动判定；轮询采用带抖动的指数退避并设置最大间隔。

验收：断线 10 分钟后恢复连接可补齐事件；游标过期和队列溢出能自动快照重同步；重复通知不会造成重复 reply/cancel；慢客户端不会阻塞 Harness 事件采集。

### 里程碑 3：产物与资源链接

- 从 Harness 原生消息/事件中提取可验证的文件、diff、图片和报告引用。
- 使用 MCP Resource/ResourceLink 返回元数据和受控读取 URI。
- URI 采用不透明 `relay+artifact://<artifactId>`，不包含本机路径；所有读取统一经过 `ArtifactFacade` 的 run 归属、客户端身份、工作区边界和保留期检查。
- 对路径做工作区边界检查，禁止目录穿越、符号链接越界和任意本机文件读取。
- 图片验证 MIME、魔数、尺寸和大小；大文件使用流式读取或分块，不全量解码进内存。
- HTML、SVG 等主动内容默认作为 attachment 下载或安全转义，禁止直接内联执行；类型白名单之外的内容统一使用 `application/octet-stream`。
- 资源设置权限、保留期和访问审计；远程模式默认不暴露本地路径。
- 初始自动化基线：单产物最大 64 MiB、最多 4 个并发读取流、每流缓冲不超过 1 MiB；阈值可配置但放宽必须重新通过内存/背压测试。产物过期返回稳定错误码，run 删除时同步删除产物或保留不可读取墓碑。

验收：四类客户端可打开小型报告/图片；越界路径、伪造 MIME 和主动内容内联被拒绝；以 64 MiB × 4 并发流压测时 Broker 额外内存增长保持在自动化基线阈值内且不会阻塞运行事件。

### 里程碑 4：本地多 Host 发现与选择

- Host 目录只来自 Relay 已持久化的 `start_service` 附件、用户显式配置的 endpoint 和成功完成 001 握手的实例；不要求修改 Harness，不扫描随机端口，也不根据浏览器标签猜测实例。
- `start_run` 可显式传 `hostId` 或使用可解释的工作区匹配规则。
- 多个候选冲突时返回列表让调用方选择，不猜测端口或默认连接最后启动实例。
- `hostInstanceId` 表示一次 Host 启动实例；Host 能提供稳定身份时另存 `hostIdentity`。无法提供稳定身份时，以已验证 endpoint、工作区和原 session 归属联合恢复，任何冲突都要求显式选择，不把旧会话错误挂到新 Host。
- 维护健康状态和最后成功连接时间。

验收：两个不同工作区和端口的 Harness 同时运行时，100% 路由到用户指定实例；Host 重启和 endpoint 复用由自动化 fixture 覆盖；目标不可达时不自动改投其他 Host。

### 里程碑 5：历史、保留与诊断

- 提供分页 `list_runs`、按状态/客户端/模型/时间筛选和运行摘要。
- 提供 `diagnose_run`，展示最近事件、未知操作、Host 连接和恢复建议。
- 支持用户主动清除、按保留期清理和导出最小诊断包。
- 诊断包默认脱敏提示词、路径、令牌和输出内容。
- 指标优先本地展示；任何遥测必须显式 opt-in。

验收：一万条历史记录和一百万事件下，分页/唯一键查询满足预先声明的延迟与内存预算；存在性查询使用 Set、键到记录使用 Map/数据库索引，并通过查询计划证明热路径无重复全表扫描。

### 里程碑 6：受控远程模式

- 使用 MCP Streamable HTTP 或届时稳定标准，置于独立 `RemoteGatewayFacade`。
- 强制 TLS、身份认证、权限策略、速率限制、审计和运行隔离；公网部署使用受信 CA 证书，私有部署使用显式证书指纹固定或组织 CA，配对令牌不能代替 TLS 身份验证。
- 严格校验 `Origin`、`Host`、协议版本和内容类型，防止 DNS rebinding、跨来源调用和协议降级。
- 默认关闭；首次启用显示监听地址和风险，禁止默认监听所有网卡。
- 远程请求仍使用 Harness 原生三种权限，且服务端可设置最高权限上限。
- 传输会话策略通过 MCP 协议版本协商：支持无状态版本时使用显式 runId/operationId 作为业务句柄，不硬编码 `MCP-Session-Id`；兼容旧版本时隔离并验证其传输会话。
- 不直接暴露 Harness Web/Host 3080；Web 链接仅在有安全反向代理和访问授权时返回。

验收：无效 Origin/Host、未认证、过期凭据、跨工作区、权限升级、协议降级和重放请求全部被拒绝；安全扫描、自动威胁测试和独立威胁模型审查通过后才可标记稳定。

## 六、MCP 能力扩展建议

在兼容旧工具的前提下逐步提供：

- `list_runs`：分页查询历史和活动运行。
- `get_run_summary`：一次获取适合 Agent 决策的摘要。
- `list_artifacts` / `read_artifact`：产物发现与受控读取。
- `list_hosts` / `get_host_capabilities`：本地 Host 发现和能力目录。
- `diagnose_run`：故障分层和恢复建议。
- `subscribe_run`：若目标 MCP SDK 支持可靠订阅，则暴露通知入口；否则使用协议原生 progress/logging。
- `get_relay_capabilities`：返回 contract version、能力开关、版本和降级路径，客户端不通过试错猜能力。

所有新增工具必须提供 `inputSchema`、`outputSchema`、准确 annotations、错误码、能力版本和降级行为。

## 七、安全与隐私要求

- 只读、工作区写入、完全访问继续直接映射 Harness 原生参数，不自行发明第四种权限。
- 资源访问必须同时检查 run 归属、客户端身份、工作区边界和保留期。
- 远程令牌不可写入普通状态表或日志；使用系统凭据存储或等价安全存储。
- Web URL 不携带长期密钥；短期访问票据需一次性或短时有效。
- 所有远程管理动作进入审计日志，审计日志可导出且默认脱敏。
- 遥测、崩溃报告和成本统计默认本地；上传必须单独同意并可撤回。

## 八、测试与质量门

- 摘要一致性：事件乱序、重复、缺失时结果可解释。
- 通知测试：重连补发、游标过期、gap/resync、背压溢出、降级轮询、客户端断开。
- 产物安全：路径穿越、符号链接、MIME 欺骗、超大文件、恶意图片头。
- 多 Host：冲突端口、Host 重启、同工作区多实例、错误实例拒绝。
- 性能：一万运行记录、一百万事件的索引查询和清理基准。
- 远程安全：Origin/Host、DNS rebinding、认证、授权、重放、限流、TLS、协议协商、跨租户/工作区隔离。
- 可行性门：自动验证 Harness 原生事件是否提供 max-tokens/执行预算等终止原因；缺失时统一标记未知终止原因，不用启发式伪造 `incomplete` 原因。
- 跨客户端 E2E：Codex、Claude Code、Cursor、OpenCode 对摘要、通知降级和 ResourceLink 的兼容。
- 文档、JSDoc、UTF-8 无 BOM、模块边界和 CHANGELOG 门。

## 九、上线顺序与功能开关

1. 先上线本地运行摘要、`needs_attention` 和历史/事件存储底座，保持现有工具兼容。
2. 在历史底座上上线诊断与游标补发，再上线通知；客户端始终允许自动降级轮询。
3. 产物能力先只读、本地、小文件白名单，稳定后扩大到已通过压测的上限。
4. 多 Host 先要求显式选择，经过自动化 fixture 验证后再提供可解释默认规则。
5. 远程模式作为实验功能默认关闭，独立威胁模型和版本通道；不得与普通本地版本静默同时开启。

每个阶段均可通过能力开关关闭新增投影层，但不得回滚 001 的安全、持久化和权限保证。

## 十、风险登记

| 风险 | 级别 | 缓解措施 |
| --- | --- | --- |
| 进度/成本数据不完整导致误导 | 中 | 标明来源和未知值，不伪估算 |
| 通知风暴拖慢 Broker | 高 | 事件合并、背压、订阅过滤、状态与通知解耦 |
| 产物接口泄露本机文件 | 高 | 工作区边界、真实路径检查、run 归属、审计 |
| 多 Host 自动路由错误 | 高 | 冲突时强制选择，不静默故障转移 |
| 远程控制扩大攻击面 | 高 | 默认关闭、独立网关、TLS/认证/限流/策略、外部安全审查 |
| 历史数据增长 | 中 | 索引、分页、TTL、归档和配额 |
| 游标过期或慢客户端产生静默事件缺口 | 高 | 有界队列、gap 标记、快照重同步、保留水位 |
| 主动内容通过产物在客户端执行 | 高 | 不透明 URI、下载/转义、类型白名单、内容安全测试 |

## 十一、完成定义

- 所有新增能力只调用稳定的 `RelayBrokerFacade`，不绕过 001。
- 四类 Agent 均能读取结构化摘要、关注状态和受控产物；不支持通知时可安全轮询。
- 游标过期、队列溢出、Host 重启和产物超限均由自动化测试恢复或明确失败，不要求用户手工判断状态。
- 多 Host 选择无隐式猜测，Web 链接发出前经过实例和可达性验证。
- 远程模式通过威胁模型、安全测试和明确 opt-in，且不暴露 Harness 原生端口。
- 数据查询具备必要索引，保留与清除策略可验证。
- 没有修改 DeepSeek Harness 产品源码。
- 代码实施时已按真实时间更新插件根 `CHANGELOG.md`。

## 十二、交付物

- `MonitoringFacade`、运行摘要、关注状态和诊断工具。
- `NotificationFacade`、MCP progress/logging 与断线续传。
- `ArtifactFacade`、ResourceLink 和安全资源读取。
- `HostDiscoveryFacade`、多 Host 目录和健康检查。
- 可选的 `RemoteGatewayFacade`、威胁模型和安全测试报告。
- 更新后的 MCP schema、README、README.zh-CN、运维/隐私文档和 CHANGELOG。
