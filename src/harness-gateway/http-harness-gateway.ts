import type { ModelSelection, PermissionPreset, PromptPart } from '../types.js'
import { HttpHostClient } from './http-host-client.js'
import type {
  HarnessGatewayProvider,
  BeforeDispatch,
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

export class HttpHarnessGateway implements HarnessGatewayProvider {
  private readonly client: HttpHostClient

  constructor(baseUrl: string, timeoutMs: number, fetchImpl: typeof fetch = fetch) {
    this.client = new HttpHostClient(baseUrl, timeoutMs, fetchImpl)
  }

  describeHost(): Promise<Record<string, unknown>> {
    return this.client.call('host.describe', {})
  }

  listWorkspaces(): Promise<WorkspaceCatalog> {
    return this.client.call('workspace.list', {})
  }

  async createWorkspace(path: string): Promise<WorkspaceView> {
    const created = await this.client.call<{ workspace: WorkspaceView }>('workspace.create', { path })
    return created.workspace
  }

  async listSessions(): Promise<SessionSummary[]> {
    const listed = await this.client.call<{ items: SessionSummary[] }>('session.list', {})
    return listed.items
  }

  createSession(request: SessionCreateRequest): Promise<SessionCreateResult> {
    return this.client.call('session.create', request)
  }

  readHistory(request: HistoryRequest): Promise<HistoryPage> {
    return this.client.call('session.history', request)
  }

  describeSettings(): Promise<SettingsDescription> {
    return this.client.call('settings.describe', {})
  }

  async selectSessionModel(sessionId: string, selection: ModelSelection): Promise<ModelSelection> {
    const selected = await this.client.call<{ selected: ModelSelection }>('session.selectModel', { sessionId, ...selection })
    return selected.selected
  }

  async replaceSettings(namespace: string, section: Record<string, unknown>, expectedRevision: number): Promise<void> {
    await this.client.call('settings.replace', { ns: namespace, section, expectedRevision })
  }

  async mutateSettings(namespace: string, ops: Array<Record<string, unknown>>, expectedRevision: number): Promise<void> {
    await this.client.call('settings.mutate', { ns: namespace, ops, expectedRevision })
  }

  async submitPrompt(sessionId: string, mode: 'queue' | 'steer', content: PromptPart[], rpcId: string, beforeDispatch?: BeforeDispatch): Promise<PromptAcceptance> {
    const accepted = await this.client.call<Omit<PromptAcceptance, 'rpcId'>>('session.prompt', { sessionId, mode, content }, rpcId, beforeDispatch)
    return { ...accepted, rpcId }
  }

  async updateQueue(request: QueueUpdateRequest): Promise<void> {
    await this.client.call('session.updateQueue', request)
  }

  async cancelSession(sessionId: string, rpcId: string, beforeDispatch?: BeforeDispatch): Promise<void> {
    await this.client.call('session.cancel', { sessionId }, rpcId, beforeDispatch)
  }

  async openPath(path: string): Promise<void> {
    await this.client.call('host.openPath', { path })
  }

  listModels(): Promise<Record<string, unknown>> {
    return this.client.call('llm.models', {})
  }

  listAgentPresets(): Promise<Record<string, unknown>> {
    return this.client.call('agentPreset.list', {})
  }

  async readPermissionProjection(sessionId: string): Promise<{ currentValue?: unknown }> {
    const history = await this.client.call<HistoryPage>('session.history', { sessionId, maxMessages: 1 })
    const currentValue = history.projections?.values?.permissions?.currentValue
    return currentValue === undefined ? {} : { currentValue }
  }

  async requestPermissionSelection(sessionId: string, preset: PermissionPreset): Promise<{ kind?: unknown }> {
    const command = await this.client.callRemote<{ result?: { kind?: unknown } }>('commands/execute', {
      agentId: sessionId,
      line: `/permission ${preset}`,
    })
    const kind = command.result?.kind
    return kind === undefined ? {} : { kind }
  }
}
