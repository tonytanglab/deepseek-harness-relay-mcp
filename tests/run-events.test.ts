import assert from 'node:assert/strict'
import test from 'node:test'
import { finalAssistantText } from '../src/run-events.js'
import type { RpcEvent } from '../src/types.js'

test('finalAssistantText never exposes reasoning-only assistant content', () => {
  assert.equal(finalAssistantText([
    assistantMessage(1, [{ type: 'reasoning', text: 'private chain of thought' }]),
    { type: 'turn/end', seq: 2, time: 2, data: { reason: { kind: 'completed' } } },
  ]), '')
})

test('finalAssistantText retains text while excluding adjacent reasoning blocks', () => {
  assert.equal(finalAssistantText([
    assistantMessage(1, [
      { type: 'reasoning', text: 'private chain of thought' },
      { type: 'text', text: 'public answer' },
      { type: 'reasoning', text: 'more private reasoning' },
    ]),
  ]), 'public answer')
})

test('finalAssistantText does not project reasoning from a non-terminal event stream', () => {
  assert.equal(finalAssistantText([
    { type: 'user/message', seq: 1, time: 1, data: { message: { content: 'question' } } },
    assistantMessage(2, [{ type: 'reasoning', text: 'in-progress private reasoning' }]),
  ]), '')
})

function assistantMessage(seq: number, content: unknown[]): RpcEvent {
  return { type: 'assistant/message', seq, time: seq, data: { message: { content } } }
}
