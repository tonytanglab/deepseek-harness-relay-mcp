import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer as createHttpServer, type Server as HttpServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { type TestContext } from 'node:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { McpHttpFacade } from '../src/mcp-http/index.js'
import { ProxyDiagnosticsFacade, readEndpointDescriptor, StdioProxyFacade } from '../src/stdio-proxy/index.js'

test('stdio proxy discovers the authority and transparently forwards tools', async t => {
  const root = await temporaryDirectory(t)
  const token = 'P'.repeat(43)
  const tokenFile = join(root, 'relay.token')
  await writeFile(tokenFile, `${token}\n`, { encoding: 'utf8', mode: 0o600 })
  const principals: string[] = []
  let facade: McpHttpFacade
  const http = createHttpServer((req, res) => { void facade.handle(req, res) })
  await listen(http)
  t.after(async () => { await facade.drain(); await close(http) })
  const address = http.address()
  assert(address !== null && typeof address === 'object')
  const host = `127.0.0.1:${address.port}`
  facade = new McpHttpFacade({
    token,
    allowedHosts: [host],
    allowedOrigins: [],
    maxBodyBytes: 64 * 1024,
    maxConcurrent: 8,
    requestsPerMinute: 1_000,
    drainTimeoutMs: 100,
  }, principal => {
    principals.push(principal)
    const server = new McpServer({ name: 'remote', version: '1.0.0' })
    server.registerTool('double', {
      inputSchema: { value: z.number() },
      outputSchema: { value: z.number() },
    }, input => ({ content: [{ type: 'text', text: String(input.value * 2) }], structuredContent: { value: input.value * 2 } }))
    return server
  })
  const descriptorFile = join(root, 'relay-endpoint.json')
  await writeFile(descriptorFile, JSON.stringify({
    schemaVersion: 1,
    authorityId: 'authority-1',
    mode: 'embedded',
    mcpUrl: `http://${host}/plugins/dsh-relay/mcp`,
    tokenFilePath: tokenFile,
    hostWebUrl: `http://${host}/`,
    ownerEpoch: 1,
    updatedAt: '2026-08-19T00:00:00.000Z',
  }), { encoding: 'utf8' })
  await writeReadyStatus(root, 'authority-1', 1)

  const proxy = new StdioProxyFacade({ descriptorFile, clientPrincipalId: 'cursor:project', requestTimeoutMs: 5_000 })
  const [clientTransport, proxyTransport] = InMemoryTransport.createLinkedPair()
  await proxy.connect(proxyTransport)
  t.after(async () => { await proxy.close() })
  const client = new Client({ name: 'local', version: '1.0.0' })
  await client.connect(clientTransport)
  t.after(async () => { await client.close() })

  assert.deepEqual((await client.listTools()).tools.map(tool => tool.name), ['doctor', 'double'])
  assert.deepEqual((await client.callTool({ name: 'double', arguments: { value: 4 } })).structuredContent, { value: 8 })
  assert.ok(principals.every(principal => principal === 'cursor:project'))
})

test('stdio proxy initializes locally and exposes doctor when the endpoint is missing', async t => {
  const root = await temporaryDirectory(t)
  const descriptorFile = join(root, 'relay-endpoint.json')
  await writeReadyStatus(root, 'authority-missing', 1)
  const proxy = new StdioProxyFacade({ descriptorFile, clientPrincipalId: 'codex:user', requestTimeoutMs: 500 })
  const [clientTransport, proxyTransport] = InMemoryTransport.createLinkedPair()
  await proxy.connect(proxyTransport)
  t.after(async () => { await proxy.close() })
  const client = new Client({ name: 'local', version: '1.0.0' })
  await client.connect(clientTransport)
  t.after(async () => { await client.close() })

  assert.deepEqual((await client.listTools()).tools.map(tool => tool.name), ['doctor'])
  const doctor = await client.callTool({ name: 'doctor', arguments: {} })
  assert.equal((doctor.structuredContent as { errorCode?: unknown }).errorCode, 'DESCRIPTOR_MISSING')
  const unavailable = await client.callTool({ name: 'start_run', arguments: {} })
  assert.equal(unavailable.isError, true)
  assert.deepEqual(unavailable.structuredContent, {
    code: 'RELAY_ROUTE_UNAVAILABLE',
    reasonCode: 'DESCRIPTOR_MISSING',
    message: 'Relay endpoint descriptor is missing.',
    retryable: true,
    remediation: 'Reload the Harness web profile so Relay can publish a fresh endpoint descriptor.',
  })
})

