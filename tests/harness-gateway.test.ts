import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import {
  createHttpHarnessGateway,
  HarnessGatewayFacade,
  HostRpcError,
  type HarnessGatewayProvider,
} from '../src/harness-gateway/index.js'

const golden = JSON.parse(await readFile(new URL('./fixtures/host-contracts.json', import.meta.url), 'utf8')) as {
  acceptedPrompt: { accepted: true; messageId: string }
  definitiveRejection: { code: string; message: string }
  retryableFailure: { code: string; message: string }
  unknownOutcome: { rpcId: string; value: { accepted: true } }
}

test('HTTP gateway maps semantic operations to the public Host wire contract', async () => {
  const requests: Array<{ method: string; payload: Record<string, unknown>; rpcId: string }> = []
  const gateway = createHttpHarnessGateway('http://127.0.0.1:3080/', 1_000, host(request => {
    requests.push(request)
    if (request.method === 'workspace.create') return { workspace: workspace() }
    if (request.method === 'session.prompt') return golden.acceptedPrompt
    if (request.method === 'session.history') {
      return { events: [], hasMore: false, projections: { values: { permissions: { currentValue: 'read-only' } } } }
    }
    if (request.method === 'commands/execute') return { result: { kind: 'success' } }
    throw new Error(`unexpected method: ${request.method}`)
  }))

  assert.equal((await gateway.createWorkspace('D:\\AI\\project')).workspaceId, 'workspace-1')
  assert.deepEqual(await gateway.submitPrompt('session-1', 'queue', [{ type: 'text', text: 'review' }], 'rpc-prompt'), {
    accepted: true,
    rpcId: 'rpc-prompt',
    messageId: 'message-golden',
  })
  assert.deepEqual(await gateway.readPermissionProjection('session-1'), { currentValue: 'read-only' })
  assert.deepEqual(await gateway.requestPermissionSelection('session-1', 'workspace-write'), { kind: 'success' })
  assert.deepEqual(requests.map(request => [request.method, request.payload, request.rpcId]), [
    ['workspace.create', { path: 'D:\\AI\\project' }, requests[0]!.rpcId],
    ['session.prompt', { sessionId: 'session-1', mode: 'queue', content: [{ type: 'text', text: 'review' }] }, 'rpc-prompt'],
    ['session.history', { sessionId: 'session-1', maxMessages: 1 }, requests[2]!.rpcId],
    ['commands/execute', { args: { agentId: 'session-1', line: '/permission workspace-write' } }, requests[3]!.rpcId],
  ])
})

test('HTTP gateway preserves definitive Host errors without exposing generic RPC methods', async () => {
  const gateway = createHttpHarnessGateway('http://127.0.0.1:3080/', 1_000, async (_input, init) => {
    const request = JSON.parse(String(init?.body)) as { rpcId: string }
    return response(request.rpcId, undefined, {
      ...golden.definitiveRejection,
    })
  })

  assert.equal('call' in gateway, false)
  assert.equal('callRemote' in gateway, false)
  await assert.rejects(gateway.createWorkspace('bad'), (error: unknown) => {
    assert(error instanceof HostRpcError)
    assert.equal(error.code, 'INVALID_ARGUMENT')
    assert.equal(error.definitiveRejection, true)
    assert.equal(error.retryable, false)
    return true
  })
})

test('HTTP gateway keeps retryable and unknown outcomes distinct', async () => {
  let responseNumber = 0
  const gateway = createHttpHarnessGateway('http://127.0.0.1:3080/', 1_000, async (_input, init) => {
    const request = JSON.parse(String(init?.body)) as { rpcId: string }
    responseNumber += 1
    if (responseNumber === 1) return response(request.rpcId, undefined, golden.retryableFailure)
    return response(golden.unknownOutcome.rpcId, golden.unknownOutcome.value)
  })

  await assert.rejects(gateway.describeHost(), (error: unknown) => {
    assert(error instanceof HostRpcError)
    assert.equal(error.code, 'HOST_UNAVAILABLE')
    assert.equal(error.definitiveRejection, false)
    assert.equal(error.retryable, true)
    return true
  })
  await assert.rejects(gateway.submitPrompt('session-1', 'queue', [{ type: 'text', text: 'review' }], 'rpc-known'), (error: unknown) => {
    assert(error instanceof HostRpcError)
    assert.equal(error.code, 'HOST_RPC_ID_MISMATCH')
    assert.equal(error.definitiveRejection, false)
    assert.equal(error.retryable, true)
    return true
  })
})

test('HTTP gateway awaits correlation durability before network dispatch', async () => {
  const order: string[] = []
  const gateway = createHttpHarnessGateway('http://127.0.0.1:3080/', 1_000, async (_input, init) => {
    const request = JSON.parse(String(init?.body)) as { rpcId: string }
    order.push(`dispatch:${request.rpcId}`)
    return response(request.rpcId, { accepted: true })
  })

  const accepted = await gateway.submitPrompt(
    'session-1',
    'queue',
    [{ type: 'text', text: 'review' }],
    'rpc-durable',
    async rpcId => {
      await Promise.resolve()
      order.push(`persist:${rpcId}`)
    },
  )

  assert.equal(accepted.rpcId, 'rpc-durable')
  assert.deepEqual(order, ['persist:rpc-durable', 'dispatch:rpc-durable'])
})

test('Facade accepts a transport-free provider for the future in-process adapter', async () => {
  const calls: string[] = []
  const provider = new Proxy({}, {
    get: (_target, property) => async () => {
      calls.push(String(property))
      if (property === 'describeHost') return { mode: 'in-process-fake' }
      throw new Error(`unexpected operation: ${String(property)}`)
    },
  }) as HarnessGatewayProvider
  const gateway = new HarnessGatewayFacade(provider)

  assert.deepEqual(await gateway.describeHost(), { mode: 'in-process-fake' })
  assert.deepEqual(calls, ['describeHost'])
  assert.equal('call' in gateway, false)
})

function host(handler: (request: { method: string; payload: Record<string, unknown>; rpcId: string }) => unknown): typeof fetch {
  return async (_input, init) => {
    const request = JSON.parse(String(init?.body)) as { method: string; payload: Record<string, unknown>; rpcId: string }
    return response(request.rpcId, handler(request))
  }
}

function response(rpcId: string, value?: unknown, error?: { code: string; message: string }): Response {
  return new Response(JSON.stringify({
    type: 'server-response',
    rpcId,
    result: error === undefined ? { ok: true, value } : { ok: false, error },
  }), { status: 200, headers: { 'content-type': 'application/json' } })
}

function workspace() {
  return {
    workspaceId: 'workspace-1',
    path: 'D:\\AI\\project',
    title: 'project',
    sessionIds: [],
    createdAt: '2026-08-19T00:00:00.000Z',
    updatedAt: '2026-08-19T00:00:00.000Z',
  }
}
