import { randomUUID } from 'node:crypto'
import { mkdir, open, readdir, rename, rm, stat, unlink, link } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { readJsonFileStrict, readTextFileStrict } from './strict-utf8.mjs'

const BUILD_LOCK_SCHEMA_VERSION = 1

export class BuildLockError extends Error {
  constructor(message, options) {
    super(message, options)
    this.name = 'BuildLockError'
    this.code = 'BUILD_LOCK_ERROR'
  }
}

export function processStartIdentity(pid = process.pid, uptimeMs = process.uptime() * 1000) {
  return new Date(Date.now() - uptimeMs).toISOString()
}

export function defaultProcessProbe(processId, signalProcess = process.kill) {
  if (!Number.isSafeInteger(processId) || processId <= 0) return 'unknown'
  try {
    signalProcess(processId, 0)
    return 'alive'
  } catch (error) {
    if (error?.code === 'ESRCH') return 'dead'
    if (error?.code === 'EPERM') return 'alive'
    return 'unknown'
  }
}

export async function acquireBuildLock(lockPath, options = {}) {
  const timeoutMs = positiveInteger(options.timeoutMs ?? 900_000, 'timeoutMs')
  const retryMs = positiveInteger(options.retryMs ?? 100, 'retryMs')
  const probe = options.probe ?? defaultProcessProbe
  const now = options.now ?? (() => new Date())
  const sleep = options.sleep ?? delay
  const processId = options.processId ?? process.pid
  const processStartedAt = options.processStartedAt ?? processStartIdentity()
  const deadline = Date.now() + timeoutMs
  await mkdir(dirname(lockPath), { recursive: true })
  while (true) {
    const ownerToken = randomUUID()
    const record = {
      schemaVersion: BUILD_LOCK_SCHEMA_VERSION,
      ownerToken,
      processId,
      processStartedAt,
      acquiredAt: now().toISOString(),
    }
    try {
      const handle = await open(lockPath, 'wx', 0o600)
      try {
        await handle.writeFile(`${JSON.stringify(record)}\n`, { encoding: 'utf8' })
        await handle.sync()
      } finally {
        await handle.close()
      }
      return buildLockLease(lockPath, record)
    } catch (error) {
      if (!isCode(error, 'EEXIST')) throw error
      // Never steal by age. A stale lock is reclaimed only when the recorded
      // process is provably dead and the recorded identity still matches.
      const existing = await inspectBuildLock(lockPath)
      if (existing.present && existing.valid && probe(existing.record.processId) === 'dead') {
        const outcome = await reclaimBuildLock(lockPath, existing.record)
        if (outcome.deleted) continue
        if (outcome.reason !== 'missing') throw new BuildLockError(`build lock recovery failed (${outcome.reason}): ${lockPath}`)
        continue
      }
      if (Date.now() >= deadline) {
        throw new BuildLockError(`timed out acquiring build lock (the owner may still be building): ${lockPath}`)
      }
      await sleep(retryMs)
    }
  }
}

export async function withBuildLock(lockPath, operation, options = {}) {
  const lease = await acquireBuildLock(lockPath, options)
  try {
    return await operation()
  } finally {
    await lease.release()
  }
}

export async function inspectBuildLock(lockPath) {
  try {
    const record = await readJsonFileStrict(lockPath)
    if (!isRecord(record) || typeof record.ownerToken !== 'string' || record.ownerToken.length === 0
      || !Number.isSafeInteger(record.processId) || record.processId <= 0
      || typeof record.processStartedAt !== 'string' || typeof record.acquiredAt !== 'string') {
      return { present: true, valid: false, record: null, detail: 'malformed-record' }
    }
    return { present: true, valid: true, record, detail: null }
  } catch (error) {
    if (isCode(error, 'ENOENT')) return { present: false, valid: false, record: null, detail: 'missing' }
    if (error instanceof SyntaxError) return { present: true, valid: false, record: null, detail: 'malformed-record' }
    if (/UTF-8/u.test(error?.message ?? '')) throw error
    return { present: true, valid: false, record: null, detail: 'malformed-record' }
  }
}

/**
 * Explicit stale recovery: claims the lock file and deletes it only when the
 * claimed record still matches `expected`. Uses compare-before-delete so a
 * reusable PID or a record changed by a racing writer can never be deleted.
 * Returns { deleted: true } on success, or the reason it failed closed.
 */
