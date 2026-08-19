import { randomUUID } from 'node:crypto'
import { openUrl, sessionUrl } from '../browser-opener.js'
import type { RelayConfig } from '../config.js'
import { createHttpHarnessGateway, HostRpcError, type HarnessGatewayFacade } from '../harness-gateway/index.js'
import { ModelSelectionFacade } from '../model-selection.js'
import { ExternalPermissionProvider, PermissionGatewayFacade } from '../permission-gateway/index.js'
import { PACKAGE_NAME } from '../product-identity/index.js'
import { resolvePrompt } from '../prompt.js'
import { mergeEvents, stringAt, userRpcId } from '../run-events.js'
import { SessionRoutingFacade, type WorkspaceSessionSummary } from '../session-routing/index.js'
import { RelayStateStore } from '../state-store.js'
import type { ModelSelection, OperationRecord, PermissionLease, PersistedRelayState, PromptPart, RunSnapshot, ServiceSnapshot } from '../types.js'
import { WorkspaceRoutingFacade, type WorkspaceResolution } from '../workspace-routing/index.js'
import { RelayError } from './errors.js'
import { cloneRun, delay, errorText, persistedSnapshot } from './helpers.js'
import type { RunRecord } from './internal-types.js'
import { OperationJournal } from './operation-journal.js'
import { PermissionController } from './permission-controller.js'
import { PromptAdmissionController } from './prompt-admission-controller.js'
import { RunReconciler } from './run-reconciler.js'
import type { RelayFacadeOptions } from './relay-facade-options.js'
import { operationRequest, type StartRunInput, validateStartRunInput } from './run-input.js'

interface ServiceRecord extends ServiceSnapshot {}

export class RelayFacade {
  private readonly gateway: HarnessGatewayFacade
  private readonly modelSelection: ModelSelectionFacade
  private readonly stateStore: RelayStateStore
  private readonly ready: Promise<void>
  private readonly services = new Map<string, ServiceRecord>()
  private readonly serviceByWorkspace = new Map<string, string>()
  private readonly runs = new Map<string, RunRecord>()
  private readonly activeSessions = new Map<string, string>()
  private readonly operations = new Map<string, OperationRecord>()
  private readonly permissionLeases = new Map<string, PermissionLease>()
  private readonly serviceStarts = new Map<string, Promise<ServiceSnapshot>>()
  private readonly sessionStarts = new Set<string>()
  private readonly journal: OperationJournal
  private readonly permissions: PermissionController
  private readonly reconciler: RunReconciler
  private readonly promptAdmission: PromptAdmissionController
  private readonly workspaceRouting: WorkspaceRoutingFacade
  private readonly sessionRouting: SessionRoutingFacade

  constructor(private readonly config: RelayConfig, fetchImpl: typeof fetch = fetch, gateway?: HarnessGatewayFacade, options: RelayFacadeOptions = {}) {
    this.gateway = gateway ?? createHttpHarnessGateway(config.hostUrl, config.rpcTimeoutMs, fetchImpl)
    this.modelSelection = new ModelSelectionFacade(this.gateway)
    this.stateStore = new RelayStateStore(config.stateFile, options.stateStore)
    this.journal = new OperationJournal(
      this.operations,
      () => this.persistState(),
      candidate => this.stateStore.claimOperation(candidate),
    )
    const permissionGateway = options.permissionGateway ?? new PermissionGatewayFacade(new ExternalPermissionProvider(this.gateway))
    this.permissions = new PermissionController(permissionGateway, this.permissionLeases, () => this.persistState(), config.permissionLeaseMs)
    this.reconciler = new RunReconciler(this.gateway, config, this.activeSessions, this.operations, this.journal, this.permissions)
    this.promptAdmission = new PromptAdmissionController(this.gateway, this.journal, this.reconciler)
    this.workspaceRouting = new WorkspaceRoutingFacade(this.gateway, config.allowedWorkspaceRoots)
    this.sessionRouting = new SessionRoutingFacade(this.gateway)
    this.ready = this.restoreState()
  }

