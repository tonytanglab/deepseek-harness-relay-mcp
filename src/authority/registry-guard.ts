import { randomUUID } from 'node:crypto'
import { mkdir, open, rename, unlink } from 'node:fs/promises'
import { dirname } from 'node:path'
import { z } from 'zod'
import { readUtf8File, restrictPermissions } from '../state-repository/index.js'

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
    try {
      const handle = await open(path, 'wx', 0o600)
      try {
        await handle.writeFile(`${JSON.stringify({ ownerToken, processId, processStartedAt })}\n`, { encoding: 'utf8' })
        await handle.sync()
      } finally {
        await handle.close()
      }
      await restrictPermissions(path)
      return guardLease(path, ownerToken)
    } catch (error) {
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
      const tombstone = `${path}.stale.${randomUUID()}`
      try {
        await rename(path, tombstone)
        await unlink(tombstone)
      } catch (error) {
        if (!isCode(error, 'ENOENT')) throw error
      }
      continue
    }
    if (Date.now() >= deadline) throw new Error(`timed out acquiring authority registry guard: ${path}`)
    await new Promise(resolveDelay => setTimeout(resolveDelay, 20))
  }
}

function guardLease(path: string, ownerToken: string): RegistryGuardLease {
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
      if (current.ownerToken !== ownerToken) return false
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
