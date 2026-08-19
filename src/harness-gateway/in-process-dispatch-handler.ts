import { AsyncLocalStorage } from 'node:async_hooks'
import { HostRpcError } from './host-errors.js'
import type { BeforeDispatch } from './types.js'

interface DispatchScope {
  expectedMethod: string
  beforeDispatch?: BeforeDispatch
  observed: boolean
}

interface FetchHandler {
  fetch: typeof fetch
}

/**
 * Wraps `toFetchHandler(ctx.apiProxy)` to persist the official client's minted
 * correlation id before the handler dispatches. It observes envelopes but does
 * not route or invoke ApiProxy methods itself.
 */
export class InProcessDispatchHandler implements FetchHandler {
  private readonly scopes = new AsyncLocalStorage<DispatchScope>()

  constructor(private readonly delegate: FetchHandler) {}

  readonly fetch: typeof fetch = async (input, init) => {
    const scope = this.scopes.getStore()
    if (scope === undefined) return this.delegate.fetch(input, init)
    const envelope = parseClientRequest(init?.body)
    if (envelope.method !== scope.expectedMethod) {
      throw new HostRpcError(
        `in-process client dispatched ${envelope.method} while ${scope.expectedMethod} was expected`,
        false,
        'HOST_RPC_METHOD_MISMATCH',
        true,
      )
    }
    scope.observed = true
    await scope.beforeDispatch?.(envelope.rpcId)
    return this.delegate.fetch(input, init)
  }

  /**
   * Associate one official client call with its awaited durability hook.
   * @param expectedMethod - Host API method the official client must emit.
   * @param beforeDispatch - Hook that persists the minted rpcId.
   * @param call - Official client method invocation.
   * @returns The official client response.
   */
  async run<T>(expectedMethod: string, beforeDispatch: BeforeDispatch | undefined, call: () => Promise<T>): Promise<T> {
    const scope: DispatchScope = {
      expectedMethod,
      observed: false,
      ...(beforeDispatch === undefined ? {} : { beforeDispatch }),
    }
    const result = await this.scopes.run(scope, call)
    if (!scope.observed) {
      throw new HostRpcError(
        `${expectedMethod} did not pass through the in-process fetch carrier`,
        false,
        'HOST_IN_PROCESS_DISPATCH_NOT_OBSERVED',
        true,
      )
    }
    return result
  }
}

function parseClientRequest(body: BodyInit | null | undefined): { rpcId: string; method: string } {
  if (typeof body !== 'string') {
    throw new HostRpcError('in-process client emitted a non-text request body', false, 'HOST_RPC_INVALID_REQUEST', true)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch (error: unknown) {
    throw new HostRpcError(
      `in-process client emitted invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
      false,
      'HOST_RPC_INVALID_REQUEST',
      true,
    )
  }
  if (!isRecord(parsed) || parsed.type !== 'client-request' || typeof parsed.rpcId !== 'string' || typeof parsed.method !== 'string') {
    throw new HostRpcError('in-process client emitted an invalid ClientRequest envelope', false, 'HOST_RPC_INVALID_REQUEST', true)
  }
  return { rpcId: parsed.rpcId, method: parsed.method }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
