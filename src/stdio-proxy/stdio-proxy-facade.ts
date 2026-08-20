import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { ProxyDiagnosticsFacade, type ProxyInspection } from './proxy-diagnostics-facade.js'
import type { ProxyDoctorReport, ProxyRouteFailure, StdioProxyConfig } from './types.js'

const principalPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/u
const relayVersion = typeof __DSH_RELAY_VERSION__ === 'string' ? __DSH_RELAY_VERSION__ : 'development'
const doctorTool = {
  name: 'doctor',
  title: 'Diagnose Harness Relay MCP',
  description: 'Inspect the local Relay status, endpoint, token readability, and remote route without exposing credentials.',
  inputSchema: { type: 'object' as const, additionalProperties: false },
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
}

type RemoteTools = Awaited<ReturnType<Client['listTools']>>['tools']

/** Local-first MCP facade that keeps diagnostics available across embedded authority restarts. */
export class StdioProxyFacade {
  private readonly local = new Server(
    { name: 'dsh-relay-proxy', version: relayVersion },
    {
      capabilities: { tools: { listChanged: true } },
      instructions: 'Local-first stdio proxy to the embedded Harness Relay authority. Run doctor when only one tool is listed.',
    },
  )
  private readonly diagnostics: ProxyDiagnosticsFacade
  private remote: Client | null = null
  private remoteAuthorityKey: string | null = null
  private lastError: ProxyRouteFailure | null = null
  private connecting: Promise<boolean> | null = null
  private connected = false

  constructor(private readonly config: StdioProxyConfig) {
    if (!principalPattern.test(config.clientPrincipalId)) throw new Error('invalid DSH Relay client principal')
    this.diagnostics = new ProxyDiagnosticsFacade(config.descriptorFile, config.statusFile)
    this.local.setRequestHandler(ListToolsRequestSchema, request => this.listTools(request.params?.cursor))
    this.local.setRequestHandler(CallToolRequestSchema, request => this.callTool(request.params.name, request.params.arguments))
  }

  async connect(localTransport: Transport): Promise<void> {
    if (this.connected) throw new Error('DSH Relay stdio proxy is already connected')
    await this.local.connect(localTransport)
    this.connected = true
    await this.ensureRemote()
  }

  async close(): Promise<void> {
    const remote = this.remote
    this.remote = null
    this.remoteAuthorityKey = null
    await Promise.allSettled([this.local.close(), remote?.close()])
    this.connected = false
  }

  private async listTools(cursor?: string): Promise<{ tools: RemoteTools; nextCursor?: string }> {
    const ready = await this.ensureRemote()
    if (!ready) return { tools: cursor === undefined ? [doctorTool] : [] }
    const remote = this.remote
    if (remote === null) return { tools: cursor === undefined ? [doctorTool] : [] }
    try {
      const page = await remote.listTools(cursor === undefined ? undefined : { cursor }, { timeout: this.config.requestTimeoutMs })
      this.lastError = null
      return {
        tools: cursor === undefined
          ? [doctorTool, ...page.tools.filter(tool => tool.name !== doctorTool.name)]
          : page.tools.filter(tool => tool.name !== doctorTool.name),
        ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
      }
    } catch (error) {
      await this.invalidateRemote(this.diagnostics.remoteFailure(error))
      return { tools: cursor === undefined ? [doctorTool] : [] }
    }
  }

  private async callTool(name: string, args: Record<string, unknown> | undefined): Promise<object> {
    if (name === doctorTool.name) {
      await this.ensureRemote()
      const report = await this.diagnostics.doctor(relayVersion, this.remote !== null, this.lastError)
      return doctorResult(report)
    }
    if (!await this.ensureRemote()) return unavailableResult(this.requireFailure())
    const remote = this.remote
    if (remote === null) return unavailableResult(this.requireFailure())
    try {
      return await remote.callTool(
        { name, ...(args === undefined ? {} : { arguments: args }) },
        undefined,
        { timeout: this.config.requestTimeoutMs },
      )
    } catch (error) {
      const routeFailure = this.diagnostics.remoteFailure(error)
      await this.invalidateRemote(routeFailure)
      return unavailableResult(routeFailure)
    }
  }

