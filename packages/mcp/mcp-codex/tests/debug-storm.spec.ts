import { it } from 'vitest'
import { createAssistantMessage, createToolResultMessage } from '@deepseek-ai/dsh-llm'
import { CallId } from '@deepseek-ai/dsh-llm/brand'
import { Session, SessionId } from '@deepseek-ai/dsh-session'

it('debug storm appends', async () => {
  const session = Session.create(SessionId('debug'))
  session.append('turn/start', { turn: 1 })
  session.append('step/start', { turn: 1, step: 1 })
  for (let i = 1; i <= 3; i++) {
    const callId = CallId(`tool-call-${i}`)
    session.append('tool/call', { turn: 1, step: 1, callId, name: `tool-${i}`, arguments: `{"n":${i}}` })
    session.append('tool/result', {
      turn: 1,
      step: 1,
      message: createToolResultMessage({ callId, content: [{ type: 'text', text: `out-${i}` }], isError: false }),
    }, { surfaceOp: 'append' })
  }
  session.append('assistant/message', {
    turn: 1,
    step: 1,
    message: createAssistantMessage({ content: [{ type: 'text', text: 'done' }], source: { provider: 'test', model: 'test' } }),
  }, { surfaceOp: 'append' })
  session.append('step/end', { turn: 1, step: 1 })
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  const { writeFileSync } = await import('node:fs')
  writeFileSync('dsh-debug-events.txt', session.events.map(event => `${event.seq}:${event.type}`).join('\n'))
})
