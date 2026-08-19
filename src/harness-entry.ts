import { unlink } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { join, resolve } from 'node:path'
import { InProcessApiClient, toFetchHandler } from '@deepseek-ai/dsh-host-apiproxy'
import type { Context } from '@deepseek-ai/cordis'
import { SessionId, type Session } from '@deepseek-ai/dsh-session'
import Schema from '@deepseek-ai/schemastery'
import {
  AuthorityRegistryFacade,
  RelayEndpointPublisher,
  deriveAuthorityId,
  normalizeHostIdentity,
  resolveAuthorityStatePaths,
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
  type HarnessPluginConfig,
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
  async startAuthority(ctx, config, adapters) {
    const profile = process.env.DSH_PROFILE ?? 'web'
    const preflight = preflightHarnessProfile({
      profile,
      availableServices: ['apiProxy', 'webServer', 'sessions', 'permissionPresets'],
    })
    if (!preflight.ready) throw new Error(`${preflight.code}: ${preflight.message}`)
    if (ctx.webServer.host !== '127.0.0.1') throw new Error('DSH Relay embedded MCP requires the Harness WebServer to bind 127.0.0.1')
    const hostWebUrl = `http://127.0.0.1:${ctx.webServer.port}/`
    const hostIdentity = normalizeHostIdentity(hostWebUrl)
    const authorityId = deriveAuthorityId('embedded', hostIdentity)
    const instanceId = authorityId
    const paths = resolveEmbeddedPaths(config, hostIdentity, profile)
    const lease = await new AuthorityRegistryFacade().acquire({
      authorityId,
      mode: 'embedded',
      hostIdentity,
      instanceId,
      recoverStale: true,
    })
    try {
      const loadedToken = await new TokenStoreFacade().loadOrCreate({
        tokenFile: config.tokenFile === undefined ? paths.tokenFile : resolve(config.tokenFile),
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
      const eventHandle = eventMonitoring.start()
      const http = new McpHttpFacade({
        token: loadedToken.token,
        allowedHosts: [`127.0.0.1:${ctx.webServer.port}`, `localhost:${ctx.webServer.port}`],
        allowedOrigins: [hostWebUrl.slice(0, -1), `http://localhost:${ctx.webServer.port}`],
        maxBodyBytes: config.requestBodyLimitBytes,
        maxConcurrent: config.maxConcurrency,
        requestsPerMinute: config.rateLimitPerMinute,
        drainTimeoutMs: config.drainTimeoutMs,
      }, principal => createServer(relay, relayConfig, monitoring, principal))
      const unregister = ctx.webServer.register({
        kind: 'exact',
        path: config.route,
        handler: (req, res) => http.handle(req, res),
      })
      await new RelayEndpointPublisher(paths.endpointDescriptorFile).publish({
        authorityId,
        mode: 'embedded',
        mcpUrl: new URL(config.route, hostWebUrl).href,
        tokenFilePath: loadedToken.tokenFile,
        hostWebUrl,
        ownerEpoch: lease.record.epoch,
      })
      return {
        async disposeInfrastructure({ drainTimeoutMs: _drainTimeoutMs }) {
          unregister()
          await eventHandle.dispose()
          await http.drain()
          await unlink(paths.endpointDescriptorFile).catch(ignoreMissing)
          await lease.release()
        },
      }
    } catch (error) {
      await lease.release()
      throw error
    }
  },
})

function resolveEmbeddedPaths(config: HarnessPluginConfig, hostIdentity: string, profile: string) {
  const dshHome = process.env.DSH_HOME
  if (dshHome === undefined || dshHome.trim() === '') throw new Error('DSH_HOME is required for embedded DSH Relay state')
  const standard = resolveAuthorityStatePaths({
    mode: 'embedded',
    hostIdentity,
    dshHome,
    profile,
  })
  if (config.stateDirectory === undefined) return standard
  const stateDirectory = resolve(config.stateDirectory)
  return {
    stateDirectory,
    stateFile: join(stateDirectory, 'state.json'),
    endpointDescriptorFile: join(stateDirectory, 'relay-endpoint.json'),
    tokenFile: join(stateDirectory, 'relay-token'),
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
