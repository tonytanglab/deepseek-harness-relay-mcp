export type RelayRuntimePathSource = 'environment' | 'default' | 'explicit'

export interface RelayRuntimeResolveInput {
  mode: 'embedded' | 'standalone'
  env?: NodeJS.ProcessEnv
  homeDirectory?: string
  hostIdentity?: string
  stateDirectory?: string
  tokenFile?: string
  endpointDescriptorFile?: string
  userDataHome?: string
}

export interface RelayRuntimePaths {
  mode: 'embedded' | 'standalone'
  dshHome: string
  dshHomeSource: Exclude<RelayRuntimePathSource, 'explicit'>
  profile: string
  profileSource: Exclude<RelayRuntimePathSource, 'explicit'>
  profileRoot: string
  stateDirectory: string
  stateFile: string
  endpointDescriptorFile: string
  endpointDescriptorSource: RelayRuntimePathSource
  statusFile: string
  tokenFile: string
}

export type RelayStatusState = 'starting' | 'ready' | 'failed' | 'stopped'

export interface RelayStatusError {
  code: string
  message: string
  remediation: string
}

export interface RelayStatusDocument {
  schemaVersion: 1
  state: RelayStatusState
  authorityId: string
  mode: 'embedded' | 'standalone'
  instanceId: string
  ownerPid: number | null
  processStartedAt: string | null
  ownerEpoch: number | null
  hostIdentity: string
  profile: string
  dshHome: string
  updatedAt: string
  lastError: RelayStatusError | null
}

export interface RelayStatusWriteInput extends Omit<RelayStatusDocument, 'schemaVersion' | 'updatedAt'> {
  updatedAt?: string
}
