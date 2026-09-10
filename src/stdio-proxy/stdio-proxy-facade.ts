import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import { CallToolRequestSchema, ErrorCode, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { createProductToolCatalog } from '../mcp-server/index.js'
import { HarnessHostAutostartFacade } from './host-autostart-facade.js'
import { ProxyDiagnosticsFacade, type ProxyInspection } from './proxy-diagnostics-facade.js'
import type { ProxyDoctorReport, ProxyRouteFailure, StdioProxyConfig, StdioProxyDependencies } from './types.js'

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
  private readonly hostAutostart: NonNullable<StdioProxyDependencies['hostAutostart']> | null
  private remote: Client | null = null
  private remoteAuthorityKey: string | null = null
  private lastError: ProxyRouteFailure | null = null
  private connecting: Promise<boolean> | null = null
  private readonly productTools: Promise<RemoteTools>
  private connected = false

  constructor(private readonly config: StdioProxyConfig, dependencies: StdioProxyDependencies = {}) {
    if (!principalPattern.test(config.clientPrincipalId)) throw new Error('invalid DSH Relay client principal')
    this.productTools = createProductToolCatalog(config.maxTaskCharacters)
    this.diagnostics = new ProxyDiagnosticsFacade(config.descriptorFile, config.statusFile, dependencies)
    this.hostAutostart = dependencies.hostAutostart
      ?? (config.autoStart === true
        ? new HarnessHostAutostartFacade(
          config.descriptorFile,
          this.diagnostics.statusFile,
          config.autoStartTimeoutMs ?? 120_000,
        )
        : null)
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
    const remote = this.remote
    if (remote === null) {
      this.beginRemoteRefresh()
      return { tools: cursor === undefined ? await this.localToolCatalog() : [] }
    }
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
      return { tools: cursor === undefined ? await this.localToolCatalog() : [] }
    }
  }

  private async callTool(name: string, args: Record<string, unknown> | undefined): Promise<object> {
    if (name === doctorTool.name) {
      if (this.remote === null) this.beginRemoteRefresh()
      const report = await this.diagnostics.doctor(relayVersion, this.remote !== null, this.lastError)
      return doctorResult(report)
    }
    if (!await this.ensureRemote()) return this.unavailableResult(name, this.requireFailure())
    const remote = this.remote
    if (remote === null) return this.unavailableResult(name, this.requireFailure())
    try {
      return await remote.callTool(
        { name, ...(args === undefined ? {} : { arguments: args }) },
        undefined,
        { timeout: this.config.requestTimeoutMs },
      )
    } catch (error) {
      if (isRequestTimeout(error)) return this.requestTimeoutResult(name, this.config.requestTimeoutMs)
      const routeFailure = this.diagnostics.remoteFailure(error)
      await this.invalidateRemote(routeFailure)
      return this.unavailableResult(name, routeFailure)
    }
  }

  private ensureRemote(): Promise<boolean> {
    if (this.connecting !== null) return this.connecting
    this.connecting = this.refreshRemote().finally(() => { this.connecting = null })
    return this.connecting
  }

  private beginRemoteRefresh(): void {
    void this.ensureRemote().catch(error => {
      this.lastError = this.diagnostics.remoteFailure(error)
    })
  }

  private async refreshRemote(): Promise<boolean> {
    let inspected = await this.diagnostics.inspect()
    if (inspected.failure !== null && this.hostAutostart !== null) {
      inspected = await this.hostAutostart.recover(inspected, () => this.diagnostics.inspect())
    }
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

  private async localToolCatalog(): Promise<RemoteTools> {
    const productTools = await this.productTools
    return [doctorTool, ...productTools.filter(tool => tool.name !== doctorTool.name)]
  }

  private async supportsStructuredError(toolName: string): Promise<boolean> {
    const tool = (await this.productTools).find(candidate => candidate.name === toolName)
    return tool?.outputSchema === undefined
  }

  private async unavailableResult(toolName: string, routeFailure: ProxyRouteFailure): Promise<object> {
    return unavailableResult(routeFailure, await this.supportsStructuredError(toolName))
  }

  private async requestTimeoutResult(toolName: string, timeoutMs: number): Promise<object> {
    return requestTimeoutResult(toolName, timeoutMs, await this.supportsStructuredError(toolName))
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

function unavailableResult(routeFailure: ProxyRouteFailure, structuredErrors: boolean): object {
  return {
    content: [{ type: 'text', text: `${routeFailure.code}: ${routeFailure.reasonCode}: ${routeFailure.message}` }],
    ...(structuredErrors ? { structuredContent: routeFailure } : {}),
    isError: true,
  }
}

function requestTimeoutResult(toolName: string, timeoutMs: number, structuredErrors: boolean): object {
  const timeout = {
    code: 'RELAY_REQUEST_TIMEOUT',
    message: `Remote Relay tool ${JSON.stringify(toolName)} timed out after ${timeoutMs} ms.`,
    retryable: true,
    outcome: 'unknown',
    nextAction: 'inspect_or_retry_idempotently',
  }
  return {
    content: [{ type: 'text', text: `${timeout.code}: ${timeout.message}` }],
    ...(structuredErrors ? { structuredContent: timeout } : {}),
    isError: true,
  }
}

function isRequestTimeout(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === ErrorCode.RequestTimeout
}

function descriptorKey(descriptor: ProxyInspection['descriptor']): string | null {
  if (descriptor === null) return null
  return `${descriptor.authorityId}\0${descriptor.ownerEpoch}\0${descriptor.mcpUrl}`
}
