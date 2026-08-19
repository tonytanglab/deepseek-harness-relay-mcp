import type { IncomingMessage, ServerResponse } from 'node:http'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import { PrincipalRateLimiter } from './rate-limiter.js'
import { RequestPolicy } from './request-policy.js'
import type { HttpFailure, McpHttpConfig, McpHttpRoute, McpServerFactory } from './types.js'

export class McpHttpFacade implements McpHttpRoute {
  private readonly policy: RequestPolicy
  private readonly limiter: PrincipalRateLimiter
  private readonly activeResponses = new Set<ServerResponse>()
  private draining = false

  constructor(private readonly config: McpHttpConfig, private readonly serverFactory: McpServerFactory) {
    this.policy = new RequestPolicy(config)
    this.limiter = new PrincipalRateLimiter(config.requestsPerMinute)
  }

  async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (this.draining) return writeFailure(res, { status: 503, code: 'DRAINING', message: 'DSH Relay is draining' })
    const authorized = this.policy.authorize(req)
    if ('status' in authorized) return writeFailure(res, authorized)
    if (this.activeResponses.size >= this.config.maxConcurrent) {
      return writeFailure(res, { status: 429, code: 'CONCURRENCY_LIMIT', message: 'Too many concurrent MCP requests' })
    }
    if (!this.limiter.take(authorized.principal)) {
      return writeFailure(res, { status: 429, code: 'RATE_LIMIT', message: 'MCP request rate exceeded' })
    }
    this.activeResponses.add(res)
    try {
      const body = await readJsonBody(req, this.config.maxBodyBytes)
      const transport = new StreamableHTTPServerTransport({ enableJsonResponse: true })
      const server = this.serverFactory(authorized.principal)
      try {
        await server.connect(transport as unknown as Transport)
        await transport.handleRequest(req, res, body)
      } finally {
        await server.close()
      }
    } catch (error) {
      if (!res.headersSent) {
        const failure = isHttpFailure(error)
          ? error
          : { status: 400, code: 'INVALID_REQUEST', message: error instanceof Error ? error.message : String(error) }
        writeFailure(res, failure)
      } else if (!res.writableEnded) {
        res.destroy()
      }
    } finally {
      this.activeResponses.delete(res)
    }
  }

  async drain(): Promise<void> {
    this.draining = true
    const deadline = Date.now() + this.config.drainTimeoutMs
    while (this.activeResponses.size > 0 && Date.now() < deadline) await delay(10)
    for (const response of this.activeResponses) response.destroy()
    this.activeResponses.clear()
  }
}

async function readJsonBody(req: IncomingMessage, maxBytes: number): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const raw of req) {
    const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw)
    size += chunk.byteLength
    if (size > maxBytes) throw { status: 413, code: 'BODY_TOO_LARGE', message: 'MCP request body exceeds the configured limit' } satisfies HttpFailure
    chunks.push(chunk)
  }
  if (chunks.length === 0) throw { status: 400, code: 'EMPTY_BODY', message: 'MCP request body is required' } satisfies HttpFailure
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
}

function writeFailure(res: ServerResponse, failure: HttpFailure): void {
  res.statusCode = failure.status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  if (failure.status === 401) res.setHeader('www-authenticate', 'Bearer')
  res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32_000, message: failure.message, data: { code: failure.code } } }))
}

function isHttpFailure(value: unknown): value is HttpFailure {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Partial<HttpFailure>
  return typeof candidate.status === 'number' && typeof candidate.code === 'string' && typeof candidate.message === 'string'
}

function delay(milliseconds: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, milliseconds))
}
