import { MCP_SERVER_ID } from '../product-identity/index.js'
import { jsonSnippet, StructuredClientConfigAdapter, stdioValue, validateStdioValue } from './adapter-utils.js'
import { pathFor } from './path-policy.js'
import type { ClientScope, ConfigLocation, ConfigPatch, DetectRequest, ScopeSupport, SetupIssue, StdioLauncherPlan } from './types.js'

export class AntigravityConfigAdapter extends StructuredClientConfigAdapter {
  readonly client = 'antigravity' as const
  readonly support: ScopeSupport = {
    client: this.client,
    supportedScopes: ['project', 'user'],
    notes: {
      local: 'Antigravity exposes project and user MCP locations, not a separate local scope.',
      project: 'Uses .agents/mcp_config.json in the workspace.',
      user: 'Uses .gemini/config/mcp_config.json in the user home.',
    },
  }

  protected location(request: DetectRequest): ConfigLocation {
    const path = pathFor(request.platform)
    let configPath = path.join(request.homeDirectory, '.gemini', 'config', 'mcp_config.json')
    if (request.scope === 'project') {
      if (request.workspaceDirectory === undefined) throw new Error('Antigravity project scope requires workspaceDirectory.')
      configPath = path.join(request.workspaceDirectory, '.agents', 'mcp_config.json')
    }
    return { path: configPath, format: 'json', selector: ['mcpServers', MCP_SERVER_ID], managedBy: 'structured-patch' }
  }

  protected renderSupported(scope: ClientScope, target: ConfigLocation, launcher: StdioLauncherPlan): ConfigPatch {
    const value = stdioValue(launcher)
    return { client: this.client, scope, target, operation: 'upsert', serverId: MCP_SERVER_ID, value, snippet: jsonSnippet(target.selector, value) }
  }

  protected validateValue(value: Readonly<Record<string, unknown>>): readonly SetupIssue[] {
    return validateStdioValue(value)
  }
}
