# Use DeepSeek Harness from Codex

English | [中文](codex.zh.md)

The `codex` profile lets Codex delegate one task to a visible DeepSeek Harness session while retaining control of planning, review, and verification. You receive a live Web link as soon as the prompt is accepted and can watch, steer, cancel, or continue the same session.

## Configure the MCP server

Add a pinned Harness CLI to the Codex MCP configuration:

```json
{
  "mcpServers": {
    "deepseek-harness": {
      "command": "npx",
      "args": ["--yes", "--package=@deepseek-ai/dsh@0.1.0-rc.5", "--", "dsh", "--profile", "codex"]
    }
  }
}
```

The browser does not open automatically. `start_service` returns a service root URL, while `start_run` returns `/?sessionId=<SessionId>` for the exact visible conversation. Use `open_service` or pass `openBrowser: true` only when you want the platform browser opened.

## Run a delegated task

1. Call `doctor` and resolve any failed direct-launch or workspace-policy check.
2. Call `start_run` once with the complete task and an absolute `workspace`.
3. Show the returned `webUrl` immediately. It remains available while Codex reviews files or runs independent checks.
4. Call `wait_run` in intervals of at most 30 seconds until the run is terminal. A timeout returns the current running snapshot rather than an error. When the active agent needs correction, call `steer_run` with its `runId` and the additional instruction; the correction stays inside the same run and session.
5. Review the workspace diff and test results independently of the assistant text returned by Harness.

Use `cancel_run` to stop an active turn without closing the Web service. After a run is terminal, call `start_run` again with the prior `sessionId` to correct or extend completed work; the session must belong to the same workspace, be idle, and have no active MCP run.

## State and persistence

One canonical workspace maps to one managed Web process and a workspace-specific Harness home. Concurrent `start_service` calls for that workspace share the same startup operation. Separate sessions and workspaces may run concurrently, but one session accepts only one MCP run at a time.

Services and run IDs are supervised by the current MCP process. Restarting it loses old run IDs. Session IDs and their workspace data remain on disk, so a new `start_run(sessionId)` can continue an earlier conversation. The inline assistant response is a bounded UTF-8 tail; use the Web link for the complete transcript.

## Windows troubleshooting

The Codex launcher may use the configured outer `npx` to start the published CLI. After that point Harness never spawns `npx`, `npx.cmd`, or a shell. It starts the Web child with the current Node executable and absolute `dsh` entry, then waits for a structured loopback readiness record.

If `doctor.launcher.direct` or `doctor.launcher.exists` is false, start the published `dsh` binary through the configuration above instead of wrapping it in another script. If readiness fails, inspect `list_services[].logTail`; invalid UTF-8, malformed readiness, a non-loopback URL, timeout, and early process exit are startup failures. `stop_service` and MCP teardown cancel active work and verify the complete Windows process tree has exited.
