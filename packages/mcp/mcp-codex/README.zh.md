# @deepseek-ai/dsh-mcp-codex

[English](README.md) | 中文

面向 Codex 的 MCP 服务器，负责工作区范围内的 Harness Web 服务。每个规范化工作区对应一个受管 Web 进程，持久化数据位于 `<DSH_HOME>/codex-services/<workspace-sha256>`，并可运行任意数量互不重叠的会话任务。MCP 进程的 stdout 只承载协议；子进程 stdout/stderr 被捕获到 `ServiceSnapshot.logTail`。

## 工具

| 工具 | 结果 |
|---|---|
| `doctor` | 检查直接 Node 启动器、包、工作区策略和进程提供方，不读取凭据 |
| `start_service` | 启动或复用工作区服务，返回 loopback 根 URL |
| `open_service` | 用平台浏览器打开经过校验的 loopback URL |
| `list_services` | 列出当前 MCP 进程拥有的服务 |
| `stop_service` | 取消活动运行、等待完全停稳并停止进程树 |
| `start_run` | 向新会话或空闲 `sessionId` 提交任务，返回会话深链 |
| `steer_run` | 向活动运行插入纠偏指令，并返回持久消息 ID |
| `get_run` | 返回即时运行快照 |
| `wait_run` | 等待状态变化或完成，最长 30 秒 |
| `list_runs` | 列出当前 MCP 进程保留的运行，可按服务过滤 |
| `cancel_run` | 幂等请求取消；保留健康服务，或隔离无法回到 idle 的服务 |

`start_run.webUrl` 的格式为 `http://127.0.0.1:<port>/?sessionId=<SessionId>`。MCP 进程重启后内存中的 run ID 会消失；session ID 和工作区数据会保留，之后可通过新的 `start_run` 继续会话。

## 运行结算

服务器在接纳提示词前打开 Host 事件流，并以返回的持久消息 ID 锚定运行。一个运行包括该消息，以及 agent 再次 idle 前从 Web 或 `steer_run` 接纳的所有 steering（中途引导）。`steer_run` 保留原 run ID 和 session ID；运行进入终态后，再用 `start_run.sessionId` 发起后续轮次。每个会话同时只能有一个 MCP 运行；不同会话和工作区可并行运行。

`completed` 映射为 `succeeded`。用户中止或 `cancel_run` 后的中止映射为 `cancelled`。错误、阻塞或中断的轮次、输出 token 耗尽、已接纳工作被丢弃、未知终态和 Web 服务故障都映射为 `failed`。取消不会改写已经进入终态的运行。

`cancel_run` 最多等待 `stopGraceMs`，以取得持久化轮次终态和 Agent idle 证据。如果取消 RPC 失败或 Agent 持续忙碌，监管器会终止该工作区的 Web 进程树，把服务标记为失败，并让该共享进程拥有的所有仍在运行的 run 失败。之后调用 `start_service` 或 `start_run` 会在相同持久化工作区数据上启动新的 Web 进程。这项有界隔离可防止一个不响应取消的工具无限占用控制平面、socket 或其他会话。

内联 assistant 文本只是便捷摘要，不是完整 transcript（文本记录）。它包含本次运行的回答 `text` 块；如果本次运行没有回答文本，则回退到可见的 `reasoning` 块，确保成功运行不会丢弃唯一可读的 assistant 输出。默认保留 50,000 字节 UTF-8 尾部，且不会从码点中间开始；`assistantTextBytes` 报告完整字节数，`assistantTextTruncated` 报告是否发生截断。Web 会话始终提供完整视图。

`lastToolEvents` 是面向工具活动的同款有界表面：运行自有后缀中最近的 `maxToolEvents` 条工具调用与结果，按日志顺序排列。每条 `arguments` 与结果 `summary` 均以 `maxToolEventBytes` UTF-8 字节为上限（不会从码点中间截断），`truncated` 报告是否丢失内容，`callId` 将每次调用与其结果配对。Web 会话始终提供完整视图。

