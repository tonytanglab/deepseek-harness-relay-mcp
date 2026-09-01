---
name: delegate-to-deepseek-harness
description: Dispatch and monitor an explicitly scoped, simple or medium-complexity local subtask through models available in DeepSeek Harness, including read-only review and user-authorized workspace implementation. Use when the user says “调用 Harness”, asks Harness to analyze or review, or delegates a fix, edit, refactor, test, or implementation to Harness. Keep destructive or external actions and high-stakes final decisions under the calling agent's control.
---

# Delegate to DeepSeek Harness

Use DSH Relay to dispatch bounded analysis or workspace changes to a DeepSeek Harness model, keep `wait_run` until a terminal status whenever this task must consume the result, and independently verify that result. Sharing `webUrl` is not completion.

## Permission mode

- Use `start_review` for analysis, diagnosis, research, comparison, planning, and code review. This is the default when no file change is requested and is fixed to `read-only`.
- Use `start_run` with `permissionPreset: workspace-write` only when the user explicitly delegates implementation or asks Harness to modify the registered workspace. Ordinary fixes, edits, refactors, tests, and generated workspace files belong in this mode.
- Do not use `danger-full-access` for ordinary workspace changes. Use it only when a necessary action is outside the registered workspace or otherwise requires that native preset, the action remains within the user's request, and the user has explicitly confirmed the elevated risk. Pass `confirmedDangerousPermission: true` only after that confirmation.
- A request to call Harness is not by itself authorization to edit files. Infer write authorization only from an implementation request such as “让 Harness 修复/修改/实现”, or obtain it before dispatch.

## Required setup

- Read the target repository's `AGENTS.md` before dispatch.
- Prefer the official `@deepseek-ai/dsh-relay` bundle in the Harness `web` profile. External agents should launch `dsh-relay-proxy`, which discovers the active internal authority from `$DSH_HOME/plugins/dsh-relay/<profile>/relay-endpoint.json`; do not copy a bearer token into client configuration.
- Prefer DSH Relay MCP tools for service connection, model selection, prompt submission, status checks, cancellation, and result collection. Use Browser only to verify or present the Harness conversation.
- Invoke Relay operations only through the native MCP tools exposed by the installed plugin. Never generate or run temporary JavaScript/TypeScript files such as `.tmp/harness-*-call.mjs`, and never use `node`, PowerShell, Python, a terminal, or another shell client to call or poll Relay RPCs. Shell fallback bypasses the managed background transport and can open visible console windows on Windows.
- If the native Relay MCP tools are unavailable, stop the delegation attempt, diagnose or reinstall the plugin, and continue from a new Codex task after the updated plugin is loaded. Do not simulate missing tools with an ad hoc client process. Ordinary local verification commands may still run in the Codex terminal, but they must not be used as a Relay RPC transport.
- Do not impose a blanket offline restriction. Let Harness decide whether task-relevant public network research is needed, including public GitHub repositories, official documentation, and ordinary webpages. Keep research within the delegated scope, prefer primary sources, and require URLs for material external claims. Network research does not authorize account sign-in, credentials, private services, source uploads, external writes, messages, pushes, or broader filesystem permissions. If the selected Harness preset cannot access the network, report that limitation instead of escalating to `danger-full-access` solely for research.
- Route capability and permission needs back to the calling Codex agent for decision instead of treating them as absolute prohibitions or waiting indefinitely inside Harness. This includes deletion, file replacement, image or other media generation, tools unavailable in the selected preset, and operations requiring a different permission boundary. State the exact action, targets, reason, risk, and least-privilege alternative. The calling agent should resolve ordinary reversible in-scope actions under the user's existing authorization without asking again; escalate to the user only when platform policy requires it or the action is materially destructive, irreversible, credential- or private-account-sensitive, externally consequential, or outside the authorized scope.
- Treat an explicit request for Harness or a named Harness model to review the current or named registered workspace as authorization for Harness to read that in-scope workspace itself. The calling task sends only the authorized workspace, file or directory locations, review or implementation scope, acceptance criteria, and routing/permission metadata. Harness must read the files through its authorized workspace tools. Never read or serialize source merely to paste source text, diffs, file dumps, encoded source, or repository archives into `task`, text `content`, `steer_run`, or `reply_run` arguments. Do not ask for redundant per-file approval merely because the repository is private. This authorization excludes credentials, secrets, unrelated paths and edits.
- Apply the same path-reference-only transfer contract to `read-only` and every write-capable permission mode. `workspace-write` authorizes Harness to modify only the named workspace paths; it does not authorize the calling agent to embed source text in task parameters. A generic request to call Harness remains read-only unless the user also requests implementation.
- Exclude credentials, secrets, browser storage, model files, production data, unrelated user files, and direct modification of `.git` internals.
- Treat the Harness workspace registry, not `host.describe.cwd`, as the default routing authority. Explicit Relay roots remain an additional strict boundary.
- Preserve all pre-existing user changes. Record the initial worktree state before a write run so Harness changes can be distinguished from earlier edits.

