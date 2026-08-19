import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import type { RelayConfig } from '../config.js'
import { HostRpcError } from '../host-client.js'
import { AttentionReason, MonitoringError, MonitoringFacade } from '../monitoring/index.js'
import { MCP_SERVER_ID, PRODUCT_DISPLAY_NAME } from '../product-identity/index.js'
import { RelayError, type RelayFacade } from '../relay-broker/index.js'
import { ClientSetupFacade } from '../setup/index.js'
import type { DoctorFacts, SetupRequest } from '../setup/index.js'

const id = z.uuid()
const idempotencyKey = z.string().trim().min(1).max(128).optional()

export function createServer(relay: RelayFacade, config: RelayConfig, monitoring: MonitoringFacade = new MonitoringFacade(), clientPrincipalId: string = config.clientPrincipalId): McpServer {
  const setup = new ClientSetupFacade()
  const server = new McpServer(
    { name: MCP_SERVER_ID, version: __DSH_RELAY_VERSION__ },
    { instructions: 'Use DeepSeek Harness native sessions and durable events. Select explicit provider/model/reasoning/preset/permission parameters before the first task, share a verified stable session URL on the first run, monitor with wait_run, and independently verify all findings.' },
  )

  server.registerTool('doctor', {
    title: `Check ${PRODUCT_DISPLAY_NAME} and Harness`,
    description: 'Check the external Harness Host and relay policy without reading credentials.',
    inputSchema: {}, annotations: readOnly,
  }, guarded(() => relay.doctor()))

  server.registerTool('setup_plan', {
    title: `Plan ${PRODUCT_DISPLAY_NAME} client setup`,
    description: 'Generate a validated, no-write MCP configuration patch for Codex, Claude Code, Cursor, or OpenCode V2.',
    inputSchema: setupInputSchema,
    outputSchema: setupPlanOutputSchema,
    annotations: readOnly,
  }, guarded(input => setup.plan(toSetupRequest(input))))

  server.registerTool('setup_doctor', {
    title: `Diagnose a ${PRODUCT_DISPLAY_NAME} client setup plan`,
    description: 'Return a machine-readable setup report from explicitly supplied probes without reading or modifying client configuration.',
    inputSchema: { ...setupInputSchema, facts: doctorFactsSchema.optional() },
    outputSchema: setupDoctorOutputSchema,
    annotations: readOnly,
  }, guarded(input => setup.doctor({
    setup: toSetupRequest(input),
    ...(input.facts === undefined ? {} : { facts: input.facts satisfies DoctorFacts }),
  })))

  server.registerTool('start_service', {
    title: 'Attach to DeepSeek Harness',
    description: 'Attach an authorized workspace to the existing Harness Host. This never starts or modifies Harness.',
    inputSchema: { workspace: z.string().min(1), openBrowser: z.boolean().default(false) }, annotations: mutable(true),
  }, guarded(input => relay.startService(input)))

  server.registerTool('open_service', {
    title: 'Open DeepSeek Harness',
    description: 'Open the stable loopback Harness page for an attached service.',
    inputSchema: { serviceId: id }, annotations: mutable(true),
  }, guarded(input => relay.openService(input.serviceId)))

  server.registerTool('list_services', {
    title: 'List Harness attachments', description: 'List Host attachments restored from durable relay state.', inputSchema: {}, annotations: readOnly,
  }, guarded(async () => ({ services: await relay.listServices() })))

  server.registerTool('list_workspaces', {
    title: 'List Harness workspaces',
    description: 'List the native Harness workspace registry used by Relay routing.',
    inputSchema: {},
    outputSchema: listWorkspacesOutputSchema,
    annotations: readOnly,
  }, guarded(() => relay.listWorkspaces()))

  server.registerTool('list_workspace_sessions', {
    title: 'List sessions in a Harness workspace',
    description: 'List reusable native sessions accounted to one registered Harness workspace without reading conversation content.',
    inputSchema: { workspace: z.string().min(1) },
    outputSchema: listWorkspaceSessionsOutputSchema,
    annotations: readOnly,
  }, guarded(input => relay.listWorkspaceSessions(input.workspace)))

  server.registerTool('stop_service', {
    title: 'Detach from DeepSeek Harness',
    description: 'Forget one relay attachment without stopping or changing the external Harness Host.',
    inputSchema: { serviceId: id }, annotations: mutable(true),
  }, guarded(input => relay.stopService(input.serviceId)))

  server.registerTool('list_capabilities', {
    title: 'List Harness run options',
    description: 'List native Provider/model/reasoning, agent preset, and permission preset options without guessing names.',
    inputSchema: {}, annotations: readOnly,
  }, guarded(() => relay.listCapabilities()))

  server.registerTool('start_run', {
    title: 'Dispatch a Harness run',
    description: 'Create or reuse a native Harness session, select provider/model/reasoning, agent preset, and native permission preset, then submit the first task and return a stable session link.',
    inputSchema: {
      task: z.string().min(1).max(config.maxTaskCharacters).optional(),
      content: z.array(promptPart(config.maxTaskCharacters)).min(1).optional(),
      workspace: z.string().min(1),
      sessionId: z.string().min(1).optional(),
      sessionMode: z.enum(['fresh', 'latest-idle']).optional(),
      provider: z.string().trim().min(1).optional(),
      model: z.string().trim().min(1).optional(),
      reasoningEffort: z.string().trim().min(1).optional(),
      agentPreset: z.string().trim().min(1).optional(),
      permissionPreset: z.enum(['read-only', 'workspace-write', 'danger-full-access']).optional(),
      confirmedDangerousPermission: z.boolean().default(false),
      idempotencyKey,
      openBrowser: z.boolean().default(false),
    },
    annotations: runAction,
  }, guarded(input => relay.startRun({
    workspace: input.workspace,
    openBrowser: input.openBrowser,
    ...(input.task === undefined ? {} : { task: input.task }),
    ...(input.content === undefined ? {} : { content: input.content }),
    ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
    ...(input.sessionMode === undefined ? {} : { sessionMode: input.sessionMode }),
    ...(input.provider === undefined ? {} : { provider: input.provider }),
    ...(input.model === undefined ? {} : { model: input.model }),
    ...(input.reasoningEffort === undefined ? {} : { reasoningEffort: input.reasoningEffort }),
    ...(input.agentPreset === undefined ? {} : { agentPreset: input.agentPreset }),
    ...(input.permissionPreset === undefined ? {} : { permissionPreset: input.permissionPreset }),
    ...(input.confirmedDangerousPermission ? { confirmedDangerousPermission: true } : {}),
    ...(input.idempotencyKey === undefined ? {} : { idempotencyKey: input.idempotencyKey }),
  }, clientPrincipalId)))

  server.registerTool('start_review', {
    title: 'Dispatch a read-only Harness review',
    description: 'Create or reuse a native Harness session with the permission preset fixed to read-only, then return a stable session link.',
    inputSchema: {
      task: z.string().min(1).max(config.maxTaskCharacters).optional(),
      content: z.array(promptPart(config.maxTaskCharacters)).min(1).optional(),
      workspace: z.string().min(1),
      sessionId: z.string().min(1).optional(),
      sessionMode: z.enum(['fresh', 'latest-idle']).optional(),
      provider: z.string().trim().min(1).optional(),
      model: z.string().trim().min(1).optional(),
      reasoningEffort: z.string().trim().min(1).optional(),
      agentPreset: z.string().trim().min(1).optional(),
      idempotencyKey,
      openBrowser: z.boolean().default(false),
    },
    annotations: reviewAction,
  }, guarded(input => relay.startRun({
    workspace: input.workspace,
    permissionPreset: 'read-only',
    openBrowser: input.openBrowser,
    ...(input.task === undefined ? {} : { task: input.task }),
    ...(input.content === undefined ? {} : { content: input.content }),
    ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
    ...(input.sessionMode === undefined ? {} : { sessionMode: input.sessionMode }),
    ...(input.provider === undefined ? {} : { provider: input.provider }),
    ...(input.model === undefined ? {} : { model: input.model }),
    ...(input.reasoningEffort === undefined ? {} : { reasoningEffort: input.reasoningEffort }),
    ...(input.agentPreset === undefined ? {} : { agentPreset: input.agentPreset }),
    ...(input.idempotencyKey === undefined ? {} : { idempotencyKey: input.idempotencyKey }),
  }, clientPrincipalId)))

  server.registerTool('steer_run', {
    title: 'Steer a Harness run', description: 'Durably insert a correction into an active run.',
    inputSchema: { runId: id, task: z.string().min(1).max(config.maxTaskCharacters).optional(), content: z.array(promptPart(config.maxTaskCharacters)).min(1).optional(), idempotencyKey },
    annotations: runAction,
  }, guarded(input => relay.steerRun(input.runId, {
    ...(input.task === undefined ? {} : { task: input.task }),
    ...(input.content === undefined ? {} : { content: input.content }),
    ...(input.idempotencyKey === undefined ? {} : { idempotencyKey: input.idempotencyKey }),
  }, clientPrincipalId)))

  server.registerTool('get_run', {
    title: 'Read a Harness run', description: 'Reconcile and return one run snapshot.', inputSchema: { runId: id }, annotations: readOnly,
  }, guarded(input => relay.getRun(input.runId)))

  server.registerTool('get_run_summary', {
    title: 'Get a structured Harness run summary',
    description: 'Project the current durable run snapshot into stable status, model, permission, elapsed time, and next-action fields.',
    inputSchema: { runId: id },
    outputSchema: runSummaryOutputSchema,
    annotations: readOnly,
  }, guarded(async input => {
    const snapshot = await relay.getRun(input.runId)
    const attention = snapshot.attentionReason === undefined ? undefined : {
      reason: snapshot.attentionReason === 'run_stalled' ? AttentionReason.RunStalled : AttentionReason.PermissionRestoreFailed,
      ...(snapshot.error === null ? {} : { detail: snapshot.error }),
    }
    return monitoring.project(snapshot, attention === undefined ? {} : { attention })
  }))

  server.registerTool('read_notifications', {
    title: 'Replay retained DSH Relay notifications',
    description: 'Read the bounded in-process notification projection after a cursor; cursor gaps return explicit resynchronization metadata.',
    inputSchema: { cursor: z.string().regex(/^(0|[1-9]\d*)$/).optional() },
    outputSchema: notificationPageOutputSchema,
    annotations: readOnly,
  }, guarded(async input => monitoring.readNotifications(input.cursor)))

  server.registerTool('status_run', {
    title: 'Get Harness run status', description: 'Reconcile one run from durable Harness events and return its current status.', inputSchema: { runId: id }, annotations: readOnly,
  }, guarded(input => relay.getRun(input.runId)))

  server.registerTool('open_run', {
    title: 'Open a Harness run',
    description: 'Open the native Harness Web session in the operating system default browser. This does not claim that the page renderer has completed loading.',
    inputSchema: { runId: id }, annotations: mutable(true),
  }, guarded(input => relay.openRun(input.runId)))

  server.registerTool('wait_run', {
    title: 'Wait for Harness progress', description: 'Poll durable Host history for at most 30 seconds and return the latest run snapshot.',
    inputSchema: { runId: id, timeoutMs: z.number().int().min(0).max(30_000).default(30_000) }, annotations: readOnly,
  }, guarded(input => relay.waitRun(input.runId, input.timeoutMs)))

  server.registerTool('list_runs', {
    title: 'List Harness runs', description: 'Reconcile and list runs restored from durable relay state.', inputSchema: { serviceId: id.optional() }, annotations: readOnly,
  }, guarded(async input => ({ runs: await relay.listRuns(input.serviceId) })))

  server.registerTool('get_operation', {
    title: 'Read a relay operation',
    description: 'Read the durable idempotent operation record for a start, reply, steer, or cancel request.',
    inputSchema: { operationId: id }, annotations: readOnly,
  }, guarded(async input => ({ operation: await relay.getOperation(input.operationId) })))

  server.registerTool('reconcile_operation', {
    title: 'Reconcile a relay operation',
    description: 'Compare an uncertain operation with durable Harness events without submitting a duplicate request.',
    inputSchema: { operationId: id }, annotations: readOnly,
  }, guarded(input => relay.reconcileOperation(input.operationId)))

  server.registerTool('reconcile_permissions', {
    title: 'Restore a Harness session permission lease',
    description: 'Retry restoration of the previous native permission preset for a session that requires attention.',
    inputSchema: { sessionId: z.string().min(1) }, annotations: mutable(true),
  }, guarded(input => relay.reconcilePermissions(input.sessionId)))

  server.registerTool('reply_run', {
    title: 'Continue a Harness session',
    description: 'Submit a new queued turn to the completed run session, optionally selecting a different model, and track it as a new run.',
    inputSchema: {
      runId: id,
      task: z.string().min(1).max(config.maxTaskCharacters).optional(),
      content: z.array(promptPart(config.maxTaskCharacters)).min(1).optional(),
      provider: z.string().trim().min(1).optional(),
      model: z.string().trim().min(1).optional(),
      reasoningEffort: z.string().trim().min(1).optional(),
      permissionPreset: z.enum(['read-only', 'workspace-write', 'danger-full-access']).optional(),
      confirmedDangerousPermission: z.boolean().default(false),
      idempotencyKey,
      openBrowser: z.boolean().default(false),
    },
    annotations: runAction,
  }, guarded(input => relay.replyRun(input.runId, {
    openBrowser: input.openBrowser,
    ...(input.permissionPreset === undefined ? {} : { permissionPreset: input.permissionPreset }),
    ...(input.task === undefined ? {} : { task: input.task }),
    ...(input.content === undefined ? {} : { content: input.content }),
    ...(input.provider === undefined ? {} : { provider: input.provider }),
    ...(input.model === undefined ? {} : { model: input.model }),
    ...(input.reasoningEffort === undefined ? {} : { reasoningEffort: input.reasoningEffort }),
    ...(input.confirmedDangerousPermission ? { confirmedDangerousPermission: true } : {}),
    ...(input.idempotencyKey === undefined ? {} : { idempotencyKey: input.idempotencyKey }),
  }, clientPrincipalId)))

  server.registerTool('cancel_run', {
    title: 'Cancel a Harness run', description: 'Request cancellation through the public Host API.', inputSchema: { runId: id, idempotencyKey }, annotations: destructive,
  }, guarded(input => relay.cancelRun(input.runId, input.idempotencyKey, clientPrincipalId)))

  return server
}

