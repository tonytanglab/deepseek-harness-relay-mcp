import { randomUUID } from 'node:crypto'
import { link, mkdir, open, rename, unlink } from 'node:fs/promises'
import { dirname } from 'node:path'
import { isCode, readTextFileStrict } from '../strict-utf8.js'
import { NodeFilePermissionBackend, type FilePermissionBackend } from './file-permissions.js'

export type LockOwnerState = 'none' | 'alive' | 'dead' | 'unknown'

export interface ProcessProbe {
  (processId: number): 'alive' | 'dead' | 'unknown'
}

export interface FileLockOptions {
  timeoutMs?: number
  retryMs?: number
  probe?: ProcessProbe
  permissions?: FilePermissionBackend
  processId?: number
  processStartedAt?: string
  now?: () => Date
}

export interface LockRecord {
  schemaVersion: 1
  ownerToken: string
  processId: number
  /** Process startup identity recorded at acquisition; null for legacy records. */
  processStartedAt: string | null
  acquiredAt: string
}

export interface FileLockLease {
  ownerToken: string
  processId: number
  processStartedAt: string | null
  release(): Promise<boolean>
}

export interface FileLockInspection {
  lockPath: string
  present: boolean
  valid: boolean
  record: LockRecord | null
  ownerState: LockOwnerState
  detail: string | null
}

export class FileLockFacade {
  readonly #timeoutMs: number
  readonly #retryMs: number
  readonly #probe: ProcessProbe
  readonly #permissions: FilePermissionBackend
  readonly #processId: number
  readonly #processStartedAt: string
  readonly #now: () => Date

  constructor(options: FileLockOptions = {}) {
    // Windows ACL hardening launches a native security operation before the
    // lock is published, so heavily contended multi-process writers need a
    // wider bounded wait than POSIX chmod callers.
    this.#timeoutMs = positiveInteger(options.timeoutMs ?? (process.platform === 'win32' ? 30_000 : 5_000), 'timeoutMs')
    this.#retryMs = positiveInteger(options.retryMs ?? 25, 'retryMs')
    this.#probe = options.probe ?? defaultProcessProbe
    this.#permissions = options.permissions ?? new NodeFilePermissionBackend()
    this.#processId = options.processId ?? process.pid
    this.#processStartedAt = options.processStartedAt ?? processStartIdentity()
    this.#now = options.now ?? (() => new Date())
  }

