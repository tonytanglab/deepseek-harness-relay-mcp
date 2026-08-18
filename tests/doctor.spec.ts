import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { inspectRuntime } from '../src/doctor.ts'
import { resolveConfig } from '../src/config.ts'

describe('inspectRuntime', () => {
  it('fails when the dsh entry is missing or not absolute', async () => {
    const config = resolveConfig({
      mcpServerName: 'dsh-relay',
      allowedWorkspaceRoots: [],
      dshPackage: '@deepseek-ai/dsh@0.1.0-rc.5',
      host: 'codex',
    }, { DSH_HOME: await mkdtemp(join(tmpdir(), 'dsh-relay-doctor-')) })
    const relative = await inspectRuntime(config, 'dsh', process.execPath, process.version)
    expect(relative.ok).toBe(false)
    expect(relative.launcher.direct).toBe(false)
    expect(relative.launcher.exists).toBe(false)
    expect(relative.launcher.shell).toBe(false)
    expect(relative.package).toEqual({ name: 'dsh-relay', version: '0.1.0' })

    const missing = await inspectRuntime(config, join(config.dataDirectory, 'missing-entry.js'), process.execPath, process.version)
    expect(missing.launcher.direct).toBe(true)
    expect(missing.launcher.exists).toBe(false)
    expect(missing.ok).toBe(false)
  })

  it('reports existing credentials without reading them', async () => {
    const home = await mkdtemp(join(tmpdir(), 'dsh-relay-creds-'))
    const credentialsPath = join(home, '.credentials.yaml')
    await writeFile(credentialsPath, 'secret: must-not-appear\n')
    const config = resolveConfig({
      mcpServerName: 'dsh-relay',
      allowedWorkspaceRoots: [home],
      credentialsPath,
      dshPackage: '@deepseek-ai/dsh@0.1.0-rc.5',
      host: 'codex',
    }, { DSH_HOME: home })
    const report = await inspectRuntime(config, process.execPath, process.execPath, 'v22.0.0')
    expect(report.credentials).toEqual({ path: credentialsPath, exists: true })
    expect(JSON.stringify(report)).not.toContain('must-not-appear')
    expect(report.workspacePolicy.restricted).toBe(true)
    expect(report.node.version).toBe('v22.0.0')
    expect(report.ok).toBe(true)
  })
})
