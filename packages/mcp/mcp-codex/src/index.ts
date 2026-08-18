/** Codex-facing MCP server that supervises visible Harness Web sessions. */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CodexRunManager } from './manager.ts'
import { resolveConfig } from './runtime.ts'
import { createMcpServer } from './server.ts'

/** Stable Cordis plugin name. */
export const name = 'mcp-codex'

/** Managed subprocess trees are required for Web service ownership. */
export const inject = ['subprocess']

/** Validated MCP service limits and workspace policy. */
export interface Config {
  /** Persistent parent directory for per-workspace Harness homes. */
  dataDirectory?: string
  /** User-global credentials document shared by supervised workspace services. */
  credentialsPath?: string
  /** Canonical workspace roots accepted by tool calls; empty reads DSH_MCP_WORKSPACE_ROOTS. */
  allowedWorkspaceRoots: string[]
  /** Web readiness deadline in milliseconds. */
  startupTimeoutMs: number
  /** Agent and process-tree shutdown grace in milliseconds. */
  stopGraceMs: number
  /** Host RPC and event-stream setup deadline in milliseconds. */
  rpcTimeoutMs: number
  /** One platform browser opener settle deadline in milliseconds. */
  browserOpenTimeoutMs: number
  /** Delay before reconnecting a previously opened event stream. */
  eventReconnectDelayMs: number
  /** Maximum submitted task length in UTF-16 code units. */
  maxTaskCharacters: number
  /** Maximum service log tail length in UTF-16 code units. */
  maxLogCharacters: number
  /** Maximum inline assistant response in UTF-8 bytes. */
  maxAssistantTextBytes: number
  /** Maximum retained tool-activity entries per run snapshot. */
  maxToolEvents: number
  /** Per-field UTF-8 cap for retained tool arguments and result summaries. */
  maxToolEventBytes: number
}

export const Config: z<Config> = z.object({
  dataDirectory: z.string(),
  credentialsPath: z.string(),
  allowedWorkspaceRoots: z.array(String).default([]),
  startupTimeoutMs: z.number().step(1).min(1).max(300_000).default(60_000),
  stopGraceMs: z.number().step(1).min(1).max(60_000).default(10_000),
  rpcTimeoutMs: z.number().step(1).min(1).max(60_000).default(10_000),
  browserOpenTimeoutMs: z.number().step(1).min(1).max(60_000).default(10_000),
  eventReconnectDelayMs: z.number().step(1).min(1).max(60_000).default(250),
  maxTaskCharacters: z.number().step(1).min(1).max(1_000_000).default(100_000),
  maxLogCharacters: z.number().step(1).min(1).max(1_000_000).default(100_000),
  maxAssistantTextBytes: z.number().step(1).min(1).max(1_000_000).default(50_000),
  maxToolEvents: z.number().step(1).min(1).max(1_000).default(20),
  maxToolEventBytes: z.number().step(1).min(1).max(1_000_000).default(2_000),
})

/**
 * Publish the stdio MCP server and bind its teardown to the Cordis effect.
 * @param ctx - plugin context carrying the managed subprocess provider.
 * @param config - validated lifecycle limits and workspace policy.
 * @returns readiness after the MCP transport is connected.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  const resolved = resolveConfig(config)
  const manager = new CodexRunManager(ctx.subprocess, resolved)
  const server = createMcpServer(manager, resolved, ctx.subprocess)
  const transport = new StdioServerTransport()
  await server.connect(transport)
  ctx.effect(() => async () => {
    const outcomes = await Promise.allSettled([manager.close(), server.close()])
    const failures = outcomes.flatMap(outcome => outcome.status === 'rejected' ? [outcome.reason as unknown] : [])
    if (failures.length === 1) throw failures[0]
    if (failures.length > 1) throw new AggregateError(failures, 'mcp-codex teardown failed')
  }, 'mcp-codex.transport')
}

export type { RunId, RunSnapshot, ServiceId, ServiceSnapshot, SteerRunResult, ToolActivity } from './types.ts'
