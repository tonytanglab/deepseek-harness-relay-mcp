import assert from 'node:assert/strict'
import test from 'node:test'
import { ClientSetupFacade } from '../src/setup/index.js'
import type { ClientName, ClientScope, SetupRequest } from '../src/setup/index.js'

const facade = new ClientSetupFacade()

test('declares the verified scope matrix for all four clients', () => {
  const support = Object.fromEntries(facade.getScopeSupport().map(item => [item.client, item.supportedScopes]))
  assert.deepEqual(support, {
    codex: ['user'],
    claude: ['local', 'project', 'user'],
    cursor: ['project', 'user'],
    opencode: ['project', 'user'],
  })
})

test('rejects unsupported scopes before rendering a patch', () => {
  for (const [client, scope] of [
    ['codex', 'local'],
    ['codex', 'project'],
    ['cursor', 'local'],
    ['opencode', 'local'],
  ] as const) {
    const plan = facade.plan(request(client, scope))
    assert.equal(plan.ready, false)
    assert.equal(plan.patch, undefined)
    assert.equal(plan.issues.some(issue => issue.code === 'SCOPE_UNSUPPORTED'), true)
  }
})

test('renders Codex user TOML as a minimal structured upsert', () => {
  const plan = facade.plan(request('codex', 'user'))
  assert.equal(plan.ready, true)
  assert.equal(plan.writeAuthorized, false)
  assert.equal(plan.patch?.target.path, 'C:\\Users\\Ada\\.codex\\config.toml')
  assert.deepEqual(plan.patch?.target.selector, ['mcp_servers', 'harness-relay-mcp'])
  assert.match(plan.patch?.snippet ?? '', /^\[mcp_servers\."harness-relay-mcp"\]/)
  assert.match(plan.patch?.snippet ?? '', /C:\\\\Program Files\\\\nodejs\\\\node\.exe/)
})

test('maps all Claude scopes to their distinct official locations', () => {
  const local = facade.plan(request('claude', 'local'))
  const project = facade.plan(request('claude', 'project'))
  const user = facade.plan(request('claude', 'user'))

  assert.equal(local.patch?.target.path, 'C:\\Users\\Ada\\.claude.json')
  assert.deepEqual(local.patch?.target.selector, ['projects', 'D:\\work\\demo', 'mcpServers', 'harness-relay-mcp'])
  assert.equal(project.patch?.target.path, 'D:\\work\\demo\\.mcp.json')
  assert.deepEqual(project.patch?.target.selector, ['mcpServers', 'harness-relay-mcp'])
  assert.equal(user.patch?.target.path, 'C:\\Users\\Ada\\.claude.json')
  assert.equal(local.patch?.target.managedBy, 'client-cli')
})

test('maps Cursor user and project scopes without inventing a local scope', () => {
  const project = facade.plan(request('cursor', 'project'))
  const user = facade.plan(request('cursor', 'user'))
  assert.equal(project.patch?.target.path, 'D:\\work\\demo\\.cursor\\mcp.json')
  assert.equal(user.patch?.target.path, 'C:\\Users\\Ada\\.cursor\\mcp.json')
  assert.deepEqual(project.patch?.target.selector, ['mcpServers', 'harness-relay-mcp'])
})

test('renders OpenCode V2 mcp.servers with command array and environment', () => {
  const plan = facade.plan(request('opencode', 'project'))
  assert.equal(plan.ready, true)
  const snippet = JSON.parse(plan.patch?.snippet ?? '{}') as {
    mcp?: { servers?: Record<string, { command?: unknown; environment?: unknown; env?: unknown }> }
  }
  const server = snippet.mcp?.servers?.['harness-relay-mcp']
  assert.deepEqual(server?.command, [
    'C:\\Program Files\\nodejs\\node.exe',
    'C:\\Program Files\\DSH Relay\\dist\\dsh-relay.mjs',
  ])
  assert.deepEqual(server?.environment, { DSH_RELAY_HOST_URL: 'http://127.0.0.1:3080/' })
  assert.equal(server?.env, undefined)
  assert.equal(plan.patch?.target.dialect, 'opencode-v2')
})

test('detect reports an existing relay entry without mutating the snapshot', () => {
  const snapshot = { exists: true, readable: true, serverIds: ['other', 'harness-relay-mcp'] }
  const detection = facade.detect({
    client: 'cursor',
    scope: 'user',
    platform: 'win32',
    homeDirectory: 'C:\\Users\\Ada',
    snapshot,
  })
  assert.equal(detection.alreadyConfigured, true)
  assert.deepEqual(snapshot.serverIds, ['other', 'harness-relay-mcp'])
})

test('detect returns structured directory errors instead of guessing paths', () => {
  const detection = facade.detect({
    client: 'claude',
    scope: 'project',
    platform: 'linux',
    homeDirectory: 'home/ada',
  })
  assert.equal(detection.location, undefined)
  assert.deepEqual(detection.issues.map(issue => issue.code), ['HOME_NOT_ABSOLUTE', 'WORKSPACE_REQUIRED'])
})

test('validate rejects a manually altered relative launcher patch', () => {
  const patch = facade.plan(request('cursor', 'user')).patch
  assert.notEqual(patch, undefined)
  if (patch === undefined) return
  const result = facade.validate('cursor', {
    ...patch,
    value: { command: 'tools/node', args: ['dist/dsh-relay.mjs'] },
  })
  assert.equal(result.valid, false)
  assert.deepEqual(result.issues.map(issue => issue.code), ['PATCH_COMMAND_INVALID', 'PATCH_ARGS_INVALID'])
})

test('blocks a configuration and launcher platform mismatch', () => {
  const input = request('cursor', 'user')
  const plan = facade.plan({ ...input, launcher: { ...input.launcher, platform: 'linux' } })
  assert.equal(plan.ready, false)
  assert.equal(plan.patch, undefined)
  assert.equal(plan.issues.some(issue => issue.code === 'PLATFORM_MISMATCH'), true)
})

function request(client: ClientName, scope: ClientScope): SetupRequest {
  return {
    client,
    scope,
    platform: 'win32',
    homeDirectory: 'C:\\Users\\Ada',
    workspaceDirectory: 'D:\\work\\demo',
    launcher: {
      platform: 'win32',
      nodeExecutable: 'C:\\Program Files\\nodejs\\node.exe',
      relayEntry: 'C:\\Program Files\\DSH Relay\\dist\\dsh-relay.mjs',
      environment: { DSH_RELAY_HOST_URL: 'http://127.0.0.1:3080/' },
    },
  }
}
