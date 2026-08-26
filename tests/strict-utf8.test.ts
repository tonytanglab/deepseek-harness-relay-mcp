import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type { IncomingMessage } from 'node:http'
import { HttpHostClient } from '../src/harness-gateway/http-host-client.js'
import { readJsonBody } from '../src/mcp-http/mcp-http-facade.js'
import { RelayStatusFacade } from '../src/relay-runtime/index.js'
import { FileLockFacade } from '../src/state-repository/index.js'
import { RelayStateStore } from '../src/state-store.js'
import { decodeUtf8Strict, readTextFileStrict, StrictUtf8Error } from '../src/strict-utf8.js'

test('decodeUtf8Strict rejects malformed UTF-8 instead of replacing it with U+FFFD', () => {
  assert.equal(decodeUtf8Strict(new TextEncoder().encode('你好 relay')), '你好 relay')
  const malformed = new Uint8Array([0xc3, 0x28])
  assert.throws(() => decodeUtf8Strict(malformed, 'sample.bin'), (error: unknown) => {
    assert.ok(error instanceof StrictUtf8Error)
    assert.equal(error.code, 'UTF8_INVALID')
    assert.match(error.message, /not valid UTF-8/u)
    assert.doesNotMatch(error.message, /\uFFFD/u)
    return true
  })
  const truncated = new Uint8Array([0xe4, 0xb8])
  assert.throws(() => decodeUtf8Strict(truncated, 'sample.bin'), (error: unknown) => error instanceof StrictUtf8Error && error.code === 'UTF8_INVALID')
})

test('decodeUtf8Strict rejects a UTF-8 BOM', () => {
  const bom = new Uint8Array([0xef, 0xbb, 0xbf, 0x7b, 0x7d])
  assert.throws(() => decodeUtf8Strict(bom, 'sample.json'), (error: unknown) => {
    assert.ok(error instanceof StrictUtf8Error)
    assert.equal(error.code, 'UTF8_BOM')
    assert.match(error.message, /BOM/u)
    return true
  })
})

test('readTextFileStrict reads valid UTF-8 and rejects BOM or malformed files', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-strict-utf8-'))
  const validPath = join(directory, 'valid.txt')
  const bomPath = join(directory, 'bom.txt')
  const malformedPath = join(directory, 'bad.txt')
  await writeFile(validPath, '内容 ok', { encoding: 'utf8' })
  await writeFile(bomPath, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('{}', 'utf8')]))
  await writeFile(malformedPath, Buffer.from([0xc3, 0x28]))

  assert.equal(await readTextFileStrict(validPath), '内容 ok')
  assert.equal(await readTextFileStrict(join(directory, 'missing.txt')), null)
  await assert.rejects(readTextFileStrict(bomPath), error => error instanceof StrictUtf8Error && error.code === 'UTF8_BOM')
  await assert.rejects(readTextFileStrict(malformedPath), error => error instanceof StrictUtf8Error && error.code === 'UTF8_INVALID')
  await rm(directory, { recursive: true, force: true })
})

test('HttpHostClient decodes the Host JSON body with a fatal UTF-8 decoder', async () => {
  const client = new HttpHostClient('http://127.0.0.1:1/', 5_000, async () => new Response(Buffer.from([0xc3, 0x28]), { status: 200, headers: { 'content-type': 'application/json' } }))
  await assert.rejects(client.call('session.history', {}), error => error instanceof StrictUtf8Error && error.code === 'UTF8_INVALID')

  const bomClient = new HttpHostClient('http://127.0.0.1:1/', 5_000, async () => new Response(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('{}')]), { status: 200 }))
  await assert.rejects(bomClient.call('session.history', {}), error => error instanceof StrictUtf8Error && error.code === 'UTF8_BOM')

  const valid = new HttpHostClient('http://127.0.0.1:1/', 5_000, async () => new Response(Buffer.from('{"rpcId":"r","result":{"ok":true,"value":{"v":1}}}'), { status: 200, headers: { 'content-type': 'application/json' } }))
  assert.deepEqual(await valid.call<{ v: number }>('session.history', {}, 'r'), { v: 1 })
})

test('readJsonBody rejects malformed and BOM-marked MCP bodies', async () => {
  const bodyOf = (chunks: Buffer[]): IncomingMessage => {
    async function* generate(): AsyncGenerator<Buffer> {
      for (const chunk of chunks) yield chunk
    }
    return { [Symbol.asyncIterator]: generate } as unknown as IncomingMessage
  }
  assert.deepEqual(await readJsonBody(bodyOf([Buffer.from('{"ok":true}', 'utf8')]), 1024), { ok: true })
  await assert.rejects(
    readJsonBody(bodyOf([Buffer.from([0xc3, 0x28])]), 1024),
    error => error instanceof StrictUtf8Error && error.code === 'UTF8_INVALID',
  )
  await assert.rejects(
    readJsonBody(bodyOf([Buffer.from([0xef, 0xbb, 0xbf, 0x7b, 0x7d])]), 1024),
    error => error instanceof StrictUtf8Error && error.code === 'UTF8_BOM',
  )
})

test('state files with a BOM are quarantined instead of being decoded with U+FFFD', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-state-bom-'))
  const statePath = join(directory, 'state.json')
  await writeFile(statePath, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('{"schemaVersion": 2, "services": [], "runs": [], "operations": [], "permissionLeases": []}')]))
  const store = new RelayStateStore(statePath)
  assert.equal(await store.load(), null)
  assert.notEqual(store.recoveryWarning, null)
  await rm(directory, { recursive: true, force: true })
})

test('status and lock files are decoded strictly at the untrusted boundary', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-utf8-boundaries-'))
  const statusPath = join(directory, 'relay-status.json')
  const lockPath = join(directory, 'state.json.lock')
  await writeFile(statusPath, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('{}')]))
  await assert.rejects(new RelayStatusFacade(statusPath).read(), error => error instanceof StrictUtf8Error && error.code === 'UTF8_BOM')

  const locks = new FileLockFacade({ timeoutMs: 100, retryMs: 5 })
  await writeFile(lockPath, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('{"ownerToken":"x"}')]))
  await assert.rejects(locks.inspect(lockPath), error => error instanceof StrictUtf8Error && error.code === 'UTF8_BOM')
  await assert.rejects(locks.acquire(lockPath), error => error instanceof StrictUtf8Error && error.code === 'UTF8_BOM')
  await rm(directory, { recursive: true, force: true })
})
