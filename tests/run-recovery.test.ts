import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { resolveConfig } from '../src/config.js'
import { RelayFacade } from '../src/relay-broker/index.js'

const workspace = fileURLToPath(new URL('../', import.meta.url))

test('persists the rpcId before submitting the prompt', async () => {
  const stateFile = join(tmpdir(), `dsh-relay-${randomUUID()}.json`)
  let historyCalls = 0
  let prompted = false
  const fakeFetch: typeof fetch = async (_input, init) => {
    const request = JSON.parse(String(init?.body)) as { method: string; payload: Record<string, unknown>; rpcId: string }
    let value: unknown
    switch (request.method) {
      case 'host.describe': value = {}; break
      case 'workspace.create': value = { workspace: { workspaceId: 'workspace-1', path: workspace, sessionIds: [] } }; break
      case 'workspace.list': value = { items: [{ workspaceId: 'workspace-1', path: workspace, sessionIds: [] }] }; break
      case 'session.create': value = { sessionId: 'session-1', agentPreset: 'standard' }; break
      case 'commands/execute': value = { commandId: 'command-1', result: { kind: 'success' } }; break
      case 'session.history':
        historyCalls += 1
        value = historyCalls === 1
          ? { events: [], hasMore: false, projections: { values: { permissions: { currentValue: 'read-only' } } } }
          : { events: [], hasMore: false }
        break
      case 'session.prompt': {
        const state = JSON.parse(await readFile(stateFile, { encoding: 'utf8' })) as {
          runs: Array<{ promptRpcId: string; snapshot: { promptAdmission: string } }>
        }
        assert.equal(state.runs[0]?.promptRpcId, request.rpcId)
        assert.equal(state.runs[0]?.snapshot.promptAdmission, 'pending')
        prompted = true
        value = { accepted: true, messageId: 'message-1' }
        break
      }
      case 'session.list': value = { items: [{ sessionId: 'session-1', running: prompted, projections: { asOfSeq: 2 } }] }; break
      default: throw new Error(`unexpected method: ${request.method}`)
    }
    return reply(request.rpcId, value)
  }
  const relay = new RelayFacade(resolveConfig({
    DSH_RELAY_HOST_URL: 'http://127.0.0.1:3080/',
    DSH_RELAY_ALLOWED_WORKSPACE_ROOTS: workspace,
    DSH_RELAY_STATE_FILE: stateFile,
  }), fakeFetch)
  const snapshot = await relay.startRun({ workspace, task: 'review' })
  assert.equal(snapshot.promptAdmission, 'accepted')
  assert.equal(snapshot.status, 'running')
})

test('reserves a reused session before asynchronous setup', async () => {
  const stateFile = join(tmpdir(), `dsh-relay-${randomUUID()}.json`)
  let prompted = false
  let historyCalls = 0
  let announcePermission!: () => void
  let releasePermission!: () => void
  const permissionEntered = new Promise<void>(resolve => { announcePermission = resolve })
  const permissionGate = new Promise<void>(resolve => { releasePermission = resolve })
  const fakeFetch: typeof fetch = async (_input, init) => {
    const request = JSON.parse(String(init?.body)) as { method: string; payload: Record<string, unknown>; rpcId: string }
    let value: unknown
    switch (request.method) {
      case 'host.describe': value = {}; break
      case 'workspace.create': value = { workspace: { workspaceId: 'workspace-1', path: workspace, sessionIds: ['session-1'] } }; break
      case 'workspace.list': value = { items: [{ workspaceId: 'workspace-1', path: workspace, sessionIds: ['session-1'] }] }; break
      case 'session.list': value = { items: [{ sessionId: 'session-1', running: prompted, agentPreset: 'standard', projections: { asOfSeq: 2 } }] }; break
      case 'commands/execute': announcePermission(); await permissionGate; value = { commandId: 'command-1', result: { kind: 'success' } }; break
      case 'session.history':
        historyCalls += 1
        if (historyCalls === 1) value = { events: [], hasMore: false, projections: { values: { permissions: { currentValue: 'workspace-write' } } } }
        else if (historyCalls === 2) value = { events: [], hasMore: false, projections: { values: { permissions: { currentValue: 'read-only' } } } }
        else value = { events: [], hasMore: false }
        break
      case 'session.prompt': prompted = true; value = { accepted: true, messageId: 'message-1' }; break
      default: throw new Error(`unexpected method: ${request.method}`)
    }
    return reply(request.rpcId, value)
  }
  const relay = new RelayFacade(resolveConfig({
    DSH_RELAY_HOST_URL: 'http://127.0.0.1:3080/',
    DSH_RELAY_ALLOWED_WORKSPACE_ROOTS: workspace,
    DSH_RELAY_STATE_FILE: stateFile,
  }), fakeFetch)
  await relay.startService({ workspace })
  const first = relay.startRun({ workspace, sessionId: 'session-1', task: 'first' })
  await permissionEntered
  await assert.rejects(
    relay.startRun({ workspace, sessionId: 'session-1', task: 'second' }),
    /session already has an active DSH Relay run/,
  )
  releasePermission()
  assert.equal((await first).promptAdmission, 'accepted')
})

function reply(rpcId: string, value: unknown): Response {
  return new Response(JSON.stringify({ type: 'server-response', rpcId, result: { ok: true, value } }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}
