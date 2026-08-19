import assert from 'node:assert/strict'
import test from 'node:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import type { RelayConfig } from '../src/config.js'
import type { RelayFacade } from '../src/relay-broker/index.js'
import { createServer } from '../src/server.js'
import type { RunSnapshot } from '../src/types.js'

test('exposes setup and monitoring Facades as read-only MCP tools', async () => {
  ;(globalThis as Record<string, unknown>).__DSH_RELAY_VERSION__ = 'test'
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const dispatched: Array<Record<string, unknown>> = []
  const relay = {
    async getRun(runId: string): Promise<RunSnapshot> {
      return snapshot(runId)
    },
    async listWorkspaces() {
      return {
        mode: 'harness-registry',
        roots: [],
        workspaces: [{ workspaceId: 'workspace-1', path: 'D:\\work\\demo', title: 'demo', sessionCount: 2 }],
      }
    },
    async listWorkspaceSessions() {
      return {
        workspace: { workspaceId: 'workspace-1', path: 'D:\\work\\demo', title: 'demo' },
        sessions: [],
      }
    },
    async startRun(input: Record<string, unknown>): Promise<RunSnapshot> {
      dispatched.push(input)
      return snapshot('5f502f03-3a5e-4e3d-9b18-373306961a79')
    },
  } as unknown as RelayFacade
  const server = createServer(relay, config())
  const client = new Client({ name: 'product-tools-test', version: '1.0.0' })
  await server.connect(serverTransport)
  await client.connect(clientTransport)
  try {
    const tools = await client.listTools()
    for (const name of [
      'setup_plan',
      'setup_doctor',
      'get_run_summary',
      'read_notifications',
      'list_workspaces',
      'list_workspace_sessions',
    ]) {
      const tool = tools.tools.find(item => item.name === name)
      assert.notEqual(tool, undefined)
      assert.equal(tool?.annotations?.readOnlyHint, true)
      assert.equal(tool?.annotations?.destructiveHint, false)
      assert.notEqual(tool?.outputSchema, undefined)
    }

    const setupPlan = await client.callTool({ name: 'setup_plan', arguments: setupArguments() })
    assert.equal((setupPlan.structuredContent as { ready?: boolean }).ready, true)
    assert.equal((setupPlan.structuredContent as { writeAuthorized?: boolean }).writeAuthorized, false)

    const setupDoctor = await client.callTool({
      name: 'setup_doctor',
      arguments: { ...setupArguments(), facts: { nodeExecutableExists: true, relayEntryExists: true } },
    })
    assert.equal((setupDoctor.structuredContent as { schemaVersion?: number }).schemaVersion, 1)

    const summary = await client.callTool({ name: 'get_run_summary', arguments: { runId: '5f502f03-3a5e-4e3d-9b18-373306961a79' } })
    assert.deepEqual(summary.structuredContent, {
      runId: '5f502f03-3a5e-4e3d-9b18-373306961a79',
      status: 'running',
      permissionMode: 'read-only',
      startedAt: '2026-08-19T00:00:00.000Z',
      updatedAt: '2026-08-19T00:00:00.000Z',
      nextAction: 'wait',
      elapsedMs: 0,
      provider: 'kimi-coding',
      model: 'k3',
      reasoningEffort: 'max',
    })

    const notifications = await client.callTool({ name: 'read_notifications', arguments: {} })
    assert.deepEqual(notifications.structuredContent, { notifications: [], nextCursor: '0' })

    const workspaces = await client.callTool({ name: 'list_workspaces', arguments: {} })
    assert.equal((workspaces.structuredContent as { mode?: string }).mode, 'harness-registry')
    const sessions = await client.callTool({ name: 'list_workspace_sessions', arguments: { workspace: 'D:\\work\\demo' } })
    assert.deepEqual((sessions.structuredContent as { sessions?: unknown[] }).sessions, [])

    await client.callTool({
      name: 'start_review',
      arguments: { workspace: 'D:\\work\\demo', task: 'review', sessionMode: 'latest-idle' },
    })
    assert.equal(dispatched[0]?.sessionMode, 'latest-idle')
    assert.equal(dispatched[0]?.permissionPreset, 'read-only')
  } finally {
    await client.close()
    await server.close()
  }
})

function setupArguments(): Record<string, unknown> {
  return {
    client: 'cursor',
    scope: 'project',
    platform: 'win32',
    homeDirectory: 'C:\\Users\\Ada',
    workspaceDirectory: 'D:\\work\\demo',
    nodeExecutable: 'C:\\Program Files\\nodejs\\node.exe',
    relayEntry: 'C:\\Program Files\\DSH Relay\\dist\\dsh-relay.mjs',
    endpointDescriptor: 'C:\\Users\\Ada\\.dsh\\profiles\\web\\dsh-relay\\relay-endpoint.json',
  }
}

function snapshot(runId: string): RunSnapshot {
  return {
    runId,
    serviceId: 'service-1',
    sessionId: 'session-1',
    sessionReused: false,
    parentRunId: null,
    workspace: 'D:\\work\\demo',
    webUrl: 'http://127.0.0.1:3080/?sessionId=session-1',
    status: 'running',
    modelSelection: { provider: 'kimi-coding', model: 'k3', reasoningEffort: 'max' },
    permissionPreset: 'read-only',
    agentPreset: null,
    modelDefaultRestore: 'not-needed',
    warnings: [],
    task: '',
    taskPersisted: false,
    taskImageCount: 0,
    cancelRequested: false,
    startedAt: '2026-08-19T00:00:00.000Z',
    finishedAt: null,
    promptAdmission: 'accepted',
    promptMessageId: 'message-1',
    assistantText: '',
    assistantTextBytes: 0,
    assistantTextTruncated: false,
    lastEventSeq: 1,
    error: null,
  }
}

function config(): RelayConfig {
  return {
    hostUrl: 'http://127.0.0.1:3080/',
    allowedWorkspaceRoots: [],
    rpcTimeoutMs: 30_000,
    pollIntervalMs: 750,
    maxTaskCharacters: 100_000,
    maxAssistantTextBytes: 256_000,
    maxImageBytes: 5 * 1024 * 1024,
    maxImagesPerMessage: 20,
    maxMessageImageBytes: 100 * 1024 * 1024,
    stateFile: 'D:\\state.json',
    persistPromptText: false,
    clientPrincipalId: 'test-client',
    permissionLeaseMs: 86_400_000,
    maxHistoryPages: 100,
    runStallMs: 300_000,
  }
}
