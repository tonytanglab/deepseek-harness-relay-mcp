import { setTimeout as delay } from 'node:timers/promises'
import type { GatewayHostFrame, GatewayMuxFrame } from '../harness-gateway/index.js'
import { EventSequencer } from './event-sequencer.js'
import type {
  EventMonitoringHandle,
  EventMonitoringNotice,
  EventMonitoringOptions,
  EventMonitoringSink,
  HarnessEventSource,
} from './types.js'

const DEFAULT_OPTIONS: EventMonitoringOptions = {
  reconnectDelayMs: 250,
  maxPendingEventsPerSession: 1_000,
  maxRememberedInteractions: 2_048,
}

/** Embedded stream accelerator; every state-changing hint still requests durable history reconciliation. */
export class EventMonitoringFacade {
  private readonly options: EventMonitoringOptions
  private readonly sequencer: EventSequencer
  private readonly seenInteractions = new Map<string, true>()
  private readonly approvalRpcIds = new Map<string, string>()
  private emitTail: Promise<void> = Promise.resolve()
  private controller: AbortController | undefined
  private pumps: Promise<void>[] = []
  private readonly degradedStreams = new Set<'mux' | 'host'>()

  constructor(
    private readonly source: HarnessEventSource,
    private readonly sink: EventMonitoringSink,
    options: Partial<EventMonitoringOptions> = {},
  ) {
    this.options = validateOptions({ ...DEFAULT_OPTIONS, ...options })
    this.sequencer = new EventSequencer(this.options.maxPendingEventsPerSession)
  }

  start(): EventMonitoringHandle {
    if (this.controller !== undefined) throw new Error('event monitoring is already running')
    const controller = new AbortController()
    this.controller = controller
    this.pumps = [this.pumpMux(controller.signal), this.pumpHost(controller.signal)]
    return {
      dispose: async () => {
        controller.abort()
        await Promise.allSettled(this.pumps)
        await this.emitTail
        if (this.controller === controller) this.controller = undefined
      },
    }
  }

  /**
   * Confirm the last sequence read from durable Harness history.
   * @param sessionId - Reconciled session.
   * @param durableLastSeq - History's authoritative last sequence.
   */
  confirmHistory(sessionId: string, durableLastSeq: number): void {
    const result = this.sequencer.rebase(sessionId, durableLastSeq)
    this.emit({ kind: 'session-stream-rebased', sessionId, durableLastSeq })
    if (result.gap) {
      this.emit({
        kind: 'polling-required',
        scope: 'session',
        reason: 'sequence-gap',
        sessionId,
        ...(result.observedSeq === undefined ? {} : { message: `expected ${result.expectedSeq}; observed ${result.observedSeq}` }),
      })
    }
  }

