import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { resolveConfig, type RelayConfig } from '../src/config.js'
import { RelayFacade } from '../src/relay-broker/index.js'
import type { RpcEvent } from '../src/types.js'

const workspace = fileURLToPath(new URL('../', import.meta.url))

test('reconciles an rc.8 completed turn while session.list is stale running and rereads the terminal snapshot', async () => {
  const stateDirectory = await tempDirectory()
  const stateFile = join(stateDirectory, 'state.json')
  const fixture = createFixture(() => completeHistory(fixture.promptRpcId))
  const relay = new RelayFacade(config(stateFile), fixture.fetch)

  const completed = await relay.startRun({ workspace, task: 'review' })
  assert.equal(completed.status, 'succeeded')
  assert.equal(completed.assistantText, 'A\n\nB\n\nC\n\nD')
  assert.equal(completed.assistantTextTruncated, false)
  assert.notEqual(completed.finishedAt, null)
  assert.equal(completed.lastProgressAt, completed.finishedAt)

  const reread = new RelayFacade(config(stateFile), async () => { throw new Error('terminal reread must not require a Host call') })
  const restored = await reread.getRun(completed.runId)
  assert.equal(restored.status, 'succeeded')
  assert.equal(restored.assistantText, 'A\n\nB\n\nC\n\nD')
  await rm(stateDirectory, { recursive: true, force: true })
})

test('keeps a steer turn in the owning run and consumes its final assistant message', async () => {
  const stateDirectory = await tempDirectory()
  const fixture = createFixture(() => fixture.steerRpcId === ''
    ? runningHistory(fixture.promptRpcId)
    : steeredHistory(fixture.promptRpcId, fixture.steerRpcId))
  const relay = new RelayFacade(config(join(stateDirectory, 'state.json')), fixture.fetch)

  const initial = await relay.startRun({ workspace, task: 'review' })
  assert.equal(initial.status, 'running')
  const steer = await relay.steerRun(initial.runId, { task: 'focus', idempotencyKey: 'steer-once' }) as {
    accepted: boolean
    operationId: string
    run: { status: string }
  }
  assert.equal(steer.accepted, true)
  assert.equal(steer.run.status, 'running')

  const completed = await relay.getRun(initial.runId)
  assert.equal(completed.status, 'succeeded')
  assert.equal(completed.assistantText, 'progress\n\nsteer result')
  const operation = await relay.getOperation(steer.operationId)
  assert.equal(operation.state, 'acknowledged')
  await rm(stateDirectory, { recursive: true, force: true })
})

test('retains a final assistant message that appears after an earlier progress-only history read', async () => {
  const stateDirectory = await tempDirectory()
  let historyRead = 0
  const fixture = createFixture(() => {
    historyRead += 1
    return historyRead <= 1 ? runningHistory(fixture.promptRpcId) : completeHistory(fixture.promptRpcId)
  }, () => historyRead === 1)
  const relay = new RelayFacade(config(join(stateDirectory, 'state.json')), fixture.fetch)

  const initial = await relay.startRun({ workspace, task: 'review' })
  assert.equal(initial.status, 'running')
  const completed = await relay.getRun(initial.runId)
  assert.equal(completed.status, 'succeeded')
  assert.equal(completed.assistantText, 'A\n\nB\n\nC\n\nD')
  await rm(stateDirectory, { recursive: true, force: true })
})

test('maps a completed interrupted assistant surface to incomplete with an actionable warning', async () => {
  const stateDirectory = await tempDirectory()
  const fixture = createFixture(() => interruptedHistory(fixture.promptRpcId))
  const relay = new RelayFacade(config(join(stateDirectory, 'state.json')), fixture.fetch)

  const run = await relay.startRun({ workspace, task: 'review' })
  assert.equal(run.status, 'incomplete')
  assert.equal(run.assistantText, 'partial answer')
  assert.match(run.warnings.join('\n'), /interrupted/u)
  await rm(stateDirectory, { recursive: true, force: true })
})

test('replaying a steer idempotency key does not submit a second steer', async () => {
  const stateDirectory = await tempDirectory()
  const fixture = createFixture(() => runningHistory(fixture.promptRpcId))
  const relay = new RelayFacade(config(join(stateDirectory, 'state.json')), fixture.fetch)

  const run = await relay.startRun({ workspace, task: 'review' })
  const first = await relay.steerRun(run.runId, { task: 'focus', idempotencyKey: 'same-steer' }) as { accepted: boolean; operationId: string }
  const second = await relay.steerRun(run.runId, { task: 'focus', idempotencyKey: 'same-steer' }) as { accepted: boolean; replayed?: boolean; operationId: string }
  assert.equal(first.accepted, true)
  assert.equal(second.accepted, true)
  assert.equal(second.replayed, true)
  assert.equal(second.operationId, first.operationId)
  assert.equal(fixture.calls.filter(call => call.method === 'session.prompt').length, 2)
  await rm(stateDirectory, { recursive: true, force: true })
})

