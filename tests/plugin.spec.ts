import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { CallId } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as relay from '../src/index.ts'
import { DEFAULT_DSH_PACKAGE, type Config } from '../src/index.ts'

const signal = new AbortController().signal

async function setup(config: Partial<Config> = {}) {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(CommandRuntime)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  const fiber = await ctx.plugin(relay, {
    mcpServerName: 'dsh-relay',
    allowedWorkspaceRoots: [],
    dshPackage: DEFAULT_DSH_PACKAGE,
    host: 'codex',
    ...config,
  })
  const session = ctx.sessions.create(SessionId('relay-test'))
  const agent = { id: session.id, session } as Agent
  return { ctx, fiber, agent }
}

describe('dsh-relay plugin', () => {
  it('registers the command and tools, then drops them on dispose', async () => {
    const { ctx, fiber, agent } = await setup()
    expect(ctx.commands.find(agent, 'relay-setup')?.description).toContain('does not run the MCP stdio server')
    expect(ctx.tools.schemas().map(schema => schema.name)).toEqual(
      expect.arrayContaining(['relay_doctor', 'relay_write_mcp_config']),
    )
    await fiber.dispose()
    expect(ctx.commands.find(agent, 'relay-setup')).toBeUndefined()
    expect(ctx.tools.schemas().map(schema => schema.name)).not.toContain('relay_doctor')
    expect(ctx.tools.schemas().map(schema => schema.name)).not.toContain('relay_write_mcp_config')
  })

  it('rejects extra /relay-setup input and writes MCP config when a path is set', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-relay-plugin-'))
    const path = join(dir, 'mcp.json')
    const { ctx, agent } = await setup({ mcpConfigPath: path, host: 'codex' })
    const rejected = await ctx.commands.execute(agent, '/relay-setup extra', signal)
    expect(rejected?.result).toEqual({
      kind: 'error',
      text: 'The /relay-setup command does not accept extra input.',
    })
    const done = await ctx.commands.execute(agent, '/relay-setup', signal)
    expect(done?.result.kind).toBe('success')
    expect(done?.result.text).toContain('does not run the MCP stdio server here')
    expect(done?.result.text).toContain('DSH_WEB_URL')
    expect(done?.result.text).toContain('mcp.js')
    const written = JSON.parse(await readFile(path, 'utf8')) as {
      mcpServers: { 'dsh-relay': { command: string; args: string[]; env: { DSH_WEB_URL: string } } }
    }
    expect(written.mcpServers['dsh-relay'].command).toBe(process.execPath)
    expect(written.mcpServers['dsh-relay'].args[0]?.replaceAll('\\', '/')).toMatch(/mcp\.js$/)
    expect(written.mcpServers['dsh-relay'].env.DSH_WEB_URL).toBe('http://127.0.0.1:3080')
  })

  it('prints a launch block without writing when path is omitted', async () => {
    const { ctx } = await setup()
    const result = await ctx.tools.execute({
      signal,
      callId: CallId('write-1'),
      name: 'relay_write_mcp_config',
      arguments: { host: 'claude-code' },
    })
    expect(result.isError).toBe(false)
    expect(result.value).toMatchObject({
      written: false,
      path: null,
      host: 'claude-code',
      serverName: 'dsh-relay',
      config: { command: process.execPath },
    })
  })
})
