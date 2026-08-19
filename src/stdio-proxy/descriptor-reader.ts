import { readFile } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import type { RelayEndpointDescriptor } from './types.js'

export async function readEndpointDescriptor(path: string): Promise<RelayEndpointDescriptor> {
  const parsed = JSON.parse(await readFile(path, { encoding: 'utf8' })) as unknown
  if (!isRecord(parsed) || parsed.schemaVersion !== 1 || parsed.mode !== 'embedded') throw new Error('invalid DSH Relay endpoint descriptor')
  if ('token' in parsed || 'authorization' in parsed) throw new Error('endpoint descriptor must not contain credentials')
  const descriptor: RelayEndpointDescriptor = {
    schemaVersion: 1,
    authorityId: requiredString(parsed, 'authorityId'),
    mode: 'embedded',
    mcpUrl: loopbackUrl(requiredString(parsed, 'mcpUrl')),
    tokenFilePath: requiredString(parsed, 'tokenFilePath'),
    hostWebUrl: loopbackUrl(requiredString(parsed, 'hostWebUrl')),
    ownerEpoch: requiredNonNegativeInteger(parsed, 'ownerEpoch'),
    updatedAt: requiredString(parsed, 'updatedAt'),
  }
  if (!isAbsolute(descriptor.tokenFilePath)) throw new Error('endpoint descriptor tokenFilePath must be absolute')
  return descriptor
}

function requiredString(value: Record<string, unknown>, key: string): string {
  const candidate = value[key]
  if (typeof candidate !== 'string' || candidate.length === 0) throw new Error(`endpoint descriptor ${key} is invalid`)
  return candidate
}

function requiredNonNegativeInteger(value: Record<string, unknown>, key: string): number {
  const candidate = value[key]
  if (!Number.isInteger(candidate) || (candidate as number) < 0) throw new Error(`endpoint descriptor ${key} is invalid`)
  return candidate as number
}

function loopbackUrl(input: string): string {
  const url = new URL(input)
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '::1'].includes(url.hostname)) {
    throw new Error('endpoint descriptor URLs must use loopback HTTP')
  }
  return url.href
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
