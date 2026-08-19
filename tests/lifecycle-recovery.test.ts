import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { resolveConfig } from '../src/config.js'
import { RelayError, RelayFacade } from '../src/relay-broker/index.js'

const workspace = fileURLToPath(new URL('../', import.meta.url))

test('does not restore a reused-session permission after the prompt was accepted', async () => {
  const commands: string[] = []
  let historyCalls = 0
  let promptAccepted = false
  const relay = new RelayFacade(config(), async (_input, init) => {
    const request = requestOf(init)
    if (request.method === 'session.list' && promptAccepted) return new Response('temporary failure', { status: 503 })
    if (request.method === 'session.prompt') promptAccepted = true
    const value = routeCommon(request, commands, () => {
      historyCalls += 1
      if (historyCalls === 1) return permissionHistory('workspace-write')
      if (historyCalls === 2) return permissionHistory('read-only')
      return { events: [], hasMore: false }
    })
    return response(request.rpcId, value)
  })
  await relay.startService({ workspace })
  await assert.rejects(relay.startRun({ workspace, sessionId: 'session-1', task: 'review' }), /HTTP 503/)
  assert.deepEqual(commands, ['/permission read-only'])
})

test('restores a reused-session permission after definitive prompt rejection', async () => {
  const commands: string[] = []
  let historyCalls = 0
  const relay = new RelayFacade(config(), async (_input, init) => {
    const request = requestOf(init)
    if (request.method === 'session.prompt') {
      return failure(request.rpcId, 'INVALID_REQUEST', 'prompt rejected')
    }
    const value = routeCommon(request, commands, () => {
      historyCalls += 1
      if (historyCalls === 1) return permissionHistory('workspace-write')
      if (historyCalls === 2) return permissionHistory('read-only')
      if (historyCalls === 3) return { events: [], hasMore: false }
      return permissionHistory('workspace-write')
    })
    return response(request.rpcId, value)
  })
  await relay.startService({ workspace })
  const run = await relay.startRun({ workspace, sessionId: 'session-1', task: 'review' })
  assert.equal(run.promptAdmission, 'rejected')
  assert.equal(run.status, 'failed')
  assert.deepEqual(commands, ['/permission read-only', '/permission workspace-write'])
})

test('reconciles an uncertain steer by its durable rpcId', async () => {
  let steerRpcId = ''
  const relay = new RelayFacade(config(), async (_input, init) => {
    const request = requestOf(init)
    let value: unknown
    switch (request.method) {
      case 'host.describe': value = {}; break
      case 'workspace.create': value = { workspace: { workspaceId: 'workspace-1', path: workspace, sessionIds: [] } }; break
      case 'workspace.list': value = { items: [{ workspaceId: 'workspace-1', path: workspace, sessionIds: [] }] }; break
      case 'session.create': value = { sessionId: 'session-1', agentPreset: 'standard' }; break
      case 'commands/execute': value = { result: { kind: 'success' } }; break
      case 'session.list': value = { items: [{ sessionId: 'session-1', running: true, projections: { asOfSeq: 3 } }] }; break
      case 'session.history': value = steerRpcId === ''
        ? permissionHistory('read-only')
        : { events: [{ event: userEvent(3, steerRpcId, 'steer-message') }], hasMore: false, projections: { values: { permissions: { currentValue: 'read-only' } } } }; break
      case 'session.prompt':
        if ((request.payload.mode as string) === 'queue') { value = { accepted: true, messageId: 'start-message' }; break }
        steerRpcId = request.rpcId
        return new Response('temporary failure', { status: 503 })
      default: throw new Error(`unexpected method: ${request.method}`)
    }
    return response(request.rpcId, value)
  })
  const run = await relay.startRun({ workspace, task: 'review' })
  let operationId = ''
  try {
    await relay.steerRun(run.runId, { task: 'focus', idempotencyKey: 'uncertain-steer' })
    assert.fail('steer should be uncertain')
  } catch (error) {
    assert.ok(error instanceof RelayError)
    operationId = error.details.operationId ?? ''
  }
  const reconciled = await relay.reconcileOperation(operationId)
  assert.equal(reconciled.operation.state, 'reconciled')
  assert.equal(reconciled.operation.messageId, 'steer-message')
})

