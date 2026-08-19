import assert from 'node:assert/strict'
import test from 'node:test'
import { SessionRoutingFacade, type SessionSummary } from '../src/session-routing/index.js'

const workspace = {
  workspaceId: 'workspace-1',
  path: 'D:\\AI\\proflow',
  sessionIds: ['latest', 'running', 'blank', 'archived', 'older'],
}

test('lists only direct workspace sessions and marks archived entries', async () => {
  const routing = new SessionRoutingFacade(client([
    summary('other', 99, { cwd: 'D:\\AI\\other' }),
    { ...summary('latest', 50), projections: { values: { title: 'must not escape' } } } as SessionSummary,
    summary('archived', 40),
    summary('subagent', 60, { origin: 'subagent' }),
  ]))

  const sessions = await routing.list(workspace, ['archived'])

  assert.deepEqual(sessions.map(session => [session.sessionId, session.archived]), [
    ['latest', false],
    ['archived', true],
  ])
  assert.equal('projections' in sessions[0]!, false)
})

test('latest-idle reuses the newest nonblank idle unarchived session', async () => {
  let creates = 0
  const routing = new SessionRoutingFacade(client([
    summary('running', 90, { running: true }),
    summary('blank', 80, { blank: true }),
    summary('archived', 70),
    summary('older', 60),
    summary('latest', 100, { agentPreset: 'standard' }),
  ], () => { creates += 1 }))

  const result = await routing.resolve(workspace, {
    sessionMode: 'latest-idle',
    archivedSessionIds: ['archived'],
  })

  assert.deepEqual(result, { sessionId: 'latest', reused: true, agentPreset: 'standard' })
  assert.equal(creates, 0)
})

test('latest-idle creates a fresh session when no reusable conversation exists', async () => {
  const routing = new SessionRoutingFacade(client([
    summary('running', 90, { running: true }),
    summary('blank', 80, { blank: true }),
  ]))

  const result = await routing.resolve(workspace, {
    sessionMode: 'latest-idle',
    archivedSessionIds: [],
  })

  assert.deepEqual(result, { sessionId: 'created', reused: false, agentPreset: null })
})

test('explicit reuse rejects archived, missing, and running sessions', async () => {
  const routing = new SessionRoutingFacade(client([
    summary('running', 90, { running: true }),
    summary('latest', 80),
  ]))

  await assert.rejects(
    routing.resolve(workspace, { sessionId: 'archived', archivedSessionIds: ['archived'] }),
    /session is archived/iu,
  )
  await assert.rejects(
    routing.resolve(workspace, { sessionId: 'older', archivedSessionIds: [] }),
    /not available for reuse/iu,
  )
  await assert.rejects(
    routing.resolve(workspace, { sessionId: 'running', archivedSessionIds: [] }),
    /already running/iu,
  )
})

function summary(
  sessionId: string,
  updatedAt: number,
  overrides: Partial<SessionSummary> = {},
): SessionSummary {
  return {
    sessionId,
    updatedAt,
    running: false,
    blank: false,
    cwd: workspace.path,
    ...overrides,
  }
}

function client(items: SessionSummary[], created?: () => void) {
  return {
    async listSessions(): Promise<SessionSummary[]> {
      return items
    },
    async createSession(): Promise<{ sessionId: string }> {
      created?.()
      return { sessionId: 'created' }
    },
  }
}
