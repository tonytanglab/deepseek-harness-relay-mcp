import assert from 'node:assert/strict'
import test from 'node:test'
import {
  AttentionReason,
  MonitoringError,
  MonitoringFacade,
  type RunAttention,
  type RunSnapshot,
} from '../src/monitoring/index.js'

const startedAt = '2026-08-19T00:00:00.000Z'
const finishedAt = '2026-08-19T00:00:05.000Z'

function snapshot(status: RunSnapshot['status']): RunSnapshot {
  return {
    runId: `run-${status}`,
    serviceId: 'service-1',
    sessionId: 'session-1',
    sessionReused: false,
    parentRunId: null,
    workspace: 'C:\\workspace',
    webUrl: 'http://127.0.0.1:3080/?sessionId=session-1',
    status,
    modelSelection: { provider: 'kimi-coding', model: 'k3', reasoningEffort: 'max' },
    permissionPreset: 'read-only',
    agentPreset: null,
    modelDefaultRestore: 'not-needed',
    warnings: [],
    task: 'review',
    taskPersisted: false,
    taskImageCount: 0,
    cancelRequested: false,
    startedAt,
    finishedAt: status === 'succeeded' || status === 'failed' || status === 'cancelled' ? finishedAt : null,
    promptAdmission: 'accepted',
    promptMessageId: 'message-1',
    assistantText: '',
    assistantTextBytes: 0,
    assistantTextTruncated: false,
    lastEventSeq: 1,
    error: null,
  }
}

test('projects every current RunSnapshot status without defining a parallel status', () => {
  const facade = new MonitoringFacade()
  const expected = new Map<RunSnapshot['status'], string>([
    ['running', 'wait'],
    ['needs_attention', 'reply'],
    ['succeeded', 'none'],
    ['incomplete', 'reply'],
    ['failed', 'none'],
    ['cancelled', 'none'],
    ['unknown', 'wait'],
  ])

  for (const [status, nextAction] of expected) {
    const summary = facade.project(snapshot(status), { updatedAt: finishedAt })
    assert.equal(summary.status, status)
    assert.equal(summary.nextAction, nextAction)
    assert.equal(summary.provider, 'kimi-coding')
    assert.equal(summary.model, 'k3')
    assert.equal(summary.reasoningEffort, 'max')
    assert.equal(summary.permissionMode, 'read-only')
    assert.equal(summary.elapsedMs, 5000)
  }
})

test('maps every attention reason to an executable next action', () => {
  const facade = new MonitoringFacade()
  const expected = new Map<AttentionReason, string>([
    [AttentionReason.AwaitUserAnswer, 'reply'],
    [AttentionReason.PermissionConfirm, 'reply'],
    [AttentionReason.HostDisconnected, 'wait'],
    [AttentionReason.PermissionRestoreFailed, 'open-session'],
  ])

  for (const [reason, nextAction] of expected) {
    const attention: RunAttention = { reason, detail: `detail:${reason}` }
    const summary = facade.project(snapshot('running'), { attention })
    assert.equal(summary.attention?.reason, reason)
    assert.equal(summary.nextAction, nextAction)
  }
})

test('reports CURSOR_EXPIRED with gap and resync metadata after queue overflow', () => {
  const facade = new MonitoringFacade({ maxQueueItems: 2, maxQueueBytes: 1024 * 1024 })
  facade.publishNotification({ runId: 'run-1', kind: 'log', payload: { message: 'one' } })
  facade.publishNotification({ runId: 'run-1', kind: 'log', payload: { message: 'two' } })
  const result = facade.publishNotification({ runId: 'run-1', kind: 'log', payload: { message: 'three' } })

  assert.equal(result.overflowed, true)
  assert.deepEqual(result.resync, {
    kind: 'resync-required',
    reason: 'queue-overflow',
    discardedThroughCursor: '1',
    latestCursor: '3',
  })
  assert.throws(
    () => facade.readNotifications('0'),
    (error: unknown) => {
      assert.ok(error instanceof MonitoringError)
      assert.equal(error.code, 'CURSOR_EXPIRED')
      assert.equal(error.details.resync?.kind, 'resync-required')
      assert.equal(error.details.resync?.reason, 'cursor-expired')
      assert.equal(error.details.latestCursor, '3')
      return true
    },
  )

  const page = facade.readNotifications('1')
  assert.deepEqual(page.notifications.map(item => item.payload.message), ['two', 'three'])
  assert.equal(page.nextCursor, '3')
})

test('rejects one notification that cannot fit without advancing the cursor', () => {
  const facade = new MonitoringFacade({ maxQueueItems: 2, maxQueueBytes: 128 })
  assert.throws(
    () => facade.publishNotification({ runId: 'run-1', kind: 'log', payload: { message: 'x'.repeat(256) } }),
    (error: unknown) => error instanceof MonitoringError && error.code === 'NOTIFICATION_TOO_LARGE',
  )
  assert.equal(facade.readNotifications().nextCursor, '0')
})

test('deep-clones published notification input and returned values', () => {
  const facade = new MonitoringFacade()
  const payload = { nested: { message: 'original' } }
  const published = facade.publishNotification({ runId: 'run-1', kind: 'log', payload })
  payload.nested.message = 'mutated-input'
  ;(published.notification.payload.nested as { message: string }).message = 'mutated-result'

  const stored = facade.readNotifications('0').notifications[0]
  assert.deepEqual(stored?.payload, { nested: { message: 'original' } })
})

test('advertises polling and snapshot fallbacks when client notifications degrade', () => {
  const facade = new MonitoringFacade()
  const full = facade.getCapabilities({ notifications: true, progress: true })
  assert.equal(full.features.notifications.enabled, true)
  assert.equal(full.features.cursorReplay.enabled, true)
  assert.equal(full.features.progress.enabled, true)

  const unspecified = facade.getCapabilities()
  assert.equal(unspecified.features.notifications.enabled, false)
  assert.equal(unspecified.features.progress.enabled, false)

  const degraded = facade.getCapabilities({ notifications: false, progress: false })
  assert.deepEqual(degraded.features.notifications, {
    enabled: false,
    version: '1.0.0',
    fallback: 'wait_run/status polling',
  })
  assert.equal(degraded.features.cursorReplay.enabled, false)
  assert.equal(degraded.features.cursorReplay.fallback, 'get_run_summary snapshot')
  assert.equal(degraded.features.progress.enabled, false)
})
