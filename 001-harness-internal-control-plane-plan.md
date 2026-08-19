# 001：Harness Relay MCP 注册为 Harness 内部 MCP 控制面的实施计划

## 文档信息

- 状态：001A–001H 主链已完成并通过自动验收；001G 事件加速已完成，状态化服务端推送仍按原决策后置
- 形成时间：2026-08-19 21:36（Asia/Shanghai）
- 目标项目：`harness-relay-mcp`
- 目标定位：The MCP control plane for DeepSeek Harness.
- 安装形态：DeepSeek Harness 树外 Cordis bundle；不修改 DeepSeek Harness 产品源码
- 兼容形态：Harness 内嵌控制面 + Streamable HTTP MCP + 通用 stdio proxy + 显式 standalone 兼容模式
- 首发范围：DeepSeek Harness `web` profile、本机回环访问、自动化验收
- 非目标：把 Relay 注册进 Harness 的 `dsh-mcp-client`、把 Relay 工具暴露给 Harness 自身模型、首版开放远程网络访问、修改 `D:\AI\deepseek-harness` 的产品代码

## 一、评审输入与主进程结论

本计划综合了三路证据：

1. K3 / MAX 对 Relay 与 Harness 授权源码的独立只读审查。
2. DeepSeek V4-Flash / MAX 对同一方案和同一基线的独立只读审查。
3. Codex 主进程对 Harness `ApiProxy`、`InProcessApiClient`、`PermissionPresetService`、`WebServer`、bundle/profile 文档及当前 Relay 实现的逐项复核。

两路 Harness 审查共同确认：混合架构可行；正式 bundle、单状态权威、权限 seam、认证、进程排他、双产物打包、真实 profile 测试是开工前必须冻结的边界。

主进程作出以下最终取舍：

| 建议 | 结论 | 主进程理由 |
| --- | --- | --- |
| 保留混合架构 | 吸收 | 内嵌模式减少 HTTP 绕行，stdio proxy 保证 Codex 等客户端兼容，standalone 保留回滚路径。 |
| `ctx.apiProxy` 覆盖全部能力 | 修正 | 它覆盖 session/workspace/model/prompt/history/cancel/events，但不提供权限写入口。 |
| 用 `session.prompt` 发送 `/permission` | 不吸收 | 主进程核对 `api-proxy.ts` 后确认该方法会直接构造并排队 `UserMessage`，不负责执行 command registry；不能拿它替代权限选择。 |
| 内部权限调用 `ctx.permissionPresets` | 吸收并定案 | `PermissionPresetService.set(session, preset)` 是原生写入口；配合 `ctx.sessions` 定位会话，并在提交首条任务前回读确认。 |
| Gateway 暴露通用 `call/callRemote` | 不吸收 | 过宽接口会泄漏传输和方法字符串；采用语义化接口与 Facade 唯一出口。 |
| 首版无状态 Streamable HTTP | 吸收 | 工具调用、30 秒 `wait_run` 和拉取通知均可工作，兼容面与清理语义更简单；状态化 SSE/服务端通知后置。 |
| 首版开放 `0.0.0.0` 条件模式 | 不吸收 | 首版只允许 loopback；检测到 `webServer.host === '0.0.0.0'` 直接拒绝加载。远程模式另行威胁建模。 |
| 全生命周期 owner lock | 吸收 | 短时文件写锁不能阻止 embedded 与 standalone 同时控制同一 Host。 |
| embedded 状态放入 Harness 作用域 | 吸收 | 避免复用 `%LOCALAPPDATA%/dsh-relay/state.json` 与 standalone 互相污染。 |
| 直接 HTTP 首发覆盖所有客户端 | 修正 | 通用默认路径为 stdio proxy；已通过兼容测试的客户端才文档化直接 HTTP。 |

### 1.1 本轮二次审查修正

主进程在开工前发现并修复以下计划级问题：

1. 原计划要求把现有 `src/server.ts` 改成 `src/server/`，会无必要地移动稳定历史入口并扩大冲突面；改为新增 `src/mcp-server/`，现有文件只做兼容转发，待确有需要时再收口。
2. 原计划只描述 token 文件，没有定义 proxy 如何发现动态 Host URL、token 路径和 authority；新增用户级、非密钥的 endpoint descriptor，作为 embedded 与 proxy 的唯一发现接口。
3. 原计划把 `clientPrincipalId` 误写成认证主体；Bearer 负责认证，principal 仅用于稳定幂等命名空间，两者必须分离。
4. 原计划假设 headless 缺少 inject 会立即给出清晰失败；Cordis 依赖等待行为不能代替产品级 preflight，改为安装/doctor 主动阻止非 web profile。
5. 原计划没有限制首次实现范围，容易让 Gateway、state v3、bundle、HTTP 和 proxy 同时改动共享文件；本轮只批准 001A + 001B，001C 以后不得提前写入。

