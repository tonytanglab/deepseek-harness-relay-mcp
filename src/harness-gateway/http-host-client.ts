import { randomUUID } from 'node:crypto'
import { HostRpcError, isTransientHostCode } from './host-errors.js'
import type { BeforeDispatch } from './types.js'

interface RpcSuccess<T> { ok: true; value: T }
interface RpcFailure { ok: false; error: { code: string; message: string; details?: unknown } }

export class HttpHostClient {
  constructor(private readonly baseUrl: string, private readonly timeoutMs: number, private readonly fetchImpl: typeof fetch = fetch) {}

  async call<T>(method: string, payload: object, rpcId: string = randomUUID(), beforeDispatch?: BeforeDispatch): Promise<T> {
    await beforeDispatch?.(rpcId)
    const response = await this.fetchImpl(new URL(`/api/${method}`, this.baseUrl), {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ type: 'client-request', rpcId, method, payload }),
      signal: AbortSignal.timeout(this.timeoutMs),
    })
    if (!response.ok) {
      const retryable = response.status === 408 || response.status === 429 || response.status >= 500
      throw new HostRpcError(`${method} transport failed: HTTP ${response.status}`, !retryable, `HOST_HTTP_${response.status}`, retryable)
    }
    const envelope = await response.json() as { rpcId?: unknown; result?: RpcSuccess<T> | RpcFailure }
    if (envelope.rpcId !== rpcId) throw new HostRpcError(`${method} returned a mismatched rpcId`, false, 'HOST_RPC_ID_MISMATCH', true)
    if (envelope.result === undefined) throw new HostRpcError(`${method} returned no result`, false, 'HOST_RPC_NO_RESULT', true)
    if (!envelope.result.ok) {
      const code = envelope.result.error.code
      const retryable = isTransientHostCode(code)
      throw new HostRpcError(`${method} failed: ${code}: ${envelope.result.error.message}`, !retryable, code, retryable, envelope.result.error.details)
    }
    return envelope.result.value
  }

  async callRemote<T>(method: string, args: object, rpcId: string = randomUUID()): Promise<T> {
    return this.call<T>(method, { args }, rpcId)
  }
}
