import { HostRpcError, type HarnessGatewayFacade } from '../harness-gateway/index.js'
import type { OperationRecord, PromptPart } from '../types.js'
import { errorText } from './helpers.js'
import type { RunRecord } from './internal-types.js'
import type { OperationJournal } from './operation-journal.js'
import type { RunReconciler } from './run-reconciler.js'

export class PromptAdmissionController {
  constructor(
    private readonly gateway: HarnessGatewayFacade,
    private readonly journal: OperationJournal,
    private readonly reconciler: RunReconciler,
  ) {}

  async submit(run: RunRecord, operation: OperationRecord, content: PromptPart[]): Promise<void> {
    const snapshot = run.snapshot
    if (operation.state === 'prepared') await this.journal.transition(operation, 'submitted')
    let accepted: { accepted: true; rpcId: string; messageId?: string }
    try {
      accepted = await this.gateway.submitPrompt(snapshot.sessionId, 'queue', content, run.promptRpcId, async actualRpcId => {
        run.promptRpcId = actualRpcId
        await this.journal.correlateRpcId(operation, actualRpcId)
      })
    } catch (error) {
      snapshot.error = errorText(error)
      if (error instanceof HostRpcError && error.definitiveRejection) {
        snapshot.promptAdmission = 'rejected'
        await this.journal.transition(operation, 'failed', { error: snapshot.error })
        await this.reconciler.finalize(run, 'failed', snapshot.error)
      } else {
        snapshot.promptAdmission = 'unknown'
        const warning = 'The prompt response was unavailable; DSH Relay is reconciling durable history by rpcId'
        if (!snapshot.warnings.includes(warning)) snapshot.warnings.push(warning)
        await this.journal.transition(operation, 'unknown', { error: snapshot.error })
      }
      return
    }
    snapshot.promptAdmission = 'accepted'
    run.promptRpcId = accepted.rpcId
    snapshot.promptMessageId = accepted.messageId ?? null
    snapshot.error = null
    await this.journal.transition(operation, 'acknowledged', { messageId: snapshot.promptMessageId, error: null })
  }
}
