import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, readdir, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { RelayStateStore } from '../src/state-store.js'
import type { OperationRecord, PersistedRelayState, PersistedRun, RunStatus, ServiceSnapshot } from '../src/types.js'

test('a failed state write does not poison later writes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-relay-state-'))
  const directory = join(root, 'blocked')
  const path = join(directory, 'state.json')
  await writeFile(directory, 'not a directory', { encoding: 'utf8' })
  const store = new RelayStateStore(path)
  const state: PersistedRelayState = { schemaVersion: 2, services: [], runs: [], operations: [], permissionLeases: [] }
  await assert.rejects(store.save(state))
  await unlink(directory)
  await mkdir(directory)
  await store.save(state)
  const persisted = JSON.parse(await readFile(path, { encoding: 'utf8' })) as Record<string, unknown>
  assert.equal(persisted.schemaVersion, 3)
  assert.equal(persisted.mode, 'standalone')
  assert.deepEqual(persisted.services, [])
})

test('migrates schema version 1 state without losing records', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-relay-state-'))
  const path = join(directory, 'state.json')
  await writeFile(path, JSON.stringify({ schemaVersion: 1, services: [], runs: [] }), { encoding: 'utf8' })
  const loaded = await new RelayStateStore(path).load()
  assert.equal(loaded?.schemaVersion, 3)
  assert.equal(loaded?.migration?.sourceSchemaVersion, 1)
  assert.deepEqual(loaded?.services, [])
  assert.deepEqual(loaded?.operations, [])
  await rm(directory, { recursive: true, force: true })
})

test('quarantines malformed state instead of silently overwriting it', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-relay-state-'))
  const path = join(directory, 'state.json')
  await writeFile(path, '{broken', { encoding: 'utf8' })
  const store = new RelayStateStore(path)
  assert.equal(await store.load(), null)
  assert.match(store.recoveryWarning ?? '', /Invalid state was quarantined/)
  const files = await readdir(directory)
  assert.equal(files.some(file => file.startsWith('state.json.corrupt.')), true)
  await rm(directory, { recursive: true, force: true })
})

test('a stale writer cannot regress a terminal run to a non-terminal state', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-relay-state-'))
  const path = join(directory, 'state.json')
  const terminalStatuses = ['succeeded', 'incomplete', 'failed', 'cancelled'] as const
  const completed = emptyState()
  const stale = emptyState()
  for (const status of terminalStatuses) {
    completed.runs.push(run(status, 8, `final result:${status}`, `run-${status}`))
    stale.runs.push(run('running', 99, 'stale partial', `run-${status}`))
  }

  await new RelayStateStore(path).save(completed)
  await new RelayStateStore(path).save(stale)

  const loaded = await new RelayStateStore(path).load()
  for (const status of terminalStatuses) {
    const persisted = loaded?.runs.find(item => item.snapshot.runId === `run-${status}`)
    assert.equal(persisted?.snapshot.status, status)
    assert.equal(persisted?.snapshot.assistantText, `final result:${status}`)
    assert.equal(persisted?.snapshot.lastEventSeq, 8)
  }
  await rm(directory, { recursive: true, force: true })
})

test('independent store instances merge concurrent unique records', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-relay-state-'))
  const path = join(directory, 'state.json')
  const stateA = emptyState()
  const stateB = emptyState()
  stateA.services.push(service('service-a'))
  stateB.services.push(service('service-b'))

  await Promise.all([
    new RelayStateStore(path).save(stateA),
    new RelayStateStore(path).save(stateB),
  ])

  const loaded = await new RelayStateStore(path).load()
  assert.deepEqual(loaded?.services.map(item => item.serviceId).sort(), ['service-a', 'service-b'])
  await rm(directory, { recursive: true, force: true })
})

test('a stale writer cannot resurrect a stopped service attachment', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-relay-state-'))
  const path = join(directory, 'state.json')
  const now = new Date().toISOString()
  const running: PersistedRelayState = {
    schemaVersion: 2,
    services: [{
      serviceId: 'service-1', workspaceId: 'workspace-1', workspace: directory, status: 'running',
      webUrl: 'http://127.0.0.1:3080/', browserOpened: false, browserError: null,
      managedProcess: false, processId: null, attachedAt: now, stoppedAt: null,
    }],
    runs: [], operations: [], permissionLeases: [],
  }
  const first = new RelayStateStore(path)
  const stale = new RelayStateStore(path)
  await first.save(running)
  const stopped = structuredClone(running)
  stopped.services[0]!.status = 'stopped'
  stopped.services[0]!.stoppedAt = new Date(Date.now() + 1_000).toISOString()
  await first.save(stopped)
  await stale.save(running)
  assert.equal((await new RelayStateStore(path).load())?.services[0]?.status, 'stopped')
  await rm(directory, { recursive: true, force: true })
})

