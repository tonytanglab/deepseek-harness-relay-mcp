/** Assign and monitor runs on an already-running Harness Web. Does not spawn a child. */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { isAbsolute } from 'node:path'
import { callHarness, sessionUrl, type SessionSummary, type WorkspaceView } from './harness-rpc.ts'
import { resolveCatalogModel, type ModelSelection, type SessionModels } from './models.ts'

const execFileAsync = promisify(execFile)

export interface AttachConfig {
  webUrl: string
  allowedWorkspaceRoots: string[]
}

export interface RunSnapshot {
  runId: string
  serviceId: string
  sessionId: string
  sessionReused: boolean
  task: string
  workspace: string
  webUrl: string
  model: ModelSelection | null
  status: 'running' | 'succeeded' | 'failed' | 'cancelled'
  cancelRequested: boolean
  startedAt: string
  finishedAt: string | null
  error: string | null
}

export interface ServiceSnapshot {
  serviceId: string
  workspace: string | null
  status: 'running' | 'failed'
  webUrl: string
  browserOpened: boolean
  browserError: string | null
  attached: true
}

interface RunRecord extends RunSnapshot {
  baselineUpdatedAt: number
  sawRunning: boolean
}

/**
 * In-process run table over one attached Harness Web origin.
 */
export class AttachManager {
  readonly serviceId = crypto.randomUUID()
  private readonly runs = new Map<string, RunRecord>()

  constructor(private readonly config: AttachConfig) {}

  async doctor(): Promise<object> {
    const listed = await callHarness<{ items: SessionSummary[] }>(this.config.webUrl, 'session.list')
    return {
      ok: true,
      attached: true,
      webUrl: this.config.webUrl,
      sessions: listed.items.length,
      workspacePolicy: {
        restricted: this.config.allowedWorkspaceRoots.length > 0,
        roots: this.config.allowedWorkspaceRoots,
      },
    }
  }

  async startService(input: { workspace?: string; openBrowser?: boolean }): Promise<ServiceSnapshot> {
    await callHarness(this.config.webUrl, 'session.list')
    const snapshot = this.serviceSnapshot(input.workspace ?? null, false, null)
    if (input.openBrowser === true) return await this.open(snapshot.webUrl, snapshot)
    return snapshot
  }

  async openService(): Promise<ServiceSnapshot> {
    return await this.open(this.config.webUrl, this.serviceSnapshot(null, false, null))
  }

  listServices(): ServiceSnapshot[] {
    return [this.serviceSnapshot(null, false, null)]
  }

  stopService(): ServiceSnapshot {
    return {
      ...this.serviceSnapshot(null, false, null),
      status: 'running',
      browserError: 'attached Harness web on the configured port is not stopped',
    }
  }

  async start(input: {
    task: string
    workspace: string
    sessionId?: string
    model?: string
    provider?: string
    reasoningEffort?: string
    openBrowser?: boolean
  }): Promise<RunSnapshot> {
    const task = input.task.trim()
    if (task === '') throw new Error('task must not be empty')
    this.assertWorkspace(input.workspace)
    const createdWs = await callHarness<{ workspace: WorkspaceView }>(this.config.webUrl, 'workspace.create', {
      path: input.workspace,
    })
    const listed = await callHarness<{ items: SessionSummary[] }>(this.config.webUrl, 'session.list')
    let sessionId = input.sessionId?.trim()
    let sessionReused = false
    let baselineUpdatedAt = 0
    if (sessionId === undefined || sessionId === '') {
      const created = await callHarness<{ sessionId: string }>(this.config.webUrl, 'session.create', {
        workspaceId: createdWs.workspace.workspaceId,
      })
      sessionId = created.sessionId
    } else {
      const summary = listed.items.find(item => item.sessionId === sessionId)
      if (summary === undefined) throw new Error(`unknown sessionId: ${sessionId}`)
      if (summary.running) throw new Error(`Harness session is still running: ${sessionId}`)
      sessionReused = true
      baselineUpdatedAt = summary.updatedAt
    }
    const model = await this.selectModel(sessionId, input)
    await callHarness(this.config.webUrl, 'session.prompt', {
      sessionId,
      mode: 'queue',
      content: [{ type: 'text', text: task }],
    })
    const runId = crypto.randomUUID()
    const record: RunRecord = {
      runId,
      serviceId: this.serviceId,
      sessionId,
      sessionReused,
      task,
      workspace: input.workspace,
      webUrl: sessionUrl(this.config.webUrl, sessionId),
      model,
      status: 'running',
      cancelRequested: false,
      startedAt: new Date().toISOString(),
      finishedAt: null,
      error: null,
      baselineUpdatedAt,
      sawRunning: false,
    }
    this.runs.set(runId, record)
    if (input.openBrowser === true) {
      try {
        await this.openUrl(record.webUrl)
      } catch (error) {
        void error
      }
    }
    return this.publicRun(record)
  }

