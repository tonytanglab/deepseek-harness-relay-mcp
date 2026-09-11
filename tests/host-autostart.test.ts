import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { type TestContext } from 'node:test'
import type { RelayHostLauncher, RelayStatusDocument } from '../src/relay-runtime/index.js'
import { FileLockFacade, type FilePermissionBackend } from '../src/state-repository/index.js'
import {
  backgroundSpawnOptions,
  HarnessHostAutostartFacade,
  type HarnessHostAutostartDependencies,
  type ProxyInspection,
} from '../src/stdio-proxy/index.js'

const permissions: FilePermissionBackend = {
  platform: process.platform,
  async restrict() {},
  async check() { return { restricted: true, detail: 'test' } },
}

test('auto-start launches one recorded Harness Web when the old owner is dead and the port is free', async t => {
  const root = await temporaryDirectory(t)
  let launches = 0
  let ready = false
  const launcher = testLauncher(root)
  const dead = inspection(root, launcher, false)
  const recovered = inspection(root, launcher, true)
  const facade = createFacade(root, {
    async spawnHost(actual) {
      launches += 1
      assert.deepEqual(actual, launcher)
      ready = true
    },
    async probePort() { return 'free' },
  })

  const result = await facade.recover(dead, async () => ready ? recovered : dead)

  assert.equal(result.failure, null)
  assert.equal(launches, 1)
})

test('auto-start replays a recorded tsx ESM source launcher vector', async t => {
  const root = await temporaryDirectory(t)
  let launched: RelayHostLauncher | null = null
  let ready = false
  const launcher = sourceLauncher(root, true)
  const dead = inspection(root, launcher, false)
  const recovered = inspection(root, launcher, true)
  const facade = createFacade(root, {
    async spawnHost(actual) {
      launched = actual
      ready = true
    },
    async probePort() { return 'free' },
  })

  const result = await facade.recover(dead, async () => ready ? recovered : dead)

  assert.equal(result.failure, null)
  assert.deepEqual(launched, launcher)
})

test('Windows background launch hides the console without requesting a detached console', async t => {
  const root = await temporaryDirectory(t)
  const options = backgroundSpawnOptions(testLauncher(root), 'win32')

  assert.equal(options.windowsHide, true)
  assert.equal(options.detached, false)
  assert.equal(options.stdio, 'ignore')
})

test('POSIX background launch remains detached', async t => {
  const root = await temporaryDirectory(t)
  const options = backgroundSpawnOptions(testLauncher(root), 'linux')

  assert.equal(options.windowsHide, true)
  assert.equal(options.detached, true)
  assert.equal(options.stdio, 'ignore')
})

test('auto-start rejects a raw Node source launcher contract without spawning', async t => {
  const root = await temporaryDirectory(t)
  let launches = 0
  const dead = inspection(root, sourceLauncher(root, false), false)
  const facade = createFacade(root, {
    async spawnHost() { launches += 1 },
    async probePort() { return 'free' },
  })

  const result = await facade.recover(dead, async () => dead)

  assert.equal(result.failure?.reasonCode, 'HOST_AUTO_START_UNAVAILABLE')
  assert.match(result.failure?.message ?? '', /failed strict validation/iu)
  assert.equal(launches, 0)
})

test('auto-start fails closed without spawning when the Harness loopback port is occupied', async t => {
  const root = await temporaryDirectory(t)
  let launches = 0
  let clock = 0
  const dead = inspection(root, testLauncher(root), false)
  const facade = createFacade(root, {
    async spawnHost() { launches += 1 },
    async probePort() { return 'occupied' },
    now: () => clock,
    async delay(timeoutMs) { clock += timeoutMs },
  }, 500)

  const result = await facade.recover(dead, async () => dead)

  assert.equal(result.failure?.reasonCode, 'HOST_AUTO_START_BLOCKED')
  assert.equal(launches, 0)
})

