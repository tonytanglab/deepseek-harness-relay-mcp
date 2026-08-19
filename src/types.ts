export type PromptPart =
  | { type: 'text'; text: string }
  | { type: 'image'; mediaType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'; data: string; name?: string | undefined }

export interface ModelSelection {
  provider: string
  model: string
  reasoningEffort?: string
}

export type RunStatus = 'running' | 'needs_attention' | 'succeeded' | 'incomplete' | 'failed' | 'cancelled' | 'unknown'
export type PromptAdmission = 'pending' | 'accepted' | 'unknown' | 'rejected'
export type ServiceStatus = 'running' | 'stopped' | 'failed'
export type PermissionPreset = 'read-only' | 'workspace-write' | 'danger-full-access'
export type AuthorityMode = 'embedded' | 'standalone'

export interface StateMigrationMarker {
  sourceSchemaVersion: 1 | 2
  sourcePath: string
  sourceDigest: string
  copiedAt: string
}

export interface StateAuthorityMetadata {
  authorityId: string
  mode: AuthorityMode
  hostIdentity: string
  instanceId: string
  migration: StateMigrationMarker | null
}

export interface ServiceSnapshot {
  serviceId: string
  workspaceId: string
  workspace: string
  status: ServiceStatus
  webUrl: string
  browserOpened: boolean
  browserError: string | null
  managedProcess: false
  processId: null
  attachedAt: string
  stoppedAt: string | null
}

export interface RunSnapshot {
  runId: string
  operationId?: string | undefined
  idempotencyKey?: string | undefined
  serviceId: string
  sessionId: string
  sessionReused: boolean
  parentRunId: string | null
  workspace: string
  webUrl: string
  status: RunStatus
  modelSelection: ModelSelection | null
  permissionPreset: PermissionPreset
  agentPreset: string | null
  modelDefaultRestore: 'restored' | 'not-needed' | 'skipped-concurrent-change' | 'unavailable'
  warnings: string[]
  task: string
  taskPersisted: boolean
  taskImageCount: number
  cancelRequested: boolean
  startedAt: string
  lastProgressAt?: string
  finishedAt: string | null
  attentionReason?: 'run_stalled' | 'permission_restore_failed'
  promptAdmission: PromptAdmission
  promptMessageId: string | null
  assistantText: string
  assistantTextBytes: number
  assistantTextTruncated: boolean
  lastEventSeq: number
  error: string | null
}

export interface PersistedRun {
  snapshot: RunSnapshot
  baselineSeq: number
  promptRpcId: string
}

export type OperationKind = 'start' | 'steer' | 'reply' | 'cancel'
export type OperationState = 'prepared' | 'submitted' | 'acknowledged' | 'unknown' | 'reconciled' | 'failed'

export interface OperationRecord {
  operationId: string
  clientPrincipalId: string
  idempotencyKey: string
  requestFingerprint: string
  runId: string
  kind: OperationKind
  rpcId: string
  fencingEpoch: number
  state: OperationState
  messageId: string | null
  error: string | null
  createdAt: string
  updatedAt: string
}

export interface PermissionLease {
  leaseId: string
  sessionId: string
  ownerOperationId: string
  previousPermission: PermissionPreset
  grantedPermission: PermissionPreset
  expiresAt: string
  state: 'prepared' | 'acquired' | 'restoring' | 'released' | 'needs_attention'
  error: string | null
  createdAt: string
  updatedAt: string
}

export interface PersistedRelayStateV2 {
  schemaVersion: 2
  services: ServiceSnapshot[]
  runs: PersistedRun[]
  operations: OperationRecord[]
  permissionLeases: PermissionLease[]
}

export interface PersistedRelayStateV3 extends StateAuthorityMetadata {
  schemaVersion: 3
  services: ServiceSnapshot[]
  runs: PersistedRun[]
  operations: OperationRecord[]
  permissionLeases: PermissionLease[]
}

/**
 * Persisted input accepted during the v2-to-v3 compatibility window.
 * RelayStateStore always returns and writes the v3 member.
 */
export type PersistedRelayState = PersistedRelayStateV2 | PersistedRelayStateV3

export interface RpcEvent {
  type: string
  seq: number
  time: number
  data: Record<string, unknown>
}

export interface ModelSelectionResult {
  selected: ModelSelection
  restore: RunSnapshot['modelDefaultRestore']
  warnings: string[]
}
