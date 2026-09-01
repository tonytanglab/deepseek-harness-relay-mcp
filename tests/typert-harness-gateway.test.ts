import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createTypertHarnessGateway,
  HostRpcError,
  type TypertGatewayPort,
} from '../src/harness-gateway/index.js'
import { PermissionGatewayFacade, type PermissionProvider } from '../src/permission-gateway/index.js'

test('Typert adapter consumes Workspace and Session baselines from Harness 0.1.2 streams', async () => {
  const typert = new RecordingTypertGateway()
  const gateway = createTypertHarnessGateway(typert, permissions())

  assert.deepEqual(await gateway.listWorkspaces(), {
    items: [workspace],
    archivedSessionIds: ['archived-1'],
  })
  assert.deepEqual(await gateway.listSessions(), [{
    sessionId: 'session-1',
    updatedAt: 1,
    running: false,
    blank: false,
    projections: { asOfSeq: 8, values: { agentPreset: 'coding' } },
    agentPreset: 'coding',
  }])
  assert.deepEqual(typert.streamCalls.map(call => `${call.namespace}.${call.method}`), ['workspace.follow'])
  assert.deepEqual(typert.invokeCalls[0], { namespace: 'session', method: 'list', args: { _request: {} } })
})

test('Typert adapter maps Session follow/page history and current projections', async () => {
  const typert = new RecordingTypertGateway()
  const gateway = createTypertHarnessGateway(typert, permissions())

  const latest = await gateway.readHistory({ sessionId: 'session-1', maxMessages: 100 })
  assert.equal(latest.events[0]?.event.type, 'assistant/message')
  assert.equal(latest.projections?.asOfSeq, 8)

  const previous = await gateway.readHistory({ sessionId: 'session-1', maxMessages: 100, beforeSeq: 8 })
  assert.equal(previous.events[0]?.event.seq, 4)
  assert.deepEqual(typert.invokeCalls.at(-1), {
    namespace: 'session',
    method: 'page',
    args: {
      request: {
        address: { kind: 'session', sessionId: 'session-1' },
        throughSeq: 8,
        beforeSeq: 8,
        maxMessages: 100,
      },
    },
  })
})

test('Typert adapter persists the Relay request id before direct prompt dispatch', async () => {
  const order: string[] = []
  const typert = new RecordingTypertGateway(order)
  const gateway = createTypertHarnessGateway(typert, permissions())

  const accepted = await gateway.submitPrompt(
    'session-1',
    'queue',
    [{ type: 'text', text: 'review' }],
    'relay-request-1',
    async rpcId => { order.push(`persist:${rpcId}`) },
  )

  assert.deepEqual(accepted, { accepted: true, rpcId: 'relay-request-1' })
  assert.deepEqual(order, ['persist:relay-request-1', 'invoke:session.prompt'])
  assert.deepEqual(typert.invokeCalls.at(-1)?.args, {
    request: {
      requestId: 'relay-request-1',
      sessionId: 'session-1',
      mode: 'queue',
      content: [{ type: 'text', text: 'review' }],
    },
  })
})

test('Typert adapter preserves new namespaced business and transient error codes', async () => {
  const business = createTypertHarnessGateway(new ThrowingTypertGateway('session/not-found'), permissions())
  await assert.rejects(business.listSessions(), (error: unknown) => {
    assert(error instanceof HostRpcError)
    assert.equal(error.code, 'session/not-found')
    assert.equal(error.definitiveRejection, true)
    return true
  })

  const transient = createTypertHarnessGateway(new ThrowingTypertGateway('gateway/internal'), permissions())
  await assert.rejects(transient.listSessions(), (error: unknown) => {
    assert(error instanceof HostRpcError)
    assert.equal(error.code, 'gateway/internal')
    assert.equal(error.retryable, true)
    return true
  })

  const unavailable = createTypertHarnessGateway(new ThrowingTypertGateway('gateway/context-unavailable'), permissions())
  await assert.rejects(unavailable.listSessions(), (error: unknown) => {
    assert(error instanceof HostRpcError)
    assert.equal(error.code, 'gateway/context-unavailable')
    assert.equal(error.retryable, true)
    return true
  })
})

const workspace = {
  workspaceId: 'workspace-1',
  path: 'D:\\workspace',
  title: 'workspace',
  sessionIds: ['session-1'],
  createdAt: '2026-08-31T00:00:00.000Z',
  updatedAt: '2026-08-31T00:00:00.000Z',
}

class RecordingTypertGateway implements TypertGatewayPort {
  readonly invokeCalls: Array<{ namespace: string; method: string; args: Readonly<Record<string, unknown>> }> = []
  readonly streamCalls: Array<{ namespace: string; method: string; args: Readonly<Record<string, unknown>> }> = []

  constructor(private readonly order: string[] = []) {}

  async invoke(request: { namespace: string; method: string; args: Readonly<Record<string, unknown>> }): Promise<unknown> {
    this.invokeCalls.push(request)
    this.order.push(`invoke:${request.namespace}.${request.method}`)
    if (request.namespace === 'session' && request.method === 'list') {
      return {
        items: [{
          sessionId: 'session-1', updatedAt: 1, running: false, blank: false,
          projections: { asOfSeq: 8, values: { agentPreset: 'coding' } },
        }],
      }
    }
    if (request.namespace === 'session' && request.method === 'page') {
      return { records: [{ type: 'event', event: event(4) }], hasMore: false }
    }
    if (request.namespace === 'session' && request.method === 'prompt') return { accepted: true }
    throw new Error(`unexpected invocation ${request.namespace}.${request.method}`)
  }

  async stream(request: { namespace: string; method: string; args: Readonly<Record<string, unknown>> }): Promise<AsyncIterable<unknown>> {
    this.streamCalls.push(request)
    if (request.namespace === 'workspace' && request.method === 'follow') {
      return values({ type: 'baseline', value: { items: [workspace], archivedSessionIds: ['archived-1'] } })
    }
    if (request.namespace === 'session' && request.method === 'follow') {
      return values({
        type: 'snapshot',
        cursor: 8,
        records: [{ type: 'event', event: event(8) }],
        hasMore: true,
        projections: { asOfSeq: 8, values: { permissions: { currentValue: 'workspace-write' } } },
      })
    }
    throw new Error(`unexpected stream ${request.namespace}.${request.method}`)
  }
}

class ThrowingTypertGateway implements TypertGatewayPort {
  constructor(private readonly code: string) {}
  async invoke(): Promise<unknown> {
    throw Object.assign(new Error('fixture failure'), { code: this.code, details: { fixture: true } })
  }
  async stream(): Promise<AsyncIterable<unknown>> { return values() }
}

function permissions(): PermissionGatewayFacade {
  let current = 'workspace-write' as const
  const provider: PermissionProvider = {
    async readCurrent() { return current },
    async select(_sessionId, preset) { current = preset as typeof current; return { accepted: true } },
  }
  return new PermissionGatewayFacade(provider)
}

function event(seq: number) {
  return {
    type: 'assistant/message',
    seq,
    time: seq,
    data: { message: { content: [{ type: 'text', text: `result-${seq}` }] } },
  }
}

async function* values(...items: unknown[]): AsyncGenerator<unknown> {
  yield* items
}
