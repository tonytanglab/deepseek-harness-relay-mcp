import type { IncomingMessage, ServerResponse } from 'node:http'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

export interface McpHttpConfig {
  token: string
  allowedHosts: string[]
  allowedOrigins: string[]
  maxBodyBytes: number
  maxConcurrent: number
  requestsPerMinute: number
  drainTimeoutMs: number
}

export type McpServerFactory = (clientPrincipalId: string) => McpServer

export interface McpHttpRoute {
  handle(req: IncomingMessage, res: ServerResponse): Promise<void>
  drain(): Promise<void>
}

export interface TokenSource {
  tokenFile: string
  environmentVariable?: string
}

export interface LoadedToken {
  token: string
  tokenFile: string
  source: 'file' | 'environment'
}

export interface HttpFailure {
  status: number
  code: string
  message: string
}
