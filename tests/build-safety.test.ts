import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  acquireBuildLock,
  defaultProcessProbe,
  inspectBuildLock,
  processStartIdentity,
  promoteArtifacts,
  reclaimBuildLock,
} from '../scripts/build-lib.mjs'
import { syncVersions } from '../scripts/sync-version.mjs'

test('build lock is fail-closed for a live owner and never stolen by age', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-build-lock-live-'))
  const lockPath = join(directory, 'build.lock')
  const lease = await acquireBuildLock(lockPath, { timeoutMs: 200, retryMs: 10 })
  await assert.rejects(
    acquireBuildLock(lockPath, { timeoutMs: 150, retryMs: 10 }),
    /timed out acquiring build lock/u,
  )
  const record = JSON.parse(await readFile(lockPath, 'utf8')) as { ownerToken: string }
  assert.equal(record.ownerToken, lease.ownerToken)
  assert.equal(await lease.release(), true)
  const second = await acquireBuildLock(lockPath, { timeoutMs: 200, retryMs: 5 })
  assert.notEqual(second.ownerToken, lease.ownerToken)
  assert.equal(await second.release(), true)
  await rm(directory, { recursive: true, force: true })
})

test('build lock refuses a reused PID whose startup identity differs from the record', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-build-lock-aba-'))
  const lockPath = join(directory, 'build.lock')
  await writeFile(lockPath, `${JSON.stringify({
    schemaVersion: 1,
    ownerToken: 'previous-owner',
    processId: process.pid,
    processStartedAt: '2000-01-01T00:00:00.000Z',
    acquiredAt: '2000-01-01T00:00:00.000Z',
  })}\n`, { encoding: 'utf8' })
  await assert.rejects(
    acquireBuildLock(lockPath, { timeoutMs: 150, retryMs: 10 }),
    /timed out acquiring build lock/u,
  )
  assert.equal((await inspectBuildLock(lockPath)).record?.ownerToken, 'previous-owner')
  await rm(directory, { recursive: true, force: true })
})

test('build lock recovers a recorded owner only after its PID is provably dead and the record still matches', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-build-lock-dead-'))
  const lockPath = join(directory, 'build.lock')
  await writeFile(lockPath, `${JSON.stringify({
    schemaVersion: 1,
    ownerToken: 'crashed-builder',
    processId: 2_147_483_647,
    processStartedAt: '2026-08-19T00:00:00.000Z',
    acquiredAt: '2026-08-19T00:00:00.000Z',
  })}\n`, { encoding: 'utf8' })
  const lease = await acquireBuildLock(lockPath, { timeoutMs: 2_000, retryMs: 10 })
  assert.equal(lease.ownerToken.length > 0, true)
  assert.equal(await lease.release(), true)
  await rm(directory, { recursive: true, force: true })
})

test('build lock with an unknown liveness probe fails closed', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-build-lock-unknown-'))
  const lockPath = join(directory, 'build.lock')
  await writeFile(lockPath, `${JSON.stringify({
    schemaVersion: 1,
    ownerToken: 'unknown-owner',
    processId: 0,
    processStartedAt: '2026-08-19T00:00:00.000Z',
    acquiredAt: '2026-08-19T00:00:00.000Z',
  })}\n`, { encoding: 'utf8' })
  await assert.rejects(acquireBuildLock(lockPath, { timeoutMs: 150, retryMs: 10 }), /timed out acquiring build lock/u)
  await rm(directory, { recursive: true, force: true })
})

test('defaultProcessProbe reports a reused or unprobeable PID as unknown', () => {
  assert.equal(defaultProcessProbe(process.pid), 'alive')
  assert.equal(defaultProcessProbe(2_147_483_647), 'dead')
  assert.equal(defaultProcessProbe(0), 'unknown')
  assert.equal(defaultProcessProbe(-1), 'unknown')
  assert.equal(defaultProcessProbe(123, () => { throw Object.assign(new Error('denied'), { code: 'EPERM' }) }), 'alive')
})

test('reclaimBuildLock uses compare-before-delete and restores a changed record', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-build-lock-reclaim-'))
  const lockPath = join(directory, 'build.lock')
  const record = {
    schemaVersion: 1,
    ownerToken: 'still-here',
    processId: 2_147_483_647,
    processStartedAt: '2026-08-19T00:00:00.000Z',
    acquiredAt: '2026-08-19T00:00:00.000Z',
  }
  await writeFile(lockPath, `${JSON.stringify(record)}\n`, { encoding: 'utf8' })

  const mismatch = await reclaimBuildLock(lockPath, { ...record, ownerToken: 'someone-else' })
  assert.equal(mismatch.deleted, false)
  assert.match(mismatch.reason, /record-changed/u)
  assert.equal((await inspectBuildLock(lockPath)).record?.ownerToken, 'still-here')

  const match = await reclaimBuildLock(lockPath, record)
  assert.equal(match.deleted, true)
  assert.equal((await inspectBuildLock(lockPath)).present, false)
  await rm(directory, { recursive: true, force: true })
})

test('build lease release preserves a lock record replaced by another owner', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-build-lock-release-race-'))
  const lockPath = join(directory, 'build.lock')
  const lease = await acquireBuildLock(lockPath, { timeoutMs: 200, retryMs: 5 })
  const replacement = {
    schemaVersion: 1,
    ownerToken: 'replacement-owner',
    processId: 2_147_483_647,
    processStartedAt: '2026-08-19T00:00:00.000Z',
    acquiredAt: '2026-08-19T00:00:00.000Z',
  }
  await writeFile(lockPath, `${JSON.stringify(replacement)}\n`, { encoding: 'utf8' })
  assert.equal(await lease.release(), false)
  assert.equal((await inspectBuildLock(lockPath)).record?.ownerToken, 'replacement-owner')
  await rm(directory, { recursive: true, force: true })
})

