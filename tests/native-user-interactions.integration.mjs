/** Opt-in artifact integration: pnpm exec tsx tests/native-user-interactions.integration.mjs <Harness root>. */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'
import { UserInteractionFacade, installNativeAnswerer, nativeInteractionOwner } from '../src/user-interactions/index.ts'

const root = process.argv[2]
if (!root) throw new Error('Pass the built Harness checkout root as the first argument.')
// Resolve only public package exports from workspace package resolution contexts.
const approvalRequire = createRequire(resolve(root, 'packages/interaction/user-approval/package.json'))
const questionsRequire = createRequire(resolve(root, 'packages/interaction/user-questions/package.json'))
const load = (resolver, name) => import(pathToFileURL(resolver.resolve(name)).href)
const { Context } = await load(approvalRequire, '@deepseek-ai/cordis')
const { default: ApprovalService, setApprovalPolicy } = await load(approvalRequire, '@deepseek-ai/dsh-user-approval')
const { default: UserQuestionService } = await load(questionsRequire, '@deepseek-ai/dsh-user-questions')
const { Session, SessionId } = await load(approvalRequire, '@deepseek-ai/dsh-session')
const { default: AgentRegistry } = await load(approvalRequire, '@deepseek-ai/dsh-agent')
const { createScope } = await load(approvalRequire, '@deepseek-ai/dsh-scope')

async function fixture() {
  const ctx = new Context()
  const fibers = [await ctx.plugin(AgentRegistry), await ctx.plugin(ApprovalService), await ctx.plugin(UserQuestionService)]
  const session = Session.create(SessionId('native-interaction-test'))
  session.append('turn/start', { turn: 0 })
  // Only the Agent driver is a stub: no loop, provider, tools, filesystem or LLM.
  const agent = { id: session.id, session }
  const scope = createScope(ctx, agent)
  agent.ctx = scope.ctx
  const detach = ctx.agents.enter(agent, undefined)
  const owner = { runId: 'native-run', sessionId: session.id, clientPrincipalId: 'test-supervisor' }
  const interactions = new UserInteractionFacade(candidate => nativeInteractionOwner(ctx, candidate, id => id === session.id ? owner : undefined))
  let ordinaryCalls = 0
  const ordinary = ctx.on('approval/request', async () => { ordinaryCalls++; return 'rejected' })
  const remove = installNativeAnswerer(ctx, interactions)
  return {
    ctx, agent, session, scope, interactions, owner,
    ordinaryCalls: () => ordinaryCalls,
    async close() {
      remove()
      ordinary()
      detach()
      await scope.dispose()
      for (const fiber of fibers.reverse()) await fiber.dispose()
    },
  }
}

async function pending(fixture, kind) {
  // Native approval dispatch enters a promise microtask; bound discovery to one second.
  const deadline = Date.now() + 1000
  while (Date.now() < deadline) {
    const ticket = fixture.interactions.list(fixture.owner.runId, fixture.owner.clientPrincipalId)[0]
    if (ticket) { assert.equal(ticket.kind, kind); return ticket }
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  assert.fail(`Native ${kind} did not reach the Relay answerer`)
}

test('native approval audit and never policy preserve one-shot decisions', { timeout: 5000 }, async () => {
  const f = await fixture()
  try {
    const result = f.ctx.approval.request({ agent: f.agent, toolName: 'shell', callId: 'call-1', reason: 'test-only escalation' })
    const ticket = await pending(f, 'approval')
    f.interactions.respond(f.owner.runId, ticket.requestId, f.owner.clientPrincipalId, {
      kind: 'approval', decision: 'allowed-once', authorizationBasis: 'explicit-user-approval', explanation: 'Integration fixture only',
    })
    assert.equal(await result, 'allowed-once')
    assert.equal(f.ordinaryCalls(), 0)
    const audit = f.session.snapshotEvents().filter(event => event.type.startsWith('approval/'))
    assert.deepEqual(audit.map(event => event.type), ['approval/asked', 'approval/decided'])
    assert.equal(audit[0].data.id, audit[1].data.id)
    assert.equal(audit[1].data.outcome, 'allowed-once')
    setApprovalPolicy(f.session, 'never')
    assert.equal(await f.ctx.approval.request({ agent: f.agent, toolName: 'shell' }), 'rejected')
    assert.deepEqual(f.interactions.list(f.owner.runId, f.owner.clientPrincipalId), [])
    assert.equal(f.ordinaryCalls(), 0)
    assert.equal(f.session.snapshotEvents().at(-1).data.outcome, 'rejected')
  } finally { await f.close() }
})

test('native questions preserve answer/skip and distinguish explicit cancellation', { timeout: 5000 }, async () => {
  const f = await fixture()
  try {
    const questions = [{ id: 'plan', question: 'Proceed?', detail: 'Fixture only', options: [{ label: 'Yes' }, { label: 'No' }], intent: { kind: 'plan-review', approve: 'Yes' } }, { id: 'optional', question: 'Additional note?' }]
    const result = f.ctx.userQuestions.ask({ agent: f.agent, questions })
    const ticket = await pending(f, 'question')
    assert.deepEqual(ticket.questions, questions)
    const answer = { answers: [{ id: 'plan', selected: ['Yes'] }, { id: 'optional', selected: [] }] }
    f.interactions.respond(f.owner.runId, ticket.requestId, f.owner.clientPrincipalId, { kind: 'question', answer })
    assert.deepEqual(await result, answer)
    const cancelled = f.ctx.userQuestions.ask({ agent: f.agent, questions })
    const rejected = assert.rejects(cancelled, { name: 'UserQuestionError', code: 'ASK_CANCELLED' })
    const next = await pending(f, 'question')
    f.interactions.respond(f.owner.runId, next.requestId, f.owner.clientPrincipalId, { kind: 'cancel' })
    await rejected
  } finally { await f.close() }
})

test('real Agent context unload cancels pending requests without a signal or another poll', { timeout: 5000 }, async () => {
  const f = await fixture()
  try {
    const approval = f.ctx.approval.request({ agent: f.agent, toolName: 'shell' })
    await pending(f, 'approval')
    const question = f.ctx.userQuestions.ask({ agent: f.agent, questions: [{ id: 'q', question: 'Name?' }] })
    const rejected = assert.rejects(question, { name: 'UserQuestionError', code: 'ASK_ABORTED' })
    assert.equal(f.interactions.list(f.owner.runId, f.owner.clientPrincipalId).length, 2)
    await f.scope.dispose()
    assert.equal(await approval, 'cancelled')
    await rejected
    assert.deepEqual(f.interactions.list(f.owner.runId, f.owner.clientPrincipalId), [])
    assert.equal(f.session.snapshotEvents().at(-1).data.outcome, 'cancelled')
  } finally { await f.close() }
})
