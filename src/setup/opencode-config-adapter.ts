import { MCP_SERVER_ID } from '../product-identity/index.js'
import { isAbsoluteNodeCommand, isAbsoluteScriptEntry, jsonSnippet, StructuredClientConfigAdapter } from './adapter-utils.js'
import { pathFor } from './path-policy.js'
import type { ClientScope, ConfigLocation, ConfigPatch, DetectRequest, ScopeSupport, SetupIssue, StdioLauncherPlan } from './types.js'

export class OpenCodeV2ConfigAdapter extends StructuredClientConfigAdapter {
  readonly client = 'opencode' as const
  readonly support: ScopeSupport = {
    client: this.client,
    supportedScopes: ['project', 'user'],
    notes: {
      local: 'OpenCode V2 exposes project and user configuration locations, not a separate local scope.',
      project: 'Uses opencode.json in the workspace.',
      user: 'Uses the OpenCode user configuration.',
    },
  }

  protected location(request: DetectRequest): ConfigLocation {
    const pathApi = pathFor(request.platform)
    return {
      path: request.scope === 'project'
        ? pathApi.join(requiredWorkspace(request), 'opencode.json')
        : pathApi.join(request.homeDirectory, '.config', 'opencode', 'opencode.json'),
      format: 'json',
      selector: ['mcp', 'servers', MCP_SERVER_ID],
      managedBy: 'structured-patch',
      dialect: 'opencode-v2',
    }
  }

  protected renderSupported(scope: ClientScope, target: ConfigLocation, launcher: StdioLauncherPlan): ConfigPatch {
    const value = {
      type: 'local',
      command: [launcher.command, ...launcher.args],
      enabled: true,
      ...(Object.keys(launcher.environment).length === 0 ? {} : { environment: { ...launcher.environment } }),
    }
    return {
      client: this.client,
      scope,
      target,
      operation: 'upsert',
      serverId: MCP_SERVER_ID,
      value,
      snippet: jsonSnippet(target.selector, value),
    }
  }

  protected validateValue(value: Readonly<Record<string, unknown>>): readonly SetupIssue[] {
    const issues: SetupIssue[] = []
    if (value.type !== 'local') issues.push({ code: 'OPENCODE_TYPE_INVALID', severity: 'error', message: 'OpenCode V2 MCP entry must be local.' })
    if (
      !Array.isArray(value.command)
      || value.command.length !== 2
      || typeof value.command[0] !== 'string'
      || typeof value.command[1] !== 'string'
    ) {
      issues.push({ code: 'OPENCODE_COMMAND_INVALID', severity: 'error', message: 'OpenCode V2 command must be a [node, relayEntry] array.' })
    } else if (!isAbsoluteNodeCommand(value.command[0]) || !isAbsoluteScriptEntry(value.command[1])) {
      issues.push({ code: 'OPENCODE_RUNTIME_INVALID', severity: 'error', message: 'OpenCode V2 command must start with an absolute Node executable.' })
    }
    if ('env' in value) issues.push({ code: 'OPENCODE_ENV_FIELD_INVALID', severity: 'error', message: 'OpenCode V2 uses environment, not env.' })
    return issues
  }
}

/** Backward-compatible name. New callers should select the explicit V2 adapter. */
export class OpenCodeConfigAdapter extends OpenCodeV2ConfigAdapter {}

function requiredWorkspace(request: DetectRequest): string {
  if (request.workspaceDirectory === undefined) throw new Error('OpenCode project scope requires workspaceDirectory.')
  return request.workspaceDirectory
}
