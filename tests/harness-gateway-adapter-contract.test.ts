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
    assert.deepEqual(await create({ kind: 'success' }).describeHost(), { version: 'rc.7', mode: 'contract' })
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
    return Response.json({
      rpcId: body.rpcId,
      result: outcome.kind === 'success'
        ? { ok: true, value: { version: 'rc.7', mode: 'contract' } }
        : { ok: false, error: { code: outcome.code, message: outcome.message, details: {} } },
    })
  })
}

function inProcessGateway(outcome: Outcome): HarnessGatewayFacade {
  const client = new Proxy({}, {
    get: (_target, domain) => {
      if (domain !== 'host') return new Proxy({}, { get: () => async () => { throw new Error('unexpected method') } })
      return {
        async describe(): Promise<InProcessRpcResponse<Record<string, unknown>>> {
          return {
            rpcId: 'in-process-contract',
            result: outcome.kind === 'success'
              ? { ok: true, value: { version: 'rc.7', mode: 'contract' } }
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
