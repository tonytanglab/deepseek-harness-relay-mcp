import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  defaultProcessProbe,
  FileLockFacade,
  processStartIdentity,
  reclaimStaleLock,
  type FileLockOptions,
  type FilePermissionBackend,
} from '../src/state-repository/index.js'
import { RelayStateStore } from '../src/state-store.js'

test('acquire records PID, process startup identity, and a fencing token', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-lock-record-'))
  const lockPath = join(directory, 'state.json.lock')
  const startedAt = processStartIdentity()
  const locks = new FileLockFacade({
    processId: process.pid,
    processStartedAt: startedAt,
    timeoutMs: 500,
    retryMs: 5,
    permissions: noopPermissions,
  })
  const lease = await locks.acquire(lockPath)
  const record = JSON.parse(await readFile(lockPath, 'utf8')) as {
    ownerToken: string
    processId: number
    processStartedAt: string
    acquiredAt: string
  }
  assert.equal(record.ownerToken, lease.ownerToken)
  assert.equal(record.processId, process.pid)
  assert.equal(record.processStartedAt, startedAt)
  assert.equal(lease.processStartedAt, startedAt)
  assert.equal(await lease.release(), true)
  await rm(directory, { recursive: true, force: true })
})

test('lease release uses compare-before-delete and preserves a replaced lock record', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-lock-release-race-'))
  const lockPath = join(directory, 'state.json.lock')
  const locks = new FileLockFacade({ timeoutMs: 500, retryMs: 5, permissions: noopPermissions })
  const lease = await locks.acquire(lockPath)
  await writtenLock(lockPath, deadRecord('replacement-owner'))
  assert.equal(await lease.release(), false)
  assert.equal((await locks.inspect(lockPath)).record?.ownerToken, 'replacement-owner')
  await rm(directory, { recursive: true, force: true })
})

const noopPermissions: FilePermissionBackend = {
  platform: 'linux',
  async restrict(): Promise<void> {},
  async check() { return { restricted: true } },
}

function deadRecord(ownerToken: string, processId = 2_147_483_647): Record<string, unknown> {
  return {
    schemaVersion: 1,
    ownerToken,
    processId,
    processStartedAt: '2026-08-19T00:00:00.000Z',
    acquiredAt: '2026-08-19T00:00:00.000Z',
  }
}

