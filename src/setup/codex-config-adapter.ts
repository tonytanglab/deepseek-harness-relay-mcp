import { MCP_SERVER_ID } from '../product-identity/index.js'
import { StructuredClientConfigAdapter, validateStdioValue, stdioValue } from './adapter-utils.js'
import { pathFor } from './path-policy.js'
import type { ClientScope, ConfigLocation, ConfigPatch, DetectRequest, ScopeSupport, SetupIssue, StdioLauncherPlan } from './types.js'

export class CodexConfigAdapter extends StructuredClientConfigAdapter {
  readonly client = 'codex' as const
  readonly support: ScopeSupport = {
    client: this.client,
    supportedScopes: ['user'],
    notes: {
      local: 'Codex has no verified local MCP scope.',
      project: 'Enable project scope only after the target Codex version and repository trust model are verified.',
      user: 'Uses the user Codex configuration.',
    },
  }

  protected location(request: DetectRequest): ConfigLocation {
    return {
      path: pathFor(request.platform).join(request.homeDirectory, '.codex', 'config.toml'),
      format: 'toml',
      selector: ['mcp_servers', MCP_SERVER_ID],
      managedBy: 'structured-patch',
    }
  }

  protected renderSupported(
    scope: ClientScope,
    target: ConfigLocation,
    launcher: StdioLauncherPlan,
  ): ConfigPatch {
    const value = stdioValue(launcher)
    const lines = [
      `[mcp_servers."${MCP_SERVER_ID}"]`,
      `command = ${tomlString(launcher.command)}`,
      `args = [${launcher.args.map(tomlString).join(', ')}]`,
    ]
    if (Object.keys(launcher.environment).length > 0) {
      lines.push('', `[mcp_servers."${MCP_SERVER_ID}".env]`)
      for (const [key, item] of Object.entries(launcher.environment)) {
        lines.push(`${tomlString(key)} = ${tomlString(item)}`)
      }
    }
    return { client: this.client, scope, target, operation: 'upsert', serverId: MCP_SERVER_ID, value, snippet: `${lines.join('\n')}\n` }
  }

  protected validateValue(value: Readonly<Record<string, unknown>>): readonly SetupIssue[] {
    return validateStdioValue(value)
  }
}

function tomlString(value: string): string {
  return JSON.stringify(value)
}