test('rolls back cancelRequested after a definitive cancellation rejection', async () => {
  const relay = new RelayFacade(config(), async (_input, init) => {
    const request = requestOf(init)
    let value: unknown
    switch (request.method) {
      case 'host.describe': value = {}; break
      case 'workspace.list': value = { items: [{ workspaceId: 'workspace-1', path: workspace, sessionIds: [] }] }; break
      case 'session.create': value = { sessionId: 'session-1', agentPreset: 'standard' }; break
      case 'session.list': value = { items: [{ sessionId: 'session-1', running: true, projections: { asOfSeq: 2 } }] }; break
      case 'session.history': value = permissionHistory('read-only'); break
      case 'session.prompt': value = { accepted: true, messageId: 'start-message' }; break
      case 'session.cancel': return failure(request.rpcId, 'CANCEL_REJECTED', 'cannot cancel')
      default: throw new Error(`unexpected method: ${request.method}`)
    }
    return response(request.rpcId, value)
  })
  const run = await relay.startRun({ workspace, task: 'review' })
  await assert.rejects(relay.cancelRun(run.runId, 'cancel-rejected'), /CANCEL_REJECTED/)
  assert.equal((await relay.getRun(run.runId)).cancelRequested, false)
})

test('restores a fresh session after a temporary elevated permission', async () => {
  const commands: string[] = []
  let permission = 'read-only'
  let promptRpcId = ''
  const relay = new RelayFacade(config(), async (_input, init) => {
    const request = requestOf(init)
    let value: unknown
    switch (request.method) {
      case 'host.describe': value = {}; break
      case 'workspace.list': value = { items: [{ workspaceId: 'workspace-1', path: workspace, sessionIds: [] }] }; break
      case 'session.create': value = { sessionId: 'session-1', agentPreset: 'standard' }; break
      case 'session.list': value = { items: [{ sessionId: 'session-1', running: false, projections: { asOfSeq: 3 } }] }; break
      case 'commands/execute': {
        const line = (request.payload.args as { line: string }).line
        commands.push(line)
        permission = line.endsWith('workspace-write') ? 'workspace-write' : 'read-only'
        value = { result: { kind: 'success' } }
        break
      }
      case 'session.history': value = promptRpcId === ''
        ? permissionHistory(permission)
        : permission === 'workspace-write'
          ? { events: [
              { event: userEvent(1, promptRpcId, 'start-message') },
              { event: { type: 'turn/end', seq: 2, time: 2, data: { reason: { kind: 'completed' } } } },
            ], hasMore: false }
          : permissionHistory(permission); break
      case 'session.prompt': promptRpcId = request.rpcId; value = { accepted: true, messageId: 'start-message' }; break
      default: throw new Error(`unexpected method: ${request.method}`)
    }
    return response(request.rpcId, value)
  })
  const run = await relay.startRun({ workspace, task: 'implement', permissionPreset: 'workspace-write' })
  assert.equal(run.status, 'succeeded')
  assert.deepEqual(commands, ['/permission workspace-write', '/permission read-only'])
})

test('marks a silent running session for attention and resumes after durable progress', async () => {
  let sequence = 2
  const relay = new RelayFacade(config(), async (_input, init) => {
    const request = requestOf(init)
    let value: unknown
    switch (request.method) {
      case 'host.describe': value = {}; break
      case 'workspace.list': value = { items: [{ workspaceId: 'workspace-1', path: workspace, sessionIds: [] }] }; break
      case 'session.create': value = { sessionId: 'session-1', agentPreset: 'standard' }; break
      case 'session.list': value = { items: [{ sessionId: 'session-1', running: true, projections: { asOfSeq: sequence } }] }; break
      case 'session.history': value = permissionHistory('read-only'); break
      case 'session.prompt': value = { accepted: true, messageId: 'start-message' }; break
      default: throw new Error(`unexpected method: ${request.method}`)
    }
    return response(request.rpcId, value)
  })
  const run = await relay.startRun({ workspace, task: 'long task' })
  await new Promise(resolve => setTimeout(resolve, 1_050))
  const stalled = await relay.getRun(run.runId)
  assert.equal(stalled.status, 'needs_attention')
  assert.equal(stalled.attentionReason, 'run_stalled')
  sequence += 1
  const resumed = await relay.getRun(run.runId)
  assert.equal(resumed.status, 'running')
  assert.equal(resumed.attentionReason, undefined)
})

