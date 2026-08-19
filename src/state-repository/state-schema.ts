import { createHash } from 'node:crypto'
import { z } from 'zod'
import type {
  PersistedRelayState,
  PersistedRelayStateV3,
  PersistedRun,
  ServiceSnapshot,
  StateAuthorityMetadata,
  StateMigrationMarker,
} from '../types.js'

const modelSelectionSchema = z.object({
  provider: z.string(), model: z.string(), reasoningEffort: z.string().optional(),
}).strict()

const serviceSchema = z.object({
  serviceId: z.string(), workspaceId: z.string(), workspace: z.string(),
  status: z.enum(['running', 'stopped', 'failed']), webUrl: z.string(),
  browserOpened: z.boolean(), browserError: z.string().nullable(), managedProcess: z.literal(false),
  processId: z.null(), attachedAt: z.string(), stoppedAt: z.string().nullable(),
}).strict()

const runSnapshotSchema = z.object({
  runId: z.string(), operationId: z.string().optional(), idempotencyKey: z.string().optional(),
  serviceId: z.string(), sessionId: z.string(), sessionReused: z.boolean(), parentRunId: z.string().nullable(),
  workspace: z.string(), webUrl: z.string(),
  status: z.enum(['running', 'needs_attention', 'succeeded', 'incomplete', 'failed', 'cancelled', 'unknown']),
  modelSelection: modelSelectionSchema.nullable(),
  permissionPreset: z.enum(['read-only', 'workspace-write', 'danger-full-access']), agentPreset: z.string().nullable(),
  modelDefaultRestore: z.enum(['restored', 'not-needed', 'skipped-concurrent-change', 'unavailable']),
  warnings: z.array(z.string()), task: z.string(), taskPersisted: z.boolean(), taskImageCount: z.number().int().nonnegative(),
  cancelRequested: z.boolean(), startedAt: z.string(), lastProgressAt: z.string().optional(), finishedAt: z.string().nullable(),
  attentionReason: z.enum(['run_stalled', 'permission_restore_failed']).optional(),
  promptAdmission: z.enum(['pending', 'accepted', 'unknown', 'rejected']), promptMessageId: z.string().nullable(),
  assistantText: z.string(), assistantTextBytes: z.number().int().nonnegative(), assistantTextTruncated: z.boolean(),
  lastEventSeq: z.number().int(), error: z.string().nullable(),
}).strict()

const runSchema = z.object({ snapshot: runSnapshotSchema, baselineSeq: z.number().int(), promptRpcId: z.string() }).strict()

const operationSchema = z.object({
  operationId: z.string(), clientPrincipalId: z.string(), idempotencyKey: z.string(), requestFingerprint: z.string(),
  runId: z.string(), kind: z.enum(['start', 'steer', 'reply', 'cancel']), rpcId: z.string(),
  fencingEpoch: z.number().int().nonnegative(),
  state: z.enum(['prepared', 'submitted', 'acknowledged', 'unknown', 'reconciled', 'failed']),
  messageId: z.string().nullable(), error: z.string().nullable(), createdAt: z.string(), updatedAt: z.string(),
}).strict()

const permissionLeaseSchema = z.object({
  leaseId: z.string(), sessionId: z.string(), ownerOperationId: z.string(),
  previousPermission: z.enum(['read-only', 'workspace-write', 'danger-full-access']),
  grantedPermission: z.enum(['read-only', 'workspace-write', 'danger-full-access']), expiresAt: z.string(),
  state: z.enum(['prepared', 'acquired', 'restoring', 'released', 'needs_attention']),
  error: z.string().nullable(), createdAt: z.string(), updatedAt: z.string(),
}).strict()

const migrationSchema = z.object({
  sourceSchemaVersion: z.union([z.literal(1), z.literal(2)]),
  sourcePath: z.string(), sourceDigest: z.string(), copiedAt: z.string().datetime(),
}).strict()

const stateBody = {
  services: z.array(serviceSchema), runs: z.array(runSchema), operations: z.array(operationSchema),
  permissionLeases: z.array(permissionLeaseSchema),
}

const stateV3Schema = z.object({
  schemaVersion: z.literal(3), authorityId: z.string().min(1), mode: z.enum(['embedded', 'standalone']),
  hostIdentity: z.string().min(1), instanceId: z.string().min(1), migration: migrationSchema.nullable(), ...stateBody,
}).strict()