  async doctor(): Promise<object> {
    await this.ready
    const host = await this.gateway.describeHost()
    const workspacePolicy = await this.workspaceRouting.describePolicy()
    return {
      ok: true,
      package: { name: PACKAGE_NAME, version: typeof __DSH_RELAY_VERSION__ === 'string' ? __DSH_RELAY_VERSION__ : 'development' },
      host: { url: this.config.hostUrl, ...host },
      workspacePolicy,
      processOwnership: 'external-host',
      state: {
        file: this.config.stateFile,
        services: this.services.size,
        runs: this.runs.size,
        operations: this.operations.size,
        permissionLeases: this.permissionLeases.size,
        recoveryWarning: this.stateStore.recoveryWarning,
      },
    }
  }

  async startService(input: { workspace: string; openBrowser?: boolean }): Promise<ServiceSnapshot> {
    await this.ready
    const workspace = await this.workspaceRouting.resolve(input.workspace)
    const pending = this.serviceStarts.get(workspace.path)
    if (pending !== undefined) return pending
    const started = this.startResolvedService(workspace, input.openBrowser === true)
    this.serviceStarts.set(workspace.path, started)
    try { return await started }
    finally { this.serviceStarts.delete(workspace.path) }
  }

  private async startResolvedService(resolution: WorkspaceResolution, openBrowser: boolean): Promise<ServiceSnapshot> {
    const existingId = this.serviceByWorkspace.get(resolution.path)
    const existing = existingId === undefined ? undefined : this.services.get(existingId)
    if (existing?.status === 'running') {
      if (openBrowser) await this.open(existing, existing.webUrl)
      return { ...existing }
    }
    await this.gateway.describeHost()
    const workspace = resolution.workspace
      ?? await this.gateway.createWorkspace(resolution.path)
    const service: ServiceRecord = {
      serviceId: randomUUID(),
      workspaceId: workspace.workspaceId,
      workspace: workspace.path,
      status: 'running',
      webUrl: this.config.hostUrl,
      browserOpened: false,
      browserError: null,
      managedProcess: false,
      processId: null,
      attachedAt: new Date().toISOString(),
      stoppedAt: null,
    }
    this.services.set(service.serviceId, service)
    this.serviceByWorkspace.set(workspace.path, service.serviceId)
    if (openBrowser) await this.open(service, service.webUrl)
    await this.persistState()
    return { ...service }
  }

  async openService(serviceId: string): Promise<ServiceSnapshot> {
    await this.ready
    const service = this.requireService(serviceId)
    if (service.status !== 'running') throw new Error(`service is not running: ${serviceId}`)
    await this.open(service, service.webUrl)
    await this.persistState()
    return { ...service }
  }

  async listServices(): Promise<ServiceSnapshot[]> {
    await this.ready
    return [...this.services.values()].map(service => ({ ...service }))
  }

  async listWorkspaces(): Promise<object> {
    await this.ready
    const policy = await this.workspaceRouting.describePolicy()
    return {
      mode: policy.mode,
      roots: policy.roots,
      workspaces: policy.registered,
    }
  }

  async listWorkspaceSessions(workspacePath: string): Promise<object> {
    await this.ready
    const resolution = await this.workspaceRouting.resolve(workspacePath)
    if (resolution.workspace === null) {
      throw new Error('workspace is allowed but not registered in Harness')
    }
    const catalog = await this.workspaceRouting.listRegistered()
    const sessions: WorkspaceSessionSummary[] = await this.sessionRouting.list(
      resolution.workspace,
      catalog.archivedSessionIds,
    )
    return {
      workspace: {
        workspaceId: resolution.workspace.workspaceId,
        path: resolution.workspace.path,
        title: resolution.workspace.title,
      },
      sessions,
    }
  }

  async stopService(serviceId: string): Promise<ServiceSnapshot> {
    await this.ready
    const service = this.requireService(serviceId)
    if (service.status === 'running') {
      service.status = 'stopped'
      service.stoppedAt = new Date().toISOString()
      this.serviceByWorkspace.delete(service.workspace)
    }
    await this.persistState()
    return { ...service }
  }

