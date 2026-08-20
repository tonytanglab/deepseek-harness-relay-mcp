import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import test from 'node:test'
import {
  AuthorityAcquireCancelledError,
  AuthorityConflictError,
  AuthorityRegistryFacade,
  deriveAuthorityId,
  hostIdentityKey,
  normalizeHostIdentity,
  RelayEndpointPublisher,
  resolveAuthorityStatePaths,
} from '../src/authority/index.js'

test('normalizes loopback Host aliases and isolates embedded from standalone state', () => {
  const canonical = normalizeHostIdentity('http://localhost:3080/sessions?ignored=1')
  assert.equal(canonical, 'http://loopback:3080')
  assert.equal(normalizeHostIdentity('http://127.0.0.1:3080/'), canonical)
  assert.equal(normalizeHostIdentity('http://[::1]:3080/'), canonical)
  assert.equal(deriveAuthorityId('embedded', canonical), deriveAuthorityId('embedded', 'http://localhost:3080'))
  assert.notEqual(deriveAuthorityId('embedded', canonical), deriveAuthorityId('standalone', canonical))

  const embedded = resolveAuthorityStatePaths({ mode: 'embedded', hostIdentity: canonical, dshHome: 'C:\\dsh-home', profile: 'web' })
  const standalone = resolveAuthorityStatePaths({ mode: 'standalone', hostIdentity: canonical, userDataHome: 'C:\\user-data' })
  assert.notEqual(embedded.stateDirectory, standalone.stateDirectory)
  assert.match(embedded.stateDirectory, /plugins[\\/]dsh-relay[\\/]web/u)
  assert.match(standalone.stateDirectory, /dsh-relay[\\/]standalone/u)
})

test('same Host rejects a second authority and permits exact owner reuse only', async () => {
  const registryDirectory = await mkdtemp(join(tmpdir(), 'dsh-relay-authority-'))
  const firstRegistry = new AuthorityRegistryFacade({
    processId: 101,
    processStartedAt: '2026-08-19T00:00:00.000Z',
    processProbe: () => 'alive',
  })
  const firstInput = {
    registryDirectory,
    authorityId: 'embedded-a', mode: 'embedded' as const, hostIdentity: 'http://localhost:3080',
    instanceId: 'instance-a', ownerToken: 'owner-a',
  }
  const first = await firstRegistry.acquire(firstInput)
  const reused = await firstRegistry.acquire(firstInput)
  assert.equal(reused.reused, true)
  assert.equal(reused.record.epoch, first.record.epoch)

  const secondRegistry = new AuthorityRegistryFacade({
    processId: 202,
    processStartedAt: '2026-08-19T00:01:00.000Z',
    processProbe: () => 'alive',
  })
  await assert.rejects(
    secondRegistry.acquire({
      registryDirectory,
      authorityId: 'standalone-b', mode: 'standalone', hostIdentity: 'http://127.0.0.1:3080', instanceId: 'instance-b',
    }),
    (error: unknown) => error instanceof AuthorityConflictError && error.code === 'AUTHORITY_OWNED' && error.owner?.mode === 'embedded',
  )
  assert.equal(await reused.release(), false)
  assert.equal(await first.release(), true)
  await rm(registryDirectory, { recursive: true, force: true })
})

test('dead owner requires explicit recovery, increments epoch, and fences the old lease', async () => {
  const registryDirectory = await mkdtemp(join(tmpdir(), 'dsh-relay-stale-authority-'))
  const oldRegistry = new AuthorityRegistryFacade({
    processId: 303, processStartedAt: '2026-08-19T00:00:00.000Z', processProbe: () => 'dead',
  })
  const oldLease = await oldRegistry.acquire({
    registryDirectory, authorityId: 'embedded-old', mode: 'embedded', hostIdentity: 'http://localhost:3080',
    instanceId: 'instance-old', ownerToken: 'old-token',
  })
  const replacementRegistry = new AuthorityRegistryFacade({
    processId: 404, processStartedAt: '2026-08-19T00:10:00.000Z', processProbe: () => 'dead',
  })
  const replacementInput = {
    registryDirectory, authorityId: 'embedded-new', mode: 'embedded' as const, hostIdentity: 'http://localhost:3080', instanceId: 'instance-new',
  }
  await assert.rejects(
    replacementRegistry.acquire(replacementInput),
    (error: unknown) => error instanceof AuthorityConflictError && error.code === 'AUTHORITY_STALE_OWNER',
  )
  const replacement = await replacementRegistry.acquire({ ...replacementInput, recoverStale: true })
  assert.equal(replacement.record.epoch, oldLease.record.epoch + 1)
  assert.equal(await oldLease.release(), false)
  assert.equal(await replacement.release(), true)
  await rm(registryDirectory, { recursive: true, force: true })
})

