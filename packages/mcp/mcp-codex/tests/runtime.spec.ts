import { mkdir, mkdtemp, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  readyUrl, resolveWorkspace, serviceHome, utf8Tail, webCommand,
} from '../src/runtime.ts'

describe('Codex MCP runtime boundaries', () => {
  it('builds the Web child from the current Node and absolute dsh entry without a shell or npx', () => {
    const command = webCommand(
      process.cwd(),
      join(process.cwd(), '.dsh-test-home'),
      join(process.cwd(), '.dsh-global-credentials.yaml'),
    )
    expect(command.argv[0]).toBe(process.execPath)
    expect(command.argv).toContain(process.argv[1])
    expect(command.argv.slice(-6)).toEqual([
      '--profile', 'web', '--port', '0', '--ready-format', 'json',
    ])
    expect(command.argv.some(value => /(?:^|[/\\])npx(?:\.cmd)?$/iu.test(value))).toBe(false)
    expect(command).not.toHaveProperty('shell')
    expect(command.env).toMatchObject({
      DSH_CWD: process.cwd(),
      DSH_HOME: join(process.cwd(), '.dsh-test-home'),
      DSH_GLOBAL_CREDENTIALS_PATH: join(process.cwd(), '.dsh-global-credentials.yaml'),
      DSH_CREDENTIALS_DEFAULT_SCOPE: 'global',
      PYTHONIOENCODING: 'utf-8',
      PYTHONUTF8: '1',
    })
  })

  it('accepts exactly one clean loopback readiness record', () => {
    expect(readyUrl('{"type":"dsh/web-ready","url":"http://127.0.0.1:43123"}'))
      .toBe('http://127.0.0.1:43123')
    expect(readyUrl('ordinary log line')).toBeUndefined()
    expect(() => readyUrl('{"type":"dsh/web-ready","url":"http://example.com:43123"}'))
      .toThrow('rejected Web readiness URL')
    expect(() => readyUrl('{"type":"dsh/web-ready","url":"http://127.0.0.1:43123/path"}'))
      .toThrow('rejected Web readiness URL')
  })

  it('canonicalizes workspaces and enforces canonical allowed roots', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'dsh-mcp-codex-'))
    const root = join(parent, 'root')
    const child = join(root, 'child')
    const outside = join(parent, 'outside')
    await Promise.all([mkdir(child, { recursive: true }), mkdir(outside, { recursive: true })])
    await expect(resolveWorkspace(child, [root])).resolves.toBe(await realpath(child))
    await expect(resolveWorkspace(outside, [root])).rejects.toThrow('outside DSH_MCP_WORKSPACE_ROOTS')
    await expect(resolveWorkspace('relative', [])).rejects.toThrow('absolute path')
  })

  it('uses the complete workspace SHA-256 and truncates assistant text on UTF-8 boundaries', () => {
    expect(serviceHome('C:\\data', 'C:\\repo').split(/[\\/]/u).at(-1)).toMatch(/^[a-f0-9]{64}$/u)
    expect(utf8Tail('a中🙂z', 6)).toEqual({ text: '🙂z', bytes: 9, truncated: true })
    expect(utf8Tail('中文', 6)).toEqual({ text: '中文', bytes: 6, truncated: false })
  })
})
