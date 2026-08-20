export {
  AuthorityAcquireCancelledError,
  AuthorityConflictError,
  AuthorityRegistryFacade,
} from './authority-registry-facade.js'
export { deriveAuthorityId, hostIdentityKey, normalizeHostIdentity } from './host-identity.js'
export { resolveAuthorityStatePaths } from './authority-paths.js'
export { RelayEndpointPublisher } from './endpoint-descriptor.js'
export type {
  AcquireAuthorityInput,
  AuthorityAcquireRetryOptions,
  AuthorityOwnerLease,
  AuthorityOwnerRecord,
  AuthorityStatePaths,
  EndpointDescriptorInput,
  RelayEndpointDescriptor,
  ResolveAuthorityPathsInput,
} from './types.js'
export type { AuthorityRegistryDependencies } from './authority-registry-facade.js'
