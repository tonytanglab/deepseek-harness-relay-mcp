/** Pure helpers for workspace fences and Harness turn terminal state. */

import { isAbsolute, resolve, sep } from 'node:path'

export interface HistoryEvent {
  type: string
  seq: number
  data?: {
    reason?: {
      kind?: string
      reason?: { kind?: string }
      error?: { message?: string; code?: string }
    }
    message?: { content?: Array<{ type?: string; text?: string }> }
  }
}

export interface TurnInspection {
  ended: boolean
  status: 'succeeded' | 'failed' | 'cancelled' | null
  error: string | null
  text: string | null
}

export interface HistoryPage {
  events: Array<{ event?: HistoryEvent } & Partial<HistoryEvent>>
}

/**
 * Resolve workspace against configured roots so `..` cannot escape.
 * @param workspace - caller-supplied path.
 * @param roots - allowed absolute roots; empty means unrestricted.
 */
export function isInsideWorkspace(workspace: string, roots: string[]): boolean {
  if (!isAbsolute(workspace)) return false
  if (roots.length === 0) return true
  const ws = resolve(workspace)
  return roots.some(root => {
    const rt = resolve(root)
    if (process.platform === 'win32') {
      const left = ws.toLowerCase()
      const right = rt.toLowerCase()
      if (left === right) return true
      const prefix = right.endsWith(sep) ? right : `${right}${sep}`
      return left.startsWith(prefix)
    }
    if (ws === rt) return true
    const prefix = rt.endsWith(sep) ? rt : `${rt}${sep}`
    return ws.startsWith(prefix)
  })
}

/** Highest seq in a history page; `-1` when empty. */
export function maxEventSeq(events: HistoryEvent[]): number {
  return events.reduce((max, event) => Math.max(max, event.seq), -1)
}

/** Unwrap Host `session.history` entries into raw events. */
export function unwrapHistory(page: HistoryPage): HistoryEvent[] {
  return page.events.map(entry => {
    const event = entry.event ?? entry
    return {
      type: event.type ?? '',
      seq: event.seq ?? 0,
      data: event.data,
    }
  })
}

/**
 * Decide terminal status from events after `afterSeq`.
 * Ignores `session.list` idle so a prompt that has not started a turn stays running.
 * Reason kinds follow the Harness wire protocol (`completed` / `aborted` /
 * `error` / `blocked` / `interrupted` / `max-tokens`); there is no `cancelled`
 * kind — a user stop arrives as `aborted` with `reason.kind: 'user'`.
 */
export function inspectTurn(events: HistoryEvent[], afterSeq: number, cancelRequested: boolean): TurnInspection {
  const later = events.filter(event => event.seq > afterSeq)
  const text = lastAssistantText(later)
  const end = later.filter(event => event.type === 'turn/end').at(-1)
  if (end === undefined) return { ended: false, status: null, error: null, text }
  const reason = end.data?.reason
  switch (reason?.kind) {
    case 'completed':
      return { ended: true, status: 'succeeded', error: null, text }
    case 'aborted': {
      const why = reason.reason?.kind
      if (why === 'user' || cancelRequested) {
        return { ended: true, status: 'cancelled', error: null, text }
      }
      return { ended: true, status: 'failed', error: `turn aborted${why === undefined ? '' : `: ${why}`}`, text }
    }
    case 'error': {
      const message = reason.error?.message?.trim() || 'Harness turn failed'
      const code = reason.error?.code?.trim()
      return { ended: true, status: 'failed', error: code ? `${code}: ${message}` : message, text }
    }
    case 'blocked':
      return { ended: true, status: 'failed', error: 'turn blocked', text }
    case 'interrupted':
      return { ended: true, status: 'failed', error: 'turn interrupted', text }
    case 'max-tokens':
      return { ended: true, status: 'failed', error: 'turn reached the output-token limit', text }
    default:
      return { ended: true, status: 'failed', error: `unknown turn end: ${JSON.stringify(reason ?? null)}`, text }
  }
}

function lastAssistantText(events: HistoryEvent[]): string | null {
  let text: string | null = null
  for (const event of events) {
    if (event.type !== 'assistant/message') continue
    const joined = (event.data?.message?.content ?? [])
      .filter(block => block.type === 'text' && (block.text ?? '').trim() !== '')
      .map(block => block.text ?? '')
      .join('\n')
      .trim()
    if (joined !== '') text = joined
  }
  return text
}
