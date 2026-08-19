# DSH Relay

English | [中文](SKILL.zh.md)

Use this skill after `dsh-relay` is installed in the Web profile. The plugin diagnoses and writes MCP configuration. It does not run the MCP stdio server inside Web.

## Configure an MCP host

1. Call `relay_doctor` (or `/relay-setup`) and fix any `ok: false` launcher or credentials check. `shell` must stay `false`.
2. Call `relay_write_mcp_config` with `host` set to `codex`, `cursor`, or `claude-code`. Pass `path` for Cursor/Claude JSON (`~/.cursor/mcp.json`) or Codex TOML (`~/.codex/config.toml`).
3. Point that host at the returned `config`: `node <plugin>/lib/mcp.js` with `DSH_WEB_URL=http://127.0.0.1:3080`. Cursor and Codex must share this same server.

## After the host is connected

Cursor and Codex share this Relay MCP. It attaches to the running Harness Web:

1. Call `doctor` and resolve failed checks.
2. Call `start_run` with the complete task, an absolute `workspace`, and `model` when the user names one. Trailing `max`/`high`/`low` is reasoning effort (`K3 MAX` → `k3`+`max`). Leave `openBrowser` false.
3. Put a markdown link to `webUrl` in the reply immediately (`http://127.0.0.1:3080/?sessionId=...`). Do not open the OS browser.
4. Call `wait_run` in intervals of at most 30 seconds. Use `steer_run` for a live correction.
5. Use `cancel_run` to stop an active turn. Continue a terminal session with `start_run.sessionId`.

Do not spawn `dsh --profile codex`. Do not wrap the command in `npx.cmd` or a shell.
