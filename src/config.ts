/** Resolved plugin configuration for doctor and MCP launch-block generation. */

import { delimiter, resolve } from 'node:path'
import { homedir } from 'node:os'
import type { McpHost } from './hosts.ts'
import { DEFAULT_WEB_URL, resolveWebUrl } from './harness-rpc.ts'
export { DEFAULT_WEB_URL }

/** Published helper identity. */
export const PACKAGE_NAME = 'dsh-agents-relay'

/** Published helper version. */
export const PACKAGE_VERSION = '0.1.5'

/** Pinned CLI package used in generated MCP launch args. */
export const DEFAULT_DSH_PACKAGE = '@deepseek-ai/dsh@0.1.0-rc.7'

/** Default MCP server key written into host config documents. */
export const DEFAULT_MCP_SERVER_NAME = 'dsh-relay'

/** Fully resolved helper settings. */
export interface ResolvedConfig {
  mcpServerName: string
  mcpConfigPath: string | undefined
  allowedWorkspaceRoots: string[]
  credentialsPath: string
  dataDirectory: string
  dshPackage: string
  host: McpHost
  webUrl: string
}

/** Environment overlay used when resolving optional paths and workspace roots. */
export interface ResolveEnv {
  DSH_HOME?: string
  DSH_MCP_WORKSPACE_ROOTS?: string
  DSH_MCP_CREDENTIALS_PATH?: string
  DSH_MCP_DATA_DIR?: string
  DSH_WEB_URL?: string
  DSH_MCP_WEB_URL?: string
}

/**
 * Resolve environment-backed data, credential, and root defaults.
 * @param config - validated explicit plugin configuration.
 * @param env - process environment; tests pass an overlay.
 * @returns absolute paths and the remaining explicit settings.
 */
export function resolveConfig(config: {
  mcpServerName: string
  mcpConfigPath?: string
  allowedWorkspaceRoots: string[]
  credentialsPath?: string
  dataDirectory?: string
  dshPackage: string
  host: McpHost
  webUrl?: string
}, env: ResolveEnv = process.env): ResolvedConfig {
  const home = env.DSH_HOME?.trim() || resolve(homedir(), '.dsh')
  const configuredRoots = config.allowedWorkspaceRoots.length > 0
    ? config.allowedWorkspaceRoots
    : (env.DSH_MCP_WORKSPACE_ROOTS ?? '').split(delimiter).map(value => value.trim()).filter(Boolean)
  return {
    mcpServerName: config.mcpServerName,
    mcpConfigPath: config.mcpConfigPath?.trim() ? resolve(config.mcpConfigPath.trim()) : undefined,
    allowedWorkspaceRoots: configuredRoots.map(root => resolve(root)),
    credentialsPath: resolve(config.credentialsPath?.trim() || env.DSH_MCP_CREDENTIALS_PATH?.trim()
      || resolve(home, '.credentials.yaml')),
    dataDirectory: resolve(config.dataDirectory?.trim() || env.DSH_MCP_DATA_DIR?.trim()
      || resolve(home, 'codex-services')),
    dshPackage: config.dshPackage,
    host: config.host,
    webUrl: resolveWebUrl(config.webUrl?.trim() || env.DSH_WEB_URL?.trim() || env.DSH_MCP_WEB_URL?.trim() || DEFAULT_WEB_URL),
  }
}
