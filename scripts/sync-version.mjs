import { readFile, writeFile } from 'node:fs/promises'

const checkOnly = process.argv.includes('--check')
const adoptPluginVersion = process.argv.includes('--from-plugin')
const versionFile = new URL('../version.json', import.meta.url)
const packageFile = new URL('../package.json', import.meta.url)
const pluginFile = new URL('../.codex-plugin/plugin.json', import.meta.url)
const marketplaceFile = new URL('../.agents/plugins/marketplace.json', import.meta.url)

if (checkOnly && adoptPluginVersion) throw new Error('--check and --from-plugin cannot be combined')

const sourceFile = adoptPluginVersion ? pluginFile : versionFile
const { version } = JSON.parse(await readFile(sourceFile, 'utf8'))
if (typeof version !== 'string' || version.length === 0) throw new Error(`${sourceFile.pathname} must contain a non-empty version`)

const targetFiles = adoptPluginVersion ? [versionFile, packageFile] : [packageFile, pluginFile]
for (const file of targetFiles) {
  const value = JSON.parse(await readFile(file, 'utf8'))
  if (checkOnly) {
    if (value.version !== version) throw new Error(`${file.pathname} has ${String(value.version)}, expected ${version}`)
    continue
  }
  value.version = version
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

const marketplace = JSON.parse(await readFile(marketplaceFile, 'utf8'))
const marketplacePlugin = marketplace.plugins?.find(entry => entry?.name === 'deepseek-harness-relay')
if (marketplacePlugin?.source?.source !== 'npm' || marketplacePlugin.source.package !== 'harness-relay-mcp') {
  throw new Error(`${marketplaceFile.pathname} must expose deepseek-harness-relay from the harness-relay-mcp npm package`)
}
if (checkOnly) {
  if (marketplacePlugin.source.version !== version) {
    throw new Error(`${marketplaceFile.pathname} has ${String(marketplacePlugin.source.version)}, expected ${version}`)
  }
} else if (marketplacePlugin.source.version !== version) {
  marketplacePlugin.source.version = version
  await writeFile(marketplaceFile, `${JSON.stringify(marketplace, null, 2)}\n`, 'utf8')
}
