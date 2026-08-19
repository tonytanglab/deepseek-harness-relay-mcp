import { randomBytes } from 'node:crypto'
import { mkdir, open, readFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { LoadedToken, TokenSource } from './types.js'

const TOKEN_BYTES = 32

export class TokenStoreFacade {
  async loadOrCreate(source: TokenSource, env: NodeJS.ProcessEnv = process.env): Promise<LoadedToken> {
    if (source.environmentVariable !== undefined) {
      const value = env[source.environmentVariable]
      if (value !== undefined) return { token: validateToken(value), tokenFile: source.tokenFile, source: 'environment' }
    }
    await mkdir(dirname(source.tokenFile), { recursive: true })
    try {
      const handle = await open(source.tokenFile, 'wx', 0o600)
      try {
        const token = randomBytes(TOKEN_BYTES).toString('base64url')
        await handle.writeFile(`${token}\n`, { encoding: 'utf8' })
        await handle.sync()
        return { token, tokenFile: source.tokenFile, source: 'file' }
      } finally {
        await handle.close()
      }
    } catch (error) {
      if (!isAlreadyExists(error)) throw error
    }
    return {
      token: validateToken(await readFile(source.tokenFile, { encoding: 'utf8' })),
      tokenFile: source.tokenFile,
      source: 'file',
    }
  }
}

function validateToken(raw: string): string {
  const token = raw.trim()
  if (!/^[A-Za-z0-9_-]{43,256}$/u.test(token)) throw new Error('DSH Relay token must be an unpadded base64url secret of at least 256 bits')
  return token
}

function isAlreadyExists(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'EEXIST'
}
