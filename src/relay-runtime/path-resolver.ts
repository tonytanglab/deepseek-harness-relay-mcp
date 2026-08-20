import { access, constants, mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { resolveAuthorityStatePaths } from '../authority/index.js'
import type { RelayRuntimePaths, RelayRuntimeResolveInput } from './types.js'

export type RelayRuntimePathErrorCode =
  | 'RELAY_HOME_INVALID'
  | 'RELAY_PROFILE_INVALID'
  | 'RELAY_STATE_DIRECTORY_INVALID'
  | 'RELAY_PATH_INVALID'

export class RelayRuntimePathError extends Error {
  readonly name = 'RelayRuntimePathError'

  constructor(
    readonly code: RelayRuntimePathErrorCode,
    message: string,
    readonly source: string,
    readonly remediation: string,
    options?: ErrorOptions,
  ) {
    super(message, options)
  }
}

/**
 * Resolve all embedded/proxy runtime locations from one environment contract.
 * The resolver is pure; callers must explicitly invoke prepare before acquire.
 */
export function resolveRelayRuntimePaths(input: RelayRuntimeResolveInput): RelayRuntimePaths {
  const env = input.env ?? process.env
  const homeCandidate = env.DSH_HOME?.trim()
  const homeRoot = input.homeDirectory ?? homedir()
  if (homeRoot.trim().length === 0) {
    throw new RelayRuntimePathError(
      'RELAY_HOME_INVALID',
      'homeDirectory must not be blank',
      'homeDirectory',
      'Provide a non-empty home directory or let Relay use the operating-system home directory.',
    )
  }
  const dshHome = homeCandidate === undefined || homeCandidate.length === 0
    ? resolve(homeRoot, '.dsh')
    : resolve(homeCandidate)
  const dshHomeSource = homeCandidate === undefined || homeCandidate.length === 0 ? 'default' : 'environment'
  const profileCandidate = env.DSH_PROFILE?.trim()
  const profile = profileCandidate === undefined || profileCandidate.length === 0 ? 'web' : profileCandidate
  const profileSource = profileCandidate === undefined || profileCandidate.length === 0 ? 'default' : 'environment'
  if (!/^[A-Za-z0-9._-]+$/u.test(profile)) {
    throw new RelayRuntimePathError(
      'RELAY_PROFILE_INVALID',
      `invalid DSH_PROFILE: ${profile}`,
      'DSH_PROFILE',
      'Set DSH_PROFILE to a Harness profile name containing only letters, numbers, dot, underscore, or hyphen.',
    )
  }

  const profileRoot = join(dshHome, 'plugins', 'dsh-relay', profile)
  let stateDirectory: string
  let stateFile: string
  let defaultEndpoint: string
  let defaultToken: string
  if (input.stateDirectory !== undefined) {
    const raw = input.stateDirectory.trim()
    if (raw.length === 0) {
      throw new RelayRuntimePathError(
        'RELAY_STATE_DIRECTORY_INVALID',
        'stateDirectory must not be blank',
        'stateDirectory',
        'Remove the blank override or provide an absolute writable state directory.',
      )
    }
    stateDirectory = resolve(raw)
    stateFile = join(stateDirectory, 'state.json')
    defaultEndpoint = join(stateDirectory, 'relay-endpoint.json')
    defaultToken = join(stateDirectory, 'relay-token')
  } else if (input.mode === 'embedded' && input.hostIdentity !== undefined) {
    try {
      const standard = resolveAuthorityStatePaths({
        mode: 'embedded',
        hostIdentity: input.hostIdentity,
        dshHome,
        profile,
      })
      stateDirectory = standard.stateDirectory
      stateFile = standard.stateFile
      defaultEndpoint = standard.endpointDescriptorFile
      defaultToken = standard.tokenFile
    } catch (error) {
      throw pathError(error, 'hostIdentity')
    }
  } else if (input.mode === 'standalone' && input.hostIdentity !== undefined) {
    try {
      const userDataHome = input.userDataHome ?? env.LOCALAPPDATA
      const standard = userDataHome === undefined
        ? resolveAuthorityStatePaths({ mode: 'standalone', hostIdentity: input.hostIdentity })
        : resolveAuthorityStatePaths({ mode: 'standalone', hostIdentity: input.hostIdentity, userDataHome })
      stateDirectory = standard.stateDirectory
      stateFile = standard.stateFile
      defaultEndpoint = standard.endpointDescriptorFile
      defaultToken = standard.tokenFile
    } catch (error) {
      throw pathError(error, 'hostIdentity')
    }
  } else {
    stateDirectory = resolve(profileRoot)
    stateFile = join(stateDirectory, 'state.json')
    defaultEndpoint = join(profileRoot, 'relay-endpoint.json')
    defaultToken = join(stateDirectory, 'relay-token')
  }

  const explicitEndpoint = input.endpointDescriptorFile?.trim()
  if (input.endpointDescriptorFile !== undefined && (explicitEndpoint === undefined || explicitEndpoint.length === 0)) {
    throw new RelayRuntimePathError(
      'RELAY_PATH_INVALID',
      'endpointDescriptorFile must not be blank',
      'endpointDescriptorFile',
      'Remove the blank override or provide an absolute endpoint descriptor path.',
    )
  }
  const environmentEndpoint = input.stateDirectory === undefined && explicitEndpoint === undefined
    ? env.DSH_RELAY_ENDPOINT_DESCRIPTOR?.trim()
    : undefined
  const endpointOverride = explicitEndpoint ?? environmentEndpoint
  const endpointDescriptorFile = endpointOverride === undefined || endpointOverride.length === 0
    ? resolve(defaultEndpoint)
    : resolve(endpointOverride)
  const endpointDescriptorSource = explicitEndpoint !== undefined
    ? 'explicit'
    : environmentEndpoint !== undefined && environmentEndpoint.length > 0
      ? 'environment'
      : 'default'
  const statusFile = join(dirname(endpointDescriptorFile), 'relay-status.json')
  const tokenOverride = input.tokenFile?.trim()
  if (input.tokenFile !== undefined && (tokenOverride === undefined || tokenOverride.length === 0)) {
    throw new RelayRuntimePathError(
      'RELAY_PATH_INVALID',
      'tokenFile must not be blank',
      'tokenFile',
      'Remove the blank override or provide an absolute token file path.',
    )
  }
  const tokenFile = tokenOverride === undefined ? defaultToken : resolve(tokenOverride)
  return {
    mode: input.mode,
    dshHome,
    dshHomeSource,
    profile,
    profileSource,
    profileRoot: resolve(profileRoot),
    stateDirectory,
    stateFile,
    endpointDescriptorFile,
    endpointDescriptorSource,
    statusFile,
    tokenFile,
  }
}

/** Prepare parents before authority acquisition without creating credentials or descriptors. */
export async function prepareRelayRuntimePaths(paths: RelayRuntimePaths): Promise<void> {
  const directories = new Set([
    paths.stateDirectory,
    dirname(paths.endpointDescriptorFile),
    dirname(paths.statusFile),
    dirname(paths.tokenFile),
  ])
  try {
    for (const directory of directories) {
      await mkdir(directory, { recursive: true })
      await access(directory, constants.W_OK)
    }
  } catch (error) {
    throw new RelayRuntimePathError(
      'RELAY_PATH_INVALID',
      `Relay runtime directory is unavailable: ${error instanceof Error ? error.message : String(error)}`,
      'runtime paths',
      'Make the resolved Relay directories writable and retry the Harness Web profile.',
      { cause: error },
    )
  }
}

function pathError(error: unknown, source: string): RelayRuntimePathError {
  if (error instanceof RelayRuntimePathError) return error
  return new RelayRuntimePathError(
    'RELAY_PATH_INVALID',
    error instanceof Error ? error.message : String(error),
    source,
    'Check the resolved Relay home, profile, and host identity paths, then retry.',
    { cause: error },
  )
}
