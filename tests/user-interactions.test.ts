import assert from 'node:assert/strict'
import test from 'node:test'
import { UserInteractionFacade, nativeInteractionOwner, installNativeAnswerer, type InteractionAgent, type InteractionOwner, type NativeInteractionContext } from '../src/user-interactions/index.js'

function fixture() {
  const cleanup = new Set<() => void>()
  const agent: InteractionAgent = { id: 'agent-1', session: { id: 'session-1' }, ctx: { effect(install) { const stop = install(); cleanup.add(stop); return () => { cleanup.delete(stop); stop() } } } }
  let owner: InteractionOwner | undefined = { runId: 'run-1', sessionId: 'session-1', clientPrincipalId: 'cursor:user' }
  const facade = new UserInteractionFacade(candidate => candidate === agent ? owner : undefined)
  const request = () => facade.list('run-1', 'cursor:user')[0]!
  return { agent, facade, request, cleanup, clearOwner: () => { owner = undefined } }
}

test('one-shot approval exposes exact context and rejects wrong owner, missing authority and duplicate responses', async () => {
  const { agent, facade, request } = fixture()
  const pending = facade.approval({ agent, toolName: 'shell', callId: 'call-1', reason: 'write outside sandbox' }, async () => { throw new Error('must not reach UI') })
  const ticket = request()
  assert.equal(ticket.kind, 'approval')
  assert.equal(ticket.kind === 'approval' && ticket.callId, 'call-1')
  assert.deepEqual(facade.list('run-1', 'codex:user'), [])
  const response = { kind: 'approval', decision: 'allowed-once', explanation: 'User approved this exact operation', authorizationBasis: 'explicit-user-approval' } as const
  assert.throws(() => facade.respond('other-run', ticket.requestId, 'cursor:user', response), /Only the client/)
  assert.throws(() => facade.respond('run-1', ticket.requestId, 'codex:user', response), /Only the client/)
  assert.throws(() => facade.respond('run-1', ticket.requestId, 'cursor:user', { kind: 'approval', decision: 'allowed-once', explanation: 'in scope' }), /requires explicit/)
  assert.equal(facade.respond('run-1', ticket.requestId, 'cursor:user', response).accepted, true)
  assert.throws(() => facade.respond('run-1', ticket.requestId, 'cursor:user', response), /expired/)
  assert.equal(await pending, 'allowed-once')
})

test('foreign requests reach original answerer; abort, lost ownership and disposal never grant', async () => {
  const { agent, facade, request, clearOwner } = fixture()
  assert.equal(await facade.approval({ agent: { ...agent, id: 'other' }, toolName: 'shell' }, async () => 'rejected'), 'rejected')
  const controller = new AbortController()
  const pending = facade.approval({ agent, toolName: 'shell', signal: controller.signal }, async () => 'unavailable')
  const ticket = request()
  controller.abort()
  assert.equal(await pending, 'cancelled')
  assert.throws(() => facade.respond('run-1', ticket.requestId, 'cursor:user', { kind: 'cancel' }), /expired/)
  const abandoned = facade.approval({ agent, toolName: 'shell' }, async () => 'unavailable')
  clearOwner()
  assert.deepEqual(facade.list('run-1', 'cursor:user'), [])
  assert.equal(await abandoned, 'cancelled')
  const second = fixture()
  const unloaded = second.facade.approval({ agent: second.agent, toolName: 'shell' }, async () => 'unavailable')
  second.facade.dispose()
  assert.equal(await unloaded, 'cancelled')
})

test('question answers preserve plan context and validate exact IDs, choices, single selection and cancellation', async () => {
  const { agent, facade, request } = fixture()
  const pending = facade.question({ agent, questions: [{ id: 'plan', question: 'Proceed?', detail: 'Only edit src/example.ts', options: [{ label: 'Yes' }, { label: 'No' }], intent: { kind: 'plan-review', approve: 'Yes' } }] }, async () => { throw new Error('must not reach UI') })
  const ticket = request()
  assert.equal(ticket.kind === 'question' && ticket.questions[0]?.detail, 'Only edit src/example.ts')
  for (const answers of [[], [{ id: 'other', selected: ['Yes'] }], [{ id: 'plan', selected: ['Maybe'] }], [{ id: 'plan', selected: ['Yes', 'No'] }], [{ id: 'plan', selected: ['Yes'], custom: 'No' }]]) {
    assert.throws(() => facade.respond('run-1', ticket.requestId, 'cursor:user', { kind: 'question', answer: { answers } }))
  }
  const answer = { answers: [{ id: 'plan', selected: ['Yes'] }] }
  facade.respond('run-1', ticket.requestId, 'cursor:user', { kind: 'question', answer })
  assert.deepEqual(await pending, answer)
  const cancelled = facade.question({ agent, questions: [{ id: 'q', question: 'Name?' }] }, async () => ({ answers: [] }))
  const rejected = assert.rejects(cancelled, { name: 'UserQuestionError', code: 'ASK_ABORTED' })
  facade.dispose()
  await rejected
})

test('native binding prepends without global scope and rejects replaced or native-child agent identities', () => {
  const { agent, facade } = fixture()
  const calls: Array<{event: string; options: unknown}> = []
  let disposed = 0
  const ctx = {
    get: () => ({ get: () => agent, roots: () => [agent] }),
    on: (event: string, _handler: unknown, options: unknown) => { calls.push({event, options}); return () => { disposed++ } },
  } as NativeInteractionContext
  const owner = {runId:'run-1', sessionId:'session-1', clientPrincipalId:'cursor:user'}
  assert.deepEqual(nativeInteractionOwner(ctx, agent, () => owner), owner)
  assert.equal(nativeInteractionOwner(ctx, {...agent}, () => owner), undefined)
  assert.equal(nativeInteractionOwner({...ctx, get: () => ({get: () => agent, roots: () => []})}, agent, () => owner), undefined)
  const stop = installNativeAnswerer(ctx, facade)
  assert.deepEqual(calls, [{event:'approval/request', options:{prepend:true}}, {event:'user-questions/request', options:{prepend:true}}])
  stop()
  assert.equal(disposed, 2)
})

test('Agent context disposal closes requests even without a signal or subsequent polling', async () => {
  const { agent, facade, cleanup } = fixture()
  const approval = facade.approval({ agent, toolName: 'shell' }, async () => 'unavailable')
  const question = facade.question({ agent, questions: [{ id: 'q', question: 'Continue?' }] }, async () => ({answers:[]}))
  const rejected = assert.rejects(question, { code: 'ASK_ABORTED' })
  for (const stop of cleanup) stop()
  assert.equal(await approval, 'cancelled')
  await rejected
  assert.equal(cleanup.size, 0)
})

test('explicit Skip is not approval; explicit cancellation preserves native cancellation taxonomy', async () => {
  const { agent, facade, request } = fixture()
  const pending = facade.question({ agent, questions: [{ id:'q', question:'Choose?', options:[{label:'Yes'}] }] }, async () => ({answers:[]}))
  facade.respond('run-1', request().requestId, 'cursor:user', {kind:'question',answer:{answers:[{id:'q',selected:[]}]}})
  assert.deepEqual(await pending, {answers:[{id:'q',selected:[]}]})
  const cancelled = facade.question({ agent, questions:[{id:'q',question:'Name?'}] }, async () => ({answers:[]}))
  const rejected = assert.rejects(cancelled, {code:'ASK_CANCELLED'})
  facade.respond('run-1', request().requestId, 'cursor:user', {kind:'cancel'})
  await rejected
})
