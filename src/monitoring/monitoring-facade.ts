import type { RunSnapshot } from '../types.js'
import { NotificationBuffer } from './notification-buffer.js'
import {
  AttentionReason,
  type ClientMonitoringCapabilities,
  type MonitoringOptions,
  type MonitoringProjection,
  type NextAction,
  type NotificationPage,
  type PublishNotificationInput,
  type PublishNotificationResult,
  type RelayCapabilities,
  type RunAttention,
  type RunSummary,
} from './types.js'

const DEFAULT_MAX_QUEUE_ITEMS = 1000
const DEFAULT_MAX_QUEUE_BYTES = 8 * 1024 * 1024
const CONTRACT_VERSION = '1.0.0'

export class MonitoringFacade {
  readonly #notifications: NotificationBuffer
  readonly #now: () => Date

  constructor(options: MonitoringOptions = {}) {
    this.#now = options.now ?? (() => new Date())
    this.#notifications = new NotificationBuffer(
      options.maxQueueItems ?? DEFAULT_MAX_QUEUE_ITEMS,
      options.maxQueueBytes ?? DEFAULT_MAX_QUEUE_BYTES,
      this.#now,
    )
  }

  project(snapshot: RunSnapshot, projection: MonitoringProjection = {}): RunSummary {
    const updatedAt = projection.updatedAt ?? snapshot.finishedAt ?? snapshot.lastProgressAt ?? snapshot.startedAt
    const elapsedMs = calculateElapsedMs(snapshot.startedAt, snapshot.finishedAt ?? updatedAt)
    const summary: RunSummary = {
      runId: snapshot.runId,
      status: snapshot.status,
      permissionMode: snapshot.permissionPreset,
      startedAt: snapshot.startedAt,
      updatedAt,
      nextAction: resolveNextAction(snapshot.status, projection.attention),
    }

    if (elapsedMs !== undefined) summary.elapsedMs = elapsedMs
    if (snapshot.finishedAt !== null) summary.finishedAt = snapshot.finishedAt
    if (snapshot.modelSelection) {
      summary.provider = snapshot.modelSelection.provider
      summary.model = snapshot.modelSelection.model
      if (snapshot.modelSelection.reasoningEffort !== undefined) {
        summary.reasoningEffort = snapshot.modelSelection.reasoningEffort
      }
    }
    if (projection.attention) summary.attention = structuredClone(projection.attention)
    if (projection.progress) summary.progress = structuredClone(projection.progress)
    if (projection.usage) summary.usage = structuredClone(projection.usage)
    return summary
  }

  publishNotification(input: PublishNotificationInput): PublishNotificationResult {
    return this.#notifications.publish(input)
  }

  readNotifications(cursor?: string): NotificationPage {
    return this.#notifications.read(cursor)
  }

  getCapabilities(client: ClientMonitoringCapabilities = {}): RelayCapabilities {
    const notificationsEnabled = client.notifications === true
    const progressEnabled = notificationsEnabled && client.progress === true
    return {
      contractVersion: CONTRACT_VERSION,
      features: {
        runSummary: { enabled: true, version: '1.0.0' },
        attention: { enabled: true, version: '1.0.0' },
        notifications: notificationsEnabled
          ? { enabled: true, version: '1.0.0' }
          : { enabled: false, version: '1.0.0', fallback: 'wait_run/status polling' },
        cursorReplay: notificationsEnabled
          ? { enabled: true, version: '1.0.0' }
          : { enabled: false, version: '1.0.0', fallback: 'get_run_summary snapshot' },
        progress: progressEnabled
          ? { enabled: true, version: '1.0.0' }
          : { enabled: false, version: '1.0.0', fallback: 'get_run_summary snapshot' },
      },
    }
  }
}

function resolveNextAction(status: RunSnapshot['status'], attention?: RunAttention): NextAction {
  const normalizedStatus: string = status
  if (normalizedStatus === 'needs_attention') return actionForAttention(attention)
  if (normalizedStatus === 'incomplete') return 'reply'
  if (normalizedStatus === 'queued' || normalizedStatus === 'running' || normalizedStatus === 'unknown') {
    return attention ? actionForAttention(attention) : 'wait'
  }
  return 'none'
}

function actionForAttention(attention?: RunAttention): NextAction {
  switch (attention?.reason) {
    case AttentionReason.PermissionRestoreFailed:
    case AttentionReason.RunStalled:
      return 'open-session'
    case AttentionReason.HostDisconnected:
      return 'wait'
    case AttentionReason.AwaitUserAnswer:
    case AttentionReason.PermissionConfirm:
    default:
      return 'reply'
  }
}

function calculateElapsedMs(startedAt: string, endedAt: string): number | undefined {
  const started = Date.parse(startedAt)
  const ended = Date.parse(endedAt)
  if (!Number.isFinite(started) || !Number.isFinite(ended)) return undefined
  return Math.max(0, ended - started)
}