  async startRun(input: StartRunInput, clientPrincipalId: string = this.config.clientPrincipalId): Promise<RunSnapshot> {
    await this.ready
    validateStartRunInput(input)
    const prompt = resolvePrompt(input, this.config)
    const prepared = await this.journal.prepare(clientPrincipalId, input.operationKind ?? 'start', randomUUID(), operationRequest(input, prompt.summary, prompt.imageCount), input.idempotencyKey)
    const operation = prepared.record
    if (prepared.replayed) {
      const latest = await this.stateStore.load()
      const latestOperation = latest?.operations.find(candidate => candidate.operationId === operation.operationId)
      if (latestOperation !== undefined) {
        Object.assign(operation, latestOperation)
        this.operations.set(operation.operationId, operation)
      }
      const persisted = latest?.runs.find(candidate => candidate.snapshot.runId === operation.runId)
      if (persisted !== undefined && !this.runs.has(operation.runId)) {
        const snapshot = cloneRun(persisted.snapshot)
        this.runs.set(operation.runId, { snapshot, baselineSeq: persisted.baselineSeq, promptRpcId: persisted.promptRpcId, events: [] })
        const service = latest?.services.find(candidate => candidate.serviceId === snapshot.serviceId)
        if (service !== undefined) this.services.set(service.serviceId, { ...service })
        if (snapshot.status === 'running') this.activeSessions.set(this.activeKey(snapshot.serviceId, snapshot.sessionId), snapshot.runId)
      }
    }
    const replay = this.runs.get(operation.runId)
    if (prepared.replayed && replay !== undefined) {
      if (replay.snapshot.status === 'running' && replay.snapshot.promptAdmission !== 'accepted' && operation.state === 'prepared') {
        if (Date.now() - Date.parse(operation.updatedAt) < this.config.rpcTimeoutMs) {
          throw new RelayError('OPERATION_IN_PROGRESS', 'The original caller still owns this prepared operation', true, {
            operationId: operation.operationId, runId: operation.runId, lastKnownState: operation.state, nextAction: 'wait',
          })
        }
        await this.promptAdmission.submit(replay, operation, prompt.content)
        await this.persistState()
        return cloneRun(replay.snapshot)
      }
      await this.reconciler.refresh(replay)
      if (replay.snapshot.status === 'running' && replay.snapshot.promptAdmission !== 'accepted'
        && operation.state === 'submitted') {
        if (Date.now() - Date.parse(operation.updatedAt) < this.config.rpcTimeoutMs) {
          throw new RelayError('OPERATION_IN_PROGRESS', 'The original caller still owns this prepared operation', true, {
            operationId: operation.operationId, runId: operation.runId, lastKnownState: operation.state, nextAction: 'wait',
          })
        }
        await this.promptAdmission.submit(replay, operation, prompt.content)
        await this.persistState()
      }
      return cloneRun(replay.snapshot)
    }
    if (prepared.replayed && operation.state === 'prepared' && Date.now() - Date.parse(operation.updatedAt) < this.config.rpcTimeoutMs) {
      throw new RelayError('OPERATION_IN_PROGRESS', 'The original caller has not persisted a recoverable run yet', true, {
        operationId: operation.operationId, runId: operation.runId, lastKnownState: operation.state, nextAction: 'wait',
      })
    }
    if (prepared.replayed && operation.state !== 'prepared') throw this.journal.unknown(operation, 'The original operation has no recoverable run snapshot')
    const service = await this.startService({ workspace: input.workspace })
    const catalog = await this.workspaceRouting.listRegistered()
    const workspace = catalog.items.find(item => item.workspaceId === service.workspaceId)
    if (workspace === undefined) throw new Error(`Harness workspace is no longer registered: ${service.workspaceId}`)
    const session = await this.sessionRouting.resolve(workspace, {
      ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
      ...(input.sessionMode === undefined ? {} : { sessionMode: input.sessionMode }),
      ...(input.agentPreset === undefined ? {} : { agentPreset: input.agentPreset }),
      archivedSessionIds: catalog.archivedSessionIds,
    })
    const activeKey = this.activeKey(service.serviceId, session.sessionId)
    if (this.activeSessions.has(activeKey) || this.sessionStarts.has(session.sessionId)) throw new Error(`session already has an active DSH Relay run: ${session.sessionId}`)
    this.sessionStarts.add(session.sessionId)
    let sessionLease: Awaited<ReturnType<RelayStateStore['acquireSessionLease']>> | null = null
    try { sessionLease = session.reused ? await this.stateStore.acquireSessionLease(session.sessionId) : null }
    catch (error) { this.sessionStarts.delete(session.sessionId); throw error }
    const runId = operation.runId
    const promptRpcId = operation.rpcId
    this.activeSessions.set(activeKey, runId)
    let selection: ModelSelection | null = null
    let restore: RunSnapshot['modelDefaultRestore'] = 'not-needed'
    const warnings: string[] = []
    let run: RunRecord | null = null
    try {
      if (session.reused) await this.sessionRouting.assertIdle(session.sessionId)
      if (input.provider !== undefined && input.model !== undefined) {
        const selected = await this.modelSelection.select(session.sessionId, {
          provider: input.provider,
          model: input.model,
          ...(input.reasoningEffort === undefined ? {} : { reasoningEffort: input.reasoningEffort }),
        })
        selection = selected.selected
        restore = selected.restore
        warnings.push(...selected.warnings)
      }
      const permissionPreset = input.permissionPreset ?? 'read-only'
      await this.permissions.selectForRun(session.sessionId, operation.operationId, permissionPreset, true)
      const baselineSeq = await this.reconciler.latestSeq(session.sessionId)
      const snapshot: RunSnapshot = {
        runId,
        operationId: operation.operationId,
        idempotencyKey: operation.idempotencyKey,
        serviceId: service.serviceId,
        sessionId: session.sessionId,
        sessionReused: session.reused,
        parentRunId: input.parentRunId ?? null,
        workspace: service.workspace,
        webUrl: sessionUrl(this.config.hostUrl, session.sessionId),
        status: 'running',
        modelSelection: selection,
        permissionPreset,
        agentPreset: input.agentPreset ?? session.agentPreset,
        modelDefaultRestore: restore,
        warnings,
        task: prompt.summary,
        taskPersisted: true,
        taskImageCount: prompt.imageCount,
        cancelRequested: false,
        startedAt: new Date().toISOString(),
        lastProgressAt: new Date().toISOString(),
        finishedAt: null,
        promptAdmission: 'pending',
        promptMessageId: null,
        assistantText: '',
        assistantTextBytes: 0,
        assistantTextTruncated: false,
        lastEventSeq: baselineSeq,
        error: null,
      }
      run = { snapshot, baselineSeq, promptRpcId, events: [] }
      this.runs.set(runId, run)
      await this.persistState()
      await this.promptAdmission.submit(run, operation, prompt.content)
      if (snapshot.status === 'running') await this.reconciler.refresh(run)
      if (input.openBrowser === true) {
        try {
          await this.open(this.requireService(service.serviceId), snapshot.webUrl)
        } catch (error) {
          snapshot.warnings.push(`The run was admitted, but its browser page could not be opened: ${errorText(error)}`)
        }
      }
      await this.persistState()
      return cloneRun(snapshot)
    } catch (error) {
      if (run === null) {
        this.activeSessions.delete(activeKey)
        await this.permissions.restoreSession(session.sessionId, operation.operationId)
        if (operation.state === 'prepared') await this.journal.transition(operation, 'failed', { error: errorText(error) })
      } else if (run.snapshot.promptAdmission === 'pending') {
        run.snapshot.promptAdmission = 'rejected'
        if (operation.state !== 'failed') await this.journal.transition(operation, 'failed', { error: errorText(error) })
        await this.reconciler.finalize(run, 'failed', errorText(error))
        await this.persistState()
      } else if (run.snapshot.promptAdmission === 'rejected') {
        await this.permissions.restoreSession(session.sessionId, operation.operationId)
      }
      throw error
    } finally {
      this.sessionStarts.delete(session.sessionId)
      await sessionLease?.release()
    }
  }

