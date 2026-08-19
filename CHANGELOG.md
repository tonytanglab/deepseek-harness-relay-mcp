# CHANGELOG

## 0.1.5 - 2026-08-19

- [2026-08-19 17:29] 修复同一 Harness 会话并发启动时的占用竞态，初始化失败时仅释放当前运行持有的占位。
- [2026-08-19 17:29] 修复取消 RPC 失败后仍残留 `cancelRequested` 的误分类问题，并让 `wait_run` / `cancel_run` 的内部 RPC 与轮询共同服从截止时间。
- [2026-08-19 17:29] 恢复 `RunSnapshot.finishedAt` 类型，新增 TypeScript 类型检查命令及并发、取消失败、超时预算回归测试；完整依赖安装与全量验证按用户要求留待后续环境继续。
- Web plugin id/package is `dsh-agents-relay` (list title `agents-relay` after Harness strips `dsh-`). The MCP server key stays `dsh-relay`.
- `turn/end` reasons follow the wire protocol (`completed` / `aborted` / `error` / `blocked` / `interrupted` / `max-tokens`): a user stop reports `cancelled`, and blocked / interrupted / max-tokens turns report `failed` instead of `succeeded`.
- `start_run` refuses a session that already has an active Relay run, verifies a reused session belongs to the given workspace, and rejects subagent sessions.
- `cancel_run` is idempotent for terminal runs and waits up to 10 seconds for the cancelled turn to settle instead of claiming `cancelled` immediately.
- `wait_run` / `get_run` / `list_runs` survive transient Harness Web errors: transport failures surface as `lastRefreshError` on the snapshot and no longer abort the wait.
- The test suite is runnable in this repository (`pnpm test`, vitest + pinned Harness packages); `package.json` is unified at `dsh-agents-relay@0.1.5`.

## 0.1.4 - 2026-08-19

- `wait_run` / `get_run` / `list_runs` refresh from `session.history` and honor `turn/end` (failed turns stay `failed`, with `error` and last assistant `text`).
- Do not mark a run succeeded until `turn/end`; idle `session.list` before the turn starts no longer completes early.
- `cancel_run` only sets cancelled after `session.cancel` succeeds.
- Workspace roots are resolved so `..` cannot escape `DSH_MCP_WORKSPACE_ROOTS`.
- `K3 MAX` / `deepseek v4 flash max` select the model plus reasoning effort `max`, not a different model id. `doctor` returns the attached catalog.

## 0.1.3 - 2026-08-19

- MCP stdio attaches to the already-running Harness Web (`http://127.0.0.1:3080`) so Cursor and Codex share one Relay server. `start_run` can select a model (`k3`, `Kimi K3`) via `session.selectModel` before prompting, and returns `webUrl` as a link without opening a browser. `relay_write_mcp_config` writes Cursor JSON or Codex TOML. The Web plugin still does not own stdin/stdout.

## 0.1.2 - 2026-08-19

- 将 MCP 启动包同步至最新版 DeepSeek Harness `0.1.0-rc.7`，并验证真实 Web profile 安装与运行。
- 修正当前 DeepSeek Harness 依赖兼容范围，将宿主提供的 peer API 标记为安装时可选并关闭 peer 自动安装，补充本地插件安装前的构建说明；验证插件可构建、安装并加入 Web profile。

## 0.1.0 - 2026-08-18

- 发布 Web-profile MCP 配置助手：诊断 launcher，并为 Codex、Cursor、Claude Code 写入 MCP 配置。
