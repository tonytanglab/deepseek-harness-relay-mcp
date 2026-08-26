import { randomBytes } from 'node:crypto'
import { link, mkdir, open, unlink } from 'node:fs/promises'
import { dirname } from 'node:path'
import { NodeFilePermissionBackend, type FilePermissionBackend } from '../state-repository/index.js'
import { readTextFileStrict } from '../strict-utf8.js'
import type { LoadedToken, TokenSource } from './types.js'

const TOKEN_BYTES = 32

export class TokenStoreFacade {
  constructor(private readonly permissions: FilePermissionBackend = new NodeFilePermissionBackend()) {}

  async loadOrCreate(source: TokenSource, env: NodeJS.ProcessEnv = process.env): Promise<LoadedToken> {
    if (source.environmentVariable !== undefined) {
      const value = env[source.environmentVariable]
      if (value !== undefined) return { token: validateToken(value), tokenFile: source.tokenFile, source: 'environment' }
    }
    await mkdir(dirname(source.tokenFile), { recursive: true })
    let created = false
    const temporary = `${source.tokenFile}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`
    try {
      const handle = await open(temporary, 'wx', 0o600)
      created = true
      let token: string
      try {
        token = randomBytes(TOKEN_BYTES).toString('base64url')
        await handle.writeFile(`${token}\n`, { encoding: 'utf8' })
        await handle.sync()
      } finally {
        await handle.close()
      }
      await this.permissions.restrict(temporary)
      await link(temporary, source.tokenFile)
      await unlink(temporary)
      return { token, tokenFile: source.tokenFile, source: 'file' }
    } catch (error) {
      if (created) {
        try { await unlink(temporary) } catch (cleanupError) {
          if (!isMissing(cleanupError)) throw cleanupError
        }
      }
      if (!isAlreadyExists(error)) throw error
    }
    // Existing token: strict UTF-8 (never U+FFFD-repaired) and restricted to
    // the current user, re-applying the ACL for files created by older builds.
    const raw = await readTextFileStrict(source.tokenFile)
    if (raw === null) throw new Error(`DSH Relay token file was removed concurrently: ${source.tokenFile}`)
    await this.permissions.restrict(source.tokenFile, { existing: true })
    return {
      token: validateToken(raw),
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

function isMissing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}
