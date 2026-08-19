import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createInProcessHarnessGateway,
  HostRpcError,
  InProcessDispatchHandler,
  type InProcessApiClientPort,
  type InProcessRpcResponse,
} from '../src/harness-gateway/index.js'
import { PermissionGatewayFacade, type PermissionProvider } from '../src/permission-gateway/index.js'

test('in-process gateway awaits rpcId durability before ApiProxy dispatch', async () => {
  const order: string[] = []
  const handler = new InProcessDispatchHandler({
    fetch: async (_input, init) => {
      const request = parseRequest(init?.body)
      order.push(`dispatch:${request.rpcId}`)
      return Response.json({
        rpcId: request.rpcId,
        result: { ok: true, value: { accepted: true } },
      })
    },
  })
  const gateway = createInProcessHarnessGateway(fakeOfficialClient(handler), nativePermissions(), handler)

  const accepted = await gateway.submitPrompt(
    'session-1',
    'queue',
    [{ type: 'text', text: 'review' }],
    'preferred-external-id',
    async actualRpcId => {
      await Promise.resolve()
      order.push(`persist:${actualRpcId}`)
    },
  )

  assert.deepEqual(accepted, { accepted: true, rpcId: 'in-process-1' })
  assert.deepEqual(order, ['persist:in-process-1', 'dispatch:in-process-1'])
})

test('in-process gateway normalizes official client business errors', async () => {
  const handler = new InProcessDispatchHandler({
    fetch: async (_input, init) => {
      const request = parseRequest(init?.body)
      return Response.json({
        rpcId: request.rpcId,
        result: { ok: false, error: { code: 'model-unavailable', message: 'missing', details: {} } },
      })
    },
  })
  const gateway = createInProcessHarnessGateway(fakeOfficialClient(handler), nativePermissions(), handler)

  await assert.rejects(
    gateway.submitPrompt('session-1', 'queue', [{ type: 'text', text: 'review' }], 'preferred'),
    (error: unknown) => {
      assert(error instanceof HostRpcError)
      assert.equal(error.code, 'model-unavailable')
      assert.equal(error.definitiveRejection, true)
      assert.equal(error.retryable, false)
      return true
    },
  )
})

test('dispatch observer rejects method drift before the Host handler runs', async () => {
  let dispatched = false
  const handler = new InProcessDispatchHandler({
    fetch: async () => {
      dispatched = true
      return Response.json({})
    },
  })

  await assert.rejects(
    handler.run('session.prompt', undefined, () => handler.fetch(new URL('http://in-process/api/session.cancel'), {
      method: 'POST',
      body: JSON.stringify({ type: 'client-request', rpcId: 'wrong-1', method: 'session.cancel', payload: {} }),
    })),
    (error: unknown) => error instanceof HostRpcError && error.code === 'HOST_RPC_METHOD_MISMATCH',
  )
  assert.equal(dispatched, false)
})

function fakeOfficialClient(handler: InProcessDispatchHandler): InProcessApiClientPort {
  let nextRpcId = 0
  const invoke = async <T>(method: string, payload: unknown): Promise<InProcessRpcResponse<T>> => {
    const rpcId = `in-process-${++nextRpcId}`
    const response = await handler.fetch(new URL(`http://in-process/api/${method}`), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId, method, payload }),
    })
    return await response.json() as InProcessRpcResponse<T>
  }
  const methodNames: Record<string, Record<string, string>> = {
    sessions: {
      list: 'session.list', create: 'session.create', history: 'session.history',
      selectModel: 'session.selectModel', prompt: 'session.prompt',
      updateQueue: 'session.updateQueue', cancel: 'session.cancel',
    },
    workspace: { list: 'workspace.list', create: 'workspace.create' },
    host: { describe: 'host.describe', openPath: 'host.openPath' },
    settings: { describe: 'settings.describe', replace: 'settings.replace', mutate: 'settings.mutate' },
    llm: { models: 'llm.models' },
    agentPresets: { list: 'agentPreset.list' },
  }
  return new Proxy({}, {
    get: (_target, domain) => new Proxy({}, {
      get: (_domainTarget, method) => async (payload: unknown) => {
        const rpcMethod = methodNames[String(domain)]?.[String(method)]
        if (rpcMethod === undefined) throw new Error(`unexpected fake method ${String(domain)}.${String(method)}`)
        return invoke(rpcMethod, payload)
      },
    }),
  }) as InProcessApiClientPort
}

function nativePermissions(): PermissionGatewayFacade {
  const provider: PermissionProvider = {
    async readCurrent() { return 'read-only' },
    async select() { return { accepted: true } },
  }
  return new PermissionGatewayFacade(provider)
}

function parseRequest(body: BodyInit | null | undefined): { rpcId: string; method: string } {
  if (typeof body !== 'string') throw new Error('missing request body')
  const parsed = JSON.parse(body) as { rpcId?: unknown; method?: unknown }
  if (typeof parsed.rpcId !== 'string' || typeof parsed.method !== 'string') throw new Error('invalid request')
  return { rpcId: parsed.rpcId, method: parsed.method }
}
