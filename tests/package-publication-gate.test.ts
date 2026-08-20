import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
  name: string
  version: string
  main: string
  exports: Record<string, { default?: string } | string>
  bin: Record<string, string>
  files: string[]
  scripts: Record<string, string>
  peerDependencies: Record<string, string>
  peerDependenciesMeta: Record<string, { optional?: boolean }>
  dsh: { bundle: { patch: string } }
}

const marketplace = JSON.parse(readFileSync(new URL('../.agents/plugins/marketplace.json', import.meta.url), 'utf8')) as {
  name: string
  interface: { displayName: string }
  plugins: Array<{
    name: string
    source: { source: string; package: string; version: string; registry: string }
    policy: { installation: string; authentication: string }
    category: string
  }>
}

test('publishes the slash-free Harness Relay MCP identity at the package root', () => {
  assert.equal(manifest.name, 'harness-relay-mcp')
  assert.equal(manifest.main, './dist/dsh-relay-harness.mjs')
  assert.equal((manifest.exports['.'] as { default?: string }).default, './dist/dsh-relay-harness.mjs')
  assert.equal((manifest.exports['./standalone'] as { default?: string }).default, './dist/dsh-relay.mjs')
  assert.equal(manifest.bin['harness-relay-mcp'], './dist/dsh-relay.mjs')
  assert.equal(manifest.bin['harness-relay-mcp-proxy'], './dist/dsh-relay-proxy.mjs')
  assert.equal(manifest.dsh.bundle.patch, './cordis.patch.yml')
  assert.equal(manifest.files.includes('.agents/plugins/marketplace.json'), false)
  const patch = readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
  assert.match(patch, /id: harness-relay-mcp/u)
  assert.match(patch, /name: 'harness-relay-mcp'/u)
  assert.doesNotMatch(patch, /name: .*\//u)
})

test('publishes a repo marketplace that installs the Codex layer from npm', () => {
  assert.equal(marketplace.name, 'harness-relay')
  assert.equal(marketplace.interface.displayName, 'Harness Relay')
  const plugin = marketplace.plugins.find(entry => entry.name === 'deepseek-harness-relay')
  assert.ok(plugin)
  assert.deepEqual(plugin.source, {
    source: 'npm',
    package: 'harness-relay-mcp',
    version: manifest.version,
    registry: 'https://registry.npmjs.org',
  })
  assert.deepEqual(plugin.policy, {
    installation: 'AVAILABLE',
    authentication: 'ON_INSTALL',
  })
  assert.equal(plugin.category, 'Productivity')
})

test('uses an explicit publication whitelist and validates its byte budget', () => {
  assert.ok(Array.isArray(manifest.files) && manifest.files.length > 0)
  assert.equal(manifest.files.some(item => /(?:^|\/)(?:\.runtime|node_modules|coverage|artifacts|state)(?:\/|$)/i.test(item)), false)

  const execution = spawnSync(process.execPath, ['./scripts/validate-package-files.mjs'], {
    cwd: new URL('../', import.meta.url),
    encoding: 'utf8',
  })
  assert.equal(execution.status, 0, execution.stderr)
  const report = JSON.parse(execution.stdout) as { valid: boolean; fileCount: number; totalBytes: number; maxBytes: number }
  assert.equal(report.valid, true)
  assert.ok(report.fileCount > 1)
  assert.ok(report.totalBytes > 0 && report.totalBytes <= report.maxBytes)
})

test('fails closed when the configured package byte budget is exceeded', () => {
  const execution = spawnSync(process.execPath, ['./scripts/validate-package-files.mjs'], {
    cwd: new URL('../', import.meta.url),
    encoding: 'utf8',
    env: { ...process.env, DSH_RELAY_PACKAGE_MAX_BYTES: '1' },
  })
  assert.notEqual(execution.status, 0)
  assert.match(execution.stdout, /exceeding the 1 byte limit/)
})

test('prepack performs strict TypeScript checking and MCP smoke builds first', () => {
  assert.match(manifest.scripts.prepack ?? '', /tsc --noEmit/)
  assert.match(manifest.scripts.prepack ?? '', /validate-package-files\.mjs/)
  const smoke = manifest.scripts['test:mcp'] ?? ''
  assert.ok(smoke.indexOf('build.mjs') >= 0)
  assert.ok(smoke.indexOf('build.mjs') < smoke.indexOf('mcp-smoke.mjs'))
})

test('version sync can explicitly adopt the official plugin cachebuster', () => {
  const script = readFileSync(new URL('../scripts/sync-version.mjs', import.meta.url), 'utf8')
  assert.match(script, /--from-plugin/)
  assert.match(script, /adoptPluginVersion \? \[versionFile, packageFile\]/)
  assert.match(script, /marketplacePlugin\.source\.version = version/)
})

test('dual-mode Harness peers are versioned but optional for standalone installs', () => {
  const peers = Object.keys(manifest.peerDependencies)
  assert.ok(peers.length > 0)
  assert.deepEqual(Object.keys(manifest.peerDependenciesMeta).sort(), peers.sort())
  for (const peer of peers) assert.equal(manifest.peerDependenciesMeta[peer]?.optional, true)
})
