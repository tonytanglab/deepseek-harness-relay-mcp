export const DEFAULT_MAX_PACKAGE_BYTES = 8 * 1024 * 1024

const forbiddenSegments = new Set([
  '.git',
  '.runtime',
  'artifacts',
  'coverage',
  'node_modules',
  'state',
  'temp',
  'tmp',
])

const sensitiveNames = [
  /^\.env(?:\.|$)/i,
  /^(?:credentials?|secrets?|tokens?)\.(?:json|ya?ml|toml|txt)$/i,
  /^state\.json$/i,
  /\.(?:db|sqlite|sqlite3|log)$/i,
]

export function validateManifestWhitelist(files) {
  const errors = []
  if (!Array.isArray(files) || files.length === 0) {
    return { valid: false, errors: ['package.json files must be a non-empty explicit whitelist'] }
  }
  for (const entry of files) {
    if (typeof entry !== 'string' || entry.trim().length === 0) {
      errors.push('package.json files contains a non-string or empty entry')
      continue
    }
    const normalized = normalize(entry)
    if (normalized === '.' || normalized === './' || normalized === '*' || normalized === '**/*') {
      errors.push(`package.json files contains an over-broad entry: ${entry}`)
    }
    const violation = forbiddenPath(normalized)
    if (violation) errors.push(`${entry}: ${violation}`)
  }
  return { valid: errors.length === 0, errors }
}

export function validatePackageFiles(records, maxBytes = DEFAULT_MAX_PACKAGE_BYTES) {
  const errors = []
  let totalBytes = 0
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    errors.push('package byte limit must be a positive safe integer')
  }
  for (const record of records) {
    const normalized = normalize(record.path)
    const violation = forbiddenPath(normalized)
    if (violation) errors.push(`${record.path}: ${violation}`)
    if (!Number.isSafeInteger(record.bytes) || record.bytes < 0) {
      errors.push(`${record.path}: invalid byte size ${String(record.bytes)}`)
      continue
    }
    totalBytes += record.bytes
  }
  if (Number.isSafeInteger(maxBytes) && totalBytes > maxBytes) {
    errors.push(`package files require ${totalBytes} bytes, exceeding the ${maxBytes} byte limit`)
  }
  return { valid: errors.length === 0, totalBytes, maxBytes, errors }
}

function forbiddenPath(input) {
  if (input.startsWith('/') || /^[A-Za-z]:\//.test(input)) return 'absolute paths are forbidden'
  const segments = input.split('/').filter(Boolean)
  if (segments.includes('..')) return 'parent traversal is forbidden'
  const forbidden = segments.find(segment => forbiddenSegments.has(segment.toLowerCase()))
  if (forbidden) return `forbidden directory segment: ${forbidden}`
  const basename = segments.at(-1) ?? ''
  if (sensitiveNames.some(pattern => pattern.test(basename))) return `sensitive or runtime-generated file is forbidden: ${basename}`
  return undefined
}

function normalize(input) {
  return String(input).replaceAll('\\', '/').replace(/^\.\//, '')
}
