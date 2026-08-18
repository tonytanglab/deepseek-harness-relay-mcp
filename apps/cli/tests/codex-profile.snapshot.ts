import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { startMockLlmServer } from '@deepseek-ai/dsh-llm-mock-server'
import { describe, expect, it } from 'vitest'

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url))
const dshBin = join(repoRoot, 'apps/cli/lib/bin.js')

describe('dsh Codex profile keyless transcript', () => {
  it('exposes the stable tools, visible session link, result, live steering, and continuation', async () => {
    const mock = await startMockLlmServer({
      sequence: ['success', 'success', 'success', 'slow_success', 'success'],
      apiKey: 'codex-profile-snapshot',
      successText: 'visible MCP snapshot completed',
      chunkSize: 1,
      chunkDelayMs: 50,
    })
    const parent = mkdtempSync(join(tmpdir(), 'dsh-codex-snapshot-'))
    const workspace = join(parent, 'workspace')
    const environment = Object.fromEntries(Object.entries({
      ...process.env,
      DSH_HOME: join(parent, 'home'),
      DSH_MCP_WORKSPACE_ROOTS: parent,
      DSH_TELEMETRY_DISABLED: '1',
      DEEPSEEK_API_KEY: 'codex-profile-snapshot',
      DEEPSEEK_BASE_URL: mock.baseURL,
    }).filter((entry): entry is [string, string] => entry[1] !== undefined))
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [dshBin, '--profile', 'codex'],
      cwd: repoRoot,
      env: environment,
      stderr: 'pipe',
    })
    const client = new Client({ name: 'codex-profile-snapshot', version: '1.0.0' })
    try {
      mkdirSync(workspace, { recursive: true })
      await client.connect(transport)
      const tools = await client.listTools()
      const first = await client.callTool({
        name: 'start_run',
        arguments: { workspace, task: '/literal-snapshot-task' },
      })
      if (first.isError === true) throw new Error(JSON.stringify(first))
      const admitted = first.structuredContent as { runId: string; sessionId: string; webUrl: string }
      const completed = await terminalRun(client, admitted.runId)
      const continued = await client.callTool({
        name: 'start_run',
        arguments: { workspace, task: 'continue the snapshot', sessionId: admitted.sessionId },
      })
      if (continued.isError === true) throw new Error(JSON.stringify(continued))
      const continuedRun = continued.structuredContent as { runId: string }
      const continuedCompleted = await terminalRun(client, continuedRun.runId)
      const held = await client.callTool({
        name: 'start_run',
        arguments: { workspace, task: 'wait for snapshot correction', sessionId: admitted.sessionId },
      })
      if (held.isError === true) throw new Error(JSON.stringify(held))
      const heldRun = held.structuredContent as { runId: string; sessionId: string }
      await waitUntil(() => mock.requests.length >= 4)
      const steered = await client.callTool({
        name: 'steer_run',
        arguments: { runId: heldRun.runId, task: '/correct-the-snapshot' },
      })
      if (steered.isError === true) throw new Error(JSON.stringify(steered))
      const steering = steered.structuredContent as {
        accepted: boolean
        messageId: string
        run: { runId: string; sessionId: string }
      }
      const steeredCompleted = await terminalRun(client, heldRun.runId)
      expect({
        tools: tools.tools.map(tool => tool.name).sort(),
        deepLink: new URL(admitted.webUrl).searchParams.has('sessionId'),
        first: stableRun(completed),
        continued: stableRun(continuedCompleted),
        steering: {
          accepted: steering.accepted,
          durableMessage: steering.messageId.length > 0,
          sameRun: steering.run.runId === heldRun.runId,
          sameSession: steering.run.sessionId === heldRun.sessionId,
          completed: stableRun(steeredCompleted),
        },
      }).toMatchInlineSnapshot(`
        {
          "continued": {
            "assistantText": "visible MCP snapshot completed",
            "assistantTextBytes": 30,
            "assistantTextTruncated": false,
            "cancelRequested": false,
            "error": null,
            "sessionReused": true,
            "status": "succeeded",
          },
          "deepLink": true,
          "first": {
            "assistantText": "visible MCP snapshot completed",
            "assistantTextBytes": 30,
            "assistantTextTruncated": false,
            "cancelRequested": false,
            "error": null,
            "sessionReused": false,
            "status": "succeeded",
          },
          "steering": {
            "accepted": true,
            "completed": {
              "assistantText": "visible MCP snapshot completed
        visible MCP snapshot completed",
              "assistantTextBytes": 61,
              "assistantTextTruncated": false,
              "cancelRequested": false,
              "error": null,
              "sessionReused": true,
              "status": "succeeded",
            },
            "durableMessage": true,
            "sameRun": true,
            "sameSession": true,
          },
          "tools": [
            "cancel_run",
            "doctor",
            "get_run",
            "list_runs",
            "list_services",
            "open_service",
            "start_run",
            "start_service",
            "steer_run",
            "stop_service",
            "wait_run",
          ],
        }
      `)
    } finally {
      await client.close().catch(() => undefined)
      await mock.close()
      rmSync(parent, { recursive: true, force: true })
    }
  }, 120_000)
})

async function terminalRun(client: Client, runId: string): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    const waited = await client.callTool({ name: 'wait_run', arguments: { runId, timeoutMs: 5_000 } })
    if (waited.isError === true) throw new Error(JSON.stringify(waited))
    const snapshot = waited.structuredContent as Record<string, unknown>
    if (snapshot.status !== 'running') return snapshot
  }
  throw new Error(`run did not settle: ${runId}`)
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 10_000
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('condition did not become true within 10 seconds')
    await new Promise(resolve => setTimeout(resolve, 20))
  }
}

function stableRun(run: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries([
    'sessionReused', 'status', 'cancelRequested', 'assistantText',
    'assistantTextBytes', 'assistantTextTruncated', 'error',
  ].map(key => [key, run[key]]))
}
