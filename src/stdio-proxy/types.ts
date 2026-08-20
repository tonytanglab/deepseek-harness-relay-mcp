import type { RelayEndpointDescriptor } from '../authority/index.js'
import type { RelayStatusDocument } from '../relay-runtime/index.js'

export type { RelayEndpointDescriptor }

export interface StdioProxyConfig {
  descriptorFile: string
  statusFile?: string
  clientPrincipalId: string
  requestTimeoutMs: number
}

export type ProxyRouteReasonCode =
  | 'DESCRIPTOR_MISSING'
  | 'DESCRIPTOR_INVALID'
  | 'STATUS_MISSING'
  | 'STATUS_INVALID'
  | 'STATUS_FAILED'
  | 'STATUS_NOT_READY'
  | 'STALE_ENDPOINT_DESCRIPTOR'
  | 'TOKEN_UNREADABLE'
  | 'TOKEN_INVALID'
  | 'AUTHENTICATION_FAILED'
  | 'POST_ROUTE_MISSING'
  | 'REMOTE_DRAINING'
  | 'REMOTE_UNAVAILABLE'

export interface ProxyRouteFailure {
  code: 'RELAY_ROUTE_UNAVAILABLE'
  reasonCode: ProxyRouteReasonCode
  message: string
  retryable: boolean
  remediation: string
}

export interface ProxyDoctorReport {
  schemaVersion: 1
  ok: boolean
  relayVersion: string
  mode: 'stdio-proxy'
  descriptorFile: string
  statusFile: string
  status: RelayStatusDocument | null
  endpoint: Omit<RelayEndpointDescriptor, 'tokenFilePath'> | null
  tokenFile: { exists: boolean; readable: boolean; valid: boolean }
  remote: { connected: boolean; lastError: ProxyRouteFailure | null }
  errorCode: ProxyRouteReasonCode | null
  remediation: string | null
}
