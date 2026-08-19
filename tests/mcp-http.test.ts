import assert from 'node:assert/strict'
import { chmod, mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { createServer as createHttpServer, request, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { type TestContext } from 'node:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import { z } from 'zod'
import { McpHttpFacade, TokenStoreFacade } from '../src/mcp-http/index.js'

test('token store atomically creates and reuses a 256-bit file secret', async t => {
  const root = await temporaryDirectory(t)
  const tokenFile = join(root, 'secrets', 'relay.token')
  const store = new TokenStoreFacade()

  const first = await store.loadOrCreate({ tokenFile })
  const second = await store.loadOrCreate({ tokenFile })

  assert.match(first.token, /^[A-Za-z0-9_-]{43}$/u)
  assert.equal(second.token, first.token)
  assert.equal((await readFile(tokenFile, 'utf8')).trim(), first.token)
  if (process.platform !== 'win32') assert.equal((await stat(tokenFile)).mode & 0o777, 0o600)
})

test('environment token overrides the file without persisting the secret', async t => {
  const root = await temporaryDirectory(t)
  const tokenFile = join(root, 'relay.token')
  const token = 'A'.repeat(43)

  const loaded = await new TokenStoreFacade().loadOrCreate(
    { tokenFile, environmentVariable: 'DSH_RELAY_TEST_TOKEN' },
    { DSH_RELAY_TEST_TOKEN: token },
  )

  assert.deepEqual(loaded, { token, tokenFile, source: 'environment' })
  await assert.rejects(readFile(tokenFile, 'utf8'), /ENOENT/iu)
})

test('authenticated stateless HTTP supports initialize, tools/list, and tools/call', async t => {
  const fixture = await httpFixture(t)
  const transport = new StreamableHTTPClientTransport(fixture.url, {
    requestInit: { headers: { authorization: `Bearer ${fixture.token}`, 'x-dsh-relay-principal': 'codex:user' } },
  })
  const client = new Client({ name: 'mcp-http-test', version: '1.0.0' })
  t.after(async () => { await client.close() })

  await client.connect(transport as unknown as Transport)
  assert.deepEqual((await client.listTools()).tools.map(tool => tool.name), ['echo'])
  const result = await client.callTool({ name: 'echo', arguments: { text: 'ready' } })
  assert.deepEqual(result.structuredContent, { text: 'ready' })
  assert.ok(fixture.principals.every(value => value === 'codex:user'))
})

test('HTTP policy rejects bad auth, Host, Origin, oversized bodies, and post-drain requests', async t => {
  const fixture = await httpFixture(t, { maxBodyBytes: 128 })
  const validHeaders = { 'content-type': 'application/json', authorization: `Bearer ${fixture.token}` }

  assert.equal((await post(fixture.url, {}, { ...validHeaders, authorization: 'Bearer wrong' })).status, 401)
  assert.equal((await rawPost(fixture.url, {}, { ...validHeaders, host: 'attacker.invalid' })).status, 403)
  assert.equal((await post(fixture.url, {}, { ...validHeaders, origin: 'https://attacker.invalid' })).status, 403)
  const oversized = await post(fixture.url, { value: 'x'.repeat(256) }, validHeaders)
  assert.equal(oversized.status, 413)
  assert.equal((await oversized.json() as { error: { data: { code: string } } }).error.data.code, 'BODY_TOO_LARGE')

  await fixture.facade.drain()
  assert.equal((await post(fixture.url, {}, validHeaders)).status, 503)
})

async function httpFixture(t: TestContext, overrides: { maxBodyBytes?: number } = {}) {
  let facade: McpHttpFacade
  const principals: string[] = []
  const http = createHttpServer((req, res) => { void facade.handle(req, res) })
  await listen(http)
  t.after(async () => { await facade.drain(); await close(http) })
  const address = http.address()
  assert(address !== null && typeof address === 'object')
  const host = `127.0.0.1:${address.port}`
  const token = 'T'.repeat(43)
  facade = new McpHttpFacade({
    token,
    allowedHosts: [host],
    allowedOrigins: [`http://${host}`],
    maxBodyBytes: overrides.maxBodyBytes ?? 64 * 1024,
    maxConcurrent: 8,
    requestsPerMinute: 1_000,
    drainTimeoutMs: 100,
  }, principal => {
    principals.push(principal)
    const server = new McpServer({ name: 'fixture', version: '1.0.0' })
    server.registerTool('echo', {
      inputSchema: { text: z.string() },
      outputSchema: { text: z.string() },
    }, input => ({
      content: [{ type: 'text', text: input.text }],
      structuredContent: { text: input.text },
    }))
    return server
  })
  return { facade, principals, token, url: new URL(`http://${host}/plugins/dsh-relay/mcp`) }
}

function post(url: URL, body: unknown, headers: Record<string, string>): Promise<Response> {
  return fetch(url, { method: 'POST', headers, body: JSON.stringify(body) })
}

function rawPost(url: URL, body: unknown, headers: Record<string, string>): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body)
    const outgoing = request(url, { method: 'POST', headers: { ...headers, 'content-length': Buffer.byteLength(payload) } }, response => {
      const chunks: Buffer[] = []
      response.on('data', chunk => chunks.push(Buffer.from(chunk)))
      response.on('end', () => resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }))
    })
    outgoing.once('error', reject)
    outgoing.end(payload)
  })
}

function listen(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve() })
  })
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => server.close(error => { if (error === undefined) resolve(); else reject(error) }))
}

async function temporaryDirectory(t: TestContext): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-relay-http-'))
  t.after(async () => { await chmod(directory, 0o700).catch(() => undefined); await rm(directory, { recursive: true, force: true }) })
  return directory
}
