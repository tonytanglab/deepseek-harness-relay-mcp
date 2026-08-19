import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { fileURLToPath } from 'node:url'

const pluginRoot = fileURLToPath(new URL('../', import.meta.url))
const relayEntry = fileURLToPath(new URL('../dist/dsh-relay-proxy.mjs', import.meta.url))
const smokeEntry = process.env.DSH_RELAY_SMOKE_ENTRY ?? fileURLToPath(new URL('../dist/dsh-relay.mjs', import.meta.url))
const platform = process.platform
if (platform !== 'win32' && platform !== 'darwin' && platform !== 'linux') {
  throw new Error(`unsupported smoke-test platform: ${platform}`)
}
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [smokeEntry],
  cwd: pluginRoot,
  env: { ...process.env, DSH_RELAY_HOST_URL: process.env.DSH_RELAY_HOST_URL ?? 'http://127.0.0.1:3080/' },
})
const client = new Client({ name: 'dsh-relay-smoke', version: '1.0.0' })
try {
  await client.connect(transport)
  const tools = await client.listTools()
  const doctor = await client.callTool({ name: 'doctor', arguments: {} })
  const capabilities = await client.callTool({ name: 'list_capabilities', arguments: {} })
  const setupPlan = await client.callTool({
    name: 'setup_plan',
    arguments: {
      client: 'cursor',
      scope: 'project',
      platform,
      homeDirectory: pluginRoot,
      workspaceDirectory: pluginRoot,
      nodeExecutable: process.execPath,
      relayEntry,
      endpointDescriptor: fileURLToPath(new URL('../.runtime/relay-endpoint.json', import.meta.url)),
    },
  })
  const notifications = await client.callTool({ name: 'read_notifications', arguments: {} })
  process.stdout.write(`${JSON.stringify({
    tools: tools.tools.map(tool => tool.name),
    doctor: doctor.structuredContent,
    capabilities: capabilities.structuredContent,
    setupPlan: setupPlan.structuredContent,
    notifications: notifications.structuredContent,
  }, null, 2)}\n`)
} finally {
  await client.close()
}