const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const
const destructive = { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false } as const
const runAction = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true } as const
const reviewAction = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true } as const
function mutable(idempotent: boolean) { return { readOnlyHint: false, destructiveHint: false, idempotentHint: idempotent, openWorldHint: true } as const }

function promptPart(maxCharacters: number) {
  return z.discriminatedUnion('type', [
    z.object({ type: z.literal('text'), text: z.string().max(maxCharacters) }),
    z.object({ type: z.literal('image'), mediaType: z.enum(['image/png', 'image/jpeg', 'image/webp', 'image/gif']), data: z.string().min(1), name: z.string().optional() }),
  ])
}

const setupInputSchema = {
  client: z.enum(['codex', 'claude', 'cursor', 'opencode']),
  scope: z.enum(['local', 'project', 'user']),
  platform: z.enum(['win32', 'darwin', 'linux']),
  homeDirectory: z.string().min(1),
  workspaceDirectory: z.string().min(1).optional(),
      nodeExecutable: z.string().min(1),
      relayEntry: z.string().min(1),
      endpointDescriptor: z.string().min(1),
      environment: z.record(z.string(), z.string()).optional(),
} as const

const doctorFactsSchema = z.object({
  nodeExecutableExists: z.boolean().optional(),
  relayEntryExists: z.boolean().optional(),
  configParentWritable: z.boolean().optional(),
  brokerReachable: z.boolean().optional(),
  hostReachable: z.boolean().optional(),
  workspaceExists: z.boolean().optional(),
  modelAvailable: z.boolean().optional(),
  permissionAvailable: z.boolean().optional(),
  targetWebProfile: z.boolean().optional(),
  bundleInstalled: z.boolean().optional(),
  httpRouteReachable: z.boolean().optional(),
  tokenFileSecure: z.boolean().optional(),
  authorityOwnerHealthy: z.boolean().optional(),
  recursiveConfigurationAbsent: z.boolean().optional(),
})

