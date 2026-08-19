import { readFile } from 'node:fs/promises'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { readEndpointDescriptor } from './descriptor-reader.js'
import type { StdioProxyConfig } from './types.js'

const principalPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/u
const relayVersion = typeof __DSH_RELAY_VERSION__ === 'string' ? __DSH_RELAY_VERSION__ : 'development'

export class StdioProxyFacade {
  private readonly remote = new Client({ name: 'dsh-relay-proxy', version: relayVersion })
  private readonly local = new Server(
    { name: 'dsh-relay-proxy', version: relayVersion },
    { capabilities: { tools: {} }, instructions: 'Transparent stdio proxy to the embedded DSH Relay authority.' },
  )
  private connected = false

  constructor(private readonly config: StdioProxyConfig) {
    if (!principalPattern.test(config.clientPrincipalId)) throw new Error('invalid DSH Relay client principal')
    this.local.setRequestHandler(ListToolsRequestSchema, request => this.remote.listTools(request.params, { timeout: config.requestTimeoutMs }))
    this.local.setRequestHandler(CallToolRequestSchema, request => this.remote.callTool(request.params, undefined, { timeout: config.requestTimeoutMs }))
  }

  async connect(localTransport: Transport): Promise<void> {
    if (this.connected) throw new Error('DSH Relay stdio proxy is already connected')
    const descriptor = await readEndpointDescriptor(this.config.descriptorFile)
    const token = validateToken(await readFile(descriptor.tokenFilePath, { encoding: 'utf8' }))
    const remoteTransport = new StreamableHTTPClientTransport(new URL(descriptor.mcpUrl), {
      requestInit: {
        headers: {
          authorization: `Bearer ${token}`,
          'x-dsh-relay-principal': this.config.clientPrincipalId,
        },
      },
    })
    await this.remote.connect(remoteTransport as unknown as Transport)
    await this.remote.listTools(undefined, { timeout: this.config.requestTimeoutMs })
    await this.local.connect(localTransport)
    this.connected = true
  }

  async close(): Promise<void> {
    await Promise.allSettled([this.local.close(), this.remote.close()])
    this.connected = false
  }
}

function validateToken(raw: string): string {
  const token = raw.trim()
  if (!/^[A-Za-z0-9_-]{43,256}$/u.test(token)) throw new Error('invalid DSH Relay token file')
  return token
}
