export {
  FileLockFacade,
  defaultProcessProbe,
  processStartIdentity,
  reclaimStaleLock,
  type FileLockInspection,
  type FileLockLease,
  type FileLockOptions,
  type LockOwnerState,
  type LockRecord,
  type ProcessProbe,
} from './file-lock-facade.js'
export { atomicWriteJson, readUtf8File, restrictPermissions } from './atomic-json-file.js'
export {
  FilePermissionError,
  NodeFilePermissionBackend,
  currentUserPrincipal,
  runPermissionCommand,
  type FilePermissionBackend,
  type FilePermissionCheck,
  type PermissionCommandRunner,
} from './file-permissions.js'
export {
  legacySchemaVersion,
  migrationMarker,
  normalizeStateInput,
  parseAndNormalizeState,
  StateAuthorityMismatchError,
  validateV3State,
} from './state-schema.js'
