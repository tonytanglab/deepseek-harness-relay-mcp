import { randomUUID } from 'node:crypto'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const [proxyEntry, workspace] = process.argv.slice(2)
if (!proxyEntry || !workspace) throw new Error('usage: profile-lifecycle-smoke.mjs <proxy-entry> <workspace>')

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [proxyEntry],
  env: { ...process.env, DSH_RELAY_CLIENT_PRINCIPAL_ID: 'profile-e2e' },
})
const client = new Client({ name: 'dsh-relay-profile-e2e', version: '1.0.0' })
try {
  await client.connect(transport)
  const permissions = process.env.DSH_RELAY_SMOKE_ALL_PERMISSIONS === 'true'
    ? ['read-only', 'workspace-write', 'danger-full-access']
    : ['read-only']
  const results = []
  for (const permissionPreset of permissions) {
    const started = await client.callTool({
    name: 'start_run',
    arguments: {
      workspace,
      task: `Reply with exactly: DSH Relay ${permissionPreset} lifecycle smoke complete.`,
      provider: 'deepseek-official',
      model: 'deepseek-v4-flash',
      reasoningEffort: 'max',
      permissionPreset,
      confirmedDangerousPermission: permissionPreset === 'danger-full-access',
      idempotencyKey: randomUUID(),
    },
    })
    if (started.isError === true || typeof started.structuredContent !== 'object' || started.structuredContent === null) {
      throw new Error(`start_run failed: ${JSON.stringify(started.content)}`)
    }
    const run = started.structuredContent
    if (typeof run.runId !== 'string' || typeof run.webUrl !== 'string') throw new Error('start_run returned no runId/webUrl')
    const opened = await fetch(run.webUrl, { redirect: 'manual' })
    if (opened.status < 200 || opened.status >= 400) throw new Error(`Harness Web URL returned HTTP ${opened.status}`)
    const waited = await client.callTool({ name: 'wait_run', arguments: { runId: run.runId, timeoutMs: 10_000 } })
    results.push({ permissionPreset, runId: run.runId, webUrl: run.webUrl, webStatus: opened.status, result: waited.structuredContent })
  }
  process.stdout.write(`${JSON.stringify({ results }, null, 2)}\n`)
} finally {
  await client.close()
}
