/** Assign and monitor runs on an already-running Harness Web. Does not spawn a child. */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { isAbsolute } from 'node:path'
import { callHarness, sessionUrl, type SessionSummary, type WorkspaceView } from './harness-rpc.ts'
import { resolveCatalogModel, summarizeCatalog, type ModelSelection, type SessionModels } from './models.ts'
import { inspectTurn, isInsideWorkspace, maxEventSeq, unwrapHistory, type HistoryPage } from './run-state.ts'

const execFileAsync = promisify(execFile)

/** Bounded wait for a cancelled turn to reach a terminal state. */
const CANCEL_CONVERGENCE_MS = 10_000

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
  text: string | null
  status: 'running' | 'succeeded' | 'failed' | 'cancelled'
  cancelRequested: boolean
  startedAt: string
  finishedAt: string | null
  error: string | null
  /** Last transport failure seen while polling; null when the last refresh succeeded. */
  lastRefreshError: string | null
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
  afterSeq: number
}

/**
 * In-process run table over one attached Harness Web origin.
 */
export class AttachManager {
  readonly serviceId = crypto.randomUUID()
  private readonly runs = new Map<string, RunRecord>()
  /** sessionId → runId reservation so two Relay runs never share one Harness session. */
  private readonly activeSessions = new Map<string, string>()

  constructor(private readonly config: AttachConfig) {}

