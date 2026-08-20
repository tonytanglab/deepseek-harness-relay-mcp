import type { HarnessGatewayFacade } from '../harness-gateway/index.js'
import type { PermissionGatewayFacade } from '../permission-gateway/index.js'
import { HARNESS_PLUGIN_NAME } from '../product-identity/index.js'
import {
  createHarnessConfigSchema,
  resolveHarnessPluginConfig,
  type HarnessPluginConfig,
  type HarnessSchemaFactory,
} from './config.js'

export const name = HARNESS_PLUGIN_NAME
export const inject = ['apiProxy', 'webServer', 'sessions', 'permissionPresets'] as const

export interface HarnessPluginContext {
  apiProxy: unknown
  webServer: unknown
  sessions: unknown
  permissionPresets: unknown
  effect(
    install: () => Promise<() => Promise<void>> | AsyncIterable<() => void | Promise<void>, void, void>,
    label?: string,
  ): unknown
}

export interface EmbeddedRelayAdapters {
  gateway: HarnessGatewayFacade
  permissions: PermissionGatewayFacade
}

/** Authority teardown deliberately excludes submitted Harness runs. */
export interface EmbeddedRelayAuthority {
  disposeInfrastructure(options: { drainTimeoutMs: number }): Promise<void>
}

export interface HarnessPluginRuntime<TContext extends HarnessPluginContext> {
  schema: HarnessSchemaFactory
  createAdapters(ctx: TContext): EmbeddedRelayAdapters
  startAuthority(
    ctx: TContext,
    config: HarnessPluginConfig,
    adapters: EmbeddedRelayAdapters,
    options: { signal: AbortSignal },
  ): Promise<EmbeddedRelayAuthority>
}

export interface HarnessPluginDefinition<TContext extends HarnessPluginContext> {
  name: typeof name
  inject: typeof inject
  Config: unknown
  apply(ctx: TContext, config: Partial<HarnessPluginConfig>): void
}

/**
 * Assemble the tree-external Cordis plugin around peer-backed Harness adapters.
 * @param runtime - Thin entry bindings for Schemastery, ApiProxy and MCP routing.
 * @returns Conventional Cordis name/inject/Config/apply exports.
 */
export function createHarnessPlugin<TContext extends HarnessPluginContext>(
  runtime: HarnessPluginRuntime<TContext>,
): HarnessPluginDefinition<TContext> {
  return {
    name,
    inject,
    Config: createHarnessConfigSchema(runtime.schema),
    apply(ctx, rawConfig) {
      const config = resolveHarnessPluginConfig(rawConfig)
      const adapters = runtime.createAdapters(ctx)
      ctx.effect(async function* () {
        const controller = new AbortController()
        yield () => controller.abort()
        const authority = await runtime.startAuthority(ctx, config, adapters, { signal: controller.signal })
        yield () => authority.disposeInfrastructure({ drainTimeoutMs: config.drainTimeoutMs })
      }, 'harness-relay-mcp.embedded-authority')
    },
  }
}