test('cross-process start lock lets concurrent proxies launch only one Harness Web instance', async t => {
  const root = await temporaryDirectory(t)
  let launches = 0
  let ready = false
  const launcher = testLauncher(root)
  const dead = inspection(root, launcher, false)
  const recovered = inspection(root, launcher, true)
  const dependencies: HarnessHostAutostartDependencies = {
    async spawnHost() {
      launches += 1
      await new Promise(resolve => setTimeout(resolve, 25))
      ready = true
    },
    async probePort() { return 'free' },
    async accessPath() {},
    lockFactory: () => new FileLockFacade({ timeoutMs: 2_000, retryMs: 5, permissions }),
  }
  const first = new HarnessHostAutostartFacade(join(root, 'relay-endpoint.json'), join(root, 'relay-status.json'), 2_000, dependencies)
  const second = new HarnessHostAutostartFacade(join(root, 'relay-endpoint.json'), join(root, 'relay-status.json'), 2_000, dependencies)
  const inspect = async (): Promise<ProxyInspection> => ready ? recovered : dead

  const results = await Promise.all([first.recover(dead, inspect), second.recover(dead, inspect)])

  assert.equal(launches, 1)
  assert.ok(results.every(result => result.failure === null))
})

function createFacade(
  root: string,
  dependencies: HarnessHostAutostartDependencies,
  timeoutMs = 1_000,
): HarnessHostAutostartFacade {
  return new HarnessHostAutostartFacade(
    join(root, 'relay-endpoint.json'),
    join(root, 'relay-status.json'),
    timeoutMs,
    {
      async accessPath() {},
      lockFactory: () => new FileLockFacade({ timeoutMs: 2_000, retryMs: 5, permissions }),
      ...dependencies,
    },
  )
}

function testLauncher(root: string): RelayHostLauncher {
  return {
    command: process.execPath,
    args: [join(root, 'apps', 'cli', 'lib', 'bin.js'), '--profile', 'web', '--no-open'],
    cwd: root,
    environment: {
      DSH_HOME: root,
      DSH_PROFILE: 'web',
      DSH_RELAY_ENDPOINT_DESCRIPTOR: join(root, 'relay-endpoint.json'),
    },
  }
}

function sourceLauncher(root: string, includeLoader: boolean): RelayHostLauncher {
  const entry = join(root, 'apps', 'cli', 'src', 'bin.ts')
  return {
    command: process.execPath,
    args: [...(includeLoader ? ['--import', 'tsx/esm'] : []), entry, '--profile', 'web', '--no-open'],
    cwd: root,
    environment: {
      DSH_HOME: root,
      DSH_PROFILE: 'web',
      DSH_RELAY_ENDPOINT_DESCRIPTOR: join(root, 'relay-endpoint.json'),
    },
  }
}

function inspection(root: string, launcher: RelayHostLauncher, ready: boolean): ProxyInspection {
  const status: RelayStatusDocument = {
    schemaVersion: 1,
    state: 'ready',
    authorityId: 'embedded-test',
    mode: 'embedded',
    instanceId: 'embedded-test',
    ownerPid: ready ? process.pid : 2_147_483_647,
    processStartedAt: '2026-09-01T00:00:00.000Z',
    ownerEpoch: 1,
    hostIdentity: 'http://loopback:3080',
    profile: 'web',
    dshHome: root,
    launcher,
    updatedAt: '2026-09-01T00:00:00.000Z',
    lastError: null,
  }
  return {
    status,
    descriptor: null,
    token: null,
    tokenFile: { exists: false, readable: false, valid: false },
    ownerProbe: { processId: status.ownerPid, state: ready ? 'alive' : 'dead' },
    failure: ready ? null : {
      code: 'RELAY_ROUTE_UNAVAILABLE',
      reasonCode: 'OWNER_DEAD',
      message: 'owner dead',
      retryable: true,
      remediation: 'recover',
    },
  }
}

async function temporaryDirectory(t: TestContext): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-relay-autostart-'))
  t.after(async () => { await rm(directory, { recursive: true, force: true }) })
  return directory
}
