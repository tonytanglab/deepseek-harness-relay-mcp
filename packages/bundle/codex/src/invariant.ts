/** Package-owned invariant companion for `@deepseek-ai/dsh-codex`. */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-codex'

/** Cordis companion plugin name. */
export const name = 'codex-bundle-invariant'
/** Service required before the companion can register. */
export const inject = ['invariants']

// No runtime invariant: this package only supplies a static loader patch. The
// inserted MCP package owns the live server and process-tree relationships.
const install: InvariantInstaller = () => {}

/** Register this static bundle's explained-empty invariant companion. */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
