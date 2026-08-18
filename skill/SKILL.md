# DSH Relay

English | [中文](SKILL.zh.md)

Use this skill after `dsh-relay` is installed in the Web profile. The plugin diagnoses and writes MCP configuration. It does not run the MCP stdio server inside Web.

## Configure an MCP host

1. Call `relay_doctor` (or `/relay-setup`) and fix any `ok: false` launcher or credentials check. `shell` must stay `false`.
2. Call `relay_write_mcp_config` with `host` set to `codex`, `cursor`, or `claude-code`. Pass `path` only when writing an absolute JSON file.
3. Point that host at the returned `config`: `npx --yes --package=@deepseek-ai/dsh@<pinned> -- dsh --profile codex`, plus any `env` keys.

## After the host is connected

The MCP server is `dsh --profile codex`, not this Web plugin. On that server:

1. Call `doctor` and resolve failed checks.
2. Call `start_run` with the complete task and an absolute `workspace`.
3. Show `webUrl` immediately.
4. Call `wait_run` in intervals of at most 30 seconds. Use `steer_run` for a live correction.
5. Use `cancel_run` to stop an active turn. Continue a terminal session with `start_run.sessionId`.

Do not wrap the generated command in another `npx.cmd` or a shell.
