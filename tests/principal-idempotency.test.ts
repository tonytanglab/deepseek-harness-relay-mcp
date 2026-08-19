import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { resolveConfig } from '../src/config.js'
import { RelayFacade } from '../src/relay-broker/index.js'

const workspace = fileURLToPath(new URL('../', import.meta.url))

test('the same idempotency key is isolated between stable client principals', async t => {
  const stateFile = join(tmpdir(), `dsh-relay-principal-${randomUUID()}.json`)
  t.after(async () => { await rm(stateFile, { force: true }); await rm(`${stateFile}.lock`, { force: true }) })
  let promptCalls = 0
  let sessionCounter = 0
  const fakeFetch: typeof fetch = async (_input, init) => {
    const request = JSON.parse(String(init?.body)) as { method: string; payload: Record<string, unknown>; rpcId: string }
    let value: unknown
    switch (request.method) {
      case 'host.describe': value = {}; break
      case 'workspace.create': value = { workspace: { workspaceId: 'workspace-1', path: workspace, sessionIds: [] } }; break
      case 'workspace.list': value = { items: [{ workspaceId: 'workspace-1', path: workspace, sessionIds: [] }] }; break
      case 'session.create':
        sessionCounter += 1
        value = { sessionId: `session-${sessionCounter}`, agentPreset: 'standard' }
        break
      case 'session.history':
        value = { events: [], hasMore: false, projections: { values: { permissions: { currentValue: 'read-only' } } } }
        break
      case 'session.prompt':
        promptCalls += 1
        value = { accepted: true, messageId: `message-${promptCalls}` }
        break
      case 'session.list':
        value = { items: Array.from({ length: sessionCounter }, (_, index) => ({
          sessionId: `session-${index + 1}`, running: true, projections: { asOfSeq: 0 },
        })) }
        break
      default: throw new Error(`unexpected method: ${request.method}`)
    }
    return response(request.rpcId, value)
  }
  const relay = new RelayFacade(resolveConfig({
    DSH_RELAY_HOST_URL: 'http://127.0.0.1:3080/',
    DSH_RELAY_ALLOWED_WORKSPACE_ROOTS: workspace,
    DSH_RELAY_STATE_FILE: stateFile,
  }), fakeFetch)
  const request = { workspace, task: 'review principal isolation', sessionMode: 'fresh' as const, idempotencyKey: 'shared-key' }

  const codex = await relay.startRun(request, 'codex:user')
  const cursor = await relay.startRun(request, 'cursor:project')
  const codexReplay = await relay.startRun(request, 'codex:user')
  const cursorReplay = await relay.startRun(request, 'cursor:project')

  assert.equal(promptCalls, 2)
  assert.notEqual(codex.operationId, cursor.operationId)
  assert.notEqual(codex.runId, cursor.runId)
  assert.equal(codexReplay.operationId, codex.operationId)
  assert.equal(cursorReplay.operationId, cursor.operationId)
  const persisted = JSON.parse(await readFile(stateFile, { encoding: 'utf8' })) as {
    schemaVersion: number
    operations: Array<{ clientPrincipalId: string; idempotencyKey: string }>
  }
  assert.equal(persisted.schemaVersion, 3)
  assert.deepEqual(
    persisted.operations
      .filter(operation => operation.idempotencyKey === 'shared-key')
      .map(operation => operation.clientPrincipalId)
      .sort(),
    ['codex:user', 'cursor:project'],
  )
})

function response(rpcId: string, value: unknown): Response {
  return new Response(JSON.stringify({ rpcId, result: { ok: true, value } }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}
