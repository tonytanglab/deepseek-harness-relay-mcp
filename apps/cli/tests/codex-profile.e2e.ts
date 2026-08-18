import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { startMockLlmServer } from '@deepseek-ai/dsh-llm-mock-server'
import { describe, expect, it } from 'vitest'

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url))
const dshBin = join(repoRoot, 'apps/cli/lib/bin.js')

/** Windows-blocking acceptance for the published Codex profile and its real managed Web child. */
describe('dsh BUILT codex profile', () => {
  it('serves MCP over stdio, reaches Web readiness, and stops the process tree', async () => {
    const mock = await startMockLlmServer({
      sequence: ['success', 'success', 'success', 'slow_success', 'success', 'stall'],
      apiKey: 'codex-profile-keyless',
      successText: 'visible MCP run completed',
      chunkSize: 1,
      chunkDelayMs: 50,
    })
    const parent = mkdtempSync(join(tmpdir(), 'dsh-codex-profile-'))
    const workspace = join(parent, 'workspace')
    const home = join(parent, 'home')
    mkdirSync(home, { recursive: true })
    writeFileSync(join(home, '.credentials.yaml'), 'DEEPSEEK_API_KEY: codex-profile-keyless\n', {
      encoding: 'utf8',
      mode: 0o600,
    })
    const environment = Object.fromEntries(
      Object.entries({
        ...process.env,
        DSH_HOME: home,
        DSH_MCP_WORKSPACE_ROOTS: parent,
        DSH_TELEMETRY_DISABLED: '1',
        // Force the supervised child through the user-global credentials
        // document instead of an inherited process value.
        DEEPSEEK_API_KEY: undefined,
        DEEPSEEK_BASE_URL: mock.baseURL,
      }).filter((entry): entry is [string, string] => entry[1] !== undefined),
    )
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [dshBin, '--profile', 'codex'],
      cwd: repoRoot,
      env: environment,
      stderr: 'pipe',
    })
    let stderr = ''
    transport.stderr?.on('data', (chunk) => { stderr += String(chunk) })
    const client = new Client({ name: 'codex-profile-smoke', version: '1.0.0' })
    try {
      mkdirSync(workspace, { recursive: true })
      await client.connect(transport)
      const tools = await client.listTools()
      expect(tools.tools.map(tool => tool.name).sort()).toEqual([
        'cancel_run', 'doctor', 'get_run', 'list_runs', 'list_services',
        'open_service', 'start_run', 'start_service', 'steer_run', 'stop_service', 'wait_run',
      ])

      const doctor = await client.callTool({ name: 'doctor', arguments: {} })
      expect(doctor.isError).not.toBe(true)
      expect(doctor.structuredContent).toMatchObject({ ok: true })

      const started = await client.callTool({
        name: 'start_service',
        arguments: { workspace, openBrowser: false },
      })
      const failedServices = started.isError === true
        ? await client.callTool({ name: 'list_services', arguments: {} })
        : undefined
      expect(
        started.isError,
        `${JSON.stringify(started)}\nservices:\n${JSON.stringify(failedServices)}\nstderr:\n${stderr}`,
      ).not.toBe(true)
      const service = started.structuredContent as { serviceId: string; status: string; webUrl: string }
      expect(service).toMatchObject({ status: 'running' })
      expect(service.webUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/u)

      const first = await client.callTool({
        name: 'start_run',
        arguments: { workspace, task: '/literal-keyless-run', openBrowser: false },
      })
      expect(first.isError, JSON.stringify(first)).not.toBe(true)
      const firstRun = first.structuredContent as { runId: string; sessionId: string; webUrl: string }
      expect(firstRun.webUrl).toContain(`/?sessionId=${firstRun.sessionId}`)
      expect(await terminalRun(client, firstRun.runId)).toMatchObject({
        status: 'succeeded',
        assistantText: 'visible MCP run completed',
      })

      const continued = await client.callTool({
        name: 'start_run',
        arguments: { workspace, task: 'continue visibly', sessionId: firstRun.sessionId },
      })
      expect(continued.isError, JSON.stringify(continued)).not.toBe(true)
      const continuedRun = continued.structuredContent as { runId: string; sessionReused: boolean }
      expect(continuedRun.sessionReused).toBe(true)
      await expect(terminalRun(client, continuedRun.runId)).resolves.toMatchObject({ status: 'succeeded' })

      const held = await client.callTool({
        name: 'start_run',
        arguments: { workspace, task: 'wait for live correction', sessionId: firstRun.sessionId },
      })
      expect(held.isError, JSON.stringify(held)).not.toBe(true)
      const heldRun = held.structuredContent as { runId: string; sessionId: string }
      await waitUntil(() => mock.requests.length >= 4)
      const steered = await client.callTool({
        name: 'steer_run',
        arguments: { runId: heldRun.runId, task: '/apply-this-correction' },
      })
      expect(steered.isError, JSON.stringify(steered)).not.toBe(true)
      expect(steered.structuredContent).toMatchObject({
        accepted: true,
        run: { runId: heldRun.runId, sessionId: heldRun.sessionId },
      })
      const steeredTerminal = await terminalRun(client, heldRun.runId).catch((error: unknown) => {
        const requests = mock.requests.map(request => ({
          attempt: request.attempt,
          behavior: request.behavior,
          outcome: request.outcome,
        }))
        throw new Error(`${String(error)}; mock requests: ${JSON.stringify(requests)}; stderr: ${stderr}`)
      })
      expect(
        steeredTerminal,
        JSON.stringify({ terminal: steeredTerminal, requests: mock.requests.map(request => request.behavior) }),
      ).toMatchObject({ status: 'succeeded' })

      const cancellable = await client.callTool({
        name: 'start_run',
        arguments: { workspace, task: 'wait until cancelled' },
      })
      expect(cancellable.isError, JSON.stringify(cancellable)).not.toBe(true)
      const cancellableRun = cancellable.structuredContent as { runId: string }
      await waitUntil(() => mock.requests.length >= 6)
      const cancelled = await client.callTool({ name: 'cancel_run', arguments: { runId: cancellableRun.runId } })
      expect(cancelled.isError, JSON.stringify(cancelled)).not.toBe(true)
      await expect(terminalRun(client, cancellableRun.runId)).resolves.toMatchObject({
        status: 'cancelled',
        cancelRequested: true,
      })

      const stopped = await client.callTool({
        name: 'stop_service',
        arguments: { serviceId: service.serviceId },
      })
      expect(stopped.isError, `${JSON.stringify(stopped)}\nstderr:\n${stderr}`).not.toBe(true)
      expect(stopped.structuredContent).toMatchObject({ status: 'stopped' })
    } finally {
      await client.close().catch(() => undefined)
      await mock.close()
      rmSync(parent, { recursive: true, force: true })
    }
  }, 120_000)
})

async function terminalRun(client: Client, runId: string): Promise<Record<string, unknown>> {
  let last: Record<string, unknown> | undefined
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    const waited = await client.callTool({ name: 'wait_run', arguments: { runId, timeoutMs: 5_000 } })
    if (waited.isError === true) throw new Error(JSON.stringify(waited))
    const snapshot = waited.structuredContent as Record<string, unknown>
    last = snapshot
    if (snapshot.status !== 'running') return snapshot
  }
  throw new Error(`run did not settle: ${runId}; last snapshot: ${JSON.stringify(last)}`)
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 10_000
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('condition did not become true within 10 seconds')
    await new Promise(resolve => setTimeout(resolve, 20))
  }
}