test('stdio proxy rejects a status and descriptor epoch mismatch as stale', async t => {
  const root = await temporaryDirectory(t)
  const descriptorFile = join(root, 'relay-endpoint.json')
  await writeReadyStatus(root, 'authority-current', 2)
  await writeFile(descriptorFile, JSON.stringify({
    schemaVersion: 1,
    authorityId: 'authority-old',
    mode: 'embedded',
    mcpUrl: 'http://127.0.0.1:3080/plugins/dsh-relay/mcp',
    tokenFilePath: join(root, 'relay.token'),
    hostWebUrl: 'http://127.0.0.1:3080/',
    ownerEpoch: 1,
    updatedAt: '2026-08-19T00:00:00.000Z',
  }), { encoding: 'utf8' })
  const proxy = new StdioProxyFacade({ descriptorFile, clientPrincipalId: 'codex:user', requestTimeoutMs: 500 })
  const [clientTransport, proxyTransport] = InMemoryTransport.createLinkedPair()
  await proxy.connect(proxyTransport)
  t.after(async () => { await proxy.close() })
  const client = new Client({ name: 'local', version: '1.0.0' })
  await client.connect(clientTransport)
  t.after(async () => { await client.close() })

  const doctor = await client.callTool({ name: 'doctor', arguments: {} })
  assert.equal((doctor.structuredContent as { errorCode?: unknown }).errorCode, 'STALE_ENDPOINT_DESCRIPTOR')
})

test('stdio proxy reports failed status without exposing status credentials', async t => {
  const root = await temporaryDirectory(t)
  const descriptorFile = join(root, 'relay-endpoint.json')
  await writeFile(join(root, 'relay-status.json'), JSON.stringify({
    schemaVersion: 1,
    state: 'failed',
    authorityId: 'authority-failed',
    mode: 'embedded',
    instanceId: 'authority-failed',
    ownerPid: null,
    processStartedAt: null,
    ownerEpoch: null,
    hostIdentity: 'http://127.0.0.1:3080/',
    profile: 'web',
    dshHome: root,
    updatedAt: '2026-08-20T00:00:00.000Z',
    lastError: { code: 'RELAY_PATH_INVALID', message: 'directory unavailable', remediation: 'Fix directory permissions.' },
  }), { encoding: 'utf8' })
  const proxy = new StdioProxyFacade({ descriptorFile, clientPrincipalId: 'codex:user', requestTimeoutMs: 500 })
  const [clientTransport, proxyTransport] = InMemoryTransport.createLinkedPair()
  await proxy.connect(proxyTransport)
  t.after(async () => { await proxy.close() })
  const client = new Client({ name: 'local', version: '1.0.0' })
  await client.connect(clientTransport)
  t.after(async () => { await client.close() })

  const doctor = await client.callTool({ name: 'doctor', arguments: {} })
  const report = doctor.structuredContent as { errorCode?: unknown; status?: unknown }
  assert.equal(report.errorCode, 'STATUS_FAILED')
  assert.doesNotMatch(JSON.stringify(report), /authorization|ownerToken|"token"/iu)
})