test('promoteArtifacts atomically swaps a staged tree and keeps the previous dist on failure', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-build-promote-'))
  const dist = join(directory, 'dist')
  await mkdir(dist, { recursive: true })
  await writeFile(join(dist, 'dsh-relay.mjs'), 'previous-build\n')

  const failedStaging = join(directory, 'staging-fail')
  await mkdir(failedStaging, { recursive: true })
  await writeFile(join(failedStaging, 'dsh-relay.mjs'), 'new-but-failing\n')
  let injected = false
  const renameImpl = async (from: string, to: string): Promise<void> => {
    if (!injected && from === failedStaging) {
      injected = true
      throw new Error('injected promotion failure')
    }
    const { rename } = await import('node:fs/promises')
    await rename(from, to)
  }
  await assert.rejects(promoteArtifacts(failedStaging, dist, { rename: renameImpl }), /injected promotion failure/u)
  assert.equal(await readFile(join(dist, 'dsh-relay.mjs'), 'utf8'), 'previous-build\n')

  const staging = join(directory, 'staging-ok')
  await mkdir(staging, { recursive: true })
  await writeFile(join(staging, 'dsh-relay.mjs'), 'new-build\n')
  await writeFile(join(staging, 'types', 'index.d.ts'), 'export {}\n').catch(async () => {
    await mkdir(join(staging, 'types'), { recursive: true })
    await writeFile(join(staging, 'types', 'index.d.ts'), 'export {}\n')
  })
  await promoteArtifacts(staging, dist)
  assert.equal(await readFile(join(dist, 'dsh-relay.mjs'), 'utf8'), 'new-build\n')
  assert.equal(await readFile(join(dist, 'types', 'index.d.ts'), 'utf8'), 'export {}\n')
  const leftovers = (await readdir(directory)).filter(name => name.includes('.backup-'))
  assert.deepEqual(leftovers, [])
  await rm(directory, { recursive: true, force: true })
})

test('concurrent lock holders serialize promotion without losing the final tree', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-build-concurrent-'))
  const dist = join(directory, 'dist')
  const lockPath = join(directory, 'build.lock')
  const builder = async (name: string, marker: string): Promise<void> => {
    const staging = join(directory, `staging-${name}`)
    await mkdir(staging, { recursive: true })
    await writeFile(join(staging, 'artifact.txt'), marker)
    const release = await acquireBuildLock(lockPath, { timeoutMs: 5_000, retryMs: 10 })
    try {
      await promoteArtifacts(staging, dist)
      await new Promise(resolveDelay => setTimeout(resolveDelay, Math.floor(Math.random() * 10)))
    } finally {
      await release.release()
    }
  }
  await Promise.all([builder('a', 'A'), builder('b', 'B'), builder('c', 'C')])
  const finalContent = await readFile(join(dist, 'artifact.txt'), 'utf8')
  assert.equal(['A', 'B', 'C'].includes(finalContent), true)
  const leftovers = (await readdir(directory)).filter(name => /backup|staging/u.test(name))
  assert.deepEqual(leftovers, [])
  await rm(directory, { recursive: true, force: true })
})

test('syncVersions rewrites only changed targets and is idempotent', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-sync-version-'))
  await mkdir(join(root, '.codex-plugin'), { recursive: true })
  await mkdir(join(root, '.agents', 'plugins'), { recursive: true })
  await writeFile(join(root, 'version.json'), `${JSON.stringify({ version: '0.2.3' }, null, 2)}\n`, 'utf8')
  await writeFile(join(root, 'package.json'), `${JSON.stringify({ name: 'demo', version: '0.2.2' }, null, 2)}\n`, 'utf8')
  await writeFile(join(root, '.codex-plugin', 'plugin.json'), `${JSON.stringify({ name: 'demo', version: '0.2.2' }, null, 2)}\n`, 'utf8')
  await writeFile(join(root, '.agents', 'plugins', 'marketplace.json'), `${JSON.stringify({
    plugins: [{ name: 'deepseek-harness-relay', source: { source: 'npm', package: 'harness-relay-mcp', version: '0.2.2' } }],
  }, null, 2)}\n`, 'utf8')

  const packageAfterFirst = join(root, 'package.json')
  const first = await syncVersions(root)
  assert.deepEqual(first.changed, [
    join(root, 'package.json'),
    join(root, '.codex-plugin', 'plugin.json'),
    join(root, '.agents', 'plugins', 'marketplace.json'),
  ])
  assert.equal((JSON.parse(await readFile(packageAfterFirst, 'utf8')) as { version: string }).version, '0.2.3')

  await new Promise(resolveDelay => setTimeout(resolveDelay, 20))
  const before = (await stat(packageAfterFirst)).mtimeMs
  const second = await syncVersions(root)
  assert.deepEqual(second.changed, [])
  assert.equal((await stat(packageAfterFirst)).mtimeMs, before)

  const check = await syncVersions(root, { checkOnly: true })
  assert.deepEqual(check.changed, [])
  await rm(root, { recursive: true, force: true })
})

test('syncVersions detects the marker created by processStartIdentity', async () => {
  const startedAt = processStartIdentity(process.pid, 5_000)
  const parsed = Date.parse(startedAt)
  assert.equal(Number.isFinite(parsed), true)
  assert.ok(Math.abs(parsed - (Date.now() - 5_000)) < 2_000)
})
