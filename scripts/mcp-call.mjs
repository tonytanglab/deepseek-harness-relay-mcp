import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { fileURLToPath } from 'node:url'

const [name, input = '{}'] = process.argv.slice(2)
if (name === undefined) throw new Error('usage: node scripts/mcp-call.mjs <tool> [json-arguments]')
const args = JSON.parse(input)
const pluginRoot = fileURLToPath(new URL('../', import.meta.url))
const transport = new StdioClientTransport({
  command: process.execPath,
  args: ['./dist/dsh-relay.mjs'],
  cwd: pluginRoot,
  env: { ...process.env, DSH_RELAY_HOST_URL: process.env.DSH_RELAY_HOST_URL ?? 'http://127.0.0.1:3080/' },
})
const client = new Client({ name: 'dsh-relay-control', version: '1.0.0' })
try {
  await client.connect(transport)
  const response = await client.callTool({ name, arguments: args })
  if (response.isError === true) throw new Error(response.content?.[0]?.text ?? `${name} failed`)
  process.stdout.write(`${JSON.stringify(response.structuredContent, null, 2)}\n`)
} finally {
  await client.close()
}
