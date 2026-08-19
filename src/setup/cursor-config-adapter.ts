import { MCP_SERVER_ID } from '../product-identity/index.js'
import { jsonSnippet, StructuredClientConfigAdapter, stdioValue, validateStdioValue } from './adapter-utils.js'
import { pathFor } from './path-policy.js'
import type { ClientScope, ConfigLocation, ConfigPatch, DetectRequest, ScopeSupport, SetupIssue, StdioLauncherPlan } from './types.js'

export class CursorConfigAdapter extends StructuredClientConfigAdapter {
  readonly client = 'cursor' as const
  readonly support: ScopeSupport = {
    client: this.client,
    supportedScopes: ['project', 'user'],
    notes: {
      local: 'Cursor exposes project and user MCP locations, not a separate local scope.',
      project: 'Uses .cursor/mcp.json in the workspace.',
      user: 'Uses .cursor/mcp.json in the user home.',
    },
  }

  protected location(request: DetectRequest): ConfigLocation {
    const pathApi = pathFor(request.platform)
    const root = request.scope === 'project' ? requiredWorkspace(request) : request.homeDirectory
    return {
      path: pathApi.join(root, '.cursor', 'mcp.json'),
      format: 'json',
      selector: ['mcpServers', MCP_SERVER_ID],
      managedBy: 'structured-patch',
    }
  }

  protected renderSupported(scope: ClientScope, target: ConfigLocation, launcher: StdioLauncherPlan): ConfigPatch {
    const value = stdioValue(launcher)
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
    return validateStdioValue(value)
  }
}

function requiredWorkspace(request: DetectRequest): string {
  if (request.workspaceDirectory === undefined) throw new Error('Cursor project scope requires workspaceDirectory.')
  return request.workspaceDirectory
}
