import type { ModelSelection, PermissionPreset, PromptPart } from '../types.js'
import type { PermissionGateway } from '../permission-gateway/index.js'
import { HostRpcError, inProcessTransportError, isTransientHostCode } from './host-errors.js'
import type { InProcessDispatchHandler } from './in-process-dispatch-handler.js'
import type {
  BeforeDispatch,
  GatewayHostFrame,
  GatewayMuxFrame,
  GatewayStreamEnvelope,
  HarnessGatewayProvider,
  HistoryPage,
  HistoryRequest,
  PromptAcceptance,
  QueueUpdateRequest,
  SessionCreateRequest,
  SessionCreateResult,
  SessionSummary,
  SettingsDescription,
  WorkspaceCatalog,
  WorkspaceView,
} from './types.js'

interface InProcessFailure {
  code: string
  message: string
  details?: unknown
}

export type InProcessRpcResponse<T> = {
  rpcId: string
  result: { ok: true; value: T } | { ok: false; error: InProcessFailure }
}

interface UnaryMethod<P, V> {
  (payload: P, signal?: AbortSignal): Promise<InProcessRpcResponse<V>>
}

/** Narrow structural view of Harness's official IApiClient used by Relay. */
export interface InProcessApiClientPort {
  sessions: {
    list: UnaryMethod<Record<string, never>, { items: SessionSummary[] }>
    create: UnaryMethod<SessionCreateRequest, SessionCreateResult>
    history: UnaryMethod<HistoryRequest, HistoryPage>
    selectModel: UnaryMethod<{ sessionId: string } & ModelSelection, { selected: ModelSelection }>
    prompt: UnaryMethod<{
      sessionId: string
      mode: 'queue' | 'steer'
      content: PromptPart[]
    }, { accepted: true; messageId?: string }>
    updateQueue: UnaryMethod<QueueUpdateRequest, { accepted: true }>
    cancel: UnaryMethod<{ sessionId: string }, { accepted: true }>
  }
  workspace: {
    list: UnaryMethod<Record<string, never>, WorkspaceCatalog>
    create: UnaryMethod<{ path: string }, { workspace: WorkspaceView; created?: boolean }>
  }
  host: {
    describe: UnaryMethod<Record<string, never>, Record<string, unknown>>
    openPath: UnaryMethod<{ path: string }, { opened: true }>
  }
  settings: {
    describe: UnaryMethod<Record<string, never>, SettingsDescription>
    replace: UnaryMethod<{
      ns: string
      section: Record<string, unknown>
      expectedRevision: number
    }, unknown>
    mutate: UnaryMethod<{
      ns: string
      ops: Array<Record<string, unknown>>
      expectedRevision: number
    }, unknown>
  }
  llm: {
    models: UnaryMethod<Record<string, never>, Record<string, unknown>>
  }
  agentPresets: {
    list: UnaryMethod<Record<string, never>, Record<string, unknown>>
  }
  events: {
    mux(
      payload: { since?: Record<string, number> },
      signal: AbortSignal,
      onOpen?: () => void,
    ): AsyncIterable<GatewayStreamEnvelope<GatewayMuxFrame>>
    host(
      payload: Record<string, never>,
      signal: AbortSignal,
      onOpen?: () => void,
    ): AsyncIterable<GatewayStreamEnvelope<GatewayHostFrame>>
  }
}

/**
 * Semantic adapter over Harness's official InProcessApiClient.
 *
 * The caller constructs the client with `new InProcessApiClient(toFetchHandler(ctx.apiProxy))`.
 * This adapter never dispatches ApiProxy methods itself and never emits permission chat messages.
 */
export class InProcessHarnessGateway implements HarnessGatewayProvider {
  constructor(
    private readonly client: InProcessApiClientPort,
    private readonly permissions: PermissionGateway,
    private readonly dispatchHandler: InProcessDispatchHandler,
  ) {}

  describeHost(): Promise<Record<string, unknown>> {
    return this.invoke('host.describe', () => this.client.host.describe({}))
  }

  listWorkspaces(): Promise<WorkspaceCatalog> {
    return this.invoke('workspace.list', () => this.client.workspace.list({}))
  }

  async createWorkspace(path: string): Promise<WorkspaceView> {
    const created = await this.invoke('workspace.create', () => this.client.workspace.create({ path }))
    return created.workspace
  }

  async listSessions(): Promise<SessionSummary[]> {
    const listed = await this.invoke('session.list', () => this.client.sessions.list({}))
    return listed.items
  }

