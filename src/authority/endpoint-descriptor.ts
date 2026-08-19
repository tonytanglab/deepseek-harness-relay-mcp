import { z } from 'zod'
import { atomicWriteJson, readUtf8File } from '../state-repository/index.js'
import type { EndpointDescriptorInput, RelayEndpointDescriptor } from './types.js'

const descriptorSchema = z.object({
  schemaVersion: z.literal(1),
  authorityId: z.string().min(1),
  mode: z.enum(['embedded', 'standalone']),
  mcpUrl: z.string().url(),
  tokenFilePath: z.string().min(1),
  hostWebUrl: z.string().url(),
  ownerEpoch: z.number().int().positive(),
  updatedAt: z.string().datetime(),
}).strict()

export class RelayEndpointPublisher {
  constructor(private readonly path: string) {}

  async publish(input: EndpointDescriptorInput): Promise<RelayEndpointDescriptor> {
    const descriptor = descriptorSchema.parse({
      schemaVersion: 1,
      authorityId: input.authorityId,
      mode: input.mode,
      mcpUrl: normalizeUrl(input.mcpUrl),
      tokenFilePath: input.tokenFilePath,
      hostWebUrl: normalizeUrl(input.hostWebUrl),
      ownerEpoch: input.ownerEpoch,
      updatedAt: input.updatedAt ?? new Date().toISOString(),
    })
    await atomicWriteJson(this.path, descriptor)
    return descriptor
  }

  async read(): Promise<RelayEndpointDescriptor | null> {
    const text = await readUtf8File(this.path)
    if (text === null) return null
    return descriptorSchema.parse(JSON.parse(text))
  }
}

function normalizeUrl(input: string): string {
  const url = new URL(input)
  url.hash = ''
  return url.href
}
