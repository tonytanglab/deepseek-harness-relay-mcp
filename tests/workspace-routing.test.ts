import assert from 'node:assert/strict'
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import test, { type TestContext } from 'node:test'
import { resolveConfig } from '../src/config.js'
import { RelayFacade } from '../src/relay-broker/index.js'
import type { WorkspaceView } from '../src/workspace-routing/index.js'

test('registry policy allows a registered workspace outside Host cwd without creating it', async t => {
  const fixture = await workspaceFixture(t)
  let creates = 0
  const relay = new RelayFacade(config(fixture.stateFile), host(async request => {
    if (request.method === 'host.describe') return { cwd: fixture.host }
    if (request.method === 'workspace.list') {
      return { items: [view(`${fixture.project}${sep}`)], archivedSessionIds: ['archived-1'] }
    }
    if (request.method === 'workspace.create') {
      creates += 1
      throw new Error('registered workspace must not be created again')
    }
    throw new Error(`unexpected method: ${request.method}`)
  }))

  const service = await relay.startService({ workspace: fixture.project })
  const report = await relay.doctor() as {
    workspacePolicy: {
      mode: string
      roots: string[]
      registered: Array<{ path: string; sessionCount: number }>
      archivedSessionIds: string[]
    }
  }

  assert.equal(service.workspaceId, 'workspace-project')
  assert.equal(service.workspace, `${fixture.project}${sep}`)
  assert.equal(creates, 0)
  assert.equal(report.workspacePolicy.mode, 'harness-registry')
  assert.deepEqual(report.workspacePolicy.roots, [])
  assert.deepEqual(report.workspacePolicy.registered, [{
    workspaceId: 'workspace-project',
    path: `${fixture.project}${sep}`,
    title: 'project',
    sessionCount: 1,
  }])
  assert.deepEqual(report.workspacePolicy.archivedSessionIds, ['archived-1'])
})

test('registry policy rejects an unregistered workspace', async t => {
  const fixture = await workspaceFixture(t)
  const relay = new RelayFacade(config(fixture.stateFile), host(async request => {
    if (request.method === 'workspace.list') return { items: [], archivedSessionIds: [] }
    throw new Error(`unexpected method: ${request.method}`)
  }))

  await assert.rejects(
    relay.startService({ workspace: fixture.project }),
    /workspace is not registered in Harness/iu,
  )
})

test('configured roots remain a strict boundary even for registered workspaces', async t => {
  const fixture = await workspaceFixture(t)
  const relay = new RelayFacade(config(fixture.stateFile, fixture.host), host(async request => {
    if (request.method === 'workspace.list') {
      return { items: [view(fixture.project)], archivedSessionIds: [] }
    }
    throw new Error(`unexpected method: ${request.method}`)
  }))

  await assert.rejects(
    relay.startService({ workspace: fixture.project }),
    /outside DSH_RELAY_ALLOWED_WORKSPACE_ROOTS/iu,
  )
})

test('configured roots allow creating an unregistered workspace', async t => {
  const fixture = await workspaceFixture(t)
  let creates = 0
  const relay = new RelayFacade(config(fixture.stateFile, fixture.project), host(async request => {
    if (request.method === 'workspace.list') return { items: [], archivedSessionIds: [] }
    if (request.method === 'host.describe') return { cwd: fixture.host }
    if (request.method === 'workspace.create') {
      creates += 1
      assert.deepEqual(request.payload, { path: fixture.project })
      return { workspace: view(fixture.project), created: true }
    }
    throw new Error(`unexpected method: ${request.method}`)
  }))

  const service = await relay.startService({ workspace: fixture.project })

  assert.equal(service.workspaceId, 'workspace-project')
  assert.equal(service.workspace, fixture.project)
  assert.equal(creates, 1)
})

interface Request {
  method: string
  payload: Record<string, unknown>
  rpcId: string
}

function host(handler: (request: Request) => Promise<unknown>): typeof fetch {
  return async (_input, init) => {
    const request = JSON.parse(String(init?.body)) as Request
    const value = await handler(request)
    return new Response(JSON.stringify({
      type: 'server-response',
      rpcId: request.rpcId,
      result: { ok: true, value },
    }), { status: 200, headers: { 'content-type': 'application/json' } })
  }
}

function config(stateFile: string, allowedRoot?: string) {
  return resolveConfig({
    DSH_RELAY_HOST_URL: 'http://127.0.0.1:3080/',
    DSH_RELAY_STATE_FILE: stateFile,
    ...(allowedRoot === undefined ? {} : { DSH_RELAY_ALLOWED_WORKSPACE_ROOTS: allowedRoot }),
  })
}

function view(path: string): WorkspaceView {
  return {
    workspaceId: 'workspace-project',
    path,
    title: 'project',
    sessionIds: ['session-1'],
    createdAt: '2026-08-19T00:00:00.000Z',
    updatedAt: '2026-08-19T00:00:00.000Z',
  }
}

async function workspaceFixture(t: TestContext): Promise<{
  host: string
  project: string
  stateFile: string
}> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-relay-routing-'))
  const host = join(root, 'host')
  const project = join(root, 'project')
  await Promise.all([mkdir(host), mkdir(project)])
  t.after(async () => { await rm(root, { recursive: true, force: true }) })
  return {
    host: await realpath(host),
    project: await realpath(project),
    stateFile: join(root, 'relay-state.json'),
  }
}
