import type { AuthorityMode, StateAuthorityMetadata } from '../types.js'

export interface AuthorityStatePaths {
  stateDirectory: string
  stateFile: string
  endpointDescriptorFile: string
  tokenFile: string
}

export interface ResolveAuthorityPathsInput {
  mode: AuthorityMode
  hostIdentity: string
  dshHome?: string
  userDataHome?: string
  profile?: string
}

export interface AuthorityOwnerRecord {
  schemaVersion: 1
  hostIdentity: string
  authorityId: string
  mode: AuthorityMode
  instanceId: string
  ownerToken: string
  epoch: number
  processId: number
  processStartedAt: string
  acquiredAt: string
  updatedAt: string
}

export interface AcquireAuthorityInput extends Omit<StateAuthorityMetadata, 'migration'> {
  registryDirectory?: string
  ownerToken?: string
  recoverStale?: boolean
}

export interface AuthorityOwnerLease {
  readonly record: AuthorityOwnerRecord
  readonly reused: boolean
  release(): Promise<boolean>
}

export interface AuthorityAcquireRetryOptions {
  budgetMs?: number
  initialDelayMs?: number
  maxDelayMs?: number
  jitterMs?: number
  signal?: AbortSignal
}

export interface RelayEndpointDescriptor {
  schemaVersion: 1
  authorityId: string
  mode: AuthorityMode
  mcpUrl: string
  tokenFilePath: string
  hostWebUrl: string
  ownerEpoch: number
  updatedAt: string
}

export interface EndpointDescriptorInput extends Omit<RelayEndpointDescriptor, 'schemaVersion' | 'updatedAt'> {
  updatedAt?: string
}
