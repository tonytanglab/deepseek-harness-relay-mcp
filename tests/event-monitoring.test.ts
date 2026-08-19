import assert from 'node:assert/strict'
import test from 'node:test'
import {
  EventMonitoringFacade,
  EventSequencer,
  type EventMonitoringNotice,
  type HarnessEventSource,
} from '../src/event-monitoring/index.js'
import type {
  GatewayHostFrame,
  GatewayMuxFrame,
  GatewayStreamEnvelope,
} from '../src/harness-gateway/index.js'

test('sequencer deduplicates, buffers out-of-order events, and rebases only from durable history', () => {
  const sequencer = new EventSequencer(10)
  sequencer.subscribe('session-1')

  assert.deepEqual(sequencer.observe('session-1', event(0)), {
    kind: 'history-required',
    observedSeq: 0,
  })
  assert.deepEqual(sequencer.rebase('session-1', -1), { gap: false })
  assert.deepEqual(sequencer.since(), { 'session-1': 0 })
  assert.deepEqual(sequencer.observe('session-1', event(0)), { kind: 'duplicate', observedSeq: 0 })
  assert.deepEqual(sequencer.observe('session-1', event(2)), {
    kind: 'history-required',
    observedSeq: 2,
    expectedSeq: 1,
  })
  assert.deepEqual(sequencer.observe('session-1', event(1)), {
    kind: 'history-required',
    observedSeq: 1,
  })
  assert.deepEqual(sequencer.rebase('session-1', 0), { gap: false })
  assert.deepEqual(sequencer.since(), { 'session-1': 2 })
})

test('sequencer fails over to polling when pending gap storage overflows', () => {
  const sequencer = new EventSequencer(1)
  sequencer.rebase('session-overflow', 0)
  assert.equal(sequencer.observe('session-overflow', event(2)).kind, 'history-required')
  assert.deepEqual(sequencer.observe('session-overflow', event(3)), {
    kind: 'overflow',
    observedSeq: 3,
  })
})

test('event monitoring emits reconciliation hints and never treats stream frames as durable state', async () => {
  const notices: EventMonitoringNotice[] = []
  const source = sourceWithFrames([
    mux('sub-1', { type: 'session/subscribed', sessionId: 'session-1', lastSeq: -1 }),
    mux('event-1', { type: 'session/event', sessionId: 'session-1', event: event(0) }),
    mux('event-duplicate', { type: 'session/event', sessionId: 'session-1', event: event(0) }),
  ], [
    host('host-1', { type: 'host/session-status', sessionId: 'session-1', running: true }),
  ])
  const monitoring = new EventMonitoringFacade(source, notice => { notices.push(notice) }, { reconnectDelayMs: 5 })
  const handle = monitoring.start()
  await waitFor(() => notices.filter(notice => notice.kind === 'history-reconcile').length >= 3)
  monitoring.confirmHistory('session-1', 0)
  await waitFor(() => notices.some(notice => notice.kind === 'session-stream-rebased'))
  await handle.dispose()

  const reconciles = notices.filter(notice => notice.kind === 'history-reconcile')
  assert(reconciles.some(notice => notice.reason === 'subscribed'))
  assert(reconciles.some(notice => notice.reason === 'sequence-gap'))
  assert(reconciles.some(notice => notice.reason === 'host-session-change'))
  assert.equal(reconciles.filter(notice => notice.observedSeq === 0).length, 1)
  assert(notices.some(notice => notice.kind === 'session-stream-rebased' && notice.durableLastSeq === 0))
})

