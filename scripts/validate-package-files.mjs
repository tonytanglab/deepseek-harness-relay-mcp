import { lstat, readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  DEFAULT_MAX_PACKAGE_BYTES,
  validateManifestWhitelist,
  validatePackageFiles,
} from './package-manifest-policy.mjs'

const pluginRoot = fileURLToPath(new URL('../', import.meta.url))
const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
const whitelist = validateManifestWhitelist(manifest.files)
const maxBytes = parseMaxBytes(process.env.DSH_RELAY_PACKAGE_MAX_BYTES)
const records = [{ path: 'package.json', bytes: (await lstat(path.join(pluginRoot, 'package.json'))).size }]
const visited = new Set(['package.json'])
const collectionErrors = []

if (Array.isArray(manifest.files)) {
  for (const entry of manifest.files) {
    if (typeof entry !== 'string' || entry.trim().length === 0) continue
    const absolute = path.resolve(pluginRoot, entry)
    if (!isWithin(pluginRoot, absolute)) {
      collectionErrors.push(`${entry}: resolves outside the package root`)
      continue
    }
    try {
      await collect(absolute)
    } catch (error) {
      collectionErrors.push(`${entry}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
}

const contents = validatePackageFiles(records, maxBytes)
const errors = [...whitelist.errors, ...collectionErrors, ...contents.errors]
const report = {
  valid: errors.length === 0,
  fileCount: records.length,
  totalBytes: contents.totalBytes,
  maxBytes,
  errors,
}
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
if (!report.valid) process.exitCode = 1

async function collect(absolute) {
  const stats = await lstat(absolute)
  if (stats.isSymbolicLink()) throw new Error('symbolic links are forbidden in the publication whitelist')
  if (stats.isDirectory()) {
    const entries = await readdir(absolute, { withFileTypes: true })
    for (const entry of entries) await collect(path.join(absolute, entry.name))
    return
  }
  if (!stats.isFile()) return
  const relative = path.relative(pluginRoot, absolute).replaceAll('\\', '/')
  if (visited.has(relative)) return
  visited.add(relative)
  records.push({ path: relative, bytes: stats.size })
}

function isWithin(root, candidate) {
  const relative = path.relative(root, candidate)
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}

function parseMaxBytes(raw) {
  if (raw === undefined) return DEFAULT_MAX_PACKAGE_BYTES
  const parsed = Number(raw)
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error('DSH_RELAY_PACKAGE_MAX_BYTES must be a positive safe integer')
  return parsed
}
