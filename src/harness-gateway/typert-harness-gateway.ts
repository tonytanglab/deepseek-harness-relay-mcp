import type { ModelSelection, PermissionPreset, PromptPart, RpcEvent } from '../types.js'
import type { PermissionGateway } from '../permission-gateway/index.js'
import { HostRpcError, typertGatewayError } from './host-errors.js'
import type {
  BeforeDispatch,
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

interface TypertInvokeRequest {
  namespace: string
  method: string
  args: Readonly<Record<string, unknown>>
  signal?: AbortSignal
}

/** Structural view of Harness 0.1.2's Host-side Typert Gateway. */
export interface TypertGatewayPort {
  invoke(request: TypertInvokeRequest): Promise<unknown>
  stream(request: TypertInvokeRequest): Promise<AsyncIterable<unknown>>
}

interface WorkspaceFollowBaseline {
  type: 'baseline'
  value: WorkspaceCatalog
}

interface SessionProjectionBlock {
  asOfSeq: number
  values: Record<string, unknown>
}

interface SessionFollowSnapshot {
  type: 'snapshot'
  cursor: number
  records: Array<{ type: string; event: RpcEvent }>
  hasMore: boolean
  projections: SessionProjectionBlock
}

interface SessionPageValue {
  records: Array<{ type: string; event: RpcEvent }>
  hasMore: boolean
}

interface SessionListValue {
  items: Array<SessionSummary & {
    projections?: {
      asOfSeq?: number
      values?: Record<string, unknown>
    }
  }>
}

/** Semantic Relay adapter over the direct Typert Gateway introduced in Harness 0.1.2. */
export class TypertHarnessGateway implements HarnessGatewayProvider {
  constructor(
    private readonly gateway: TypertGatewayPort,
    private readonly permissions: PermissionGateway,
    private readonly hostDescription: Readonly<Record<string, unknown>> = {
      mode: 'embedded',
      api: 'typert-gateway',
    },
  ) {}

  describeHost(): Promise<Record<string, unknown>> {
    return Promise.resolve({ ...this.hostDescription })
  }

  async listWorkspaces(): Promise<WorkspaceCatalog> {
    const frame = await this.firstStreamValue<WorkspaceFollowBaseline>('workspace.follow', 'workspace', 'follow', {})
    if (frame.type !== 'baseline') throw incompatibleFrame('workspace.follow', 'baseline', frame)
    return frame.value
  }

  async createWorkspace(path: string): Promise<WorkspaceView> {
    const result = await this.invoke<{ workspace: WorkspaceView }>('workspace.create', 'workspace', 'create', {
      request: { path },
    })
    return result.workspace
  }

  async listSessions(): Promise<SessionSummary[]> {
    const result = await this.invoke<SessionListValue>('session.list', 'session', 'list', { _request: {} })
    return result.items.map((item) => {
      const projectedPreset = item.projections?.values?.agentPreset
      return {
        ...item,
        ...(typeof projectedPreset === 'string' ? { agentPreset: projectedPreset } : {}),
      }
    })
  }

  createSession(request: SessionCreateRequest): Promise<SessionCreateResult> {
    return this.invoke('session.create', 'session', 'create', { request })
  }

  async readHistory(request: HistoryRequest): Promise<HistoryPage> {
    const snapshot = await this.firstStreamValue<SessionFollowSnapshot>(
      'session.follow',
      'session',
      'follow',
      {
        request: {
          address: { kind: 'session', sessionId: request.sessionId },
          maxMessages: request.maxMessages,
        },
      },
    )
    if (snapshot.type !== 'snapshot') throw incompatibleFrame('session.follow', 'snapshot', snapshot)

    const page = request.beforeSeq === undefined
      ? snapshot
      : await this.invoke<SessionPageValue>('session.page', 'session', 'page', {
          request: {
            address: { kind: 'session', sessionId: request.sessionId },
            throughSeq: snapshot.cursor,
            beforeSeq: request.beforeSeq,
            maxMessages: request.maxMessages,
          },
        })
    return {
      events: page.records.map(record => ({ event: record.event })),
      hasMore: page.hasMore,
      projections: snapshot.projections,
    }
  }

  describeSettings(): Promise<SettingsDescription> {
    return this.invoke('settings.describe', 'settings', 'describe', {})
  }

  async selectSessionModel(sessionId: string, selection: ModelSelection): Promise<ModelSelection> {
    const result = await this.invoke<{ selected: ModelSelection }>(
      'session.selectModel',
      'session',
      'selectModel',
      { request: { sessionId, ...selection } },
    )
    return result.selected
  }

  async replaceSettings(namespace: string, section: Record<string, unknown>, expectedRevision: number): Promise<void> {
    await this.invoke('settings.replace', 'settings', 'replace', {
      ns: namespace,
      section,
      expectedRevision,
    })
  }

  async mutateSettings(namespace: string, ops: Array<Record<string, unknown>>, expectedRevision: number): Promise<void> {
    await this.invoke('settings.mutate', 'settings', 'mutate', {
      ns: namespace,
      ops,
      expectedRevision,
    })
  }

  async submitPrompt(
    sessionId: string,
    mode: 'queue' | 'steer',
    content: PromptPart[],
    rpcId: string,
    beforeDispatch?: BeforeDispatch,
  ): Promise<PromptAcceptance> {
    await beforeDispatch?.(rpcId)
    const result = await this.invoke<{ accepted: true }>('session.prompt', 'session', 'prompt', {
      request: { requestId: rpcId, sessionId, mode, content },
    })
    return { ...result, rpcId }
  }

  async updateQueue(request: QueueUpdateRequest): Promise<void> {
    await this.invoke('session.updateQueue', 'session', 'updateQueue', { request })
  }

  async cancelSession(sessionId: string, rpcId: string, beforeDispatch?: BeforeDispatch): Promise<void> {
    await beforeDispatch?.(rpcId)
    await this.invoke('session.cancel', 'session', 'cancel', { request: { sessionId } })
  }

  async openPath(path: string): Promise<void> {
    await this.invoke('session.openWorkspacePath', 'session', 'openWorkspacePath', { request: { path } })
  }

  listModels(): Promise<Record<string, unknown>> {
    return this.invoke('session.modelCatalog', 'session', 'modelCatalog', {})
  }

  listAgentPresets(): Promise<Record<string, unknown>> {
    return this.invoke('agentPresets.list', 'agentPresets', 'list', {})
  }

  async readPermissionProjection(sessionId: string): Promise<{ currentValue?: unknown }> {
    return { currentValue: await this.permissions.current(sessionId) }
  }

  async requestPermissionSelection(sessionId: string, preset: PermissionPreset): Promise<{ kind?: unknown }> {
    await this.permissions.select(sessionId, preset)
    return { kind: 'success' }
  }

  private async invoke<T>(
    operation: string,
    namespace: string,
    method: string,
    args: Readonly<Record<string, unknown>>,
  ): Promise<T> {
    try {
      return await this.gateway.invoke({ namespace, method, args }) as T
    } catch (error: unknown) {
      throw typertGatewayError(operation, error)
    }
  }

  private async firstStreamValue<T>(
    operation: string,
    namespace: string,
    method: string,
    args: Readonly<Record<string, unknown>>,
  ): Promise<T> {
    const controller = new AbortController()
    let iterator: AsyncIterator<unknown> | undefined
    try {
      const stream = await this.gateway.stream({ namespace, method, args, signal: controller.signal })
      iterator = stream[Symbol.asyncIterator]()
      const first = await iterator.next()
      if (first.done) {
        throw new HostRpcError(`${operation} ended before its baseline`, false, 'HOST_STREAM_EMPTY', true)
      }
      return first.value as T
    } catch (error: unknown) {
      throw typertGatewayError(operation, error)
    } finally {
      controller.abort()
      await iterator?.return?.().catch(() => {})
    }
  }
}

function incompatibleFrame(operation: string, expected: string, frame: unknown): HostRpcError {
  const actual = isRecord(frame) && typeof frame.type === 'string' ? frame.type : typeof frame
  return new HostRpcError(
    `${operation} returned ${actual}; expected ${expected}`,
    true,
    'HOST_API_INCOMPATIBLE',
    false,
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
