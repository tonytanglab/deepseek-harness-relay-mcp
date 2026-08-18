import { delimiter, resolve } from 'node:path'
import { homedir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { DEFAULT_DSH_PACKAGE, resolveConfig } from '../src/config.ts'

describe('resolveConfig', () => {
  it('uses DSH_MCP_WORKSPACE_ROOTS when allowedWorkspaceRoots is empty', () => {
    const first = resolve('/tmp/relay-a')
    const second = resolve('/tmp/relay-b')
    const resolved = resolveConfig({
      mcpServerName: 'dsh-relay',
      allowedWorkspaceRoots: [],
      dshPackage: DEFAULT_DSH_PACKAGE,
      host: 'codex',
    }, {
      DSH_HOME: resolve('/tmp/relay-home'),
      DSH_MCP_WORKSPACE_ROOTS: `${first}${delimiter}${second}`,
    })
    expect(resolved.allowedWorkspaceRoots).toEqual([first, second])
    expect(resolved.credentialsPath).toBe(resolve('/tmp/relay-home', '.credentials.yaml'))
    expect(resolved.dataDirectory).toBe(resolve('/tmp/relay-home', 'codex-services'))
  })

  it('prefers explicit roots and paths over the environment', () => {
    const resolved = resolveConfig({
      mcpServerName: 'custom',
      mcpConfigPath: '/tmp/mcp.json',
      allowedWorkspaceRoots: ['/tmp/explicit'],
      credentialsPath: '/tmp/creds.yaml',
      dataDirectory: '/tmp/data',
      dshPackage: '@deepseek-ai/dsh@9.9.9',
      host: 'cursor',
    }, {
      DSH_HOME: '/tmp/ignored-home',
      DSH_MCP_WORKSPACE_ROOTS: '/tmp/ignored-root',
      DSH_MCP_CREDENTIALS_PATH: '/tmp/ignored-creds',
      DSH_MCP_DATA_DIR: '/tmp/ignored-data',
    })
    expect(resolved.mcpServerName).toBe('custom')
    expect(resolved.mcpConfigPath).toBe(resolve('/tmp/mcp.json'))
    expect(resolved.allowedWorkspaceRoots).toEqual([resolve('/tmp/explicit')])
    expect(resolved.credentialsPath).toBe(resolve('/tmp/creds.yaml'))
    expect(resolved.dataDirectory).toBe(resolve('/tmp/data'))
    expect(resolved.dshPackage).toBe('@deepseek-ai/dsh@9.9.9')
    expect(resolved.host).toBe('cursor')
  })

  it('falls back to ~/.dsh when DSH_HOME is unset', () => {
    const resolved = resolveConfig({
      mcpServerName: 'dsh-relay',
      allowedWorkspaceRoots: [],
      dshPackage: DEFAULT_DSH_PACKAGE,
      host: 'codex',
    }, {})
    expect(resolved.credentialsPath).toBe(resolve(homedir(), '.dsh', '.credentials.yaml'))
  })
})
