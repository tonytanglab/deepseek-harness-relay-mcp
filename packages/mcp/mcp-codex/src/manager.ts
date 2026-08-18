/** Lifecycle owner for Codex-visible Web services and message-anchored runs. */

import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import type { Readable } from 'node:stream'
import { foldConsumedWork } from '@deepseek-ai/dsh-agent'
import type { IApiClient } from '@deepseek-ai/dsh-host-apiproxy/client'
import type { HostFrame, MuxFrame, RpcResponse, WorkspaceView } from '@deepseek-ai/dsh-host-apiproxy/api'
import type { MessageId } from '@deepseek-ai/dsh-llm/brand'
import type { ToolResultMessage } from '@deepseek-ai/dsh-llm/types'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent, TurnEndReason } from '@deepseek-ai/dsh-session'
import type { SubprocessHandle, SubprocessOutcome, SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import { CodexWebApiClient } from './api-client.ts'
import {
  readyUrl, resolveWorkspace, serviceHome, utf8Tail, webCommand,
  type ResolvedConfig,
} from './runtime.ts'
import type {
  RunId, RunSnapshot, RunStatus, ServiceId, ServiceSnapshot, ServiceStatus,
  StartRunInput, StartServiceInput, SteerRunResult, ToolActivity,
} from './types.ts'

interface PendingRun {
  events: SessionEvent[]
  baselineSeq: number
}

interface ServiceRecord {
  serviceId: ServiceId
  workspace: string
  status: ServiceStatus
  webUrl: string | null
  browserOpened: boolean
  browserError: string | null
  startedAt: Date
  stoppedAt: Date | null
  handle: SubprocessHandle
  log: string
  client?: IApiClient
  streams: AbortController
  sessionRunning: Map<string, boolean>
  pending: Map<string, PendingRun>
  reconcile: Promise<void> | undefined
  terminating: boolean
  termination: Promise<void> | undefined
}

interface RunRecord {
  runId: RunId
  serviceId: ServiceId
  sessionId: string
  messageId: MessageId
  sessionReused: boolean
  baselineSeq: number
  task: string
  workspace: string
  webUrl: string
  status: RunStatus
  cancelRequested: boolean
  startedAt: Date
  finishedAt: Date | null
  events: SessionEvent[]
  error: string | null
  listeners: Set<() => void>
  cancellationRequest: Promise<void> | undefined
  cancellation: Promise<void> | undefined
}

/** Options whose providers are replaced by focused tests. */
export interface ManagerOptions {
  now?: () => Date
  openUrl?: (url: string) => Promise<void>
  createClient?: (webUrl: string, timeoutMs: number) => IApiClient
}

/** Owns every process, event pump, waiter, and run created by one MCP server. */
export class CodexRunManager {
  private readonly services = new Map<ServiceId, ServiceRecord>()
  private readonly serviceByWorkspace = new Map<string, ServiceId>()
  private readonly starts = new Map<string, Promise<ServiceRecord>>()
  private readonly runs = new Map<RunId, RunRecord>()
  private readonly activeSessions = new Map<string, RunId>()
  private readonly reservedSessions = new Set<string>()
  private readonly now: () => Date
  private readonly openUrlImpl: (url: string) => Promise<void>
  private readonly createClient: (webUrl: string, timeoutMs: number) => IApiClient
  private closed = false

  /**
   * @param subprocess - managed process-tree provider.
   * @param config - resolved limits and storage policy.
   * @param options - test substitutions for clock, browser opener, and Web API client.
   */
  constructor(
    private readonly subprocess: SubprocessRuntime,
    private readonly config: ResolvedConfig,
    options: ManagerOptions = {},
  ) {
    this.now = options.now ?? (() => new Date())
    this.openUrlImpl = options.openUrl ?? (url => this.openUrl(url))
    this.createClient = options.createClient ?? ((webUrl, timeoutMs) => new CodexWebApiClient(webUrl, timeoutMs))
  }

  /**
   * Start or reuse the Web service for an absolute workspace.
   * @param input - workspace and optional browser-open request.
   * @returns the current service snapshot after readiness.
   */
  async startService(input: StartServiceInput): Promise<ServiceSnapshot> {
    this.assertOpen()
    const workspace = await resolveWorkspace(input.workspace, this.config.allowedWorkspaceRoots)
    let service = this.serviceForWorkspace(workspace)
    if (service === undefined) {
      const pending = this.starts.get(workspace) ?? this.launchService(workspace)
      this.starts.set(workspace, pending)
      try {
        service = await pending
      } finally {
        this.starts.delete(workspace)
      }
    }
    if (input.openBrowser === true) await this.openServiceRecord(service)
    return this.serviceSnapshot(service)
  }

  /**
   * Open one running service in the platform browser.
   * @param serviceId - service returned by this manager.
   * @returns the service snapshot after the opener settles.
   */
  async openService(serviceId: ServiceId): Promise<ServiceSnapshot> {
    const service = this.requireService(serviceId)
    await this.openServiceRecord(service)
    return this.serviceSnapshot(service)
  }

  /**
   * List services owned by this MCP process.
   * @returns services owned by this MCP process.
   */
  listServices(): ServiceSnapshot[] {
    return [...this.services.values()].map(service => this.serviceSnapshot(service))
  }

  /**
   * Cancel active runs and stop one complete Web process tree.
   * @param serviceId - service returned by this manager.
   * @returns the stopped service snapshot.
   */
  async stopService(serviceId: ServiceId): Promise<ServiceSnapshot> {
    const service = this.requireService(serviceId)
    const active = [...this.runs.values()].filter(run => run.serviceId === serviceId && run.status === 'running')
    await Promise.allSettled(active.map(run => this.requestCancellation(run)))
    await Promise.allSettled(active.map(run => this.waitForTerminal(run)))
    await this.terminate(service, 'stopped')
    return this.serviceSnapshot(service)
  }

  /**
   * Submit a task to a new or completed session and return immediately.
   * @param input - task, workspace, continuation, and browser options.
   * @returns the admitted run snapshot with its session deep link.
   */
  async start(input: StartRunInput): Promise<RunSnapshot> {
    this.assertOpen()
    const task = input.task.trim()
    if (task === '') throw new Error('task must not be empty')
    if (task.length > this.config.maxTaskCharacters) {
      throw new Error(`task exceeds the ${String(this.config.maxTaskCharacters)} character limit`)
    }
    const snapshot = await this.startService({ workspace: input.workspace, openBrowser: false })
    const service = this.requireService(snapshot.serviceId)
    const client = this.requireClient(service)
    const workspace = await value(client.workspace.create({ path: service.workspace }), 'workspace.create')
    const requested = input.sessionId?.trim()
    let sessionId: SessionId
    let baselineSeq = -1
    if (requested === undefined || requested === '') {
      const created = await value(client.sessions.create({ workspaceId: workspace.workspace.workspaceId }), 'session.create')
      sessionId = created.sessionId
    } else {
      sessionId = SessionId(requested)
      this.requireWorkspaceSession(workspace.workspace, sessionId)
      const [listed, history] = await Promise.all([
        value(client.sessions.list({}), 'session.list'),
        value(client.sessions.history({ sessionId, maxMessages: 1 }), 'session.history'),
      ])
      const summary = listed.items.find(item => item.sessionId === sessionId)
      if (summary === undefined) throw new Error(`unknown sessionId for this workspace: ${sessionId}`)
      if (summary.running) throw new Error(`Harness session is still running: ${sessionId}`)
      baselineSeq = highestSeq(history.events.map(entry => entry.event), -1)
    }

    const activeKey = this.activeKey(service.serviceId, sessionId)
    if (this.activeSessions.has(activeKey) || this.reservedSessions.has(activeKey)) {
      throw new Error(`Harness session already has an active MCP run: ${sessionId}`)
    }
    this.reservedSessions.add(activeKey)
    const pending: PendingRun = { events: [], baselineSeq }
    service.pending.set(sessionId, pending)
    let receipt: { accepted: true; messageId: MessageId }
    try {
      receipt = await value(client.sessions.prompt({
        sessionId,
        mode: 'queue',
        content: [{ type: 'text', text: task }],
      }), 'session.prompt')
    } catch (error) {
      service.pending.delete(sessionId)
      this.reservedSessions.delete(activeKey)
      throw error
    }

    const runId = randomUUID() as RunId
    const run: RunRecord = {
      runId,
      serviceId: service.serviceId,
      sessionId,
      messageId: receipt.messageId,
      sessionReused: requested !== undefined && requested !== '',
      baselineSeq,
      task,
      workspace: service.workspace,
      webUrl: sessionUrl(snapshot.webUrl, sessionId),
      status: 'running',
      cancelRequested: false,
      startedAt: this.now(),
      finishedAt: null,
      events: pending.events,
      error: null,
      listeners: new Set(),
      cancellationRequest: undefined,
      cancellation: undefined,
    }
    service.pending.delete(sessionId)
    this.runs.set(runId, run)
    this.activeSessions.set(activeKey, runId)
    this.reservedSessions.delete(activeKey)

    // Reconcile events that completed between prompt admission and run publication.
    try {
      const [listed, events] = await Promise.all([
        value(client.sessions.list({}), 'session.list'),
        this.eventsAfter(client, sessionId, baselineSeq),
      ])
      run.events = mergeEvents(run.events, events)
      service.sessionRunning.set(sessionId, listed.items.find(item => item.sessionId === sessionId)?.running ?? false)
      this.maybeSettle(service, run)
    } catch (error) {
      this.finish(run, 'failed', `could not reconcile admitted work: ${errorText(error)}`)
    }
    if (input.openBrowser === true) {
      try {
        await this.openServiceRecord(service, run.webUrl)
      } catch {
        // The run is already admitted; openServiceRecord recorded the failure on
        // the service snapshot, and the caller can retry with open_service.
      }
    }
    return this.runSnapshot(run)
  }

  /**
   * Insert a correction into the active agent turn represented by one run.
   * @param runId - active run returned by this manager.
   * @param task - correction or additional instruction for the active turn.
   * @returns the durable message admission and unchanged run identity.
   */
  async steer(runId: RunId, task: string): Promise<SteerRunResult> {
    const run = this.requireRun(runId)
    const instruction = task.trim()
    if (instruction === '') throw new Error('task must not be empty')
    if (instruction.length > this.config.maxTaskCharacters) {
      throw new Error(`task exceeds the ${String(this.config.maxTaskCharacters)} character limit`)
    }
    if (run.status !== 'running') throw new Error(`Harness run is not running: ${runId}`)
    if (run.cancelRequested) throw new Error(`Harness run cancellation is already requested: ${runId}`)
    const service = this.requireService(run.serviceId)
    const receipt = await value(this.requireClient(service).sessions.prompt({
      sessionId: SessionId(run.sessionId),
      mode: 'steer',
      content: [{ type: 'text', text: instruction }],
    }), 'session.prompt')
    return { accepted: true, messageId: receipt.messageId, run: this.runSnapshot(run) }
  }

  /**
   * Read one in-memory run snapshot.
   * @param runId - run returned by this manager.
   * @returns the current run snapshot.
   */
  get(runId: RunId): RunSnapshot {
    return this.runSnapshot(this.requireRun(runId))
  }

  /**
   * Wait for a run change or a bounded timeout without polling Host history.
   * @param runId - run returned by this manager.
   * @param timeoutMs - caller wait deadline, clamped to 30 seconds.
   * @returns the next available run snapshot.
   */
  async wait(runId: RunId, timeoutMs: number): Promise<RunSnapshot> {
    const run = this.requireRun(runId)
    if (run.status !== 'running' || timeoutMs === 0) return this.runSnapshot(run)
    const bounded = Math.min(Math.max(timeoutMs, 0), 30_000)
    await new Promise<void>((resolveWait) => {
      const done = (): void => {
        clearTimeout(timer)
        run.listeners.delete(done)
        resolveWait()
      }
      const timer = setTimeout(done, bounded)
      run.listeners.add(done)
    })
    return this.runSnapshot(run)
  }

  /**
   * List run snapshots, optionally for one service.
   * @param serviceId - optional service filter.
   * @returns matching snapshots retained by this MCP process.
   */
  list(serviceId?: ServiceId): RunSnapshot[] {
    return [...this.runs.values()]
      .filter(run => serviceId === undefined || run.serviceId === serviceId)
      .map(run => this.runSnapshot(run))
  }

  /**
   * Request idempotent cancellation and enforce bounded convergence. A Web
   * service that accepts cancellation but does not return the Agent to idle is
   * terminated and marked failed so it cannot retain stuck tools or sockets.
   * @param runId - run returned by this manager.
   * @returns the terminal snapshot after cancellation or unhealthy-service isolation.
   */
  async cancel(runId: RunId): Promise<RunSnapshot> {
    const run = this.requireRun(runId)
    if (run.status !== 'running') return this.runSnapshot(run)
    run.cancellation ??= this.convergeCancellation(run)
    await run.cancellation
    return this.runSnapshot(run)
  }

  /** Stop accepting work and await every owned service tree. */
  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    const active = [...this.runs.values()].filter(run => run.status === 'running')
    await Promise.allSettled(active.map(run => this.requestCancellation(run)))
    await Promise.allSettled(active.map(run => this.waitForTerminal(run)))
    const outcomes = await Promise.allSettled([...this.services.values()].map(service => this.terminate(service, 'stopped')))
    const failures = outcomes.flatMap(outcome => outcome.status === 'rejected' ? [outcome.reason as unknown] : [])
    if (failures.length === 1) throw failures[0]
    if (failures.length > 1) throw new AggregateError(failures, 'mcp-codex service teardown failed')
  }

  private async launchService(workspace: string): Promise<ServiceRecord> {
    await mkdir(serviceHome(this.config.dataDirectory, workspace), { recursive: true, mode: 0o700 })
    const command = webCommand(
      workspace,
      serviceHome(this.config.dataDirectory, workspace),
      this.config.credentialsPath,
    )
    const handle = this.subprocess.spawn({
      argv: command.argv,
      cwd: command.cwd,
      env: command.env,
      stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' },
      graceMs: this.config.stopGraceMs,
    })
    const service: ServiceRecord = {
      serviceId: randomUUID() as ServiceId,
      workspace,
      status: 'starting',
      webUrl: null,
      browserOpened: false,
      browserError: null,
      startedAt: this.now(),
      stoppedAt: null,
      handle,
      log: '',
      streams: new AbortController(),
      sessionRunning: new Map(),
      pending: new Map(),
      reconcile: undefined,
      terminating: false,
      termination: undefined,
    }
    this.services.set(service.serviceId, service)
    this.serviceByWorkspace.set(workspace, service.serviceId)

    const readiness = Promise.withResolvers<string>()
    void this.consumeOutput(service, handle.stdout, true, readiness).catch((error: unknown) => {
      readiness.reject(error)
    })
    void this.consumeOutput(service, handle.stderr, false, readiness).catch((error: unknown) => {
      readiness.reject(error)
    })
    void handle.done.then(
      (outcome) => {
        const detail = `code ${String(outcome.exitCode)}, signal ${String(outcome.signal)}`
        readiness.reject(new Error(`Harness Web service exited before readiness (${detail})`))
        this.onExit(service, detail)
      },
      (error: unknown) => {
        readiness.reject(error)
        this.onExit(service, errorText(error))
      },
    )
    try {
      service.webUrl = await withTimeout(readiness.promise, this.config.startupTimeoutMs, 'Harness Web readiness')
      service.client = this.createClient(service.webUrl, this.config.rpcTimeoutMs)
      await this.startEventPumps(service)
      service.status = 'running'
      return service
    } catch (error) {
      try {
        await this.terminate(service, 'failed')
      } catch (cleanupError) {
        throw new Error(
          `Harness Web startup failed: ${errorText(error)}; cleanup failed: ${errorText(cleanupError)}`,
          { cause: new AggregateError([error, cleanupError]) },
        )
      }
      throw error
    }
  }

  private async consumeOutput(
    service: ServiceRecord,
    stream: Readable | undefined,
    inspectReadiness: boolean,
    readiness: PromiseWithResolvers<string>,
  ): Promise<void> {
    if (stream === undefined) throw new Error('mcp-codex: Web child did not expose piped output')
    const decoder = new TextDecoder('utf-8', { fatal: true })
    let buffer = ''
    for await (const chunk of stream) {
      buffer += decoder.decode(chunk as Buffer, { stream: true })
      let newline: number
      while ((newline = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newline).replace(/\r$/u, '')
        buffer = buffer.slice(newline + 1)
        this.appendLog(service, line + '\n')
        if (inspectReadiness) {
          const url = readyUrl(line)
          if (url !== undefined) readiness.resolve(url)
        }
      }
    }
    buffer += decoder.decode()
    if (buffer !== '') {
      this.appendLog(service, buffer)
      if (inspectReadiness) {
        const url = readyUrl(buffer)
        if (url !== undefined) readiness.resolve(url)
      }
    }
  }

  private async startEventPumps(service: ServiceRecord): Promise<void> {
    const client = this.requireClient(service)
    const muxOpen = Promise.withResolvers<void>()
    const hostOpen = Promise.withResolvers<void>()
    this.pump(
      service,
      onOpen => client.events.mux({}, service.streams.signal, onOpen),
      (envelope) => { this.onMux(service, envelope.payload) },
      muxOpen,
    )
    this.pump(
      service,
      onOpen => client.events.host({}, service.streams.signal, onOpen),
      (envelope) => { this.onHost(service, envelope.payload) },
      hostOpen,
    )
    await withTimeout(Promise.all([muxOpen.promise, hostOpen.promise]), this.config.rpcTimeoutMs, 'Harness event streams')
  }

  private pump<T>(
    service: ServiceRecord,
    createStream: (onOpen: () => void) => AsyncIterable<T>,
    consume: (value: T) => void,
    opened: PromiseWithResolvers<void>,
  ): void {
    void (async () => {
      let openedOnce = false
      const hasOpened = (): boolean => openedOnce
      while (!isSignalAborted(service.streams.signal)) {
        try {
          const stream = createStream(() => {
            if (hasOpened()) this.reconcileAfterReconnect(service)
            else {
              openedOnce = true
              opened.resolve()
            }
          })
          for await (const value of stream) consume(value)
          if (!isSignalAborted(service.streams.signal)) throw new Error('event stream ended')
        } catch (error: unknown) {
          if (isSignalAborted(service.streams.signal)) return
          if (!hasOpened()) {
            opened.reject(error)
            this.failService(service, `Harness event stream failed before opening: ${errorText(error)}`)
            return
          }
          this.appendLog(service, `mcp-codex: reconnecting event stream after ${errorText(error)}\n`)
          await abortableDelay(this.config.eventReconnectDelayMs, service.streams.signal)
        }
      }
    })()
  }

  private reconcileAfterReconnect(service: ServiceRecord): void {
    if (service.reconcile !== undefined || service.streams.signal.aborted) return
    const reconciliation = this.reconcileService(service)
    service.reconcile = reconciliation
    void reconciliation.catch((error: unknown) => {
      if (!service.streams.signal.aborted) {
        this.failService(service, `Harness event history reconciliation failed: ${errorText(error)}`)
      }
    }).finally(() => {
      if (service.reconcile === reconciliation) service.reconcile = undefined
    })
  }

  private async reconcileService(service: ServiceRecord): Promise<void> {
    const client = this.requireClient(service)
    const listed = await value(client.sessions.list({}), 'session.list')
    const running = new Map(listed.items.map(item => [item.sessionId as string, item.running]))
    for (const [sessionId, pending] of service.pending) {
      pending.events = mergeEvents(
        pending.events,
        await this.eventsAfter(client, SessionId(sessionId), pending.baselineSeq),
      )
    }
    const active = [...this.runs.values()]
      .filter(run => run.serviceId === service.serviceId && run.status === 'running')
    for (const run of active) {
      run.events = mergeEvents(
        run.events,
        await this.eventsAfter(client, SessionId(run.sessionId), run.baselineSeq),
      )
      service.sessionRunning.set(run.sessionId, running.get(run.sessionId) ?? false)
      this.notify(run)
      this.maybeSettle(service, run)
    }
  }

  private onMux(service: ServiceRecord, frame: MuxFrame): void {
    if (frame.type !== 'session/event') return
    const sessionId = frame.sessionId as string
    const pending = service.pending.get(sessionId)
    if (pending !== undefined && frame.event.seq > pending.baselineSeq) pending.events.push(frame.event)
    const runId = this.activeSessions.get(this.activeKey(service.serviceId, sessionId))
    if (runId === undefined) return
    const run = this.runs.get(runId)
    if (run === undefined || frame.event.seq <= run.baselineSeq) return
    run.events = mergeEvents(run.events, [frame.event])
    this.notify(run)
    this.maybeSettle(service, run)
  }

  private onHost(service: ServiceRecord, frame: HostFrame): void {
    if (frame.type === 'host/session-status') {
      service.sessionRunning.set(frame.sessionId, frame.running)
      const runId = this.activeSessions.get(this.activeKey(service.serviceId, frame.sessionId))
      const run = runId === undefined ? undefined : this.runs.get(runId)
      if (run !== undefined) {
        this.notify(run)
        this.maybeSettle(service, run)
      }
    } else if (frame.type === 'host/agent-error') {
      const runId = this.activeSessions.get(this.activeKey(service.serviceId, frame.sessionId))
      const run = runId === undefined ? undefined : this.runs.get(runId)
      if (run !== undefined) this.finish(run, 'failed', frame.message)
    }
  }

  private maybeSettle(service: ServiceRecord, run: RunRecord): void {
    if (run.status !== 'running' || service.sessionRunning.get(run.sessionId) !== false) return
    const owned = run.events.filter(event => event.seq > run.baselineSeq)
    const admitted = owned.some(event => event.type === 'user/message' && event.data.id === run.messageId)
    const consumed = foldConsumedWork(owned)
    if (!admitted && !consumed.droppedUnrun) return
    if (consumed.droppedUnrun) {
      this.finish(run, run.cancelRequested ? 'cancelled' : 'failed', run.cancelRequested ? null : 'accepted work was discarded before it ran')
      return
    }
    const reason = consumed.end?.data.reason
    if (reason === undefined) return
    const outcome = outcomeOf(reason, run.cancelRequested)
    this.finish(run, outcome.status, outcome.error)
  }

  private finish(run: RunRecord, status: Exclude<RunStatus, 'running'>, error: string | null): void {
    if (run.status !== 'running') return
    run.status = status
    run.error = error
    run.finishedAt = this.now()
    this.activeSessions.delete(this.activeKey(run.serviceId, run.sessionId))
    this.notify(run)
  }

  private failService(service: ServiceRecord, message: string): void {
    if (service.status === 'stopped' || service.status === 'failed') return
    service.status = 'failed'
    service.stoppedAt = this.now()
    service.streams.abort()
    // A failed service must not outlive its owner: terminate the tree so a later
    // start for the same workspace cannot double-open the same persisted data home.
    service.handle.terminate()
    this.serviceByWorkspace.delete(service.workspace)
    for (const run of this.runs.values()) {
      if (run.serviceId === service.serviceId) this.finish(run, 'failed', message)
    }
  }

  private onExit(service: ServiceRecord, detail: string): void {
    if (service.status === 'stopped' || service.terminating) return
    this.failService(service, `Harness Web service exited before the task completed (${detail})`)
  }

  private async terminate(
    service: ServiceRecord,
    terminal: 'stopped' | 'failed',
    unfinishedRunError = 'Harness Web service stopped before the task completed',
  ): Promise<void> {
    if (service.status === 'stopped' && terminal === 'stopped') return
    if (service.termination !== undefined) return service.termination
    const operation = (async (): Promise<void> => {
      service.terminating = true
      service.streams.abort()
      service.handle.terminate()
      const exited = await service.handle.waitForExit(AbortSignal.timeout(this.config.stopGraceMs + 1_000))
      if (!exited) throw new Error(`mcp-codex: Web process tree ${String(service.handle.pid)} did not exit`)
      service.status = terminal
      service.stoppedAt ??= this.now()
      this.serviceByWorkspace.delete(service.workspace)
      for (const run of this.runs.values()) {
        if (run.serviceId === service.serviceId && run.status === 'running') {
          this.finish(run, 'failed', unfinishedRunError)
        }
      }
    })()
    service.termination = operation
    try {
      await operation
    } catch (error) {
      this.failService(service, `Harness Web process tree cleanup failed: ${errorText(error)}`)
      throw error
    } finally {
      service.terminating = false
      if (service.termination === operation) service.termination = undefined
    }
  }

  private requestCancellation(run: RunRecord): Promise<void> {
    if (run.status !== 'running') return Promise.resolve()
    if (run.cancellationRequest !== undefined) return run.cancellationRequest
    run.cancelRequested = true
    this.notify(run)
    const service = this.requireService(run.serviceId)
    const request = (async (): Promise<void> => {
      await value(this.requireClient(service).sessions.cancel({ sessionId: SessionId(run.sessionId) }), 'session.cancel')
    })()
    run.cancellationRequest = request
    return request
  }

  private async convergeCancellation(run: RunRecord): Promise<void> {
    const service = this.requireService(run.serviceId)
    try {
      await this.requestCancellation(run)
    } catch (error) {
      if (run.status !== 'running') return
      await this.terminate(
        service,
        'failed',
        `Harness cancellation request failed; the unresponsive Web service was terminated: ${errorText(error)}`,
      )
      return
    }
    await this.waitForTerminal(run)
    if (run.status !== 'running') return
    await this.terminate(
      service,
      'failed',
      `Harness cancellation did not reach Agent idle within ${String(this.config.stopGraceMs)}ms; the unresponsive Web service was terminated`,
    )
  }

  private async openServiceRecord(service: ServiceRecord, url = service.webUrl): Promise<void> {
    if (service.status !== 'running' || url === null) throw new Error('Harness Web service is not running')
    try {
      await this.openUrlImpl(url)
      service.browserOpened = true
      service.browserError = null
    } catch (error) {
      service.browserError = errorText(error)
      throw error
    }
  }

  private async eventsAfter(client: IApiClient, sessionId: SessionId, baselineSeq: number): Promise<SessionEvent[]> {
    const events: SessionEvent[] = []
    let beforeSeq: number | undefined
    while (true) {
      const page = await value(client.sessions.history({
        sessionId,
        maxMessages: 100,
        ...beforeSeq === undefined ? {} : { beforeSeq },
      }), 'session.history')
      const pageEvents = page.events.map(entry => entry.event)
      events.push(...pageEvents.filter(event => event.seq > baselineSeq))
      const oldest = pageEvents.reduce((value, event) => Math.min(value, event.seq), Number.POSITIVE_INFINITY)
      if (!page.hasMore || oldest <= baselineSeq || !Number.isFinite(oldest)) break
      beforeSeq = oldest
    }
    return mergeEvents([], events)
  }

  private async waitForTerminal(run: RunRecord): Promise<void> {
    if (run.status !== 'running') return
    await new Promise<void>((resolveWait) => {
      const done = (): void => {
        if (run.status === 'running') return
        clearTimeout(timer)
        run.listeners.delete(done)
        resolveWait()
      }
      const timer = setTimeout(() => {
        run.listeners.delete(done)
        resolveWait()
      }, this.config.stopGraceMs)
      run.listeners.add(done)
    })
  }

  private async openUrl(url: string): Promise<void> {
    const target = new URL(url)
    if (target.protocol !== 'http:' || (target.hostname !== '127.0.0.1' && target.hostname !== 'localhost')) {
      throw new Error('mcp-codex: browser opener accepts loopback HTTP URLs only')
    }
    const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer.exe' : 'xdg-open'
    const executable = await this.subprocess.resolveExecutable(command)
    const handle = this.subprocess.spawn({
      argv: [executable, target.href],
      cwd: process.cwd(),
      stdio: { stdin: 'ignore', stdout: { maxBytes: 4_096 }, stderr: { maxBytes: 4_096 } },
      graceMs: this.config.stopGraceMs,
    })
    // Only the direct opener settles the call; the launched browser legitimately
    // outlives it, so the tree wait would block the tool call until the browser closes.
    let outcome: SubprocessOutcome
    try {
      outcome = await withTimeout(handle.done, this.config.browserOpenTimeoutMs, 'browser opener')
    } catch (error) {
      handle.terminate()
      throw error
    }
    if (outcome.exitCode !== 0) throw new Error(`${command} exited with code ${String(outcome.exitCode)}`)
  }

  private appendLog(service: ServiceRecord, text: string): void {
    service.log = `${service.log}${text}`.slice(-this.config.maxLogCharacters)
  }

  private notify(run: RunRecord): void {
    for (const listener of [...run.listeners]) {
      try {
        listener()
      } catch (error) {
        process.stderr.write(`mcp-codex: run listener failed: ${errorText(error)}\n`)
      }
    }
  }

  private serviceForWorkspace(workspace: string): ServiceRecord | undefined {
    const id = this.serviceByWorkspace.get(workspace)
    const service = id === undefined ? undefined : this.services.get(id)
    return service?.status === 'running' ? service : undefined
  }

  private requireService(id: ServiceId): ServiceRecord {
    const service = this.services.get(id)
    if (service === undefined) throw new Error(`unknown serviceId: ${id}`)
    return service
  }

  private requireRun(id: RunId): RunRecord {
    const run = this.runs.get(id)
    if (run === undefined) throw new Error(`unknown runId: ${id}`)
    return run
  }

  private requireClient(service: ServiceRecord): IApiClient {
    if (service.client === undefined) throw new Error('Harness Web service has no API client')
    return service.client
  }

  private requireWorkspaceSession(workspace: WorkspaceView, sessionId: SessionId): void {
    if (!workspace.sessionIds.includes(sessionId)) throw new Error(`unknown sessionId for this workspace: ${sessionId}`)
  }

  private assertOpen(): void {
    if (this.closed) throw new Error('mcp-codex: supervisor is closed')
  }

  private activeKey(serviceId: ServiceId, sessionId: string): string {
    return `${serviceId}:${sessionId}`
  }

  private serviceSnapshot(service: ServiceRecord): ServiceSnapshot {
    return {
      serviceId: service.serviceId,
      workspace: service.workspace,
      status: service.status,
      webUrl: service.webUrl,
      browserOpened: service.browserOpened,
      browserError: service.browserError,
      startedAt: service.startedAt.toISOString(),
      stoppedAt: service.stoppedAt?.toISOString() ?? null,
      processId: service.handle.pid < 0 ? null : service.handle.pid,
      logTail: service.log,
    }
  }

  private runSnapshot(run: RunRecord): RunSnapshot {
    const full = assistantText(run.events)
    const retained = utf8Tail(full, this.config.maxAssistantTextBytes)
    return {
      runId: run.runId,
      serviceId: run.serviceId,
      sessionId: run.sessionId,
      sessionReused: run.sessionReused,
      task: run.task,
      workspace: run.workspace,
      webUrl: run.webUrl,
      status: run.status,
      cancelRequested: run.cancelRequested,
      startedAt: run.startedAt.toISOString(),
      finishedAt: run.finishedAt?.toISOString() ?? null,
      assistantText: retained.text,
      assistantTextBytes: retained.bytes,
      assistantTextTruncated: retained.truncated,
      lastToolEvents: toolActivity(run.events, this.config.maxToolEvents, this.config.maxToolEventBytes),
      lastEventSeq: highestSeq(run.events, run.baselineSeq),
      error: run.error,
    }
  }
}

