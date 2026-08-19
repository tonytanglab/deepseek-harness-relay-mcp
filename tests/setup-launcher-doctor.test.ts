import assert from 'node:assert/strict'
import test from 'node:test'
import { ClientSetupFacade, StdioLauncherPlanner } from '../src/setup/index.js'

test('keeps absolute paths with spaces as separate stdio argv fields', () => {
  const result = new StdioLauncherPlanner().plan({
    platform: 'win32',
    nodeExecutable: 'C:\\Program Files\\nodejs\\node.exe',
    relayEntry: 'C:\\Program Files\\DSH Relay\\dist\\dsh-relay.mjs',
  })
  assert.deepEqual(result.launcher, {
    transport: 'stdio',
    command: 'C:\\Program Files\\nodejs\\node.exe',
    args: ['C:\\Program Files\\DSH Relay\\dist\\dsh-relay.mjs'],
    environment: {},
    resolution: 'absolute-node',
  })
})

test('rejects pnpm.exe and pnpm.cmd as the Node ESM runtime', () => {
  for (const executable of ['C:\\Users\\Ada\\AppData\\Roaming\\pnpm\\pnpm.exe', 'C:\\tools\\pnpm.cmd']) {
    const result = new StdioLauncherPlanner().plan({
      platform: 'win32',
      nodeExecutable: executable,
      relayEntry: 'C:\\relay\\dist\\dsh-relay.mjs',
    })
    assert.equal(result.launcher, undefined)
    assert.equal(result.issues.some(issue => issue.code === 'LAUNCHER_NOT_NODE'), true)
  }
})

test('rejects relative runtime and package entry paths', () => {
  const result = new StdioLauncherPlanner().plan({
    platform: 'linux',
    nodeExecutable: 'node',
    relayEntry: './dist/dsh-relay.mjs',
  })
  assert.equal(result.launcher, undefined)
  assert.deepEqual(result.issues.map(issue => issue.code), [
    'LAUNCHER_NODE_NOT_ABSOLUTE',
    'LAUNCHER_ENTRY_NOT_ABSOLUTE',
  ])
})

test('plans a macOS launcher without relying on a GUI process PATH', () => {
  const result = new StdioLauncherPlanner().plan({
    platform: 'darwin',
    nodeExecutable: '/opt/homebrew/bin/node',
    relayEntry: '/Applications/DSH Relay/dist/dsh-relay.mjs',
  })
  assert.equal(result.issues.length, 0)
  assert.equal(result.launcher?.command, '/opt/homebrew/bin/node')
  assert.deepEqual(result.launcher?.args, ['/Applications/DSH Relay/dist/dsh-relay.mjs'])
})

test('doctor is machine-readable and healthy only when every supplied probe passes', () => {
  const facade = new ClientSetupFacade()
  const report = facade.doctor({
    setup: setupRequest(),
    facts: {
      nodeExecutableExists: true,
      relayEntryExists: true,
      configParentWritable: true,
      brokerReachable: true,
      hostReachable: true,
      workspaceExists: true,
      modelAvailable: true,
      permissionAvailable: true,
      targetWebProfile: true,
      bundleInstalled: true,
      httpRouteReachable: true,
      tokenFileSecure: true,
      authorityOwnerHealthy: true,
      recursiveConfigurationAbsent: true,
    },
  })
  assert.equal(report.status, 'healthy')
  assert.equal(report.schemaVersion, 1)
  assert.doesNotThrow(() => JSON.parse(JSON.stringify(report)))
})

test('doctor distinguishes absent probes from failed probes without performing I/O', () => {
  const facade = new ClientSetupFacade()
  const skipped = facade.doctor({ setup: setupRequest() })
  assert.equal(skipped.status, 'degraded')
  assert.equal(skipped.checks.filter(check => check.status === 'skipped').length, 14)

  const failed = facade.doctor({ setup: setupRequest(), facts: { hostReachable: false } })
  assert.equal(failed.status, 'blocked')
  assert.equal(failed.checks.find(check => check.id === 'host')?.status, 'fail')
})

function setupRequest() {
  return {
    client: 'cursor' as const,
    scope: 'project' as const,
    platform: 'linux' as const,
    homeDirectory: '/home/ada',
    workspaceDirectory: '/work/demo',
    launcher: {
      platform: 'linux' as const,
      nodeExecutable: '/usr/bin/node',
      relayEntry: '/opt/dsh-relay/dist/dsh-relay.mjs',
    },
  }
}
