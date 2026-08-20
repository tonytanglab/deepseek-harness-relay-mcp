import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer as createHttpServer, type Server as HttpServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test, { type TestContext } from 'node:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { AuthorityRegistryFacade, RelayEndpointPublisher } from '../src/authority/index.js'
import { McpHttpFacade } from '../src/mcp-http/index.js'
import { RelayStatusFacade } from '../src/relay-runtime/index.js'
import { StdioProxyFacade } from '../src/stdio-proxy/index.js'

test('overlapping Web upgrade waits for the old owner and reconnects the same proxy to the new epoch', async t => {
  const root = await temporaryDirectory(t)
  const registryDirectory = join(root, 'authorities')
  const descriptorFile = join(root, 'relay-endpoint.json')
  const statusFile = join(root, 'relay-status.json')
  const tokenFile = join(root, 'relay-token')
  const token = 'U'.repeat(43)
  await writeFile(tokenFile, `${token}\n`, { encoding: 'utf8', mode: 0o600 })

  let oldHost = await startHost(token, 1)
  t.after(async () => { await stopHost(oldHost) })
  const port = portOf(oldHost.http)
  const hostIdentity = `http://127.0.0.1:${port}/`
  const liveness = new Map<number, 'alive' | 'dead' | 'unknown'>([[22_001, 'alive'], [22_002, 'alive']])
  const probe = (pid: number) => liveness.get(pid) ?? 'unknown'
  const ownerInput = {
    authorityId: 'embedded:upgrade-test',
    mode: 'embedded' as const,
    hostIdentity,
    instanceId: 'embedded:upgrade-test',
    registryDirectory,
    recoverStale: true,
  }
  const oldRegistry = new AuthorityRegistryFacade({
    processId: 22_001,
    processStartedAt: '2026-08-20T00:00:01.000Z',
    processProbe: probe,
  })
  const oldLease = await oldRegistry.acquire(ownerInput)
  await publishRuntime(descriptorFile, statusFile, tokenFile, hostIdentity, oldLease.record.epoch, oldLease.record.processId, oldLease.record.processStartedAt)

  const proxy = new StdioProxyFacade({ descriptorFile, statusFile, clientPrincipalId: 'codex:upgrade', requestTimeoutMs: 1_000 })
  const [clientTransport, proxyTransport] = InMemoryTransport.createLinkedPair()
  await proxy.connect(proxyTransport)
  t.after(async () => { await proxy.close() })
  const client = new Client({ name: 'upgrade-test', version: '1.0.0' })
  await client.connect(clientTransport)
  t.after(async () => { await client.close() })
  assert.equal(((await client.callTool({ name: 'epoch', arguments: {} })).structuredContent as { epoch?: unknown }).epoch, 1)

  let waits = 0
  const nextRegistry = new AuthorityRegistryFacade({
    processId: 22_002,
    processStartedAt: '2026-08-20T00:00:02.000Z',
    processProbe: probe,
    random: () => 0,
    sleep: async () => {
      waits += 1
      assert.equal(probe(22_001), 'alive')
      await stopHost(oldHost)
      liveness.set(22_001, 'dead')
    },
  })
  const nextLease = await nextRegistry.acquireWithRetry(ownerInput, {
    budgetMs: 1_000,
    initialDelayMs: 1,
    maxDelayMs: 1,
    jitterMs: 0,
  })
  t.after(async () => { await nextLease.release() })
  assert.equal(waits, 1)
  assert.equal(nextLease.record.epoch, oldLease.record.epoch + 1)

  oldHost = await startHost(token, 2, port)
  await publishRuntime(descriptorFile, statusFile, tokenFile, hostIdentity, nextLease.record.epoch, nextLease.record.processId, nextLease.record.processStartedAt)
  const tools = await client.listTools()
  assert.ok(tools.tools.some(tool => tool.name === 'epoch'))
  assert.equal(((await client.callTool({ name: 'epoch', arguments: {} })).structuredContent as { epoch?: unknown }).epoch, 2)
})

async function publishRuntime(
  descriptorFile: string,
  statusFile: string,
  tokenFile: string,
  hostWebUrl: string,
  ownerEpoch: number,
  ownerPid: number,
  processStartedAt: string,
): Promise<void> {
  await new RelayEndpointPublisher(descriptorFile).publish({
    authorityId: 'embedded:upgrade-test',
    mode: 'embedded',
    mcpUrl: new URL('/plugins/dsh-relay/mcp', hostWebUrl).href,
    tokenFilePath: tokenFile,
    hostWebUrl,
    ownerEpoch,
  })
  await new RelayStatusFacade(statusFile).write({
    state: 'ready',
    authorityId: 'embedded:upgrade-test',
    mode: 'embedded',
    instanceId: 'embedded:upgrade-test',
    ownerPid,
    processStartedAt,
    ownerEpoch,
    hostIdentity: hostWebUrl,
    profile: 'web',
    dshHome: dirname(statusFile),
    lastError: null,
  })
}

async function startHost(token: string, epoch: number, port = 0): Promise<{ http: HttpServer; facade: McpHttpFacade }> {
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
  }, () => {
    const server = new McpServer({ name: `epoch-${epoch}`, version: '1.0.0' })
    server.registerTool('epoch', {
      inputSchema: {},
      outputSchema: { epoch: z.number() },
    }, () => ({ content: [{ type: 'text', text: String(epoch) }], structuredContent: { epoch } }))
    return server
  })
  return { http, facade }
}

async function stopHost(host: { http: HttpServer; facade: McpHttpFacade }): Promise<void> {
  await host.facade.drain()
  await close(host.http)
}

function listen(server: HttpServer, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => { server.off('error', reject); resolve() })
  })
}

function close(server: HttpServer): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!server.listening) return resolve()
    server.close(error => { if (error === undefined) resolve(); else reject(error) })
  })
}

function portOf(server: HttpServer): number {
  const address = server.address()
  assert(address !== null && typeof address === 'object')
  return address.port
}

async function temporaryDirectory(t: TestContext): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-relay-upgrade-overlap-'))
  t.after(async () => { await rm(directory, { recursive: true, force: true }) })
  return directory
}
