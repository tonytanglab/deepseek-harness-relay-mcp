/** MCP stdio launch-block generation and optional host-config writes. */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { delimiter, dirname, isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ResolvedConfig } from './config.ts'
import { assertNever, type McpHost } from './hosts.ts'

/** One MCP server launch descriptor shared by Codex, Cursor, and Claude Code. */
export interface McpServerLaunch {
  command: string
  args: string[]
  env: Record<string, string>
}

/**
 * Build the stdio launch block that an MCP host uses to attach to the running
 * Harness Web. This does not spawn `dsh --profile codex`.
 * @param config - resolved helper settings.
 * @param host - MCP host product; currently all three share the same argv.
 * @returns command, args, and env. The command is `process.execPath`, never a Windows `.cmd` shim.
 */
export function buildMcpLaunch(config: ResolvedConfig, host: McpHost): McpServerLaunch {
  switch (host) {
    case 'codex':
    case 'cursor':
    case 'claude-code':
      return {
        command: process.execPath,
        args: [mcpEntry()],
        env: launchEnv(config),
      }
    default:
      return assertNever(host)
  }
}

/**
 * Absolute path of the attach MCP entry next to this module after build.
 * @returns `lib/mcp.js` when loaded from the compiled plugin.
 */
export function mcpEntry(): string {
  return join(dirname(fileURLToPath(import.meta.url)), 'mcp.js')
}

/**
 * Merge one server launch into a Cursor/Claude JSON file or a Codex TOML file.
 * @param path - absolute destination `.json` or `.toml` path.
 * @param serverName - key under `mcpServers` / `[mcp_servers.<name>]`.
 * @param launch - generated launch block.
 * @returns the written server map.
 */
export async function writeMcpConfigFile(
  path: string,
  serverName: string,
  launch: McpServerLaunch,
): Promise<{ mcpServers: Record<string, McpServerLaunch> }> {
  if (!isAbsolute(path)) throw new Error('dsh-relay: mcp config path must be absolute')
  await mkdir(dirname(path), { recursive: true })
  if (path.toLowerCase().endsWith('.toml')) {
    const previous = await readText(path)
    await writeFile(path, upsertCodexMcpServer(previous, serverName, launch), 'utf8')
    return { mcpServers: { [serverName]: launch } }
  }
  const document = await readConfigDocument(path)
  const existing = document.mcpServers
  const mcpServers = existing !== undefined && isServerMap(existing)
    ? { ...existing, [serverName]: launch }
    : { [serverName]: launch }
  if (existing !== undefined && !isServerMap(existing)) {
    throw new Error(`dsh-relay: ${path} mcpServers must be a JSON object`)
  }
  const next = { ...document, mcpServers }
  await writeFile(path, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
  return { mcpServers }
}

/**
 * Replace or append `[mcp_servers.<name>]` and `[mcp_servers.<name>.env]`.
 * @param text - existing Codex `config.toml` contents.
 * @param serverName - MCP server key.
 * @param launch - command, args, and env.
 * @returns the updated TOML document.
 */
export function upsertCodexMcpServer(text: string, serverName: string, launch: McpServerLaunch): string {
  const header = `[mcp_servers.${serverName}]`
  const nested = `[mcp_servers.${serverName}.`
  const kept: string[] = []
  let skipping = false
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith('[') && line.endsWith(']')) {
      skipping = line === header || line.startsWith(nested)
    }
    if (!skipping) kept.push(line)
  }
  while (kept.length > 0 && kept[kept.length - 1] === '') kept.pop()
  const stripped = kept.join('\n').trimEnd()
  const args = launch.args.map(quoteToml).join(', ')
  const envLines = Object.entries(launch.env).map(([key, value]) => `${key} = ${quoteToml(value)}`).join('\n')
  const block = [
    `[mcp_servers.${serverName}]`,
    `command = ${quoteToml(launch.command)}`,
    `args = [${args}]`,
    '',
    `[mcp_servers.${serverName}.env]`,
    envLines,
    '',
  ].join('\n')
  if (stripped === '') return `${block}\n`
  return `${stripped}\n\n${block}\n`
}

function launchEnv(config: ResolvedConfig): Record<string, string> {
  const env: Record<string, string> = {
    DSH_WEB_URL: config.webUrl,
  }
  if (config.allowedWorkspaceRoots.length > 0) {
    env.DSH_MCP_WORKSPACE_ROOTS = config.allowedWorkspaceRoots.join(delimiter)
  }
  env.DSH_MCP_CREDENTIALS_PATH = config.credentialsPath
  env.DSH_MCP_DATA_DIR = config.dataDirectory
  return env
}

async function readText(path: string): Promise<string> {
  try {
    return await readFile(path, 'utf8')
  } catch (error) {
    if (isEnoent(error)) return ''
    throw error
  }
}

async function readConfigDocument(path: string): Promise<Record<string, unknown>> {
  const raw = await readText(path)
  if (raw.trim() === '') return {}
  const parsed: unknown = JSON.parse(raw)
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`dsh-relay: ${path} must contain a JSON object`)
  }
  return parsed as Record<string, unknown>
}

function quoteToml(value: string): string {
  if (!value.includes("'") && !value.includes('\n') && !value.includes('\r')) return `'${value}'`
  return JSON.stringify(value)
}

function isEnoent(error: unknown): boolean {
  return error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT'
}

function isServerMap(value: unknown): value is Record<string, McpServerLaunch> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