const issueOutputSchema = z.object({
  code: z.string(),
  severity: z.enum(['info', 'warning', 'error']),
  message: z.string(),
  remediation: z.string().optional(),
})

const setupPlanOutputSchema = {
  ready: z.boolean(),
  writeAuthorized: z.literal(false),
  detection: z.record(z.string(), z.unknown()),
  launcher: z.record(z.string(), z.unknown()).optional(),
  patch: z.record(z.string(), z.unknown()).optional(),
  issues: z.array(issueOutputSchema),
  actions: z.array(z.record(z.string(), z.unknown())),
} as const

const setupDoctorOutputSchema = {
  schemaVersion: z.literal(1),
  client: z.enum(['codex', 'claude', 'cursor', 'opencode']),
  scope: z.enum(['local', 'project', 'user']),
  status: z.enum(['healthy', 'degraded', 'blocked']),
  planReady: z.boolean(),
  checks: z.array(z.record(z.string(), z.unknown())),
  plan: z.object(setupPlanOutputSchema),
} as const

const runSummaryOutputSchema = {
  runId: z.string(),
  status: z.enum(['running', 'needs_attention', 'succeeded', 'incomplete', 'failed', 'cancelled', 'unknown']),
  attention: z.record(z.string(), z.unknown()).optional(),
  provider: z.string().optional(),
  model: z.string().optional(),
  reasoningEffort: z.string().optional(),
  permissionMode: z.enum(['read-only', 'workspace-write', 'danger-full-access']),
  startedAt: z.string(),
  updatedAt: z.string(),
  finishedAt: z.string().optional(),
  elapsedMs: z.number().nonnegative().optional(),
  progress: z.record(z.string(), z.unknown()).optional(),
  usage: z.record(z.string(), z.unknown()).optional(),
  nextAction: z.enum(['wait', 'reply', 'cancel', 'open-session', 'none']),
} as const

