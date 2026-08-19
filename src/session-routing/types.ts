import type { SessionSummary, WorkspaceView } from '../harness-gateway/index.js'

export type { SessionSummary } from '../harness-gateway/index.js'

export type SessionMode = 'fresh' | 'latest-idle'

export interface WorkspaceSessionSummary extends SessionSummary {
  archived: boolean
}

export interface SessionResolution {
  sessionId: string
  reused: boolean
  agentPreset: string | null
}

export interface SessionResolveRequest {
  sessionId?: string
  sessionMode?: SessionMode
  agentPreset?: string
  archivedSessionIds: string[]
}

export interface SessionHostClient {
  listSessions(): Promise<SessionSummary[]>
  createSession(request: { workspaceId: string; agentPreset?: string }): Promise<{ sessionId: string; agentPreset?: string }>
}

export type SessionWorkspace = Pick<WorkspaceView, 'workspaceId' | 'path' | 'sessionIds'>
