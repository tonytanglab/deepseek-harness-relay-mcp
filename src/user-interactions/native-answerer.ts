import { UserInteractionFacade } from './user-interaction-facade.js'
import type { ApprovalDecision, InteractionAgent, InteractionOwner, NativeApprovalRequest, NativeQuestionRequest, QuestionAnswer } from './types.js'

/** Public Cordis event/registry surface; no imports of Harness implementation internals. */
export interface NativeInteractionContext {
  get(name: 'agents'): { get(id: string): unknown; roots(): readonly unknown[] } | undefined
  on(event: 'approval/request', handler: (request: NativeApprovalRequest, next: () => Promise<ApprovalDecision | 'unavailable'>) => Promise<ApprovalDecision | 'unavailable'>, options: { prepend: true }): () => void
  on(event: 'user-questions/request', handler: (request: NativeQuestionRequest, next: () => Promise<QuestionAnswer>) => Promise<QuestionAnswer>, options: { prepend: true }): () => void
}

/** Resolve only the exact live root Agent. Native child agents keep their existing interaction policy. */
export function nativeInteractionOwner(ctx: NativeInteractionContext, agent: InteractionAgent, ownerOfSession: (sessionId: string) => InteractionOwner | undefined): InteractionOwner | undefined {
  const agents = ctx.get('agents')
  if (agents?.get(agent.id) !== agent || !agents.roots().includes(agent)) return undefined
  return ownerOfSession(agent.session.id)
}

/** Register before ordinary UI answerers; foreign sessions always delegate via next(). */
export function installNativeAnswerer(ctx: NativeInteractionContext, interactions: UserInteractionFacade): () => void {
  const approval = ctx.on('approval/request', (request, next) => interactions.approval(request, next), { prepend: true })
  let questions: (() => void) | undefined
  try {
    questions = ctx.on('user-questions/request', (request, next) => interactions.question(request, next), { prepend: true })
  } catch (error) {
    approval()
    interactions.dispose()
    throw error
  }
  return () => { approval(); questions?.(); interactions.dispose() }
}
