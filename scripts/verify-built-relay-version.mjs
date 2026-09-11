import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join, resolve } from 'node:path'

const ARTIFACTS = [
  'dist/dsh-relay.mjs',
  'dist/dsh-relay-proxy.mjs',
  'dist/dsh-relay-harness.mjs',
]

const REQUIRED_PROXY_TOOLS = ['list_capabilities', 'start_review', 'wait_run']

/**
 * Verify that ignored build artifacts match the checked-out source version.
 * Codex local-marketplace installs copy files without running package scripts,
 * so a fresh manifest beside a stale dist tree must fail before installation.
 */
export async function verifyBuiltRelayVersion(root) {
  const repositoryRoot = resolve(root)
  const versionRecord = await readJson(join(repositoryRoot, 'version.json'))
  const packageManifest = await readJson(join(repositoryRoot, 'package.json'))
  const pluginManifest = await readJson(join(repositoryRoot, '.codex-plugin', 'plugin.json'))
  const expected = requireVersion(versionRecord.version, 'version.json')

  assertBaseVersion(packageManifest.version, expected, 'package.json')
  assertBaseVersion(pluginManifest.version, expected, '.codex-plugin/plugin.json')

  const sources = new Map()
  for (const relativePath of ARTIFACTS) {
    let source
    try {
      source = await readFile(join(repositoryRoot, relativePath), 'utf8')
    } catch (error) {
      throw new Error(`Codex plugin build artifact is missing: ${relativePath}. Run pnpm run prepare:codex-local before reinstalling.`, { cause: error })
    }
    if (!source.includes(JSON.stringify(expected))) {
      throw new Error(`Codex plugin build artifact is stale: ${relativePath} does not embed ${expected}. Run pnpm run prepare:codex-local before reinstalling.`)
    }
    sources.set(relativePath, source)
  }

  const proxy = sources.get('dist/dsh-relay-proxy.mjs')
  if (proxy === undefined) throw new Error('Codex proxy artifact was not verified')
  for (const tool of REQUIRED_PROXY_TOOLS) {
    if (!proxy.includes(tool)) {
      throw new Error(`Codex proxy artifact does not contain the stable tool catalog entry ${tool}. Run pnpm run prepare:codex-local before reinstalling.`)
    }
  }

  return { version: expected, artifacts: ARTIFACTS.length, requiredProxyTools: REQUIRED_PROXY_TOOLS.length }
}

function assertBaseVersion(value, expected, source) {
  const actual = requireVersion(value, source).split('+', 1)[0]
  if (actual !== expected) throw new Error(`${source} base version ${actual} does not match version.json ${expected}`)
}

function requireVersion(value, source) {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${source} must contain a non-empty version`)
  return value
}

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'))
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = fileURLToPath(new URL('../', import.meta.url))
  const report = await verifyBuiltRelayVersion(root)
  process.stdout.write(`${JSON.stringify({ valid: true, ...report })}\n`)
}
