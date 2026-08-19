import { resolve } from 'node:path'
import type {
  SessionHostClient,
  SessionResolution,
  SessionResolveRequest,
  SessionSummary,
  SessionWorkspace,
  WorkspaceSessionSummary,
} from './types.js'

export class SessionRoutingFacade {
  constructor(private readonly client: SessionHostClient) {}

  async list(workspace: SessionWorkspace, archivedSessionIds: string[]): Promise<WorkspaceSessionSummary[]> {
    const listed = await this.client.listSessions()
    const byId = new Map(listed.map(session => [session.sessionId, session]))
    const archived = new Set(archivedSessionIds)
    const sessions: WorkspaceSessionSummary[] = []
    for (const sessionId of workspace.sessionIds) {
      const session = byId.get(sessionId)
      if (session === undefined || session.origin === 'subagent') continue
      if (session.cwd !== undefined && !samePath(session.cwd, workspace.path)) continue
      sessions.push(toWorkspaceSessionSummary(session, archived.has(sessionId)))
    }
    return sessions.sort((left, right) => right.updatedAt - left.updatedAt)
  }

  async resolve(workspace: SessionWorkspace, request: SessionResolveRequest): Promise<SessionResolution> {
    if (request.sessionId !== undefined) {
      if (request.sessionMode !== undefined) {
        throw new Error('sessionId and sessionMode cannot be supplied together')
      }
      return this.reuseRequested(workspace, request)
    }

    if (request.sessionMode === 'latest-idle' && request.agentPreset === undefined) {
      const sessions = await this.list(workspace, request.archivedSessionIds)
      const latest = sessions.find(session => !session.archived && !session.running && !session.blank)
      if (latest !== undefined) {
        return {
          sessionId: latest.sessionId,
          reused: true,
          agentPreset: latest.agentPreset ?? null,
        }
      }
    }

    const created = await this.client.createSession({
      workspaceId: workspace.workspaceId,
      ...(request.agentPreset === undefined ? {} : { agentPreset: request.agentPreset }),
    })
    return {
      sessionId: created.sessionId,
      reused: false,
      agentPreset: created.agentPreset ?? request.agentPreset ?? null,
    }
  }

  async assertIdle(sessionId: string): Promise<void> {
    const listed = await this.client.listSessions()
    if (listed.some(session => session.sessionId === sessionId && session.running)) {
      throw new Error(`session is already running: ${sessionId}`)
    }
  }

  private async reuseRequested(workspace: SessionWorkspace, request: SessionResolveRequest): Promise<SessionResolution> {
    const requested = request.sessionId
    if (requested === undefined) throw new Error('sessionId is required for explicit reuse')
    if (!workspace.sessionIds.includes(requested)) {
      throw new Error(`session does not belong to the selected workspace: ${requested}`)
    }
    if (request.archivedSessionIds.includes(requested)) {
      throw new Error(`session is archived in Harness: ${requested}`)
    }
    const listed = await this.client.listSessions()
    const session = listed.find(item => item.sessionId === requested)
    if (session === undefined || session.origin === 'subagent') {
      throw new Error(`Harness session is not available for reuse: ${requested}`)
    }
    if (session.cwd !== undefined && !samePath(session.cwd, workspace.path)) {
      throw new Error(`session does not belong to the selected workspace: ${requested}`)
    }
    if (session.running) throw new Error(`session is already running: ${requested}`)
    if (request.agentPreset !== undefined && session.agentPreset !== request.agentPreset) {
      throw new Error('agentPreset can only be selected when creating a fresh session')
    }
    return {
      sessionId: requested,
      reused: true,
      agentPreset: session.agentPreset ?? null,
    }
  }
}

function samePath(left: string, right: string): boolean {
  const normalizedLeft = resolve(left)
  const normalizedRight = resolve(right)
  return process.platform === 'win32'
    ? normalizedLeft.toLocaleLowerCase('en-US') === normalizedRight.toLocaleLowerCase('en-US')
    : normalizedLeft === normalizedRight
}

function toWorkspaceSessionSummary(session: SessionSummary, archived: boolean): WorkspaceSessionSummary {
  return {
    sessionId: session.sessionId,
    updatedAt: session.updatedAt,
    running: session.running,
    blank: session.blank,
    ...(session.parentSessionId === undefined ? {} : { parentSessionId: session.parentSessionId }),
    ...(session.origin === undefined ? {} : { origin: session.origin }),
    ...(session.cwd === undefined ? {} : { cwd: session.cwd }),
    ...(session.agentPreset === undefined ? {} : { agentPreset: session.agentPreset }),
    archived,
  }
}
