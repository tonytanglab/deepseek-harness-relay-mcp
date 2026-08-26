import assert from 'node:assert/strict'
import test from 'node:test'
import { hostPollContract } from '../src/mcp-server/host-poll-contract.js'

test('running wait_run slices forbid concluding the host turn', () => {
  assert.deepEqual(hostPollContract('running'), {
    schemaVersion: 1,
    waitRunIsASlice: true,
    runComplete: false,
    hostMustCallWaitRunAgain: true,
    doNotConcludeHostTurn: true,
    nextTool: 'wait_run',
    consumeAssistantTextBeforeClosing: false,
  })
  assert.equal(hostPollContract('unknown').hostMustCallWaitRunAgain, true)
})

test('succeeded runs require consuming assistantText before closing', () => {
  assert.deepEqual(hostPollContract('succeeded'), {
    schemaVersion: 1,
    waitRunIsASlice: true,
    runComplete: true,
    hostMustCallWaitRunAgain: false,
    doNotConcludeHostTurn: false,
    nextTool: 'consume_assistantText',
    consumeAssistantTextBeforeClosing: true,
  })
})

test('attention and failure stay open until the host inspects them', () => {
  assert.equal(hostPollContract('needs_attention').doNotConcludeHostTurn, true)
  assert.equal(hostPollContract('needs_attention').nextTool, 'get_run_summary')
  assert.equal(hostPollContract('failed').nextTool, 'inspect_error')
  assert.equal(hostPollContract('cancelled').runComplete, true)
})