### 1.2 001A/001B 执行记录

1. Codex 子代理按独占文件范围完成 `permission-gateway`，主进程逐文件复核并接入现有权限租约控制器；专项与全量测试通过。
2. 主进程完成 `harness-gateway`、现有 HTTP 调用迁移、Gateway 构造注入、共享 `MonitoringFacade`、golden contract 与模块边界测试；通用 `call/callRemote` 仅保留在 HTTP adapter 内部。
3. 本轮新发起的 K3/MAX 只读审查成功选中 `kimi-coding/k3/max` 并持久接收任务，但模型端两次返回 `403 AUTH`（计费周期额度用尽），未产生可采纳的审查正文；不得把该运行记为成功评审。
4. K3 失败运行反向暴露了一个真实对账缺口：Harness 插件注入的 runtime-context 也使用 `user/message` 事件。现已改为仅以带用户 `rpcId` 的消息划分下一轮，并用真实失败会话验证运行从错误的 `running` 收敛为 `failed/AUTH`。
5. 001A/001B 自动验收覆盖 TypeScript strict、完整测试、MCP smoke、真实 Host 能力发现、发布白名单和 UTF-8/BOM；没有修改 `D:\AI\deepseek-harness` 产品源码，也没有提前实现 001C+。

### 1.3 001C–001H 完成记录

1. 001C 完成 state schema v3、Host authority 全生命周期 lease、陈旧 owner 的 PID 校验恢复、endpoint descriptor 原子发布及 embedded/standalone 状态隔离；多进程竞争和崩溃恢复测试已覆盖。
2. 001D 完成官方 Cordis bundle、`InProcessApiClient(toFetchHandler(ctx.apiProxy))`、原生 `permissionPresets` adapter，以及实际 rpcId 在 Host dispatch 前的持久关联；没有手写或复制 Harness dispatch。
3. 001E 完成仅回环、Bearer 认证的无状态 Streamable HTTP MCP，覆盖 Host/Origin、协议、方法、body、并发、速率、draining 与 token 文件边界。
4. 001F 完成无业务状态的通用 stdio proxy、稳定 principal、动态 descriptor/token 发现和 Host 重启后的自动恢复；Codex、Claude Code、Cursor、OpenCode 配置由 setup Facade 生成。
5. 001G 完成 `events.mux/host` 实时加速、seq 去重/乱序/gap/overflow、断流重连、durable-history rebase 和 polling 降级；approval/question 只发 attention 通知，不自动批准。状态化 HTTP 服务端推送仍按本计划“后置”决策保留为未来增强。
6. 001H 完成双入口/三产物发布、可选且带版本范围的 Harness peers、隔离 profile 的 add/dump/start/MCP/start_run/异常重启/remove、真实 web profile 安装及机器可读验收报告。
7. 最终基线为 116 项自动测试全部通过；TypeScript、build、MCP smoke、package 白名单、8 MiB 门、Codex plugin validator、Skill validator 和 UTF-8/BOM 检查均纳入发布门。

## 二、已验证的事实基线

1. 当前 Relay 是独立 stdio MCP Server，`RelayFacade` 内部构造 `HostClient` 并通过 `/api/<method>` 控制 Harness。
2. 当前包没有 `dsh.bundle`、`cordis.patch.yml` 或 Harness 子路径入口。
3. Harness 官方 bundle 声明是嵌套字段：

   ```json
   { "dsh": { "bundle": { "patch": "./cordis.patch.yml" } } }
   ```