async function value<T>(response: Promise<RpcResponse<T>>, method: string): Promise<T> {
  const envelope = await response
  if (!envelope.result.ok) {
    throw new Error(`${method} failed: ${envelope.result.error.code}: ${envelope.result.error.message}`)
  }
  return envelope.result.value
}

function highestSeq(events: readonly SessionEvent[], fallback: number): number {
  return events.reduce((highest, event) => Math.max(highest, event.seq), fallback)
}

function mergeEvents(left: readonly SessionEvent[], right: readonly SessionEvent[]): SessionEvent[] {
  const bySeq = new Map(left.map(event => [event.seq, event]))
  for (const event of right) bySeq.set(event.seq, event)
  return [...bySeq.values()].sort((a, b) => a.seq - b.seq)
}

function assistantText(events: readonly SessionEvent[]): string {
  const messages = events.flatMap(event => event.type === 'assistant/message'
    ? [event.data.message.content]
    : [])
  const text = messages.flatMap(content => content.flatMap(block => block.type === 'text' ? [block.text] : []))
  if (text.length > 0) return text.join('\n')
  return messages.flatMap(content => content.flatMap(block => block.type === 'reasoning' ? [block.text] : []))
    .join('\n')
}

/**
 * Fold the owned suffix into its most recent bounded tool-activity window.
 * @param events - the run's owned event suffix, in seq order.
 * @param maxEvents - retained window size.
 * @param maxFieldBytes - per-field UTF-8 cap for arguments and result summaries.
 * @returns the retained tail of the window, newest last.
 */
