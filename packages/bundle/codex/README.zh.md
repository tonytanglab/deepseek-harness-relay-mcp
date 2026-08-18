# @deepseek-ai/dsh-codex

[English](README.md) | 中文

`dsh --profile codex` 的 profile bundle。它在 `@deepseek-ai/dsh-base` 上叠加 `@deepseek-ai/dsh-mcp-codex`，禁用 HMR，并通过 stdio 提供 MCP。MCP 进程通过独立的 `web` profile 启动可见 Web 应用；它本身不是 HTTP 服务器。

在 Codex MCP 配置中运行已发布 CLI：

```json
{
  "command": "npx",
  "args": ["--yes", "--package=@deepseek-ai/dsh@0.1.0-rc.5", "--", "dsh", "--profile", "codex"]
}
```

外层 `npx` 归 Codex 启动器所有。受管 Web 子进程直接使用当前 Node 可执行文件和已解析的 `dsh` 入口，因此 Windows 启动不依赖 spawn `npx.cmd` 或启用 shell。

## 模型体验

通过 `dsh-mcp-codex` 间接生效；该包提交普通 Host 会话消息，而组合后的 Web agent 拥有提示词和工具。

#### KV Cache 影响

每个提交的任务都会追加到会话历史中，并保留此前请求前缀的复用；该 bundle 不增加单独的模型上下文。

## 已知限制与延后工作

- **运行状态仅存在于进程内。** 重启会保留工作区数据和 session ID，但需要用原 `sessionId` 再次调用 `start_run`；旧 run ID 的等待无法恢复。
- **打开浏览器为显式选择。** 除非工具调用主动请求，否则该 profile 不会打开浏览器。
