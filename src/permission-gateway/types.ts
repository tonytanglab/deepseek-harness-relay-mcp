export type PermissionPreset = 'read-only' | 'workspace-write' | 'danger-full-access'

export interface PermissionGateway {
  current(sessionId: string): Promise<PermissionPreset>
  select(sessionId: string, preset: PermissionPreset): Promise<PermissionPreset>
  confirm(sessionId: string, expected: PermissionPreset): Promise<PermissionPreset>
}

export interface PermissionProvider {
  readCurrent(sessionId: string): Promise<unknown>
  select(sessionId: string, preset: PermissionPreset): Promise<PermissionSelectionResult>
}

export interface PermissionSelectionResult {
  accepted: boolean
}

export interface ExternalPermissionClient {
  readPermissionProjection(sessionId: string): Promise<PermissionProjection>
  requestPermissionSelection(sessionId: string, preset: PermissionPreset): Promise<PermissionCommandResult>
}

export interface PermissionProjection {
  currentValue?: unknown
}

export interface PermissionCommandResult {
  kind?: unknown
}

export type PermissionGatewayErrorCode = 'PERMISSION_UNAVAILABLE' | 'PERMISSION_DENIED'

export interface PermissionGatewayErrorDetails {
  sessionId: string
  expected?: PermissionPreset
  actual?: unknown
}

export class PermissionGatewayError extends Error {
  readonly definitive = true
  readonly retryable = false

  constructor(
    readonly code: PermissionGatewayErrorCode,
    message: string,
    readonly details: PermissionGatewayErrorDetails,
  ) {
    super(message)
    this.name = 'PermissionGatewayError'
  }
}
