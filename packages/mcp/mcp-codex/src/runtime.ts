/** Direct CLI launch, workspace authorization, and readiness framing helpers. */

import { createHash } from 'node:crypto'
import { realpath, stat } from 'node:fs/promises'
import { delimiter, isAbsolute, join, relative, resolve } from 'node:path'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'

/** Fully resolved supervisor settings. */
export interface ResolvedConfig {
  dataDirectory: string
  credentialsPath: string
  allowedWorkspaceRoots: string[]
  startupTimeoutMs: number
  stopGraceMs: number
  rpcTimeoutMs: number
  browserOpenTimeoutMs: number
  eventReconnectDelayMs: number
  maxTaskCharacters: number
  maxLogCharacters: number
  maxAssistantTextBytes: number
  maxToolEvents: number
  maxToolEventBytes: number
}

/** Direct, shell-free command for one Web child. */
export interface WebCommand {
  argv: string[]
  cwd: string
  env: NodeJS.ProcessEnv
}

/**
 * Resolve environment-backed data and root defaults into plugin configuration.
 * @param config - validated explicit plugin configuration.
 * @returns absolute data and workspace-root settings with the remaining limits.
 */
export function resolveConfig(config: Omit<ResolvedConfig, 'dataDirectory' | 'credentialsPath' | 'allowedWorkspaceRoots'> & {
  dataDirectory?: string
  credentialsPath?: string
  allowedWorkspaceRoots: string[]
}): ResolvedConfig {
  const configuredRoots = config.allowedWorkspaceRoots.length > 0
    ? config.allowedWorkspaceRoots
    : (process.env.DSH_MCP_WORKSPACE_ROOTS ?? '').split(delimiter).map(value => value.trim()).filter(Boolean)
  return {
    ...config,
    dataDirectory: resolve(config.dataDirectory?.trim() || process.env.DSH_MCP_DATA_DIR?.trim()
      || join(resolveDshHome(), 'codex-services')),
    credentialsPath: resolve(config.credentialsPath?.trim() || process.env.DSH_MCP_CREDENTIALS_PATH?.trim()
      || join(resolveDshHome(), '.credentials.yaml')),
    allowedWorkspaceRoots: configuredRoots.map(root => resolve(root)),
  }
}

/**
 * Build a direct invocation of the currently running dsh entry.
 * @param workspace - canonical workspace used as the child working directory.
 * @param serviceHome - workspace-specific Harness data directory.
 * @param credentialsPath - user-global credentials document shared by workspace services.
 * @returns a shell-free Node command and UTF-8 environment.
 */
export function webCommand(workspace: string, serviceHome: string, credentialsPath: string): WebCommand {
  const entry = process.argv[1]
  if (entry === undefined || !isAbsolute(entry)) {
    throw new Error('mcp-codex: the dsh launcher entry must be an absolute path')
  }
  return {
    argv: [
      process.execPath,
      ...process.execArgv,
      entry,
      '--profile', 'web', '--port', '0', '--ready-format', 'json',
    ],
    cwd: workspace,
    env: {
      ...process.env,
      DSH_CWD: workspace,
      DSH_HOME: serviceHome,
      DSH_GLOBAL_CREDENTIALS_PATH: credentialsPath,
      DSH_CREDENTIALS_DEFAULT_SCOPE: 'global',
      DSH_TELEMETRY_DISABLED: process.env.DSH_TELEMETRY_DISABLED?.trim() || '1',
      NO_COLOR: '1',
      PYTHONIOENCODING: 'utf-8',
      PYTHONUTF8: '1',
    },
  }
}

/**
 * Resolve and authorize one existing workspace directory.
 * @param input - absolute workspace path supplied through MCP.
 * @param roots - configured allowed roots before canonicalization.
 * @returns the canonical workspace directory.
 */
export async function resolveWorkspace(input: string, roots: readonly string[]): Promise<string> {
  if (!isAbsolute(input)) throw new Error('workspace must be an absolute path')
  const workspace = await realpath(input)
  if (!(await stat(workspace)).isDirectory()) throw new Error('workspace must point to a directory')
  if (roots.length > 0) {
    const canonicalRoots = await Promise.all(roots.map(root => realpath(root)))
    if (!canonicalRoots.some(root => isWithin(root, workspace))) {
      throw new Error('workspace is outside DSH_MCP_WORKSPACE_ROOTS')
    }
  }
  return workspace
}

/**
 * Stable service home for one canonical workspace.
 * @param dataDirectory - parent directory for Codex services.
 * @param workspace - canonical workspace path.
 * @returns the full SHA-256 keyed service directory.
 */
export function serviceHome(dataDirectory: string, workspace: string): string {
  const key = createHash('sha256').update(workspace).digest('hex')
  return join(dataDirectory, key)
}

/**
 * Parse and validate one machine-readable Web readiness line.
 * @param line - one complete UTF-8 stdout line.
 * @returns the loopback origin, or undefined for an unrelated line.
 */
export function readyUrl(line: string): string | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined
  const record = parsed as Record<string, unknown>
  if (record.type !== 'dsh/web-ready' || typeof record.url !== 'string') return undefined
  const url = new URL(record.url)
  if (url.protocol !== 'http:' || (url.hostname !== '127.0.0.1' && url.hostname !== 'localhost')
    || url.username !== '' || url.password !== '' || url.pathname !== '/' || url.search !== '' || url.hash !== '') {
    throw new Error(`mcp-codex: rejected Web readiness URL ${JSON.stringify(record.url)}`)
  }
  return url.origin
}

/**
 * Retain a UTF-8 tail that never starts inside a code point.
 * @param text - complete text to measure.
 * @param maxBytes - maximum retained UTF-8 bytes.
 * @returns retained text, complete byte count, and truncation flag.
 */
export function utf8Tail(text: string, maxBytes: number): { text: string; bytes: number; truncated: boolean } {
  const encoded = Buffer.from(text, 'utf8')
  if (encoded.byteLength <= maxBytes) return { text, bytes: encoded.byteLength, truncated: false }
  const decoder = new TextDecoder('utf-8', { fatal: true })
  let start = encoded.byteLength - maxBytes
  while (start < encoded.byteLength) {
    try {
      return { text: decoder.decode(encoded.subarray(start)), bytes: encoded.byteLength, truncated: true }
    } catch {
      start++
    }
  }
  return { text: '', bytes: encoded.byteLength, truncated: true }
}

function isWithin(root: string, candidate: string): boolean {
  const child = relative(root, candidate)
  return child === '' || (!child.startsWith('..') && !isAbsolute(child))
}
