import { createHash, randomUUID } from 'node:crypto'
import { open, rename } from 'node:fs/promises'
import { resolve } from 'node:path'
import {
  atomicWriteJson,
  FileLockFacade,
  legacySchemaVersion,
  migrationMarker,
  normalizeStateInput,
  parseAndNormalizeState,
  readUtf8File,
  StateAuthorityMismatchError,
  validateV3State,
  type FileLockLease,
  type FileLockOptions,
} from './state-repository/index.js'
import type {
  OperationRecord,
  PermissionLease,
  PersistedRelayState,
  PersistedRelayStateV3,
  PersistedRun,
  ServiceSnapshot,
  StateAuthorityMetadata,
} from './types.js'

export interface RelayStateStoreOptions extends FileLockOptions {
  authority?: Omit<StateAuthorityMetadata, 'migration'>
}

export class RelayStateStore {
  private writes = Promise.resolve()
  private recoveryMessage: string | null = null
  private readonly fileLock: FileLockFacade
  private readonly authority: Omit<StateAuthorityMetadata, 'migration'>

  constructor(private readonly path: string, options: RelayStateStoreOptions = {}) {
    this.fileLock = new FileLockFacade(options)
    this.authority = options.authority ?? compatibilityAuthority(path)
  }

  get recoveryWarning(): string | null {
    return this.recoveryMessage
  }

  get authorityMetadata(): Omit<StateAuthorityMetadata, 'migration'> {
    return { ...this.authority }
  }

  async load(): Promise<PersistedRelayStateV3 | null> {
    return this.readState(true)
  }

  async save(state: PersistedRelayState): Promise<void> {
    const validated = normalizeStateInput(state, this.authority, this.path)
    const write = this.writes.then(async () => {
      const lease = await this.fileLock.acquire(`${this.path}.lock`)
      try {
        const existing = await this.readState(true)
        await atomicWriteJson(this.path, mergeStates(existing, validated))
      } finally {
        await lease.release()
      }
    })
    this.writes = write.then(() => undefined, () => undefined)
    return write
  }

  async claimOperation(candidate: OperationRecord): Promise<{ record: OperationRecord; created: boolean }> {
    let result: { record: OperationRecord; created: boolean } | undefined
    const write = this.writes.then(async () => {
      const lease = await this.fileLock.acquire(`${this.path}.lock`)
      try {
        const existing = await this.readState(true)
        const previous = existing?.operations.find(operation =>
          operation.clientPrincipalId === candidate.clientPrincipalId && operation.idempotencyKey === candidate.idempotencyKey,
        )
        if (previous !== undefined) {
          result = { record: { ...previous }, created: false }
          return
        }
        const next: PersistedRelayStateV3 = existing === null
          ? emptyV3State(this.authority, [{ ...candidate }])
          : { ...existing, operations: [...existing.operations, { ...candidate }] }
        await atomicWriteJson(this.path, validateV3State(next))
        result = { record: { ...candidate }, created: true }
      } finally {
        await lease.release()
      }
    })
    this.writes = write.then(() => undefined, () => undefined)
    await write
    if (result === undefined) throw new Error('operation claim completed without a result')
    return result
  }

  acquireSessionLease(sessionId: string): Promise<FileLockLease> {
    const digest = createHash('sha256').update(sessionId, 'utf8').digest('hex')
    return this.fileLock.acquire(`${this.path}.session.${digest}.lock`)
  }

  /** Explicitly copies a validated v1/v2 source into this v3 authority state file. */
  async migrateFrom(sourcePath: string): Promise<PersistedRelayStateV3> {
    if (resolve(sourcePath) === resolve(this.path)) throw new Error('migration source and target must be different files')
    const lease = await this.fileLock.acquire(`${this.path}.lock`)
    try {
      if (await readUtf8File(this.path) !== null) throw new Error(`migration target already exists: ${this.path}`)
      const source = await readReadOnly(sourcePath)
      const version = legacySchemaVersion(source)
      const marker = migrationMarker(version, resolve(sourcePath), source)
      const migrated = parseAndNormalizeState(source, resolve(sourcePath), this.authority, marker)
      await atomicWriteJson(this.path, migrated)
      return migrated
    } finally {
      await lease.release()
    }
  }

  private async readState(quarantineInvalid: boolean): Promise<PersistedRelayStateV3 | null> {
    const text = await readUtf8File(this.path)
    if (text === null) return null
    try {
      return parseAndNormalizeState(text, this.path, this.authority)
    } catch (error) {
      if (error instanceof StateAuthorityMismatchError || !quarantineInvalid) throw error
      const quarantined = `${this.path}.corrupt.${Date.now()}.${randomUUID()}`
      try {
        await rename(this.path, quarantined)
        this.recoveryMessage = `Invalid state was quarantined at ${quarantined}: ${errorText(error)}`
      } catch (renameError) {
        if (!isCode(renameError, 'ENOENT')) throw renameError
        this.recoveryMessage = `Invalid state was quarantined by another relay process: ${errorText(error)}`
      }
      return null
    }
  }
}

async function readReadOnly(path: string): Promise<string> {
  const handle = await open(path, 'r')
  try {
    return await handle.readFile({ encoding: 'utf8' })
  } finally {
    await handle.close()
  }
}