test('PID reuse ambiguity remains fail closed while the PID is alive', async () => {
  const registryDirectory = await mkdtemp(join(tmpdir(), 'dsh-relay-pid-reuse-'))
  const first = await new AuthorityRegistryFacade({
    processId: 505, processStartedAt: '2026-08-19T00:00:00.000Z', processProbe: () => 'alive',
  }).acquire({
    registryDirectory, authorityId: 'authority-old', mode: 'embedded', hostIdentity: 'http://localhost:3080', instanceId: 'old', ownerToken: 'old',
  })
  const reusedPidRegistry = new AuthorityRegistryFacade({
    processId: 505, processStartedAt: '2026-08-19T01:00:00.000Z', processProbe: () => 'alive',
  })
  await assert.rejects(
    reusedPidRegistry.acquire({
      registryDirectory, authorityId: 'authority-new', mode: 'standalone', hostIdentity: 'http://localhost:3080', instanceId: 'new', recoverStale: true,
    }),
    (error: unknown) => error instanceof AuthorityConflictError && error.code === 'AUTHORITY_OWNED',
  )
  assert.equal(await first.release(), true)
  await rm(registryDirectory, { recursive: true, force: true })
})

test('a guard abandoned during a process crash is recovered only after its PID is dead', async () => {
  const registryDirectory = await mkdtemp(join(tmpdir(), 'dsh-relay-stale-guard-'))
  const hostIdentity = normalizeHostIdentity('http://localhost:3080')
  const ownerPath = join(registryDirectory, `${hostIdentityKey(hostIdentity)}.owner.json`)
  await mkdir(registryDirectory, { recursive: true })
  await writeFile(`${ownerPath}.guard`, `${JSON.stringify({
    ownerToken: 'crashed-guard', processId: 999, processStartedAt: '2026-08-19T00:00:00.000Z',
  })}\n`, { encoding: 'utf8' })
  const registry = new AuthorityRegistryFacade({ processProbe: processId => processId === 999 ? 'dead' : 'alive' })
  const lease = await registry.acquire({
    registryDirectory, authorityId: 'authority-after-crash', mode: 'embedded', hostIdentity, instanceId: 'instance-after-crash',
  })
  assert.equal(lease.record.epoch, 1)
  assert.equal(await lease.release(), true)
  await rm(registryDirectory, { recursive: true, force: true })
})

test('malformed owner registry fails closed and is not overwritten', async () => {
  const registryDirectory = await mkdtemp(join(tmpdir(), 'dsh-relay-invalid-owner-'))
  const hostIdentity = normalizeHostIdentity('http://localhost:3080')
  const ownerPath = join(registryDirectory, `${hostIdentityKey(hostIdentity)}.owner.json`)
  await mkdir(registryDirectory, { recursive: true })
  await writeFile(ownerPath, '{invalid', { encoding: 'utf8' })
  const registry = new AuthorityRegistryFacade({ processProbe: () => 'dead' })
  await assert.rejects(
    registry.acquire({
      registryDirectory, authorityId: 'new-authority', mode: 'embedded', hostIdentity, instanceId: 'new-instance', recoverStale: true,
    }),
    (error: unknown) => error instanceof AuthorityConflictError && error.code === 'AUTHORITY_REGISTRY_INVALID',
  )
  assert.equal(await readFile(ownerPath, { encoding: 'utf8' }), '{invalid')
  await rm(registryDirectory, { recursive: true, force: true })
})

test('authority acquire retries live ownership with a bounded backoff and recovers after death', async () => {
  const registryDirectory = await mkdtemp(join(tmpdir(), 'dsh-relay-authority-retry-'))
  let probe: 'alive' | 'dead' | 'unknown' = 'alive'
  let clock = Date.parse('2026-08-19T01:00:00.000Z')
  const first = await new AuthorityRegistryFacade({
    processId: 606,
    processStartedAt: '2026-08-19T00:00:00.000Z',
    processProbe: () => 'alive',
  }).acquire({
    registryDirectory,
    authorityId: 'old',
    mode: 'embedded',
    hostIdentity: 'http://localhost:3080',
    instanceId: 'old-instance',
    ownerToken: 'old-token',
  })
  const waits: number[] = []
  const replacement = new AuthorityRegistryFacade({
    processId: 607,
    processStartedAt: '2026-08-19T01:00:00.000Z',
    now: () => new Date(clock),
    processProbe: () => probe,
    sleep: async milliseconds => {
      waits.push(milliseconds)
      clock += milliseconds
      if (waits.length === 2) probe = 'dead'
    },
    random: () => 0,
  })
  const recovered = await replacement.acquireWithRetry({
    registryDirectory,
    authorityId: 'new',
    mode: 'embedded',
    hostIdentity: 'http://localhost:3080',
    instanceId: 'new-instance',
    recoverStale: true,
  }, { budgetMs: 1_000, initialDelayMs: 10, maxDelayMs: 40, jitterMs: 0 })
  assert.deepEqual(waits, [10, 20])
  assert.equal(recovered.record.epoch, first.record.epoch + 1)
  assert.equal(await recovered.release(), true)
  await rm(registryDirectory, { recursive: true, force: true })
})

