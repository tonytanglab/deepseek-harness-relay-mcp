import { describe, expect, it } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import type { CodexRunManager } from '../src/manager.ts'
import type { ResolvedConfig } from '../src/runtime.ts'
import { createMcpServer } from '../src/server.ts'

const config: ResolvedConfig = {
  dataDirectory: 'test-data',
  credentialsPath: 'test-credentials.yaml',
  allowedWorkspaceRoots: [],
  startupTimeoutMs: 60_000,
  stopGraceMs: 10_000,
  rpcTimeoutMs: 10_000,
  browserOpenTimeoutMs: 10_000,
  eventReconnectDelayMs: 250,
  maxTaskCharacters: 100_000,
  maxLogCharacters: 100_000,
  maxAssistantTextBytes: 50_000,
  maxToolEvents: 20,
  maxToolEventBytes: 2_000,
}

describe('Codex MCP tool protocol', () => {
  it('publishes the stable eleven-tool surface and bounded wait/task schemas', async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    const server = createMcpServer({} as CodexRunManager, config, {} as SubprocessRuntime)
    const client = new Client({ name: 'schema-test', version: '1.0.0' })
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
    const listed = await client.listTools()
    expect(listed.tools.map(tool => tool.name)).toEqual([
      'doctor',
      'start_service',
      'open_service',
      'list_services',
      'stop_service',
      'start_run',
      'steer_run',
      'get_run',
      'wait_run',
      'list_runs',
      'cancel_run',
    ])
    const wait = listed.tools.find(tool => tool.name === 'wait_run')?.inputSchema as {
      properties?: { timeoutMs?: { minimum?: number; maximum?: number } }
    }
    expect(wait.properties?.timeoutMs).toMatchObject({ minimum: 0, maximum: 30_000 })
    const start = listed.tools.find(tool => tool.name === 'start_run')?.inputSchema as {
      properties?: { task?: { maxLength?: number } }
    }
    expect(start.properties?.task?.maxLength).toBe(100_000)
    const steer = listed.tools.find(tool => tool.name === 'steer_run')?.inputSchema as {
      properties?: { task?: { maxLength?: number } }
    }
    expect(steer.properties?.task?.maxLength).toBe(100_000)
    await Promise.all([client.close(), server.close()])
  })
})
