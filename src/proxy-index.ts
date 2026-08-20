import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { RelayRuntimeFacade } from './relay-runtime/index.js'
import { StdioProxyFacade } from './stdio-proxy/index.js'

const runtimePaths = new RelayRuntimeFacade().resolve({ mode: 'embedded', env: process.env })
const proxy = new StdioProxyFacade({
  descriptorFile: runtimePaths.endpointDescriptorFile,
  statusFile: runtimePaths.statusFile,
  clientPrincipalId: process.env.DSH_RELAY_CLIENT_PRINCIPAL_ID?.trim() || 'local-user',
  requestTimeoutMs: integer(process.env.DSH_RELAY_PROXY_TIMEOUT_MS, 35_000, 1_000, 120_000),
})
await proxy.connect(new StdioServerTransport())

function integer(raw: string | undefined, fallback: number, min: number, max: number): number {
  if (raw === undefined) return fallback
  const value = Number(raw)
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`invalid integer setting: ${raw}`)
  return value
}