function toolActivity(
  events: readonly SessionEvent[],
  maxEvents: number,
  maxFieldBytes: number,
): ToolActivity[] {
  const activity: ToolActivity[] = []
  for (const event of events) {
    if (event.type === 'tool/call') {
      const retained = utf8Tail(event.data.arguments, maxFieldBytes)
      activity.push({
        kind: 'call',
        callId: event.data.callId,
        name: event.data.name,
        arguments: retained.text,
        truncated: retained.truncated,
      })
    } else if (event.type === 'tool/result') {
      const retained = utf8Tail(toolResultSummary(event.data.message), maxFieldBytes)
      activity.push({
        kind: 'result',
        callId: event.data.message.source.callId,
        summary: retained.text,
        error: event.data.error === undefined ? null : `${event.data.error.name}: ${event.data.error.code}`,
        truncated: retained.truncated,
      })
    }
  }
  return activity.slice(-maxEvents)
}

/** Join the text blocks of one tool-result message. */
function toolResultSummary(message: ToolResultMessage): string {
  const blocks = message.content[0].content
  const text = blocks.flatMap(block => block.type === 'text' ? [block.text] : [])
  return text.length === 0 ? '' : text.join('\n')
}

function outcomeOf(reason: TurnEndReason, cancelRequested: boolean): {
  status: Exclude<RunStatus, 'running'>
  error: string | null
} {
  switch (reason.kind) {
    case 'completed': return { status: 'succeeded', error: null }
    case 'aborted':
      return reason.reason.kind === 'user' || cancelRequested
        ? { status: 'cancelled', error: null }
        : { status: 'failed', error: `turn aborted: ${reason.reason.kind}` }
    case 'error': return { status: 'failed', error: `${reason.error.code}: ${reason.error.message}` }
    case 'blocked': return { status: 'failed', error: 'turn blocked' }
    case 'interrupted': return { status: 'failed', error: 'turn interrupted' }
    case 'max-tokens': return { status: 'failed', error: 'turn reached the output-token limit' }
    default: return { status: 'failed', error: `unknown turn end: ${JSON.stringify(reason)}` }
  }
}

function sessionUrl(base: string | null, sessionId: string): string {
  if (base === null) throw new Error('Harness Web service did not provide a URL')
  const url = new URL('/', base)
  url.searchParams.set('sessionId', sessionId)
  return url.href
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  const timeout = Promise.withResolvers<T>()
  const timer = setTimeout(() => {
    timeout.reject(new Error(`${label} did not complete within ${String(timeoutMs)}ms`))
  }, timeoutMs)
  try {
    return await Promise.race([promise, timeout.promise])
  } finally {
    clearTimeout(timer)
  }
}

/** Read live signal state without preserving a stale control-flow narrowing across awaits. */
function isSignalAborted(signal: AbortSignal): boolean {
  return signal.aborted
}

async function abortableDelay(timeoutMs: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return
  await new Promise<void>((resolveDelay) => {
    const done = (): void => {
      clearTimeout(timer)
      signal.removeEventListener('abort', done)
      resolveDelay()
    }
    const timer = setTimeout(done, timeoutMs)
    signal.addEventListener('abort', done, { once: true })
  })
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