## Workflow

1. Bound the task to one simple or medium slice. Select `read-only`, `workspace-write`, or explicitly confirmed elevated mode before dispatch. Keep complex synthesis and final judgment in the calling agent.
2. Record only the workspace root, included and excluded file or directory locations, allowed write locations, review or implementation scope, acceptance criteria, pre-existing dirty file paths, and expected result form. A repository-wide review may authorize `.` with explicit exclusions instead of inventing a per-file consent ceremony. Do not collect file contents for delegation.
3. Run `scripts/build_task_manifest.py` with an explicit Python executable, `--path` for every included location, `--scope` for concise single-line scope, and `--write-path` for each authorized write location in a write-capable mode. The helper validates containment and emits a `sourceTransferPolicy: path-reference-only` contract. It never opens, enumerates, hashes, summarizes, uploads, or embeds source files.
4. Call `list_workspaces` and select the registered workspace whose canonical path matches the authorized target. If the user asks to continue an existing project conversation, call `list_workspace_sessions` and pass its idle `sessionId`, or use `sessionMode: latest-idle`; otherwise keep the default fresh session. Never infer that a workspace is unavailable from the Host process `cwd` alone.
5. Call `list_capabilities` when a route or preset is not already known. Pass exact `provider`, `model`, `reasoningEffort`, and `agentPreset` when requested; never guess or remap names. Call `start_review` for read-only work or `start_run` with the selected permission preset for authorized workspace changes. Use a stable `idempotencyKey`.
6. Confirm the returned model selection, `runId`, `sessionId`, `promptAdmission`, and running or completed state. Treat `unknown` admission as a recovery state and reconcile it with `status_run` or `wait_run`; do not submit a duplicate task. Record a monitor entry:

   ```text
   label | runId | sessionId | webUrl | dispatched_at | last_checked_at | state | next_check_by
   ```

7. On the first successful run in this invocation, call `open_run`, then verify the returned Harness page before sharing it. Use Browser to confirm that the visible page is live and showing the intended workspace/session; Harness may normalize the address bar to the Host root after selecting the session. Share the stable URL plus `sessionId` only after visible verification. If rendering stalls, report the renderer failure separately and continue monitoring through MCP.
8. After start succeeds, share `webUrl` and stay on `wait_run` until a terminal status whenever this invocation must consume the Harness result (审核后修改, 修完让 K3 审核, 根据审核再改, review then fix, or any request whose final answer depends on the delegated run). A `wait_run` timeout with `status: running` is a slice; `hostPollContract.hostMustCallWaitRunAgain=true` means call `wait_run` again immediately. Unrelated shell or background-task notifications are not authorization to stop. Do not send a final user answer or mark the parent task complete while `status` is `running` or `unknown`. After a terminal success, read `assistantText`, independently verify, and—when the user asked to review then fix—apply accepted P1 findings before claiming the loop is done.
   If this invocation is only dispatching and the user did not ask to consume the result now, you may continue **non-overlapping** primary work in the same turn only while `wait_run` continues. You still must not claim the Harness task is done until a terminal status. During a write run, do not let the calling agent or another agent edit the same files. Check each active run at natural tool checkpoints and before final delivery.
