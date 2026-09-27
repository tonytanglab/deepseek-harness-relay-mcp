import type { PermissionGatewayFacade } from '../permission-gateway/index.js'
import type { RelayStateStoreOptions } from '../state-store.js'
import type { UserInteractionFacade } from '../user-interactions/index.js'

export interface RelayFacadeOptions {
  stateStore?: RelayStateStoreOptions
  permissionGateway?: PermissionGatewayFacade
  interactions?: UserInteractionFacade
}
