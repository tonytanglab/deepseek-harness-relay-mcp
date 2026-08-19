import { randomUUID } from 'node:crypto'
import { PermissionGatewayError, type PermissionGatewayFacade } from '../permission-gateway/index.js'
import type { PermissionLease, PermissionPreset } from '../types.js'
import { RelayError } from './errors.js'
import { errorText } from './helpers.js'

export class PermissionController {
  constructor(
    private readonly gateway: PermissionGatewayFacade,
    private readonly leases: Map<string, PermissionLease>,
    private readonly persist: () => Promise<void>,
    private readonly leaseDurationMs: number,
  ) {}

  list(): PermissionLease[] {
    return [...this.leases.values()].map(lease => ({ ...lease }))
  }

  async markExpired(): Promise<number> {
    const now = Date.now()
    let changed = 0
    for (const lease of this.leases.values()) {
      if (lease.state === 'released' || lease.state === 'needs_attention' || Date.parse(lease.expiresAt) > now) continue
      lease.state = 'needs_attention'
      lease.error = 'Permission lease expired before its owning run reached a reconciled terminal state'
      lease.updatedAt = new Date().toISOString()
      changed += 1
    }
    if (changed > 0) await this.persist()
    return changed
  }

  async selectForRun(sessionId: string, operationId: string, preset: PermissionPreset, restoreRequired: boolean): Promise<PermissionLease | null> {
    if (!restoreRequired) {
      await this.select(sessionId, preset)
      return null
    }
    const active = this.activeForSession(sessionId)
    if (active !== undefined) {
      const expired = Date.parse(active.expiresAt) <= Date.now()
      throw new RelayError(expired ? 'PERMISSION_LEASE_EXPIRED' : 'PERMISSION_LEASE_CONFLICT', `${expired ? 'Expired' : 'Active'} permission lease requires reconciliation for session: ${sessionId}`, false, {
        operationId: active.ownerOperationId,
        lastKnownState: active.state,
        nextAction: expired ? 'reconcile' : 'wait',
      })
    }
    const previous = await this.current(sessionId)
    if (previous === preset) return null
    const now = new Date()
    const lease: PermissionLease = {
      leaseId: randomUUID(),
      sessionId,
      ownerOperationId: operationId,
      previousPermission: previous,
      grantedPermission: preset,
      expiresAt: new Date(now.getTime() + this.leaseDurationMs).toISOString(),
      state: 'prepared',
      error: null,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    }
    this.leases.set(lease.leaseId, lease)
    await this.persist()
    try {
      await this.select(sessionId, preset)
      lease.state = 'acquired'
      lease.updatedAt = new Date().toISOString()
      await this.persist()
      return lease
    } catch (error) {
      lease.state = 'needs_attention'
      lease.error = errorText(error)
      lease.updatedAt = new Date().toISOString()
      await this.persist()
      throw error
    }
  }

  async restoreSession(sessionId: string, ownerOperationId?: string): Promise<boolean> {
    const lease = this.activeForSession(sessionId)
    if (lease === undefined) return true
    if (ownerOperationId !== undefined && lease.ownerOperationId !== ownerOperationId) return true
    return this.restoreLease(lease)
  }

  private async restoreLease(lease: PermissionLease): Promise<boolean> {
    lease.state = 'restoring'
    lease.updatedAt = new Date().toISOString()
    await this.persist()
    try {
      await this.select(lease.sessionId, lease.previousPermission)
      lease.state = 'released'
      lease.error = null
      lease.updatedAt = new Date().toISOString()
      await this.persist()
      return true
    } catch (error) {
      lease.state = 'needs_attention'
      lease.error = errorText(error)
      lease.updatedAt = new Date().toISOString()
      await this.persist()
      return false
    }
  }

  private activeForSession(sessionId: string): PermissionLease | undefined {
    return [...this.leases.values()].find(lease => lease.sessionId === sessionId && lease.state !== 'released')
  }

  private async current(sessionId: string): Promise<PermissionPreset> {
    try {
      return await this.gateway.current(sessionId)
    } catch (error) {
      throw permissionRelayError(error)
    }
  }

  private async select(sessionId: string, preset: PermissionPreset): Promise<void> {
    try {
      await this.gateway.select(sessionId, preset)
    } catch (error) {
      throw permissionRelayError(error)
    }
  }
}

function permissionRelayError(error: unknown): unknown {
  if (!(error instanceof PermissionGatewayError)) return error
  return new RelayError(error.code, error.message, error.retryable, { ...error.details, nextAction: 'none' })
}