  async replyRun(runId: string, input: Omit<StartRunInput, 'workspace' | 'sessionId' | 'sessionMode' | 'agentPreset' | 'parentRunId'>, clientPrincipalId: string = this.config.clientPrincipalId): Promise<RunSnapshot> {
    await this.ready
    const parent = this.requireRun(runId)
    await this.reconciler.refresh(parent)
    if (parent.snapshot.status === 'running') throw new Error(`run is still active: ${runId}`)
    return this.startRun({
      ...input,
      workspace: parent.snapshot.workspace,
      sessionId: parent.snapshot.sessionId,
      permissionPreset: input.permissionPreset ?? parent.snapshot.permissionPreset,
      parentRunId: runId,
      operationKind: 'reply',
    }, clientPrincipalId)
  }

  async steerRun(runId: string, input: { task?: string; content?: PromptPart[]; idempotencyKey?: string }, clientPrincipalId: string = this.config.clientPrincipalId): Promise<object> {
    await this.ready
    const run = this.requireRun(runId)
    const prompt = resolvePrompt(input, this.config)
    const prepared = await this.journal.prepare(clientPrincipalId, 'steer', runId, { runId, summary: prompt.summary, imageCount: prompt.imageCount }, input.idempotencyKey)
    const operation = prepared.record
    if (prepared.replayed && operation.state === 'acknowledged' && operation.messageId !== null) {
      return { accepted: true, messageId: operation.messageId, durable: true, replayed: true, operationId: operation.operationId, run: cloneRun(run.snapshot) }
    }
    if (prepared.replayed && operation.state !== 'prepared') {
      const reconciled = await this.reconcileOperation(operation.operationId)
      if (reconciled.operation.state === 'acknowledged' || reconciled.operation.state === 'reconciled') {
        return { accepted: true, messageId: reconciled.operation.messageId, durable: true, replayed: true, operationId: operation.operationId, run: cloneRun(run.snapshot) }
      }
      throw this.journal.unknown(operation, 'The steer operation outcome is not yet reconciled')
    }
    if (prepared.replayed && Date.now() - Date.parse(operation.updatedAt) < this.config.rpcTimeoutMs) {
      throw new RelayError('OPERATION_IN_PROGRESS', 'The original caller still owns this prepared steer', true, { operationId: operation.operationId, runId, lastKnownState: operation.state, nextAction: 'wait' })
    }
    await this.reconciler.refresh(run)
    if (run.snapshot.status !== 'running') {
      await this.journal.transition(operation, 'failed', { error: `run is terminal: ${runId}` })
      throw new Error(`run is terminal: ${runId}`)
    }
    await this.journal.transition(operation, 'submitted')
    let accepted: { accepted: true; rpcId: string; messageId?: string }
    try {
      accepted = await this.gateway.submitPrompt(run.snapshot.sessionId, 'steer', prompt.content, operation.rpcId, actualRpcId => this.journal.correlateRpcId(operation, actualRpcId))
    } catch (error) {
      if (error instanceof HostRpcError && error.definitiveRejection) {
        await this.journal.transition(operation, 'failed', { error: errorText(error) })
        throw error
      }
      await this.journal.transition(operation, 'unknown', { error: errorText(error) })
      throw this.journal.unknown(operation, 'The steer prompt response was unavailable; inspect run status before retrying')
    }
    if (accepted.messageId !== undefined) {
      await this.journal.transition(operation, 'acknowledged', { messageId: accepted.messageId })
      return { accepted: true, messageId: accepted.messageId, durable: false, operationId: operation.operationId, run: cloneRun(run.snapshot) }
    }
    const deadline = Date.now() + Math.min(this.config.rpcTimeoutMs, 10_000)
    let messageId: string | null = null
    while (Date.now() <= deadline) {
      run.events = mergeEvents(run.events, await this.reconciler.historyAfter(run.snapshot.sessionId, run.baselineSeq))
      const message = run.events.find(event => userRpcId(event) === operation.rpcId)
      messageId = message === undefined ? null : stringAt(message.data, 'id')
      if (messageId !== null) break
      await delay(this.config.pollIntervalMs)
    }
    if (messageId === null) {
      await this.journal.transition(operation, 'unknown', { error: 'Durable user message was not observed before timeout' })
      throw this.journal.unknown(operation, 'The steer prompt was accepted but its durable message was not observed before timeout')
    }
    await this.journal.transition(operation, 'acknowledged', { messageId })
    return { accepted: true, messageId, durable: true, operationId: operation.operationId, run: cloneRun(run.snapshot) }
  }