test('a persisted running snapshot is promoted by durable terminal history after restart', async () => {
  const stateDirectory = await tempDirectory()
  let terminal = false
  const fixture = createFixture(() => terminal
    ? completeHistory(fixture.promptRpcId)
    : runningHistory(fixture.promptRpcId))
  const first = new RelayFacade(config(join(stateDirectory, 'state.json')), fixture.fetch)
  const running = await first.startRun({ workspace, task: 'review' })
  assert.equal(running.status, 'running')

  terminal = true
  const recovered = new RelayFacade(config(join(stateDirectory, 'state.json')), fixture.fetch)
  const completed = await recovered.getRun(running.runId)
  assert.equal(completed.status, 'succeeded')
  assert.equal(completed.assistantText, 'A\n\nB\n\nC\n\nD')
  await rm(stateDirectory, { recursive: true, force: true })
})

interface Fixture {
  fetch: typeof fetch
  calls: Array<{ method: string; value?: unknown }>
  promptRpcId: string
  steerRpcId: string
}

function createFixture(history: () => RpcEvent[], running = () => true): Fixture {
  const fixture = {
    calls: [] as Array<{ method: string; value?: unknown }>,
    promptRpcId: '',
    steerRpcId: '',
  } as Fixture
  fixture.fetch = async (_input, init) => {
    const request = JSON.parse(String(init?.body)) as {
      method: string
      rpcId: string
      payload: Record<string, unknown>
    }
    fixture.calls.push({ method: request.method })
    let value: unknown
    switch (request.method) {
      case 'host.describe':
        value = { version: 'rc.8', home: 'D:\\Harness\\profiles\\web' }
        break
      case 'workspace.list':
        value = { items: [{ workspaceId: 'workspace-1', path: workspace, sessionIds: [] }], archivedSessionIds: [] }
        break
      case 'workspace.create':
        value = { workspace: { workspaceId: 'workspace-1', path: workspace, sessionIds: [] } }
        break
      case 'session.create':
        value = { sessionId: 'session-1', agentPreset: 'standard' }
        break
      case 'session.list':
        value = { items: [{ sessionId: 'session-1', running: running(), projections: { asOfSeq: 6 } }] }
        break
      case 'session.history':
        value = Number(request.payload.maxMessages) === 1
          ? { events: [], hasMore: false, projections: { values: { permissions: { currentValue: 'read-only' } } } }
          : { events: history().map(event => ({ event })), hasMore: false }
        break
      case 'session.prompt':
        if (request.payload.mode === 'steer') {
          fixture.steerRpcId = request.rpcId
          value = { accepted: true, messageId: 'steer-message' }
        } else {
          fixture.promptRpcId = request.rpcId
          value = { accepted: true, messageId: 'start-message' }
        }
        break
      default:
        throw new Error(`unexpected method: ${request.method}`)
    }
    return response(request.rpcId, value)
  }
  return fixture
}

function runningHistory(promptRpcId: string): RpcEvent[] {
  return [
    userEvent(1, promptRpcId, 'start-message'),
    assistantEvent(2, 'progress'),
  ]
}

function completeHistory(promptRpcId: string): RpcEvent[] {
  return [
    userEvent(1, promptRpcId, 'start-message'),
    assistantEvent(2, 'A'),
    assistantEvent(3, 'B'),
    assistantEvent(4, 'C'),
    assistantEvent(5, 'D'),
    turnEnd(6, 'completed'),
  ]
}

function steeredHistory(promptRpcId: string, steerRpcId: string): RpcEvent[] {
  return [
    userEvent(1, promptRpcId, 'start-message'),
    assistantEvent(2, 'progress'),
    userEvent(3, steerRpcId, 'steer-message'),
    assistantEvent(4, 'steer result'),
    turnEnd(5, 'completed'),
  ]
}

function interruptedHistory(promptRpcId: string): RpcEvent[] {
  return [
    userEvent(1, promptRpcId, 'start-message'),
    assistantEvent(2, 'partial answer', true),
    turnEnd(3, 'completed'),
  ]
}

function userEvent(seq: number, rpcId: string, id: string): RpcEvent {
  return { type: 'user/message', seq, time: seq, data: { id, source: { kind: 'user', rpcId } } }
}

function assistantEvent(seq: number, text: string, interrupted = false): RpcEvent {
  return {
    type: 'assistant/message',
    seq,
    time: seq,
    data: { message: { content: [{ type: 'text', text }], ...(interrupted ? { interrupted: true } : {}) } },
  }
}

function turnEnd(seq: number, kind: string): RpcEvent {
  return { type: 'turn/end', seq, time: seq, data: { reason: { kind } } }
}

function response(rpcId: string, value: unknown): Response {
  return new Response(JSON.stringify({ type: 'server-response', rpcId, result: { ok: true, value } }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

function config(stateFile: string): RelayConfig {
  return resolveConfig({
    DSH_RELAY_HOST_URL: 'http://127.0.0.1:3080/',
    DSH_RELAY_ALLOWED_WORKSPACE_ROOTS: workspace,
    DSH_RELAY_STATE_FILE: stateFile,
    DSH_RELAY_RPC_TIMEOUT_MS: '1000',
    DSH_RELAY_POLL_INTERVAL_MS: '100',
    DSH_RELAY_RUN_STALL_MS: '1000',
  })
}

async function tempDirectory(): Promise<string> {
  const directory = join(tmpdir(), `dsh-relay-rc8-${randomUUID()}`)
  await mkdir(directory, { recursive: true })
  return directory
}
