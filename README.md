# dsh-relay

English | [中文](README.zh.md)

Web-profile helper that diagnoses the Codex MCP launch path and writes host configuration so Codex, Cursor, or Claude Code can spawn `dsh --profile codex`. It does not run the MCP stdio server in the Web process.

Install into a profile:

```sh
dsh plugin --profile web add github:tonytanglab/deepseek-harness-relay-mcp
```

or install the GitHub Release tarball for a prebuilt `lib/`. Restart `dsh web` after install. Then run `/relay-setup` or ask the agent to call `relay_doctor` and `relay_write_mcp_config`.

## What it does

`apply` registers one slash command and two tools on the Web profile:

- `/relay-setup` prints the doctor summary and MCP launch JSON. When `mcpConfigPath` is set, it also writes that JSON. Extra input is rejected.
- `relay_doctor` checks that `process.argv[1]` is an absolute existing dsh entry, that `process.execPath` exists, and that the credentials path exists, without reading credential contents and without starting MCP stdio.
- `relay_write_mcp_config` builds the npx launch block from [the Codex guide](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/guide/codex.md). It writes the block when `path` is an absolute JSON file, merging `mcpServers` so other servers remain.

The generated command is `npx --yes --package=@deepseek-ai/dsh@0.1.0-rc.5 -- dsh --profile codex`. The helper never uses `npx.cmd` or `shell: true`, and it never imports `StdioServerTransport`.

## Configuration

| Field | Default | Meaning |
|---|---|---|
| `mcpServerName` | `dsh-relay` | Key under `mcpServers` |
| `mcpConfigPath` | unset | Absolute JSON path `/relay-setup` writes |
| `allowedWorkspaceRoots` | `[]` | Empty reads `DSH_MCP_WORKSPACE_ROOTS` |
| `credentialsPath` | `$DSH_HOME/.credentials.yaml` | Shared credentials document; also `DSH_MCP_CREDENTIALS_PATH` |
| `dataDirectory` | `$DSH_HOME/codex-services` | Codex service homes; also `DSH_MCP_DATA_DIR` |
| `dshPackage` | `@deepseek-ai/dsh@0.1.0-rc.5` | Pinned package in generated npx args |
| `host` | `codex` | Default host for `/relay-setup` writes: `codex`, `cursor`, or `claude-code` |

Users override rows in the profile `cordis.patch.yml`. Invalid configuration fails plugin load.

## After setup

Point the MCP host at the printed launch block. Session start, wait, steer, and cancel stay on `dsh --profile codex`, documented in [`@deepseek-ai/dsh-mcp-codex`](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/mcp/mcp-codex/README.md) and the [Codex guide](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/guide/codex.md). The bundled [skill](skill/SKILL.md) names that workflow.

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

`relay_doctor` returns JSON with `ok`, launcher `direct`/`exists`/`shell: false`, workspace roots, and credentials `path`/`exists`. It never includes credential file contents. `relay_write_mcp_config` returns `{ written, path, host, serverName, config }` whose `config.args` contain `--profile` and `codex`. `/relay-setup` success text starts with `DSH Relay is loaded in this Web profile. It does not run the MCP stdio server here.` Extra input returns `The /relay-setup command does not accept extra input.`

#### Token effect

Per call, bounded by the JSON report and the launch block.

#### KV Cache effect

Independent of earlier turns.

## Known Limitations and Deferred Work

- **No in-process MCP stdio** — installing this bundle into the web profile does not expose the eleven Codex MCP tools. Those remain on `dsh --profile codex`.
- **No Settings UI** — there is no `dsh.client` form in v0.1.0; `/relay-setup` and the two tools are the configuration path.
