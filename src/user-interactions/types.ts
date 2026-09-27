/** Native scoped answerer payloads. Objects stay borrowed; only display data crosses MCP. */
export interface InteractionAgent {
  readonly id: string
  readonly session: { readonly id: string }
  readonly ctx: { effect(install: () => () => void, label?: string): () => void | Promise<void> }
}

export interface InteractionOwner {
  runId: string
  sessionId: string
  clientPrincipalId: string
}

export interface QuestionItem {
  id: string
  question: string
  detail?: string
  header?: string
  options?: Array<{ label: string; description?: string }>
  multiSelect?: boolean
  intent?: { kind: 'plan-review'; approve: string }
}

export interface QuestionAnswer {
  answers: Array<{ id: string; selected: string[]; custom?: string }>
}

export interface NativeApprovalRequest {
  agent: InteractionAgent
  toolName: string
  callId?: string
  reason?: string
  signal?: AbortSignal
}

export interface NativeQuestionRequest {
  agent?: InteractionAgent
  questions: QuestionItem[]
  signal?: AbortSignal
}

export type ApprovalDecision = 'allowed-once' | 'rejected' | 'cancelled'
export type InteractionResponse =
  | { kind: 'approval'; decision: ApprovalDecision; authorizationBasis?: 'explicit-user-approval' | 'within-authorized-task'; explanation: string }
  | { kind: 'question'; answer: QuestionAnswer }
  | { kind: 'cancel' }

export type PendingInteraction = {
  requestId: string
  runId: string
  sessionId: string
  createdAt: string
} & (
  | { kind: 'approval'; toolName: string; callId?: string; reason?: string; toolCall?: unknown }
  | { kind: 'question'; questions: QuestionItem[] }
)

export class InteractionError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = 'InteractionError' }
}
