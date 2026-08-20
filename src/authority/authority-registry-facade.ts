import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { unlink } from 'node:fs/promises'
import { z } from 'zod'
import { atomicWriteJson, readUtf8File } from '../state-repository/index.js'
import { hostIdentityKey, normalizeHostIdentity } from './host-identity.js'
import { acquireRegistryGuard } from './registry-guard.js'
import type {
  AcquireAuthorityInput,
  AuthorityAcquireRetryOptions,
  AuthorityOwnerLease,
  AuthorityOwnerRecord,
} from './types.js'

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

export interface AuthorityRegistryDependencies {
  processId?: number
  processStartedAt?: string
  now?: () => Date
  processProbe?: (processId: number) => 'alive' | 'dead' | 'unknown'
  sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>
  random?: () => number
}

export class AuthorityAcquireCancelledError extends Error {
  readonly code = 'AUTHORITY_ACQUIRE_CANCELLED'
  readonly retryable = true

  constructor() {
    super('authority acquisition retry was cancelled')
    this.name = 'AuthorityAcquireCancelledError'
  }
}

export class AuthorityRegistryFacade {
  readonly #processId: number
  readonly #processStartedAt: string
  readonly #now: () => Date
  readonly #processProbe: (processId: number) => 'alive' | 'dead' | 'unknown'
  readonly #sleep: (milliseconds: number, signal?: AbortSignal) => Promise<void>
  readonly #random: () => number

  constructor(dependencies: AuthorityRegistryDependencies = {}) {
    this.#processId = dependencies.processId ?? process.pid
    this.#processStartedAt = dependencies.processStartedAt ?? new Date(Date.now() - process.uptime() * 1_000).toISOString()
    this.#now = dependencies.now ?? (() => new Date())
    this.#processProbe = dependencies.processProbe ?? probeProcess
    this.#sleep = dependencies.sleep ?? delay
    this.#random = dependencies.random ?? Math.random
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

  /**
   * Retry only a live/unknown authority conflict. Every attempt re-reads the
   * owner registry and probes the current PID inside the registry guard.
   */
  async acquireWithRetry(
    input: AcquireAuthorityInput,
    options: AuthorityAcquireRetryOptions = {},
  ): Promise<AuthorityOwnerLease> {
    const budgetMs = boundedRetryOption(options.budgetMs ?? 20_000, 0, 30_000, 'budgetMs')
    const initialDelayMs = boundedRetryOption(options.initialDelayMs ?? 100, 1, 5_000, 'initialDelayMs')
    const maxDelayMs = boundedRetryOption(options.maxDelayMs ?? Math.max(1_000, initialDelayMs), initialDelayMs, 5_000, 'maxDelayMs')
    const jitterMs = boundedRetryOption(options.jitterMs ?? 25, 0, 1_000, 'jitterMs')
    const startedAt = this.#now().getTime()
    let delayMs = initialDelayMs
    let waitedMs = 0
    let lastConflict: AuthorityConflictError | null = null

    while (true) {
      throwIfAborted(options.signal)
      if (lastConflict !== null && retryElapsedMs(startedAt, this.#now().getTime(), waitedMs) >= budgetMs) {
        throw retryBudgetError(lastConflict, budgetMs)
      }
      try {
        return await this.acquire(input)
      } catch (error) {
        if (!(error instanceof AuthorityConflictError) || error.code !== 'AUTHORITY_OWNED') throw error
        lastConflict = error
        const elapsedMs = retryElapsedMs(startedAt, this.#now().getTime(), waitedMs)
        const remainingMs = budgetMs - elapsedMs
        if (remainingMs <= 0) throw retryBudgetError(error, budgetMs)
        const randomValue = this.#random()
        const random = Number.isFinite(randomValue) ? Math.min(1, Math.max(0, randomValue)) : 0
        const jitter = jitterMs === 0 ? 0 : Math.floor(random * (jitterMs + 1))
        const waitMs = Math.min(remainingMs, delayMs + jitter)
        try {
          await this.#sleep(waitMs, options.signal)
        } catch (error) {
          if (options.signal?.aborted === true) throw new AuthorityAcquireCancelledError()
          throw error
        }
        waitedMs += waitMs
        delayMs = Math.min(maxDelayMs, delayMs * 2)
      }
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

function boundedRetryOption(value: number, min: number, max: number, name: string): number {
  if (!Number.isInteger(value) || value < min || value > max) throw new RangeError(`${name} must be an integer from ${min} to ${max}`)
  return value
}

function retryElapsedMs(startedAt: number, now: number, waitedMs: number): number {
  const clockElapsed = Number.isFinite(now) && Number.isFinite(startedAt) ? Math.max(0, now - startedAt) : 0
  return Math.max(clockElapsed, waitedMs)
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw new AuthorityAcquireCancelledError()
}

function retryBudgetError(error: AuthorityConflictError, budgetMs: number): AuthorityConflictError {
  const owner = error.owner
  const ownerDetail = owner === null ? 'owner details unavailable' : `PID ${owner.processId}, epoch ${owner.epoch}`
  return new AuthorityConflictError(
    'AUTHORITY_OWNED',
    `${error.message}; authority remained owned after the ${budgetMs}ms retry budget (${ownerDetail}); wait for the current owner to exit before retrying`,
    owner,
  )
}

function delay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted === true) return Promise.reject(new AuthorityAcquireCancelledError())
  return new Promise((resolveDelay, reject) => {
    let timer: NodeJS.Timeout | undefined
    const onAbort = () => {
      if (timer !== undefined) clearTimeout(timer)
      reject(new AuthorityAcquireCancelledError())
    }
    timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolveDelay()
    }, milliseconds)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}
