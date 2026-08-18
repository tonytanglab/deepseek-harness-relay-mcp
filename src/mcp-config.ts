/** MCP stdio launch-block generation and optional host-config writes. */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { delimiter, dirname, isAbsolute } from 'node:path'
import type { ResolvedConfig } from './config.ts'
import { assertNever, type McpHost } from './hosts.ts'

/** One MCP server launch descriptor shared by Codex, Cursor, and Claude Code. */
export interface McpServerLaunch {
  command: 'npx'
  args: string[]
  env: Record<string, string>
}

/**
 * Build the stdio launch block that an MCP host uses to spawn `dsh --profile codex`.
 * @param config - resolved helper settings.
 * @param host - MCP host product; currently all three share the same npx argv.
 * @returns command, args, and env. The command is always `npx`, never a Windows `.cmd` shim, and the spawn never enables a shell.
 */
export function buildMcpLaunch(config: ResolvedConfig, host: McpHost): McpServerLaunch {
  switch (host) {
    case 'codex':
    case 'cursor':
    case 'claude-code':
      return {
        command: 'npx',
        args: ['--yes', `--package=${config.dshPackage}`, '--', 'dsh', '--profile', 'codex'],
        env: launchEnv(config),
      }
    default:
      return assertNever(host)
  }
}

/**
 * Merge one server launch into an MCP config document and write it.
 * @param path - absolute destination JSON path.
 * @param serverName - key under `mcpServers`.
 * @param launch - generated launch block.
 * @returns the written document.
 */
export async function writeMcpConfigFile(
  path: string,
  serverName: string,
  launch: McpServerLaunch,
): Promise<{ mcpServers: Record<string, McpServerLaunch> }> {
  if (!isAbsolute(path)) throw new Error('dsh-relay: mcp config path must be absolute')
  const document = await readConfigDocument(path)
  const existing = document.mcpServers
  const mcpServers = existing !== undefined && isServerMap(existing)
    ? { ...existing, [serverName]: launch }
    : { [serverName]: launch }
  if (existing !== undefined && !isServerMap(existing)) {
    throw new Error(`dsh-relay: ${path} mcpServers must be a JSON object`)
  }
  const next = { ...document, mcpServers }
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
  return { mcpServers }
}

function launchEnv(config: ResolvedConfig): Record<string, string> {
  const env: Record<string, string> = {}
  if (config.allowedWorkspaceRoots.length > 0) {
    env.DSH_MCP_WORKSPACE_ROOTS = config.allowedWorkspaceRoots.join(delimiter)
  }
  env.DSH_MCP_CREDENTIALS_PATH = config.credentialsPath
  env.DSH_MCP_DATA_DIR = config.dataDirectory
  return env
}

async function readConfigDocument(path: string): Promise<Record<string, unknown>> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, 'utf8'))
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error(`dsh-relay: ${path} must contain a JSON object`)
    }
    return parsed as Record<string, unknown>
  } catch (error) {
    if (isEnoent(error)) return {}
    throw error
  }
}

function isEnoent(error: unknown): boolean {
  return error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT'
}

function isServerMap(value: unknown): value is Record<string, McpServerLaunch> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
