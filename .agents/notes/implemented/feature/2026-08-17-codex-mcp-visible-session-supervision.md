# Agent Note: Codex MCP visible-session supervision

Status: implemented

English | [中文](2026-08-17-codex-mcp-visible-session-supervision.zh.md)

## Problem

Codex needs a delegation path that keeps Harness work visible and controllable without duplicating Harness session or process ownership in an external integration. The previous external server polled a fixed history tail and spawned `npx.cmd` internally; Node 24 on Windows rejects that shell shim under `shell: false`, while `shell: true` would weaken argument and process-tree control. A task receipt also lacked the durable message identity required to distinguish its work from prior history and later Web steering.

## Decision

`@deepseek-ai/dsh-mcp-codex` and the `codex` profile live in Harness. One canonical workspace owns one supervised Web-profile process and one workspace-specific Harness home. The supervisor launches the current Node executable, inherited execution arguments, and the absolute current `dsh` entry through `ctx.subprocess`; no inner `npx`, `.cmd`, or shell participates. The Web child emits one strict UTF-8 `dsh/web-ready` JSON record with a loopback root URL after Loader settlement. Browser opening is a separate explicit tool operation over a validated URL.

Host `session.prompt` returns the durable user `messageId`. The MCP supervisor opens Host event streams before admission, buffers the race until the run is published, and defines one run from that accepted message until its consumed work reaches a terminal turn and the whole agent is idle. Web steering inside that interval belongs to the run. The MCP `steer_run` tool exposes the same admission path with `mode: 'steer'`, returns the correction's durable `messageId`, and retains the original run and session identities. It rejects terminal or cancellation-requested runs; Host remains authoritative when agent activity changes concurrently. Session continuation validates workspace ownership, idle state, and the absence of another MCP run. A `completed` turn succeeds; user cancellation maps an aborted turn to cancellation; every other terminal or discarded-work outcome fails.

The inline assistant projection collects answer `text` blocks from the run. When no answer text exists, it collects visible `reasoning` blocks instead; some provider routes can complete with reasoning as their only readable assistant content. The byte limit applies after this selection, while the Web session retains the complete event-derived transcript.

Host prompt admission does not interpret slash commands: browser command execution already uses the separate `command.execute` remote before prompt submission. MCP tasks therefore remain literal, including text beginning with `/`, without adding a second command-dispatch switch or a command-result variant to `session.prompt`.

Shutdown requests cancellation, waits a bounded interval for durable terminal plus idle evidence, aborts event streams, terminates the managed process tree, and verifies complete exit. The same sequence owns `stop_service` and plugin disposal. Normal Windows termination launches `taskkill /T /F` without synchronously waiting in the Node event loop; only the process `exit` fallback remains synchronous because Node cannot finish asynchronous work there.

`cancel_run` owns the same bounded convergence requirement. An accepted cancellation that does not reach a persisted terminal turn and Agent idle within `stopGraceMs`, or a failed cancellation RPC, proves the shared Web process unhealthy. The supervisor terminates that workspace process tree, marks the service failed, and fails its remaining live runs. A later start creates a fresh process over the same persisted workspace data. Service and run IDs are MCP-process-local; persisted session IDs and workspace data survive MCP restarts. The Web client treats `?sessionId=` as an authoritative initial selection and retains an unknown ID long enough to display its history error instead of redirecting silently.

## Alternatives considered

**Keep the runtime in the external Codex plugin.** Rejected because it duplicates Host event interpretation, session ownership, and subprocess teardown outside their source repository. The external plugin remains a thin pinned launcher and workflow skill.

**Spawn `npx.cmd` or enable `shell: true` on Windows.** Rejected because the former is not a directly executable Node child on the affected runtime and the latter delegates quoting and descendant ownership to a shell. The already-running CLI provides a complete direct self-launch descriptor.

**Poll the latest fixed number of history entries.** Rejected because a long or fast run can move its admission or terminal evidence outside the window. Event streams carry live evidence. Bounded backward pagination closes admission-to-publication races and reconciles missed durable events after an established stream reconnects.

## Consequences

Codex can show a stable live session link immediately, wait without history polling, insert live corrections with a durable receipt, cancel idempotently, and continue a persisted session by ID after terminal settlement. A non-converging cancellation sacrifices every active run in that workspace process so the control plane and OS children cannot remain stuck; each affected run reports failure rather than a false cancellation. The MCP process must stay alive to retain run IDs and service supervision. Assistant text returned inline is a bounded UTF-8 tail and may contain reasoning only when the run has no answer text; the Web session is the complete transcript. A Web child that emits invalid UTF-8 or readiness data, exits early, or cannot reach event-stream readiness fails startup instead of publishing a partially usable service.
