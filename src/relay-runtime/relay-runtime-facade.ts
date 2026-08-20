import { RelayStatusFacade } from './status-store.js'
import { prepareRelayRuntimePaths, resolveRelayRuntimePaths } from './path-resolver.js'
import type { RelayRuntimePaths, RelayRuntimeResolveInput } from './types.js'

/** Public assembly point for runtime location and lifecycle status services. */
export class RelayRuntimeFacade {
  constructor(private readonly now: () => Date = () => new Date()) {}

  resolve(input: RelayRuntimeResolveInput): RelayRuntimePaths {
    return resolveRelayRuntimePaths(input)
  }

  async prepare(paths: RelayRuntimePaths): Promise<void> {
    await prepareRelayRuntimePaths(paths)
  }

  status(paths: RelayRuntimePaths): RelayStatusFacade {
    return new RelayStatusFacade(paths.statusFile, this.now)
  }
}