4. 官方安装路径是 `dsh plugin --profile web add <package-or-tarball>`；`dsh --profile web --dump-config` 用于只读验证配置层。
5. `ctx.apiProxy` 是传输无关权威 API；Harness 已提供 `InProcessApiClient(toFetchHandler(ctx.apiProxy))`，可在不走网络的情况下保持与 Fetch 载体一致的协议语义。
6. `ctx.apiProxy.sessions` 覆盖 list/create/history/models/selectModel/prompt/updateQueue/cancel；`workspace`、`host`、`events` 也有正式接口。
7. 权限写入口属于 `ctx.permissionPresets.set(session, preset)`，当前外部 Relay 使用的 `commands/execute` 不属于 `ApiProxy` 契约。
8. `ctx.webServer.register` 支持 exact/prefix 路由并返回 disposer；它本身不提供认证、Origin、Host、请求体或限流保护。
9. MCP SDK 当前提供与 Node `IncomingMessage`/`ServerResponse` 兼容的 `StreamableHTTPServerTransport.handleRequest`。
10. 当前状态、操作日志、权限租约和文件锁可以复用，但需要增加 authority 身份与全生命周期排他。

## 三、最终目标架构

```text
Codex / Claude Code / Cursor / OpenCode
        │
        ├─ 通用默认：stdio proxy（不保存业务状态）
        └─ 认证后直连：Streamable HTTP MCP
                         │
                         ▼
          /plugins/dsh-relay/mcp（loopback + Bearer）
                         │
                         ▼
            EmbeddedRelayPluginFacade
                         │
          ┌──────────────┼────────────────┐
          ▼              ▼                ▼
   RelayFacade   HarnessGatewayFacade   PermissionGatewayFacade
   单一 Broker      语义化宿主接口           原生权限接口
          │              │                │
          │     InProcess / HTTP      permissionPresets
          └──────────────┴────────────────┘
                         │
            Harness 原生 session/event/history
```

架构约束：

- embedded 进程中的 `RelayFacade` 是该 Harness Host 的唯一运行、操作日志、权限租约和通知投影权威。
- stdio proxy 只做 MCP 协议转发和认证，不保存 run、operation、permission lease 或状态文件。
- standalone 只作为显式兼容模式存在；同一 Host 已有 embedded authority 时必须拒绝启动写能力。
- Relay 不注册到 Harness 的 `ctx.tools`，也不配置进 Harness 自身的 `dsh-mcp-client`，避免 `Harness → Relay → 同一 Harness` 递归。
- Harness 产品仓库只作为兼容目标和测试依赖；所有实现均落在 Relay 包。

## 四、模块物理边界

本次新增或改动模块必须只通过模块根 `index.ts` 暴露 API，禁止跨模块导入内部文件。

| 模块 | 唯一出口 | 职责 |
| --- | --- | --- |
| `src/harness-gateway/` | `src/harness-gateway/index.ts` | 语义化 Host/session/workspace/model/history/cancel/event 接口与 HTTP/InProcess 实现。 |
| `src/permission-gateway/` | `src/permission-gateway/index.ts` | 当前权限读取、原生权限选择、确认和错误归一化；分别提供 external 与 embedded 实现。 |
| `src/authority/` | `src/authority/index.ts` | Host identity 归一化、owner lease、模式冲突和 state authority。 |
| `src/mcp-http/` | `src/mcp-http/index.ts` | 认证、请求边界、限流、Streamable HTTP transport、drain/dispose。 |
| `src/stdio-proxy/` | `src/stdio-proxy/index.ts` | stdio MCP Server 与远端 Streamable HTTP MCP Client 之间的透明转发。 |
| `src/harness-plugin/` | `src/harness-plugin/index.ts` | Cordis `name/inject/Config/apply`、Facade 组装、effect 生命周期。 |
| `src/mcp-server/` | `src/mcp-server/index.ts` | MCP 工具注册工厂；接收共享 Relay/Monitoring 实例，不自行创建业务单例；现有 `src/server.ts` 暂作兼容入口。 |

现有 `relay-broker`、`monitoring`、`setup`、`state-repository`、`workspace-routing`、`session-routing` 保持职责；没有本次需求的历史代码不主动重构。普通源码文件达到 600 行前必须拆分。

### 4.1 HarnessGatewayFacade 契约

不得暴露任意字符串方法调用。Facade 至少提供：

- `describeHost`
- `listWorkspaces` / `createWorkspace`
- `listSessions` / `createSession` / `readHistory`
- `listModels` / `selectModel`
- `submitPrompt` / `updateQueue` / `cancelSession`
- `openPath`
- 后续阶段的 `openMuxEvents` / `openHostEvents` / `respondToHostRequest`

两种实现必须经过同一组 adapter contract tests：

