import { HarnessGatewayFacade } from './harness-gateway-facade.js'
import { HttpHarnessGateway } from './http-harness-gateway.js'
import { InProcessDispatchHandler } from './in-process-dispatch-handler.js'
import { InProcessHarnessGateway, type InProcessApiClientPort } from './in-process-harness-gateway.js'

export { HarnessGatewayFacade } from './harness-gateway-facade.js'
export { HostRpcError } from './host-errors.js'
export { InProcessDispatchHandler } from './in-process-dispatch-handler.js'
export { InProcessHarnessGateway } from './in-process-harness-gateway.js'
export type { InProcessApiClientPort, InProcessRpcResponse } from './in-process-harness-gateway.js'
export type {
  HarnessGatewayProvider,
  BeforeDispatch,
  GatewayHostFrame,
  GatewayMuxFrame,
  GatewayStreamEnvelope,
  HarnessEventGatewayProvider,
  HistoryPage,
  HistoryRequest,
  PromptAcceptance,
  QueueUpdateRequest,
  SessionCreateRequest,
  SessionCreateResult,
  SessionSummary,
  SettingsDescription,
  SettingsNamespace,
  WorkspaceCatalog,
  WorkspaceView,
} from './types.js'

export function createHttpHarnessGateway(baseUrl: string, timeoutMs: number, fetchImpl: typeof fetch = fetch): HarnessGatewayFacade {
  return new HarnessGatewayFacade(new HttpHarnessGateway(baseUrl, timeoutMs, fetchImpl))
}

/**
 * Create the embedded semantic gateway over Harness's official in-process client.
 * @param client - Client constructed with `InProcessApiClient(toFetchHandler(ctx.apiProxy))`.
 * @param permissions - Native permission facade for the same Harness context.
 * @returns Transport-free Relay gateway facade.
 */
export function createInProcessHarnessGateway(
  client: InProcessApiClientPort,
  permissions: import('../permission-gateway/index.js').PermissionGateway,
  dispatchHandler: InProcessDispatchHandler,
): HarnessGatewayFacade {
  return new HarnessGatewayFacade(new InProcessHarnessGateway(client, permissions, dispatchHandler))
}
