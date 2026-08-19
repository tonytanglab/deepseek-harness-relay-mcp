import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { resolveConfig } from './config.js'
import { MonitoringFacade } from './monitoring/index.js'
import { RelayFacade } from './relay-broker/index.js'
import { createServer } from './server.js'

const config = resolveConfig()
const relay = new RelayFacade(config)
const monitoring = new MonitoringFacade()
const server = createServer(relay, config, monitoring)
await server.connect(new StdioServerTransport())