- `HttpHarnessGateway`：封装当前 Host Fetch 通路，保持 standalone 行为。
- `InProcessHarnessGateway`：基于 `InProcessApiClient(toFetchHandler(ctx.apiProxy))`，不复制 Rpc envelope 或手写方法 dispatch。

错误统一为稳定的 Relay 错误分类：`code`、`message`、`definitive`、`retryable`、`details`。HTTP 状态码只在 HTTP adapter 内出现，Broker 不感知传输。

### 4.2 PermissionGatewayFacade 契约

- `current(sessionId)`：读取 Harness 原生权限状态；external adapter 读取 `permissions.currentValue` 投影，embedded adapter 调用 `permissionPresets.current(session.events)`。
- `select(sessionId, preset)`：切换 `read-only | workspace-write | danger-full-access`。
- `confirm(sessionId, expected)`：回读并拒绝静默不一致。

实现：

- `ExternalPermissionGateway` 保留已验证的 Remote command 通路，兼容 standalone。
- `InProcessPermissionGateway` 注入 `ctx.sessions` 与 `ctx.permissionPresets`，通过 `permissionPresets.current(session.events)` 读取并用 `permissionPresets.set(session, preset)` 切换，不发送聊天消息。
- `danger-full-access` 仍要求 MCP 调用显式传入确认；Relay 不自动回答 Harness 后续工具 approval。

## 五、实施阶段

### 001A：冻结契约与回归基线

任务：

1. 为现有 HTTP 方法和权限通路增加 golden contract fixtures，记录成功、拒绝、可重试和结果未知形状。
2. 固化 `session.prompt` 只返回 accepted、以 rpcId/history 对账的现有语义，不为 in-process 模式发明 messageId。
3. 记录 K3、V4-Flash 建议的采纳/拒绝表，并将本计划标记为现有 `docs/001` 中“external-only”和“单实例 IPC Broker”冲突段落的后继决策。
4. 新增架构边界测试：新增模块只能从各自 `index.ts` 跨模块引用。

退出门：现有全套测试、TypeScript strict 检查、构建与 MCP smoke 全绿；没有产品源码变更。

回滚：本阶段只增加契约测试与文档，可独立删除。

### 001B：Gateway 与权限解耦

任务：

1. 建立 `HarnessGatewayFacade`、`PermissionGatewayFacade` 及语义类型。
2. 将 `RelayFacade` 的宿主依赖改为构造注入；默认 standalone 仍组装 HTTP adapters。
3. 迁移 ModelSelection、PromptAdmission、RunReconciler、WorkspaceRouting、SessionRouting 和 PermissionController 到 Facade 接口。
4. 把 `MonitoringFacade` 提升为 authority 级共享实例，再注入 MCP server factory。
5. 明确 adapter 关闭、超时、AbortSignal 与错误映射行为。
6. 本阶段只实现 HTTP adapter 的接口化与权限 adapter 抽取；Harness 包依赖和真正的 InProcess adapter 编译入口留到 001D，避免 001B 提前改变发布依赖。

退出门：HTTP adapter 行为与改造前逐项一致；HTTP/InProcess fake contract suite 同例同果；现有 MCP 工具 schema 不漂移。

回滚：保留 HTTP adapter 作为默认组装，删除 embedded adapter 不影响现有发布物。

### 001C：单权威、状态 v3 与恢复

任务：

1. 状态 schema 升级为 v3，增加 `authorityId`、`mode`、`hostIdentity`、`instanceId` 和 migration marker。
2. 新增用户级 authority registry；以归一化 Host 身份为键持有全生命周期 owner lease，而不是只持有一次写文件短锁。
3. embedded 默认状态位于 `$DSH_HOME` 下的 Relay 专属目录；standalone 继续使用独立目录。两者不得共享状态文件。
4. 第二个 authority 对同一 Host 启动时 fail closed，并在 `setup_doctor` 输出 owner/mode/恢复建议。
5. 设计显式一次性迁移：源状态只读打开、校验、复制到新目录、写入迁移完成标记；不自动搬移不明来源状态。
6. Host/插件重启时从状态和 Harness durable history 恢复；已提交 run 不因插件 dispose 被取消。
7. 在状态目录原子发布非密钥 `relay-endpoint.json`：只包含 schemaVersion、authorityId、mode、规范化 MCP URL、token 文件路径、Host Web URL、owner epoch 和更新时间；不得包含 token。stdio proxy 只通过显式 descriptor 路径或受控默认路径发现 embedded authority，不扫描端口。

