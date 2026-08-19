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
      error: '429 overloaded',
      text: 'partial',
    })
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