test('concurrent processes claim one canonical operation per principal and idempotency key', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-relay-state-'))
  const path = join(directory, 'state.json')
  const left = operation('operation-left')
  const right = operation('operation-right')
  const [first, second] = await Promise.all([
    new RelayStateStore(path).claimOperation(left),
    new RelayStateStore(path).claimOperation(right),
  ])
  assert.equal([first.created, second.created].filter(Boolean).length, 1)
  assert.equal(first.record.operationId, second.record.operationId)
  assert.equal((await new RelayStateStore(path).load())?.operations.length, 1)
  await rm(directory, { recursive: true, force: true })
})

test('explicit v2 to v3 migration copies source without deleting or rewriting it', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-relay-state-migrate-'))
  const sourcePath = join(directory, 'legacy', 'state.json')
  const targetPath = join(directory, 'embedded', 'state.json')
  await mkdir(join(directory, 'legacy'), { recursive: true })
  const sourceText = `${JSON.stringify(emptyState(), null, 2)}\n`
  await writeFile(sourcePath, sourceText, { encoding: 'utf8' })
  const authority = {
    authorityId: 'embedded-authority',
    mode: 'embedded' as const,
    hostIdentity: 'http://loopback:3080',
    instanceId: 'host-instance-1',
  }
  const store = new RelayStateStore(targetPath, { authority })

  const migrated = await store.migrateFrom(sourcePath)

  assert.equal(migrated.schemaVersion, 3)
  assert.equal(migrated.authorityId, authority.authorityId)
  assert.equal(migrated.migration?.sourceSchemaVersion, 2)
  assert.equal(migrated.migration?.sourcePath, sourcePath)
  assert.equal(await readFile(sourcePath, { encoding: 'utf8' }), sourceText)
  await assert.rejects(store.migrateFrom(sourcePath), /migration target already exists/)
  await rm(directory, { recursive: true, force: true })
})

test('a state belonging to another authority fails closed without quarantine', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-relay-state-authority-'))
  const path = join(directory, 'state.json')
  const first = new RelayStateStore(path, { authority: {
    authorityId: 'authority-a', mode: 'embedded', hostIdentity: 'http://loopback:3080', instanceId: 'instance-a',
  } })
  await first.save({
    schemaVersion: 3,
    authorityId: 'authority-a', mode: 'embedded', hostIdentity: 'http://loopback:3080', instanceId: 'instance-a', migration: null,
    services: [], runs: [], operations: [], permissionLeases: [],
  })
  const second = new RelayStateStore(path, { authority: {
    authorityId: 'authority-b', mode: 'standalone', hostIdentity: 'http://loopback:3080', instanceId: 'instance-b',
  } })

  await assert.rejects(second.load(), /state belongs to authority/)
  assert.equal((await readdir(directory)).some(file => file.includes('.corrupt.')), false)
  await rm(directory, { recursive: true, force: true })
})

function emptyState(): PersistedRelayState {
  return { schemaVersion: 2, services: [], runs: [], operations: [], permissionLeases: [] }
}

function service(serviceId: string): ServiceSnapshot {
  return {
    serviceId,
    workspaceId: `workspace-${serviceId}`,
    workspace: `C:\\workspace\\${serviceId}`,
    status: 'running',
    webUrl: 'http://127.0.0.1:3080/',
    browserOpened: false,
    browserError: null,
    managedProcess: false,
    processId: null,
    attachedAt: '2026-08-19T00:00:00.000Z',
    stoppedAt: null,
  }
}

function run(status: RunStatus, lastEventSeq: number, assistantText: string, runId = 'run-1'): PersistedRun {
  return {
    baselineSeq: 0,
    promptRpcId: 'rpc-1',
    snapshot: {
      runId,
      serviceId: 'service-1',
      sessionId: 'session-1',
      sessionReused: false,
      parentRunId: null,
      workspace: 'C:\\workspace',
      webUrl: 'http://127.0.0.1:3080/?sessionId=session-1',
      status,
      modelSelection: null,
      permissionPreset: 'read-only',
      agentPreset: null,
      modelDefaultRestore: 'not-needed',
      warnings: [],
      task: '[prompt text not persisted]',
      taskPersisted: false,
      taskImageCount: 0,
      cancelRequested: false,
      startedAt: '2026-08-19T00:00:00.000Z',
      finishedAt: status === 'running' ? null : '2026-08-19T00:01:00.000Z',
      promptAdmission: 'accepted',
      promptMessageId: 'message-1',
      assistantText,
      assistantTextBytes: Buffer.byteLength(assistantText, 'utf8'),
      assistantTextTruncated: false,
      lastEventSeq,
      error: null,
    },
  }
}

function operation(operationId: string): OperationRecord {
  return {
    operationId,
    clientPrincipalId: 'local-user',
    idempotencyKey: 'same-key',
    requestFingerprint: 'same-fingerprint',
    runId: `run-${operationId}`,
    kind: 'start',
    rpcId: `rpc-${operationId}`,
    fencingEpoch: 0,
    state: 'prepared',
    messageId: null,
    error: null,
    createdAt: '2026-08-19T00:00:00.000Z',
    updatedAt: '2026-08-19T00:00:00.000Z',
  }
}
