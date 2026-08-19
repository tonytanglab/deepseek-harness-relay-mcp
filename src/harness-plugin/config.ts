/** User-owned configuration exposed by the Harness bundle. */
export interface HarnessPluginConfig {
  route: string
  stateDirectory?: string
  tokenFile?: string
  requestBodyLimitBytes: number
  maxConcurrency: number
  rateLimitPerMinute: number
  drainTimeoutMs: number
}

interface StringSchema {
  default(value: string): StringSchema
}

interface NumberSchema {
  min(value: number): NumberSchema
  max(value: number): NumberSchema
  default(value: number): NumberSchema
}

/** Minimal Schemastery-compatible builder used by the peer-backed thin entry. */
export interface HarnessSchemaFactory {
  string(): StringSchema
  natural(): NumberSchema
  object(shape: Record<string, unknown>): unknown
}

/**
 * Build the Cordis Config schema without accepting a plaintext bearer token.
 * @param schema - Harness's peer Schemastery export.
 * @returns Cordis-compatible configuration schema.
 */
export function createHarnessConfigSchema(schema: HarnessSchemaFactory): unknown {
  return schema.object({
    route: schema.string().default('/plugins/dsh-relay/mcp'),
    stateDirectory: schema.string(),
    tokenFile: schema.string(),
    requestBodyLimitBytes: schema.natural().min(1_024).max(16 * 1024 * 1024).default(1024 * 1024),
    maxConcurrency: schema.natural().min(1).max(256).default(16),
    rateLimitPerMinute: schema.natural().min(1).max(60_000).default(120),
    drainTimeoutMs: schema.natural().min(100).max(30_000).default(5_000),
  })
}

/**
 * Apply defaults and reject values that would overlap Harness's public API.
 * @param input - Parsed Cordis configuration.
 * @returns Fully resolved plugin configuration.
 */
export function resolveHarnessPluginConfig(input: Partial<HarnessPluginConfig>): HarnessPluginConfig {
  const route = input.route ?? '/plugins/dsh-relay/mcp'
  if (!route.startsWith('/') || route === '/' || route.startsWith('/api/')) {
    throw new Error('dsh-relay route must be an absolute non-/api path')
  }
  return {
    route,
    requestBodyLimitBytes: bounded(input.requestBodyLimitBytes, 1024 * 1024, 1_024, 16 * 1024 * 1024, 'requestBodyLimitBytes'),
    maxConcurrency: bounded(input.maxConcurrency, 16, 1, 256, 'maxConcurrency'),
    rateLimitPerMinute: bounded(input.rateLimitPerMinute, 120, 1, 60_000, 'rateLimitPerMinute'),
    drainTimeoutMs: bounded(input.drainTimeoutMs, 5_000, 100, 30_000, 'drainTimeoutMs'),
    ...(input.stateDirectory === undefined ? {} : { stateDirectory: input.stateDirectory }),
    ...(input.tokenFile === undefined ? {} : { tokenFile: input.tokenFile }),
  }
}

function bounded(value: number | undefined, fallback: number, min: number, max: number, name: string): number {
  const resolved = value ?? fallback
  if (!Number.isInteger(resolved) || resolved < min || resolved > max) {
    throw new Error(`dsh-relay ${name} must be an integer from ${min} to ${max}`)
  }
  return resolved
}
