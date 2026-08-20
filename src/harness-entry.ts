import { unlink } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { InProcessApiClient, toFetchHandler } from '@deepseek-ai/dsh-host-apiproxy'
import type { Context } from '@deepseek-ai/cordis'
import { SessionId, type Session } from '@deepseek-ai/dsh-session'
import Schema from '@deepseek-ai/schemastery'
import {
  AuthorityRegistryFacade,
  RelayEndpointPublisher,
  deriveAuthorityId,
  normalizeHostIdentity,
  type AuthorityOwnerLease,
} from './authority/index.js'
import { resolveConfig } from './config.js'
import { EventMonitoringFacade, type EventMonitoringNotice } from './event-monitoring/index.js'
import {
  InProcessDispatchHandler,
  createInProcessHarnessGateway,
  type InProcessApiClientPort,
} from './harness-gateway/index.js'
import {
  createHarnessPlugin,
  preflightHarnessProfile,
  type EmbeddedRelayAdapters,
  type HarnessPluginContext,
} from './harness-plugin/index.js'
import { McpHttpFacade, TokenStoreFacade } from './mcp-http/index.js'
import { createServer } from './mcp-server/index.js'
import { MonitoringFacade } from './monitoring/index.js'
import {
  InProcessPermissionProvider,
  PermissionGatewayFacade,
  type InProcessPermissionPresetPort,
} from './permission-gateway/index.js'
import { RelayFacade } from './relay-broker/index.js'
import {
  RelayRuntimeFacade,
  RelayRuntimePathError,
  type RelayRuntimePaths,
  type RelayStatusError,
  type RelayStatusWriteInput,
} from './relay-runtime/index.js'

class RelayStartupError extends Error {
  readonly name = 'RelayStartupError'

  constructor(
    readonly code: string,
    message: string,
    readonly remediation: string,
    options?: ErrorOptions,
  ) {
    super(message, options)
  }
}

interface NativeSessionStore {
  get(id: ReturnType<typeof SessionId>): Session | undefined
}

interface NativeWebServer {
  readonly host: '127.0.0.1' | '0.0.0.0'
  readonly port: number
  register(route: {
    kind: 'exact'
    path: string
    handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>
  }): () => void
}

interface NativePermissionPresets extends InProcessPermissionPresetPort<Session, Session['events'][number]> {}

type NativeHarnessContext = Context & HarnessPluginContext & {
  apiProxy: Parameters<typeof toFetchHandler>[0]
  webServer: NativeWebServer
  sessions: NativeSessionStore
  permissionPresets: NativePermissionPresets
}