const notificationPageOutputSchema = {
  notifications: z.array(z.object({
    runId: z.string(),
    kind: z.enum(['run-summary', 'attention', 'progress', 'log']),
    payload: z.record(z.string(), z.unknown()),
    eventId: z.string(),
    cursor: z.string(),
    occurredAt: z.string(),
  })),
  nextCursor: z.string(),
} as const

const workspaceSummaryOutputSchema = z.object({
  workspaceId: z.string(),
  path: z.string(),
  title: z.string(),
  sessionCount: z.number().int().nonnegative(),
})

const listWorkspacesOutputSchema = {
  mode: z.enum(['harness-registry', 'configured-roots']),
  roots: z.array(z.string()),
  workspaces: z.array(workspaceSummaryOutputSchema),
} as const

const workspaceSessionOutputSchema = z.object({
  sessionId: z.string(),
  updatedAt: z.number(),
  running: z.boolean(),
  blank: z.boolean(),
  parentSessionId: z.string().optional(),
  origin: z.literal('subagent').optional(),
  cwd: z.string().optional(),
  agentPreset: z.string().optional(),
  archived: z.boolean(),
})

const listWorkspaceSessionsOutputSchema = {
  workspace: z.object({
    workspaceId: z.string(),
    path: z.string(),
    title: z.string(),
  }),
  sessions: z.array(workspaceSessionOutputSchema),
} as const