  createSession(request: SessionCreateRequest): Promise<SessionCreateResult> {
    return this.invoke('session.create', () => this.client.sessions.create(request))
  }

  readHistory(request: HistoryRequest): Promise<HistoryPage> {
    return this.invoke('session.history', () => this.client.sessions.history(request))
  }

  describeSettings(): Promise<SettingsDescription> {
    return this.invoke('settings.describe', () => this.client.settings.describe({}))
  }

  async selectSessionModel(sessionId: string, selection: ModelSelection): Promise<ModelSelection> {
    const selected = await this.invoke(
      'session.selectModel',
      () => this.client.sessions.selectModel({ sessionId, ...selection }),
    )
    return selected.selected
  }

  async replaceSettings(namespace: string, section: Record<string, unknown>, expectedRevision: number): Promise<void> {
    await this.invoke('settings.replace', () => this.client.settings.replace({ ns: namespace, section, expectedRevision }))
  }

  async mutateSettings(namespace: string, ops: Array<Record<string, unknown>>, expectedRevision: number): Promise<void> {
    await this.invoke('settings.mutate', () => this.client.settings.mutate({ ns: namespace, ops, expectedRevision }))
  }

  async submitPrompt(
    sessionId: string,
    mode: 'queue' | 'steer',
    content: PromptPart[],
    _preferredRpcId: string,
    beforeDispatch?: BeforeDispatch,
  ): Promise<PromptAcceptance> {
    const response = await this.dispatchHandler.run(
      'session.prompt',
      beforeDispatch,
      () => this.invokeResponse(
        'session.prompt',
        () => this.client.sessions.prompt({ sessionId, mode, content }),
      ),
    )
    return { ...response.value, rpcId: response.rpcId }
  }

  async updateQueue(request: QueueUpdateRequest): Promise<void> {
    await this.invoke('session.updateQueue', () => this.client.sessions.updateQueue(request))
  }

  async cancelSession(sessionId: string, _preferredRpcId: string, beforeDispatch?: BeforeDispatch): Promise<void> {
    await this.dispatchHandler.run(
      'session.cancel',
      beforeDispatch,
      () => this.invoke('session.cancel', () => this.client.sessions.cancel({ sessionId })),
    )
  }

  async openPath(path: string): Promise<void> {
    await this.invoke('host.openPath', () => this.client.host.openPath({ path }))
  }

  listModels(): Promise<Record<string, unknown>> {
    return this.invoke('llm.models', () => this.client.llm.models({}))
  }

  listAgentPresets(): Promise<Record<string, unknown>> {
    return this.invoke('agentPreset.list', () => this.client.agentPresets.list({}))
  }

  async readPermissionProjection(sessionId: string): Promise<{ currentValue?: unknown }> {
    return { currentValue: await this.permissions.current(sessionId) }
  }

  async requestPermissionSelection(sessionId: string, preset: PermissionPreset): Promise<{ kind?: unknown }> {
    await this.permissions.select(sessionId, preset)
    return { kind: 'success' }
  }

  openMuxEvents(
    since: Record<string, number>,
    signal: AbortSignal,
    onOpen?: () => void,
  ): AsyncIterable<GatewayStreamEnvelope<GatewayMuxFrame>> {
    return this.client.events.mux(Object.keys(since).length === 0 ? {} : { since }, signal, onOpen)
  }

  openHostEvents(
    signal: AbortSignal,
    onOpen?: () => void,
  ): AsyncIterable<GatewayStreamEnvelope<GatewayHostFrame>> {
    return this.client.events.host({}, signal, onOpen)
  }

  private async invoke<T>(operation: string, call: () => Promise<InProcessRpcResponse<T>>): Promise<T> {
    return (await this.invokeResponse(operation, call)).value
  }

  private async invokeResponse<T>(
    operation: string,
    call: () => Promise<InProcessRpcResponse<T>>,
  ): Promise<{ rpcId: string; value: T }> {
    let response: InProcessRpcResponse<T>
    try {
      response = await call()
    } catch (error: unknown) {
      throw inProcessTransportError(operation, error)
    }
    if (!response.result.ok) {
      const { code, message, details } = response.result.error
      const retryable = isTransientHostCode(code)
      throw new HostRpcError(`${operation} failed: ${code}: ${message}`, !retryable, code, retryable, details)
    }
    return { rpcId: response.rpcId, value: response.result.value }
  }
}
