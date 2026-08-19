import assert from 'node:assert/strict'
import test from 'node:test'
import { HarnessGatewayFacade, type HarnessGatewayProvider } from '../src/harness-gateway/index.js'
import {
  createHarnessPlugin,
  preflightHarnessProfile,
  type HarnessPluginContext,
  type HarnessSchemaFactory,
} from '../src/harness-plugin/index.js'
import { PermissionGatewayFacade, type PermissionProvider } from '../src/permission-gateway/index.js'

test('Cordis plugin factory exposes native injects and disposes infrastructure without cancelling runs', async () => {
  const schema = new RecordingSchemaFactory()
  const lifecycle: string[] = []
  let installer: (() => Promise<() => Promise<void>>) | undefined
  const ctx: HarnessPluginContext = {
    apiProxy: {},
    webServer: {},
    sessions: {},
    permissionPresets: {},
    effect(install) {
      installer = install
      return () => {}
    },
  }
  const gateway = new HarnessGatewayFacade(new Proxy({}, {
    get: () => async () => { throw new Error('not used') },
  }) as HarnessGatewayProvider)
  const permissions = new PermissionGatewayFacade(new Proxy({}, {
    get: () => async () => { throw new Error('not used') },
  }) as PermissionProvider)
  const plugin = createHarnessPlugin({
    schema,
    createAdapters: () => ({ gateway, permissions }),
    async startAuthority() {
      lifecycle.push('started')
      return {
        async disposeInfrastructure({ drainTimeoutMs }) {
          lifecycle.push(`disposed:${drainTimeoutMs}`)
        },
      }
    },
  })

  assert.equal(plugin.name, 'harness-relay-mcp')
  assert.deepEqual(plugin.inject, ['apiProxy', 'webServer', 'sessions', 'permissionPresets'])
  assert.equal(schema.fields.includes('token'), false)
  assert.deepEqual(schema.fields, [
    'route',
    'stateDirectory',
    'tokenFile',
    'requestBodyLimitBytes',
    'maxConcurrency',
    'rateLimitPerMinute',
    'drainTimeoutMs',
  ])

  plugin.apply(ctx, { drainTimeoutMs: 750 })
  assert(installer !== undefined)
  const dispose = await installer()
  await dispose()
  assert.deepEqual(lifecycle, ['started', 'disposed:750'])
})

test('headless profile preflight blocks before profile mutation', () => {
  assert.deepEqual(preflightHarnessProfile({ profile: 'headless', availableServices: [] }), {
    ready: false,
    code: 'HARNESS_WEB_PROFILE_REQUIRED',
    missingServices: [],
    message: 'DSH Relay requires the Harness web profile; received headless',
  })
  assert.deepEqual(preflightHarnessProfile({
    profile: 'web',
    availableServices: ['apiProxy', 'sessions', 'permissionPresets'],
  }), {
    ready: false,
    code: 'HARNESS_SERVICES_MISSING',
    missingServices: ['webServer'],
    message: 'Harness web profile is missing required services: webServer',
  })
  assert.equal(preflightHarnessProfile({
    profile: 'web',
    availableServices: ['apiProxy', 'webServer', 'sessions', 'permissionPresets'],
  }).ready, true)
})

class RecordingSchemaFactory implements HarnessSchemaFactory {
  readonly fields: string[] = []

  string(): ChainSchema {
    return new ChainSchema()
  }

  natural(): ChainSchema {
    return new ChainSchema()
  }

  object(shape: Record<string, unknown>): unknown {
    this.fields.push(...Object.keys(shape))
    return shape
  }
}

class ChainSchema {
  default(_value: string | number): ChainSchema { return this }
  min(_value: number): ChainSchema { return this }
  max(_value: number): ChainSchema { return this }
}
