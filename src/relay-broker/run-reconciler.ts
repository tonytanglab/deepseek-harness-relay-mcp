import type { RelayConfig } from '../config.js'
import type { HarnessGatewayFacade } from '../harness-gateway/index.js'
import { finalAssistantInterrupted, finalAssistantText, highestSeq, mergeEvents, stringAt, terminalOutcome, userRpcId, utf8Tail } from '../run-events.js'
import type { OperationRecord, RpcEvent, RunStatus } from '../types.js'
import type { RunRecord } from './internal-types.js'
import type { OperationJournal } from './operation-journal.js'
import type { PermissionController } from './permission-controller.js'

export class RunReconciler {
  constructor(
    private readonly gateway: HarnessGatewayFacade,
    private readonly config: RelayConfig,
    private readonly activeSessions: Map<string, string>,
    private readonly operations: Map<string, OperationRecord>,
    private readonly journal: OperationJournal,
    private readonly permissions: PermissionController,
  ) {}

  async refresh(run: RunRecord): Promise<void> {
    const stalled = run.snapshot.status === 'needs_attention' && run.snapshot.attentionReason === 'run_stalled'
    if (run.snapshot.status !== 'running' && !stalled) return
    const previousLastSeq = run.snapshot.lastEventSeq
    const listed = await this.gateway.listSessions()
    const session = listed.find(item => item.sessionId === run.snapshot.sessionId)
    if (session === undefined) {
      await this.finalize(run, 'failed', `Harness session is no longer listed: ${run.snapshot.sessionId}`)
      return
    }
    if (session.running) this.activeSessions.set(activeKey(run), run.snapshot.runId)
    const previousDurableSeq = highestSeq(run.events, run.baselineSeq)
    run.events = mergeEvents(run.events, await this.historyAfter(run.snapshot.sessionId, run.baselineSeq))
    const durableLastSeq = highestSeq(run.events, run.baselineSeq)
    const projectionLastSeq = session.projections?.asOfSeq
    const projectionProgress = typeof projectionLastSeq === 'number'
      && run.lastObservedProjectionSeq !== undefined
      && projectionLastSeq > run.lastObservedProjectionSeq
    if (typeof projectionLastSeq === 'number') {
      run.lastObservedProjectionSeq = Math.max(run.lastObservedProjectionSeq ?? projectionLastSeq, projectionLastSeq)
    }
    run.snapshot.lastEventSeq = Math.max(
      run.snapshot.lastEventSeq,
      durableLastSeq,
      typeof projectionLastSeq === 'number' ? projectionLastSeq : run.snapshot.lastEventSeq,
    )
    if (durableLastSeq > previousDurableSeq || projectionProgress) this.recordProgress(run)
    const promptEvent = run.events.find(event => userRpcId(event) === run.promptRpcId)
    if (promptEvent === undefined) {
      if (session.running && run.snapshot.promptAdmission === 'accepted') this.markStalled(run)
      await this.reconcileMissingPrompt(run, session.running, previousLastSeq)
      return
    }
    run.snapshot.promptAdmission = 'accepted'
    run.snapshot.error = null
    run.snapshot.promptMessageId = stringAt(promptEvent.data, 'id')
    const operation = run.snapshot.operationId === undefined ? undefined : this.operations.get(run.snapshot.operationId)
    if (operation !== undefined && (operation.state === 'prepared' || operation.state === 'submitted' || operation.state === 'unknown')) {
      await this.journal.transition(operation, operation.state === 'unknown' ? 'reconciled' : 'acknowledged', { messageId: run.snapshot.promptMessageId })
    }
    const owned = this.ownedEvents(run, promptEvent)
    const terminal = [...owned].reverse().find(event => event.type === 'turn/end')
    const relevant = owned.filter(event => terminal === undefined || event.seq <= terminal.seq)
    const retained = utf8Tail(finalAssistantText(relevant), this.config.maxAssistantTextBytes)
    run.snapshot.assistantText = retained.text
    run.snapshot.assistantTextBytes = retained.bytes
    run.snapshot.assistantTextTruncated = retained.truncated
    if (terminal === undefined) {
      if (session.running) this.markStalled(run)
      return
    }
    const outcome = terminalOutcome(terminal, run.snapshot.cancelRequested, finalAssistantInterrupted(relevant))
    if (outcome.warning !== undefined && !run.snapshot.warnings.includes(outcome.warning)) run.snapshot.warnings.push(outcome.warning)
    await this.finalize(run, outcome.status, outcome.error)
  }

  private ownedEvents(run: RunRecord, promptEvent: RpcEvent): RpcEvent[] {
    const ownedRpcIds = new Set<string>([run.promptRpcId])
    const ownedMessageIds = new Set<string>()
    if (run.snapshot.promptMessageId !== null) ownedMessageIds.add(run.snapshot.promptMessageId)
    for (const operation of this.operations.values()) {
      if (operation.runId !== run.snapshot.runId || operation.kind !== 'steer') continue
      ownedRpcIds.add(operation.rpcId)
      if (operation.messageId !== null) ownedMessageIds.add(operation.messageId)
    }
    const nextForeignUser = run.events.find(event => {
      if (event.seq <= promptEvent.seq) return false
      const rpcId = userRpcId(event)
      if (rpcId === null) return false
      if (ownedRpcIds.has(rpcId)) return false
      const messageId = stringAt(event.data, 'id')
      return messageId === null || !ownedMessageIds.has(messageId)
    })
    return run.events.filter(event => event.seq > promptEvent.seq
      && (nextForeignUser === undefined || event.seq < nextForeignUser.seq))
  }

