import type { PermissionPreset, PromptPart } from '../types.js'
import type { SessionMode } from '../session-routing/index.js'
import { RelayError } from './errors.js'

export interface StartRunInput {
  task?: string
  content?: PromptPart[]
  workspace: string
  sessionId?: string
  sessionMode?: SessionMode
  provider?: string
  model?: string
  reasoningEffort?: string
  agentPreset?: string
  permissionPreset?: PermissionPreset
  openBrowser?: boolean
  parentRunId?: string
  idempotencyKey?: string
  confirmedDangerousPermission?: boolean
  operationKind?: 'start' | 'reply'
}

export function validateStartRunInput(input: StartRunInput): void {
  if (input.sessionId !== undefined && input.sessionMode !== undefined) {
    throw new Error('sessionId and sessionMode cannot be supplied together')
  }
  if ((input.provider === undefined) !== (input.model === undefined)) throw new Error('provider and model must be supplied together')
  if (input.reasoningEffort !== undefined && (input.provider === undefined || input.model === undefined)) {
    throw new Error('reasoningEffort requires provider and model')
  }
  if (input.permissionPreset === 'danger-full-access' && input.confirmedDangerousPermission !== true) {
    throw new RelayError('DANGEROUS_PERMISSION_CONFIRMATION_REQUIRED', 'danger-full-access requires confirmedDangerousPermission=true', false, { nextAction: 'confirm' })
  }
}

export function operationRequest(input: StartRunInput, summary: string, imageCount: number): object {
  return {
    workspace: input.workspace,
    sessionId: input.sessionId ?? null,
    sessionMode: input.sessionMode ?? 'fresh',
    provider: input.provider ?? null,
    model: input.model ?? null,
    reasoningEffort: input.reasoningEffort ?? null,
    agentPreset: input.agentPreset ?? null,
    permissionPreset: input.permissionPreset ?? 'read-only',
    parentRunId: input.parentRunId ?? null,
    summary,
    imageCount,
  }
}
