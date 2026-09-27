import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { RelayFacade } from '../src/relay-broker/index.js'
import { resolveConfig } from '../src/config.js'
import { createServer } from '../src/server.js'
import { UserInteractionFacade, type PendingInteraction } from '../src/user-interactions/index.js'
import type { RpcEvent } from '../src/types.js'

test('MCP wait surfaces a suspended native approval, responds once, resumes the same run and retains permission mode', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'relay-interaction-test-'))
  const workspace = fileURLToPath(new URL('../', import.meta.url))
  const stateFile = join(directory, 'state.json')
  const events: RpcEvent[] = []
  let running = false
  let permission = 'read-only'
  let promptCount = 0
  const config = resolveConfig({ DSH_RELAY_STATE_FILE: stateFile, DSH_RELAY_CLIENT_PRINCIPAL_ID: 'cursor:user', DSH_RELAY_ALLOWED_WORKSPACE_ROOTS: workspace })
  const fakeFetch: typeof fetch = async (_input, init) => {
    const req = JSON.parse(String(init?.body)) as { method: string; rpcId: string; payload: Record<string, unknown> }
    let value: unknown
    switch (req.method) {
      case 'host.describe': value = {}; break
      case 'workspace.list': value = { items: [{ workspaceId: 'workspace-1', path: workspace, sessionIds: [] }] }; break
      case 'session.create': value = { sessionId: 'session-1' }; break
      case 'session.list': value = { items: [{ sessionId: 'session-1', running }] }; break
      case 'session.history': value = { events: events.map(event => ({ event })), hasMore: false, projections: { values: { permissions: { currentValue: permission } } } }; break
      case 'commands/execute': permission = String((req.payload.args as { value?: string })?.value ?? permission); value = { result: { kind: 'success' } }; break
      case 'session.prompt':
        promptCount++
        running = true
        events.push({ type: 'user/message', seq: 1, time: Date.now(), data: { id: 'message-1', source: { rpcId: req.rpcId } } })
        value = { accepted: true, messageId: 'message-1' }; break
      default: throw new Error(`Unexpected method ${req.method}`)
    }
    return new Response(JSON.stringify({ type: 'server-response', rpcId: req.rpcId, result: { ok: true, value } }))
  }
  const interactions: UserInteractionFacade = new UserInteractionFacade(agent => relay.interactionOwner(agent.session.id))
  const relay: RelayFacade = new RelayFacade(config, fakeFetch, undefined, {
    interactions,
    stateStore: { permissions: { platform: 'linux', async restrict() {}, async check() { return { restricted: true } } } },
  })
  const [a, b] = InMemoryTransport.createLinkedPair()
  const server = createServer(relay, config, undefined, 'cursor:user')
  const client = new Client({ name: 'approval-integration', version: 'test' })
  await server.connect(b)
  await client.connect(a)
  try {
    const started = await relay.startRun({ workspace, task: 'bounded review' })
    events.push({ type: 'tool/call', seq: 2, time: Date.now(), data: { callId: 'call-1', name: 'read_file', arguments: '{"path":"src/example.ts"}' } })
    const pending = interactions.approval({ agent: { id: 'agent-1', session: { id: 'session-1' }, ctx: { effect(install) { return install() } } }, toolName: 'read_file', callId: 'call-1', reason: 'Read a requested file' }, async () => 'unavailable')
    config.runStallMs = 0
    const waiting = await client.callTool({ name: 'wait_run', arguments: { runId: started.runId, timeoutMs: 30_000 } })
    assert.equal(waiting.isError, undefined)
    const view = waiting.structuredContent as { status: string; pendingInteractions: PendingInteraction[]; hostPollContract: { nextTool: string; runComplete: boolean } }
    assert.equal(view.status, 'needs_attention')
    const repeated = await relay.getRun(started.runId)
    assert.equal(repeated.attentionReason, 'permission_confirm', 'Waiting for a real response must not become run_stalled')
    config.runStallMs = 300_000
    assert.equal(view.hostPollContract.nextTool, 'list_run_interactions')
    assert.equal(view.hostPollContract.runComplete, false)
    const ticket = view.pendingInteractions[0]!
    const summary = await client.callTool({ name: 'get_run_summary', arguments: { runId: started.runId } })
    assert.equal((summary.structuredContent as {nextAction: string}).nextAction, 'respond-interaction')
    assert.equal(ticket.kind === 'approval' && (ticket.toolCall as {name: string}).name, 'read_file')
    assert.deepEqual((await relay.listRunInteractions(started.runId, 'codex:user') as {requests: unknown[]}).requests, [])
    assert.equal((await relay.getRun(started.runId, 'codex:user')).pendingInteractions, undefined)
    assert.equal((await readFile(stateFile, 'utf8')).includes(ticket.requestId), false, 'No resumable approval tokens in durable state')
    const result = await client.callTool({ name: 'respond_to_run_interaction', arguments: { runId: started.runId, requestId: ticket.requestId, response: { kind: 'approval', decision: 'allowed-once', authorizationBasis: 'within-authorized-task', explanation: 'Read operation within requested scope' } } })
    assert.equal(result.isError, undefined)
    assert.equal(await pending, 'allowed-once')
    assert.equal((await relay.getRun(started.runId)).status, 'running')
    assert.equal(promptCount, 1, 'Respond must not submit a continuation prompt')
    assert.equal(permission, 'read-only', 'Respond must not change the permission preset')
    const duplicate = await client.callTool({ name: 'respond_to_run_interaction', arguments: { runId: started.runId, requestId: ticket.requestId, response: { kind: 'cancel' } } })
    assert.equal(duplicate.isError, true)
    assert.equal((duplicate.structuredContent as {code: string}).code, 'INTERACTION_NOT_PENDING')
    running = false
    events.push({type:'turn/end',seq:3,time:Date.now(),data:{reason:{kind:'completed'}}})
    assert.equal((await relay.getRun(started.runId)).status, 'succeeded')
  } finally {
    interactions.dispose()
    await client.close()
    await server.close()
    await rm(directory, { recursive: true, force: true })
  }
})
