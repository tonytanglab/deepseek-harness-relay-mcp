import type { ModelSelection, PermissionPreset, PromptPart, RpcEvent } from '../types.js'

export interface WorkspaceView {
  workspaceId: string
  path: string
  title: string
  sessionIds: string[]
  createdAt: string
  updatedAt: string
}

export interface WorkspaceCatalog {
  items: WorkspaceView[]
  archivedSessionIds: string[]
}

export interface SessionSummary {
  sessionId: string
  updatedAt: number
  running: boolean
  blank: boolean
  parentSessionId?: string
  origin?: 'subagent'
  cwd?: string
  agentPreset?: string
  projections?: { asOfSeq?: number }
}

export interface SessionCreateRequest {
  workspaceId: string
  agentPreset?: string
}

export interface SessionCreateResult {
  sessionId: string
  agentPreset?: string
}

export interface HistoryRequest {
  sessionId: string
  maxMessages: number
  beforeSeq?: number
}

export interface HistoryPage {
  events: Array<{ event: RpcEvent }>
  hasMore: boolean
  projections?: { values?: { permissions?: { currentValue?: string } } }
}

export interface SettingsNamespace {
  ns: string
  user?: unknown
  revision: number
}

export interface SettingsDescription {
  writable: boolean
  namespaces: SettingsNamespace[]
}

export interface PromptAcceptance {
  accepted: true
  /** Correlation id minted by the active carrier; in-process calls may replace the preferred id. */
  rpcId: string
  messageId?: string
}

/** Awaited durability hook invoked after correlation is known and before Host dispatch. */
export type BeforeDispatch = (actualRpcId: string) => Promise<void>

export interface QueueUpdateRequest {
  sessionId: string
  itemId: string
  action: { kind: 'edit'; content: PromptPart[] } | { kind: 'remove' } | { kind: 'steer' }
}

export interface GatewayStreamEnvelope<TFrame> {
  rpcId: string
  payload: TFrame
}

export type GatewayMuxFrame =
  | { type: 'session/event'; sessionId: string; event: RpcEvent; view?: unknown }
  | { type: 'session/subscribed'; sessionId: string; lastSeq: number }
  | { type: 'approval/requested'; sessionId: string; approvalId: string; toolName: string; callId?: string; reason?: string }
  | { type: 'approval/resolved'; sessionId: string; approvalId: string; outcome: string }
  | { type: 'question/requested'; sessionId: string; questions: unknown[] }
  | { type: 'question/resolved'; sessionId: string; questionRpcId: string; outcome: 'answered' | 'cancelled' }
  | { type: 'session/queue'; sessionId: string; items: unknown[] }
  | { type: 'session/jobs'; sessionId: string; jobs: unknown[] }
  | { type: 'session/projection'; sessionId: string; key: string; value: unknown; seq: number }
  | { type: 'stream/error'; error: { code: string; message: string; details?: unknown } }

export type GatewayHostFrame =
  | { type: 'host/session-added'; sessionId: string; blank: boolean; parentSessionId?: string; origin?: 'subagent'; cwd?: string; agentPreset?: string }
  | { type: 'host/session-removed'; sessionId: string }
  | { type: 'host/session-status'; sessionId: string; running: boolean }
  | { type: 'host/agent-error'; sessionId: string; message: string }
  | { type: 'host/workspace-changed'; workspace: WorkspaceView }
  | { type: 'host/workspace-removed'; workspaceId: string }
  | { type: 'host/workspace-order-changed'; workspaceIds: string[] }
  | { type: 'host/archived-sessions-changed'; archivedSessionIds: string[] }
  | { type: 'host/remote-event'; event: string; args: unknown[] }
  | { type: 'stream/error'; error: { code: string; message: string; details?: unknown } }

export interface HarnessEventGatewayProvider {
  openMuxEvents(
    since: Record<string, number>,
    signal: AbortSignal,
    onOpen?: () => void,
  ): AsyncIterable<GatewayStreamEnvelope<GatewayMuxFrame>>
  openHostEvents(
    signal: AbortSignal,
    onOpen?: () => void,
  ): AsyncIterable<GatewayStreamEnvelope<GatewayHostFrame>>
}

export interface HarnessGatewayProvider {
  describeHost(): Promise<Record<string, unknown>>
  listWorkspaces(): Promise<WorkspaceCatalog>
  createWorkspace(path: string): Promise<WorkspaceView>
  listSessions(): Promise<SessionSummary[]>
  createSession(request: SessionCreateRequest): Promise<SessionCreateResult>
  readHistory(request: HistoryRequest): Promise<HistoryPage>
  describeSettings(): Promise<SettingsDescription>
  selectSessionModel(sessionId: string, selection: ModelSelection): Promise<ModelSelection>
  replaceSettings(namespace: string, section: Record<string, unknown>, expectedRevision: number): Promise<void>
  mutateSettings(namespace: string, ops: Array<Record<string, unknown>>, expectedRevision: number): Promise<void>
  submitPrompt(sessionId: string, mode: 'queue' | 'steer', content: PromptPart[], rpcId: string, beforeDispatch?: BeforeDispatch): Promise<PromptAcceptance>
  updateQueue(request: QueueUpdateRequest): Promise<void>
  cancelSession(sessionId: string, rpcId: string, beforeDispatch?: BeforeDispatch): Promise<void>
  openPath(path: string): Promise<void>
  listModels(): Promise<Record<string, unknown>>
  listAgentPresets(): Promise<Record<string, unknown>>
  readPermissionProjection(sessionId: string): Promise<{ currentValue?: unknown }>
  requestPermissionSelection(sessionId: string, preset: PermissionPreset): Promise<{ kind?: unknown }>
  openMuxEvents?: HarnessEventGatewayProvider['openMuxEvents']
  openHostEvents?: HarnessEventGatewayProvider['openHostEvents']
}
