# Harness Relay 开发约束

- 从本地 Marketplace 源更新 Codex 插件前，必须先运行 `pnpm run prepare:codex-local`，再生成 cachebuster 并执行 `codex plugin add`。Codex 安装器只复制文件，不会自动构建 `dist/`。
- 不得以 `.codex-plugin/plugin.json` 或 `codex plugin list` 显示的版本作为运行时已升级的唯一证据；必须在新 Codex 任务中验证 `doctor.relayVersion`，并确认完整工具目录包含 `list_capabilities`、`start_review` 与 `wait_run`。
- 删除旧缓存前先确认新缓存已完整生成。已有任务可能继续持有旧 MCP 进程；安装后应新建任务，必要时重启 Codex，再做最终验收。
- 正式用户优先通过仓库 Marketplace 的 npm 源安装。只有明确进行本地插件开发时才使用 personal Marketplace 的本地源码源。
