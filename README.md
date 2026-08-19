# Harness Relay MCP

English | [简体中文](README.zh-CN.md)

**Delegate and monitor DeepSeek Harness work from any MCP agent.**

Delegate long-running work to DeepSeek Harness from any MCP-capable agent—and monitor it to completion.

Harness Relay MCP connects MCP clients to the native DeepSeek Harness session and event model. Its recommended form is a tree-external Harness bundle; it does not wrap the CLI, patch Harness source, or own the Harness process.

```text
MCP agent
   │
   ├─ start_run ── provider / model / reasoning / preset / permission
   │
   ├─ status_run / wait_run / steer_run / cancel_run
   │
   └─ durable result + native Harness Web session URL
```

## Positioning: Harness control plane, not a model wrapper

Harness Relay MCP is an independent third-party project. It is not developed, endorsed, or supported by DeepSeek AI.

> **This is not a DeepSeek model wrapper. It is the MCP control plane for DeepSeek Harness.**

Do not confuse three different integration directions:

- The official DeepSeek Harness repository currently documents [`mcp-client`](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/mcp/README.md), which lets Harness consume external MCP servers. It is the opposite direction from exposing Harness as an MCP-controlled worker.
- Direct DeepSeek MCP servers call a model API and return model output. They do not enter the native Harness session, plugin, workspace, permission, or event lifecycle.
- Harness Relay MCP attaches to an existing official Harness Host and exposes that Host's native capabilities to external MCP agents.