test('marks expired permission leases for explicit reconciliation during restore', async () => {
  const stateFile = join(tmpdir(), `dsh-relay-${randomUUID()}.json`)
  const now = new Date().toISOString()
  await writeFile(stateFile, JSON.stringify({
    schemaVersion: 2,
    services: [],
    runs: [],
    operations: [],
    permissionLeases: [{
      leaseId: randomUUID(), sessionId: 'session-expired', ownerOperationId: randomUUID(),
      previousPermission: 'read-only', grantedPermission: 'workspace-write', expiresAt: '2000-01-01T00:00:00.000Z',
      state: 'acquired', error: null, createdAt: now, updatedAt: now,
    }],
  }), { encoding: 'utf8' })
  const relay = new RelayFacade(config(stateFile), async () => { throw new Error('Host must not be called') })
  await relay.listRuns()
  const state = JSON.parse(await readFile(stateFile, { encoding: 'utf8' })) as { permissionLeases: Array<{ state: string; error: string | null }> }
  assert.equal(state.permissionLeases[0]?.state, 'needs_attention')
  assert.match(state.permissionLeases[0]?.error ?? '', /expired/iu)
})

test('deduplicates concurrent service attachment for one workspace', async () => {
  let creates = 0
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const relay = new RelayFacade(config(), async (_input, init) => {
    const request = requestOf(init)
    if (request.method === 'host.describe') return response(request.rpcId, {})
    if (request.method === 'workspace.list') return response(request.rpcId, { items: [] })
    if (request.method === 'workspace.create') {
      creates += 1
      await gate
      return response(request.rpcId, { workspace: { workspaceId: 'workspace-1', path: workspace, sessionIds: [] } })
    }
    throw new Error(`unexpected method: ${request.method}`)
  })
  const first = relay.startService({ workspace })
  const second = relay.startService({ workspace })
  await new Promise(resolve => setImmediate(resolve))
  release()
  const [left, right] = await Promise.all([first, second])
  assert.equal(creates, 1)
  assert.equal(left.serviceId, right.serviceId)
})

test('resumes a prepared persisted run with the original prompt rpcId', async () => {
  const stateFile = join(tmpdir(), `dsh-relay-${randomUUID()}.json`)
  const runId = randomUUID()
  const operationId = randomUUID()
  const rpcId = randomUUID()
  const serviceId = randomUUID()
  const now = new Date().toISOString()
  const abandonedAt = new Date(Date.now() - 2_000).toISOString()
  const request = {
    workspace, sessionId: null, sessionMode: 'fresh', provider: null, model: null, reasoningEffort: null, agentPreset: null,
    permissionPreset: 'read-only', parentRunId: null, summary: 'review', imageCount: 0,
  }
  await writeFile(stateFile, JSON.stringify({
    schemaVersion: 2,
    services: [{
      serviceId, workspaceId: 'workspace-1', workspace, status: 'running', webUrl: 'http://127.0.0.1:3080/',
      browserOpened: false, browserError: null, managedProcess: false, processId: null, attachedAt: now, stoppedAt: null,
    }],
    runs: [{
      baselineSeq: 0,
      promptRpcId: rpcId,
      snapshot: {
        runId, operationId, idempotencyKey: 'prepared-replay', serviceId, sessionId: 'session-1', sessionReused: false,
        parentRunId: null, workspace, webUrl: 'http://127.0.0.1:3080/?sessionId=session-1', status: 'running',
        modelSelection: null, permissionPreset: 'read-only', agentPreset: 'standard', modelDefaultRestore: 'not-needed',
        warnings: [], task: '[prompt text not persisted]', taskPersisted: false, taskImageCount: 0, cancelRequested: false,
        startedAt: now, finishedAt: null, promptAdmission: 'pending', promptMessageId: null, assistantText: '',
        assistantTextBytes: 0, assistantTextTruncated: false, lastEventSeq: 0, error: null,
      },
    }],
    operations: [{
      operationId, clientPrincipalId: 'local-user', idempotencyKey: 'prepared-replay', requestFingerprint: fingerprint(request),
      runId, kind: 'start', rpcId, fencingEpoch: 0, state: 'prepared', messageId: null, error: null, createdAt: now, updatedAt: now,
    }],
    permissionLeases: [],
  }), { encoding: 'utf8' })
  const recent = new RelayFacade(config(stateFile), async () => { throw new Error('Fresh replay must not call Harness') })
  await assert.rejects(
    recent.startRun({ workspace, task: 'review', idempotencyKey: 'prepared-replay' }),
    (error: unknown) => error instanceof RelayError && error.code === 'OPERATION_IN_PROGRESS',
  )
  const abandoned = JSON.parse(await readFile(stateFile, { encoding: 'utf8' })) as {
    operations: Array<{ createdAt: string; updatedAt: string }>
  }
  abandoned.operations[0]!.createdAt = abandonedAt
  abandoned.operations[0]!.updatedAt = abandonedAt
  await writeFile(stateFile, JSON.stringify(abandoned), { encoding: 'utf8' })

  const promptRpcIds: string[] = []
  const relay = new RelayFacade(config(stateFile), async (_input, init) => {
    const call = requestOf(init)
    let value: unknown
    switch (call.method) {
      case 'session.list': value = { items: [{ sessionId: 'session-1', running: false, projections: { asOfSeq: 0 } }] }; break
      case 'session.history': value = { events: [], hasMore: false }; break
      case 'session.prompt': promptRpcIds.push(call.rpcId); value = { accepted: true, messageId: 'replayed-message' }; break
      default: throw new Error(`unexpected method: ${call.method}`)
    }
    return response(call.rpcId, value)
  })
  const resumed = await relay.startRun({ workspace, task: 'review', idempotencyKey: 'prepared-replay' })
  assert.deepEqual(promptRpcIds, [rpcId])
  assert.equal(resumed.promptAdmission, 'accepted')
  assert.equal(resumed.promptMessageId, 'replayed-message')
})

