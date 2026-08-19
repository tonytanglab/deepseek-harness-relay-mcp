import type { RelayEndpointDescriptor } from '../authority/index.js'

export type { RelayEndpointDescriptor }

export interface StdioProxyConfig {
  descriptorFile: string
  clientPrincipalId: string
  requestTimeoutMs: number
}