  async acquire(lockPath: string): Promise<FileLockLease> {
    await mkdir(dirname(lockPath), { recursive: true })
    const deadline = Date.now() + this.#timeoutMs
    while (true) {
      const ownerToken = randomUUID()
      let created = false
      const record: LockRecord = {
        schemaVersion: 1,
        ownerToken,
        processId: this.#processId,
        processStartedAt: this.#processStartedAt,
        acquiredAt: this.#now().toISOString(),
      }
      const temporary = `${lockPath}.${process.pid}.${ownerToken}.tmp`
      try {
        const handle = await open(temporary, 'wx', 0o600)
        created = true
        try {
          await handle.writeFile(`${JSON.stringify(record)}\n`, { encoding: 'utf8' })
        } finally {
          await handle.close()
        }
        // Never swallow a permission failure: the lock file is sensitive.
        await this.#permissions.restrict(temporary)
        await link(temporary, lockPath)
        await unlink(temporary)
        return this.#lease(lockPath, record)
      } catch (error) {
        if (created) {
          try { await unlink(temporary) } catch (cleanupError) { if (!isCode(cleanupError, 'ENOENT')) throw cleanupError }
        }
        if (!isCode(error, 'EEXIST')) throw error
        // Diagnose a corrupt lock body immediately; an undecodable record must
        // never be silently repaired or waited out, and never stolen.
        await readLockRecord(lockPath)
        if (Date.now() >= deadline) {
          throw new Error(`timed out acquiring DSH Relay state lock: ${lockPath}`)
        }
        await delay(this.#retryMs)
      }
    }
  }

  /** Reads and classifies a lock without mutating it; never steals by age. */
  async inspect(lockPath: string): Promise<FileLockInspection> {
    const record = await readLockRecord(lockPath)
    if (record === null) {
      return { lockPath, present: false, valid: false, record: null, ownerState: 'none', detail: 'missing' }
    }
    if (record.invalid || record.record === null) {
      return { lockPath, present: true, valid: false, record: null, ownerState: 'unknown', detail: record.detail }
    }
    return {
      lockPath,
      present: true,
      valid: true,
      record: record.record,
      ownerState: this.#probe(record.record.processId),
      detail: null,
    }
  }

  /**
   * Explicit stale-lock recovery: succeeds only when the owner process is
   * provably dead AND the lock record still matches the inspected record;
   * live and unknown owners fail closed. Deletion is compare-before-delete so
   * a reused PID or a record changed by a racing writer is never deleted.
   */
  async recoverStale(lockPath: string): Promise<{ recovered: boolean; reason: string }> {
    const inspection = await this.inspect(lockPath)
    if (!inspection.present) return { recovered: false, reason: 'missing' }
    if (!inspection.valid || inspection.record === null) return { recovered: false, reason: 'invalid-record' }
    if (inspection.ownerState !== 'dead') return { recovered: false, reason: `owner-${inspection.ownerState}` }
    const outcome = await reclaimStaleLock(lockPath, record =>
      record.ownerToken === inspection.record!.ownerToken
        && record.processId === inspection.record!.processId
        && record.processStartedAt === inspection.record!.processStartedAt,
    path => this.#permissions.restrict(path))
    return { recovered: outcome.deleted, reason: outcome.reason }
  }

  #lease(lockPath: string, expected: LockRecord): FileLockLease {
    let released = false
    return {
      ownerToken: expected.ownerToken,
      processId: this.#processId,
      processStartedAt: this.#processStartedAt,
      release: async () => {
        if (released) return false
        released = true
        const outcome = await reclaimStaleLock(lockPath, record =>
          record.ownerToken === expected.ownerToken
            && record.processId === expected.processId
            && record.processStartedAt === expected.processStartedAt,
        path => this.#permissions.restrict(path))
        return outcome.deleted
      },
    }
  }
}

/**
 * Compare-before-delete reclamation used by stale-lock recovery: atomically
 * claims the file, verifies the claimed record still matches, and only then
 * deletes it. A mismatch (ABA, PID reuse, racing writer) restores the claim
 * via a hard link when the path is free, or leaves it for inspection when the
 * path was re-acquired; the caller never deletes a lock it cannot verify.
 */
export async function reclaimStaleLock(
  lockPath: string,
  matches: (record: Readonly<Record<string, unknown>>) => boolean,
  restorePermissions?: (path: string) => Promise<void>,
): Promise<{ deleted: boolean; reason: string; detail?: string }> {
  const tombstone = `${lockPath}.stale-${randomUUID()}`
  try {
    await rename(lockPath, tombstone)
  } catch (error) {
    if (isCode(error, 'ENOENT')) return { deleted: false, reason: 'missing' }
    throw error
  }
  let claimed: Readonly<Record<string, unknown>> | null
  let claimedText: string | null
  try {
    claimedText = await readTextFileStrict(tombstone)
    claimed = claimedText === null ? null : JSON.parse(claimedText) as Record<string, unknown>
  } catch (error) {
    return { deleted: false, reason: 'unreadable-claim', detail: error instanceof Error ? error.message : String(error) }
  }
  if (claimed !== null && isRecord(claimed) && matches(claimed)) {
    try {
      await unlink(tombstone)
      return { deleted: true, reason: 'deleted' }
    } catch (error) {
      if (isCode(error, 'ENOENT')) return { deleted: true, reason: 'deleted' }
      throw error
    }
  }
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
    if ((isCode(error, 'EPERM') || isCode(error, 'ENOSYS') || isCode(error, 'EOPNOTSUPP')) && claimedText !== null) {
      return restoreClaimByCopy(lockPath, tombstone, claimedText, restorePermissions)
    }
    throw error
  }
}

async function restoreClaimByCopy(
  lockPath: string,
  tombstone: string,
  text: string,
  restorePermissions?: (path: string) => Promise<void>,
): Promise<{ deleted: false; reason: string }> {
  let handle: Awaited<ReturnType<typeof open>>
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
  if (restorePermissions !== undefined) await restorePermissions(lockPath)
  await unlink(tombstone)
  return { deleted: false, reason: 'record-changed-restored-copy' }
}

export function defaultProcessProbe(processId: number): 'alive' | 'dead' | 'unknown' {
  if (!Number.isSafeInteger(processId) || processId <= 0) return 'unknown'
  try {
    process.kill(processId, 0)
    return 'alive'
  } catch (error) {
    if (isCode(error, 'ESRCH')) return 'dead'
    return 'unknown'
  }
}

export function processStartIdentity(pid = process.pid, uptimeSeconds = process.uptime()): string {
  return new Date(Date.now() - uptimeSeconds * 1_000).toISOString()
}

interface ReadLockResult {
  invalid: boolean
  detail: string | null
  record: LockRecord | null
}

async function readLockRecord(lockPath: string): Promise<ReadLockResult | null> {
  const text = await readTextFileStrict(lockPath)
  if (text === null) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return { invalid: true, detail: 'malformed lock record', record: null }
  }
  if (
    !isRecord(parsed)
    || typeof parsed.ownerToken !== 'string' || parsed.ownerToken.length === 0
    || typeof parsed.processId !== 'number' || !Number.isSafeInteger(parsed.processId) || parsed.processId <= 0
    || typeof parsed.acquiredAt !== 'string'
  ) {
    return { invalid: true, detail: 'malformed lock record', record: null }
  }
  const legacy = parsed.processStartedAt === undefined
  const processStartedAt = typeof parsed.processStartedAt === 'string' ? parsed.processStartedAt : null
  if (!legacy && processStartedAt === null) {
    return { invalid: true, detail: 'malformed lock record', record: null }
  }
  return {
    invalid: false,
    detail: null,
    record: {
      schemaVersion: 1,
      ownerToken: parsed.ownerToken,
      processId: parsed.processId,
      processStartedAt,
      acquiredAt: parsed.acquiredAt,
    },
  }
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new RangeError(`${name} must be a positive safe integer`)
  return value
}

function delay(timeoutMs: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, timeoutMs))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