  async getRun(runId: string): Promise<RunSnapshot> {
    await this.ready
    const run = this.requireRun(runId)
    await this.reconciler.refresh(run)
    await this.persistState()
    return cloneRun(run.snapshot)
  }

  async openRun(runId: string): Promise<RunSnapshot> {
    await this.ready
    const run = this.requireRun(runId)
    const service = this.requireService(run.snapshot.serviceId)
    await this.open(service, run.snapshot.webUrl)
    await this.persistState()
    return cloneRun(run.snapshot)
  }

  async waitRun(runId: string, timeoutMs: number): Promise<RunSnapshot> {
    await this.ready
    const run = this.requireRun(runId)
    const deadline = Date.now() + timeoutMs
    do {
      await this.reconciler.refresh(run)
      if (run.snapshot.status !== 'running' || Date.now() >= deadline) break
      await delay(Math.min(this.config.pollIntervalMs, Math.max(0, deadline - Date.now())))
    } while (Date.now() <= deadline)
    await this.persistState()
    return cloneRun(run.snapshot)
  }

  async listRuns(serviceId?: string): Promise<RunSnapshot[]> {
    await this.ready
    const selected = [...this.runs.values()].filter(run => serviceId === undefined || run.snapshot.serviceId === serviceId)
    await Promise.all(selected.filter(run => run.snapshot.status === 'running').map(run => this.reconciler.refresh(run)))
    await this.persistState()
    return selected.map(run => cloneRun(run.snapshot))
  }
  async getOperation(operationId: string): Promise<OperationRecord> {
    await this.ready
    return { ...this.requireOperation(operationId) }
  }
  async reconcilePermissions(sessionId: string): Promise<{ sessionId: string; restored: boolean }> {
    await this.ready
    return { sessionId, restored: await this.permissions.restoreSession(sessionId) }
  }

