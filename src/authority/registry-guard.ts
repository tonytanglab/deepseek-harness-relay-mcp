import { randomUUID } from 'node:crypto'
import { link, mkdir, open, unlink } from 'node:fs/promises'
import { dirname } from 'node:path'
import { z } from 'zod'
import { readUtf8File, reclaimStaleLock, restrictPermissions } from '../state-repository/index.js'

const guardSchema = z.object({
  ownerToken: z.string().min(1),
  processId: z.number().int().positive(),
  processStartedAt: z.string().datetime(),
}).strict()

interface RegistryGuardLease {
  release(): Promise<boolean>
}

export async function acquireRegistryGuard(
  path: string,
  processId: number,
  processStartedAt: string,
  processProbe: (processId: number) => 'alive' | 'dead' | 'unknown',
): Promise<RegistryGuardLease> {
  await mkdir(dirname(path), { recursive: true })
  const deadline = Date.now() + 5_000
  while (true) {
    const ownerToken = randomUUID()
    let created = false
    const temporary = `${path}.${processId}.${ownerToken}.tmp`
    try {
      const handle = await open(temporary, 'wx', 0o600)
      created = true
      try {
        await handle.writeFile(`${JSON.stringify({ ownerToken, processId, processStartedAt })}\n`, { encoding: 'utf8' })
        await handle.sync()
      } finally {
        await handle.close()
      }
      await restrictPermissions(temporary)
      await link(temporary, path)
      await unlink(temporary)
      return guardLease(path, ownerToken, processId, processStartedAt)
    } catch (error) {
      if (created) {
        try { await unlink(temporary) } catch (cleanupError) { if (!isCode(cleanupError, 'ENOENT')) throw cleanupError }
      }
      if (!isCode(error, 'EEXIST')) throw error
    }

    const text = await readUtf8File(path)
    if (text === null) continue
    let current: z.infer<typeof guardSchema>
    try {
      current = guardSchema.parse(JSON.parse(text))
    } catch {
      throw new Error(`invalid authority registry guard: ${path}`)
    }
    if (processProbe(current.processId) === 'dead') {
      // Compare-before-delete: reclaim only when the claimed record still
      // matches the record we probed, so a reused PID or a racing writer can
      // never have its guard deleted.
      const outcome = await reclaimStaleLock(path, record =>
        record.ownerToken === current.ownerToken
          && record.processId === current.processId
          && record.processStartedAt === current.processStartedAt,
      restrictPermissions)
      if (outcome.deleted) continue
      if (outcome.reason === 'missing') continue
      if (outcome.reason === 'record-changed-restored'
        || outcome.reason === 'record-changed-restored-copy'
        || outcome.reason === 'record-changed-path-reacquired') continue
      throw new Error(`authority registry guard changed during recovery: ${path} (${outcome.reason})`)
    }
    if (Date.now() >= deadline) throw new Error(`timed out acquiring authority registry guard: ${path}`)
    await new Promise(resolveDelay => setTimeout(resolveDelay, 20))
  }
}

function guardLease(path: string, ownerToken: string, processId: number, processStartedAt: string): RegistryGuardLease {
  let released = false
  return {
    release: async () => {
      if (released) return false
      released = true
      const text = await readUtf8File(path)
      if (text === null) return false
      let current: z.infer<typeof guardSchema>
      try {
        current = guardSchema.parse(JSON.parse(text))
      } catch {
        return false
      }
      if (current.ownerToken !== ownerToken || current.processId !== processId || current.processStartedAt !== processStartedAt) return false
      try {
        await unlink(path)
        return true
      } catch (error) {
        if (isCode(error, 'ENOENT')) return false
        throw error
      }
    },
  }
}

function isCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code
}
