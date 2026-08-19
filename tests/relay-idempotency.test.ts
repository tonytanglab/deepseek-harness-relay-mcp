import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { resolveConfig } from '../src/config.js'
import { RelayFacade } from '../src/relay-broker/index.js'

const workspace = fileURLToPath(new URL('../', import.meta.url))

test('replays start_run by idempotency key without submitting a second prompt', async () => {
  const stateFile = join(tmpdir(), `dsh-relay-${randomUUID()}.json`)
  let promptCalls = 0
  let historyCalls = 0
  const fakeFetch: typeof fetch = async (_input, init) => {
    const request = JSON.parse(String(init?.body)) as { method: string; payload: Record<string, unknown>; rpcId: string }
    let value: unknown
    switch (request.method) {
      case 'host.describe': value = {}; break
      case 'workspace.create': value = { workspace: { workspaceId: 'workspace-1', path: workspace, sessionIds: [] } }; break
      case 'workspace.list': value = { items: [{ workspaceId: 'workspace-1', path: workspace, sessionIds: [] }] }; break
      case 'session.create': value = { sessionId: 'session-1', agentPreset: 'standard' }; break
      case 'commands/execute': value = { result: { kind: 'success' } }; break
      case 'session.history':
        historyCalls += 1
        value = historyCalls === 1
          ? { events: [], hasMore: false, projections: { values: { permissions: { currentValue: 'read-only' } } } }
          : { events: [], hasMore: false }
        break
      case 'session.prompt': promptCalls += 1; value = { accepted: true, messageId: 'message-1' }; break
      case 'session.list': value = { items: [{ sessionId: 'session-1', running: true, projections: { asOfSeq: 2 } }] }; break
      default: throw new Error(`unexpected method: ${request.method}`)
    }
    return response(request.rpcId, value)
  }
  const relay = new RelayFacade(resolveConfig({
    DSH_RELAY_HOST_URL: 'http://127.0.0.1:3080/',
    DSH_RELAY_ALLOWED_WORKSPACE_ROOTS: workspace,
    DSH_RELAY_STATE_FILE: stateFile,
  }), fakeFetch)
  const request = { workspace, task: 'review', idempotencyKey: 'same-request' }
  const first = await relay.startRun(request)
  const replay = await relay.startRun(request)
  assert.equal(promptCalls, 1)
  assert.equal(replay.runId, first.runId)
  assert.equal(replay.operationId, first.operationId)
  assert.equal(replay.idempotencyKey, 'same-request')
})

test('rejects danger-full-access before any Host call without explicit confirmation', async () => {
  let calls = 0
  const relay = new RelayFacade(resolveConfig({
    DSH_RELAY_HOST_URL: 'http://127.0.0.1:3080/',
    DSH_RELAY_ALLOWED_WORKSPACE_ROOTS: workspace,
    DSH_RELAY_STATE_FILE: join(tmpdir(), `dsh-relay-${randomUUID()}.json`),
  }), async () => {
    calls += 1
    throw new Error('Host must not be called')
  })
  await assert.rejects(
    relay.startRun({ workspace, task: 'write', permissionPreset: 'danger-full-access' }),
    /confirmedDangerousPermission=true/,
  )
  assert.equal(calls, 0)
})

function response(rpcId: string, value: unknown): Response {
  return new Response(JSON.stringify({ rpcId, result: { ok: true, value } }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}
