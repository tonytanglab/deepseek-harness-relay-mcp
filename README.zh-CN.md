# Harness Relay MCP

[English](README.md) | 简体中文

**让外部 Agent 委派并持续监控 DeepSeek Harness 任务。**

让任何支持 MCP 的 Agent 向 DeepSeek Harness 委派长时间任务，并持续监控直至完成。

Harness Relay MCP 将 MCP 客户端直接连接到 DeepSeek Harness 原生会话与事件模型。推荐形态是安装为 Harness 树外内部 bundle；它不包装 CLI、不修改 Harness 源码，也不接管 Harness 进程。

```text
MCP Agent
   │
   ├─ start_run ── Provider / 模型 / 推理强度 / preset / 权限
   │
   ├─ status_run / wait_run / steer_run / cancel_run
   │
   └─ 持久结果 + 原生 Harness Web 会话链接
```

## 主要能力

- 使用 Harness 原生会话和持久事件，不解析 CLI 输出。
- 完整异步生命周期：启动、查询、等待、纠偏、回复、取消和重新打开。
- 在首条任务提示词前选择 Provider、模型、推理强度、Agent preset 和原生权限。
- 直接支持 Harness 的 `read-only`、`workspace-write`、`danger-full-access` 三档权限。
- 支持有序文本和内联图片提示词，并对 base64 和大小进行有界校验。
- 持久保存运行标识，MCP Server 重启后可恢复监控。
- 返回稳定的 Harness Web 会话链接；随附 Skill 会在分享前验证页面确实可见。
- 兼容 Codex、Claude Code、OpenCode、Cursor 及其他符合标准的 MCP 客户端。
- 内部 bundle 使用官方 InProcess ApiProxy 和原生权限服务；外部 Agent 通过认证 HTTP 或无状态 stdio proxy 调用。
- 保留独立 `dsh-relay` 模式用于旧版 Harness 和显式回滚。

## 运行要求

- Node.js `^22.19` 或 `>=24`。
- 内部模式要求 DeepSeek Harness `0.1.0-rc.7` 兼容系列的 `web` profile，并只允许 `127.0.0.1` 绑定。
- 独立兼容模式要求已在本机回环 HTTP 地址运行的 DeepSeek Harness Web Host。
- 目标工作区必须已在 Harness 中登记，或属于明确配置的允许根目录。

默认 Host 地址：

```text
http://127.0.0.1:3080/
```

## 安装

### 安装为 Harness 内部 bundle（推荐）

使用 Harness 官方 profile 命令从 npm 安装已发布包，检查组合后的配置，再启动该 profile：

```powershell
dsh plugin --profile web add harness-relay-mcp
dsh --profile web --dump-config
dsh --profile web
```

离线安装或需要锁定本地文件时，可下载 Release tarball，并将第一条命令中的 `harness-relay-mcp` 替换为本地 `.tgz` 路径。

配置输出应包含 `id: harness-relay-mcp` 和 `name: 'harness-relay-mcp'`。因此 Harness 插件列表显示为无斜杆的 `harness-relay-mcp`。如果 `dsh web` 已在运行，安装或升级后需要重启该 Host 才会加载新 bundle。启动后，bundle 会继续在兼容路径 `$DSH_HOME/plugins/dsh-relay/web/relay-endpoint.json` 发布不含密钥的端点描述；Bearer token 单独保存在 Host 专属状态目录。

卸载不会取消已提交的 Harness 任务：

```powershell
dsh plugin --profile web remove harness-relay-mcp
```

不要把 Relay 再配置进同一 Harness 的 MCP client，否则会形成 `Harness → Relay → Harness` 递归。

### Codex 插件

本机 `personal` marketplace 已包含此插件时：

```powershell
codex plugin add deepseek-harness-relay@personal
```

安装后新建一个 Codex 对话，以便 Codex 加载 MCP Server 和 `delegate-to-deepseek-harness` Skill。

### 本地开发

```powershell
pnpm install
pnpm run build
```

内部 bundle 启动后，让 MCP 客户端启动通用 stdio proxy：

```json
{
  "mcpServers": {
    "harness-relay-mcp": {
      "command": "node",
      "args": ["C:/Users/you/plugins/deepseek-harness-relay-mcp/dist/dsh-relay-proxy.mjs"],
      "env": {
        "DSH_RELAY_CLIENT_PRINCIPAL_ID": "cursor:project"
      }
    }
  }
}
```

proxy 默认读取 `$DSH_HOME/plugins/dsh-relay/web/relay-endpoint.json`；自定义状态目录时显式设置 `DSH_RELAY_ENDPOINT_DESCRIPTOR`。客户端配置不保存 token。`harness-relay-mcp` 包根入口是 Harness bundle，同时提供 `harness-relay-mcp`、`harness-relay-mcp-proxy` 命令；旧 `dsh-relay` 命令作为兼容别名保留。