export async function reclaimBuildLock(lockPath, expected) {
  const tombstone = `${lockPath}.stale-${randomUUID()}`
  try {
    await rename(lockPath, tombstone)
  } catch (error) {
    if (isCode(error, 'ENOENT')) return { deleted: false, reason: 'missing' }
    throw error
  }
  let claimed
  let claimedText
  try {
    claimedText = await readTextFileStrict(tombstone)
    claimed = await inspectBuildLock(tombstone)
  } catch (error) {
    return { deleted: false, reason: 'unreadable-claim', detail: error?.message ?? String(error) }
  }
  if (!claimed.valid || !recordMatches(claimed.record, expected)) {
    // The record changed while we were racing; restore it when the path is
    // still free, otherwise leave the claim for inspection and fail closed.
    try {
      await link(tombstone, lockPath)
      try {
        await unlink(tombstone)
      } catch (error) {
        if (!isCode(error, 'ENOENT')) throw error
      }
      return { deleted: false, reason: 'record-changed-restored' }
    } catch (error) {
      if (isCode(error, 'EEXIST')) return { deleted: false, reason: 'record-changed-path-reacquired' }
      if (isCode(error, 'EPERM') || isCode(error, 'ENOSYS') || isCode(error, 'EOPNOTSUPP')) {
        return restoreBuildClaimByCopy(lockPath, tombstone, claimedText)
      }
      throw error
    }
  }
  try {
    await unlink(tombstone)
    return { deleted: true, reason: 'deleted' }
  } catch (error) {
    if (isCode(error, 'ENOENT')) return { deleted: true, reason: 'deleted' }
    throw error
  }
}

export function buildLockLease(lockPath, expected) {
  let released = false
  return {
    ownerToken: expected.ownerToken,
    release: async () => {
      if (released) return false
      released = true
      const outcome = await reclaimBuildLock(lockPath, expected)
      return outcome.deleted
    },
  }
}

async function restoreBuildClaimByCopy(lockPath, tombstone, text) {
  let handle
  try {
    handle = await open(lockPath, 'wx', 0o600)
  } catch (error) {
    if (isCode(error, 'EEXIST')) return { deleted: false, reason: 'record-changed-path-reacquired' }
    return { deleted: false, reason: 'record-changed-claim-left' }
  }
  try {
    await handle.writeFile(text, { encoding: 'utf8' })
    await handle.sync()
  } finally {
    await handle.close()
  }
  await unlink(tombstone)
  return { deleted: false, reason: 'record-changed-restored-copy' }
}

/**
 * Atomically promotes a fully staged artifact directory over `distDir`.
 * The previous `distDir` is kept intact until the staged tree is in place;
 * any failure restores it before propagating the error.
 */
export async function promoteArtifacts(stagingDir, distDir, options = {}) {
  const renameImpl = options.rename ?? rename
  const rmImpl = options.rm ?? rm
  const existed = await exists(distDir)
  const backup = `${distDir}.backup-${process.pid}-${randomUUID()}`
  if (existed) await renameImpl(distDir, backup)
  try {
    await renameImpl(stagingDir, distDir)
  } catch (error) {
    if (existed) {
      try {
        await renameImpl(backup, distDir)
      } catch (restoreError) {
        throw new Error(
          `promotion failed (${error?.message ?? error}) and the previous build could not be restored: ${restoreError?.message ?? restoreError}`,
          { cause: error },
        )
      }
    }
    throw error
  }
  if (existed) {
    try {
      await rmImpl(backup, { recursive: true, force: true })
    } catch (cleanupError) {
      process.stderr.write(`warn: failed to remove previous build backup ${backup}: ${cleanupError?.message ?? cleanupError}\n`)
    }
  }
}

export async function removePromotedBackup(distDir, options = {}) {
  const rmImpl = options.rm ?? rm
  const entries = await listBackups(distDir)
  for (const backup of entries) {
    await rmImpl(backup, { recursive: true, force: true })
  }
}

async function listBackups(distDir) {
  const parent = dirname(distDir)
  const base = distDir.split(/[\\/]/u).pop() ?? distDir
  try {
    const names = await readdir(parent)
    return names.filter(name => name.startsWith(`${base}.backup-`)).map(name => join(parent, name))
  } catch (error) {
    if (isCode(error, 'ENOENT')) return []
    throw error
  }
}

function recordMatches(left, right) {
  return isRecord(left) && isRecord(right)
    && left.ownerToken === right.ownerToken
    && left.processId === right.processId
    && left.processStartedAt === right.processStartedAt
}

async function exists(path) {
  try {
    await stat(path)
    return true
  } catch (error) {
    if (isCode(error, 'ENOENT')) return false
    throw error
  }
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function positiveInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 1) throw new RangeError(`${name} must be a positive safe integer`)
  return value
}

function isCode(error, code) {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code
}

function delay(timeoutMs) {
  return new Promise(resolve => setTimeout(resolve, timeoutMs))
}