function compatibilityAuthority(path: string): Omit<StateAuthorityMetadata, 'migration'> {
  const digest = createHash('sha256').update(resolve(path), 'utf8').digest('hex').slice(0, 24)
  return {
    authorityId: `standalone-legacy-${digest}`,
    mode: 'standalone',
    hostIdentity: `legacy-state:${digest}`,
    instanceId: `legacy-instance-${digest}`,
  }
}

function emptyV3State(authority: Omit<StateAuthorityMetadata, 'migration'>, operations: OperationRecord[] = []): PersistedRelayStateV3 {
  return { schemaVersion: 3, ...authority, migration: null, services: [], runs: [], operations, permissionLeases: [] }
}

function mergeStates(existing: PersistedRelayStateV3 | null, incoming: PersistedRelayStateV3): PersistedRelayStateV3 {
  if (existing === null) return incoming
  return validateV3State({
    schemaVersion: 3,
    authorityId: existing.authorityId,
    mode: existing.mode,
    hostIdentity: existing.hostIdentity,
    instanceId: existing.instanceId,
    migration: existing.migration ?? incoming.migration,
    services: mergeBy(existing.services, incoming.services, item => item.serviceId, freshestService),
    runs: mergeBy(existing.runs, incoming.runs, item => item.snapshot.runId, freshestRun),
    operations: mergeBy(existing.operations, incoming.operations, item => item.operationId, freshestOperation),
    permissionLeases: mergeBy(existing.permissionLeases, incoming.permissionLeases, item => item.leaseId, freshestLease),
  })
}

const stableRunStatuses = new Set(['needs_attention', 'succeeded', 'incomplete', 'failed', 'cancelled'])

function freshestService(left: ServiceSnapshot, right: ServiceSnapshot): ServiceSnapshot {
  const rank = (status: ServiceSnapshot['status']) => status === 'running' ? 1 : status === 'stopped' ? 2 : 3
  const comparison = rank(left.status) - rank(right.status)
  if (comparison !== 0) return comparison > 0 ? left : right
  return timestamp(left.stoppedAt ?? left.attachedAt) >= timestamp(right.stoppedAt ?? right.attachedAt) ? left : right
}

function freshestRun(left: PersistedRun, right: PersistedRun): PersistedRun {
  const leftTerminal = stableRunStatuses.has(left.snapshot.status)
  const rightTerminal = stableRunStatuses.has(right.snapshot.status)
  if (leftTerminal !== rightTerminal) return leftTerminal ? left : right
  const sequenceComparison = left.snapshot.lastEventSeq - right.snapshot.lastEventSeq
  if (sequenceComparison !== 0) return sequenceComparison > 0 ? left : right
  const finishedComparison = timestamp(left.snapshot.finishedAt) - timestamp(right.snapshot.finishedAt)
  if (finishedComparison !== 0) return finishedComparison > 0 ? left : right
  const textComparison = left.snapshot.assistantTextBytes - right.snapshot.assistantTextBytes
  if (textComparison !== 0) return textComparison > 0 ? left : right
  const statusComparison = runStatusRank(left.snapshot.status) - runStatusRank(right.snapshot.status)
  if (statusComparison !== 0) return statusComparison > 0 ? left : right
  return JSON.stringify(left) >= JSON.stringify(right) ? left : right
}

function freshestOperation(left: OperationRecord, right: OperationRecord): OperationRecord {
  const timeComparison = timestamp(left.updatedAt) - timestamp(right.updatedAt)
  if (timeComparison !== 0) return timeComparison > 0 ? left : right
  const rank = (state: OperationRecord['state']) => {
    switch (state) {
      case 'prepared': return 1
      case 'submitted': return 2
      case 'unknown': return 3
      case 'failed': return 4
      case 'acknowledged': return 5
      case 'reconciled': return 6
    }
  }
  return rank(left.state) >= rank(right.state) ? left : right
}

function freshestLease(left: PermissionLease, right: PermissionLease): PermissionLease {
  const timeComparison = timestamp(left.updatedAt) - timestamp(right.updatedAt)
  if (timeComparison !== 0) return timeComparison > 0 ? left : right
  const rank = (state: PermissionLease['state']) => {
    switch (state) {
      case 'prepared': return 1
      case 'acquired': return 2
      case 'restoring': return 3
      case 'needs_attention': return 4
      case 'released': return 5
    }
  }
  return rank(left.state) >= rank(right.state) ? left : right
}

function timestamp(value: string | null): number {
  if (value === null) return Number.NEGATIVE_INFINITY
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY
}

function runStatusRank(status: PersistedRun['snapshot']['status']): number {
  switch (status) {
    case 'succeeded': return 7
    case 'incomplete': return 6
    case 'failed': return 5
    case 'cancelled': return 4
    case 'needs_attention': return 3
    case 'running': return 2
    case 'unknown': return 1
  }
}

function mergeBy<T>(left: T[], right: T[], key: (item: T) => string, choose: (left: T, right: T) => T = (_left, rightItem) => rightItem): T[] {
  const merged = new Map(left.map(item => [key(item), item]))
  for (const item of right) {
    const id = key(item)
    const previous = merged.get(id)
    merged.set(id, previous === undefined ? item : choose(previous, item))
  }
  return [...merged.values()]
}

function isCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
