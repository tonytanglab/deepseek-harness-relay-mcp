import type { RunSnapshot } from '../types.js'

export enum AttentionReason {
  AwaitUserAnswer = 'await_user_answer',
  PermissionConfirm = 'permission_confirm',
  HostDisconnected = 'host_disconnected',
  PermissionRestoreFailed = 'permission_restore_failed',
  RunStalled = 'run_stalled',
}

export type NextAction = 'wait' | 'reply' | 'cancel' | 'open-session' | 'none'

export interface RunAttention {
  reason: AttentionReason
  detail?: string
  requestedInput?: string
}

export interface RunProgress {
  completed?: number
  total?: number
  message?: string
}

export interface RunUsage {
  inputTokens?: number
  outputTokens?: number
  estimatedCost?: number
}

export interface MonitoringProjection {
  attention?: RunAttention
  progress?: RunProgress
  usage?: RunUsage
  updatedAt?: string
}

export interface RunSummary {
  runId: string
  status: RunSnapshot['status']
  attention?: RunAttention
  provider?: string
  model?: string
  reasoningEffort?: string
  permissionMode: RunSnapshot['permissionPreset']
  startedAt: string
  updatedAt: string
  finishedAt?: string
  elapsedMs?: number
  progress?: RunProgress
  usage?: RunUsage
  nextAction: NextAction
}

export type RunNotificationKind = 'run-summary' | 'attention' | 'progress' | 'log'

export interface PublishNotificationInput {
  runId: string
  kind: RunNotificationKind
  payload: Record<string, unknown>
  occurredAt?: string
}

export interface RunNotification extends PublishNotificationInput {
  eventId: string
  cursor: string
  occurredAt: string
}

export interface ResyncRequired {
  kind: 'resync-required'
  reason: 'queue-overflow' | 'cursor-expired'
  discardedThroughCursor: string
  latestCursor: string
}

export interface PublishNotificationResult {
  notification: RunNotification
  overflowed: boolean
  resync?: ResyncRequired
}

export interface NotificationPage {
  notifications: RunNotification[]
  nextCursor: string
}

export interface MonitoringOptions {
  maxQueueItems?: number
  maxQueueBytes?: number
  now?: () => Date
}

export interface ClientMonitoringCapabilities {
  notifications?: boolean
  progress?: boolean
}

export interface RelayCapability {
  enabled: boolean
  version: string
  fallback?: string
}

export interface RelayCapabilities {
  contractVersion: string
  features: {
    runSummary: RelayCapability
    attention: RelayCapability
    notifications: RelayCapability
    cursorReplay: RelayCapability
    progress: RelayCapability
  }
}

export type MonitoringErrorCode = 'CURSOR_EXPIRED' | 'INVALID_CURSOR' | 'NOTIFICATION_TOO_LARGE'

export interface MonitoringErrorDetails {
  resync?: ResyncRequired
  latestCursor?: string
}

export class MonitoringError extends Error {
  readonly code: MonitoringErrorCode
  readonly details: MonitoringErrorDetails

  constructor(code: MonitoringErrorCode, message: string, details: MonitoringErrorDetails = {}) {
    super(message)
    this.name = 'MonitoringError'
    this.code = code
    this.details = details
  }
}