test('a live sequence gap explicitly keeps session polling enabled', async () => {
  const notices: EventMonitoringNotice[] = []
  let releaseGap: (() => void) | undefined
  const gapGate = new Promise<void>(resolve => { releaseGap = resolve })
  const source: HarnessEventSource = {
    async *openMuxEvents(_since, signal, onOpen) {
      onOpen?.()
      yield mux('sub-gap', { type: 'session/subscribed', sessionId: 'session-gap', lastSeq: 0 })
      await gapGate
      yield mux('event-gap', { type: 'session/event', sessionId: 'session-gap', event: event(2) })
      await waitForAbort(signal)
    },
    async *openHostEvents(signal, onOpen) {
      onOpen?.()
      await waitForAbort(signal)
    },
  }
  const monitoring = new EventMonitoringFacade(source, notice => { notices.push(notice) }, { reconnectDelayMs: 5 })
  const handle = monitoring.start()
  await waitFor(() => notices.some(notice => notice.kind === 'history-reconcile' && notice.reason === 'subscribed'))
  monitoring.confirmHistory('session-gap', 0)
  releaseGap?.()
  await waitFor(() => notices.some(notice => notice.kind === 'polling-required' && notice.scope === 'session'))
  await handle.dispose()

  assert(notices.some(notice => notice.kind === 'polling-required'
    && notice.scope === 'session'
    && notice.reason === 'sequence-gap'))
})

test('approval and question frames only produce deduplicated attention notifications', async () => {
  const notices: EventMonitoringNotice[] = []
  const approval: GatewayMuxFrame = {
    type: 'approval/requested',
    sessionId: 'session-attention',
    approvalId: 'approval-1',
    toolName: 'bash',
  }
  const question: GatewayMuxFrame = {
    type: 'question/requested',
    sessionId: 'session-attention',
    questions: [{ id: 'q1', question: 'Proceed?' }],
  }
  const source = sourceWithFrames([
    mux('approval-rpc', approval),
    mux('approval-rpc', approval),
    mux('question-rpc', question),
    mux('question-rpc', question),
  ], [])
  const monitoring = new EventMonitoringFacade(source, notice => { notices.push(notice) }, { reconnectDelayMs: 5 })
  const handle = monitoring.start()
  await waitFor(() => notices.filter(notice => notice.kind === 'attention-required').length === 2)
  await handle.dispose()

  assert.deepEqual(
    notices.filter(notice => notice.kind === 'attention-required').map(notice => [notice.interaction, notice.rpcId]),
    [['approval', 'approval-rpc'], ['question', 'question-rpc']],
  )
  assert.equal('responses' in source, false)
})

test('stream disconnect enables polling and a later open reports restoration', async () => {
  const notices: EventMonitoringNotice[] = []
  let muxOpens = 0
  const source: HarnessEventSource = {
    async *openMuxEvents(_since, signal, onOpen) {
      muxOpens += 1
      onOpen?.()
      if (muxOpens === 1) return
      await waitForAbort(signal)
    },
    async *openHostEvents(signal, onOpen) {
      onOpen?.()
      await waitForAbort(signal)
    },
  }
  const monitoring = new EventMonitoringFacade(source, notice => { notices.push(notice) }, { reconnectDelayMs: 5 })
  const handle = monitoring.start()
  await waitFor(() => notices.some(notice => notice.kind === 'polling-required' && notice.scope === 'mux'))
  await waitFor(() => notices.some(notice => notice.kind === 'stream-restored' && notice.stream === 'mux'))
  await handle.dispose()

  assert(muxOpens >= 2)
})

function sourceWithFrames(
  muxFrames: Array<GatewayStreamEnvelope<GatewayMuxFrame>>,
  hostFrames: Array<GatewayStreamEnvelope<GatewayHostFrame>>,
): HarnessEventSource {
  return {
    async *openMuxEvents(_since, signal, onOpen) {
      onOpen?.()
      for (const frame of muxFrames) yield frame
      await waitForAbort(signal)
    },
    async *openHostEvents(signal, onOpen) {
      onOpen?.()
      for (const frame of hostFrames) yield frame
      await waitForAbort(signal)
    },
  }
}

function mux(rpcId: string, payload: GatewayMuxFrame): GatewayStreamEnvelope<GatewayMuxFrame> {
  return { rpcId, payload }
}

function host(rpcId: string, payload: GatewayHostFrame): GatewayStreamEnvelope<GatewayHostFrame> {
  return { rpcId, payload }
}

function event(seq: number) {
  return { type: 'assistant/message', seq, time: 1_786_800_000_000 + seq, data: {} }
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('timed out waiting for event-monitoring observation')
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}

function waitForAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve()
  return new Promise(resolve => signal.addEventListener('abort', () => resolve(), { once: true }))
}