  async reconcileOperation(operationId: string): Promise<{ operation: OperationRecord; run: RunSnapshot | null }> {
    await this.ready
    const operation = this.requireOperation(operationId)
    const run = this.runs.get(operation.runId)
    if (run !== undefined) {
      await this.reconciler.refresh(run)
      if ((operation.kind === 'start' || operation.kind === 'reply') && run.snapshot.promptMessageId !== null
        && operation.state !== 'acknowledged' && operation.state !== 'reconciled' && operation.state !== 'failed') {
        await this.journal.transition(operation, 'reconciled', { messageId: run.snapshot.promptMessageId, error: null })
      } else if (operation.kind === 'steer' && operation.state !== 'acknowledged' && operation.state !== 'reconciled' && operation.state !== 'failed') {
        const events = await this.reconciler.historyAfter(run.snapshot.sessionId, run.baselineSeq)
        const message = events.find(event => userRpcId(event) === operation.rpcId)
        if (message !== undefined) await this.journal.transition(operation, 'reconciled', { messageId: stringAt(message.data, 'id'), error: null })
      } else if (operation.kind === 'cancel' && run.snapshot.status !== 'running'
        && operation.state !== 'acknowledged' && operation.state !== 'reconciled' && operation.state !== 'failed') {
        await this.journal.transition(operation, 'reconciled', { error: null })
      }
    }
    await this.persistState()
    return { operation: { ...operation }, run: run === undefined ? null : cloneRun(run.snapshot) }
  }

