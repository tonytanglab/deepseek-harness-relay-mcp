import { writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readJsonFileStrict } from './strict-utf8.mjs'

export async function syncVersions(root = process.env.DSH_RELAY_SYNC_VERSION_ROOT ?? fileURLToPath(new URL('../', import.meta.url)), options = {}) {
  const checkOnly = options.checkOnly ?? process.argv.includes('--check')
  const adoptPluginVersion = options.adoptPluginVersion ?? process.argv.includes('--from-plugin')
  const versionFile = resolve(root, 'version.json')
  const packageFile = resolve(root, 'package.json')
  const pluginFile = resolve(root, '.codex-plugin', 'plugin.json')
  const marketplaceFile = resolve(root, '.agents', 'plugins', 'marketplace.json')

  if (checkOnly && adoptPluginVersion) throw new Error('--check and --from-plugin cannot be combined')

  const sourceFile = adoptPluginVersion ? pluginFile : versionFile
  const { version } = await readJsonFileStrict(sourceFile)
  if (typeof version !== 'string' || version.length === 0) throw new Error(`${sourceFile} must contain a non-empty version`)

  const targetFiles = adoptPluginVersion ? [versionFile, packageFile] : [packageFile, pluginFile]
  const changed = []
  for (const file of targetFiles) {
    const value = await readJsonFileStrict(file)
    if (checkOnly) {
      if (value.version !== version) throw new Error(`${file} has ${String(value.version)}, expected ${version}`)
      continue
    }
    if (value.version === version) continue
    value.version = version
    await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
    changed.push(file)
  }

  const marketplace = await readJsonFileStrict(marketplaceFile)
  const marketplacePlugin = marketplace.plugins?.find(entry => entry?.name === 'deepseek-harness-relay')
  if (marketplacePlugin?.source?.source !== 'npm' || marketplacePlugin.source.package !== 'harness-relay-mcp') {
    throw new Error(`${marketplaceFile} must expose deepseek-harness-relay from the harness-relay-mcp npm package`)
  }
  if (checkOnly) {
    if (marketplacePlugin.source.version !== version) {
      throw new Error(`${marketplaceFile} has ${String(marketplacePlugin.source.version)}, expected ${version}`)
    }
  } else if (marketplacePlugin.source.version !== version) {
    marketplacePlugin.source.version = version
    await writeFile(marketplaceFile, `${JSON.stringify(marketplace, null, 2)}\n`, 'utf8')
    changed.push(marketplaceFile)
  }
  return { changed }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await syncVersions()
}
