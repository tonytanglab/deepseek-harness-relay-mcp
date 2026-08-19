import type { PermissionGatewayFacade } from '../permission-gateway/index.js'
import type { RelayStateStoreOptions } from '../state-store.js'

export interface RelayFacadeOptions {
  stateStore?: RelayStateStoreOptions
  permissionGateway?: PermissionGatewayFacade
}
