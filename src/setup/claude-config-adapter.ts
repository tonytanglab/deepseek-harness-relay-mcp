import { MCP_SERVER_ID } from '../product-identity/index.js'
import { jsonSnippet, StructuredClientConfigAdapter, stdioValue, validateStdioValue } from './adapter-utils.js'
import { pathFor } from './path-policy.js'
import type { ClientScope, ConfigLocation, ConfigPatch, DetectRequest, ScopeSupport, SetupIssue, StdioLauncherPlan } from './types.js'

export class ClaudeConfigAdapter extends StructuredClientConfigAdapter {
  readonly client = 'claude' as const
  readonly support: ScopeSupport = {
    client: this.client,
    supportedScopes: ['local', 'project', 'user'],
    notes: {
      local: 'Stores a private current-project entry in the user Claude configuration.',
      project: 'Uses the project .mcp.json file.',
      user: 'Uses the user Claude configuration.',
    },
  }

  protected location(request: DetectRequest): ConfigLocation {
    const pathApi = pathFor(request.platform)
    if (request.scope === 'project') {
      return {
        path: pathApi.join(requiredWorkspace(request), '.mcp.json'),
        format: 'json',
        selector: ['mcpServers', MCP_SERVER_ID],
        managedBy: 'client-cli',
      }
    }
    if (request.scope === 'local') {
      const workspace = requiredWorkspace(request)
      return {
        path: pathApi.join(request.homeDirectory, '.claude.json'),
        format: 'json',
        selector: ['projects', workspace, 'mcpServers', MCP_SERVER_ID],
        managedBy: 'client-cli',
      }
    }
    return {
      path: pathApi.join(request.homeDirectory, '.claude.json'),
      format: 'json',
      selector: ['mcpServers', MCP_SERVER_ID],
      managedBy: 'client-cli',
    }
  }

  protected renderSupported(scope: ClientScope, target: ConfigLocation, launcher: StdioLauncherPlan): ConfigPatch {
    const value = { type: 'stdio', ...stdioValue(launcher) }
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
    const issues = [...validateStdioValue(value)]
    if (value.type !== 'stdio') issues.push({ code: 'CLAUDE_TYPE_INVALID', severity: 'error', message: 'Claude MCP entry must use stdio.' })
    return issues
  }
}

function requiredWorkspace(request: DetectRequest): string {
  if (request.workspaceDirectory === undefined) throw new Error(`${request.client}/${request.scope} requires workspaceDirectory.`)
  return request.workspaceDirectory
}
