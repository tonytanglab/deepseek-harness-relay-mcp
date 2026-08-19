import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { StdioProxyFacade } from './stdio-proxy/index.js'

const descriptorFile = resolve(process.env.DSH_RELAY_ENDPOINT_DESCRIPTOR?.trim() || defaultDescriptor())
const proxy = new StdioProxyFacade({
  descriptorFile,
  clientPrincipalId: process.env.DSH_RELAY_CLIENT_PRINCIPAL_ID?.trim() || 'local-user',
  requestTimeoutMs: integer(process.env.DSH_RELAY_PROXY_TIMEOUT_MS, 35_000, 1_000, 120_000),
})
await proxy.connect(new StdioServerTransport())

function defaultDescriptor(): string {
  const dshHome = process.env.DSH_HOME?.trim() || join(homedir(), '.dsh')
  const profile = process.env.DSH_PROFILE?.trim() || 'web'
  if (!/^[A-Za-z0-9._-]+$/u.test(profile)) throw new Error(`invalid DSH_PROFILE: ${profile}`)
  return join(dshHome, 'plugins', 'dsh-relay', profile, 'relay-endpoint.json')
}

function integer(raw: string | undefined, fallback: number, min: number, max: number): number {
  if (raw === undefined) return fallback
  const value = Number(raw)
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`invalid integer setting: ${raw}`)
  return value
}
