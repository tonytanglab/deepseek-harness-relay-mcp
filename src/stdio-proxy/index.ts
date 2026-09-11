export { readEndpointDescriptor } from './descriptor-reader.js'
export {
  backgroundSpawnOptions,
  HarnessHostAutostartFacade,
  type HarnessHostAutostartDependencies,
  type HarnessHostAutostartLock,
  type LoopbackPortState,
} from './host-autostart-facade.js'
export { ProxyDiagnosticsFacade, type ProxyDiagnosticsDependencies, type ProxyInspection } from './proxy-diagnostics-facade.js'
export { StdioProxyFacade } from './stdio-proxy-facade.js'
export type {
  ProxyDoctorReport,
  ProxyRouteFailure,
  ProxyRouteReasonCode,
  RelayEndpointDescriptor,
  StdioProxyConfig,
  StdioProxyDependencies,
} from './types.js'
