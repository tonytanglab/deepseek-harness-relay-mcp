# @deepseek-ai/dsh-codex

English | [中文](README.zh.md)

Profile bundle for `dsh --profile codex`. It layers `@deepseek-ai/dsh-mcp-codex` over `@deepseek-ai/dsh-base`, disables HMR, and serves MCP over stdio. The MCP process starts visible Web applications through the separate `web` profile; it is not itself an HTTP server.

Run the published CLI from a Codex MCP configuration:

```json
{
  "command": "npx",
  "args": ["--yes", "--package=@deepseek-ai/dsh@0.1.0-rc.5", "--", "dsh", "--profile", "codex"]
}
```

The outer `npx` belongs to the Codex launcher. Managed Web children use the current Node executable and resolved `dsh` entry directly, so Windows startup does not depend on spawning `npx.cmd` or enabling a shell.

## Model Experience

Indirectly, through `dsh-mcp-codex`, which submits ordinary Host session messages while the composed Web agent owns prompts and tools.

#### KV Cache effect

Each submitted task is append-only session history and preserves reuse of the earlier request prefix; the bundle adds no separate model context.

## Known Limitations and Deferred Work

- **Run state is process-local.** A restart keeps workspace data and session IDs but requires a new `start_run` call with the prior `sessionId`; it cannot resume waiting on an old run ID.
- **Browser opening is opt-in.** The profile does not open a browser unless a tool call requests it.