## 快速开始

先读取 Harness 原生工作区注册表，不要把 Host 进程目录当成授权清单：

```json
{
  "tool": "list_workspaces",
  "arguments": {}
}
```

然后读取 Host 实际能力，不要猜测路由名称：

```json
{
  "tool": "list_capabilities",
  "arguments": {}
}
```

然后使用 Kimi K3/MAX 发起只读审查：

```json
{
  "tool": "start_review",
  "arguments": {
    "workspace": "D:/work/project",
    "task": "审查此工作区，只返回可复现的发现。",
    "provider": "kimi-coding",
    "model": "k3",
    "reasoningEffort": "max",
    "agentPreset": "standard",
    "idempotencyKey": "review-2026-08-19-001"
  }
}
```

保存返回的 `runId`、`sessionId` 和 `webUrl`，通过有界等待监控运行：

```json
{
  "tool": "wait_run",
  "arguments": {
    "runId": "<run-id>",
    "timeoutMs": 30000
  }
}
```

活动运行需要补充或纠正时调用 `steer_run`。运行进入终态后，通过 `reply_run` 在同一个原生 Harness 会话中继续对话。

同时省略 `sessionId` 和 `sessionMode` 时，会在所选 Harness 工作区内创建新会话。需要延续现有项目对话时，先调用 `list_workspace_sessions` 并传入其中空闲的 `sessionId`，或者传入 `sessionMode: "latest-idle"`，复用最新的非空、空闲、未归档会话。显式 `sessionId` 不能与 `sessionMode` 同时使用。

## 运行生命周期

```text
start_run
   │
   ├─ 预留会话
   ├─ 选择模型和原生权限 preset
   ├─ 持久化 runId + prompt rpcId
   ├─ 提交 session.prompt
   └─ 与持久历史对账

running ── status/wait/steer/cancel ──> succeeded | incomplete | failed | cancelled | needs_attention
   │
   └─ 终态 ── reply_run ──> 同一会话中的新运行
```

`promptAdmission` 表示提示词接纳状态：

| 值 | 含义 |
| --- | --- |
| `pending` | 运行标识已经持久化，但提示词提交尚未完成。 |
| `accepted` | Harness 已接纳提示词，或已观察到其持久消息。 |
| `unknown` | 传输响应不可用；应按 `rpcId` 对账，不能重复提交任务。 |
| `rejected` | Harness 未接纳或未持久化提示词。 |

## `start_run` 参数

| 参数 | 是否必需 | 说明 |
| --- | --- | --- |
| `workspace` | 是 | Relay 策略允许的绝对工作区路径。 |
| `task` | 两种提示词形式选一 | 纯文本任务，与 `content` 互斥。 |
| `content` | 两种提示词形式选一 | 有序文本/图片块，与 `task` 互斥。 |
| `sessionId` | 否 | 复用所选工作区内的空闲会话。 |
| `sessionMode` | 否 | `fresh` 或 `latest-idle`；默认为 `fresh`，不能与 `sessionId` 同时使用。 |
| `provider` | 与 `model` 同时提供 | `list_capabilities` 返回的准确 Provider ID。 |
| `model` | 与 `provider` 同时提供 | `list_capabilities` 返回的准确模型 ID。 |
| `reasoningEffort` | 否 | 适配器支持的强度，例如 `low`、`high` 或 `max`。 |
| `agentPreset` | 否 | Harness Agent preset，只能在创建新会话时选择。 |
| `permissionPreset` | 否 | 原生权限 preset，默认为 `read-only`。 |
| `confirmedDangerousPermission` | 完全访问时必需 | 使用 `danger-full-access` 前必须显式设为 `true`。 |
| `idempotencyKey` | 建议提供 | 调用方稳定键；相同请求重试时返回原操作，不会重复提交。 |
| `openBrowser` | 否 | 请求操作系统打开原生会话 URL。 |

### 图片提示词

使用不带 `data:` URL 前缀的规范 base64：

```json
{
  "workspace": "D:/work/project",
  "content": [
    { "type": "text", "text": "审查这张截图。" },
    {
      "type": "image",
      "mediaType": "image/png",
      "data": "<canonical-base64>",
      "name": "screen.png"
    }
  ]
}
```

支持 PNG、JPEG、WebP 和 GIF。图片字节会发送给 Harness，但不会保留在 Relay 运行快照或状态文件中。

## 原生权限 preset

| Preset | 适用场景 |
| --- | --- |
| `read-only` | 审查、诊断、研究、比较和规划。 |
| `workspace-write` | 仅在授权工作区内实施修改。 |
| `danger-full-access` | Harness 完全访问；仅在调用方明确授权时使用。 |

DSH Relay 通过 `commands/execute` 调用 Harness 原生 `/permission` 命令，并在提交首条任务提示词前核验会话投影。提示词中的文字声明不会被当作权限边界。

