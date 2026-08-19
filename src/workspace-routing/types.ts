import type { WorkspaceCatalog, WorkspaceView } from '../harness-gateway/index.js'

export type { WorkspaceCatalog, WorkspaceView } from '../harness-gateway/index.js'

export interface WorkspaceSummary {
  workspaceId: string
  path: string
  title: string
  sessionCount: number
}

export interface WorkspacePolicy {
  mode: 'harness-registry' | 'configured-roots'
  roots: string[]
  registered: WorkspaceSummary[]
  archivedSessionIds: string[]
}

export interface WorkspaceResolution {
  path: string
  workspace: WorkspaceView | null
}

export interface WorkspaceHostClient {
  listWorkspaces(): Promise<WorkspaceCatalog>
}