function config(stateFile = join(tmpdir(), `dsh-relay-${randomUUID()}.json`)) {
  return resolveConfig({
    DSH_RELAY_HOST_URL: 'http://127.0.0.1:3080/',
    DSH_RELAY_ALLOWED_WORKSPACE_ROOTS: workspace,
    DSH_RELAY_STATE_FILE: stateFile,
    DSH_RELAY_RPC_TIMEOUT_MS: '1000',
    DSH_RELAY_POLL_INTERVAL_MS: '100',
    DSH_RELAY_RUN_STALL_MS: '1000',
  })
}

function requestOf(init: RequestInit | undefined) {
  return JSON.parse(String(init?.body)) as { method: string; payload: Record<string, unknown>; rpcId: string }
}

function routeCommon(request: ReturnType<typeof requestOf>, commands: string[], history: () => unknown): unknown {
  switch (request.method) {
    case 'host.describe': return {}
    case 'workspace.create': return { workspace: { workspaceId: 'workspace-1', path: workspace, sessionIds: ['session-1'] } }
    case 'workspace.list': return { items: [{ workspaceId: 'workspace-1', path: workspace, sessionIds: ['session-1'] }] }
    case 'session.list': return { items: [{ sessionId: 'session-1', running: false, agentPreset: 'standard' }] }
    case 'commands/execute': commands.push(((request.payload.args as { line: string }).line)); return { result: { kind: 'success' } }
    case 'session.history': return history()
    case 'session.prompt': return { accepted: true, messageId: 'message-1' }
    default: throw new Error(`unexpected method: ${request.method}`)
  }
}

function permissionHistory(preset: string) {
  return { events: [], hasMore: false, projections: { values: { permissions: { currentValue: preset } } } }
}

function userEvent(seq: number, rpcId: string, id: string) {
  return { type: 'user/message', seq, time: seq, data: { id, source: { kind: 'user', rpcId } } }
}

function response(rpcId: string, value: unknown): Response {
  return new Response(JSON.stringify({ rpcId, result: { ok: true, value } }), { status: 200, headers: { 'content-type': 'application/json' } })
}

function failure(rpcId: string, code: string, message: string): Response {
  return new Response(JSON.stringify({ rpcId, result: { ok: false, error: { code, message } } }), { status: 200, headers: { 'content-type': 'application/json' } })
}

function fingerprint(value: unknown): string {
  return createHash('sha256').update(stableJson(value), 'utf8').digest('hex')
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (typeof value === 'object' && value !== null) {
    const record = value as Record<string, unknown>
    return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}
