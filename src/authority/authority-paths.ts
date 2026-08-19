import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { hostIdentityKey, normalizeHostIdentity } from './host-identity.js'
import type { AuthorityStatePaths, ResolveAuthorityPathsInput } from './types.js'

/** Resolves physically isolated state roots for embedded and standalone authorities. */
export function resolveAuthorityStatePaths(input: ResolveAuthorityPathsInput): AuthorityStatePaths {
  const digest = hostIdentityKey(normalizeHostIdentity(input.hostIdentity)).slice(0, 24)
  const embeddedRoot = input.mode === 'embedded'
    ? join(requiredRoot(input.dshHome, 'dshHome'), 'plugins', 'dsh-relay', sanitizeProfile(input.profile))
    : null
  const directory = embeddedRoot === null
    ? join(resolve(input.userDataHome ?? process.env.LOCALAPPDATA ?? homedir()), 'dsh-relay', 'standalone', digest)
    : join(embeddedRoot, digest)
  const stateDirectory = resolve(directory)
  return {
    stateDirectory,
    stateFile: join(stateDirectory, 'state.json'),
    endpointDescriptorFile: join(embeddedRoot ?? stateDirectory, 'relay-endpoint.json'),
    tokenFile: join(stateDirectory, 'relay-token'),
  }
}

function requiredRoot(value: string | undefined, name: string): string {
  if (value === undefined || value.trim() === '') throw new Error(`${name} is required for embedded authority state`)
  return resolve(value)
}

function sanitizeProfile(profile: string | undefined): string {
  const value = (profile ?? 'web').trim()
  if (!/^[a-zA-Z0-9._-]+$/u.test(value)) throw new Error(`invalid Harness profile: ${value}`)
  return value
}