  private async pumpMux(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      try {
        const stream = this.source.openMuxEvents(this.sequencer.since(), signal, () => this.restored('mux'))
        for await (const envelope of stream) {
          if (signal.aborted) break
          await this.handleMux(envelope.rpcId, envelope.payload)
        }
        if (!signal.aborted) await this.disconnected('mux', 'stream-disconnected')
      } catch (error: unknown) {
        if (!signal.aborted) await this.disconnected('mux', 'stream-error', error)
      }
      await reconnectDelay(this.options.reconnectDelayMs, signal)
    }
  }

  private async pumpHost(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      try {
        const stream = this.source.openHostEvents(signal, () => this.restored('host'))
        for await (const envelope of stream) {
          if (signal.aborted) break
          await this.handleHost(envelope.payload)
        }
        if (!signal.aborted) await this.disconnected('host', 'stream-disconnected')
      } catch (error: unknown) {
        if (!signal.aborted) await this.disconnected('host', 'stream-error', error)
      }
      await reconnectDelay(this.options.reconnectDelayMs, signal)
    }
  }

  private async handleMux(rpcId: string, frame: GatewayMuxFrame): Promise<void> {
    switch (frame.type) {
      case 'session/subscribed':
        this.sequencer.subscribe(frame.sessionId)
        await this.emit({ kind: 'history-reconcile', sessionId: frame.sessionId, reason: 'subscribed', observedSeq: frame.lastSeq })
        return
      case 'session/event': {
        const result = this.sequencer.observe(frame.sessionId, frame.event)
        if (result.kind === 'duplicate') return
        if (result.kind === 'overflow') {
          await this.emit({ kind: 'polling-required', scope: 'session', reason: 'pending-overflow', sessionId: frame.sessionId })
        }
        if (result.kind === 'history-required' && result.expectedSeq !== undefined) {
          await this.emit({
            kind: 'polling-required',
            scope: 'session',
            reason: 'sequence-gap',
            sessionId: frame.sessionId,
            message: `expected ${result.expectedSeq}; observed ${result.observedSeq}`,
          })
        }
        await this.emit({
          kind: 'history-reconcile',
          sessionId: frame.sessionId,
          reason: result.kind === 'progress' ? 'session-event' : 'sequence-gap',
          observedSeq: result.observedSeq,
          ...(result.expectedSeq === undefined ? {} : { expectedSeq: result.expectedSeq }),
        })
        return
      }
      case 'approval/requested':
        this.approvalRpcIds.set(frame.approvalId, rpcId)
        trimOldest(this.approvalRpcIds, this.options.maxRememberedInteractions)
        await this.attentionRequired('approval', rpcId, frame.sessionId, {
          approvalId: frame.approvalId,
          toolName: frame.toolName,
          ...(frame.callId === undefined ? {} : { callId: frame.callId }),
          ...(frame.reason === undefined ? {} : { reason: frame.reason }),
        })
        return
      case 'question/requested':
        await this.attentionRequired('question', rpcId, frame.sessionId, { questions: frame.questions })
        return
      case 'approval/resolved': {
        const requestRpcId = this.approvalRpcIds.get(frame.approvalId)
        this.approvalRpcIds.delete(frame.approvalId)
        if (requestRpcId !== undefined) {
          await this.attentionResolved('approval', requestRpcId, frame.sessionId, frame.outcome)
        }
        return
      }
      case 'question/resolved':
        await this.attentionResolved('question', frame.questionRpcId, frame.sessionId, frame.outcome)
        return
      case 'stream/error':
        throw new Error(`${frame.error.code}: ${frame.error.message}`)
      default:
        return
    }
  }

  private async handleHost(frame: GatewayHostFrame): Promise<void> {
    switch (frame.type) {
      case 'host/session-added':
      case 'host/session-removed':
      case 'host/session-status':
        await this.emit({ kind: 'history-reconcile', sessionId: frame.sessionId, reason: 'host-session-change' })
        return
      case 'host/agent-error':
        await this.emit({ kind: 'history-reconcile', sessionId: frame.sessionId, reason: 'host-agent-error' })
        return
      case 'stream/error':
        throw new Error(`${frame.error.code}: ${frame.error.message}`)
      default:
        return
    }
  }

  private async attentionRequired(
    interaction: 'approval' | 'question',
    rpcId: string,
    sessionId: string,
    details: Record<string, unknown>,
  ): Promise<void> {
    const key = `${interaction}:${rpcId}`
    if (this.seenInteractions.has(key)) return
    this.seenInteractions.set(key, true)
    trimOldest(this.seenInteractions, this.options.maxRememberedInteractions)
    await this.emit({ kind: 'attention-required', interaction, rpcId, sessionId, details })
  }

  private async attentionResolved(
    interaction: 'approval' | 'question',
    rpcId: string,
    sessionId: string,
    outcome: string,
  ): Promise<void> {
    const key = `resolved:${interaction}:${rpcId}:${outcome}`
    if (this.seenInteractions.has(key)) return
    this.seenInteractions.set(key, true)
    trimOldest(this.seenInteractions, this.options.maxRememberedInteractions)
    await this.emit({ kind: 'attention-resolved', interaction, rpcId, sessionId, outcome })
  }

  private restored(stream: 'mux' | 'host'): void {
    if (!this.degradedStreams.delete(stream)) return
    this.emit({ kind: 'stream-restored', stream })
  }

  private async disconnected(
    stream: 'mux' | 'host',
    reason: 'stream-disconnected' | 'stream-error',
    error?: unknown,
  ): Promise<void> {
    this.degradedStreams.add(stream)
    await this.emit({
      kind: 'polling-required',
      scope: stream,
      reason,
      ...(error === undefined ? {} : { message: error instanceof Error ? error.message : String(error) }),
    })
  }

  private emit(notice: EventMonitoringNotice): Promise<void> {
    const emitted = this.emitTail.then(() => this.sink(notice))
    this.emitTail = emitted.then(() => {}, () => {})
    return emitted
  }
}

function trimOldest<T>(map: Map<string, T>, maximum: number): void {
  while (map.size > maximum) {
    const oldest = map.keys().next().value
    if (oldest === undefined) return
    map.delete(oldest)
  }
}

function validateOptions(options: EventMonitoringOptions): EventMonitoringOptions {
  for (const [name, value] of Object.entries(options)) {
    if (!Number.isInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`)
  }
  return options
}

async function reconnectDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return
  try {
    await delay(milliseconds, undefined, { signal })
  } catch (error: unknown) {
    if (!signal.aborted) throw error
  }
}
