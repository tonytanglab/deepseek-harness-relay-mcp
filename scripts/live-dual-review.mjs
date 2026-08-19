import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { access, mkdir, readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const pluginRoot = fileURLToPath(new URL('../', import.meta.url))
const runtimeRoot = fileURLToPath(new URL('../.runtime/', import.meta.url))
const monitorFile = new URL('../.runtime/dual-review.json', import.meta.url)
const continueFile = new URL('../.runtime/continue', import.meta.url)
const prompt = process.env.DSH_RELAY_REVIEW_TASK ?? await readFile(new URL('../.runtime/review-task.txt', import.meta.url), 'utf8')
if (prompt.trim() === '') throw new Error('DSH_RELAY_REVIEW_TASK is required')

await mkdir(runtimeRoot, { recursive: true })
const state = { phase: 'starting', updatedAt: new Date().toISOString(), processId: process.pid, runs: [] }
async function save() {
  state.updatedAt = new Date().toISOString()
  await writeFile(monitorFile, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
}
await save()

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ['./dist/dsh-relay.mjs'],
  cwd: pluginRoot,
  env: { ...process.env, DSH_RELAY_HOST_URL: 'http://127.0.0.1:3080/' },
})
const client = new Client({ name: 'dsh-relay-dual-review', version: '1.0.0' })
try {
  await client.connect(transport)
  const k3 = await call('start_run', {
    workspace: 'D:\\AI\\deepseek-harness', task: prompt, provider: 'kimi-coding', model: 'k3', reasoningEffort: 'max', permissionPreset: 'read-only', openBrowser: false,
  })
  state.runs.push({ label: 'K3/MAX', ...k3 })
  state.phase = 'awaiting-link-verification'
  await save()
  while (!(await exists(continueFile))) await delay(250)

  const flash = await call('start_run', {
    workspace: 'D:\\AI\\deepseek-harness', task: prompt, provider: 'deepseek-official', model: 'deepseek-v4-flash', reasoningEffort: 'max', permissionPreset: 'read-only', openBrowser: false,
  })
  state.runs.push({ label: 'V4-Flash/MAX', ...flash })
  state.phase = 'monitoring'
  await save()

  while (state.runs.some(run => run.status === 'running')) {
    for (let index = 0; index < state.runs.length; index += 1) {
      const current = state.runs[index]
      if (current.status !== 'running') continue
      state.runs[index] = { label: current.label, ...await call('wait_run', { runId: current.runId, timeoutMs: 20_000 }) }
      await save()
    }
  }
  state.phase = 'completed'
  await save()
} catch (error) {
  state.phase = 'failed'
  state.error = error instanceof Error ? error.stack ?? error.message : String(error)
  await save()
  process.exitCode = 1
} finally {
  await client.close()
}

async function call(name, args) {
  const response = await client.callTool({ name, arguments: args })
  if (response.isError === true) throw new Error(response.content?.[0]?.text ?? `${name} failed`)
  return response.structuredContent
}

async function exists(path) {
  return access(path).then(() => true, () => false)
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}