const plugin = createHarnessPlugin<NativeHarnessContext>({
  schema: Schema,
  createAdapters(ctx): EmbeddedRelayAdapters {
    const permissionProvider = new InProcessPermissionProvider(
      sessionId => ctx.sessions.get(SessionId(sessionId)),
      session => session.events,
      ctx.permissionPresets,
    )
    const permissions = new PermissionGatewayFacade(permissionProvider)
    const dispatch = new InProcessDispatchHandler(toFetchHandler(ctx.apiProxy))
    const client = new InProcessApiClient(dispatch)
    const gateway = createInProcessHarnessGateway(client as unknown as InProcessApiClientPort, permissions, dispatch)
    return { gateway, permissions }
  },
  async startAuthority(ctx, config, adapters, options) {
    const runtime = new RelayRuntimeFacade()
    const defaultPaths = runtime.resolve({ mode: 'embedded', env: process.env })
    const profile = defaultPaths.profile
    const hostWebUrl = `http://127.0.0.1:${ctx.webServer.port}/`
    const hostIdentity = normalizeHostIdentity(hostWebUrl)
    const authorityId = deriveAuthorityId('embedded', hostIdentity)
    const instanceId = authorityId
    let paths: RelayRuntimePaths = defaultPaths
    let status = runtime.status(defaultPaths)
    let lease: AuthorityOwnerLease | undefined
    let unregister: (() => void) | undefined
    let eventHandle: { dispose(): Promise<void> } | undefined
    let http: McpHttpFacade | undefined
    try {
      paths = runtime.resolve({
        mode: 'embedded',
        env: process.env,
        hostIdentity,
        ...(config.stateDirectory === undefined ? {} : { stateDirectory: config.stateDirectory }),
        ...(config.tokenFile === undefined ? {} : { tokenFile: config.tokenFile }),
      })
      status = runtime.status(paths)
      await runtime.prepare(paths)
      await writeRelayStatus(status, lifecycleStatus(paths, authorityId, instanceId, hostIdentity, 'starting', null, null))

      const preflight = preflightHarnessProfile({
        profile,
        availableServices: ['apiProxy', 'webServer', 'sessions', 'permissionPresets'],
      })
      if (!preflight.ready) throw new RelayStartupError(preflight.code, preflight.message, 'Enable the Harness web profile with the required native services and retry.')
      if (ctx.webServer.host !== '127.0.0.1') {
        throw new RelayStartupError(
          'HARNESS_WEB_BIND_HOST_INVALID',
          'DSH Relay embedded MCP requires the Harness WebServer to bind 127.0.0.1',
          'Configure the Harness WebServer to bind loopback only, then retry the web profile.',
        )
      }

      lease = await new AuthorityRegistryFacade().acquireWithRetry({
        authorityId,
        mode: 'embedded',
        hostIdentity,
        instanceId,
        recoverStale: true,
      }, { signal: options.signal })
      await writeRelayStatus(status, lifecycleStatus(paths, authorityId, instanceId, hostIdentity, 'starting', lease.record, null))

      const loadedToken = await new TokenStoreFacade().loadOrCreate({
        tokenFile: paths.tokenFile,
        environmentVariable: 'DSH_RELAY_TOKEN',
      })
      const relayConfig = resolveConfig({
        ...process.env,
        DSH_RELAY_HOST_URL: hostWebUrl,
        DSH_RELAY_STATE_FILE: paths.stateFile,
        DSH_RELAY_CLIENT_PRINCIPAL_ID: 'embedded-authority',
      })
      const relay = new RelayFacade(relayConfig, fetch, adapters.gateway, {
        stateStore: { authority: { authorityId, mode: 'embedded', hostIdentity, instanceId } },
        permissionGateway: adapters.permissions,
      })
      const monitoring = new MonitoringFacade()
      let eventMonitoring: EventMonitoringFacade
      eventMonitoring = new EventMonitoringFacade(adapters.gateway, async notice => {
        await projectEventNotice(notice, relay, monitoring, eventMonitoring)
      })
      eventHandle = eventMonitoring.start()
      http = new McpHttpFacade({
        token: loadedToken.token,
        allowedHosts: [`127.0.0.1:${ctx.webServer.port}`, `localhost:${ctx.webServer.port}`],
        allowedOrigins: [hostWebUrl.slice(0, -1), `http://localhost:${ctx.webServer.port}`],
        maxBodyBytes: config.requestBodyLimitBytes,
        maxConcurrent: config.maxConcurrency,
        requestsPerMinute: config.rateLimitPerMinute,
        drainTimeoutMs: config.drainTimeoutMs,
      }, principal => createServer(relay, relayConfig, monitoring, principal))
      unregister = ctx.webServer.register({
        kind: 'exact',
        path: config.route,
        handler: (req, res) => http?.handle(req, res) ?? Promise.resolve(),
      })
      await new RelayEndpointPublisher(paths.endpointDescriptorFile).publish({
        authorityId,
        mode: 'embedded',
        mcpUrl: new URL(config.route, hostWebUrl).href,
        tokenFilePath: loadedToken.tokenFile,
        hostWebUrl,
        ownerEpoch: lease.record.epoch,
      })
      await verifyPostHandshake(
        new URL(config.route, hostWebUrl).href,
        loadedToken.token,
        'embedded-authority',
      )
      await writeRelayStatus(status, lifecycleStatus(paths, authorityId, instanceId, hostIdentity, 'ready', lease.record, null))
      return {
        async disposeInfrastructure({ drainTimeoutMs: _drainTimeoutMs }) {
          let cleanupError: unknown
          try {
            await cleanupEmbeddedInfrastructure({
              unregister,
              eventHandle,
              http,
              endpointDescriptorFile: paths.endpointDescriptorFile,
              removeEndpoint: true,
              lease: undefined,
            })
          } catch (error) {
            cleanupError = error
          }
          await tryWriteRelayStatus(status, lifecycleStatus(paths, authorityId, instanceId, hostIdentity, 'stopped', lease?.record ?? null, null))
          try {
            await lease?.release()
          } catch (error) {
            cleanupError ??= error
          }
          if (cleanupError !== undefined) throw cleanupError
        },
      }
    } catch (error) {
      await tryWriteRelayStatus(status, lifecycleStatus(paths, authorityId, instanceId, hostIdentity, 'failed', lease?.record ?? null, toRelayStatusError(error)))
      await cleanupEmbeddedInfrastructure({
        unregister,
        eventHandle,
        http,
        endpointDescriptorFile: paths.endpointDescriptorFile,
        removeEndpoint: lease !== undefined,
        lease,
      }).catch(() => {})
      throw error
    }
  },
})

function lifecycleStatus(
  paths: RelayRuntimePaths,
  authorityId: string,
  instanceId: string,
  hostIdentity: string,
  state: RelayStatusWriteInput['state'],
  owner: AuthorityOwnerLease['record'] | null,
  lastError: RelayStatusError | null,
): RelayStatusWriteInput {
  return {
    state,
    authorityId,
    mode: 'embedded',
    instanceId,
    ownerPid: owner?.processId ?? null,
    processStartedAt: owner?.processStartedAt ?? null,
    ownerEpoch: owner?.epoch ?? null,
    hostIdentity,
    profile: paths.profile,
    dshHome: paths.dshHome,
    lastError,
  }
}

