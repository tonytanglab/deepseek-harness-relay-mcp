import assert from 'node:assert/strict'
import test from 'node:test'
import {
  ExternalPermissionProvider,
  InProcessPermissionProvider,
  PermissionGatewayError,
  PermissionGatewayFacade,
  type ExternalPermissionClient,
  type PermissionPreset,
} from '../src/permission-gateway/index.js'

test('current rejects a permission value outside the native preset set', async () => {
  const client = new RecordingPermissionClient('administrator')
  const gateway = gatewayFor(client)

  await assert.rejects(
    gateway.current('session-invalid'),
    (error: unknown) => {
      assert(error instanceof PermissionGatewayError)
      assert.equal(error.code, 'PERMISSION_UNAVAILABLE')
      assert.equal(error.definitive, true)
      assert.equal(error.retryable, false)
      assert.deepEqual(error.details, { sessionId: 'session-invalid', actual: 'administrator' })
      return true
    },
  )
  assert.deepEqual(client.calls, ['read:session-invalid'])
})

test('select requests the preset once and confirms it with one read', async () => {
  const client = new RecordingPermissionClient('read-only')
  client.onRequest = preset => {
    client.currentValue = preset
    return { kind: 'success' }
  }
  const gateway = gatewayFor(client)

  const selected = await gateway.select('session-select', 'workspace-write')

  assert.equal(selected, 'workspace-write')
  assert.deepEqual(client.calls, [
    'select:session-select:workspace-write',
    'read:session-select',
  ])
})

test('select rejects a denied command without an unnecessary confirmation read', async () => {
  const client = new RecordingPermissionClient('read-only')
  client.onRequest = () => ({ kind: 'denied' })
  const gateway = gatewayFor(client)

  await assert.rejects(
    gateway.select('session-denied', 'danger-full-access'),
    (error: unknown) => {
      assert(error instanceof PermissionGatewayError)
      assert.equal(error.code, 'PERMISSION_DENIED')
      assert.deepEqual(error.details, {
        sessionId: 'session-denied',
        expected: 'danger-full-access',
      })
      return true
    },
  )
  assert.deepEqual(client.calls, ['select:session-denied:danger-full-access'])
})

test('select rejects a successful command whose confirmed preset is inconsistent', async () => {
  const client = new RecordingPermissionClient('read-only')
  const gateway = gatewayFor(client)

  await assert.rejects(
    gateway.select('session-mismatch', 'workspace-write'),
    (error: unknown) => {
      assert(error instanceof PermissionGatewayError)
      assert.equal(error.code, 'PERMISSION_DENIED')
      assert.deepEqual(error.details, {
        sessionId: 'session-mismatch',
        expected: 'workspace-write',
        actual: 'read-only',
      })
      return true
    },
  )
  assert.deepEqual(client.calls, [
    'select:session-mismatch:workspace-write',
    'read:session-mismatch',
  ])
})

test('confirm only reads once and returns the matching preset', async () => {
  const client = new RecordingPermissionClient('danger-full-access')
  const gateway = gatewayFor(client)

  assert.equal(await gateway.confirm('session-confirm', 'danger-full-access'), 'danger-full-access')
  assert.deepEqual(client.calls, ['read:session-confirm'])
})

test('in-process provider uses native sessions and permission presets without chat commands', async () => {
  interface Event { preset: PermissionPreset }
  interface Session { events: Event[] }
  const session: Session = { events: [{ preset: 'read-only' }] }
  const calls: string[] = []
  const provider = new InProcessPermissionProvider<Session, Event>(
    sessionId => sessionId === 'session-native' ? session : undefined,
    value => value.events,
    {
      current(events) {
        calls.push('current')
        return events.at(-1)?.preset ?? 'read-only'
      },
      set(value, preset) {
        calls.push(`set:${preset}`)
        value.events.push({ preset: preset as PermissionPreset })
      },
    },
  )
  const gateway = new PermissionGatewayFacade(provider)

  assert.equal(await gateway.select('session-native', 'workspace-write'), 'workspace-write')
  assert.deepEqual(calls, ['set:workspace-write', 'current'])
  assert.deepEqual(session.events, [{ preset: 'read-only' }, { preset: 'workspace-write' }])
})

test('in-process provider fails closed when the native session is unavailable', async () => {
  const provider = new InProcessPermissionProvider<object, never>(
    () => undefined,
    () => [],
    { current: () => 'read-only', set: () => {} },
  )

  await assert.rejects(provider.readCurrent('missing'), (error: unknown) => {
    assert(error instanceof PermissionGatewayError)
    assert.equal(error.code, 'PERMISSION_UNAVAILABLE')
    return true
  })
})

function gatewayFor(client: ExternalPermissionClient): PermissionGatewayFacade {
  return new PermissionGatewayFacade(new ExternalPermissionProvider(client))
}

class RecordingPermissionClient implements ExternalPermissionClient {
  readonly calls: string[] = []
  onRequest: (preset: PermissionPreset) => { kind?: unknown } = () => ({ kind: 'success' })

  constructor(public currentValue: unknown) {}

  async readPermissionProjection(sessionId: string): Promise<{ currentValue?: unknown }> {
    this.calls.push(`read:${sessionId}`)
    return { currentValue: this.currentValue }
  }

  async requestPermissionSelection(sessionId: string, preset: PermissionPreset): Promise<{ kind?: unknown }> {
    this.calls.push(`select:${sessionId}:${preset}`)
    return this.onRequest(preset)
  }
}