退出门：多进程竞争、进程崩溃、陈旧 owner、状态损坏、v2→v3、权限租约恢复均有自动故障注入测试；禁止双 Broker 成功写同一 Host。

回滚：embedded 功能开关默认关闭即可继续运行 standalone；迁移只复制不删除源文件。

### 001D：Harness bundle 骨架与内嵌组装

任务：

1. 以无斜杆的 `harness-relay-mcp` 包根导出 Cordis 插件入口，并保留 `./standalone` 兼容入口。
2. `inject` 至少包含 `apiProxy`、`webServer`、`sessions`、`permissionPresets`；安装器与 `setup_doctor` 必须在写入 profile 前确认目标为 web profile，不依赖缺失 inject 的运行时等待充当错误提示。
3. 提供 Schemastery `Config`，只暴露用户真正拥有的配置：route、state/token 文件位置、请求体上限、并发数、速率限制、drain timeout；不提供明文 token 配置项。
4. 新增 `cordis.patch.yml`，只插入 Relay 行，不覆盖 Harness 既有行。
5. `package.json` 增加 `dsh.bundle.patch`、`./harness`、`./cordis.patch.yml` exports 与发布白名单。
6. 构建双产物：现有 standalone/proxy bin 与不带 shebang 的 Harness ESM 入口；Harness/Cordis/Schemastery 依赖外置并声明兼容 peer range，生成声明文件。
7. 继续由 `version.json` 驱动 package、MCP、Codex manifest 和运行时版本，禁止新增第二版本源。

退出门：从实际 `npm pack` tarball 安装到临时 `DSH_HOME` 的 web profile；`dsh --profile web --dump-config` 显示 Relay 层；启动/卸载/重装无产品源码改动；对 headless 的安装计划在执行前由 setup/doctor 明确阻止。

回滚：移除 bundle 层或执行 `dsh plugin --profile web remove harness-relay-mcp` 即恢复原 profile；包的外部 bin 仍可使用。

### 001E：认证 Streamable HTTP MCP

任务：

1. 通过 `ctx.webServer.register({ kind: 'exact', path })` 挂载 `/plugins/dsh-relay/mcp`。
2. 首版采用无状态 Streamable HTTP：每次 MCP initialize/request 可重建协议对象，但所有处理器共享同一 Relay/Monitoring authority。
3. 默认生成 256-bit token 文件，原子创建并限制为当前用户可读；支持从指定环境变量读取作为 CI/受管部署替代。token 不进入 endpoint descriptor、patch、dump-config、日志、错误或诊断。
4. stdio proxy 先读取 endpoint descriptor，再按其中的路径读取 token 文件；客户端配置只保存 descriptor 路径和稳定 principal，不保存 token。直接 HTTP 客户端通过 `Authorization: Bearer` 提供。
5. 在 transport 前执行：Bearer 常量时间比较、loopback remoteAddress、Host allowlist、Origin（缺失允许，存在则严格 allowlist）、Content-Type、MCP 协议头、方法、请求体上限、并发和令牌桶检查。
6. `webServer.host === '0.0.0.0'` 时拒绝插件加载。首版无 `allowRemote` 逃生开关。
7. dispose 顺序：标记 draining、拒绝新请求为 JSON 503、Abort 等待器、关闭 MCP transport、释放路由；不取消 Harness run。验证 Cordis 热重应用注册顺序，避免重复 exact route 或 SPA HTML 回退。

退出门：MCP initialize/tools-list/tools-call、认证正反例、DNS rebinding、Origin/无 Origin、超大 body、慢请求、并发限流、drain、热重载和 5 秒退出预算全部自动通过。

回滚：关闭 HTTP route 配置，继续使用 standalone；authority 状态保持可恢复。

### 001F：通用 stdio proxy 与客户端接入

任务：

1. 新增独立 `harness-relay-mcp-proxy` bin，并保留 `dsh-relay-proxy` 兼容别名；使用 MCP SDK Client + Streamable HTTP transport，不手写 JSON-RPC 隧道。
2. proxy 启动时完成 initialize、tools/list 和能力发现；把 tools/call 与结构化错误透明转发。
3. proxy 不建立 Relay Broker、不打开业务状态文件、不创建权限租约。
4. 更新 Codex plugin manifest、`.mcp.json`、Claude Code、Cursor、OpenCode setup adapters：通用默认均指向 proxy，并为每个客户端/作用域生成稳定、非安全身份的 `clientPrincipalId`；只有通过认证矩阵的客户端才推荐直接 HTTP。
5. setup/doctor 自动检查 Host、bundle、route、token 文件权限、协议版本、递归配置和 authority owner；保持只读规划，不私自写外部客户端配置。
6. 第一次成功启动 run 后返回并验证 Harness Web 会话 URL；无法实际打开时不向用户宣称已验证。

