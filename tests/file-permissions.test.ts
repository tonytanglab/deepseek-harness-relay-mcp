import assert from 'node:assert/strict'
import { access, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { TokenStoreFacade } from '../src/mcp-http/index.js'
import {
  currentUserPrincipal,
  FilePermissionError,
  NodeFilePermissionBackend,
  restrictPermissions,
  type FilePermissionBackend,
  type PermissionCommandRunner,
} from '../src/state-repository/index.js'
import { RelayStateStore } from '../src/state-store.js'

test('win32 backend restricts via a SID-scoped native ACL operation', async () => {
  const calls: Array<{ command: string; args: string[]; capture: boolean }> = []
  const run: PermissionCommandRunner = async (command, args, capture) => {
    calls.push({ command, args, capture })
    return { code: 0 }
  }
  const sid = 'S-1-5-21-1-2-3-1001'
  const backend = new NodeFilePermissionBackend({ platform: 'win32', run, windowsSid: sid })
  await backend.restrict('C:\\relay\\state.json')
  assert.deepEqual(calls, [{
    command: 'icacls.exe',
    args: ['C:\\relay\\state.json', '/inheritance:r', '/grant:r', `*${sid}:F`],
    capture: false,
  }])
})

test('non-win32 backend keeps mode 0600 and never swallows chmod failures', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-perms-posix-'))
  const path = join(directory, 'token')
  const backend = new NodeFilePermissionBackend({ platform: 'linux' })
  await writeFile(path, 'secret\n')
  await backend.restrict(path)
  if (process.platform !== 'win32') {
    assert.equal((await stat(path)).mode & 0o777, 0o600)
    assert.deepEqual(await backend.check(path), { restricted: true })
  }

  await assert.rejects(backend.restrict(join(directory, 'missing', 'file')), error => {
    assert.ok(error instanceof FilePermissionError)
    assert.equal(error.code, 'FILE_PERMISSION_FAILED')
    return true
  })
  await rm(directory, { recursive: true, force: true })
})

test('win32 backend propagates ACL failures and wraps runner errors', async () => {
  const rejecting: PermissionCommandRunner = async () => { throw new Error('PowerShell unavailable') }
  const failing: PermissionCommandRunner = async () => ({ code: 1 })
  const backend = new NodeFilePermissionBackend({ platform: 'win32', run: rejecting, windowsSid: 'S-1-5-21-1' })
  await assert.rejects(backend.restrict('C:\\relay\\state.json'), error => error instanceof FilePermissionError)
  const backendFailing = new NodeFilePermissionBackend({ platform: 'win32', run: failing, windowsSid: 'S-1-5-21-1' })
  await assert.rejects(backendFailing.restrict('C:\\relay\\state.json'), error => error instanceof FilePermissionError)
  assert.deepEqual(await backendFailing.check('C:\\relay\\state.json'), { restricted: false, detail: 'PowerShell exited with 1' })
})

test('win32 check consumes strict structured ACL inspection output', async () => {
  const inspection = (value: unknown): PermissionCommandRunner => async (_command, _args, capture) => ({
    code: 0,
    ...(capture ? { stdout: JSON.stringify(value) } : {}),
  })
  const backend = new NodeFilePermissionBackend({
    platform: 'win32',
    run: inspection({ restricted: false, detail: 'ACL is not current-user-only' }),
  })
  assert.deepEqual(await backend.check('D:\\relay\\state.json'), { restricted: false, detail: 'ACL is not current-user-only' })

  const ownOnly = new NodeFilePermissionBackend({
    platform: 'win32',
    run: inspection({ restricted: true, detail: null }),
  })
  assert.deepEqual(await ownOnly.check('D:\\relay\\state.json'), { restricted: true, detail: null })

  const malformed = new NodeFilePermissionBackend({
    platform: 'win32',
    run: inspection({ nope: true }),
  })
  assert.deepEqual(await malformed.check('D:\\relay\\state.json'), { restricted: false, detail: 'invalid ACL inspection output' })
})

test('win32 check preserves a structured missing-file diagnostic', async () => {
  const backend = new NodeFilePermissionBackend({
    platform: 'win32',
    run: async () => ({ code: 0, stdout: '{"restricted":false,"detail":"file does not exist"}' }),
  })
  assert.deepEqual(await backend.check('D:\\relay\\missing.json'), {
    restricted: false,
    detail: 'file does not exist',
  })
})

