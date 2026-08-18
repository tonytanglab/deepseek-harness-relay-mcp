# Agent Note: Codex global credentials with project overrides

Status: implemented

English | [中文](2026-08-18-codex-global-credentials.zh.md)

## Problem

The Codex MCP supervisor gives every canonical workspace a separate Harness home so sessions, settings, attachments, and indexes cannot collide. That isolation also moved `.credentials.yaml` into the workspace hash directory. A key stored from one project's Models page was therefore absent in every other project, and rotating a key required editing each service home independently.

## Decision

The supervisor keeps the workspace-specific `DSH_HOME` and passes one absolute user-global credential path separately as `DSH_GLOBAL_CREDENTIALS_PATH`. The base bundle maps that trusted process value into `dsh-credentials-local.globalPath` and selects `global` as the default write scope only for supervised children. Direct Harness launches without that value retain one project document and the existing API results.

The local provider resolves inherited process environment, project managed document, optional global managed document, project `.env`, then user `.env`. Both managed documents retain owner-only validation, atomic writes, cross-process locks, hot reload, and fail-loud parsing. The credential Service Definition and Host RPC accept an optional `global` or `project` write scope; `describe()` exposes scope metadata only when the provider has both documents.

The Models editor renders a scope selector only when both scopes are available. A configured key starts on its effective managed scope; an unconfigured key starts on the provider default. Switching a project override to global writes the global document first and removes the project entry only after that commit succeeds. The project file remains the higher-priority explicit override. Removing a provider profile never removes a user-global credential because other workspaces may still consume it.

## Alternatives considered

**Copy the credential file into every workspace home.** This preserves the old provider unchanged but duplicates secrets, makes rotation non-atomic across projects, and leaves stale copies that continue shadowing newer values.

**Use one shared `DSH_HOME` for all Codex projects.** This shares keys but also merges sessions, settings, attachments, and indexes whose isolation is the supervisor's ownership rule.

**Put the shared key into each child process environment.** This makes the value read-only to the Models page and materializes a managed secret into process environments, contrary to the credential provider's storage rule.

## Testing

Provider tests pin precedence, scoped writes, unscoped global defaults, invalid path configuration, global hot reload, and the unchanged single-document behavior. Host tests pin wire scope forwarding without returning values; Client tests pin selector defaults, the global-then-remove-project ordering, and retention of a shared credential when its provider profile is deleted; MCP tests pin explicit global-path propagation to the child. Typecheck and build exercise the generated Host/Client contract and the installed CLI artifact.

## Consequences

A key stored globally is immediately available to every newly started or already watched Codex workspace service, while an intentional project credential still wins locally. Existing workspace credential files remain valid and act as overrides; choosing global in that workspace migrates the selected reference without deleting the override before the shared value is durable. The global file has the same file-permission limitation as the project file: same-user model tool processes can deliberately read it if they discover its path, so an OS-keychain provider remains the answer for stronger separation.
