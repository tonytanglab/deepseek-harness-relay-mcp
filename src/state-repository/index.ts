export { FileLockFacade, type FileLockLease, type FileLockOptions } from './file-lock-facade.js'
export { atomicWriteJson, readUtf8File, restrictPermissions } from './atomic-json-file.js'
export {
  legacySchemaVersion,
  migrationMarker,
  normalizeStateInput,
  parseAndNormalizeState,
  StateAuthorityMismatchError,
  validateV3State,
} from './state-schema.js'
