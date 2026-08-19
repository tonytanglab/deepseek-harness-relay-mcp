import { createHash } from 'node:crypto'

const loopbackHosts = new Set(['127.0.0.1', 'localhost', '[::1]', '::1'])

/** Returns a stable identity for one local Harness HTTP authority. */
export function normalizeHostIdentity(input: string): string {
  const url = new URL(input)
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`unsupported Harness Host protocol: ${url.protocol}`)
  }
  const host = loopbackHosts.has(url.hostname.toLowerCase()) ? 'loopback' : url.hostname.toLowerCase()
  const defaultPort = url.protocol === 'http:' ? '80' : '443'
  const port = url.port === '' ? defaultPort : url.port
  return `${url.protocol.toLowerCase()}//${host}:${port}`
}

/** Builds a stable identifier for a mode-specific Relay authority. */
export function deriveAuthorityId(mode: 'embedded' | 'standalone', hostIdentity: string): string {
  const digest = createHash('sha256').update(`${mode}\0${normalizeHostIdentity(hostIdentity)}`, 'utf8').digest('hex')
  return `${mode}-${digest.slice(0, 24)}`
}

export function hostIdentityKey(hostIdentity: string): string {
  return createHash('sha256').update(normalizeHostIdentity(hostIdentity), 'utf8').digest('hex')
}
