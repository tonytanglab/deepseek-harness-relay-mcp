import { readFile } from 'node:fs/promises'

export const UTF8_BOM_BYTES = [0xef, 0xbb, 0xbf] as const

export class StrictUtf8Error extends Error {
  readonly code: 'UTF8_INVALID' | 'UTF8_BOM'

  constructor(message: string, code: StrictUtf8Error['code']) {
    super(message)
    this.name = 'StrictUtf8Error'
    this.code = code
  }
}

/** Fatal UTF-8 decoder: invalid sequences throw instead of being replaced with U+FFFD. */
const fatalDecoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })

/**
 * Strictly decodes untrusted bytes as UTF-8 without BOM.
 * Throws StrictUtf8Error('UTF8_BOM') when the input starts with a BOM marker
 * and StrictUtf8Error('UTF8_INVALID') on malformed sequences; malformed text
 * is never silently repaired with the replacement character.
 */
export function decodeUtf8Strict(input: Uint8Array, source = 'input'): string {
  if (input.byteLength >= UTF8_BOM_BYTES.length
    && input[0] === UTF8_BOM_BYTES[0] && input[1] === UTF8_BOM_BYTES[1] && input[2] === UTF8_BOM_BYTES[2]) {
    throw new StrictUtf8Error(`${source} starts with a UTF-8 BOM; UTF-8 without BOM is required`, 'UTF8_BOM')
  }
  try {
    return fatalDecoder.decode(input)
  } catch {
    throw new StrictUtf8Error(`${source} is not valid UTF-8`, 'UTF8_INVALID')
  }
}

/** Reads a text file strictly as UTF-8 without BOM; null when the file is missing. */
export async function readTextFileStrict(path: string): Promise<string | null> {
  let bytes: Buffer
  try {
    bytes = await readFile(path)
  } catch (error) {
    if (isCode(error, 'ENOENT')) return null
    throw error
  }
  return decodeUtf8Strict(bytes, path)
}

export function isCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code
}

/** Error with a synthetic filesystem code, used where callers branch on ENOENT. */
export function withFsCode(message: string, code: string): Error {
  const error = new Error(message)
  ;(error as Error & { code: string }).code = code
  return error
}
