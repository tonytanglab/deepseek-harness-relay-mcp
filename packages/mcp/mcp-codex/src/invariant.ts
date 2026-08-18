/** Package-owned invariant companion for `@deepseek-ai/dsh-mcp-codex`. */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-mcp-codex'

/** Cordis companion plugin name. */
export const name = 'mcp-codex-invariant'
/** Service required before the companion can register. */
export const inject = ['invariants']

// No runtime invariant: the MCP supervisor's authoritative lifecycle evidence
// is asynchronous process, Host-event, and MCP output. Assembled process tests
// audit the relationships that cannot be sampled synchronously.
const install: InvariantInstaller = () => {}

/** Register this package's explained-empty invariant companion. */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
