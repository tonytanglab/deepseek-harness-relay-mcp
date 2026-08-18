# dsh-relay

[English](README.md) | 中文

Web profile 辅助插件：检测 Codex MCP 启动路径并写入宿主配置，供 Codex、Cursor 或 Claude Code 拉起 `dsh --profile codex`。它不会在 Web 进程内运行 MCP stdio 服务器。

安装到 profile：

```sh
dsh plugin --profile web add github:tonytanglab/deepseek-harness-relay-mcp
```

或安装 GitHub Release 的预构建 tarball。安装后重启 `dsh web`，然后运行 `/relay-setup`，或让 agent 调用 `relay_doctor` 与 `relay_write_mcp_config`。

## 做什么

`apply` 在 Web profile 上注册一条斜杠命令和两个工具：

- `/relay-setup` 打印 doctor 摘要和 MCP 启动 JSON。若设置了 `mcpConfigPath`，还会写入该 JSON。额外输入会被拒绝。
- `relay_doctor` 检查 `process.argv[1]` 是否为绝对且存在的 dsh 入口、`process.execPath` 是否存在、凭证路径是否存在；不读取凭证内容，也不启动 MCP stdio。
- `relay_write_mcp_config` 按 [Codex 指南](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/guide/codex.md) 生成 npx 启动块。当 `path` 是绝对 JSON 文件时写入，并合并 `mcpServers` 以保留其他服务器。

生成的命令是 `npx --yes --package=@deepseek-ai/dsh@0.1.0-rc.5 -- dsh --profile codex`。本插件从不使用 `npx.cmd` 或 `shell: true`，也从不导入 `StdioServerTransport`。

## 配置

| 字段 | 默认值 | 含义 |
|---|---|---|
| `mcpServerName` | `dsh-relay` | `mcpServers` 下的键 |
| `mcpConfigPath` | 未设置 | `/relay-setup` 写入的绝对 JSON 路径 |
| `allowedWorkspaceRoots` | `[]` | 空则读取 `DSH_MCP_WORKSPACE_ROOTS` |
| `credentialsPath` | `$DSH_HOME/.credentials.yaml` | 共享凭证文档；也可用 `DSH_MCP_CREDENTIALS_PATH` |
| `dataDirectory` | `$DSH_HOME/codex-services` | Codex 服务主目录；也可用 `DSH_MCP_DATA_DIR` |
| `dshPackage` | `@deepseek-ai/dsh@0.1.0-rc.5` | 生成 npx 参数时钉死的包 |
| `host` | `codex` | `/relay-setup` 写入的默认宿主：`codex`、`cursor` 或 `claude-code` |

用户可在 profile 的 `cordis.patch.yml` 中覆盖这些行。无效配置会在插件加载时失败。

## 配置之后

把 MCP 宿主指向打印出的启动块。会话的启动、等待、steering（中途引导）和取消仍由 `dsh --profile codex` 提供，见 [`@deepseek-ai/dsh-mcp-codex`](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/mcp/mcp-codex/README.md) 与 [Codex 指南](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/guide/codex.md)。附带的 [skill](skill/SKILL.md) 描述该工作流。

## Model Experience

### 工具 schema

#### 模型看见什么

`relay_doctor` 的参数对象为空。`relay_write_mcp_config` 要求 `host` 为 `codex`、`cursor` 或 `claude-code`，并接受可选的绝对 `path`。

#### Token 影响

工具可见时，每次请求都有固定的 schema 成本。

#### KV Cache 影响

在定义与可见性不变时前缀稳定。

### 工具调用历史与结果

#### 模型看见什么

`relay_doctor` 返回含 `ok`、launcher 的 `direct`/`exists`/`shell: false`、工作区根和凭证 `path`/`exists` 的 JSON，从不包含凭证文件内容。`relay_write_mcp_config` 返回 `{ written, path, host, serverName, config }`，其中 `config.args` 含 `--profile` 与 `codex`。`/relay-setup` 成功文本以 `DSH Relay is loaded in this Web profile. It does not run the MCP stdio server here.` 开头。额外输入返回 `The /relay-setup command does not accept extra input.`

#### Token 影响

按次调用，受 JSON 报告与启动块大小限制。

#### KV Cache 影响

与先前轮次独立。

## Known Limitations and Deferred Work

- **进程内没有 MCP stdio** — 把本 bundle 装进 web profile 不会露出 Codex 的十一个 MCP 工具。那些工具仍在 `dsh --profile codex`。
- **没有 Settings UI** — v0.1.0 没有 `dsh.client` 表单；配置路径是 `/relay-setup` 和这两个工具。
