import { timingSafeEqual } from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import type { HttpFailure, McpHttpConfig } from './types.js'

const supportedProtocolVersions = new Set(['2024-11-05', '2025-03-26', '2025-06-18', '2025-11-25'])
const principalPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/u

export class RequestPolicy {
  private readonly hosts: Set<string>
  private readonly origins: Set<string>

  constructor(private readonly config: McpHttpConfig) {
    this.hosts = new Set(config.allowedHosts.map(value => value.toLowerCase()))
    this.origins = new Set(config.allowedOrigins.map(value => value.toLowerCase()))
  }

  authorize(req: IncomingMessage): { principal: string } | HttpFailure {
    if (req.method !== 'POST') return failure(405, 'METHOD_NOT_ALLOWED', 'Only POST is supported by the stateless MCP endpoint')
    if (!isLoopback(req.socket.remoteAddress)) return failure(403, 'LOOPBACK_REQUIRED', 'DSH Relay HTTP MCP accepts loopback clients only')
    const host = singleHeader(req.headers.host)
    if (host === null || !this.hosts.has(host.toLowerCase())) return failure(403, 'HOST_REJECTED', 'Host header is not allowed')
    const origin = singleHeader(req.headers.origin)
    if (origin !== null && !this.origins.has(origin.toLowerCase())) return failure(403, 'ORIGIN_REJECTED', 'Origin header is not allowed')
    const contentType = singleHeader(req.headers['content-type'])
    if (contentType === null || contentType.split(';', 1)[0]?.trim().toLowerCase() !== 'application/json') {
      return failure(415, 'CONTENT_TYPE_REQUIRED', 'Content-Type must be application/json')
    }
    const version = singleHeader(req.headers['mcp-protocol-version'])
    if (version !== null && !supportedProtocolVersions.has(version)) {
      return failure(400, 'PROTOCOL_VERSION_REJECTED', 'MCP protocol version is not supported')
    }
    const authorization = singleHeader(req.headers.authorization)
    if (authorization === null || !secureEqual(authorization, `Bearer ${this.config.token}`)) {
      return failure(401, 'AUTHENTICATION_REQUIRED', 'Bearer authentication failed')
    }
    const rawPrincipal = singleHeader(req.headers['x-dsh-relay-principal']) ?? 'direct-http'
    if (!principalPattern.test(rawPrincipal)) return failure(400, 'PRINCIPAL_REJECTED', 'Client principal format is invalid')
    return { principal: rawPrincipal }
  }
}

function singleHeader(value: string | string[] | undefined): string | null {
  return typeof value === 'string' ? value : null
}

function isLoopback(address: string | undefined): boolean {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

function secureEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, 'utf8')
  const rightBytes = Buffer.from(right, 'utf8')
  return leftBytes.byteLength === rightBytes.byteLength && timingSafeEqual(leftBytes, rightBytes)
}

function failure(status: number, code: string, message: string): HttpFailure {
  return { status, code, message }
}