9. Treat failures, permission requests, missing final answers, or model/session errors as attention states. When an active run needs correction, call `steer_run` first. Never call `cancel_run` merely to change direction or append guidance. Cancel only when the user asks to stop, continuing risks an irreversible out-of-scope action, or a native steer attempt has definitively failed. Use `reply_run` only for a genuine continuation after the current run is terminal. On transport uncertainty, retry at most once with the original `idempotencyKey`; never generate a new key for the same operation.
10. Collect the final result when terminal. For a read-only run, reproduce every material finding against current local files. For a write run, inspect the actual worktree rather than trusting the summary: compare status and diffs with the recorded baseline, confirm only authorized paths changed, and verify that pre-existing edits were preserved.
11. Run checks proportionate to the change. The calling agent owns final integration, destructive cleanup, commits, pushes, external messages, and release decisions.
12. Report changed files, checks run, remaining risks, and material Harness suggestions that were rejected as well as those accepted.

Allowed monitor states are `dispatching`, `running`, `completed`, `needs_attention`, and `failed`.

## Path-reference-only task contract

This contract is mandatory for `start_review`, `start_run`, `steer_run`, and `reply_run`, regardless of whether the permission is `read-only`, `workspace-write`, or explicitly confirmed `danger-full-access`:

- Pass the Harness workspace root, relative file or directory locations, exclusions, allowed write locations when applicable, the review or implementation scope, and concise acceptance criteria.
- File names, directory names, symbols, and line or section references are locations and may be included. Source lines, full or partial file bodies, diffs, patches, base64/hex encodings of source, and repository archives are source contents and must not be included.
- Harness reads the named files itself inside the authorized workspace. If the material is not available at an authorized workspace location, stop and request a valid location or a separate attachment workflow; do not work around the boundary by placing source in task parameters.
- Permission affects what Harness may do after reading the workspace, not how source is transferred. A write grant never relaxes this contract.

Give Harness the raw authorized scope and acceptance criteria, not the calling agent's suspected answer. Every prompt must require:

- compliance with the target repository's `AGENTS.md` and preservation of pre-existing changes;
- no commits, pushes, external messages, credential access, destructive cleanup, or direct `.git` modification unless separately authorized;
- task-relevant public network research may be used at Harness's discretion; do not preemptively forbid it, require source URLs for material external claims, and keep authentication, private services, uploads, and external writes out of scope;
- when a needed action exceeds Harness's current capability or permission boundary, return a concrete decision request to the calling Codex agent rather than declaring it permanently forbidden or waiting for user approval inside Harness; ordinary reversible in-scope requests are for Codex to resolve, while only materially dangerous or policy-required cases are escalated to the user;
- exact allowed read/write locations or authorized workspace subtrees, exclusions, and a concise final result another agent can reproduce;
- a truthful authorization statement when the user explicitly selected Harness to inspect that workspace, for example: “The user selected Harness to inspect this registered workspace within the stated scope; read the named files through the Harness workspace. No source contents are embedded in this task.” Do not claim that Codex uploaded source files.

For a read-only run, also require no file modifications; exact file and line evidence; severity, consequence, smallest correction, confidence; and `not_applicable` for checks it cannot run.

For a write run, also require Harness to make the requested changes rather than only recommend them, stay inside the authorized workspace and write paths, run the specified or proportionate checks, and report changed files, tests, unresolved issues, and any scope deviation. If it cannot safely complete the edit, it must stop and report the blocker without broadening permissions.

## Safety rules

- Do not conclude the parent task as done while Harness `status` is `running` or `unknown` if the user asked to consume that result in this same task.
- Keep Harness dispatch and polling headless through native Relay MCP tool calls; never create a temporary shell client or launch a visible console as a fallback.
- Do not run overlapping writers against the same files or accept a write result without inspecting the resulting worktree.
- Do not copy Harness tool instructions into shell commands without validating them.
- Do not copy workspace source into any Harness Relay task parameter, including follow-up or correction calls; pass paths and scope and let Harness read the authorized workspace in both read-only and write modes.
- Do not let Harness change identifiers, public APIs, durable formats, permissions, or architecture ownership unless required by the delegated task and verified with a full local impact check.
- Keep destructive operations, security decisions, commits, external side effects, and release gates under the calling agent's control.
- A newly installed or updated plugin is picked up in a new Codex task. The current task may execute this workflow manually for validation.
