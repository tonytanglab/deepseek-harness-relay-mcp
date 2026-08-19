import { randomUUID } from 'node:crypto'
import { chmod, mkdir, open, readFile, rename, unlink } from 'node:fs/promises'
import { dirname } from 'node:path'

export async function readUtf8File(path: string): Promise<string | null> {
  try {
    return await readFile(path, { encoding: 'utf8' })
  } catch (error) {
    if (isCode(error, 'ENOENT')) return null
    throw error
  }
}

export async function atomicWriteJson(path: string, value: unknown): Promise<void> {
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
    await rename(temporary, path)
    await syncDirectory(directory)
    await restrictPermissions(path)
  } catch (error) {
    try {
      await unlink(temporary)
    } catch (cleanupError) {
      if (!isCode(cleanupError, 'ENOENT')) throw cleanupError
    }
    throw error
  }
}

export async function restrictPermissions(path: string): Promise<void> {
  try {
    await chmod(path, 0o600)
  } catch (error) {
    if (process.platform !== 'win32') throw error
  }
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

function isCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code
}