test('authority acquire retry times out live or unknown owners with structured ownership details', async () => {
  const registryDirectory = await mkdtemp(join(tmpdir(), 'dsh-relay-authority-retry-timeout-'))
  const first = await new AuthorityRegistryFacade({
    processId: 608,
    processStartedAt: '2026-08-19T00:00:00.000Z',
    processProbe: () => 'alive',
  }).acquire({
    registryDirectory,
    authorityId: 'old',
    mode: 'embedded',
    hostIdentity: 'http://localhost:3080',
    instanceId: 'old-instance',
    ownerToken: 'old-token',
  })
  let clock = Date.parse('2026-08-19T01:00:00.000Z')
  const replacement = new AuthorityRegistryFacade({
    processId: 609,
    processStartedAt: '2026-08-19T01:00:00.000Z',
    now: () => new Date(clock),
    processProbe: () => 'unknown',
    sleep: async milliseconds => { clock += milliseconds },
    random: () => 0,
  })
  await assert.rejects(
    replacement.acquireWithRetry({
      registryDirectory,
      authorityId: 'new',
      mode: 'embedded',
      hostIdentity: 'http://localhost:3080',
      instanceId: 'new-instance',
      recoverStale: true,
    }, { budgetMs: 25, initialDelayMs: 10, maxDelayMs: 10, jitterMs: 0 }),
    (error: unknown) => error instanceof AuthorityConflictError
      && error.code === 'AUTHORITY_OWNED'
      && error.message.includes('PID 608')
      && error.message.includes('epoch 1')
      && error.message.includes('25ms retry budget'),
  )
  assert.equal(await first.release(), true)
  await rm(registryDirectory, { recursive: true, force: true })
})

test('authority acquire retry cancels promptly while sleeping', async () => {
  const registryDirectory = await mkdtemp(join(tmpdir(), 'dsh-relay-authority-retry-cancel-'))
  const first = await new AuthorityRegistryFacade({
    processId: 610,
    processStartedAt: '2026-08-19T00:00:00.000Z',
    processProbe: () => 'alive',
  }).acquire({
    registryDirectory,
    authorityId: 'old',
    mode: 'embedded',
    hostIdentity: 'http://localhost:3080',
    instanceId: 'old-instance',
    ownerToken: 'old-token',
  })
  const controller = new AbortController()
  let sleeping = false
  const replacement = new AuthorityRegistryFacade({
    processId: 611,
    processStartedAt: '2026-08-19T01:00:00.000Z',
    processProbe: () => 'alive',
    sleep: async (_milliseconds, signal) => {
      sleeping = true
      await new Promise<void>((resolve, reject) => {
        signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
        signal?.addEventListener('abort', () => resolve(), { once: true })
      })
    },
    random: () => 0,
  })
  const attempt = replacement.acquireWithRetry({
    registryDirectory,
    authorityId: 'new',
    mode: 'embedded',
    hostIdentity: 'http://localhost:3080',
    instanceId: 'new-instance',
    recoverStale: true,
  }, { signal: controller.signal, budgetMs: 1_000, initialDelayMs: 10, jitterMs: 0 })
  while (!sleeping) await new Promise(resolve => setImmediate(resolve))
  controller.abort()
  await assert.rejects(attempt, (error: unknown) => error instanceof AuthorityAcquireCancelledError)
  assert.equal(await first.release(), true)
  await rm(registryDirectory, { recursive: true, force: true })
})