const stateV2Schema = z.object({ schemaVersion: z.literal(2), ...stateBody }).strict()
const stateV1Schema = z.object({
  schemaVersion: z.literal(1), services: z.array(serviceSchema), runs: z.array(runSchema),
}).strict()

export class StateAuthorityMismatchError extends Error {
  readonly code = 'STATE_AUTHORITY_MISMATCH'
  constructor(readonly expected: Omit<StateAuthorityMetadata, 'migration'>, readonly actual: Omit<StateAuthorityMetadata, 'migration'>) {
    super(`state belongs to authority ${actual.authorityId}/${actual.mode}/${actual.hostIdentity}/${actual.instanceId}, not ${expected.authorityId}/${expected.mode}/${expected.hostIdentity}/${expected.instanceId}`)
    this.name = 'StateAuthorityMismatchError'
  }
}

export function validateV3State(state: PersistedRelayStateV3): PersistedRelayStateV3 {
  return stateV3Schema.parse(state) as PersistedRelayStateV3
}

export function parseAndNormalizeState(
  text: string,
  sourcePath: string,
  authority: Omit<StateAuthorityMetadata, 'migration'>,
  marker?: StateMigrationMarker,
): PersistedRelayStateV3 {
  const parsed: unknown = JSON.parse(text)
  const current = stateV3Schema.safeParse(parsed)
  if (current.success) {
    const result = current.data as PersistedRelayStateV3
    assertAuthority(authority, result)
    return result
  }
  const legacyV2 = stateV2Schema.safeParse(parsed)
  if (legacyV2.success) return fromLegacy(legacyV2.data as PersistedRelayState, authority, marker ?? migrationMarker(2, sourcePath, text))
  const legacyV1 = stateV1Schema.safeParse(parsed)
  if (legacyV1.success) {
    return fromLegacy({
      schemaVersion: 2,
      services: legacyV1.data.services as ServiceSnapshot[], runs: legacyV1.data.runs as PersistedRun[],
      operations: [], permissionLeases: [],
    }, authority, marker ?? migrationMarker(1, sourcePath, text))
  }
  throw new Error(current.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; '))
}

export function normalizeStateInput(
  state: PersistedRelayState,
  authority: Omit<StateAuthorityMetadata, 'migration'>,
  sourcePath: string,
): PersistedRelayStateV3 {
  if (state.schemaVersion === 3) {
    assertAuthority(authority, state)
    return validateV3State(state)
  }
  return fromLegacy(state, authority, migrationMarker(2, sourcePath, JSON.stringify(state)))
}

export function legacySchemaVersion(text: string): 1 | 2 {
  const parsed: unknown = JSON.parse(text)
  if (stateV2Schema.safeParse(parsed).success) return 2
  if (stateV1Schema.safeParse(parsed).success) return 1
  throw new Error('migration source is not valid Relay schema v1 or v2 state')
}

export function migrationMarker(version: 1 | 2, sourcePath: string, text: string, copiedAt = new Date().toISOString()): StateMigrationMarker {
  return {
    sourceSchemaVersion: version,
    sourcePath,
    sourceDigest: createHash('sha256').update(text, 'utf8').digest('hex'),
    copiedAt,
  }
}

function fromLegacy(
  state: PersistedRelayState,
  authority: Omit<StateAuthorityMetadata, 'migration'>,
  migration: StateMigrationMarker,
): PersistedRelayStateV3 {
  return validateV3State({ ...authority, migration, schemaVersion: 3, services: state.services, runs: state.runs, operations: state.operations, permissionLeases: state.permissionLeases })
}

function assertAuthority(expected: Omit<StateAuthorityMetadata, 'migration'>, actual: PersistedRelayStateV3): void {
  if (
    expected.authorityId !== actual.authorityId || expected.mode !== actual.mode
    || expected.hostIdentity !== actual.hostIdentity || expected.instanceId !== actual.instanceId
  ) {
    throw new StateAuthorityMismatchError(expected, {
      authorityId: actual.authorityId, mode: actual.mode, hostIdentity: actual.hostIdentity, instanceId: actual.instanceId,
    })
  }
}