退出门：四客户端配置生成快照、SDK 级 stdio e2e、断线重连、重复 initialize、工具分页、Host 重启和错误保持测试全绿；无需人工点击验证。

回滚：客户端配置重新指向现有 standalone bin。

### 001G：事件驱动监控与状态化通知（后置）

任务：

1. embedded adapter 消费 `ctx.apiProxy.events.mux/host`，减少轮询延迟。
2. durable history 继续是重启、断流和 gap recovery 真源；事件只做实时加速。
3. 设计状态化 Streamable HTTP session、EventStore、断点恢复和服务端通知；保留 `read_notifications` 拉取降级。
4. approval/question 帧只上报需要关注，不自动代表用户批准；响应策略另设安全决策。

退出门：事件丢失、重复、乱序、重连、Host 重启、多客户端 cursor、通知缓冲淘汰和历史对账测试全绿。

回滚：停用事件订阅，恢复现有 `wait_run`/history 轮询，不影响 run 数据。

### 001H：发布、安装与全矩阵门

任务：

1. 实际 tarball → 临时 profile add → dump-config → 启动 → MCP smoke → 重启 → remove 全流程。
2. 验证发布包只含允许文件，无状态、token、`.env`、runtime 和测试产物，大小不超过现有 8 MiB 门。
3. 兼容矩阵覆盖 Node/Harness 版本、Codex/Claude Code/Cursor/OpenCode、stdio/HTTP、四类生命周期、三种权限和故障恢复。
4. 双语 README 同步内部/外部差异、安装卸载、威胁边界、状态位置、URL、递归禁令和版本兼容范围。
5. 安装进入真实 `D:\AI\deepseek-harness` 前，先用隔离的 `DSH_HOME` 全自动验证；真实安装只通过官方 profile 命令完成，不复制或修改 Harness 源码。

退出门：全部测试、tsc、build、MCP smoke、package validator、tarball 安装、真实 Loader/profile、卸载残留检查均成功；生成机器可读验证报告。

## 六、安全契约

1. 网络：首版只接受回环 TCP；不信任 `X-Forwarded-For`。
2. 身份：所有 HTTP MCP 请求必须 Bearer；stdio proxy 继承同一用户的 token 文件读取权限。
3. 密钥：token 不进入源码、patch、配置 dump、日志、异常、run state 或诊断；支持轮换并立即废止旧值，是否提供宽限期由单独安全决策确定。
4. 请求：限制 Content-Type、协议版本、方法、body、header、并发、速率和最长等待；所有拒绝返回结构化 JSON，不落入 SPA HTML。
5. 权限：使用 Harness 原生三档权限；完全访问必须由上游 MCP 调用显式确认；切换后先回读再提交首条任务。
6. 作用域：Relay 只访问调用中明确授权的 workspace；保留 allowed roots、canonical path 与 symlink 防逃逸检查。
7. 生命周期：dispose 不取消已提交任务；新请求停止后，状态与权限租约可由重启恢复和 reconcile。
8. 递归：doctor 检测 Relay URL/包被配置进同一 Harness 的 mcp-client 时报告 blocked。

## 七、状态与幂等契约

- 所有客户端共享 embedded authority 的 operation journal，但幂等键按 `clientPrincipalId + idempotencyKey` 隔离。
- Bearer token 只负责认证；`clientPrincipalId` 是非安全的幂等命名空间。stdio proxy 从客户端/作用域配置得到稳定 principal，不能在每次进程启动时随机生成；直接 HTTP 必须显式提供受格式和长度限制的 principal，省略时使用稳定的 `direct-http`。
- principal 不授予权限，不能覆盖 workspace、permission 或危险操作确认；服务端不得把它描述为已认证身份。
- 同一 principal 和 key 的输入摘要不同必须返回 conflict，不覆盖原操作。
- 状态提交顺序保持“先写 prepared，再调用 Host，再对账”；不确定结果进入 unknown，不重复提交。
- permission lease 与 owner operation 持久关联；run 终态后恢复原权限，恢复失败进入 needs_attention。
- Harness history/session events 是事实真源；Relay state 是幂等、路由和恢复索引，不能伪造 Harness 终态。