test('endpoint descriptor is atomic, strict, and never contains bearer token material', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-relay-endpoint-'))
  const path = join(directory, 'relay-endpoint.json')
  const publisher = new RelayEndpointPublisher(path)
  await publisher.publish({
    authorityId: 'authority-a', mode: 'embedded', mcpUrl: 'http://127.0.0.1:3080/plugins/dsh-relay/mcp',
    tokenFilePath: join(directory, 'relay-token'), hostWebUrl: 'http://127.0.0.1:3080/', ownerEpoch: 7,
    updatedAt: '2026-08-19T00:00:00.000Z',
  })
  const text = await readFile(path, { encoding: 'utf8' })
  const raw = JSON.parse(text) as Record<string, unknown>
  assert.deepEqual(Object.keys(raw).sort(), [
    'authorityId', 'hostWebUrl', 'mcpUrl', 'mode', 'ownerEpoch', 'schemaVersion', 'tokenFilePath', 'updatedAt',
  ])
  assert.equal('token' in raw, false)
  assert.equal(text.includes('super-secret-token'), false)
  assert.equal((await publisher.read())?.ownerEpoch, 7)
  await rm(directory, { recursive: true, force: true })
})

test('separate processes cannot both own one Host authority', async () => {
  const registryDirectory = await mkdtemp(join(tmpdir(), 'dsh-relay-authority-process-'))
  const results = await Promise.all([
    runAuthorityWorker(registryDirectory, 'embedded-a', 'embedded'),
    runAuthorityWorker(registryDirectory, 'standalone-b', 'standalone'),
  ])
  assert.equal(results.filter(result => result === 'acquired').length, 1)
  assert.equal(results.filter(result => result === 'AUTHORITY_OWNED').length, 1)
  await rm(registryDirectory, { recursive: true, force: true })
})

test('a crashed process leaves a stale owner that only explicit recovery can replace', async () => {
  const registryDirectory = await mkdtemp(join(tmpdir(), 'dsh-relay-authority-crash-'))
  assert.equal(await runCrashWorker(registryDirectory), 'acquired')
  const registry = new AuthorityRegistryFacade()
  const input = {
    registryDirectory, authorityId: 'recovery', mode: 'embedded' as const,
    hostIdentity: 'http://localhost:3080', instanceId: 'replacement',
  }
  await assert.rejects(registry.acquire(input), (error: unknown) => error instanceof AuthorityConflictError && error.code === 'AUTHORITY_STALE_OWNER')
  const recovered = await registry.acquire({ ...input, recoverStale: true })
  assert.equal(recovered.record.epoch, 2)
  await recovered.release()
  await rm(registryDirectory, { recursive: true, force: true })
})

test('authority and state-repository internals are consumed only through module indexes', async () => {
  const sourceRoot = new URL('../src/', import.meta.url)
  const violations: string[] = []
  for (const file of await sourceFiles(sourceRoot)) {
    const relativePath = relative(sourceRoot.pathname, file.pathname).replaceAll('\\', '/')
    const source = await readFile(file, { encoding: 'utf8' })
    for (const moduleName of ['authority', 'state-repository']) {
      if (relativePath.startsWith(`${moduleName}/`)) continue
      const internalImport = new RegExp(`from ['\"](?:\\.\\./)+${moduleName}/(?!index\\.js)[^'\"]+['\"]`, 'gu')
      if (internalImport.test(source)) violations.push(`${relativePath} imports ${moduleName} internals`)
    }
  }
  assert.deepEqual(violations, [])
})

const workerSource = String.raw`
  import { AuthorityRegistryFacade } from './src/authority/index.ts'
  const [registryDirectory, authorityId, mode, hold] = process.argv.slice(1)
  try {
    const lease = await new AuthorityRegistryFacade().acquire({
      registryDirectory, authorityId, mode, hostIdentity: 'http://localhost:3080', instanceId: authorityId,
    })
    process.stdout.write('acquired')
    if (hold === 'true') {
      await new Promise(resolve => setTimeout(resolve, 800))
      await lease.release()
    }
  } catch (error) {
    process.stdout.write(error && typeof error === 'object' && 'code' in error ? String(error.code) : 'error')
  }
`

function runAuthorityWorker(registryDirectory: string, authorityId: string, mode: 'embedded' | 'standalone'): Promise<string> {
  return runWorker([registryDirectory, authorityId, mode, 'true'])
}

function runCrashWorker(registryDirectory: string): Promise<string> {
  return runWorker([registryDirectory, 'crashed', 'embedded', 'false'])
}

function runWorker(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', workerSource, ...args], {
      cwd: process.cwd(), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', chunk => { stdout += String(chunk) })
    child.stderr.on('data', chunk => { stderr += String(chunk) })
    child.once('error', reject)
    child.once('close', code => code === 0 ? resolve(stdout) : reject(new Error(`authority worker exited ${code}: ${stderr}`)))
  })
}

async function sourceFiles(directory: URL): Promise<URL[]> {
  const files: URL[] = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const child = new URL(`${entry.name}${entry.isDirectory() ? '/' : ''}`, directory)
    if (entry.isDirectory()) files.push(...await sourceFiles(child))
    else if (entry.name.endsWith('.ts')) files.push(child)
  }
  return files
}