test('stdio proxy preserves a healthy remote route after a tool call timeout', async t => {
  const root = await temporaryDirectory(t)
  const token = 'T'.repeat(43)
  const tokenFile = join(root, 'relay.token')
  await writeFile(tokenFile, `${token}\n`, { encoding: 'utf8', mode: 0o600 })
  let facade: McpHttpFacade
  const http = createHttpServer((req, res) => { void facade.handle(req, res) })
  await listen(http)
  t.after(async () => { await facade.drain(); await close(http) })
  const address = http.address()
  assert(address !== null && typeof address === 'object')
  const host = `127.0.0.1:${address.port}`
  facade = new McpHttpFacade({
    token,
    allowedHosts: [host],
    allowedOrigins: [],
    maxBodyBytes: 64 * 1024,
    maxConcurrent: 8,
    requestsPerMinute: 1_000,
    drainTimeoutMs: 100,
  }, () => {
    const server = new McpServer({ name: 'remote', version: '1.0.0' })
    server.registerTool('slow', { inputSchema: {} }, async () => {
      await new Promise(resolve => setTimeout(resolve, 100))
      return { content: [{ type: 'text', text: 'late' }] }
    })
    server.registerTool('quick', { inputSchema: {} }, () => ({
      content: [{ type: 'text', text: 'ready' }],
      structuredContent: { ready: true },
    }))
    return server
  })
  const descriptorFile = join(root, 'relay-endpoint.json')
  await writeFile(descriptorFile, JSON.stringify({
    schemaVersion: 1,
    authorityId: 'authority-timeout',
    mode: 'embedded',
    mcpUrl: `http://${host}/plugins/dsh-relay/mcp`,
    tokenFilePath: tokenFile,
    hostWebUrl: `http://${host}/`,
    ownerEpoch: 1,
    updatedAt: '2026-08-19T00:00:00.000Z',
  }), { encoding: 'utf8' })
  await writeReadyStatus(root, 'authority-timeout', 1)

  const proxy = new StdioProxyFacade({ descriptorFile, clientPrincipalId: 'codex:user', requestTimeoutMs: 50 })
  const [clientTransport, proxyTransport] = InMemoryTransport.createLinkedPair()
  await proxy.connect(proxyTransport)
  t.after(async () => { await proxy.close() })
  const client = new Client({ name: 'local', version: '1.0.0' })
  await client.connect(clientTransport)
  t.after(async () => { await client.close() })

  const timedOut = await client.callTool({ name: 'slow', arguments: {} })
  assert.equal(timedOut.isError, true)
  assert.equal((timedOut.structuredContent as { code?: unknown }).code, 'RELAY_REQUEST_TIMEOUT')
  assert.notEqual((timedOut.structuredContent as { code?: unknown }).code, 'RELAY_ROUTE_UNAVAILABLE')
  assert.equal((timedOut.structuredContent as { outcome?: unknown }).outcome, 'unknown')

  assert.deepEqual((await client.callTool({ name: 'quick', arguments: {} })).structuredContent, { ready: true })
  const doctor = await client.callTool({ name: 'doctor', arguments: {} })
  assert.equal((doctor.structuredContent as { ok?: unknown }).ok, true)
  assert.equal((doctor.structuredContent as { remote?: { connected?: unknown } }).remote?.connected, true)
})

test('proxy doctor reports a provably dead ready owner before reading stale endpoint artifacts', async t => {
  const root = await temporaryDirectory(t)
  const descriptorFile = join(root, 'relay-endpoint.json')
  await writeStatus(root, {
    state: 'ready',
    ownerPid: 2_147_483_647,
    processStartedAt: '2026-08-20T00:00:00.000Z',
  })

  const diagnostics = new ProxyDiagnosticsFacade(descriptorFile)
  const report = await diagnostics.doctor('test', false, null)

  assert.equal(report.errorCode, 'OWNER_DEAD')
  assert.deepEqual(report.ownerProbe, { processId: 2_147_483_647, state: 'dead' })
  assert.match(report.remediation ?? '', /will not restart or stop/iu)
  assert.doesNotMatch(JSON.stringify(report), /authorization|ownerToken|Bearer/iu)
})

test('proxy doctor fails closed when owner liveness cannot be verified', async t => {
  const root = await temporaryDirectory(t)
  const descriptorFile = join(root, 'relay-endpoint.json')
  await writeStatus(root, {
    state: 'starting',
    ownerPid: 8123,
    processStartedAt: '2026-08-20T00:00:00.000Z',
  })

  const diagnostics = new ProxyDiagnosticsFacade(descriptorFile, undefined, { processProbe: () => 'unknown' })
  const inspected = await diagnostics.inspect()
  const report = await diagnostics.doctor('test', false, null)

  assert.equal(inspected.failure?.reasonCode, 'OWNER_UNPROBEABLE')
  assert.deepEqual(report.ownerProbe, { processId: 8123, state: 'unknown' })
  assert.equal(report.errorCode, 'OWNER_UNPROBEABLE')
})

