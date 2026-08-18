/**
 * Compile src/ for git installs. Skip when the Release tarball already
 * contains lib/index.js so consumers do not need the TypeScript toolchain.
 */
import { existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(fileURLToPath(import.meta.url))
if (existsSync(join(root, 'lib', 'index.js'))) process.exit(0)
const result = spawnSync('tsdown', { cwd: root, stdio: 'inherit', shell: true })
process.exit(result.status === null ? 1 : result.status)
