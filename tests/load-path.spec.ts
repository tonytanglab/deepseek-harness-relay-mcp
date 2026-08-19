import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import * as relay from '../src/index.ts'

describe('dsh-relay real-load-path guard', () => {
  it('has no default export and keeps name/inject/Config through unwrapExports', () => {
    expect('default' in relay).toBe(false)
    const loader = Object.create(Loader.prototype) as Loader
    const unwrapped = loader.unwrapExports(relay) as Record<string, unknown>
    expect(unwrapped).toBe(relay)
    expect(unwrapped.name).toBe('relay')
    expect(unwrapped.inject).toEqual(['commands', 'tools'])
    expect(typeof unwrapped.apply).toBe('function')
    expect(unwrapped.Config).toBeDefined()
  })

  it('does not import MCP stdio transport', async () => {
    const sources = await Promise.all([
      'index.ts', 'config.ts', 'doctor.ts', 'mcp-config.ts', 'hosts.ts', 'attach.ts', 'harness-rpc.ts', 'models.ts',
    ].map(file => readFile(fileURLToPath(new URL(`../src/${file}`, import.meta.url)), 'utf8')))
    const code = sources.map(source => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')).join('\n')
    expect(code).not.toContain('StdioServerTransport')
    expect(code).not.toContain('@modelcontextprotocol/sdk')
    expect(code).not.toContain("command: 'npx.cmd'")
    expect(code).not.toContain('"npx.cmd"')
    expect(code).not.toMatch(/shell:\s*true/)
  })
})
