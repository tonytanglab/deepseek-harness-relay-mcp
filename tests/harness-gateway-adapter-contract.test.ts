import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createHttpHarnessGateway,
  createInProcessHarnessGateway,
  HostRpcError,
  InProcessDispatchHandler,
  type HarnessGatewayFacade,
  type InProcessApiClientPort,
  type InProcessRpcResponse,
} from '../src/harness-gateway/index.js'
import { PermissionGatewayFacade, type PermissionProvider } from '../src/permission-gateway/index.js'

type Outcome =
  | { kind: 'success' }
  | { kind: 'failure'; code: string; message: string }

runAdapterContract('HTTP', outcome => httpGateway(outcome))
runAdapterContract('InProcess', outcome => inProcessGateway(outcome))

function runAdapterContract(name: string, create: (outcome: Outcome) => HarnessGatewayFacade): void {
  test(`${name} adapter contract returns the semantic Host description`, async () => {
    assert.deepEqual(await create({ kind: 'success' }).describeHost(), {
      version: 'rc.8', mode: 'contract', home: 'D:\\Harness\\profiles\\web',
    })
  })

  test(`${name} adapter contract consumes additive rc.8 history projections`, async () => {
    const history = await create({ kind: 'success' }).readHistory({ sessionId: 'session-1', maxMessages: 100 })
    assert.equal(history.events[0]?.event.type, 'assistant/message')
    assert.equal(history.projections?.values?.imageLimits?.maxImageDimension, 4096)
    assert.deepEqual(history.projections?.values?.imageLimits?.mediaTypes, [
      'image/png', 'image/jpeg', 'image/webp', 'image/gif',
    ])
  })

  test(`${name} adapter contract preserves definitive business rejection`, async () => {
    await assert.rejects(
      create({ kind: 'failure', code: 'model-unavailable', message: 'missing' }).describeHost(),
      (error: unknown) => assertGatewayError(error, 'model-unavailable', true, false),
    )
  })

  test(`${name} adapter contract preserves retryable internal failure`, async () => {
    await assert.rejects(
      create({ kind: 'failure', code: 'internal', message: 'temporary' }).describeHost(),
      (error: unknown) => assertGatewayError(error, 'internal', false, true),
    )
  })
}

function httpGateway(outcome: Outcome): HarnessGatewayFacade {
  return createHttpHarnessGateway('http://127.0.0.1:3080/', 1_000, async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as { rpcId: string }
    const request = JSON.parse(String(init?.body)) as { method: string }
    if (request.method === 'session.history') {
      return Response.json({ rpcId: body.rpcId, result: { ok: true, value: rc8History() } })
    }
    return Response.json({
      rpcId: body.rpcId,
      result: outcome.kind === 'success'
        ? { ok: true, value: { version: 'rc.8', mode: 'contract', home: 'D:\\Harness\\profiles\\web' } }
        : { ok: false, error: { code: outcome.code, message: outcome.message, details: {} } },
    })
  })
}

function inProcessGateway(outcome: Outcome): HarnessGatewayFacade {
  const client = new Proxy({}, {
    get: (_target, domain) => {
      if (domain === 'sessions') {
        return {
          async history(): Promise<InProcessRpcResponse<ReturnType<typeof rc8History>>> {
            return { rpcId: 'in-process-history', result: { ok: true, value: rc8History() } }
          },
        }
      }
      if (domain !== 'host') return new Proxy({}, { get: () => async () => { throw new Error('unexpected method') } })
      return {
        async describe(): Promise<InProcessRpcResponse<Record<string, unknown>>> {
          return {
            rpcId: 'in-process-contract',
            result: outcome.kind === 'success'
              ? { ok: true, value: { version: 'rc.8', mode: 'contract', home: 'D:\\Harness\\profiles\\web' } }
              : { ok: false, error: { code: outcome.code, message: outcome.message, details: {} } },
          }
        },
        async openPath(): Promise<never> { throw new Error('unexpected method') },
      }
    },
  }) as InProcessApiClientPort
  const unusedHandler = new InProcessDispatchHandler({ fetch: async () => { throw new Error('unexpected dispatch') } })
  return createInProcessHarnessGateway(client, nativePermissions(), unusedHandler)
}

function nativePermissions(): PermissionGatewayFacade {
  const provider: PermissionProvider = {
    async readCurrent() { return 'read-only' },
    async select() { return { accepted: true } },
  }
  return new PermissionGatewayFacade(provider)
}

function assertGatewayError(error: unknown, code: string, definitive: boolean, retryable: boolean): true {
  assert(error instanceof HostRpcError)
  assert.equal(error.code, code)
  assert.equal(error.definitiveRejection, definitive)
  assert.equal(error.retryable, retryable)
  return true
}

function rc8History() {
  return {
    events: [{
      event: {
        type: 'assistant/message',
        seq: 4,
        time: 1786800000004,
        data: { message: { content: [{ type: 'text', text: 'rc.8 final' }], interrupted: true } },
      },
    }],
    hasMore: false,
    projections: {
      values: {
        imageLimits: {
          maxImageDimension: 4096,
          maxPixels: 16_777_216,
          maxImages: 20,
          maxMessageBytes: 104_857_600,
          mediaTypes: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'],
        },
      },
    },
  }
}
