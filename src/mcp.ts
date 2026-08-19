#!/usr/bin/env node
/**
 * MCP stdio entry that attaches to an already-running Harness Web.
 * Not loaded by the Web-profile plugin (that process must not own stdin/stdout).
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { PACKAGE_NAME, PACKAGE_VERSION } from './config.ts'
import { DEFAULT_WEB_URL, resolveWebUrl } from './harness-rpc.ts'
import { AttachManager } from './attach.ts'

const webUrl = resolveWebUrl(process.env.DSH_WEB_URL?.trim() || process.env.DSH_MCP_WEB_URL?.trim() || DEFAULT_WEB_URL)
const roots = (process.env.DSH_MCP_WORKSPACE_ROOTS ?? '').split(process.platform === 'win32' ? ';' : ':')
  .map(value => value.trim()).filter(Boolean)
const manager = new AttachManager({ webUrl, allowedWorkspaceRoots: roots })

const runIdSchema = z.string().uuid().describe('Run identifier returned by start_run.')
const serviceIdSchema = z.string().uuid().describe('Service identifier returned by start_service.')

const server = new McpServer(
  { name: PACKAGE_NAME, version: PACKAGE_VERSION },
  {
    instructions: 'Attach to the running Harness Web (default http://127.0.0.1:3080). Start one session with start_run. A trailing max/high/low on the model name is reasoning effort (K3 MAX means k3 + max; deepseek v4 flash max means deepseek-v4-flash + max), not a different model. Return webUrl as a clickable link without opening a browser. Wait in intervals of at most 30 seconds and read wait_run status/error/text. Do not spawn dsh --profile codex.',
  },
)

server.registerTool('doctor', {
  title: 'Check the attached Harness Web',
  description: 'Ping the attached Harness Web and return workspace policy plus the model catalog (ids, names, reasoning efforts).',
  inputSchema: {},
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, async () => result(await manager.doctor()))

server.registerTool('start_service', {
  title: 'Attach the Harness Web service',
  description: 'Reuse the already-running Harness Web. Does not start a new dsh process.',
  inputSchema: {
    workspace: z.string().min(1).optional().describe('Absolute workspace directory.'),
    openBrowser: z.boolean().default(false).describe('Open the OS browser. Leave false; return webUrl as a link instead.'),
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
}, guarded(input => manager.startService(input)))

server.registerTool('open_service', {
  title: 'Open the Harness Web',
  description: 'Open the attached Harness task page in the platform browser.',
  inputSchema: { serviceId: serviceIdSchema.optional() },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
}, guarded(() => manager.openService()))

server.registerTool('list_services', {
  title: 'List Harness Web services',
  description: 'List the attached Harness Web origin.',
  inputSchema: {},
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, () => result({ services: manager.listServices() }))

server.registerTool('stop_service', {
  title: 'Stop the Harness Web service',
  description: 'Does not stop the user-owned Harness Web; the attach target stays running.',
  inputSchema: { serviceId: serviceIdSchema.optional() },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, () => result(manager.stopService()))

server.registerTool('start_run', {
  title: 'Start a visible Harness run',
  description: 'Submit a task into the attached Harness Web, optionally select a model first, and return the session deep link. Do not open a browser unless the user asked.',
  inputSchema: {
    task: z.string().min(1).describe('Implementation or analysis task for Harness.'),
    workspace: z.string().min(1).describe('Absolute workspace directory.'),
    sessionId: z.string().min(1).optional().describe('Idle session in this workspace to continue.'),
    model: z.string().min(1).optional().describe('Harness model id or display name. A trailing max/high/low is reasoning effort: "K3 MAX" is k3+max, "deepseek v4 flash max" is deepseek-v4-flash+max.'),
    provider: z.string().min(1).optional().describe('Harness provider id, such as kimi-coding. Optional when the model id is unique.'),
    reasoningEffort: z.string().min(1).optional().describe('Reasoning effort (max/high/medium/low). Overrides a trailing effort word in model.'),
    openBrowser: z.boolean().default(false).describe('Open the OS browser. Leave false; return webUrl as a link instead.'),
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
}, guarded(input => manager.start(input)))

server.registerTool('steer_run', {
  title: 'Steer an active Harness run',
  description: 'Insert a live correction into the active Harness turn.',
  inputSchema: {
    runId: runIdSchema,
    task: z.string().min(1).describe('Correction or additional instruction for the active Harness run.'),
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
}, guarded(input => manager.steer(input.runId, input.task)))

server.registerTool('get_run', {
  title: 'Read a Harness run',
  description: 'Refresh from the attached Harness Web and return the run snapshot, including last assistant text.',
  inputSchema: { runId: runIdSchema },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, guarded(input => manager.get(input.runId)))

server.registerTool('wait_run', {
  title: 'Wait for Harness run progress',
  description: 'Wait until the Harness turn ends or 30 seconds elapse. Terminal snapshots include status, error, and last assistant text.',
  inputSchema: {
    runId: runIdSchema,
    timeoutMs: z.number().int().min(0).max(30_000).default(30_000),
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, guarded(input => manager.wait(input.runId, input.timeoutMs)))

server.registerTool('list_runs', {
  title: 'List Harness runs',
  description: 'Refresh and list runs retained by this Relay MCP process.',
  inputSchema: { serviceId: serviceIdSchema.optional() },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, guarded(async input => ({ runs: await manager.list(input.serviceId) })))

server.registerTool('cancel_run', {
  title: 'Cancel a Harness run',
  description: 'Request cancellation of the Harness session behind one Relay run.',
  inputSchema: { runId: runIdSchema },
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
}, guarded(input => manager.cancel(input.runId)))

const transport = new StdioServerTransport()
await server.connect(transport)

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
