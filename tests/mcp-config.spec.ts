import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DEFAULT_DSH_PACKAGE, DEFAULT_WEB_URL, resolveConfig } from '../src/config.ts'
import { assertNever, MCP_HOSTS, parseMcpHost } from '../src/hosts.ts'
import { buildMcpLaunch, mcpEntry, upsertCodexMcpServer, writeMcpConfigFile } from '../src/mcp-config.ts'

const config = resolveConfig({
  mcpServerName: 'dsh-relay',
  allowedWorkspaceRoots: ['/tmp/workspace'],
  credentialsPath: '/tmp/creds.yaml',
  dataDirectory: '/tmp/codex-services',
  dshPackage: DEFAULT_DSH_PACKAGE,
  host: 'codex',
})

describe('buildMcpLaunch', () => {
  it('attaches every host to the running Harness Web via node mcp.js', () => {
    for (const host of MCP_HOSTS) {
      expect(buildMcpLaunch(config, host)).toEqual({
        command: process.execPath,
        args: [mcpEntry()],
        env: {
          DSH_WEB_URL: DEFAULT_WEB_URL,
          DSH_MCP_WORKSPACE_ROOTS: config.allowedWorkspaceRoots.join(delimiter),
          DSH_MCP_CREDENTIALS_PATH: config.credentialsPath,
          DSH_MCP_DATA_DIR: config.dataDirectory,
        },
      })
    }
    expect(mcpEntry().replaceAll('\\', '/')).toMatch(/mcp\.js$/)
  })

  it('omits DSH_MCP_WORKSPACE_ROOTS when no roots are configured', () => {
    const open = resolveConfig({
      mcpServerName: 'dsh-relay',
      allowedWorkspaceRoots: [],
      credentialsPath: '/tmp/creds.yaml',
      dataDirectory: '/tmp/codex-services',
      dshPackage: DEFAULT_DSH_PACKAGE,
      host: 'codex',
    }, {})
    expect(buildMcpLaunch(open, 'codex').env.DSH_MCP_WORKSPACE_ROOTS).toBeUndefined()
    expect(buildMcpLaunch(open, 'codex').env.DSH_WEB_URL).toBe(DEFAULT_WEB_URL)
  })
})

describe('writeMcpConfigFile', () => {
  it('merges the server block into an existing document', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-relay-mcp-'))
    const path = join(dir, 'mcp.json')
    await writeFile(path, `${JSON.stringify({ mcpServers: { other: { command: 'echo' } } }, null, 2)}\n`)
    const launch = buildMcpLaunch(config, 'cursor')
    await writeMcpConfigFile(path, 'dsh-relay', launch)
    const written = JSON.parse(await readFile(path, 'utf8')) as {
      mcpServers: Record<string, unknown>
    }
    expect(written.mcpServers.other).toEqual({ command: 'echo' })
    expect(written.mcpServers['dsh-relay']).toEqual(launch)
  })

  it('rejects a relative path', async () => {
    await expect(writeMcpConfigFile('mcp.json', 'dsh-relay', buildMcpLaunch(config, 'codex')))
      .rejects.toThrow(/must be absolute/)
  })

  it('upserts a Codex TOML mcp_servers table without duplicating it', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-relay-mcp-'))
    const path = join(dir, 'config.toml')
    await writeFile(path, "model = 'gpt'\n\n[mcp_servers.other]\ncommand = 'echo'\n")
    const launch = buildMcpLaunch(config, 'codex')
    await writeMcpConfigFile(path, 'dsh-relay', launch)
    await writeMcpConfigFile(path, 'dsh-relay', launch)
    const written = await readFile(path, 'utf8')
    expect(written).toContain("[mcp_servers.other]")
    expect(written.match(/\[mcp_servers\.dsh-relay\]/g)).toHaveLength(1)
    expect(written.match(/\[mcp_servers\.dsh-relay\.env\]/g)).toHaveLength(1)
    expect(written).toContain(`command = '${launch.command}'`)
  })
})

describe('upsertCodexMcpServer', () => {
  it('appends the table to an empty document', () => {
    const launch = buildMcpLaunch(config, 'codex')
    const written = upsertCodexMcpServer('', 'dsh-relay', launch)
    expect(written).toContain("[mcp_servers.dsh-relay]")
    expect(written).toContain(`args = [${launch.args.map(value => `'${value}'`).join(', ')}]`)
  })
})

describe('parseMcpHost', () => {
  it('rejects an unknown host', () => {
    expect(() => parseMcpHost('windsurf')).toThrow(/must be one of/)
  })

  it('assertNever throws for a remaining value', () => {
    expect(() => assertNever('nope' as never)).toThrow(/unsupported MCP host/)
  })
})