  async historyAfter(sessionId: string, baselineSeq: number): Promise<RpcEvent[]> {
    const events: RpcEvent[] = []
    let beforeSeq: number | undefined
    for (let pageNumber = 0; pageNumber < this.config.maxHistoryPages; pageNumber += 1) {
      const page = await this.gateway.readHistory({
        sessionId,
        maxMessages: 100,
        ...(beforeSeq === undefined ? {} : { beforeSeq }),
      })
      const pageEvents = page.events.map(entry => entry.event)
      events.push(...pageEvents.filter(event => event.seq > baselineSeq))
      const oldest = pageEvents.reduce((value, event) => Math.min(value, event.seq), Number.POSITIVE_INFINITY)
      if (!page.hasMore || !Number.isFinite(oldest) || oldest <= baselineSeq) break
      if (beforeSeq !== undefined && oldest >= beforeSeq) {
        throw new Error(`Harness history pagination made no progress for session ${sessionId}`)
      }
      beforeSeq = oldest
      if (pageNumber + 1 === this.config.maxHistoryPages) {
        throw new Error(`Harness history exceeded DSH_RELAY_MAX_HISTORY_PAGES for session ${sessionId}`)
      }
    }
    return mergeEvents([], events)
  }

  async latestSeq(sessionId: string): Promise<number> {
    const page = await this.gateway.readHistory({ sessionId, maxMessages: 1 })
    return highestSeq(page.events.map(entry => entry.event), -1)
  }

  async finalize(run: RunRecord, status: Exclude<RunStatus, 'running' | 'unknown'>, error: string | null): Promise<void> {
    const finishedAt = new Date().toISOString()
    run.snapshot.status = status
    run.snapshot.error = error
    delete run.snapshot.attentionReason
    run.snapshot.finishedAt = finishedAt
    run.snapshot.lastProgressAt = finishedAt
    this.activeSessions.delete(activeKey(run))
    await this.restorePermission(run)
  }

  private async reconcileMissingPrompt(run: RunRecord, sessionRunning: boolean, previousLastSeq: number): Promise<void> {
    if (!sessionRunning && run.snapshot.cancelRequested) {
      await this.finalize(run, 'cancelled', null)
      return
    }
    const admissionExpired = Date.now() - Date.parse(run.snapshot.startedAt) >= this.config.rpcTimeoutMs
    const operation = run.snapshot.operationId === undefined ? undefined : this.operations.get(run.snapshot.operationId)
    const submissionStillRecoverable = operation?.state === 'prepared' || operation?.state === 'submitted'
    if (!sessionRunning && run.snapshot.promptAdmission !== 'accepted' && admissionExpired
      && run.snapshot.lastEventSeq <= previousLastSeq && !submissionStillRecoverable) {
      run.snapshot.promptAdmission = 'rejected'
      if (operation !== undefined && operation.state !== 'failed') {
        await this.journal.transition(operation, 'failed', { error: run.snapshot.error ?? 'Harness did not persist the submitted prompt' })
      }
      await this.finalize(run, 'failed', run.snapshot.error ?? 'Harness did not persist the submitted prompt')
    }
  }

  private async restorePermission(run: RunRecord): Promise<void> {
    if (await this.permissions.restoreSession(run.snapshot.sessionId, run.snapshot.operationId)) return
    run.snapshot.status = 'needs_attention'
    run.snapshot.attentionReason = 'permission_restore_failed'
    run.snapshot.error = 'The run completed, but the previous Harness permission preset could not be restored'
    const warning = 'Permission restoration requires attention before this session is reused'
    if (!run.snapshot.warnings.includes(warning)) run.snapshot.warnings.push(warning)
  }

  private recordProgress(run: RunRecord): void {
    run.snapshot.lastProgressAt = new Date().toISOString()
    if (run.snapshot.attentionReason !== 'run_stalled') return
    run.snapshot.status = 'running'
    run.snapshot.error = null
    delete run.snapshot.attentionReason
  }

  private markStalled(run: RunRecord): void {
    const lastProgressAt = run.snapshot.lastProgressAt ?? run.snapshot.startedAt
    if (Date.now() - Date.parse(lastProgressAt) < this.config.runStallMs) return
    run.snapshot.status = 'needs_attention'
    run.snapshot.attentionReason = 'run_stalled'
    run.snapshot.error = 'Harness reports the session as running, but no durable progress was observed before the stall timeout'
  }
}

function activeKey(run: RunRecord): string {
  return `${run.snapshot.serviceId}:${run.snapshot.sessionId}`
}
