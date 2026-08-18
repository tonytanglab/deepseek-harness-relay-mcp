# 在 Codex 中使用 DeepSeek Harness

[English](codex.md) | 中文

`codex` profile 让 Codex 把一项任务委托给可见的 DeepSeek Harness 会话，同时保留计划、复核和验证的主控权。提示词一经接纳就会返回实时 Web 链接，你可以观察、steering（中途引导）、取消或继续同一会话。

## 配置 MCP 服务器

在 Codex MCP 配置中加入固定版本的 Harness CLI：

```json
{
  "mcpServers": {
    "deepseek-harness": {
      "command": "npx",
      "args": ["--yes", "--package=@deepseek-ai/dsh@0.1.0-rc.5", "--", "dsh", "--profile", "codex"]
    }
  }
}
```

浏览器默认不会自动打开。`start_service` 返回服务根 URL，`start_run` 返回精确指向可见会话的 `/?sessionId=<SessionId>`。仅在希望打开平台浏览器时调用 `open_service` 或传入 `openBrowser: true`。

## 运行委托任务

1. 调用 `doctor`，解决直接启动或工作区策略检查中的失败项。
2. 使用完整任务和绝对 `workspace` 调用一次 `start_run`。
3. 立即展示返回的 `webUrl`。Codex 复核文件或独立运行检查时，该链接仍然可用。
4. 以最长 30 秒的区间调用 `wait_run`，直到运行进入终态。超时会返回仍在运行的当前快照，而不是错误。活动 agent 需要纠偏时，使用其 `runId` 和新增指令调用 `steer_run`；纠偏仍属于同一个运行和会话。
5. 独立复核工作区差异和测试结果，不依赖 Harness 返回的 assistant 文本。

使用 `cancel_run` 可停止活动轮次而不关闭 Web 服务。运行进入终态后，要纠正或扩展已完成的工作，再次调用 `start_run` 并传入之前的 `sessionId`；该会话必须属于同一工作区、处于 idle，且没有活动 MCP 运行。

## 状态与持久化

每个规范化工作区映射到一个受管 Web 进程和工作区专属 Harness home。同一工作区的并发 `start_service` 会共享同一个启动操作。不同会话和工作区可以并行，但一个会话同时只接受一个 MCP 运行。

服务和 run ID 由当前 MCP 进程监管。进程重启后旧 run ID 会丢失。session ID 及其工作区数据保留在磁盘上，因此新的 `start_run(sessionId)` 可以继续早先的会话。内联 assistant 响应是有界 UTF-8 尾部；完整 transcript（文本记录）应从 Web 链接查看。

## Windows 故障排查

Codex 启动器可以使用配置中的外层 `npx` 启动已发布 CLI。此后 Harness 不会 spawn `npx`、`npx.cmd` 或 shell。它通过当前 Node 可执行文件和绝对 `dsh` 入口启动 Web 子进程，然后等待结构化 loopback readiness 记录。

如果 `doctor.launcher.direct` 或 `doctor.launcher.exists` 为 false，请通过上述配置启动已发布的 `dsh` 二进制，不要再套一层脚本。如果 readiness 失败，请检查 `list_services[].logTail`；非法 UTF-8、畸形 readiness、非 loopback URL、超时和进程提前退出都属于启动失败。`stop_service` 和 MCP 拆卸会取消活动工作，并确认完整 Windows 进程树已经退出。
