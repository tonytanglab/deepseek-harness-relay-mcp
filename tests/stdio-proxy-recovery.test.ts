import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer as createHttpServer, type Server as HttpServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { type TestContext } from 'node:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { resolveConfig, type RelayConfig } from '../src/config.js'
import { McpHttpFacade } from '../src/mcp-http/index.js'
import { createServer } from '../src/mcp-server/index.js'
import { MonitoringFacade } from '../src/monitoring/index.js'
import { RelayFacade } from '../src/relay-broker/index.js'
import { StdioProxyFacade } from '../src/stdio-proxy/index.js'

test('proxy reports Host shutdown structurally and a restarted proxy recovers after Host restart', async t => {
  ;(globalThis as Record<string, unknown>).__DSH_RELAY_VERSION__ = 'test'
  const root = await temporaryDirectory(t)
  const token = 'R'.repeat(43)
  const tokenFile = join(root, 'relay.token')
  const descriptorFile = join(root, 'relay-endpoint.json')
  const stateFile = join(root, 'state.json')
  await writeFile(tokenFile, `${token}\n`, { encoding: 'utf8', mode: 0o600 })

  let brokerCreations = 0
  let mcpAdapterCreations = 0
  const config = resolveConfig({
    DSH_RELAY_HOST_URL: 'http://127.0.0.1:3080/',
    DSH_RELAY_ALLOWED_WORKSPACE_ROOTS: root,
    DSH_RELAY_STATE_FILE: stateFile,
  })
  const firstHost = await startHost(config, token, 0, () => { brokerCreations += 1 }, () => { mcpAdapterCreations += 1 })
  t.after(async () => { await firstHost.facade.drain(); await close(firstHost.http) })
  const port = portOf(firstHost.http)
  await writeDescriptor(descriptorFile, tokenFile, port, 1)

  const firstConnection = await connectProxy(descriptorFile)
  t.after(async () => { await Promise.allSettled([firstConnection.client.close(), firstConnection.proxy.close()]) })
  const firstTools = await firstConnection.client.listTools()
  assert.ok(firstTools.tools.some(tool => tool.name === 'doctor'))
  await firstConnection.client.listTools()
  await firstConnection.client.listTools()
  assert.equal(brokerCreations, 1)
  assert.ok(mcpAdapterCreations >= 4)

  await firstHost.facade.drain()
  const shutdownFailure = await captureFailure(firstConnection.client.listTools())
  assert(shutdownFailure instanceof Error)
  assert.match(shutdownFailure.message, /503|draining/iu)
  assert.equal(errorDataCode(shutdownFailure), 'DRAINING')
  await close(firstHost.http)
  await Promise.allSettled([firstConnection.client.close(), firstConnection.proxy.close()])

  const secondHost = await startHost(config, token, port, () => { brokerCreations += 1 }, () => { mcpAdapterCreations += 1 })
  t.after(async () => { await secondHost.facade.drain(); await close(secondHost.http) })
  await writeDescriptor(descriptorFile, tokenFile, port, 2)
  const recovered = await connectProxy(descriptorFile)
  t.after(async () => { await Promise.allSettled([recovered.client.close(), recovered.proxy.close()]) })

  assert.ok((await recovered.client.listTools()).tools.some(tool => tool.name === 'doctor'))
  await recovered.client.listTools()
  assert.equal(brokerCreations, 2)
  assert.ok(mcpAdapterCreations >= 7)
})

async function startHost(
  config: RelayConfig,
  token: string,
  port: number,
  onBroker: () => void,
  onAdapter: () => void,
): Promise<{ http: HttpServer; facade: McpHttpFacade }> {
  onBroker()
  const relay = new RelayFacade(config, async () => { throw new Error('Harness API is not needed for handshake tests') })
  const monitoring = new MonitoringFacade()
  let facade: McpHttpFacade
  const http = createHttpServer((req, res) => { void facade.handle(req, res) })
  await listen(http, port)
  const address = http.address()
  assert(address !== null && typeof address === 'object')
  facade = new McpHttpFacade({
    token,
    allowedHosts: [`127.0.0.1:${address.port}`],
    allowedOrigins: [],
    maxBodyBytes: 64 * 1024,
    maxConcurrent: 8,
    requestsPerMinute: 1_000,
    drainTimeoutMs: 100,
  }, principal => {
    onAdapter()
    return createServer(relay, config, monitoring, principal)
  })
  return { http, facade }
}

async function connectProxy(descriptorFile: string): Promise<{ proxy: StdioProxyFacade; client: Client }> {
  const proxy = new StdioProxyFacade({ descriptorFile, clientPrincipalId: 'codex:user', requestTimeoutMs: 1_000 })
  const [clientTransport, proxyTransport] = InMemoryTransport.createLinkedPair()
  await proxy.connect(proxyTransport)
  const client = new Client({ name: 'test-client', version: '1.0.0' })
  await client.connect(clientTransport)
  return { proxy, client }
}

async function writeDescriptor(descriptorFile: string, tokenFile: string, port: number, ownerEpoch: number): Promise<void> {
  await writeFile(descriptorFile, JSON.stringify({
    schemaVersion: 1,
    authorityId: `authority-${ownerEpoch}`,
    mode: 'embedded',
    mcpUrl: `http://127.0.0.1:${port}/plugins/dsh-relay/mcp`,
    tokenFilePath: tokenFile,
    hostWebUrl: `http://127.0.0.1:${port}/`,
    ownerEpoch,
    updatedAt: new Date().toISOString(),
  }), { encoding: 'utf8' })
}

function errorDataCode(error: Error): unknown {
  if ('data' in error && typeof error.data === 'object' && error.data !== null) {
    const code = (error.data as { code?: unknown }).code
    if (code !== undefined) return code
  }
  return /DRAINING/iu.test(error.message) ? 'DRAINING' : undefined
}

async function captureFailure(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise
    return null
  } catch (error) {
    return error
  }
}

function portOf(server: HttpServer): number {
  const address = server.address()
  assert(address !== null && typeof address === 'object')
  return address.port
}

function listen(server: HttpServer, port: number): Promise<void> {
  return new Promise((resolveListen, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => { server.off('error', reject); resolveListen() })
  })
}

function close(server: HttpServer): Promise<void> {
  return new Promise((resolveClose, reject) => {
    if (!server.listening) return resolveClose()
    server.close(error => { if (error === undefined) resolveClose(); else reject(error) })
  })
}

async function temporaryDirectory(t: TestContext): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), `dsh-relay-proxy-recovery-${randomUUID()}-`))
  t.after(async () => { await rm(directory, { recursive: true, force: true }) })
  return directory
}