test('currentUserPrincipal prefers USERDOMAIN and falls back to the local hostname', () => {
  assert.equal(currentUserPrincipal({ USERDOMAIN: 'WORKGROUP' }, 'MYHOST', 'alice'), 'WORKGROUP\\alice')
  assert.equal(currentUserPrincipal({}, 'MYHOST', 'alice'), 'MYHOST\\alice')
})

test('real win32 backend applies and verifies a current-user-only ACL', { skip: process.platform !== 'win32' }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-perms-win32-'))
  const path = join(directory, 'secret.json')
  await writeFile(path, '{}\n', { encoding: 'utf8' })
  const backend = new NodeFilePermissionBackend()
  await backend.restrict(path)
  assert.deepEqual(await backend.check(path), { restricted: true, detail: null })
  await rm(directory, { recursive: true, force: true })
})

test('restrictPermissions uses the injected backend and propagates its failure', async () => {
  let restricted = ''
  const backend: FilePermissionBackend = {
    platform: 'linux',
    async restrict(path: string) { restricted = path },
    async check() { return { restricted: true } },
  }
  await restrictPermissions('C:\\state.json', backend)
  assert.equal(restricted, 'C:\\state.json')
  const failing: FilePermissionBackend = {
    platform: 'linux',
    async restrict() { throw new FilePermissionError('chmod 0600', 'C:\\state.json', 'boom') },
    async check() { return { restricted: true } },
  }
  await assert.rejects(restrictPermissions('C:\\state.json', failing), error => error instanceof FilePermissionError)
})

test('token store restricts the token file on create and on existing reads', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-token-perms-'))
  const tokenPath = join(directory, 'relay-token')
  const calls: string[] = []
  const backend: FilePermissionBackend = {
    platform: 'linux',
    async restrict(path: string) { calls.push(path) },
    async check() { return { restricted: true } },
  }
  const store = new TokenStoreFacade(backend)
  const created = await store.loadOrCreate({ tokenFile: tokenPath }, {})
  assert.equal(created.source, 'file')
  assert.equal(calls.length, 1)
  assert.equal(calls[0]!.startsWith(`${tokenPath}.`), true)
  assert.equal(calls[0]!.endsWith('.tmp'), true)
  await store.loadOrCreate({ tokenFile: tokenPath }, {})
  assert.equal(calls.length, 3, 'the raced temporary and existing token both receive a restricted ACL')
  await rm(directory, { recursive: true, force: true })
})

test('token store removes a newly created token when permission hardening fails', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-token-perms-fail-'))
  const tokenPath = join(directory, 'relay-token')
  const failing: FilePermissionBackend = {
    platform: 'win32',
    async restrict() { throw new FilePermissionError('apply ACL', tokenPath, 'denied') },
    async check() { return { restricted: false } },
  }
  await assert.rejects(new TokenStoreFacade(failing).loadOrCreate({ tokenFile: tokenPath }, {}), FilePermissionError)
  await assert.rejects(access(tokenPath))
  await rm(directory, { recursive: true, force: true })
})

test('RelayStateStore applies the injected backend to staged and lock files', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-state-perms-'))
  const statePath = join(directory, 'state.json')
  const calls: string[] = []
  const backend: FilePermissionBackend = {
    platform: 'linux',
    async restrict(path: string) { calls.push(path) },
    async check() { return { restricted: true } },
  }
  const store = new RelayStateStore(statePath, { permissions: backend, timeoutMs: 500, retryMs: 5 })
  await store.save({ schemaVersion: 2, services: [], runs: [], operations: [], permissionLeases: [] })
  assert.ok(calls.some(path => path.startsWith(statePath)), 'staged state file restricted before promotion')
  assert.ok(calls.some(path => path.startsWith(`${statePath}.lock.`) && path.endsWith('.tmp')), 'staged lock file restricted')
  const checks = await store.checkFilePermissions([statePath])
  assert.equal(checks.length, 1)
  assert.equal(checks[0]!.check.restricted, true)
  await rm(directory, { recursive: true, force: true })
})