async function writeRelayStatus(status: { write(input: RelayStatusWriteInput): Promise<unknown> }, input: RelayStatusWriteInput): Promise<void> {
  await status.write(input)
}

async function tryWriteRelayStatus(status: { write(input: RelayStatusWriteInput): Promise<unknown> } | undefined, input: RelayStatusWriteInput): Promise<void> {
  if (status === undefined) return
  try {
    await status.write(input)
  } catch {
    // A failed status write must never mask the startup error or block cleanup.
  }
}

function toRelayStatusError(error: unknown): RelayStatusError {
  const code = typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
    ? error.code
    : 'RELAY_START_FAILED'
  const remediation = error instanceof RelayRuntimePathError
    ? error.remediation
    : error instanceof RelayStartupError
      ? error.remediation
      : 'Inspect the Relay status and Harness profile configuration, then retry the web profile.'
  const message = error instanceof Error ? error.message : String(error)
  return { code, message, remediation }
}

interface CleanupEmbeddedInfrastructureInput {
  unregister: (() => void) | undefined
  eventHandle: { dispose(): Promise<void> } | undefined
  http: McpHttpFacade | undefined
  endpointDescriptorFile: string
  removeEndpoint: boolean
  lease: AuthorityOwnerLease | undefined
}

async function cleanupEmbeddedInfrastructure(input: CleanupEmbeddedInfrastructureInput): Promise<void> {
  let firstError: unknown
  const attempt = async (operation: () => void | Promise<void>): Promise<void> => {
    try {
      await operation()
    } catch (error) {
      firstError ??= error
    }
  }
  if (input.unregister !== undefined) await attempt(input.unregister)
  if (input.eventHandle !== undefined) await attempt(() => input.eventHandle!.dispose())
  if (input.http !== undefined) await attempt(() => input.http!.drain())
  if (input.removeEndpoint) await attempt(() => unlink(input.endpointDescriptorFile).catch(ignoreMissing))
  if (input.lease !== undefined) await attempt(() => input.lease!.release().then(() => undefined))
  if (firstError !== undefined) throw firstError
}

async function verifyPostHandshake(url: string, token: string, principal: string): Promise<void> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 5_000)
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        'mcp-protocol-version': '2025-03-26',
        'x-dsh-relay-principal': principal,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 'relay-startup-handshake',
        method: 'initialize',
        params: {
          protocolVersion: '2025-03-26',
          capabilities: {},
          clientInfo: { name: 'dsh-relay-startup', version: '1.0.0' },
        },
      }),
      signal: controller.signal,
    })
    if (!response.ok) {
      throw new RelayStartupError(
        'RELAY_POST_HANDSHAKE_FAILED',
        `Relay POST handshake returned HTTP ${response.status}`,
        'Verify that the Harness WebServer route is registered and accepts authenticated loopback POST requests.',
      )
    }
    await response.arrayBuffer()
  } catch (error) {
    if (error instanceof RelayStartupError) throw error
    throw new RelayStartupError(
      'RELAY_POST_HANDSHAKE_FAILED',
      `Relay POST handshake failed: ${error instanceof Error ? error.message : String(error)}`,
      'Verify that the Harness WebServer is listening on loopback and the Relay route is reachable.',
      { cause: error },
    )
  } finally {
    clearTimeout(timeout)
  }
}

async function projectEventNotice(
  notice: EventMonitoringNotice,
  relay: RelayFacade,
  monitoring: MonitoringFacade,
  eventMonitoring: EventMonitoringFacade,
): Promise<void> {
  const runs = await relay.listRuns()
  const selected = 'sessionId' in notice
    ? runs.filter(run => run.sessionId === notice.sessionId)
    : runs.filter(run => run.status === 'running' || run.status === 'unknown')
  if (notice.kind === 'history-reconcile') {
    for (const run of selected) {
      monitoring.publishNotification({ runId: run.runId, kind: 'run-summary', payload: monitoring.project(run) as unknown as Record<string, unknown> })
    }
    const durableLastSeq = selected.reduce((highest, run) => Math.max(highest, run.lastEventSeq), 0)
    eventMonitoring.confirmHistory(notice.sessionId, durableLastSeq)
    return
  }
  if (notice.kind === 'session-stream-rebased') return
  const kind = notice.kind === 'attention-required' || notice.kind === 'attention-resolved' ? 'attention' : 'log'
  for (const run of selected) {
    monitoring.publishNotification({ runId: run.runId, kind, payload: { ...notice } })
  }
}

function ignoreMissing(error: unknown): void {
  if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') return
  throw error
}

export const name = plugin.name
export const inject = plugin.inject
export const Config = plugin.Config
export const apply = plugin.apply
