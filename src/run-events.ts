import type { RpcEvent, RunStatus } from './types.js'

export function mergeEvents(left: RpcEvent[], right: RpcEvent[]): RpcEvent[] {
  const bySeq = new Map(left.map(event => [event.seq, event]))
  for (const event of right) bySeq.set(event.seq, event)
  return [...bySeq.values()].sort((a, b) => a.seq - b.seq)
}

export function highestSeq(events: RpcEvent[], fallback: number): number {
  return events.reduce((highest, event) => Math.max(highest, event.seq), fallback)
}

export function userRpcId(event: RpcEvent): string | null {
  if (event.type !== 'user/message') return null
  const source = objectAt(event.data, 'source')
  return source === null ? null : stringAt(source, 'rpcId')
}

export function finalAssistantText(events: RpcEvent[]): string {
  const messages = events.flatMap(event => {
    if (event.type !== 'assistant/message') return []
    const message = objectAt(event.data, 'message')
    const content = message?.content ?? event.data.content
    if (typeof content === 'string') return [[{ type: 'text', text: content }]]
    return Array.isArray(content) ? [content] : []
  })
  const text = messages.flatMap(content => {
    const blocks = content.flatMap(block => isRecord(block) && block.type === 'text' && typeof block.text === 'string' ? [block.text] : [])
    return blocks.length === 0 ? [] : [blocks.join('\n')]
  })
  if (text.length > 0) return text.join('\n\n')
  return messages.flatMap(content => content.flatMap(block =>
    isRecord(block) && block.type === 'reasoning' && typeof block.text === 'string' ? [block.text] : [],
  )).join('\n\n')
}

/**
 * Returns whether the last assistant surface event in a run was interrupted.
 *
 * rc.8 places the marker beside the assistant message under the event data;
 * the nested fallback keeps the projection defensive for early fixtures that
 * attached it to the message object itself.
 */
export function finalAssistantInterrupted(events: RpcEvent[]): boolean {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event?.type !== 'assistant/message') continue
    if (event.data.interrupted === true) return true
    const message = objectAt(event.data, 'message')
    return message?.interrupted === true
  }
  return false
}

export function terminalOutcome(event: RpcEvent, cancelRequested: boolean, interrupted = false): { status: Exclude<RunStatus, 'running' | 'needs_attention' | 'unknown'>; error: string | null; warning?: string } {
  const reason = objectAt(event.data, 'reason')
  const kind = reason === null ? null : stringAt(reason, 'kind')
  if (kind === 'completed') {
    return interrupted
      ? {
          status: 'incomplete',
          error: null,
          warning: 'Harness marked the final assistant output as interrupted; the retained result is partial and may be continued with reply_run',
        }
      : { status: 'succeeded', error: null }
  }
  if (kind === 'aborted') {
    const detail = objectAt(reason ?? {}, 'reason')
    const detailKind = detail === null ? null : stringAt(detail, 'kind')
    return detailKind === 'user' || cancelRequested
      ? { status: 'cancelled', error: null }
      : { status: 'failed', error: `turn aborted: ${detailKind ?? 'unknown'}` }
  }
  if (kind === 'error') {
    const detail = objectAt(reason ?? {}, 'error')
    return { status: 'failed', error: `${detail === null ? 'ERROR' : stringAt(detail, 'code') ?? 'ERROR'}: ${detail === null ? 'turn failed' : stringAt(detail, 'message') ?? 'turn failed'}` }
  }
  if (kind === 'max-tokens') return { status: 'incomplete', error: null, warning: 'Harness reached the model output-token ceiling; the retained result is partial and may be continued with reply_run' }
  return { status: 'failed', error: `turn ended: ${kind ?? 'unknown'}` }
}

export function utf8Tail(text: string, maxBytes: number): { text: string; bytes: number; truncated: boolean } {
  const buffer = Buffer.from(text, 'utf8')
  if (buffer.byteLength <= maxBytes) return { text, bytes: buffer.byteLength, truncated: false }
  let start = buffer.byteLength - maxBytes
  while (start < buffer.byteLength && (buffer[start] ?? 0) >>> 6 === 2) start += 1
  const retained = buffer.subarray(start).toString('utf8')
  return { text: retained, bytes: Buffer.byteLength(retained), truncated: true }
}

export function stringAt(value: Record<string, unknown>, key: string): string | null {
  const candidate = value[key]
  return typeof candidate === 'string' ? candidate : null
}

function objectAt(value: Record<string, unknown>, key: string): Record<string, unknown> | null {
  const candidate = value[key]
  return isRecord(candidate) ? candidate : null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
