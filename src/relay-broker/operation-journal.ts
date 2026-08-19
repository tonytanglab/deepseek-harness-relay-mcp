import { randomUUID } from 'node:crypto'
import type { OperationKind, OperationRecord, OperationState } from '../types.js'
import { RelayError } from './errors.js'
import { requestFingerprint } from './helpers.js'

export interface PreparedOperation {
  record: OperationRecord
  replayed: boolean
}

export class OperationJournal {
  private readonly byIdempotency = new Map<string, string>()

  constructor(
    private readonly records: Map<string, OperationRecord>,
    private readonly persist: () => Promise<void>,
    private readonly claim: (candidate: OperationRecord) => Promise<{ record: OperationRecord; created: boolean }>,
  ) {}

  restoreIndex(): void {
    this.byIdempotency.clear()
    for (const record of this.records.values()) this.byIdempotency.set(this.key(record.clientPrincipalId, record.idempotencyKey), record.operationId)
  }

  list(): OperationRecord[] {
    return [...this.records.values()].map(record => ({ ...record }))
  }

  async prepare(clientPrincipalId: string, kind: OperationKind, runId: string, request: unknown, idempotencyKey?: string): Promise<PreparedOperation> {
    const key = idempotencyKey ?? randomUUID()
    const fingerprint = requestFingerprint(request)
    const previousId = this.byIdempotency.get(this.key(clientPrincipalId, key))
    const previous = previousId === undefined ? undefined : this.records.get(previousId)
    if (previous !== undefined) {
      if (previous.kind !== kind || previous.requestFingerprint !== fingerprint) {
        throw new RelayError('OPERATION_CONFLICT', 'The idempotency key was already used for a different operation', false, {
          operationId: previous.operationId,
          runId: previous.runId,
          lastKnownState: previous.state,
          nextAction: 'status',
        })
      }
      return { record: previous, replayed: true }
    }
    const now = new Date().toISOString()
    const record: OperationRecord = {
      operationId: randomUUID(),
      clientPrincipalId,
      idempotencyKey: key,
      requestFingerprint: fingerprint,
      runId,
      kind,
      rpcId: randomUUID(),
      fencingEpoch: 0,
      state: 'prepared',
      messageId: null,
      error: null,
      createdAt: now,
      updatedAt: now,
    }
    const claimed = await this.claim(record)
    const canonical = claimed.record
    if (canonical.kind !== kind || canonical.requestFingerprint !== fingerprint) {
      throw new RelayError('OPERATION_CONFLICT', 'The idempotency key was already used for a different operation', false, {
        operationId: canonical.operationId,
        runId: canonical.runId,
        lastKnownState: canonical.state,
        nextAction: 'status',
      })
    }
    this.records.set(canonical.operationId, canonical)
    this.byIdempotency.set(this.key(clientPrincipalId, key), canonical.operationId)
    return { record: canonical, replayed: !claimed.created }
  }

  async transition(record: OperationRecord, state: OperationState, update: { messageId?: string | null; error?: string | null } = {}): Promise<void> {
    if (!allowedTransitions[record.state].has(state)) {
      throw new RelayError('OPERATION_STATE_CONFLICT', `Invalid operation transition: ${record.state} -> ${state}`, false, {
        operationId: record.operationId, runId: record.runId, lastKnownState: record.state, nextAction: 'reconcile',
      })
    }
    record.state = state
    if ('messageId' in update) record.messageId = update.messageId ?? null
    if ('error' in update) record.error = update.error ?? null
    record.updatedAt = new Date().toISOString()
    await this.persist()
  }

  async correlateRpcId(record: OperationRecord, rpcId: string): Promise<void> {
    if (record.rpcId === rpcId) return
    if (rpcId.length === 0 || record.state === 'acknowledged' || record.state === 'reconciled' || record.state === 'failed') {
      throw new RelayError('OPERATION_STATE_CONFLICT', 'Operation correlation cannot change after terminal acknowledgement', false, {
        operationId: record.operationId, runId: record.runId, lastKnownState: record.state, nextAction: 'reconcile',
      })
    }
    record.rpcId = rpcId
    record.updatedAt = new Date().toISOString()
    await this.persist()
  }

  unknown(record: OperationRecord, message: string): RelayError {
    return new RelayError('OPERATION_UNKNOWN', message, false, {
      operationId: record.operationId,
      runId: record.runId,
      lastKnownState: record.state,
      nextAction: 'reconcile',
    })
  }

  private key(clientPrincipalId: string, idempotencyKey: string): string {
    return `${clientPrincipalId}\u0000${idempotencyKey}`
  }
}

const allowedTransitions: Record<OperationState, ReadonlySet<OperationState>> = {
  prepared: new Set(['submitted', 'failed', 'reconciled']),
  submitted: new Set(['acknowledged', 'unknown', 'failed', 'reconciled']),
  unknown: new Set(['acknowledged', 'reconciled', 'failed']),
  acknowledged: new Set(['reconciled']),
  reconciled: new Set(),
  failed: new Set(),
}