## MCP 工具

| 工具 | 用途 |
| --- | --- |
| `doctor` | 检查 Relay 包、Host 连接、工作区策略和持久状态。 |
| `setup_plan` | 生成经过验证且不写入磁盘的客户端配置补丁。 |
| `setup_doctor` | 将 setup 计划和调用方提供的探针结果转换为机器可读报告。 |
| `start_service` | 将授权工作区附加到现有 Harness Host。 |
| `open_service` | 打开 Host 根地址。 |
| `list_services` | 列出已恢复的工作区附加记录。 |
| `list_workspaces` | 列出用于路由的 Harness 原生工作区注册表。 |
| `list_workspace_sessions` | 列出指定已登记工作区的直接会话，不读取对话内容。 |
| `stop_service` | 只移除 Relay 附加状态，不停止 Harness。 |
| `list_capabilities` | 列出 Provider/模型/推理强度、Agent preset 和原生权限模式。 |
| `start_run` | 创建或复用会话并提交受跟踪任务。 |
| `start_review` | 固定使用 Harness 原生 `read-only` 权限提交审查任务。 |
| `steer_run` | 向活动运行插入纠偏指令。 |
| `get_run` | 读取并对账运行；`status_run` 的兼容别名。 |
| `get_run_summary` | 将运行投影为稳定的状态、模型、权限、耗时和下一步字段。 |
| `status_run` | 根据 Host 状态和持久事件对账运行。 |
| `open_run` | 打开原生 Harness Web 会话链接。 |
| `wait_run` | 最长等待 30 秒以获取运行进展。 |
| `list_runs` | 对账并列出已持久化运行。 |
| `get_operation` | 读取一条持久化的 start、reply、steer 或 cancel 幂等操作。 |
| `reconcile_operation` | 根据 Harness 持久事件解析不确定操作，且不重复提交请求。 |
| `reconcile_permissions` | 重试恢复已过期或中断的 Harness 原生权限租约。 |
| `reply_run` | 在已完成会话中创建新的受跟踪运行。 |
| `cancel_run` | 请求 Harness 原生取消。 |
| `read_notifications` | 从指定游标开始重放当前进程的有界通知投影。 |

## 客户端配置与监控投影

`setup_plan` 支持 Codex、Claude Code、Cursor，以及显式标记版本的 OpenCode V2 配置结构。它接收已经解析的 Node 与 Relay 入口绝对路径，只返回结构化最小补丁，绝不直接编辑客户端配置。启动器平台必须与配置平台一致；`pnpm.exe`、`pnpm.cmd` 等包管理器 shim 不能充当 Node 运行时。

`setup_doctor` 同样无副作用。文件系统、Broker、Host、工作区、模型和权限事实必须由获得授权的调用方提供；未提供的探针会标记为 `skipped`，不会猜测结果。

`get_run_summary` 消费 Relay 权威运行快照并输出版本化监控投影。`read_notifications` 重放当前 MCP Server 进程保留的通知，并在游标缺口时返回明确的重同步元数据。原生 MCP 通知 transport 尚未启用，因此通知缓冲为空属于正常情况，客户端必须自动降级到 `get_run_summary`、`wait_run` 或 `status_run` 轮询。

## 持久化与故障恢复

默认状态文件：

```text
%LOCALAPPDATA%/dsh-relay/state.json
```

状态会经过 schema 校验、带所有者校验的跨进程锁和原子替换，并在支持的平台上使用限制性文件权限；旧写入者不能回退已停止服务、终态运行、待处理状态、操作或权限租约。损坏文件会被隔离而不是覆盖。默认不持久化提示词文本和图片字节。Relay 重启后会恢复运行与操作标识，并与 Harness 原生历史重新对账。对账得到的 Assistant 文本会按当前 turn 的事件顺序保留，不再只返回最后一条 Assistant 消息。活动运行在配置时间内没有持久进展时会进入 `needs_attention` 并给出 `attentionReason: run_stalled`；后续一旦出现新进展会自动恢复为 `running`。

多个本地 MCP Server 进程可以共享一个状态文件；写入会按稳定标识串行化并合并。遗留锁会安全失败，而不会仅因时间过长就被删除。需要运行隔离时，再为不同客户端配置独立的 `DSH_RELAY_STATE_FILE`。

## 会话链接

每个运行都会返回如下原生 URL：

```text
http://127.0.0.1:3080/?sessionId=<session-id>
```

HTTP 200 只能证明 Host 已响应，不能证明超长实时对话已经完成浏览器渲染。随附 Skill 会先调用 `open_run`，再验证页面中可见的工作区和会话，然后才把链接作为可打开链接交给用户。Harness 成功选择会话后可能把地址栏规范化回 Host 根地址，但选中的会话仍然保持不变。

