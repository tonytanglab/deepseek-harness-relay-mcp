/**
 * Web-profile helper that writes MCP config so Cursor, Codex, or Claude Code
 * can attach to an already-running Harness Web. It never connects MCP stdio
 * in this process.
 *
 * Namespace plugin (named exports, no default export).
 * @module dsh-relay
 */

import { isAbsolute } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { CommandResult } from '@deepseek-ai/dsh-commands'
import { defineTool, type JsonValue } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-commands'
import type {} from '@deepseek-ai/dsh-tools'
import {
  DEFAULT_DSH_PACKAGE,
  DEFAULT_MCP_SERVER_NAME,
  resolveConfig,
  type ResolvedConfig,
} from './config.ts'
import { DEFAULT_WEB_URL } from './harness-rpc.ts'
import { inspectRuntime, type DoctorReport } from './doctor.ts'
import { MCP_HOSTS, parseMcpHost, type McpHost } from './hosts.ts'
import { buildMcpLaunch, writeMcpConfigFile, type McpServerLaunch } from './mcp-config.ts'

/** Stable Cordis plugin name. */
export const name = 'relay'

/** Command and tool registries required before apply. */
export const inject = ['commands', 'tools']

/** Validated helper settings supplied through the bundle patch. */
export interface Config {
  /** MCP server key written into host config documents. */
  mcpServerName: string
  /** Absolute JSON path written by `/relay-setup` when set. */
  mcpConfigPath?: string
  /** Canonical workspace roots; empty reads DSH_MCP_WORKSPACE_ROOTS. */
  allowedWorkspaceRoots: string[]
  /** Shared credentials document path. */
  credentialsPath?: string
  /** Parent directory for per-workspace Codex service homes. */
  dataDirectory?: string
  /** Pinned `@deepseek-ai/dsh@<version>` kept for compatibility. */
  dshPackage: string
  /** Default MCP host for `/relay-setup` writes. */
  host: McpHost
  /** Already-running Harness Web origin the host MCP attaches to. */
  webUrl?: string
}

export const Config: z<Config> = z.object({
  mcpServerName: z.string().default(DEFAULT_MCP_SERVER_NAME),
  mcpConfigPath: z.string(),
  allowedWorkspaceRoots: z.array(String).default([]),
  credentialsPath: z.string(),
  dataDirectory: z.string(),
  dshPackage: z.string().default(DEFAULT_DSH_PACKAGE),
  host: z.union(['codex', 'cursor', 'claude-code'] as const).default('codex'),
  webUrl: z.string().default(DEFAULT_WEB_URL),
})

const DOCTOR_DESCRIPTION = 'Check the direct Node launcher, workspace policy, and credentials path without reading credential contents or starting MCP stdio.'
const WRITE_DESCRIPTION = 'Build the MCP stdio launch block for Codex, Cursor, or Claude Code that attaches to the already-running Harness Web. Writes the block when a path is supplied; does not start MCP in this process.'
const SETUP_DESCRIPTION = 'Diagnose the Harness attach path and print or write MCP configuration. This Web profile does not run the MCP stdio server.'
const SETUP_EXTRA_INPUT = 'The /relay-setup command does not accept extra input.'

interface WriteResult {
  written: boolean
  path: string | null
  host: McpHost
  serverName: string
  config: McpServerLaunch
}

/**
 * Register `/relay-setup`, `relay_doctor`, and `relay_write_mcp_config`.
 * @param ctx - plugin context carrying commands and tools.
 * @param config - validated helper settings.
 */
export function apply(ctx: Context, config: Config): void {
  const resolved = resolveConfig(config)
  ctx.effect(() => ctx.commands.register({
    name: 'relay-setup',
    description: SETUP_DESCRIPTION,
    handler: invocation => runSetup(resolved, invocation.rawInput),
  }), 'relay.command')
  ctx.tools.register(defineTool({
    name: 'relay_doctor',
    description: DOCTOR_DESCRIPTION,
    parameters: {},
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    isConcurrencySafe: () => true,
    execute: async () => await inspectRuntime(resolved, process.argv[1], process.execPath, process.version) as unknown as JsonValue,
    presentCall: () => ({ card: 'generic', title: 'Check DSH Relay launch', kind: 'read' }),
  }))
  ctx.tools.register(defineTool({
    name: 'relay_write_mcp_config',
    description: WRITE_DESCRIPTION,
    parameters: {
      host: {
        type: 'string',
        required: true,
        enum: MCP_HOSTS,
        description: 'MCP host that will attach to the running Harness Web',
      },
      path: {
        type: 'string',
        description: 'Absolute JSON (Cursor/Claude) or TOML (Codex config.toml) file to merge the server block into',
      },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args): Promise<JsonValue> {
      return await writeLaunch(resolved, parseMcpHost(args.host), args.path) as unknown as JsonValue
    },
    presentCall: args => args.path === undefined
      ? { card: 'generic', title: 'Build MCP launch config', kind: 'other' }
      : { card: 'generic', title: 'Write MCP launch config', kind: 'edit', locations: [{ path: args.path }] },
  }))
}

export type { DoctorReport, McpHost, McpServerLaunch, ResolvedConfig, WriteResult }
export { buildMcpLaunch, DEFAULT_DSH_PACKAGE, DEFAULT_WEB_URL, inspectRuntime, MCP_HOSTS, resolveConfig }

async function runSetup(config: ResolvedConfig, rawInput: string): Promise<CommandResult> {
  if (rawInput.trim() !== '') return { kind: 'error', text: SETUP_EXTRA_INPUT }
  const doctor = await inspectRuntime(config, process.argv[1], process.execPath, process.version)
  const written = await writeLaunch(config, config.host, config.mcpConfigPath)
  return {
    kind: 'success',
    text: formatSetup(doctor, written),
  }
}

async function writeLaunch(
  config: ResolvedConfig,
  host: McpHost,
  path: string | undefined,
): Promise<WriteResult> {
  const launch = buildMcpLaunch(config, host)
  if (path === undefined) {
    return { written: false, path: null, host, serverName: config.mcpServerName, config: launch }
  }
  if (!isAbsolute(path)) throw new Error('dsh-relay: mcp config path must be absolute')
  await writeMcpConfigFile(path, config.mcpServerName, launch)
  return { written: true, path, host, serverName: config.mcpServerName, config: launch }
}

function formatSetup(doctor: DoctorReport, written: WriteResult): string {
  const destination = written.written && written.path !== null ? written.path : 'not written'
  return [
    'DSH Relay is loaded in this Web profile. It does not run the MCP stdio server here.',
    '',
    `Doctor: ok=${String(doctor.ok)} launcher.direct=${String(doctor.launcher.direct)} shell=${String(doctor.launcher.shell)}`,
    '',
    `MCP launch (host=${written.host}, server=${written.serverName}):`,
    JSON.stringify({ [written.serverName]: written.config }, null, 2),
    '',
    `Written: ${destination}`,
  ].join('\n')
}
