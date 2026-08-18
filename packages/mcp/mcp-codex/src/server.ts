/** MCP tool surface for Codex-owned Harness Web sessions. */

import { stat } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import { CodexRunManager } from './manager.ts'
import type { ResolvedConfig } from './runtime.ts'
import type { RunId, ServiceId } from './types.ts'

const runIdSchema = z.uuid().describe('Run identifier returned by start_run.')
const serviceIdSchema = z.uuid().describe('Service identifier returned by start_service or start_run.')

/**
 * Create the stable eleven-tool server over one lifecycle manager.
 * @param manager - owner of services and runs.
 * @param config - resolved diagnostics and policy configuration.
 * @param subprocess - process provider inspected by doctor.
 * @returns an unconnected MCP server.
 */
export function createMcpServer(
  manager: CodexRunManager,
  config: ResolvedConfig,
  subprocess: SubprocessRuntime,
): McpServer {
  const server = new McpServer(
    { name: '@deepseek-ai/dsh-mcp-codex', version: '0.1.0-rc.5' },
    {
      instructions: 'Start one visible Harness session, show its webUrl immediately, wait in intervals of at most 30 seconds, use steer_run for live correction, continue a terminal session with start_run.sessionId, and independently review the resulting workspace changes.',
    },
  )

  server.registerTool('doctor', {
    title: 'Check the Harness Codex runtime',
    description: 'Check the direct Node launcher, package version, workspace policy, and managed process provider without reading credentials.',
    inputSchema: {},
    annotations: readOnlyAnnotations,
  }, async () => result(await inspectRuntime(config, subprocess)))

  server.registerTool('start_service', {
    title: 'Start the Harness Web service',
    description: 'Start or reuse the managed Harness Web service for an absolute workspace. The browser stays closed by default.',
    inputSchema: {
      workspace: z.string().min(1).describe('Absolute workspace directory.'),
      openBrowser: z.boolean().default(false).describe('Open the loopback page after readiness.'),
    },
    annotations: mutableAnnotations(true),
  }, guarded(input => manager.startService(input)))

  server.registerTool('open_service', {
    title: 'Open the Harness Web service',
    description: 'Open a running service loopback URL in the platform browser.',
    inputSchema: { serviceId: serviceIdSchema },
    annotations: mutableAnnotations(true),
  }, guarded(input => manager.openService(input.serviceId as ServiceId)))

  server.registerTool('list_services', {
    title: 'List Harness Web services',
    description: 'List Web services supervised by this MCP process.',
    inputSchema: {},
    annotations: readOnlyAnnotations,
  }, () => result({ services: manager.listServices() }))

  server.registerTool('stop_service', {
    title: 'Stop the Harness Web service',
    description: 'Cancel active work, wait for agent quiescence, and terminate the complete managed process tree.',
    inputSchema: { serviceId: serviceIdSchema },
    annotations: destructiveAnnotations,
  }, guarded(input => manager.stopService(input.serviceId as ServiceId)))

  server.registerTool('start_run', {
    title: 'Start a visible Harness run',
    description: 'Submit a task into a new session or continue an idle session and return its live Web deep link immediately.',
    inputSchema: {
      task: z.string().min(1).max(config.maxTaskCharacters).describe('Implementation or analysis task for Harness.'),
      workspace: z.string().min(1).describe('Absolute workspace directory.'),
      sessionId: z.string().min(1).optional().describe('Idle session in this workspace to continue.'),
      openBrowser: z.boolean().default(false).describe('Open the session deep link after admission.'),
    },
    annotations: mutableAnnotations(false),
  }, guarded(input => manager.start({
    task: input.task,
    workspace: input.workspace,
    openBrowser: input.openBrowser,
    ...input.sessionId === undefined ? {} : { sessionId: input.sessionId },
  })))

  server.registerTool('steer_run', {
    title: 'Steer an active Harness run',
    description: 'Insert a durable correction into the active agent turn without creating a new run or session.',
    inputSchema: {
      runId: runIdSchema,
      task: z.string().min(1).max(config.maxTaskCharacters).describe('Correction or additional instruction for the active Harness run.'),
    },
    annotations: mutableAnnotations(false),
  }, guarded(input => manager.steer(input.runId as RunId, input.task)))

  server.registerTool('get_run', {
    title: 'Read a Harness run',
    description: 'Return the immediate in-memory snapshot for one MCP run.',
    inputSchema: { runId: runIdSchema },
    annotations: readOnlyAnnotations,
  }, guarded(input => Promise.resolve(manager.get(input.runId as RunId))))

  server.registerTool('wait_run', {
    title: 'Wait for Harness run progress',
    description: 'Wait for the next run state change or completion for at most 30 seconds.',
    inputSchema: {
      runId: runIdSchema,
      timeoutMs: z.number().int().min(0).max(30_000).default(30_000),
    },
    annotations: readOnlyAnnotations,
  }, guarded(input => manager.wait(input.runId as RunId, input.timeoutMs)))

  server.registerTool('list_runs', {
    title: 'List Harness runs',
    description: 'List runs retained by this MCP process, optionally restricted to one service.',
    inputSchema: { serviceId: serviceIdSchema.optional() },
    annotations: readOnlyAnnotations,
  }, input => result({ runs: manager.list(input.serviceId as ServiceId | undefined) }))

  server.registerTool('cancel_run', {
    title: 'Cancel a Harness run',
    description: 'Idempotently request cancellation; terminal cancellation follows durable abort and agent-idle evidence.',
    inputSchema: { runId: runIdSchema },
    annotations: destructiveAnnotations,
  }, guarded(input => manager.cancel(input.runId as RunId)))

  return server
}

const readOnlyAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const

const destructiveAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: true,
  openWorldHint: false,
} as const

function mutableAnnotations(idempotent: boolean) {
  return {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: idempotent,
    openWorldHint: true,
  } as const
}

function result(value: object) {
  const structuredContent: Record<string, unknown> = { ...value }
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(structuredContent) }],
    structuredContent,
  }
}

function failure(error: unknown) {
  const message = error instanceof Error ? error.message : String(error)
  return { content: [{ type: 'text' as const, text: message }], isError: true }
}

function guarded<TInput, TOutput extends object>(operation: (input: TInput) => Promise<TOutput>) {
  return async (input: TInput) => {
    try {
      return result(await operation(input))
    } catch (error) {
      return failure(error)
    }
  }
}

async function inspectRuntime(config: ResolvedConfig, subprocess: SubprocessRuntime): Promise<object> {
  const entry = process.argv[1]
  const entryDirect = entry !== undefined && isAbsolute(entry)
  const entryExists = entryDirect && (await stat(entry).then(value => value.isFile(), () => false))
  const node = await subprocess.resolveExecutable(process.execPath).then(() => true, () => false)
  return {
    ok: node && entryExists,
    node: { version: process.version, execPath: process.execPath, available: node },
    package: { name: '@deepseek-ai/dsh-mcp-codex', version: '0.1.0-rc.5' },
    launcher: { entry: entry ?? null, direct: entryDirect, exists: entryExists, shell: false },
    workspacePolicy: {
      restricted: config.allowedWorkspaceRoots.length > 0,
      roots: config.allowedWorkspaceRoots,
    },
    subprocess: { managedProcessTrees: true },
  }
}