## 八、自动化验证矩阵

| 维度 | 必测场景 |
| --- | --- |
| Adapter parity | HTTP 与 InProcess 对成功、拒绝、超时、取消、internal、unknown 返回一致错误语义。 |
| 生命周期 | start/status/wait/reply/steer/cancel、max-tokens、needs-attention、Host 丢失、重启恢复。 |
| 模型 | provider/model/reasoningEffort/agentPreset 在首条任务前应用；不可用模型 fail closed。 |
| 权限 | 三档权限、回读确认、租约恢复、进程崩溃、危险确认、多客户端冲突。 |
| MCP | initialize、tools/list 分页、tools/call、无状态重复握手、stdio proxy、结构化错误。 |
| 安全 | 无 token、错 token、Origin、Host、非 loopback、0.0.0.0、慢请求、超限、DoS。 |
| 多进程 | embedded/standalone、两个 profile、陈旧 owner、PID 重用、状态目录误配。 |
| Cordis | add/dump/start/hot-reload/dispose/remove、缺 inject、配置 schema 错误。 |
| 发布 | pack 文件白名单、双入口解析、peer range、version 单一真源、UTF-8 无 BOM。 |
| 客户端 | Codex、Claude Code、Cursor、OpenCode 的生成配置和协议 smoke；不要求用户人工参与。 |

所有集成测试使用临时目录、临时端口和隔离 `DSH_HOME`；不得污染真实 profile、真实 Relay 状态或用户客户端配置。

## 九、主要风险与控制

| 风险 | 等级 | 控制 |
| --- | --- | --- |
| 权限 seam 错误导致任务先提交后授权 | Critical | 内部直接调用 permissionPresets，回读确认成功后才允许 prompt。 |
| 双 Broker 同时控制同一 Host | Critical | 用户级 authority owner lease + fail closed + 多进程故障注入。 |
| Token 泄漏 | High | 文件/环境 provider Facade、ACL、输出红线测试、无明文 Config。 |
| HTTP 路由绕过现有 `/api` trust fence | High | Relay 自有完整认证和请求边界，首版 loopback-only。 |
| embedded 与 standalone 错误语义不同 | High | 共享错误映射与 adapter contract suite。 |
| Cordis 热重载造成路由冲突或 HTML 回退 | High | drain、结构化 503、注册顺序 E2E、effect disposer。 |
| 双产物打包引入重复 Cordis | High | Harness 依赖 external/peer，包解析与实例唯一性测试。 |
| 事件推送成为新的非持久真源 | Medium | history 恢复优先、seq 去重/gap reconcile、轮询降级。 |

## 十、Definition of Done

只有同时满足以下条件，内部插件能力才可宣布完成：

1. Relay 包能由官方命令安装进隔离和真实 web profile，且没有修改 Harness 产品源码。
2. embedded authority 通过 InProcess ApiProxy 与原生 permissionPresets 完成三档权限和完整异步生命周期。
3. Codex、Claude Code、Cursor、OpenCode 至少通过 stdio proxy 自动化调用；通过认证矩阵的版本可直连 HTTP。
4. 返回的 Harness Web URL 来自真实 Host，会话 ID 正确，并在宣称“可打开”前做实际打开验证。
5. 多进程、Host 重启、插件热重载、状态损坏、权限恢复和网络故障均有自动测试。
6. 安全契约全部通过负例测试；远程绑定在首版明确拒绝。
7. tarball、exports、peerDependencies、manifest、Skill、双语 README、CHANGELOG 和单一版本源一致。
8. `pnpm test`、strict TypeScript、build、MCP smoke、package gate、profile E2E 和卸载检查全部成功。

## 十一、执行顺序与并行限制

依赖主链：`001A → 001B → 001C → 001D → 001E → 001F → 001H`；`001G` 在 001E 稳定后单独后置。

可并行但不得修改同一文件：

- 001C 的 authority/state 模块可与 001D 的 bundle 文档和独立入口骨架并行。
- 001E 的安全测试夹具可与 001F 的客户端配置快照并行。
- package.json、build scripts、根 index、README、CHANGELOG、version 文件由主进程统一合流，避免冲突。

实施时每个阶段单独提交、单独验证、可独立回滚；任何阶段若需要修改 Harness 产品源码，立即停止并改为兼容层方案或请求变更产品要求。
