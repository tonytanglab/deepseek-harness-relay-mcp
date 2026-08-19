import assert from 'node:assert/strict'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveConfig } from '../src/config.js'
import { RelayFacade } from '../src/relay-broker/index.js'

test('selects the model, enforces read-only, then submits the task', async () => {
  const calls: Array<{ method: string; payload: Record<string, unknown>; rpcId: string }> = []
  let historyCalls = 0
  let taskRpcId = ''
  const fakeFetch: typeof fetch = async (_input, init) => {
    const request = JSON.parse(String(init?.body)) as { method: string; payload: Record<string, unknown>; rpcId: string }
    calls.push(request)
    let value: unknown
    switch (request.method) {
      case 'host.describe': value = {}; break
      case 'workspace.create': value = { workspace: { workspaceId: 'workspace-1', path: request.payload.path, sessionIds: [] } }; break
      case 'workspace.list': value = { items: [{ workspaceId: 'workspace-1', path: fileURLToPath(new URL('../', import.meta.url)), sessionIds: [] }] }; break
      case 'session.create': value = { sessionId: 'session-1', agentPreset: 'standard' }; break
      case 'settings.describe': value = { writable: false, namespaces: [] }; break
      case 'session.selectModel': value = { selected: { provider: 'kimi-coding', model: 'k3', reasoningEffort: 'max' } }; break
      case 'session.list': value = { items: [{ sessionId: 'session-1', running: false, agentPreset: 'standard', projections: { asOfSeq: 6 } }] }; break
      case 'commands/execute': value = { commandId: 'command-1', result: { kind: 'success', text: 'preset read-only' } }; break
      case 'session.prompt': taskRpcId = request.rpcId; value = { accepted: true }; break
      case 'session.history': {
        historyCalls += 1
        if (historyCalls === 1) value = { events: [], hasMore: false, projections: { values: { permissions: { currentValue: 'read-only' } } } }
        else if (historyCalls === 2) value = { events: [{ event: { type: 'permission/preset', seq: 1, time: 1, data: {} } }], hasMore: false }
        else value = { events: [
          { event: { type: 'user/message', seq: 2, time: 2, data: { id: 'message-1', source: { kind: 'user', rpcId: taskRpcId } } } },
          { event: { type: 'user/message', seq: 3, time: 3, data: { id: 'runtime-context', source: { kind: 'plugin', plugin: '@deepseek-ai/dsh-system-prompt' } } } },
          { event: { type: 'assistant/message', seq: 4, time: 4, data: { message: { content: [{ type: 'text', text: 'partial' }] } } } },
          { event: { type: 'turn/end', seq: 5, time: 5, data: { reason: { kind: 'error', error: { code: 'TRANSPORT', message: 'retry' } } } } },
          { event: { type: 'assistant/message', seq: 6, time: 6, data: { message: { content: [{ type: 'text', text: 'reviewed' }] } } } },
          { event: { type: 'turn/end', seq: 7, time: 7, data: { reason: { kind: 'completed' } } } },
          { event: { type: 'user/message', seq: 8, time: 8, data: { id: 'other-user', source: { kind: 'user', rpcId: 'other-rpc' } } } },
          { event: { type: 'assistant/message', seq: 9, time: 9, data: { message: { content: 'other client result' } } } },
          { event: { type: 'turn/end', seq: 10, time: 10, data: { reason: { kind: 'completed' } } } },
        ], hasMore: false }
        break
      }
      default: throw new Error(`unexpected method: ${request.method}`)
    }
    return new Response(JSON.stringify({ type: 'server-response', rpcId: request.rpcId, result: { ok: true, value } }), {
      status: 200, headers: { 'content-type': 'application/json' },
    })
  }
  const config = resolveConfig({
    DSH_RELAY_HOST_URL: 'http://127.0.0.1:3080/',
    DSH_RELAY_ALLOWED_WORKSPACE_ROOTS: fileURLToPath(new URL('../', import.meta.url)),
    DSH_RELAY_STATE_FILE: join(tmpdir(), `dsh-relay-${randomUUID()}.json`),
  })
  const relay = new RelayFacade(config, fakeFetch)
  const snapshot = await relay.startRun({
    workspace: fileURLToPath(new URL('../', import.meta.url)),
    task: 'review',
    provider: 'kimi-coding',
    model: 'k3',
    reasoningEffort: 'max',
  })
  const selectionIndex = calls.findIndex(call => call.method === 'session.selectModel')
  const prompts = calls.filter(call => call.method === 'session.prompt')
  assert.ok(selectionIndex >= 0)
  assert.equal(calls.filter(call => call.method === 'commands/execute').length, 0)
  assert.equal((prompts[0]?.payload.content as Array<{ text: string }>)[0]?.text, 'review')
  assert.ok(selectionIndex < calls.indexOf(prompts[0]!))
  assert.equal(snapshot.permissionPreset, 'read-only')
  assert.equal(snapshot.promptAdmission, 'accepted')
  assert.equal(snapshot.status, 'succeeded')
  assert.equal(snapshot.assistantText, 'partial\n\nreviewed')
  const recovered = new RelayFacade(config, fakeFetch)
  const [restored] = await recovered.listRuns()
  assert.equal(restored?.runId, snapshot.runId)
  assert.equal(restored?.status, 'succeeded')
  assert.equal(restored?.task, '[prompt text not persisted]')
  assert.equal(restored?.taskPersisted, false)
})