## 配置

| 环境变量 | 默认值 | 用途 |
| --- | --- | --- |
| `DSH_RELAY_HOST_URL` | `http://127.0.0.1:3080/` | 本机回环 Harness Host 地址。 |
| `DSH_RELAY_ALLOWED_WORKSPACE_ROOTS` | Harness 工作区目录 | 操作系统分隔的额外授权绝对根目录列表；未配置时只接受 Harness 已登记工作区。 |
| `DSH_RELAY_STATE_FILE` | `%LOCALAPPDATA%/dsh-relay/state.json` | Relay 持久状态位置。 |
| `DSH_RELAY_PERSIST_PROMPT_TEXT` | `false` | 明确接受本地留存时持久化提示词摘要。 |
| `DSH_RELAY_CLIENT_PRINCIPAL_ID` | `local-user` | 与幂等键共同使用的稳定本地调用方标识。 |
| `DSH_RELAY_PERMISSION_LEASE_MS` | `86400000` | 复用会话权限租约的记录时限。 |
| `DSH_RELAY_RPC_TIMEOUT_MS` | `30000` | Host RPC 超时。 |
| `DSH_RELAY_POLL_INTERVAL_MS` | `750` | 活动运行轮询间隔。 |
| `DSH_RELAY_MAX_HISTORY_PAGES` | `100` | 单次对账最多读取的持久历史页数。 |
| `DSH_RELAY_RUN_STALL_MS` | `300000` | 活动运行无进展多久后标记为 `needs_attention`；恢复进展时自动回到运行态。 |
| `DSH_RELAY_MAX_TASK_CHARACTERS` | `100000` | 单条提示词的最大文本字符数。 |
| `DSH_RELAY_MAX_ASSISTANT_TEXT_BYTES` | `256000` | 返回的 Assistant 文本尾部最大字节数。 |
| `DSH_RELAY_MAX_IMAGE_BYTES` | `5242880` | 单张图片最大解码字节数。 |
| `DSH_RELAY_MAX_IMAGES` | `20` | 每条消息最大图片数。 |
| `DSH_RELAY_MAX_MESSAGE_IMAGE_BYTES` | `104857600` | 每条消息中图片的最大解码总字节数。 |

只接受本机回环 HTTP Host。工作区路径会先经过文件系统解析，再执行包含关系检查。

## 安全模型

- Harness Relay MCP 不读取或存储 Harness 凭据。
- 现有 Harness Host 仍然是模型、权限、会话、附件和任务执行的权威来源。
- 默认权限 preset 为 `read-only`。
- 未配置显式 roots 时，以 Harness 工作区注册表作为路由授权真源；配置 roots 后仍执行更严格的本地边界。
- `stop_service` 不会停止 Harness，也不会删除会话。
- Harness 输出属于证据；最终复核和高风险决策仍由调用方 Agent 负责。

## 与 Harness 插件标准的边界

Harness Relay MCP 采用双层兼容结构：`harness-relay-mcp` 包根入口是遵循 Harness/Cordis 标准的树外内部 bundle，导出 `Config/apply(ctx)` 并通过 `dsh.bundle` 与 `cordis.patch.yml` 安装；外部 Agent 则通过认证 HTTP 或无业务状态的 proxy 使用同一内部 authority。standalone 入口只作为兼容和回滚路径。整个方案不复制或修改 Harness 产品源码。

参见 DeepSeek Harness 官方文档：[创建 Harness 插件](https://deepseek-harness.github.io/deepseek-harness/develop/basic/)和[发布 bundle](https://deepseek-harness.github.io/deepseek-harness/develop/basic/publish)。

## 开发与验证

`version.json` 是唯一可编辑版本源。构建会先同步 npm 与 Codex 清单，再生成自包含 MCP bundle。

```powershell
pnpm run test
pnpm run build
pnpm run test:mcp
pnpm run check:package
pnpm pack --dry-run
```

`prepack` 会执行严格 TypeScript 检查、构建 bundle，并验证显式发布白名单。敏感目录、运行时产物、敏感文件和符号链接会被拒绝；展开后的默认总字节上限为 8 MiB。发布自动化可通过 `DSH_RELAY_PACKAGE_MAX_BYTES` 调整门限，但提高上限应经过审查，不能用于掩盖异常包体增长。`test:mcp` 每次都会先重新构建，再启动 stdio 冒烟测试。

## 标识

| 使用位置 | 名称 |
| --- | --- |
| 产品名 | Harness Relay MCP |
| 仓库名 | `deepseek-harness-relay-mcp` |
| Codex 插件 ID | `deepseek-harness-relay` |
| npm 包 | `harness-relay-mcp` |
| MCP Server ID | `harness-relay-mcp` |
| Skill | `delegate-to-deepseek-harness` |

## 许可证

MIT
