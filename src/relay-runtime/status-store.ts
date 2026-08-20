import { z } from 'zod'
import { atomicWriteJson, readUtf8File } from '../state-repository/index.js'
import type { RelayStatusDocument, RelayStatusWriteInput } from './types.js'

const statusSchema = z.object({
  schemaVersion: z.literal(1),
  state: z.enum(['starting', 'ready', 'failed', 'stopped']),
  authorityId: z.string().min(1),
  mode: z.enum(['embedded', 'standalone']),
  instanceId: z.string().min(1),
  ownerPid: z.number().int().positive().nullable(),
  processStartedAt: z.string().datetime().nullable(),
  ownerEpoch: z.number().int().positive().nullable(),
  hostIdentity: z.string().min(1),
  profile: z.string().min(1),
  dshHome: z.string().min(1),
  updatedAt: z.string().datetime(),
  lastError: z.object({
    code: z.string().min(1),
    message: z.string().min(1),
    remediation: z.string().min(1),
  }).strict().nullable(),
}).strict()

export class RelayStatusFacade {
  constructor(
    private readonly path: string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async write(input: RelayStatusWriteInput): Promise<RelayStatusDocument> {
    const safeInput = sanitizeStatusInput(input)
    const document = statusSchema.parse({
      schemaVersion: 1,
      ...safeInput,
      updatedAt: input.updatedAt ?? this.now().toISOString(),
    }) as RelayStatusDocument
    await atomicWriteJson(this.path, document)
    return document
  }

  async read(): Promise<RelayStatusDocument | null> {
    const text = await readUtf8File(this.path)
    if (text === null) return null
    return statusSchema.parse(JSON.parse(text)) as RelayStatusDocument
  }
}

function sanitizeStatusInput(input: RelayStatusWriteInput): RelayStatusWriteInput {
  if (input.lastError === null) return input
  return {
    ...input,
    lastError: {
      ...input.lastError,
      message: redactCredentialMaterial(input.lastError.message),
      remediation: redactCredentialMaterial(input.lastError.remediation),
    },
  }
}

/** Keep diagnostics useful while ensuring accidental credential values never enter the sidecar. */
function redactCredentialMaterial(value: string): string {
  return value
    .replace(/Bearer\s+[A-Za-z0-9._~-]+/giu, 'Bearer [redacted]')
    .replace(/((?:token|secret|password|authorization)[^:=]{0,32}[:=]\s*)[^\s,;]+/giu, '$1[redacted]')
}
