import { randomUUID } from 'node:crypto'
import { mkdir, open, rename, unlink } from 'node:fs/promises'
import { dirname } from 'node:path'
import { isCode, readTextFileStrict } from '../strict-utf8.js'
import { NodeFilePermissionBackend, type FilePermissionBackend } from './file-permissions.js'

const defaultPermissionBackend = new NodeFilePermissionBackend()

export async function readUtf8File(path: string): Promise<string | null> {
  return readTextFileStrict(path)
}

export async function atomicWriteJson(path: string, value: unknown, permissions: FilePermissionBackend = defaultPermissionBackend): Promise<void> {
  const directory = dirname(path)
  await mkdir(directory, { recursive: true })
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`
  try {
    const handle = await open(temporary, 'wx', 0o600)
    try {
      await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8' })
      await handle.sync()
    } finally {
      await handle.close()
    }
    // Restrict before promotion so a failed ACL never swaps in an open file.
    await restrictPermissions(temporary, permissions)
    await rename(temporary, path)
    await syncDirectory(directory)
  } catch (error) {
    try {
      await unlink(temporary)
    } catch (cleanupError) {
      if (!isCode(cleanupError, 'ENOENT')) throw cleanupError
    }
    throw error
  }
}

export async function restrictPermissions(path: string, permissions: FilePermissionBackend = defaultPermissionBackend): Promise<void> {
  await permissions.restrict(path)
}

async function syncDirectory(directory: string): Promise<void> {
  let handle: Awaited<ReturnType<typeof open>> | undefined
  try {
    handle = await open(directory, 'r')
    await handle.sync()
  } catch (error) {
    if (process.platform !== 'win32') throw error
  } finally {
    await handle?.close()
  }
}
