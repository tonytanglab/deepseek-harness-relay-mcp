/** Loopback JSON-RPC client for an already-running Harness Web (`dsh web`). */

export const DEFAULT_WEB_URL = 'http://127.0.0.1:3080'

interface RpcOk<T> {
  ok: true
  value: T
}

interface RpcErr {
  ok: false
  error: { message: string; code?: string }
}

interface ServerResponse<T> {
  type: 'server-response'
  rpcId: string
  result: RpcOk<T> | RpcErr
}

export interface SessionSummary {
  sessionId: string
  updatedAt: number
  running: boolean
  blank: boolean
  cwd?: string
  origin?: 'subagent'
}

export interface WorkspaceView {
  workspaceId: string
  path: string
  title: string
  sessionIds: string[]
}

export interface HarnessRpcOptions {
  /** Per-call timeout. Defaults to 30 seconds. */
  timeoutMs?: number
}

/**
 * Confirm a Harness Web origin is loopback HTTP.
 * @param value - raw URL from config or `DSH_WEB_URL`.
 * @returns the origin with no path or query.
 */
export function resolveWebUrl(value: string): string {
  const url = new URL(value)
  if (url.protocol !== 'http:' || (url.hostname !== '127.0.0.1' && url.hostname !== 'localhost')) {
    throw new Error(`dsh-relay: webUrl must be loopback HTTP, got ${JSON.stringify(value)}`)
  }
  return url.origin
}

/**
 * POST one unary Host RPC to a running Harness Web.
 * @param origin - loopback origin.
 * @param method - Host method name such as `session.list`.
 * @param payload - method payload.
 * @returns the unwrapped business value.
 */
export async function callHarness<T>(
  origin: string,
  method: string,
  payload: Record<string, unknown> = {},
  options: HarnessRpcOptions = {},
): Promise<T> {
  const rpcId = crypto.randomUUID()
  const timeoutMs = Math.max(1, Math.min(30_000, Math.trunc(options.timeoutMs ?? 30_000)))
  const response = await fetch(new URL(`/api/${method}`, origin), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId, method, payload }),
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!response.ok) throw new Error(`dsh-relay: ${method} HTTP ${String(response.status)}`)
  const full = await response.json() as ServerResponse<T>
  if (full.rpcId !== rpcId) throw new Error(`dsh-relay: rpcId mismatch for ${method}`)
  if (!full.result.ok) throw new Error(full.result.error.message)
  return full.result.value
}

/** Build the visible Harness task-page deep link. */
export function sessionUrl(origin: string, sessionId: string): string {
  const url = new URL(origin)
  url.searchParams.set('sessionId', sessionId)
  return url.href
}