for (const scenario of [
  { status: 401, reasonCode: 'AUTHENTICATION_FAILED' },
  { status: 405, reasonCode: 'POST_ROUTE_MISSING' },
] as const) {
  test(`stdio proxy maps HTTP ${scenario.status} to ${scenario.reasonCode}`, async t => {
    const root = await temporaryDirectory(t)
    const token = 'S'.repeat(43)
    const tokenFile = join(root, 'relay.token')
    await writeFile(tokenFile, `${token}\n`, { encoding: 'utf8', mode: 0o600 })
    const http = createHttpServer((_req, res) => {
      res.statusCode = scenario.status
      res.end('route unavailable')
    })
    await listen(http)
    t.after(async () => { await close(http) })
    const address = http.address()
    assert(address !== null && typeof address === 'object')
    const descriptorFile = join(root, 'relay-endpoint.json')
    await writeFile(descriptorFile, JSON.stringify({
      schemaVersion: 1,
      authorityId: 'authority-http',
      mode: 'embedded',
      mcpUrl: `http://127.0.0.1:${address.port}/plugins/dsh-relay/mcp`,
      tokenFilePath: tokenFile,
      hostWebUrl: `http://127.0.0.1:${address.port}/`,
      ownerEpoch: 1,
      updatedAt: '2026-08-20T00:00:00.000Z',
    }), { encoding: 'utf8' })
    await writeReadyStatus(root, 'authority-http', 1)
    const proxy = new StdioProxyFacade({ descriptorFile, clientPrincipalId: 'codex:user', requestTimeoutMs: 500 })
    const [clientTransport, proxyTransport] = InMemoryTransport.createLinkedPair()
    await proxy.connect(proxyTransport)
    t.after(async () => { await proxy.close() })
    const client = new Client({ name: 'local', version: '1.0.0' })
    await client.connect(clientTransport)
    t.after(async () => { await client.close() })

    assert.deepEqual((await client.listTools()).tools.map(tool => tool.name), ['doctor'])
    const doctor = await client.callTool({ name: 'doctor', arguments: {} })
    assert.equal((doctor.structuredContent as { errorCode?: unknown }).errorCode, scenario.reasonCode)
  })
}

test('descriptor reader rejects credentials and non-loopback endpoints', async t => {
  const root = await temporaryDirectory(t)
  const file = join(root, 'relay-endpoint.json')
  const base = {
    schemaVersion: 1,
    authorityId: 'authority-1',
    mode: 'embedded',
    mcpUrl: 'http://127.0.0.1:3080/plugins/dsh-relay/mcp',
    tokenFilePath: join(root, 'relay.token'),
    hostWebUrl: 'http://127.0.0.1:3080/',
    ownerEpoch: 1,
    updatedAt: '2026-08-19T00:00:00.000Z',
  }
  await writeFile(file, JSON.stringify({ ...base, token: 'secret' }), { encoding: 'utf8' })
  await assert.rejects(readEndpointDescriptor(file), /must not contain credentials/iu)
  await writeFile(file, JSON.stringify({ ...base, mcpUrl: 'http://example.com/mcp' }), { encoding: 'utf8' })
  await assert.rejects(readEndpointDescriptor(file), /loopback HTTP/iu)
})

function listen(server: HttpServer): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve() })
  })
}

function close(server: HttpServer): Promise<void> {
  return new Promise((resolve, reject) => server.close(error => { if (error === undefined) resolve(); else reject(error) }))
}

async function temporaryDirectory(t: TestContext): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-relay-proxy-'))
  t.after(async () => { await rm(directory, { recursive: true, force: true }) })
  return directory
}

async function writeReadyStatus(root: string, authorityId: string, ownerEpoch: number): Promise<void> {
  await writeStatus(root, {
    authorityId,
    instanceId: authorityId,
    ownerEpoch,
  })
}

async function writeStatus(root: string, overrides: Record<string, unknown>): Promise<void> {
  await writeFile(join(root, 'relay-status.json'), JSON.stringify({
    schemaVersion: 1,
    state: 'ready',
    authorityId: 'authority-ready',
    mode: 'embedded',
    instanceId: 'authority-ready',
    ownerPid: process.pid,
    processStartedAt: '2026-08-20T00:00:00.000Z',
    ownerEpoch: 1,
    hostIdentity: 'http://127.0.0.1:3080/',
    profile: 'web',
    dshHome: root,
    updatedAt: '2026-08-20T00:00:00.000Z',
    lastError: null,
    ...overrides,
  }), { encoding: 'utf8' })
}
