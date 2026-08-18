import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DEFAULT_DSH_PACKAGE, resolveConfig } from '../src/config.ts'
import { assertNever, MCP_HOSTS, parseMcpHost } from '../src/hosts.ts'
import { buildMcpLaunch, writeMcpConfigFile } from '../src/mcp-config.ts'

const config = resolveConfig({
  mcpServerName: 'dsh-relay',
  allowedWorkspaceRoots: ['/tmp/workspace'],
  credentialsPath: '/tmp/creds.yaml',
  dataDirectory: '/tmp/codex-services',
  dshPackage: DEFAULT_DSH_PACKAGE,
  host: 'codex',
})

describe('buildMcpLaunch', () => {
  it('uses the documented npx argv for every supported host', () => {
    for (const host of MCP_HOSTS) {
      expect(buildMcpLaunch(config, host)).toEqual({
        command: 'npx',
        args: ['--yes', `--package=${DEFAULT_DSH_PACKAGE}`, '--', 'dsh', '--profile', 'codex'],
        env: {
          DSH_MCP_WORKSPACE_ROOTS: config.allowedWorkspaceRoots.join(delimiter),
          DSH_MCP_CREDENTIALS_PATH: config.credentialsPath,
          DSH_MCP_DATA_DIR: config.dataDirectory,
        },
      })
    }
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
})

describe('parseMcpHost', () => {
  it('rejects an unknown host', () => {
    expect(() => parseMcpHost('windsurf')).toThrow(/must be one of/)
  })

  it('assertNever throws for a remaining value', () => {
    expect(() => assertNever('nope' as never)).toThrow(/unsupported MCP host/)
  })
})