## 配置

| 字段 | 默认值 | 含义 |
|---|---:|---|
| `dataDirectory` | `<DSH_HOME>/codex-services` | 各工作区 Harness home 的父目录 |
| `credentialsPath` | `<DSH_HOME>/.credentials.yaml` | 所有受监管工作区共用的用户级全局凭据文档 |
| `allowedWorkspaceRoots` | `[]` | 允许的根目录；空列表读取 `DSH_MCP_WORKSPACE_ROOTS` |
| `startupTimeoutMs` | `60000` | 结构化 Web readiness 的期限 |
| `stopGraceMs` | `10000` | 等待 agent idle 和进程树退出的宽限期 |
| `rpcTimeoutMs` | `10000` | Host RPC 和事件流就绪期限 |
| `browserOpenTimeoutMs` | `10000` | 单次平台浏览器打开器的结算期限 |
| `eventReconnectDelayMs` | `250` | 已建立事件流断开后的重连间隔 |
| `maxTaskCharacters` | `100000` | 提交任务的长度上限 |
| `maxLogCharacters` | `100000` | 捕获的服务日志尾部上限 |
| `maxAssistantTextBytes` | `50000` | 内联 assistant UTF-8 尾部上限 |
| `maxToolEvents` | `20` | 每个运行快照保留的最近工具活动条目数 |
| `maxToolEventBytes` | `2000` | 保留的工具参数与结果摘要的逐字段 UTF-8 上限 |

工作区路径在计算哈希或检查允许根目录前通过 `realpath` 解析。Web 子进程继承可信 Harness 进程环境，并覆盖自己的 `DSH_HOME`、`DSH_CWD` 和 UTF-8 变量，同时通过 `DSH_GLOBAL_CREDENTIALS_PATH` 指向 `credentialsPath`。项目 `.credentials.yaml` 仍是优先级更高的覆盖；Models 默认写入全局，并提供显式的「仅当前项目」作用域。把项目密钥切换为全局时，系统会先提交共享值，成功后才移除该工作区的覆盖。模型启动的工具仍使用既有凭据清理规则。

## 进程所有权与 Windows

监管器通过 `ctx.subprocess` 启动 `[process.execPath, ...process.execArgv, absoluteDshEntry, '--profile', 'web', '--port', '0', '--ready-format', 'json']`。内部不会启动 `npx`、`.cmd` shim 或 shell。Web readiness 是一行严格 UTF-8 JSON，其中必须包含无附加路径的 loopback HTTP 根 URL。编码非法、readiness 记录非法、超时或进程提前退出都会使启动失败。

dispose（资源释放）与 `stop_service` 使用同一条路径：请求取消，等待持久终态和 idle 证据，中止事件流，终止受管进程树，并确认完整退出。在 Windows 上，正常终止会异步启动进程树范围的 `taskkill` 请求，使缓慢的 OS helper 无法阻塞 MCP 或 Web 事件循环；同步形式只保留给 Node 最终的 `exit` hook。Web 子进程不会在插件拆卸后变成未追踪的孤儿进程。

## 模型体验

通过 MCP 工具提交的普通 Host 会话消息间接生效；组合后的 Web agent 拥有提示词和工具。

#### KV Cache 影响

每个任务、续聊或实时纠偏都会在可复用请求前缀之后追加一条用户消息；MCP 状态字段和 Web URL 不会进入模型上下文。

## 已知限制与延后工作

- **运行记录只保存在进程内。** MCP 重启后不会重建；续聊改用持久化 `sessionId`。
- **内联 assistant 文本与工具活动有界。** 需要完整回复的调用方必须使用 Web 会话。
- **打开浏览器为显式选择。** 除非调用 `open_service` 或请求 `openBrowser: true`，否则保持禁用。打开失败不会使已受理的 run 失败：`start_run` 仍返回运行快照，失败记录在服务快照的 `browserError` 上，调用方可通过 `open_service` 重试。
