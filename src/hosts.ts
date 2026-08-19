/** MCP hosts that launch the shared `lib/mcp.js` attach server over stdio. */

/** Closed set of MCP hosts this helper can write a launch block for. */
export const MCP_HOSTS = ['codex', 'cursor', 'claude-code'] as const

/** One supported MCP host product. */
export type McpHost = (typeof MCP_HOSTS)[number]

/**
 * Exhaust a closed host union.
 * @param value - a value TypeScript treated as remaining.
 * @returns never; always throws.
 */
export function assertNever(value: never): never {
  throw new Error(`dsh-relay: unsupported MCP host ${JSON.stringify(value)}`)
}

/**
 * Confirm a model-supplied host string is one of {@link MCP_HOSTS}.
 * @param value - raw host argument.
 * @returns the typed host.
 */
export function parseMcpHost(value: string): McpHost {
  for (const host of MCP_HOSTS) {
    if (host === value) return host
  }
  throw new Error(`dsh-relay: host must be one of ${MCP_HOSTS.join(', ')}`)
}
