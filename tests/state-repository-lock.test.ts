import assert from 'node:assert/strict'
import { readFile, rm, unlink, writeFile, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { FileLockFacade } from '../src/state-repository/index.js'

test('an old lease cannot delete a replacement lock owned by another token', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-relay-lock-'))
  const lockPath = join(directory, 'state.json.lock')
  const locks = new FileLockFacade({ timeoutMs: 100, retryMs: 5 })
  const oldLease = await locks.acquire(lockPath)
  await unlink(lockPath)
  const replacementLease = await locks.acquire(lockPath)

  assert.notEqual(oldLease.ownerToken, replacementLease.ownerToken)
  assert.equal(await oldLease.release(), false)
  const record = JSON.parse(await readFile(lockPath, { encoding: 'utf8' })) as { ownerToken: string }
  assert.equal(record.ownerToken, replacementLease.ownerToken)
  await assert.rejects(locks.acquire(lockPath), /timed out acquiring DSH Relay state lock/)
  assert.equal(await replacementLease.release(), true)
  await rm(directory, { recursive: true, force: true })
})

test('a pre-existing lock is never deleted or taken over based only on age', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-relay-lock-'))
  const lockPath = join(directory, 'state.json.lock')
  const ownerToken = 'external-owner'
  await writeFile(lockPath, `${JSON.stringify({
    ownerToken,
    processId: 1,
    acquiredAt: '2000-01-01T00:00:00.000Z',
  })}\n`, { encoding: 'utf8', mode: 0o600 })

  const locks = new FileLockFacade({ timeoutMs: 50, retryMs: 5 })
  await assert.rejects(locks.acquire(lockPath), /timed out acquiring DSH Relay state lock/)
  const record = JSON.parse(await readFile(lockPath, { encoding: 'utf8' })) as { ownerToken: string }
  assert.equal(record.ownerToken, ownerToken)
  await rm(directory, { recursive: true, force: true })
})
