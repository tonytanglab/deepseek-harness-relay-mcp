import { readFile } from 'node:fs/promises'

const BOM = [0xef, 0xbb, 0xbf]
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })

export function decodeUtf8Strict(bytes, source = 'input') {
  if (bytes.byteLength >= BOM.length && bytes[0] === BOM[0] && bytes[1] === BOM[1] && bytes[2] === BOM[2]) {
    throw new Error(`${source} starts with a UTF-8 BOM; UTF-8 without BOM is required`)
  }
  try {
    return decoder.decode(bytes)
  } catch (error) {
    throw new Error(`${source} is not valid UTF-8`, { cause: error })
  }
}

export async function readTextFileStrict(path) {
  return decodeUtf8Strict(await readFile(path), String(path))
}

export async function readJsonFileStrict(path) {
  return JSON.parse(await readTextFileStrict(path))
}
