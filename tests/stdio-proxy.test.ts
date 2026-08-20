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
import { readEndpointDescriptor, StdioProxyFacade } from '../src/stdio-proxy/index.js'

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
  await writeFile(join(root, 'relay-status.json'), JSON.stringify({
    schemaVersion: 1,
    state: 'ready',
    authorityId,
    mode: 'embedded',
    instanceId: authorityId,
    ownerPid: process.pid,
    processStartedAt: '2026-08-20T00:00:00.000Z',
    ownerEpoch,
    hostIdentity: 'http://127.0.0.1:3080/',
    profile: 'web',
    dshHome: root,
    updatedAt: '2026-08-20T00:00:00.000Z',
    lastError: null,
  }), { encoding: 'utf8' })
}
