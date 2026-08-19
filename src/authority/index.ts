export { AuthorityRegistryFacade, AuthorityConflictError } from './authority-registry-facade.js'
export { deriveAuthorityId, hostIdentityKey, normalizeHostIdentity } from './host-identity.js'
export { resolveAuthorityStatePaths } from './authority-paths.js'
export { RelayEndpointPublisher } from './endpoint-descriptor.js'
export type {
  AcquireAuthorityInput,
  AuthorityOwnerLease,
  AuthorityOwnerRecord,
  AuthorityStatePaths,
  EndpointDescriptorInput,
  RelayEndpointDescriptor,
  ResolveAuthorityPathsInput,
} from './types.js'
