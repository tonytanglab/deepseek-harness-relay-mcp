# DSH Relay

[English](SKILL.md) | 中文

在 Web profile 安装 `dsh-relay` 之后使用本 skill。该插件只检测并写入 MCP 配置，不会在 Web 进程内运行 MCP stdio 服务器。

## 配置 MCP 宿主

1. 调用 `relay_doctor`（或 `/relay-setup`），修复任何 `ok: false` 的启动器或凭证检查。`shell` 必须保持 `false`。
2. 调用 `relay_write_mcp_config`，将 `host` 设为 `codex`、`cursor` 或 `claude-code`。仅在写入绝对 JSON 文件时传入 `path`。
3. 把该宿主指向返回的 `config`：`npx --yes --package=@deepseek-ai/dsh@<pinned> -- dsh --profile codex`，以及其中的 `env` 键。

## 宿主连上之后

MCP 服务器是 `dsh --profile codex`，不是这个 Web 插件。在那台服务器上：

1. 调用 `doctor` 并处理失败项。
2. 调用 `start_run`，传入完整任务和绝对 `workspace`。
3. 立即展示 `webUrl`。
4. 以不超过 30 秒的间隔调用 `wait_run`。现场纠正使用 `steer_run`。
5. 用 `cancel_run` 停止进行中的轮次。已结束的会话用 `start_run.sessionId` 继续。

不要把生成的命令再包一层 `npx.cmd` 或 shell。
