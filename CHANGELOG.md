# CHANGELOG

## 0.1.3 - 2026-08-19

- MCP stdio attaches to the already-running Harness Web (`http://127.0.0.1:3080`) so Cursor and Codex share one Relay server. `start_run` can select a model (`k3`, `Kimi K3`) via `session.selectModel` before prompting, and returns `webUrl` as a link without opening a browser. `relay_write_mcp_config` writes Cursor JSON or Codex TOML. The Web plugin still does not own stdin/stdout.

## 0.1.2 - 2026-08-19

- 将 MCP 启动包同步至最新版 DeepSeek Harness `0.1.0-rc.7`，并验证真实 Web profile 安装与运行。
- 修正当前 DeepSeek Harness 依赖兼容范围，将宿主提供的 peer API 标记为安装时可选并关闭 peer 自动安装，补充本地插件安装前的构建说明；验证插件可构建、安装并加入 Web profile。

## 0.1.0 - 2026-08-18

- 发布 Web-profile MCP 配置助手：诊断 launcher，并为 Codex、Cursor、Claude Code 写入 MCP 配置。