As of 2026-08-20, the official [`dsh` launcher source](https://github.com/deepseek-ai/deepseek-harness/blob/master/apps/cli/src/args.ts) provides profile boot and plugin management but no documented outbound `dsh mcp` server command. DeepSeek Harness is a developer preview, so re-check the official repository before relying on this comparison.

**Comparison last verified: 2026-08-20.**

| Capability | Official Harness today | Direct DeepSeek MCP | Harness Relay MCP |
|---|---|---|---|
| Primary direction | Harness consumes MCP tools | MCP client calls a DeepSeek model | MCP client controls a running Harness Host |
| Native Harness sessions/events | Native internally, not exported by a documented MCP server | No | Yes |
| Harness plugins, tools, and sandbox | Native internally | No | Executed by Harness |
| Provider/model/reasoning/preset selection | Available in Harness UI and APIs | Usually a small fixed model surface | Discovered from and selected through the Host |
| Native permission presets | Internal Harness behavior | No workspace permission model | `read-only`, `workspace-write`, `danger-full-access` |
| Long-running lifecycle | Operated inside Harness | Usually one request/response | Start, status, wait, steer, reply, cancel, reopen |
| Durable monitoring and recovery | Harness-owned session history | Usually none | Relay identities, idempotency, reconciliation, and restart recovery |
| Harness Web session link | Native UI | No | Returned and verifiable |
| Setup and maintenance | Lowest when using Harness directly | Simplest MCP option | More components and ongoing Harness compatibility work |

### Choose the right tool

- Use a direct DeepSeek MCP server for bounded classification, extraction, summarization, or a quick second opinion where plain model output is enough.
- Use Harness Relay MCP when the task must run inside DeepSeek Harness and needs its registered workspaces, tools, plugins, provider catalog, native permissions, persistent sessions, long-running monitoring, recovery, or Web inspection.
- Do not install Relay only to replace one ordinary chat-completions request; the additional Host, state, authentication, and proxy layers would add complexity without providing useful control-plane value.

## Highlights

- Native Harness sessions and durable events instead of CLI output parsing.
- Complete asynchronous lifecycle: start, status, wait, steer, reply, cancel, and reopen.
- Provider, model, reasoning effort, agent preset, and native permission selection before the first task prompt.
- Direct support for `read-only`, `workspace-write`, and `danger-full-access` Harness permissions.
- Ordered text and inline image prompts with bounded base64 validation.
- Persistent run identities and recovery after the MCP server restarts.
- Stable Harness Web session links, with explicit visible-page verification in the bundled Skill.
- Compatible with Codex, Claude Code, OpenCode, Cursor, and other standards-compliant MCP clients.
- The internal bundle uses the official InProcess ApiProxy and native permission service; external agents connect through authenticated HTTP or the stateless stdio proxy.
- The standalone `dsh-relay` mode remains available for older Harness versions and explicit rollback.

## Requirements

- Node.js `^22.19` or `>=24`.
- Internal mode requires the DeepSeek Harness `0.1.0-rc.7` compatible line, the `web` profile, and a `127.0.0.1` bind.
- Standalone compatibility mode requires a running DeepSeek Harness Web Host on loopback HTTP.
- The target workspace must already be registered by Harness or be inside an explicitly configured allowed root.

The default Host is:

```text
http://127.0.0.1:3080/
```

## Installation

### Install as a Harness bundle (recommended)

Install the published package from npm with the official profile command, inspect the composed configuration, and then start the profile:

```powershell
dsh plugin --profile web add harness-relay-mcp
dsh --profile web --dump-config
dsh --profile web
```

For an offline or pinned-file installation, download the release tarball and replace `harness-relay-mcp` in the first command with its local `.tgz` path.

The dump must contain `id: harness-relay-mcp` and `name: 'harness-relay-mcp'`, so the Harness inventory shows the slash-free name `harness-relay-mcp`. If `dsh web` is already running, restart that Host after an install or upgrade so it loads the new bundle. Once started, the bundle continues to publish its non-secret descriptor at the backward-compatible path `$DSH_HOME/plugins/dsh-relay/web/relay-endpoint.json`; its Bearer token lives separately in the Host-specific state directory.

Uninstalling infrastructure does not cancel submitted Harness work:

```powershell
dsh plugin --profile web remove harness-relay-mcp
```

Do not configure Relay into the same Harness MCP client, which would create a `Harness → Relay → Harness` recursion.

### Codex plugin

When the local `personal` marketplace contains this plugin:

```powershell
codex plugin add deepseek-harness-relay@personal
```

Start a new Codex thread after installation so Codex loads the MCP server and the `delegate-to-deepseek-harness` Skill.

### Local development

```powershell
pnpm install
pnpm run build
```

After the internal bundle starts, point MCP clients at the universal stdio proxy:

```json
{
  "mcpServers": {
    "harness-relay-mcp": {
      "command": "node",
      "args": ["C:/Users/you/plugins/deepseek-harness-relay-mcp/dist/dsh-relay-proxy.mjs"],
      "env": {
        "DSH_RELAY_CLIENT_PRINCIPAL_ID": "cursor:project"
      }
    }
  }
}
```

The proxy defaults to `$DSH_HOME/plugins/dsh-relay/web/relay-endpoint.json`; set `DSH_RELAY_ENDPOINT_DESCRIPTOR` when using a custom state directory. Client configuration never stores the token. The `harness-relay-mcp` package root is the Harness bundle and ships `harness-relay-mcp` plus `harness-relay-mcp-proxy`; the old `dsh-relay` commands remain compatibility aliases.

## Quick start

First discover the native Harness workspace registry instead of treating the Host process directory as an authorization list:

```json
{
  "tool": "list_workspaces",
  "arguments": {}
}
```

Then discover the Host capabilities instead of guessing route names:

```json
{
  "tool": "list_capabilities",
  "arguments": {}
}
```

Then dispatch a read-only Kimi K3/MAX review:

```json
{
  "tool": "start_review",
  "arguments": {
    "workspace": "D:/work/project",
    "task": "Review this workspace and return reproducible findings only.",
    "provider": "kimi-coding",
    "model": "k3",
    "reasoningEffort": "max",
    "agentPreset": "standard",
    "idempotencyKey": "review-2026-08-19-001"
  }
}
```

Store the returned `runId`, `sessionId`, and `webUrl`. Poll without blocking indefinitely:

```json
{
  "tool": "wait_run",
  "arguments": {
    "runId": "<run-id>",
    "timeoutMs": 30000
  }
}
```

For an active correction, use `steer_run`. After a run reaches a terminal state, use `reply_run` to continue the same native Harness session.

Omitting both `sessionId` and `sessionMode` creates a fresh session inside the selected Harness workspace. To continue an existing project conversation, call `list_workspace_sessions` first and pass its idle `sessionId`, or pass `sessionMode: "latest-idle"` to reuse the newest nonblank, idle, unarchived session. An explicit `sessionId` cannot be combined with `sessionMode`.

## Run lifecycle

```text
start_run
   │
   ├─ reserve the session
   ├─ select model and native permission preset
   ├─ persist runId + prompt rpcId
   ├─ submit session.prompt
   └─ reconcile durable history

running ── status/wait/steer/cancel ──> succeeded | incomplete | failed | cancelled | needs_attention
   │
   └─ terminal ── reply_run ──> a new run in the same session
```

`promptAdmission` reports the prompt admission state:

| Value | Meaning |
| --- | --- |
| `pending` | The run identity is durable, but prompt submission has not completed. |
| `accepted` | Harness accepted the prompt or its durable message was observed. |
| `unknown` | The transport response was unavailable; reconcile by `rpcId` instead of submitting a duplicate. |
| `rejected` | Harness did not persist or accept the prompt. |

## `start_run` parameters

| Parameter | Required | Description |
| --- | --- | --- |
| `workspace` | Yes | Absolute workspace path allowed by Relay policy. |
| `task` | One prompt form | Plain-text task. Mutually exclusive with `content`. |
| `content` | One prompt form | Ordered text/image blocks. Mutually exclusive with `task`. |
| `sessionId` | No | Reuse an idle session in the selected workspace. |
| `sessionMode` | No | `fresh` or `latest-idle`; defaults to `fresh` and cannot be combined with `sessionId`. |
| `provider` | With `model` | Exact provider ID returned by `list_capabilities`. |
| `model` | With `provider` | Exact model ID returned by `list_capabilities`. |
| `reasoningEffort` | No | Adapter-supported effort such as `low`, `high`, or `max`. |
| `agentPreset` | No | Harness agent preset; selectable only for a fresh session. |
| `permissionPreset` | No | Native permission preset; defaults to `read-only`. |
| `confirmedDangerousPermission` | For full access | Must be `true` before `danger-full-access` is accepted. |
| `idempotencyKey` | Recommended | Stable caller key; a retry with the same request returns the original operation instead of resubmitting. |
| `openBrowser` | No | Ask the OS to open the native session URL. |

### Image prompts

Use canonical base64 without a `data:` URL prefix:

```json
{
  "workspace": "D:/work/project",
  "content": [
    { "type": "text", "text": "Review this screenshot." },
    {
      "type": "image",
      "mediaType": "image/png",
      "data": "<canonical-base64>",
      "name": "screen.png"
    }
  ]
}
```

Supported media types are PNG, JPEG, WebP, and GIF. Image bytes are forwarded to Harness but are not retained in Relay run snapshots or state files.

## Native permission presets

| Preset | Intended use |
| --- | --- |
| `read-only` | Review, diagnosis, research, comparison, and planning. |
| `workspace-write` | Implementation restricted to the authorized workspace. |
| `danger-full-access` | Full Harness access; use only when the caller intentionally authorizes it. |

DSH Relay invokes the native Harness `/permission` command through `commands/execute` and verifies the resulting session projection before submitting the first task prompt. A textual instruction is never treated as a permission boundary.

## MCP tools

| Tool | Purpose |
| --- | --- |
| `doctor` | Check the Relay package, Host connection, workspace policy, and persistent state. |
| `setup_plan` | Generate a validated, no-write client configuration patch. |
| `setup_doctor` | Evaluate a setup plan and caller-supplied probes as a machine-readable report. |
| `start_service` | Attach an authorized workspace to the existing Harness Host. |
| `open_service` | Open the Host root URL. |
| `list_services` | List restored workspace attachments. |
| `list_workspaces` | List the native Harness workspace registry used for routing. |
| `list_workspace_sessions` | List direct sessions in one registered workspace without reading conversation content. |
| `stop_service` | Detach Relay state without stopping Harness. |
| `list_capabilities` | List provider/model/reasoning and agent preset choices plus native permission modes. |
| `start_run` | Create or reuse a session and submit a tracked task. |
| `start_review` | Submit a task with the native permission preset fixed to `read-only`. |
| `steer_run` | Insert a correction into an active run. |
| `get_run` | Read and reconcile one run; compatibility alias for `status_run`. |
| `get_run_summary` | Project a run into stable status, model, permission, elapsed-time, and next-action fields. |
| `status_run` | Reconcile one run from Host state and durable events. |
| `open_run` | Open the native Harness Web session URL. |
| `wait_run` | Wait for progress for up to 30 seconds. |
| `list_runs` | Reconcile and list persisted runs. |
| `get_operation` | Read one durable idempotent start, reply, steer, or cancel operation. |
| `reconcile_operation` | Resolve an uncertain operation from durable Harness events without duplicate submission. |
| `reconcile_permissions` | Retry restoration of expired or interrupted native permission leases. |
| `reply_run` | Continue a completed session as a new tracked run. |
| `cancel_run` | Request native Harness cancellation. |
| `read_notifications` | Replay the bounded in-process notification projection after a cursor. |

## Client setup and monitoring projection

`setup_plan` supports Codex, Claude Code, Cursor, and the explicitly versioned OpenCode V2 layout. It accepts already-resolved absolute Node and Relay entry paths and returns only a structured minimal patch; it never edits a client configuration. The launcher platform must match the configuration platform, and package-manager shims such as `pnpm.exe` or `pnpm.cmd` are rejected as Node runtimes.

`setup_doctor` is also side-effect free. Filesystem, Broker, Host, workspace, model, and permission facts must be supplied by an authorized caller; omitted probes are reported as `skipped` instead of being guessed.

`get_run_summary` consumes the authoritative Relay run snapshot and exposes the versioned monitoring projection. `read_notifications` replays notifications retained by the current MCP server process and returns explicit cursor-gap metadata. Native MCP notification transport is not enabled yet, so clients must treat an empty buffer as normal and fall back to `get_run_summary`, `wait_run`, or `status_run` polling.

## Persistence and recovery

The default state file is:

```text
%LOCALAPPDATA%/dsh-relay/state.json
```

State is schema-validated, locked across processes with owner-verified leases, and written through atomic replacement with restrictive file permissions where supported. Stale writers cannot regress stopped services, terminal runs, attention states, operations, or permission leases. Invalid files are quarantined rather than overwritten. By default, prompt text and image bytes are not persisted. After a Relay restart, run and operation identities are restored and reconciled with native Harness history. Assistant text from the reconciled turn is retained in event order instead of returning only the final assistant message. A run that produces no durable progress for the configured interval enters `needs_attention` with `attentionReason: run_stalled`; later progress automatically returns it to `running`.

Multiple local MCP server processes may share one state file; writes are serialized and merged by stable identifiers. An abandoned lock fails closed instead of being deleted by age. Use separate `DSH_RELAY_STATE_FILE` paths when clients require operational isolation.

## Session links

Each run returns a native URL in this form:

```text
http://127.0.0.1:3080/?sessionId=<session-id>
```

An HTTP 200 response proves only that the Host answered; it does not prove that a very large live transcript finished rendering. The bundled Skill calls `open_run` and verifies the visible workspace and session before presenting the URL as openable. Harness may normalize the address bar back to the Host root while retaining the selected session.

## Configuration

| Environment variable | Default | Purpose |
| --- | --- | --- |
| `DSH_RELAY_HOST_URL` | `http://127.0.0.1:3080/` | Loopback Harness Host URL. |
| `DSH_RELAY_ALLOWED_WORKSPACE_ROOTS` | Harness workspace registry | OS-delimited list of additional authorized absolute roots. Without it, Relay accepts only workspaces already registered by Harness. |
| `DSH_RELAY_STATE_FILE` | `%LOCALAPPDATA%/dsh-relay/state.json` | Persistent Relay state location. |
| `DSH_RELAY_PERSIST_PROMPT_TEXT` | `false` | Persist prompt summaries when explicitly acceptable. |
| `DSH_RELAY_CLIENT_PRINCIPAL_ID` | `local-user` | Stable local caller identity used with idempotency keys. |
| `DSH_RELAY_PERMISSION_LEASE_MS` | `86400000` | Maximum lifetime recorded for a reused-session permission lease. |
| `DSH_RELAY_RPC_TIMEOUT_MS` | `30000` | Host RPC timeout. |
| `DSH_RELAY_POLL_INTERVAL_MS` | `750` | Active-run polling interval. |
| `DSH_RELAY_MAX_HISTORY_PAGES` | `100` | Maximum durable-history pages read during one reconciliation. |
| `DSH_RELAY_RUN_STALL_MS` | `300000` | No-progress interval before an active run is marked `needs_attention`; later progress resumes it automatically. |
| `DSH_RELAY_MAX_TASK_CHARACTERS` | `100000` | Maximum text characters in one prompt. |
| `DSH_RELAY_MAX_ASSISTANT_TEXT_BYTES` | `256000` | Maximum returned assistant-text tail. |
| `DSH_RELAY_MAX_IMAGE_BYTES` | `5242880` | Maximum decoded bytes per image. |
| `DSH_RELAY_MAX_IMAGES` | `20` | Maximum images per message. |
| `DSH_RELAY_MAX_MESSAGE_IMAGE_BYTES` | `104857600` | Maximum decoded image bytes per message. |

Only loopback HTTP Hosts are accepted. Workspace paths are resolved through the filesystem before containment is checked.

## Security model

- Harness Relay MCP does not read or store Harness credentials.
- The existing Harness Host remains authoritative for models, permissions, sessions, attachments, and task execution.
- The default permission preset is `read-only`.
- Without explicit roots, the Harness workspace registry is the routing authority; configured roots remain a stricter local boundary when present.
- `stop_service` never stops Harness or deletes a session.
- Harness findings are evidence; the calling agent remains responsible for final verification and high-stakes decisions.
- Relay cannot guarantee whether Codex or another MCP client will request approval or run auto-review; those decisions remain governed by the client, its policy, and the requested operation.

## Standards boundary

Harness Relay MCP uses a dual-layer compatibility design. The `harness-relay-mcp` package root is an out-of-tree, in-process bundle that follows the Harness/Cordis contract, exports `Config/apply(ctx)`, and installs through `dsh.bundle` plus `cordis.patch.yml`. External agents use the same internal authority through authenticated HTTP or the stateless proxy; the standalone entry remains a compatibility and rollback path. No Harness product source is copied or modified.

See the official DeepSeek Harness documentation for [creating a Harness plugin](https://deepseek-harness.github.io/deepseek-harness/develop/basic/) and [publishing bundles](https://deepseek-harness.github.io/deepseek-harness/develop/basic/publish).

## Development and validation

`version.json` is the only editable version source. A build synchronizes package and Codex manifests before emitting the self-contained MCP bundle.

```powershell
pnpm run test
pnpm run build
pnpm run test:mcp
pnpm run check:package
pnpm pack --dry-run
```

`prepack` performs strict TypeScript checking, builds the bundle, and validates the explicit publication whitelist. Sensitive/runtime-generated directories and files are rejected, symbolic links are rejected, and the default expanded-file budget is 8 MiB. Release automation may lower or raise that gate with `DSH_RELAY_PACKAGE_MAX_BYTES`; raising it should be reviewed rather than used to bypass unexpected package growth. `test:mcp` always rebuilds before starting the stdio smoke test.

## Identity

| Surface | Name |
| --- | --- |
| Product | Harness Relay MCP |
| Repository | `deepseek-harness-relay-mcp` |
| Codex plugin ID | `deepseek-harness-relay` |
| npm package | `harness-relay-mcp` |
| MCP server ID | `harness-relay-mcp` |
| Skill | `delegate-to-deepseek-harness` |

## License

MIT