  async cancelRun(runId: string, idempotencyKey?: string, clientPrincipalId: string = this.config.clientPrincipalId): Promise<RunSnapshot> {
    await this.ready
    const run = this.requireRun(runId)
    await this.reconciler.refresh(run)
    if (run.snapshot.status !== 'running') return cloneRun(run.snapshot)
    const prepared = await this.journal.prepare(clientPrincipalId, 'cancel', runId, { runId }, idempotencyKey)
    const operation = prepared.record
    if (prepared.replayed && operation.state === 'acknowledged') return cloneRun(run.snapshot)
    if (prepared.replayed && operation.state !== 'prepared') {
      const reconciled = await this.reconcileOperation(operation.operationId)
      if (reconciled.operation.state === 'acknowledged' || reconciled.operation.state === 'reconciled') return cloneRun(run.snapshot)
      throw this.journal.unknown(operation, 'The cancel operation outcome is not yet reconciled')
    }
    if (prepared.replayed && Date.now() - Date.parse(operation.updatedAt) < this.config.rpcTimeoutMs) throw new RelayError('OPERATION_IN_PROGRESS', 'The original caller still owns this prepared cancel', true, { operationId: operation.operationId, runId, lastKnownState: operation.state, nextAction: 'wait' })
    run.snapshot.cancelRequested = true
    await this.journal.transition(operation, 'submitted')
    try {
      await this.gateway.cancelSession(run.snapshot.sessionId, operation.rpcId, actualRpcId => this.journal.correlateRpcId(operation, actualRpcId))
      await this.journal.transition(operation, 'acknowledged')
    } catch (error) {
      if (error instanceof HostRpcError && error.definitiveRejection) {
        run.snapshot.cancelRequested = false
        await this.journal.transition(operation, 'failed', { error: errorText(error) })
        await this.persistState()
        throw error
      }
      await this.journal.transition(operation, 'unknown', { error: errorText(error) })
      throw this.journal.unknown(operation, 'The cancel response was unavailable; inspect run status before retrying')
    }
    await this.reconciler.refresh(run)
    await this.persistState()
    return cloneRun(run.snapshot)
  }

  async listCapabilities(): Promise<object> {
    await this.ready
    const [models, presets] = await Promise.all([
      this.gateway.listModels(),
      this.gateway.listAgentPresets(),
    ])
    return {
      models,
      presets,
      permissionPresets: ['read-only', 'workspace-write', 'danger-full-access'],
    }
  }

  private async restoreState(): Promise<void> {
    const state = await this.stateStore.load()
    if (state === null) return
    for (const service of state.services) {
      this.services.set(service.serviceId, { ...service })
      if (service.status === 'running') this.serviceByWorkspace.set(service.workspace, service.serviceId)
    }
    for (const persisted of state.runs) {
      const snapshot = cloneRun(persisted.snapshot)
      snapshot.promptAdmission ??= snapshot.promptMessageId === null ? 'unknown' : 'accepted'
      this.runs.set(snapshot.runId, {
        snapshot,
        baselineSeq: persisted.baselineSeq,
        promptRpcId: persisted.promptRpcId,
        events: [],
      })
      if (snapshot.status === 'running') {
        this.activeSessions.set(this.activeKey(snapshot.serviceId, snapshot.sessionId), snapshot.runId)
      }
    }
    for (const operation of state.operations) this.operations.set(operation.operationId, { ...operation })
    for (const lease of state.permissionLeases) this.permissionLeases.set(lease.leaseId, { ...lease })
    this.journal.restoreIndex()
    await this.permissions.markExpired()
  }

  private async persistState(): Promise<void> {
    const state: PersistedRelayState = {
      schemaVersion: 2,
      services: [...this.services.values()].map(service => ({ ...service })),
      runs: [...this.runs.values()].map(run => ({
        snapshot: persistedSnapshot(run.snapshot, this.config.persistPromptText),
        baselineSeq: run.baselineSeq,
        promptRpcId: run.promptRpcId,
      })),
      operations: this.journal.list(),
      permissionLeases: this.permissions.list(),
    }
    await this.stateStore.save(state)
  }

  private async open(service: ServiceRecord, url: string): Promise<void> {
    try {
      await openUrl(url)
      service.browserOpened = true
      service.browserError = null
    } catch (error) {
      service.browserError = errorText(error)
      throw error
    }
  }

  private requireService(serviceId: string): ServiceRecord {
    const service = this.services.get(serviceId)
    if (service === undefined) throw new Error(`unknown serviceId: ${serviceId}`)
    return service
  }

  private requireRun(runId: string): RunRecord {
    const run = this.runs.get(runId)
    if (run === undefined) throw new Error(`unknown runId: ${runId}`)
    return run
  }

  private requireOperation(operationId: string): OperationRecord {
    const operation = this.operations.get(operationId)
    if (operation === undefined) throw new Error(`unknown operationId: ${operationId}`)
    return operation
  }

  private activeKey(serviceId: string, sessionId: string): string {
    return `${serviceId}:${sessionId}`
  }
}
