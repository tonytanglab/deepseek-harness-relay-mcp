import { afterEach, describe, expect, it, vi } from 'vitest'
import { AttachManager } from '../src/attach.ts'

const WEB_URL = 'http://127.0.0.1:3080'
const WORKSPACE = 'D:\\relay-workspace'
const SESSION_ID = 'session-1'

interface RpcRequest {
  rpcId: string
  method: string
  payload: Record<string, unknown>
}

type RpcReply = { value: unknown } | { error: string }

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('AttachManager run ownership', () => {
  it('atomically reserves a reused session across concurrent starts', async () => {
    let listCalls = 0
    let promptCalls = 0
    let releaseLists!: () => void
    const listsReady = new Promise<void>(resolve => {
      releaseLists = resolve
    })
    installHost(async method => {
      if (method === 'session.list') {
        listCalls += 1
        if (listCalls === 2) releaseLists()
        await listsReady
      }
      if (method === 'session.prompt') promptCalls += 1
      return standardReply(method)
    })

    const manager = createManager()
    const results = await Promise.allSettled([
      manager.start(startInput('first')),
      manager.start(startInput('second')),
    ])

    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    const rejected = results.find(result => result.status === 'rejected')
    expect(rejected).toMatchObject({ status: 'rejected' })
    if (rejected?.status === 'rejected') {
      expect(String(rejected.reason)).toContain('already has an active Relay run')
    }
    expect(promptCalls).toBe(1)
  })

  it('releases its reservation when initialization fails', async () => {
    let historyFails = true
    installHost(async method => {
      if (method === 'session.history' && historyFails) {
        historyFails = false
        return { error: 'history unavailable' }
      }
      return standardReply(method)
    })

    const manager = createManager()
    await expect(manager.start(startInput('first'))).rejects.toThrow('history unavailable')
    await expect(manager.start(startInput('retry'))).resolves.toMatchObject({ status: 'running' })
  })

  it('does not mark cancellation requested when the cancel RPC fails', async () => {
    let cancelFails = false
    let historyEvents: unknown[] = []
    installHost(async method => {
      if (method === 'session.cancel' && cancelFails) return { error: 'cancel rejected' }
      if (method === 'session.history') return { value: { events: historyEvents } }
      return standardReply(method)
    })

    const manager = createManager()
    const started = await manager.start(startInput('cancel me'))
    cancelFails = true
    await expect(manager.cancel(started.runId)).rejects.toThrow('cancel rejected')

    historyEvents = [
      { type: 'turn/end', seq: 1, data: { reason: { kind: 'aborted', reason: { kind: 'legacy' } } } },
    ]
    const snapshot = await manager.get(started.runId)
    expect(snapshot).toMatchObject({
      status: 'failed',
      cancelRequested: false,
      error: 'turn aborted: legacy',
    })
    expect(snapshot.finishedAt).not.toBeNull()
  })
})

describe('AttachManager deadlines', () => {
  it('bounds a refresh RPC by the remaining wait_run budget', async () => {
    let hangSessionList = false
    installHost(async (method, _payload, signal) => {
      if (method === 'session.list' && hangSessionList) {
        return await new Promise<RpcReply>((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(signal.reason), { once: true })
        })
      }
      return standardReply(method)
    })

    const manager = createManager()
    const started = await manager.start(startInput('wait for me'))
    hangSessionList = true
    const before = performance.now()
    const snapshot = await manager.wait(started.runId, 30)
    const elapsed = performance.now() - before

    expect(elapsed).toBeLessThan(500)
    expect(snapshot.status).toBe('running')
    expect(snapshot.lastRefreshError).not.toBeNull()
  })
})

function createManager(): AttachManager {
  return new AttachManager({ webUrl: WEB_URL, allowedWorkspaceRoots: [] })
}

function startInput(task: string): { task: string; workspace: string; sessionId: string } {
  return { task, workspace: WORKSPACE, sessionId: SESSION_ID }
}

function standardReply(method: string): RpcReply {
  switch (method) {
    case 'workspace.create':
      return {
        value: {
          workspace: {
            workspaceId: 'workspace-1',
            path: WORKSPACE,
            title: 'Relay workspace',
            sessionIds: [SESSION_ID],
          },
        },
      }
    case 'session.list':
      return {
        value: {
          items: [{ sessionId: SESSION_ID, updatedAt: 0, running: false, blank: false, cwd: WORKSPACE }],
        },
      }
    case 'session.history':
      return { value: { events: [] } }
    default:
      return { value: {} }
  }
}

function installHost(
  resolve: (method: string, payload: Record<string, unknown>, signal: AbortSignal | null) => RpcReply | Promise<RpcReply>,
): void {
  vi.stubGlobal('fetch', vi.fn(async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const request = JSON.parse(String(init?.body)) as RpcRequest
    const reply = await resolve(request.method, request.payload, init?.signal ?? null)
    const result = 'error' in reply
      ? { ok: false, error: { message: reply.error } }
      : { ok: true, value: reply.value }
    return new Response(JSON.stringify({ type: 'server-response', rpcId: request.rpcId, result }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }))
}
