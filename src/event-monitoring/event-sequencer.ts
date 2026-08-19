import type { RpcEvent } from '../types.js'

interface SessionSequence {
  durableSeq?: number
  awaitingHistory: boolean
  pending: Map<number, RpcEvent>
}

export interface SequenceObservation {
  kind: 'duplicate' | 'progress' | 'history-required' | 'overflow'
  observedSeq: number
  expectedSeq?: number
}

/** Orders stream hints while leaving durable history as the only baseline authority. */
export class EventSequencer {
  private readonly sessions = new Map<string, SessionSequence>()

  constructor(private readonly maxPendingPerSession: number) {}

  subscribe(sessionId: string): void {
    const state = this.stateFor(sessionId)
    state.awaitingHistory = true
  }

  observe(sessionId: string, event: RpcEvent): SequenceObservation {
    const state = this.stateFor(sessionId)
    if (state.durableSeq !== undefined && event.seq <= state.durableSeq) {
      return { kind: 'duplicate', observedSeq: event.seq }
    }
    if (state.pending.has(event.seq)) return { kind: 'duplicate', observedSeq: event.seq }
    if (state.pending.size >= this.maxPendingPerSession) {
      state.pending.clear()
      state.awaitingHistory = true
      return { kind: 'overflow', observedSeq: event.seq }
    }
    state.pending.set(event.seq, event)
    if (state.durableSeq === undefined || state.awaitingHistory) {
      return { kind: 'history-required', observedSeq: event.seq }
    }
    const expectedSeq = state.durableSeq + 1
    if (event.seq !== expectedSeq) {
      state.awaitingHistory = true
      return { kind: 'history-required', observedSeq: event.seq, expectedSeq }
    }
    this.advanceContiguous(state)
    return { kind: 'progress', observedSeq: event.seq }
  }

  rebase(sessionId: string, durableLastSeq: number): { gap: boolean; expectedSeq?: number; observedSeq?: number } {
    const state = this.stateFor(sessionId)
    state.durableSeq = durableLastSeq
    state.awaitingHistory = false
    for (const seq of state.pending.keys()) {
      if (seq <= durableLastSeq) state.pending.delete(seq)
    }
    this.advanceContiguous(state)
    const firstPending = minimum(state.pending.keys())
    if (firstPending === undefined) return { gap: false }
    const expectedSeq = (state.durableSeq ?? durableLastSeq) + 1
    if (firstPending === expectedSeq) {
      this.advanceContiguous(state)
      return { gap: false }
    }
    state.awaitingHistory = true
    return { gap: true, expectedSeq, observedSeq: firstPending }
  }

  since(): Record<string, number> {
    const result: Record<string, number> = {}
    for (const [sessionId, state] of this.sessions) {
      if (state.durableSeq !== undefined) result[sessionId] = state.durableSeq
    }
    return result
  }

  private stateFor(sessionId: string): SessionSequence {
    let state = this.sessions.get(sessionId)
    if (state === undefined) {
      state = { awaitingHistory: true, pending: new Map() }
      this.sessions.set(sessionId, state)
    }
    return state
  }

  private advanceContiguous(state: SessionSequence): void {
    if (state.durableSeq === undefined) return
    while (state.pending.delete(state.durableSeq + 1)) state.durableSeq += 1
  }
}

function minimum(values: Iterable<number>): number | undefined {
  let result: number | undefined
  for (const value of values) {
    if (result === undefined || value < result) result = value
  }
  return result
}
