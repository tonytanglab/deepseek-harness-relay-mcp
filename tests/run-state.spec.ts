import { resolve, sep } from 'node:path'
import { describe, expect, it } from 'vitest'
import { inspectTurn, isInsideWorkspace, maxEventSeq, unwrapHistory } from '../src/run-state.ts'

describe('inspectTurn', () => {
  it('stays running until turn/end even if the list looks idle', () => {
    const events = unwrapHistory({
      events: [
        { type: 'user/message', seq: 7, data: { message: { content: [{ type: 'text', text: 'hi' }] } } },
        { type: 'assistant/message', seq: 8, data: { message: { content: [{ type: 'text', text: 'working' }] } } },
      ],
    })
    expect(inspectTurn(events, 0, false)).toEqual({
      ended: false,
      status: null,
      error: null,
      text: 'working',
    })
  })

  it('marks RATE_LIMIT turn/end as failed and keeps assistant text', () => {
    const events = unwrapHistory({
      events: [
        { type: 'turn/end', seq: 3, data: { reason: { kind: 'completed' } } },
        { type: 'assistant/message', seq: 10, data: { message: { content: [{ type: 'text', text: 'partial' }] } } },
        {
          type: 'turn/end',
          seq: 12,
          data: { reason: { kind: 'error', error: { message: '429 overloaded', code: 'RATE_LIMIT' } } },
        },
      ],
    })
    expect(inspectTurn(events, 3, false)).toEqual({
      ended: true,
      status: 'failed',
      error: 'RATE_LIMIT: 429 overloaded',
      text: 'partial',
    })
  })

  it('maps a user abort to cancelled and a non-user abort to failed', () => {
    const userStop = unwrapHistory({
      events: [{ type: 'turn/end', seq: 5, data: { reason: { kind: 'aborted', reason: { kind: 'user' } } } }],
    })
    expect(inspectTurn(userStop, 0, false)).toMatchObject({ ended: true, status: 'cancelled', error: null })
    const legacy = unwrapHistory({
      events: [{ type: 'turn/end', seq: 5, data: { reason: { kind: 'aborted', reason: { kind: 'legacy' } } } }],
    })
    expect(inspectTurn(legacy, 0, false)).toMatchObject({ ended: true, status: 'failed', error: 'turn aborted: legacy' })
    // A Relay-requested cancellation wins even over a non-user abort kind.
    expect(inspectTurn(legacy, 0, true)).toMatchObject({ ended: true, status: 'cancelled' })
  })

  it('maps blocked, interrupted, and max-tokens to failed instead of succeeded', () => {
    for (const [kind, error] of [
      ['blocked', 'turn blocked'],
      ['interrupted', 'turn interrupted'],
      ['max-tokens', 'turn reached the output-token limit'],
    ] as const) {
      const events = unwrapHistory({ events: [{ type: 'turn/end', seq: 5, data: { reason: { kind } } }] })
      expect(inspectTurn(events, 0, false)).toMatchObject({ ended: true, status: 'failed', error })
    }
  })

  it('reports an unknown turn end kind as failed', () => {
    const events = unwrapHistory({ events: [{ type: 'turn/end', seq: 5, data: { reason: { kind: 'mystery' } } }] })
    const outcome = inspectTurn(events, 0, false)
    expect(outcome.status).toBe('failed')
    expect(outcome.error).toContain('unknown turn end')
  })

  it('ignores turn/end from earlier turns', () => {
    const events = unwrapHistory({
      events: [{ type: 'turn/end', seq: 3, data: { reason: { kind: 'completed' } } }],
    })
    expect(inspectTurn(events, 3, false).ended).toBe(false)
    expect(maxEventSeq(events)).toBe(3)
  })
})

describe('isInsideWorkspace', () => {
  it('rejects parent-directory escapes', () => {
    const root = resolve('/tmp/git')
    expect(isInsideWorkspace(resolve('/tmp/git/relay'), [root])).toBe(true)
    expect(isInsideWorkspace(resolve('/tmp/git/relay/secret'), [root])).toBe(true)
    expect(isInsideWorkspace(resolve('/tmp/git/../outside'), [root])).toBe(false)
    expect(isInsideWorkspace(resolve('/tmp/git-evil'), [root])).toBe(false)
  })

  it('requires an absolute path', () => {
    expect(isInsideWorkspace(`relative${sep}path`, [resolve('/tmp/git')])).toBe(false)
  })
})
