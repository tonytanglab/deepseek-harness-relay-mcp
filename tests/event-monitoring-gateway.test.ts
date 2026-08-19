import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createInProcessHarnessGateway,
  InProcessDispatchHandler,
  type GatewayHostFrame,
  type GatewayMuxFrame,
  type InProcessApiClientPort,
} from '../src/harness-gateway/index.js'
import { PermissionGatewayFacade, type PermissionProvider } from '../src/permission-gateway/index.js'

test('InProcess gateway forwards official mux and host AsyncIterables without dispatch duplication', async () => {
  const opened: string[] = []
  const client = new Proxy({}, {
    get: (_target, domain) => {
      if (domain === 'events') {
        return {
          async *mux(_payload: unknown, _signal: AbortSignal, onOpen?: () => void) {
            onOpen?.()
            yield {
              rpcId: 'mux-rpc',
              payload: { type: 'session/subscribed', sessionId: 'session-1', lastSeq: 4 } satisfies GatewayMuxFrame,
            }
          },
          async *host(_payload: unknown, _signal: AbortSignal, onOpen?: () => void) {
            onOpen?.()
            yield {
              rpcId: 'host-rpc',
              payload: { type: 'host/session-status', sessionId: 'session-1', running: true } satisfies GatewayHostFrame,
            }
          },
        }
      }
      return new Proxy({}, { get: () => async () => { throw new Error('unexpected unary call') } })
    },
  }) as InProcessApiClientPort
  const permissions = new PermissionGatewayFacade({
    async readCurrent() { return 'read-only' },
    async select() { return { accepted: true } },
  } satisfies PermissionProvider)
  const handler = new InProcessDispatchHandler({ fetch: async () => { throw new Error('unexpected fetch') } })
  const gateway = createInProcessHarnessGateway(client, permissions, handler)
  const signal = new AbortController().signal

  assert.equal(gateway.supportsEventStreams(), true)
  assert.deepEqual(await collect(gateway.openMuxEvents({}, signal, () => { opened.push('mux') })), [{
    rpcId: 'mux-rpc',
    payload: { type: 'session/subscribed', sessionId: 'session-1', lastSeq: 4 },
  }])
  assert.deepEqual(await collect(gateway.openHostEvents(signal, () => { opened.push('host') })), [{
    rpcId: 'host-rpc',
    payload: { type: 'host/session-status', sessionId: 'session-1', running: true },
  }])
  assert.deepEqual(opened, ['mux', 'host'])
})

async function collect<T>(values: AsyncIterable<T>): Promise<T[]> {
  const result: T[] = []
  for await (const value of values) result.push(value)
  return result
}
