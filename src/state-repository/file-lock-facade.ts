import { randomUUID } from 'node:crypto'
import { chmod, mkdir, open, readFile, unlink } from 'node:fs/promises'
import { dirname } from 'node:path'

export interface FileLockOptions {
  timeoutMs?: number
  retryMs?: number
}

export interface FileLockLease {
  ownerToken: string
  release(): Promise<boolean>
}

interface LockRecord {
  ownerToken: string
  processId: number
  acquiredAt: string
}

export class FileLockFacade {
  readonly #timeoutMs: number
  readonly #retryMs: number

  constructor(options: FileLockOptions = {}) {
    this.#timeoutMs = positiveInteger(options.timeoutMs ?? 5_000, 'timeoutMs')
    this.#retryMs = positiveInteger(options.retryMs ?? 25, 'retryMs')
  }

  async acquire(lockPath: string): Promise<FileLockLease> {
    await mkdir(dirname(lockPath), { recursive: true })
    const deadline = Date.now() + this.#timeoutMs
    while (true) {
      const ownerToken = randomUUID()
      let created = false
      const record: LockRecord = {
        ownerToken,
        processId: process.pid,
        acquiredAt: new Date().toISOString(),
      }
      try {
        const handle = await open(lockPath, 'wx', 0o600)
        created = true
        try {
          await handle.writeFile(`${JSON.stringify(record)}\n`, { encoding: 'utf8' })
        } finally {
          await handle.close()
        }
        await restrictPermissions(lockPath)
        return this.#lease(lockPath, ownerToken)
      } catch (error) {
        if (created) {
          try { await unlink(lockPath) } catch (cleanupError) { if (!isCode(cleanupError, 'ENOENT')) throw cleanupError }
        }
        if (!isCode(error, 'EEXIST')) throw error
        if (Date.now() >= deadline) {
          throw new Error(`timed out acquiring DSH Relay state lock: ${lockPath}`)
        }
        await delay(this.#retryMs)
      }
    }
  }

  #lease(lockPath: string, ownerToken: string): FileLockLease {
    let released = false
    return {
      ownerToken,
      release: async () => {
        if (released) return false
        released = true
        const current = await readLockRecord(lockPath)
        if (current === null || current.ownerToken !== ownerToken) return false
        try {
          await unlink(lockPath)
          return true
        } catch (error) {
          if (isCode(error, 'ENOENT')) return false
          throw error
        }
      },
    }
  }
}

async function readLockRecord(lockPath: string): Promise<LockRecord | null> {
  let text: string
  try {
    text = await readFile(lockPath, { encoding: 'utf8' })
  } catch (error) {
    if (isCode(error, 'ENOENT')) return null
    throw error
  }
  try {
    const parsed: unknown = JSON.parse(text)
    if (
      typeof parsed === 'object' && parsed !== null
      && 'ownerToken' in parsed && typeof parsed.ownerToken === 'string'
      && 'processId' in parsed && typeof parsed.processId === 'number'
      && 'acquiredAt' in parsed && typeof parsed.acquiredAt === 'string'
    ) return parsed as LockRecord
  } catch {
    return null
  }
  return null
}

async function restrictPermissions(path: string): Promise<void> {
  try {
    await chmod(path, 0o600)
  } catch (error) {
    if (process.platform !== 'win32') throw error
  }
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new RangeError(`${name} must be a positive safe integer`)
  return value
}

function delay(timeoutMs: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, timeoutMs))
}

function isCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code
}