  private ensureRemote(): Promise<boolean> {
    if (this.connecting !== null) return this.connecting
    this.connecting = this.refreshRemote().finally(() => { this.connecting = null })
    return this.connecting
  }

  private async refreshRemote(): Promise<boolean> {
    const inspected = await this.diagnostics.inspect()
    if (inspected.failure !== null) {
      if (this.remote === null) this.lastError = inspected.failure
      else await this.invalidateRemote(inspected.failure)
      return false
    }
    const authorityKey = inspected.descriptor === null ? null : descriptorKey(inspected.descriptor)
    if (this.remote !== null && this.remoteAuthorityKey === authorityKey) return true
    if (this.remote !== null) {
      await this.invalidateRemote({
        code: 'RELAY_ROUTE_UNAVAILABLE',
        reasonCode: 'STALE_ENDPOINT_DESCRIPTOR',
        message: 'Embedded Relay authority lifecycle changed; reconnecting to the published endpoint.',
        retryable: true,
        remediation: 'Retry after Relay reconnects to the new authority epoch.',
      })
    }
    return this.connectRemote(inspected)
  }

  private async connectRemote(inspected: ProxyInspection): Promise<boolean> {
    if (inspected.descriptor === null || inspected.token === null) return false
    const candidate = new Client({ name: 'dsh-relay-proxy', version: relayVersion })
    const remoteTransport = new StreamableHTTPClientTransport(new URL(inspected.descriptor.mcpUrl), {
      requestInit: {
        headers: {
          authorization: `Bearer ${inspected.token}`,
          'x-dsh-relay-principal': this.config.clientPrincipalId,
        },
      },
    })
    try {
      await candidate.connect(remoteTransport as unknown as Transport)
      const page = await candidate.listTools(undefined, { timeout: this.config.requestTimeoutMs })
      const becameReady = this.remote === null
      this.remote = candidate
      this.remoteAuthorityKey = descriptorKey(inspected.descriptor)
      this.lastError = null
      if (becameReady) this.notifyToolsChanged()
      return true
    } catch (error) {
      await candidate.close().catch(() => undefined)
      this.lastError = this.diagnostics.remoteFailure(error)
      return false
    }
  }

  private async invalidateRemote(routeFailure: ProxyRouteFailure): Promise<void> {
    const remote = this.remote
    const becameUnavailable = remote !== null
    this.remote = null
    this.remoteAuthorityKey = null
    this.lastError = routeFailure
    await remote?.close().catch(() => undefined)
    if (becameUnavailable) this.notifyToolsChanged()
  }

  private notifyToolsChanged(): void {
    if (!this.connected) return
    void this.local.sendToolListChanged().catch(() => undefined)
  }

  private requireFailure(): ProxyRouteFailure {
    return this.lastError ?? {
      code: 'RELAY_ROUTE_UNAVAILABLE',
      reasonCode: 'REMOTE_UNAVAILABLE',
      message: 'Embedded Relay route is unavailable.',
      retryable: true,
      remediation: 'Run doctor and retry after the Harness web profile reaches ready state.',
    }
  }
}

function doctorResult(report: ProxyDoctorReport): object {
  return {
    content: [{ type: 'text', text: JSON.stringify(report) }],
    structuredContent: report,
    isError: false,
  }
}

function unavailableResult(routeFailure: ProxyRouteFailure): object {
  return {
    content: [{ type: 'text', text: `${routeFailure.code}: ${routeFailure.reasonCode}: ${routeFailure.message}` }],
    structuredContent: routeFailure,
    isError: true,
  }
}

function descriptorKey(descriptor: ProxyInspection['descriptor']): string | null {
  if (descriptor === null) return null
  return `${descriptor.authorityId}\0${descriptor.ownerEpoch}\0${descriptor.mcpUrl}`
}