function toSetupRequest(input: {
  client: SetupRequest['client']
  scope: SetupRequest['scope']
  platform: SetupRequest['platform']
  homeDirectory: string
  workspaceDirectory?: string | undefined
  nodeExecutable: string
  relayEntry: string
  endpointDescriptor: string
  environment?: Record<string, string> | undefined
}): SetupRequest {
  return {
    client: input.client,
    scope: input.scope,
    platform: input.platform,
    homeDirectory: input.homeDirectory,
    ...(input.workspaceDirectory === undefined ? {} : { workspaceDirectory: input.workspaceDirectory }),
    launcher: {
      platform: input.platform,
      nodeExecutable: input.nodeExecutable,
      relayEntry: input.relayEntry,
      environment: {
        ...input.environment,
        DSH_RELAY_ENDPOINT_DESCRIPTOR: input.endpointDescriptor,
        DSH_RELAY_CLIENT_PRINCIPAL_ID: `${input.client}:${input.scope}`,
      },
    },
  }
}

function result(value: object) {
  const structuredContent = { ...value }
  return { content: [{ type: 'text' as const, text: JSON.stringify(structuredContent) }], structuredContent }
}

function guarded<TInput, TOutput extends object>(operation: (input: TInput) => Promise<TOutput> | TOutput) {
  return async (input: TInput) => {
    try { return result(await operation(input)) }
    catch (error) {
      const structuredContent = error instanceof RelayError
        ? error.toStructuredContent()
        : error instanceof HostRpcError
          ? { code: error.code, message: error.message, retryable: error.retryable, nextAction: error.retryable ? 'status' : 'none' }
        : error instanceof MonitoringError
          ? {
              code: error.code,
              message: error.message,
              retryable: error.code === 'CURSOR_EXPIRED',
              nextAction: error.code === 'CURSOR_EXPIRED' ? 'get_run_summary' : 'none',
              ...error.details,
            }
          : { code: 'INTERNAL_ERROR', message: error instanceof Error ? error.message : String(error), retryable: false, nextAction: 'none' }
      return { content: [{ type: 'text' as const, text: JSON.stringify(structuredContent) }], structuredContent, isError: true }
    }
  }
}
