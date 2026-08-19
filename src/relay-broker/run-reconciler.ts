import type { RelayConfig } from '../config.js'
import type { HarnessGatewayFacade } from '../harness-gateway/index.js'
import { finalAssistantText, highestSeq, mergeEvents, stringAt, terminalOutcome, userRpcId, utf8Tail } from '../run-events.js'
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
    if (typeof session.projections?.asOfSeq === 'number') {
      run.snapshot.lastEventSeq = Math.max(run.snapshot.lastEventSeq, session.projections.asOfSeq)
    }
    if (run.snapshot.lastEventSeq > previousLastSeq) this.recordProgress(run)
    if (session.running) {
      this.activeSessions.set(activeKey(run), run.snapshot.runId)
      if (run.snapshot.promptMessageId !== null) {
        this.markStalled(run)
        return
      }
    }
    run.events = mergeEvents(run.events, await this.historyAfter(run.snapshot.sessionId, run.baselineSeq))
    run.snapshot.lastEventSeq = Math.max(run.snapshot.lastEventSeq, highestSeq(run.events, run.baselineSeq))
    if (run.snapshot.lastEventSeq > previousLastSeq) this.recordProgress(run)
    const promptEvent = run.events.find(event => userRpcId(event) === run.promptRpcId)
    if (promptEvent === undefined) {
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
    if (session.running) {
      run.events = [promptEvent]
      return
    }
    const nextUser = run.events.find(event => event.seq > promptEvent.seq && userRpcId(event) !== null)
    const owned = run.events.filter(event => event.seq > promptEvent.seq && (nextUser === undefined || event.seq < nextUser.seq))
    const terminal = [...owned].reverse().find(event => event.type === 'turn/end')
    const relevant = owned.filter(event => terminal === undefined || event.seq <= terminal.seq)
    const retained = utf8Tail(finalAssistantText(relevant), this.config.maxAssistantTextBytes)
    run.snapshot.assistantText = retained.text
    run.snapshot.assistantTextBytes = retained.bytes
    run.snapshot.assistantTextTruncated = retained.truncated
    if (terminal === undefined) return
    const outcome = terminalOutcome(terminal, run.snapshot.cancelRequested)
    if (outcome.warning !== undefined && !run.snapshot.warnings.includes(outcome.warning)) run.snapshot.warnings.push(outcome.warning)
    run.events = [promptEvent, terminal]
    await this.finalize(run, outcome.status, outcome.error)
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
    run.snapshot.status = status
    run.snapshot.error = error
    delete run.snapshot.attentionReason
    run.snapshot.finishedAt = new Date().toISOString()
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
