# @deepseek-ai/dsh-mcp-codex

English | [中文](README.zh.md)

Codex-facing MCP server that owns workspace-scoped Harness Web services. Each canonical workspace gets one managed Web process, persistent data under `<DSH_HOME>/codex-services/<workspace-sha256>`, and any number of non-overlapping session runs. The MCP process keeps stdout protocol-only and captures child stdout/stderr in `ServiceSnapshot.logTail`.

## Tools

| Tool | Result |
|---|---|
| `doctor` | Direct Node launcher, package, workspace-policy, and process-provider diagnostics without credentials |
| `start_service` | Start or reuse a workspace service; return its loopback root URL |
| `open_service` | Open a validated loopback URL in the platform browser |
| `list_services` | Services owned by the current MCP process |
| `stop_service` | Cancel active runs, wait for quiescence, and stop the process tree |
| `start_run` | Submit a task to a new session or an idle `sessionId`; return the session deep link |
| `steer_run` | Insert a correction into an active run and return its durable message ID |
| `get_run` | Immediate run snapshot |
| `wait_run` | Wait up to 30 seconds for a state change or completion |
| `list_runs` | Runs retained by this MCP process, optionally for one service |
| `cancel_run` | Idempotently request cancellation; retain a healthy service or isolate one that cannot return to idle |

`start_run.webUrl` is `http://127.0.0.1:<port>/?sessionId=<SessionId>`. Run IDs are in-memory and disappear when the MCP process restarts; session IDs and workspace data persist and can be continued by a later `start_run`.

## Run settlement

The server opens Host event streams before prompt admission and anchors the run to the returned durable message ID. A run covers that message and any Web or `steer_run` correction accepted before the agent becomes idle again. `steer_run` retains the original run and session IDs; after the run becomes terminal, use `start_run.sessionId` for a follow-up turn. One MCP run may be active per session; separate sessions and workspaces can run concurrently.

`completed` becomes `succeeded`. A user abort, or an abort after `cancel_run`, becomes `cancelled`. Errors, blocked or interrupted turns, output-token exhaustion, discarded admitted work, unknown terminal reasons, and Web-service failure become `failed`. Cancellation does not rewrite an already-terminal run.

`cancel_run` waits up to `stopGraceMs` for the persisted terminal turn and Agent idle evidence. If the cancellation RPC fails or the Agent stays busy, the supervisor terminates that workspace's Web process tree, marks the service failed, and fails every still-running run owned by that shared process. A later `start_service` or `start_run` starts a fresh Web process over the same persisted workspace data. This bounded isolation prevents one uncooperative tool from retaining the control plane, sockets, or other sessions indefinitely.

Assistant text is an inline convenience, not the complete transcript. It contains the run's answer `text` blocks; when the run has no answer text, it falls back to visible `reasoning` blocks so a successful run retains its only readable assistant output. The default 50,000-byte UTF-8 tail never starts inside a code point; `assistantTextBytes` reports the complete byte count and `assistantTextTruncated` reports loss. The Web session remains the complete view.

`lastToolEvents` is the same bounded surface for tool activity: the most recent `maxToolEvents` tool calls and results of the run's owned suffix, in log order. Each `arguments` and result `summary` is capped at `maxToolEventBytes` UTF-8 bytes (never cut inside a code point) with `truncated` reporting loss, and `callId` pairs each call with its result. The Web session remains the complete view.

## Configuration

| Field | Default | Meaning |
|---|---:|---|
| `dataDirectory` | `<DSH_HOME>/codex-services` | Parent for workspace-specific Harness homes |
| `credentialsPath` | `<DSH_HOME>/.credentials.yaml` | User-global credentials document shared by supervised workspaces |
| `allowedWorkspaceRoots` | `[]` | Allowed roots; an empty list reads `DSH_MCP_WORKSPACE_ROOTS` |
| `startupTimeoutMs` | `60000` | Structured Web-readiness deadline |
| `stopGraceMs` | `10000` | Agent-idle and process-tree shutdown grace |
| `rpcTimeoutMs` | `10000` | Host RPC and event-stream readiness deadline |
| `browserOpenTimeoutMs` | `10000` | One platform browser opener settle deadline |
| `eventReconnectDelayMs` | `250` | Delay before reconnecting an established event stream |
| `maxTaskCharacters` | `100000` | Submitted task limit |
| `maxLogCharacters` | `100000` | Captured service-log tail limit |
| `maxAssistantTextBytes` | `50000` | Inline assistant UTF-8 tail limit |
| `maxToolEvents` | `20` | Retained recent tool-activity entries per run snapshot |
| `maxToolEventBytes` | `2000` | Per-field UTF-8 cap for retained tool arguments and result summaries |

Workspace paths are resolved through `realpath` before hashing or allowed-root checks. The Web child inherits the trusted Harness process environment with its own `DSH_HOME`, `DSH_CWD`, and UTF-8 variables, plus `DSH_GLOBAL_CREDENTIALS_PATH` pointing at `credentialsPath`. Its project `.credentials.yaml` remains the higher-priority override, while Models writes globally by default and offers an explicit “This project only” scope. Changing a project-scoped key to global writes the shared value first and removes that workspace's override only after the global commit succeeds. Model-launched tools still use their existing credential scrubbing.

## Process ownership and Windows

The supervisor launches `[process.execPath, ...process.execArgv, absoluteDshEntry, '--profile', 'web', '--port', '0', '--ready-format', 'json']` through `ctx.subprocess`. It never starts an inner `npx`, `.cmd` shim, or shell. Web readiness is one strict UTF-8 JSON line containing a clean loopback HTTP root URL. Startup fails on invalid encoding, an invalid readiness record, timeout, or early exit.

Disposal follows the same path as `stop_service`: request cancellation, wait for durable terminal plus idle evidence, abort event streams, terminate the managed process tree, and verify complete exit. On Windows normal termination starts the tree-scoped `taskkill` request asynchronously, so a slow OS helper cannot block MCP or Web event loops; the synchronous form is reserved for Node's final `exit` hook. The Web child cannot survive plugin teardown as an untracked descendant.

## Model Experience

Indirectly, through ordinary Host session messages submitted by the MCP tools; the composed Web agent owns prompts and tools.

#### KV Cache effect

Each task, continuation, or live correction appends one user message after the reusable request prefix; MCP status fields and the Web URL never enter model context.

## Known Limitations and Deferred Work

- **Run records are process-local.** They are not reconstructed after an MCP restart; continuation uses the durable `sessionId` instead.
- **Inline assistant text and tool activity are bounded.** Callers needing the complete response must use the Web session.
- **Browser opening is opt-in.** It remains disabled unless `open_service` or `openBrowser: true` is requested. A failed open never fails the admitted run: `start_run` still returns the run snapshot, the failure is recorded on the service snapshot's `browserError`, and the caller can retry with `open_service`.
