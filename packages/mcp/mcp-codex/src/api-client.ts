/** Typed HTTP/SSE client used by the Codex supervisor to drive one Web child. */

import type { ApiProxy, HostFrame, MuxFrame, RpcRequest } from '@deepseek-ai/dsh-host-apiproxy/api'
import { hostFrameSchema, muxFrameSchema } from '@deepseek-ai/dsh-host-apiproxy/api/events.schema'
import { serverRequestSchema } from '@deepseek-ai/dsh-host-apiproxy/api/rpc.schema'
import { AbstractApiClient } from '@deepseek-ai/dsh-host-apiproxy/client'

type SocketItem<F> =
  | { kind: 'frame'; envelope: RpcRequest<F> }
  | { kind: 'end' }
  | { kind: 'error'; error: Error }
type Parser<F> = { parse(value: unknown): F }

/** ApiProxy fetch carrier whose base URL is one managed Web child. */
export class CodexWebApiClient extends AbstractApiClient {
  /**
   * @param baseUrl - validated loopback origin of the managed Web child.
   * @param timeoutMs - unary RPC deadline.
   */
  constructor(private readonly baseUrl: string, timeoutMs: number) {
    super(timeoutMs)
  }

  protected override resolveBase(): string {
    return this.baseUrl
  }

  protected doFetch(input: URL, init?: RequestInit): Promise<Response> {
    return globalThis.fetch(input, init)
  }

  protected override openMux(
    _payload: Parameters<ApiProxy['events']['mux']>[0]['payload'],
    signal: AbortSignal,
    onOpen?: () => void,
  ): AsyncIterable<RpcRequest<MuxFrame>> {
    return this.readWebSocket('/api/events.mux', signal, muxFrameSchema, onOpen)
  }

  protected override openHost(
    _payload: Parameters<ApiProxy['events']['host']>[0]['payload'],
    signal: AbortSignal,
    onOpen?: () => void,
  ): AsyncIterable<RpcRequest<HostFrame>> {
    return this.readWebSocket('/api/events.host', signal, hostFrameSchema, onOpen)
  }

  private async *readWebSocket<F extends MuxFrame | HostFrame>(
    path: string,
    signal: AbortSignal,
    frameSchema: Parser<F>,
    onOpen?: () => void,
  ): AsyncGenerator<RpcRequest<F>> {
    const url = new URL(path, this.baseUrl)
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
    const socket = new WebSocket(url)
    const inbox: SocketItem<F>[] = []
    let wake: (() => void) | undefined
    const enqueue = (item: SocketItem<F>): void => {
      inbox.push(item)
      wake?.()
      wake = undefined
    }
    const handleOpen = (): void => { onOpen?.() }
    const handleMessage = (event: MessageEvent): void => {
      try {
        if (typeof event.data !== 'string') throw new Error('binary WebSocket frame')
        const full = serverRequestSchema.parse(JSON.parse(event.data))
        const frame = frameSchema.parse(full.payload)
        this.onEnvelope(full)
        enqueue({ kind: 'frame', envelope: { rpcId: full.rpcId, payload: frame } })
      } catch (error) {
        process.stderr.write(`mcp-codex: dropping malformed WebSocket frame on ${path}: ${errorText(error)}\n`)
      }
    }
    const handleClose = (): void => { enqueue({ kind: 'end' }) }
    const handleError = (): void => { enqueue({ kind: 'error', error: new Error(`WebSocket failed for ${path}`) }) }
    const handleAbort = (): void => {
      if (socket.readyState === WebSocket.CONNECTING || socket.readyState === WebSocket.OPEN) socket.close()
    }
    socket.addEventListener('open', handleOpen)
    socket.addEventListener('message', handleMessage)
    socket.addEventListener('close', handleClose, { once: true })
    socket.addEventListener('error', handleError, { once: true })
    signal.addEventListener('abort', handleAbort, { once: true })
    if (signal.aborted) handleAbort()
    try {
      while (true) {
        while (inbox.length > 0) {
          const item = inbox.shift() as SocketItem<F>
          if (item.kind === 'end') return
          if (item.kind === 'error') throw item.error
          yield item.envelope
        }
        await new Promise<void>((resolve) => { wake = resolve })
      }
    } finally {
      signal.removeEventListener('abort', handleAbort)
      socket.removeEventListener('open', handleOpen)
      socket.removeEventListener('message', handleMessage)
      socket.removeEventListener('close', handleClose)
      socket.removeEventListener('error', handleError)
      handleAbort()
    }
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
