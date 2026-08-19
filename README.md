# dsh-agents-relay

English | [中文](README.zh.md)

Web-profile helper that writes MCP config so **Cursor, Codex, or Claude Code** can attach to an already-running Harness Web (`http://127.0.0.1:3080` by default). It does not run the MCP stdio server in the Web process, and it does not spawn `dsh --profile codex`. In the Web plugin list the package is **dsh-agents-relay** (card title **agents-relay**, because Harness strips the `dsh-` prefix).

Install into a profile:

```sh
dsh plugin --profile web add github:tonytanglab/deepseek-harness-relay-mcp
```

or install the GitHub Release tarball for a prebuilt `lib/`. Restart `dsh web` after install. Then run `/relay-setup` or ask the agent to call `relay_doctor` and `relay_write_mcp_config`.

For a local checkout, build it before adding the directory because pnpm links local directories without running `prepare`:

```sh
pnpm install
pnpm run build
dsh plugin --profile web add file:/absolute/path/to/deepseek-harness-relay-mcp
```

The plugin accepts both the earlier prerelease Cordis/Schemastery package lines and the current Harness `@deepseek-ai/cordis` 4.x plus `@deepseek-ai/schemastery` 3.x line. These peer APIs are supplied by the Harness profile and are optional for package installation. The repository disables pnpm peer auto-installation so building the plugin does not try to fetch Harness-internal transitive packages.

## What it does

`apply` registers one slash command and two tools on the Web profile:

- `/relay-setup` prints the doctor summary and MCP launch JSON. When `mcpConfigPath` is set, it also writes that JSON. Extra input is rejected.
- `relay_doctor` checks that `process.argv[1]` is an absolute existing dsh entry, that `process.execPath` exists, and that the credentials path exists, without reading credential contents and without starting MCP stdio.
- `relay_write_mcp_config` writes a Node launch block for `lib/mcp.js`. That stdio server attaches to the running Harness Web and exposes `start_run` / `wait_run` / `steer_run` / `cancel_run` for **Cursor and Codex**.

The generated command is `node <plugin>/lib/mcp.js` with `DSH_WEB_URL=http://127.0.0.1:3080`. The helper never uses `npx.cmd` or `shell: true`, and the Web process never imports `StdioServerTransport`.

## Configuration

| Field | Default | Meaning |
|---|---|---|
| `mcpServerName` | `dsh-relay` | Key under `mcpServers` |
| `mcpConfigPath` | unset | Absolute JSON or Codex TOML path `/relay-setup` writes |
| `allowedWorkspaceRoots` | `[]` | Empty reads `DSH_MCP_WORKSPACE_ROOTS` |
| `credentialsPath` | `$DSH_HOME/.credentials.yaml` | Shared credentials document; also `DSH_MCP_CREDENTIALS_PATH` |
| `dataDirectory` | `$DSH_HOME/codex-services` | Codex service homes; also `DSH_MCP_DATA_DIR` |
| `dshPackage` | `@deepseek-ai/dsh@0.1.0-rc.7` | Kept for compatibility |
| `host` | `codex` | Default host for `/relay-setup` writes: `codex`, `cursor`, or `claude-code` |
| `webUrl` | `http://127.0.0.1:3080` | Already-running Harness Web the MCP attaches to |

Users override rows in the profile `cordis.patch.yml`. Invalid configuration fails plugin load.

## After setup

Point Cursor (`~/.cursor/mcp.json`) and Codex (`~/.codex/config.toml`) at the same launch block. Both hosts call one Relay MCP, which assigns and monitors tasks on your existing Harness Web. `start_run` accepts `model` / `provider` (for example `k3`) and returns a session link without opening a browser.

## Model Experience

### Tool schema

#### What the model sees

`relay_doctor` has an empty parameter object. `relay_write_mcp_config` requires `host` as `codex`, `cursor`, or `claude-code`, and accepts optional absolute `path`.

#### Token effect

Fixed schema cost on every request where the tools are visible.

#### KV Cache effect

Prefix-stable while the definitions and visibility are unchanged.

### Tool-call history and result

#### What the model sees

`relay_doctor` returns JSON with `ok`, launcher `direct`/`exists`/`shell: false`, workspace roots, and credentials `path`/`exists`. It never includes credential file contents. `relay_write_mcp_config` returns `{ written, path, host, serverName, config }` whose `config.args` end with `mcp.js` and whose `config.env` includes `DSH_WEB_URL`. `/relay-setup` success text starts with `DSH Relay is loaded in this Web profile. It does not run the MCP stdio server here.` Extra input returns `The /relay-setup command does not accept extra input.`

#### Token effect

Per call, bounded by the JSON report and the launch block.

#### KV Cache effect

Independent of earlier turns.

## Known Limitations and Deferred Work

- **No in-process MCP stdio** — installing this bundle into the web profile does not expose `start_run` / `wait_run` / `steer_run`. Those tools live on the separate `lib/mcp.js` stdio server that Cursor and Codex launch.
- **No Settings UI** — there is no `dsh.client` form in v0.1.x; `/relay-setup` and the two tools are the configuration path.
