import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { unlink } from 'node:fs/promises'
import { z } from 'zod'
import { atomicWriteJson, readUtf8File } from '../state-repository/index.js'
import { hostIdentityKey, normalizeHostIdentity } from './host-identity.js'
import { acquireRegistryGuard } from './registry-guard.js'
import type { AcquireAuthorityInput, AuthorityOwnerLease, AuthorityOwnerRecord } from './types.js'

const ownerSchema = z.object({
  schemaVersion: z.literal(1),
  hostIdentity: z.string().min(1),
  authorityId: z.string().min(1),
  mode: z.enum(['embedded', 'standalone']),
  instanceId: z.string().min(1),
  ownerToken: z.string().min(1),
  epoch: z.number().int().positive(),
  processId: z.number().int().positive(),
  processStartedAt: z.string().datetime(),
  acquiredAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
}).strict()

const activeLeaseReferences = new Map<string, number>()

export class AuthorityConflictError extends Error {
  readonly code: 'AUTHORITY_OWNED' | 'AUTHORITY_STALE_OWNER' | 'AUTHORITY_REGISTRY_INVALID'
  readonly owner: AuthorityOwnerRecord | null
  readonly definitive = true
  readonly retryable = false

  constructor(code: AuthorityConflictError['code'], message: string, owner: AuthorityOwnerRecord | null) {
    super(message)
    this.name = 'AuthorityConflictError'
    this.code = code
    this.owner = owner
  }
}

interface AuthorityRegistryDependencies {
  processId?: number
  processStartedAt?: string
  now?: () => Date
  processProbe?: (processId: number) => 'alive' | 'dead' | 'unknown'
}

export class AuthorityRegistryFacade {
  readonly #processId: number
  readonly #processStartedAt: string
  readonly #now: () => Date
  readonly #processProbe: (processId: number) => 'alive' | 'dead' | 'unknown'

  constructor(dependencies: AuthorityRegistryDependencies = {}) {
    this.#processId = dependencies.processId ?? process.pid
    this.#processStartedAt = dependencies.processStartedAt ?? new Date(Date.now() - process.uptime() * 1_000).toISOString()
    this.#now = dependencies.now ?? (() => new Date())
    this.#processProbe = dependencies.processProbe ?? probeProcess
  }

  async acquire(input: AcquireAuthorityInput): Promise<AuthorityOwnerLease> {
    const hostIdentity = normalizeHostIdentity(input.hostIdentity)
    const registryDirectory = resolve(input.registryDirectory ?? join(process.env.LOCALAPPDATA ?? homedir(), 'dsh-relay', 'authorities'))
    const ownerPath = join(registryDirectory, `${hostIdentityKey(hostIdentity)}.owner.json`)
    const guard = await acquireRegistryGuard(`${ownerPath}.guard`, this.#processId, this.#processStartedAt, this.#processProbe)
    try {
      const current = await readOwner(ownerPath)
      const token = input.ownerToken ?? randomUUID()
      if (current !== null && isExactOwner(current, input, token, this.#processId, this.#processStartedAt)) {
        return this.#lease(ownerPath, current, true)
      }
      if (current !== null) {
        const liveness = this.#processProbe(current.processId)
        if (liveness !== 'dead') {
          throw new AuthorityConflictError(
            'AUTHORITY_OWNED',
            `Harness Host ${hostIdentity} is already owned by ${current.mode} authority ${current.authorityId} (PID ${current.processId}, epoch ${current.epoch})`,
            current,
          )
        }
        if (input.recoverStale !== true) {
          throw new AuthorityConflictError(
            'AUTHORITY_STALE_OWNER',
            `Harness Host ${hostIdentity} has a stale owner from PID ${current.processId}; explicit stale-owner recovery is required`,
            current,
          )
        }
      }
      const now = this.#now().toISOString()
      const record: AuthorityOwnerRecord = {
        schemaVersion: 1,
        hostIdentity,
        authorityId: input.authorityId,
        mode: input.mode,
        instanceId: input.instanceId,
        ownerToken: token,
        epoch: (current?.epoch ?? 0) + 1,
        processId: this.#processId,
        processStartedAt: this.#processStartedAt,
        acquiredAt: now,
        updatedAt: now,
      }
      await atomicWriteJson(ownerPath, record)
      return this.#lease(ownerPath, record, false)
    } finally {
      await guard.release()
    }
  }

  #lease(ownerPath: string, record: AuthorityOwnerRecord, reused: boolean): AuthorityOwnerLease {
    const leaseKey = `${ownerPath}\0${record.ownerToken}\0${record.epoch}`
    activeLeaseReferences.set(leaseKey, (activeLeaseReferences.get(leaseKey) ?? 0) + 1)
    let released = false
    return {
      record,
      reused,
      release: async () => {
        if (released) return false
        released = true
        const references = activeLeaseReferences.get(leaseKey) ?? 1
        if (references > 1) {
          activeLeaseReferences.set(leaseKey, references - 1)
          return false
        }
        activeLeaseReferences.delete(leaseKey)
        const guard = await acquireRegistryGuard(`${ownerPath}.guard`, this.#processId, this.#processStartedAt, this.#processProbe)
        try {
          const current = await readOwner(ownerPath)
          if (current === null || current.ownerToken !== record.ownerToken || current.epoch !== record.epoch) return false
          try {
            await unlink(ownerPath)
            return true
          } catch (error) {
            if (isCode(error, 'ENOENT')) return false
            throw error
          }
        } finally {
          await guard.release()
        }
      },
    }
  }
}

async function readOwner(path: string): Promise<AuthorityOwnerRecord | null> {
  const text = await readUtf8File(path)
  if (text === null) return null
  try {
    return ownerSchema.parse(JSON.parse(text))
  } catch (error) {
    throw new AuthorityConflictError('AUTHORITY_REGISTRY_INVALID', `invalid authority owner registry: ${path}`, null)
  }
}

function isExactOwner(current: AuthorityOwnerRecord, input: AcquireAuthorityInput, token: string, processId: number, startedAt: string): boolean {
  return current.ownerToken === token
    && current.authorityId === input.authorityId
    && current.mode === input.mode
    && current.instanceId === input.instanceId
    && current.processId === processId
    && current.processStartedAt === startedAt
}

function probeProcess(processId: number): 'alive' | 'dead' | 'unknown' {
  try {
    process.kill(processId, 0)
    return 'alive'
  } catch (error) {
    if (isCode(error, 'ESRCH')) return 'dead'
    if (isCode(error, 'EPERM')) return 'alive'
    return 'unknown'
  }
}

function isCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code
}
