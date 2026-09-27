import { randomUUID } from 'node:crypto'
import { InteractionError, type ApprovalDecision, type InteractionAgent, type InteractionOwner, type InteractionResponse, type NativeApprovalRequest, type NativeQuestionRequest, type PendingInteraction, type QuestionAnswer } from './types.js'

interface PendingEntry {
  owner: InteractionOwner
  view: PendingInteraction
  isCurrent: () => boolean
  finish: (response: Settlement) => void
}

type Settlement = InteractionResponse | { kind: 'aborted' }

/** Live one-shot requests, owned by an active Relay run. Never persisted or replayed after restart. */
export class UserInteractionFacade {
  private readonly pending = new Map<string, PendingEntry>()
  private disposed = false

  constructor(
    private readonly ownerOf: (agent: InteractionAgent) => InteractionOwner | undefined,
    private readonly maxPending = 256,
  ) {}

  approval(request: NativeApprovalRequest, next: () => Promise<ApprovalDecision | 'unavailable'>): Promise<ApprovalDecision | 'unavailable'> {
    const owner = this.ownerOf(request.agent)
    if (owner === undefined || this.disposed) return next()
    if (request.signal?.aborted) return Promise.resolve('cancelled')
    return this.enqueue(owner, request.agent, request.signal, {
      kind: 'approval', toolName: request.toolName,
      ...(request.callId === undefined ? {} : { callId: request.callId }),
      ...(request.reason === undefined ? {} : { reason: request.reason }),
    }).then(response => response.kind === 'approval' ? response.decision : 'cancelled')
  }

  question(request: NativeQuestionRequest, next: () => Promise<QuestionAnswer>): Promise<QuestionAnswer> {
    const owner = request.agent === undefined ? undefined : this.ownerOf(request.agent)
    if (owner === undefined || request.agent === undefined || this.disposed) return next()
    if (request.signal?.aborted) return Promise.reject(questionCancelled(true))
    return this.enqueue(owner, request.agent, request.signal, { kind: 'question', questions: structuredClone(request.questions) })
      .then(response => {
        if (response.kind !== 'question') throw questionCancelled(response.kind === 'aborted')
        return response.answer
      })
  }

  list(runId: string, principal: string): PendingInteraction[] {
    this.prune()
    return [...this.pending.values()]
      .filter(entry => entry.owner.runId === runId && entry.owner.clientPrincipalId === principal)
      .map(entry => structuredClone(entry.view))
  }

  hasPending(runId: string): boolean {
    this.prune()
    return [...this.pending.values()].some(entry => entry.owner.runId === runId)
  }

  respond(runId: string, requestId: string, principal: string, response: InteractionResponse): { accepted: true; requestId: string } {
    this.prune()
    const entry = this.pending.get(requestId)
    if (entry === undefined) throw new InteractionError('INTERACTION_NOT_PENDING', 'Request expired, was answered, or belongs to a previous Host process; list pending requests again.')
    if (entry.owner.runId !== runId || entry.owner.clientPrincipalId !== principal) {
      throw new InteractionError('INTERACTION_OWNER_MISMATCH', 'Only the client principal that started this run may answer its requests.')
    }
    validateResponse(entry.view, response)
    // Remove before resolving: concurrent callers cannot apply the same grant twice.
    entry.finish(structuredClone(response))
    return { accepted: true, requestId }
  }

  dispose(): void {
    this.disposed = true
    for (const entry of this.pending.values()) entry.finish({ kind: 'aborted' })
  }

  private prune(): void {
    for (const entry of this.pending.values()) {
      if (!entry.isCurrent()) entry.finish({ kind: 'aborted' })
    }
  }

  private enqueue(
    owner: InteractionOwner, agent: InteractionAgent, signal: AbortSignal | undefined,
    details: { kind: 'approval'; toolName: string; callId?: string; reason?: string; toolCall?: unknown } | { kind: 'question'; questions: NativeQuestionRequest['questions'] },
  ): Promise<Settlement> {
    this.prune()
    if (this.pending.size >= this.maxPending) throw new InteractionError('INTERACTION_CAPACITY', 'Too many pending user interactions; failing closed.')
    const requestId = randomUUID()
    return new Promise((resolve, reject) => {
      let settled = false
      let releaseContext: (() => void | Promise<void>) | undefined
      const finish = (response: Settlement) => {
        if (settled) return
        settled = true
        this.pending.delete(requestId)
        signal?.removeEventListener('abort', abort)
        // Cordis disposers also run the callback; settled fences re-entry.
        void releaseContext?.()
        resolve(response)
      }
      const abort = () => finish({ kind: 'aborted' })
      try {
        releaseContext = agent.ctx.effect(() => abort, 'harness-relay: pending user interaction')
      } catch (error) { reject(error); return }
      if (settled) { void releaseContext(); return }
      this.pending.set(requestId, {
        owner,
        view: { requestId, runId: owner.runId, sessionId: owner.sessionId, createdAt: new Date().toISOString(), ...details },
        isCurrent: () => {
          const current = this.ownerOf(agent)
          return !signal?.aborted && current?.runId === owner.runId && current.clientPrincipalId === owner.clientPrincipalId
        },
        finish,
      })
      signal?.addEventListener('abort', abort, { once: true })
      if (signal?.aborted) abort()
    })
  }
}

function validateResponse(view: PendingInteraction, response: InteractionResponse): void {
  if (response.kind === 'cancel') return
  if (view.kind !== response.kind) throw new InteractionError('INTERACTION_KIND_MISMATCH', 'Response kind must match the pending request.')
  if (response.kind === 'approval') {
    if (!response.explanation.trim()) throw new InteractionError('AUTHORIZATION_REQUIRED', 'Explain the decision against the actual user authorization.')
    if (response.decision === 'allowed-once' && response.authorizationBasis === undefined) {
      throw new InteractionError('AUTHORIZATION_REQUIRED', 'A one-shot grant requires explicit user approval or an already authorized task scope.')
    }
    return
  }
  if (view.kind !== 'question') return
  const answers = response.answer.answers
  if (answers.length !== view.questions.length || new Set(answers.map(item => item.id)).size !== answers.length) {
    throw new InteractionError('INVALID_ANSWER', 'Answer each pending question exactly once.')
  }
  for (const question of view.questions) {
    const answer = answers.find(item => item.id === question.id)
    if (answer === undefined || new Set(answer.selected).size !== answer.selected.length
      || answer.selected.some(label => !question.options?.some(option => option.label === label))
      || (!question.multiSelect && answer.selected.length + (answer.custom?.trim() ? 1 : 0) > 1)) {
      throw new InteractionError('INVALID_ANSWER', `Invalid answer for question ${question.id}.`)
    }
  }
}

function questionCancelled(aborted: boolean): Error {
  return Object.assign(new Error('The pending user question was cancelled.'), { name: 'UserQuestionError', code: aborted ? 'ASK_ABORTED' : 'ASK_CANCELLED' })
}
