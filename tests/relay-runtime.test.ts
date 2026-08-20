import assert from 'node:assert/strict'
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import test from 'node:test'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  RelayRuntimePathError,
  RelayStatusFacade,
  prepareRelayRuntimePaths,
  resolveRelayRuntimePaths,
} from '../src/relay-runtime/index.js'

test('shared runtime resolver defaults blank home/profile values and isolates host state', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-relay-runtime-home-'))
  const paths = resolveRelayRuntimePaths({
    mode: 'embedded',
    homeDirectory: home,
    env: { DSH_HOME: '  ', DSH_PROFILE: '  ' },
    hostIdentity: 'http://localhost:3080',
  })
  assert.equal(paths.dshHome, join(home, '.dsh'))
  assert.equal(paths.dshHomeSource, 'default')
  assert.equal(paths.profile, 'web')
  assert.equal(paths.profileSource, 'default')
  assert.match(paths.stateDirectory, /plugins[\\/]dsh-relay[\\/]web[\\/]/u)
  assert.match(paths.stateFile, /state\.json$/u)
  assert.match(paths.statusFile, /relay-status\.json$/u)
  await rm(home, { recursive: true, force: true })
})

test('shared runtime resolver honors explicit home/profile, state, token, and endpoint paths', () => {
  const paths = resolveRelayRuntimePaths({
    mode: 'embedded',
    homeDirectory: 'C:\\default-home',
    env: {
      DSH_HOME: 'C:\\explicit-home',
      DSH_PROFILE: 'web-preview',
      DSH_RELAY_ENDPOINT_DESCRIPTOR: 'C:\\environment-endpoint.json',
    },
    hostIdentity: 'http://localhost:3080',
    stateDirectory: 'C:\\explicit-state',
    tokenFile: 'C:\\explicit-token',
    endpointDescriptorFile: 'C:\\explicit-endpoint.json',
  })
  assert.equal(paths.dshHome, 'C:\\explicit-home')
  assert.equal(paths.dshHomeSource, 'environment')
  assert.equal(paths.profile, 'web-preview')
  assert.equal(paths.profileSource, 'environment')
  assert.equal(paths.stateDirectory, 'C:\\explicit-state')
  assert.equal(paths.tokenFile, 'C:\\explicit-token')
  assert.equal(paths.endpointDescriptorFile, 'C:\\explicit-endpoint.json')
  assert.equal(paths.endpointDescriptorSource, 'explicit')
  assert.equal(paths.statusFile, 'C:\\relay-status.json')
})

test('shared runtime resolver reports structured invalid profile and blank overrides', () => {
  assert.throws(
    () => resolveRelayRuntimePaths({ mode: 'embedded', env: { DSH_PROFILE: '../web' } }),
    (error: unknown) => error instanceof RelayRuntimePathError
      && error.code === 'RELAY_PROFILE_INVALID'
      && error.source === 'DSH_PROFILE'
      && error.remediation.includes('profile name'),
  )
  assert.throws(
    () => resolveRelayRuntimePaths({ mode: 'embedded', stateDirectory: '  ' }),
    (error: unknown) => error instanceof RelayRuntimePathError && error.code === 'RELAY_STATE_DIRECTORY_INVALID',
  )
  assert.throws(
    () => resolveRelayRuntimePaths({ mode: 'embedded', endpointDescriptorFile: '  ' }),
    (error: unknown) => error instanceof RelayRuntimePathError && error.code === 'RELAY_PATH_INVALID',
  )
})

test('runtime preparation creates only directories and fails closed when a parent is a file', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-relay-runtime-prepare-'))
  const paths = resolveRelayRuntimePaths({ mode: 'embedded', stateDirectory: join(directory, 'runtime') })
  await prepareRelayRuntimePaths(paths)
  await access(paths.stateDirectory)
  const blocked = join(directory, 'blocked')
  await writeFile(blocked, 'not a directory', { encoding: 'utf8' })
  const blockedPaths = resolveRelayRuntimePaths({ mode: 'embedded', stateDirectory: join(blocked, 'runtime') })
  await assert.rejects(
    prepareRelayRuntimePaths(blockedPaths),
    (error: unknown) => error instanceof RelayRuntimePathError && error.code === 'RELAY_PATH_INVALID',
  )
  await rm(directory, { recursive: true, force: true })
})

test('relay status v1 is atomic UTF-8, strict, lifecycle-ready, and credential-safe', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-relay-status-'))
  const path = join(directory, 'relay-status.json')
  const status = new RelayStatusFacade(path, () => new Date('2026-08-20T01:02:03.000Z'))
  const base = {
    authorityId: 'embedded-authority',
    mode: 'embedded' as const,
    instanceId: 'embedded-authority',
    ownerPid: 1234,
    processStartedAt: '2026-08-20T01:00:00.000Z',
    ownerEpoch: 4,
    hostIdentity: 'http://loopback:3080',
    profile: 'web',
    dshHome: 'C:\\Users\\tester\\.dsh',
  }
  const written = await status.write({
    ...base,
    state: 'failed',
    lastError: {
      code: 'AUTHENTICATION_FAILED',
      message: 'Bearer super-secret-token',
      remediation: 'Check token=super-secret-token and retry.',
    },
  })
  assert.equal(written.schemaVersion, 1)
  const text = await readFile(path, { encoding: 'utf8' })
  assert.equal(text.charCodeAt(0), '{'.charCodeAt(0))
  assert.equal(text.includes('super-secret-token'), false)
  assert.deepEqual(Object.keys(JSON.parse(text) as object).sort(), [
    'authorityId', 'dshHome', 'hostIdentity', 'instanceId', 'lastError', 'mode', 'ownerEpoch',
    'ownerPid', 'processStartedAt', 'profile', 'schemaVersion', 'state', 'updatedAt',
  ])
  assert.equal((await status.read())?.lastError?.message, 'Bearer [redacted]')
  await status.write({ ...base, state: 'ready', lastError: null })
  await status.write({ ...base, state: 'stopped', lastError: null })
  assert.equal((await status.read())?.state, 'stopped')
  await rm(directory, { recursive: true, force: true })
})
