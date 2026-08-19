import type {
  GatewayHostFrame,
  GatewayMuxFrame,
  GatewayStreamEnvelope,
} from '../harness-gateway/index.js'

export interface HarnessEventSource {
  openMuxEvents(
    since: Record<string, number>,
    signal: AbortSignal,
    onOpen?: () => void,
  ): AsyncIterable<GatewayStreamEnvelope<GatewayMuxFrame>>
  openHostEvents(
    signal: AbortSignal,
    onOpen?: () => void,
  ): AsyncIterable<GatewayStreamEnvelope<GatewayHostFrame>>
}

export type HistoryReconcileReason =
  | 'subscribed'
  | 'session-event'
  | 'sequence-gap'
  | 'host-session-change'
  | 'host-agent-error'

export type EventMonitoringNotice =
  | {
    kind: 'history-reconcile'
    sessionId: string
    reason: HistoryReconcileReason
    observedSeq?: number
    expectedSeq?: number
  }
  | {
    kind: 'attention-required'
    interaction: 'approval' | 'question'
    rpcId: string
    sessionId: string
    details: Record<string, unknown>
  }
  | {
    kind: 'attention-resolved'
    interaction: 'approval' | 'question'
    rpcId: string
    sessionId: string
    outcome: string
  }
  | {
    kind: 'polling-required'
    scope: 'mux' | 'host' | 'session'
    reason: 'stream-disconnected' | 'stream-error' | 'sequence-gap' | 'pending-overflow'
    sessionId?: string
    message?: string
  }
  | {
    kind: 'stream-restored'
    stream: 'mux' | 'host'
  }
  | {
    kind: 'session-stream-rebased'
    sessionId: string
    durableLastSeq: number
  }

export interface EventMonitoringOptions {
  reconnectDelayMs: number
  maxPendingEventsPerSession: number
  maxRememberedInteractions: number
}

export type EventMonitoringSink = (notice: EventMonitoringNotice) => void | Promise<void>

export interface EventMonitoringHandle {
  dispose(): Promise<void>
}