  async steer(runId: string, task: string): Promise<{ runId: string; accepted: true }> {
    const run = this.requireRun(runId)
    if (run.status !== 'running') throw new Error(`run is not active: ${runId}`)
    await callHarness(this.config.webUrl, 'session.prompt', {
      sessionId: run.sessionId,
      mode: 'steer',
      content: [{ type: 'text', text: task.trim() }],
    })
    return { runId, accepted: true }
  }

  get(runId: string): RunSnapshot {
    return this.publicRun(this.requireRun(runId))
  }

  async wait(runId: string, timeoutMs = 30_000): Promise<RunSnapshot> {
    const run = this.requireRun(runId)
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline && run.status === 'running') {
      await this.refresh(run)
      if (run.status !== 'running') break
      await delay(500)
    }
    return this.publicRun(run)
  }

  list(serviceId?: string): RunSnapshot[] {
    if (serviceId !== undefined && serviceId !== this.serviceId) return []
    return [...this.runs.values()].map(run => this.publicRun(run))
  }

  async cancel(runId: string): Promise<RunSnapshot> {
    const run = this.requireRun(runId)
    run.cancelRequested = true
    await callHarness(this.config.webUrl, 'session.cancel', { sessionId: run.sessionId })
    run.status = 'cancelled'
    run.finishedAt = new Date().toISOString()
    return this.publicRun(run)
  }

  private async refresh(run: RunRecord): Promise<void> {
    const listed = await callHarness<{ items: SessionSummary[] }>(this.config.webUrl, 'session.list')
    const summary = listed.items.find(item => item.sessionId === run.sessionId)
    if (summary === undefined) {
      run.status = 'failed'
      run.error = 'session disappeared from Harness'
      run.finishedAt = new Date().toISOString()
      return
    }
    if (summary.running) run.sawRunning = true
    if (run.sawRunning && !summary.running) {
      run.status = run.cancelRequested ? 'cancelled' : 'succeeded'
      run.finishedAt = new Date().toISOString()
    } else if (!summary.running && summary.updatedAt > run.baselineUpdatedAt && summary.blank === false) {
      run.status = 'succeeded'
      run.finishedAt = new Date().toISOString()
    }
  }

  private async selectModel(
    sessionId: string,
    input: { model?: string; provider?: string; reasoningEffort?: string },
  ): Promise<ModelSelection | null> {
    if ((input.model?.trim() ?? '') === '' && (input.provider?.trim() ?? '') === '') return null
    const directory = await callHarness<SessionModels>(this.config.webUrl, 'session.models', { sessionId })
    const resolved = resolveCatalogModel(directory.groups, input)
    const selected = await callHarness<{ selected: ModelSelection }>(this.config.webUrl, 'session.selectModel', {
      sessionId,
      provider: resolved.provider,
      model: resolved.model,
      ...input.reasoningEffort?.trim() ? { reasoningEffort: input.reasoningEffort.trim() } : {},
    })
    return selected.selected
  }

  private requireRun(runId: string): RunRecord {
    const run = this.runs.get(runId)
    if (run === undefined) throw new Error(`unknown runId: ${runId}`)
    return run
  }

  private assertWorkspace(workspace: string): void {
    if (!isAbsolute(workspace)) throw new Error('workspace must be an absolute path')
    const roots = this.config.allowedWorkspaceRoots
    if (roots.length === 0) return
    const allowed = roots.some(root => workspace === root || workspace.startsWith(`${root}\\`) || workspace.startsWith(`${root}/`))
    if (!allowed) throw new Error('workspace is outside DSH_MCP_WORKSPACE_ROOTS')
  }

  private serviceSnapshot(workspace: string | null, browserOpened: boolean, browserError: string | null): ServiceSnapshot {
    return {
      serviceId: this.serviceId,
      workspace,
      status: 'running',
      webUrl: this.config.webUrl,
      browserOpened,
      browserError,
      attached: true,
    }
  }

  private publicRun(run: RunRecord): RunSnapshot {
    const { baselineUpdatedAt: _baseline, sawRunning: _saw, ...rest } = run
    return rest
  }

  private async open(url: string, snapshot: ServiceSnapshot): Promise<ServiceSnapshot> {
    try {
      await this.openUrl(url)
      return { ...snapshot, browserOpened: true, browserError: null }
    } catch (error) {
      return { ...snapshot, browserOpened: false, browserError: error instanceof Error ? error.message : String(error) }
    }
  }

  private async openUrl(url: string): Promise<void> {
    if (process.platform === 'win32') {
      await execFileAsync('cmd.exe', ['/c', 'start', '', url], { windowsHide: true })
      return
    }
    await execFileAsync(process.platform === 'darwin' ? 'open' : 'xdg-open', [url])
  }
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}
