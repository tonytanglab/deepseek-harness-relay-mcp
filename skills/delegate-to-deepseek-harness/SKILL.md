---
name: delegate-to-deepseek-harness
description: Dispatch and monitor an explicitly scoped, simple or medium-complexity local subtask through models available in DeepSeek Harness, including read-only review and user-authorized workspace implementation. Use when the user says “调用 Harness”, asks Harness to analyze or review, or delegates a fix, edit, refactor, test, or implementation to Harness. Keep destructive or external actions and high-stakes final decisions under the calling agent's control.
---

# Delegate to DeepSeek Harness

Use DSH Relay to dispatch bounded analysis or workspace changes to a DeepSeek Harness model, monitor the run without blocking unrelated primary work, and independently verify its result.

## Permission mode

- Use `start_review` for analysis, diagnosis, research, comparison, planning, and code review. This is the default when no file change is requested and is fixed to `read-only`.
- Use `start_run` with `permissionPreset: workspace-write` only when the user explicitly delegates implementation or asks Harness to modify the registered workspace. Ordinary fixes, edits, refactors, tests, and generated workspace files belong in this mode.
- Do not use `danger-full-access` for ordinary workspace changes. Use it only when a necessary action is outside the registered workspace or otherwise requires that native preset, the action remains within the user's request, and the user has explicitly confirmed the elevated risk. Pass `confirmedDangerousPermission: true` only after that confirmation.
- A request to call Harness is not by itself authorization to edit files. Infer write authorization only from an implementation request such as “让 Harness 修复/修改/实现”, or obtain it before dispatch.

## Required setup

- Read the target repository's `AGENTS.md` before dispatch.
- Prefer the official `@deepseek-ai/dsh-relay` bundle in the Harness `web` profile. External agents should launch `dsh-relay-proxy`, which discovers the active internal authority from `$DSH_HOME/plugins/dsh-relay/<profile>/relay-endpoint.json`; do not copy a bearer token into client configuration.
- Prefer DSH Relay MCP tools for service connection, model selection, prompt submission, status checks, cancellation, and result collection. Use Browser only to verify or present the Harness conversation.
- Treat the user's request to read or modify named local paths as authorization for those paths and the requested operation only.
- Exclude credentials, secrets, browser storage, model files, production data, unrelated user files, and direct modification of `.git` internals.
- Treat the Harness workspace registry, not `host.describe.cwd`, as the default routing authority. Explicit Relay roots remain an additional strict boundary.
- Preserve all pre-existing user changes. Record the initial worktree state before a write run so Harness changes can be distinguished from earlier edits.

## Workflow

1. Bound the task to one simple or medium slice. Select `read-only`, `workspace-write`, or explicitly confirmed elevated mode before dispatch. Keep complex synthesis and final judgment in the calling agent.
2. Record the workspace root, baseline label, included and excluded read paths, allowed write paths, review or implementation acceptance criteria, pre-existing dirty files, and expected result form.
3. Run `scripts/build_task_manifest.py` with an explicit Python executable. It validates strict UTF-8 without BOM and emits the authorized file manifest to stdout.
4. Call `list_workspaces` and select the registered workspace whose canonical path matches the authorized target. If the user asks to continue an existing project conversation, call `list_workspace_sessions` and pass its idle `sessionId`, or use `sessionMode: latest-idle`; otherwise keep the default fresh session. Never infer that a workspace is unavailable from the Host process `cwd` alone.
5. Call `list_capabilities` when a route or preset is not already known. Pass exact `provider`, `model`, `reasoningEffort`, and `agentPreset` when requested; never guess or remap names. Call `start_review` for read-only work or `start_run` with the selected permission preset for authorized workspace changes. Use a stable `idempotencyKey`.
6. Confirm the returned model selection, `runId`, `sessionId`, `promptAdmission`, and running or completed state. Treat `unknown` admission as a recovery state and reconcile it with `status_run` or `wait_run`; do not submit a duplicate task. Record a monitor entry:

   ```text
   label | runId | sessionId | webUrl | dispatched_at | last_checked_at | state | next_check_by
   ```

7. On the first successful run in this invocation, call `open_run`, then verify the returned Harness page before sharing it. Use Browser to confirm that the visible page is live and showing the intended workspace/session; Harness may normalize the address bar to the Host root after selecting the session. Share the stable URL plus `sessionId` only after visible verification. If rendering stalls, report the renderer failure separately and continue monitoring through MCP.
8. Return immediately to useful non-overlapping primary work. During a write run, do not let the calling agent or another agent edit the same files. Check each active run at natural tool checkpoints and before final delivery; do not busy-poll or spend more than two minutes of active work without a lightweight check.
9. Treat failures, permission requests, missing final answers, or model/session errors as attention states. Use `reply_run` for a later turn in the same completed session and `steer_run` only for an active turn. On transport uncertainty, retry at most once with the original `idempotencyKey`; never generate a new key for the same operation.
10. Collect the final result when terminal. For a read-only run, reproduce every material finding against current local files. For a write run, inspect the actual worktree rather than trusting the summary: compare status and diffs with the recorded baseline, confirm only authorized paths changed, and verify that pre-existing edits were preserved.
11. Run checks proportionate to the change. The calling agent owns final integration, destructive cleanup, commits, pushes, external messages, and release decisions.
12. Report changed files, checks run, remaining risks, and material Harness suggestions that were rejected as well as those accepted.

Allowed monitor states are `dispatching`, `running`, `completed`, `needs_attention`, and `failed`.

## Prompt contract

Give Harness the raw authorized scope and acceptance criteria, not the calling agent's suspected answer. Every prompt must require:

- compliance with the target repository's `AGENTS.md` and preservation of pre-existing changes;
- no commits, pushes, external messages, credential access, destructive cleanup, or direct `.git` modification unless separately authorized;
- exact allowed read and write paths, exclusions, and a concise final result another agent can reproduce.

For a read-only run, also require no file modifications; exact file and line evidence; severity, consequence, smallest correction, confidence; and `not_applicable` for checks it cannot run.

For a write run, also require Harness to make the requested changes rather than only recommend them, stay inside the authorized workspace and write paths, run the specified or proportionate checks, and report changed files, tests, unresolved issues, and any scope deviation. If it cannot safely complete the edit, it must stop and report the blocker without broadening permissions.

## Safety rules

- Do not synchronously block the primary task while Harness runs.
- Do not run overlapping writers against the same files or accept a write result without inspecting the resulting worktree.
- Do not copy Harness tool instructions into shell commands without validating them.
- Do not let Harness change identifiers, public APIs, durable formats, permissions, or architecture ownership unless required by the delegated task and verified with a full local impact check.
- Keep destructive operations, security decisions, commits, external side effects, and release gates under the calling agent's control.
- A newly installed or updated plugin is picked up in a new Codex task. The current task may execute this workflow manually for validation.