  async doctor(): Promise<object> {
    const listed = await callHarness<{ items: SessionSummary[] }>(this.config.webUrl, 'session.list')
    let models: ReturnType<typeof summarizeCatalog> | null = null
    for (const item of listed.items) {
      try {
        const directory = await callHarness<SessionModels>(this.config.webUrl, 'session.models', { sessionId: item.sessionId })
        models = summarizeCatalog(directory)
        break
      } catch {
        continue
      }
    }
    return {
      ok: true,
      attached: true,
      webUrl: this.config.webUrl,
      sessions: listed.items.length,
      workspacePolicy: {
        restricted: this.config.allowedWorkspaceRoots.length > 0,
        roots: this.config.allowedWorkspaceRoots,
      },
      models: models ?? { current: null, groups: [] },
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
    if (sessionId === undefined || sessionId === '') {
      const created = await callHarness<{ sessionId: string }>(this.config.webUrl, 'session.create', {
        workspaceId: createdWs.workspace.workspaceId,
      })
      sessionId = created.sessionId
    } else {
      const summary = listed.items.find(item => item.sessionId === sessionId)
      if (summary === undefined) throw new Error(`unknown sessionId: ${sessionId}`)
      if (!createdWs.workspace.sessionIds.includes(sessionId)) {
        throw new Error(`unknown sessionId for this workspace: ${sessionId}`)
      }
      if (summary.origin === 'subagent') throw new Error(`session is a subagent session: ${sessionId}`)
      if (summary.running) throw new Error(`Harness session is still running: ${sessionId}`)
      sessionReused = true
    }
    const runId = crypto.randomUUID()
    if (this.activeSessions.has(sessionId)) {
      throw new Error(`Harness session already has an active Relay run: ${sessionId}`)
    }
    // Reserve synchronously before any more awaits so concurrent starts cannot
    // both pass the active-session check.
    this.activeSessions.set(sessionId, runId)
    try {
      const model = await this.selectModel(sessionId, input)
      const prior = await callHarness<HistoryPage>(this.config.webUrl, 'session.history', {
        sessionId,
        maxMessages: 20,
      })
      const afterSeq = maxEventSeq(unwrapHistory(prior))
      await callHarness(this.config.webUrl, 'session.prompt', {
        sessionId,
        mode: 'queue',
        content: [{ type: 'text', text: task }],
      })
      const record: RunRecord = {
        runId,
        serviceId: this.serviceId,
        sessionId,
        sessionReused,
        task,
        workspace: input.workspace,
        webUrl: sessionUrl(this.config.webUrl, sessionId),
        model,
        text: null,
        status: 'running',
        cancelRequested: false,
        startedAt: new Date().toISOString(),
        finishedAt: null,
        error: null,
        lastRefreshError: null,
        afterSeq,
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
    } catch (error) {
      if (this.activeSessions.get(sessionId) === runId) {
        this.activeSessions.delete(sessionId)
      }
      throw error
    }
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

  async get(runId: string): Promise<RunSnapshot> {
    const run = this.requireRun(runId)
    await this.refresh(run)
    return this.publicRun(run)
  }

  async wait(runId: string, timeoutMs = 30_000): Promise<RunSnapshot> {
    const run = this.requireRun(runId)
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline && run.status === 'running') {
      await this.refresh(run, deadline)
      if (run.status !== 'running') break
      await delay(Math.min(500, Math.max(0, deadline - Date.now())))
    }
    return this.publicRun(run)
  }

  async list(serviceId?: string): Promise<RunSnapshot[]> {
    if (serviceId !== undefined && serviceId !== this.serviceId) return []
    const runs = [...this.runs.values()]
    await Promise.all(runs.map(run => this.refresh(run)))
    return runs.map(run => this.publicRun(run))
  }

  async cancel(runId: string): Promise<RunSnapshot> {
    const run = this.requireRun(runId)
    // Idempotent: a terminal run just returns its snapshot.
    if (run.status !== 'running') return this.publicRun(run)
    const deadline = Date.now() + CANCEL_CONVERGENCE_MS
    await callHarness(
      this.config.webUrl,
      'session.cancel',
      { sessionId: run.sessionId },
      { timeoutMs: remainingMs(deadline) },
    )
    run.cancelRequested = true
    // Converge on the real turn/end instead of claiming cancelled immediately:
    // if Harness keeps the turn alive, the snapshot honestly stays `running`
    // with `cancelRequested: true`.
    while (run.status === 'running' && Date.now() < deadline) {
      await this.refresh(run, deadline)
      if (run.status !== 'running') break
      await delay(Math.min(500, Math.max(0, deadline - Date.now())))
    }
    return this.publicRun(run)
  }

  private async refresh(run: RunRecord, deadline?: number): Promise<void> {
    let page: HistoryPage
    try {
      if (deadline !== undefined && Date.now() >= deadline) return
      const listed = await callHarness<{ items: SessionSummary[] }>(
        this.config.webUrl,
        'session.list',
        {},
        deadline === undefined ? {} : { timeoutMs: remainingMs(deadline) },
      )
      const summary = listed.items.find(item => item.sessionId === run.sessionId)
      if (summary === undefined) {
        run.lastRefreshError = null
        // A vanished session is a business outcome, not a transport failure.
        this.finish(run, 'failed', 'session disappeared from Harness')
        return
      }
      if (deadline !== undefined && Date.now() >= deadline) return
      page = await callHarness<HistoryPage>(
        this.config.webUrl,
        'session.history',
        {
          sessionId: run.sessionId,
          maxMessages: 40,
        },
        deadline === undefined ? {} : { timeoutMs: remainingMs(deadline) },
      )
    } catch (error) {
      // Transport failures (Web restarting, fetch timeout) must not end the run
      // or abort the wait; surface them on the snapshot and keep polling.
      run.lastRefreshError = error instanceof Error ? error.message : String(error)
      return
    }
    run.lastRefreshError = null
    const outcome = inspectTurn(unwrapHistory(page), run.afterSeq, run.cancelRequested)
    if (outcome.text !== null) run.text = outcome.text
    if (!outcome.ended) return
    this.finish(run, outcome.status ?? 'succeeded', outcome.error)
  }

  private finish(run: RunRecord, status: Exclude<RunSnapshot['status'], 'running'>, error: string | null): void {
    if (run.status === 'running') {
      run.status = status
      run.error = error
      run.finishedAt = new Date().toISOString()
    }
    if (this.activeSessions.get(run.sessionId) === run.runId) {
      this.activeSessions.delete(run.sessionId)
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
      ...resolved.reasoningEffort === undefined ? {} : { reasoningEffort: resolved.reasoningEffort },
    })
    return selected.selected
  }

  private requireRun(runId: string): RunRecord {
    const run = this.runs.get(runId)
    if (run === undefined) throw new Error(`unknown runId: ${runId}`)
    return run
  }

  private assertWorkspace(workspace: string): void {
    if (!isInsideWorkspace(workspace, this.config.allowedWorkspaceRoots)) {
      if (!isAbsolute(workspace)) throw new Error('workspace must be an absolute path')
      throw new Error('workspace is outside DSH_MCP_WORKSPACE_ROOTS')
    }
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
    const { afterSeq: _afterSeq, ...rest } = run
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

function remainingMs(deadline: number): number {
  return Math.max(1, deadline - Date.now())
}