async function writtenLock(path: string, record: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(record)}\n`, { encoding: 'utf8' })
}

test('inspect classifies a dead owner and recoverStale deletes it with compare-before-delete', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-lock-recover-dead-'))
  const lockPath = join(directory, 'state.json.lock')
  await writtenLock(lockPath, deadRecord('crashed-owner'))
  const locks = new FileLockFacade({ timeoutMs: 200, retryMs: 5 })
  const inspection = await locks.inspect(lockPath)
  assert.equal(inspection.present, true)
  assert.equal(inspection.valid, true)
  assert.equal(inspection.ownerState, 'dead')
  assert.equal(inspection.record?.ownerToken, 'crashed-owner')

  const outcome = await locks.recoverStale(lockPath)
  assert.equal(outcome.recovered, true)
  assert.equal((await locks.inspect(lockPath)).present, false)
  await rm(directory, { recursive: true, force: true })
})

test('live and unknown owners fail closed; no time-based stealing', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-lock-recover-live-'))
  const locks = new FileLockFacade({ timeoutMs: 200, retryMs: 5, processId: 42, permissions: noopPermissions })
  const livePath = join(directory, 'live.lock')
  await writtenLock(livePath, deadRecord('live-owner', process.pid))
  assert.equal((await locks.inspect(livePath)).ownerState, 'alive')
  assert.deepEqual(await locks.recoverStale(livePath), { recovered: false, reason: 'owner-alive' })

  const unknownPath = join(directory, 'unknown.lock')
  await writtenLock(unknownPath, { ...deadRecord('unknown-owner'), processId: 42 })
  const unknownLocks = new FileLockFacade({ timeoutMs: 200, retryMs: 5, probe: () => 'unknown' })
  assert.equal((await unknownLocks.inspect(unknownPath)).ownerState, 'unknown')
  assert.deepEqual(await unknownLocks.recoverStale(unknownPath), { recovered: false, reason: 'owner-unknown' })

  const validLease = await locks.acquire(livePath).catch(() => null)
  assert.equal(validLease, null, 'a live lock is never taken over')
  assert.equal((await locks.inspect(livePath)).record?.ownerToken, 'live-owner')
  await rm(directory, { recursive: true, force: true })
})

test('a reused PID with a different startup identity is never recovered', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-lock-reused-pid-'))
  const lockPath = join(directory, 'state.json.lock')
  await writtenLock(lockPath, deadRecord('reused-pid-owner', process.pid))
  const locks = new FileLockFacade({ timeoutMs: 200, retryMs: 5 })
  assert.deepEqual(await locks.recoverStale(lockPath), { recovered: false, reason: 'owner-alive' })
  assert.equal((await locks.inspect(lockPath)).record?.ownerToken, 'reused-pid-owner')
  await rm(directory, { recursive: true, force: true })
})

test('a record changed between read and recovery is never deleted', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-lock-race-'))
  const lockPath = join(directory, 'state.json.lock')
  const original = deadRecord('original-owner')
  await writtenLock(lockPath, original)
  const outcome = await reclaimStaleLock(lockPath, record => record.ownerToken === 'someone-else')
  assert.equal(outcome.deleted, false)
  assert.match(outcome.reason, /record-changed/u)
  const current = JSON.parse(await readFile(lockPath, 'utf8')) as { ownerToken: string }
  assert.equal(current.ownerToken, 'original-owner', 'the changed record was restored, never deleted')
  await rm(directory, { recursive: true, force: true })
})

test('a malformed lock record is reported as unknown and never recovered', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-lock-invalid-'))
  const lockPath = join(directory, 'state.json.lock')
  await writeFile(lockPath, '{not-json', { encoding: 'utf8' })
  const locks = new FileLockFacade({ timeoutMs: 200, retryMs: 5 })
  const inspection = await locks.inspect(lockPath)
  assert.equal(inspection.present, true)
  assert.equal(inspection.valid, false)
  assert.equal(inspection.ownerState, 'unknown')
  assert.deepEqual(await locks.recoverStale(lockPath), { recovered: false, reason: 'invalid-record' })
  assert.equal(await readFile(lockPath, 'utf8'), '{not-json', 'malformed locks are never deleted')
  await rm(directory, { recursive: true, force: true })
})

test('legacy lock records without a startup identity are fenced by token only', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-lock-legacy-'))
  const lockPath = join(directory, 'state.json.lock')
  await writtenLock(lockPath, { ownerToken: 'legacy-token', processId: 2_147_483_647, acquiredAt: '2026-08-19T00:00:00.000Z' })
  const locks = new FileLockFacade({ timeoutMs: 200, retryMs: 5 })
  const inspection = await locks.inspect(lockPath)
  assert.equal(inspection.valid, true)
  assert.equal(inspection.record?.processStartedAt, null)
  assert.equal((await locks.inspect(lockPath)).ownerState, 'dead')
  await rm(directory, { recursive: true, force: true })
})

test('acquire with a dead but still-present lock fails closed instead of stealing', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-lock-no-auto-steal-'))
  const lockPath = join(directory, 'state.json.lock')
  await writtenLock(lockPath, deadRecord('still-present'))
  const locks = new FileLockFacade({ timeoutMs: 100, retryMs: 5 })
  await assert.rejects(locks.acquire(lockPath), /timed out acquiring DSH Relay state lock/u)
  assert.equal((await locks.inspect(lockPath)).record?.ownerToken, 'still-present')
  await rm(directory, { recursive: true, force: true })
})

test('defaultProcessProbe and processStartIdentity are stable', () => {
  assert.equal(defaultProcessProbe(process.pid), 'alive')
  assert.equal(defaultProcessProbe(2_147_483_647), 'dead')
  assert.equal(defaultProcessProbe(0), 'unknown')
  assert.equal(defaultProcessProbe(123, () => { throw Object.assign(new Error('denied'), { code: 'EPERM' }) }), 'alive')
  const startedAt = processStartIdentity()
  assert.equal(Number.isFinite(Date.parse(startedAt)), true)
})

test('FileLockFacade options accept an injected probe for deterministic recovery', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-lock-probe-'))
  const lockPath = join(directory, 'state.json.lock')
  await writtenLock(lockPath, deadRecord('probe-owner'))
  const options: FileLockOptions = {
    timeoutMs: 200,
    retryMs: 5,
    probe: processId => processId === 2_147_483_647 ? 'dead' : 'unknown',
  }
  const locks = new FileLockFacade(options)
  assert.equal((await locks.inspect(lockPath)).ownerState, 'dead')
  const outcome = await locks.recoverStale(lockPath)
  assert.equal(outcome.recovered, true)
  await rm(directory, { recursive: true, force: true })
})

test('RelayStateStore exposes lock diagnostics and explicit stale recovery for doctor', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-store-lock-diag-'))
  const statePath = join(directory, 'state.json')
  const store = new RelayStateStore(statePath, { permissions: noopPermissions, probe: () => 'unknown' })
  assert.equal((await store.inspectLockState()).stateFile.present, false)

  await writtenLock(`${statePath}.lock`, deadRecord('stale-store-lock'))
  const inspecting = await store.inspectLockState()
  assert.equal(inspecting.stateFile.present, true)
  assert.equal(inspecting.stateFile.ownerState, 'unknown', 'live/unknown probes are reported as not recoverable')
  assert.doesNotMatch(JSON.stringify(inspecting), /stale-store-lock/u, 'doctor diagnostics never expose the fencing token')

  const recovering = new RelayStateStore(statePath, { permissions: noopPermissions, probe: () => 'dead' })
  const outcome = await recovering.recoverStaleLock()
  assert.equal(outcome.recovered, true)
  assert.equal((await store.inspectLockState()).stateFile.present, false)
  await rm(directory, { recursive: true, force: true })
})

test('RelayStateStore recovers all dead state and session locks only through the explicit authority path', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-store-lock-recover-all-'))
  const statePath = join(directory, 'state.json')
  const stateLock = `${statePath}.lock`
  const sessionLock = `${statePath}.session.${'a'.repeat(64)}.lock`
  await writtenLock(stateLock, deadRecord('dead-state-owner'))
  await writtenLock(sessionLock, deadRecord('dead-session-owner'))
  const store = new RelayStateStore(statePath, { permissions: noopPermissions, probe: () => 'dead' })

  const report = await store.recoverDeadLocks()

  assert.deepEqual(report.recovered.sort(), [sessionLock, stateLock].sort())
  assert.deepEqual(report.skipped, [])
  assert.match(store.recoveryWarning ?? '', /Recovered 2 stale state locks/iu)
  assert.equal((await store.inspectLockState()).stateFile.present, false)
  assert.deepEqual((await store.inspectLockState()).sessionLocks, [])
  await rm(directory, { recursive: true, force: true })
})

test('RelayStateStore leaves live and unknown locks untouched during explicit dead-lock recovery', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-store-lock-recover-safe-'))
  const statePath = join(directory, 'state.json')
  const stateLock = `${statePath}.lock`
  const sessionLock = `${statePath}.session.${'b'.repeat(64)}.lock`
  await writtenLock(stateLock, deadRecord('live-state-owner'))
  await writtenLock(sessionLock, deadRecord('unknown-session-owner', 8123))
  const store = new RelayStateStore(statePath, {
    permissions: noopPermissions,
    probe: processId => processId === 2_147_483_647 ? 'alive' : 'unknown',
  })

  const report = await store.recoverDeadLocks()

  assert.deepEqual(report.recovered, [])
  assert.deepEqual(report.skipped.map(item => item.reason).sort(), ['owner-alive', 'owner-unknown'])
  assert.equal((await store.inspectLockState()).stateFile.present, true)
  assert.equal((await store.inspectLockState()).sessionLocks.length, 1)
  await rm(directory, { recursive: true, force: true })
})
