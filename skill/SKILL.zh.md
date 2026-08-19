# DSH Relay

[English](SKILL.md) | 中文

在 Web profile 安装 `dsh-agents-relay` 之后使用本 skill（插件列表标题为 `agents-relay`）。该插件只检测并写入 MCP 配置，不会在 Web 进程内运行 MCP stdio 服务器。

## 配置 MCP 宿主

1. 调用 `relay_doctor`（或 `/relay-setup`），修复任何 `ok: false` 的启动器或凭证检查。`shell` 必须保持 `false`。
2. 调用 `relay_write_mcp_config`，将 `host` 设为 `codex`、`cursor` 或 `claude-code`。写入 Cursor/Claude 的 JSON（`~/.cursor/mcp.json`）或 Codex 的 TOML（`~/.codex/config.toml`）时传入 `path`。
3. 把该宿主指向返回的 `config`：`node <plugin>/lib/mcp.js`，并带上 `DSH_WEB_URL=http://127.0.0.1:3080`。Cursor 和 Codex 必须共用这一台 Relay MCP。

## 宿主连上之后

Cursor 和 Codex 共用这台 Relay MCP。它接到已经在跑的 Harness Web：

1. 调用 `doctor` 并处理失败项。
2. 调用 `start_run`，传入完整任务、绝对 `workspace`；用户点名模型时再传 `model`。名称末尾的 `max`/`high`/`low` 是推理等级：`K3 MAX` 表示 `k3`+`max`，`deepseek v4 flash max` 表示 `deepseek-v4-flash`+`max`。不要设置 `openBrowser`。
3. 立刻用 Markdown 给出 `webUrl` 链接（`http://127.0.0.1:3080/?sessionId=...`）。不要打开系统浏览器。
4. 以不超过 30 秒的间隔调用 `wait_run`。现场纠正使用 `steer_run`。
5. 用 `cancel_run` 停止进行中的轮次。已结束的会话用 `start_run.sessionId` 继续。

不要再拉起 `dsh --profile codex`。不要把命令再包一层 `npx.cmd` 或 shell。
