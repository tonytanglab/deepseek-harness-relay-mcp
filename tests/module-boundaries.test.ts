import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import { relative } from 'node:path'
import test from 'node:test'

const sourceRoot = new URL('../src/', import.meta.url)

test('new gateway modules are consumed only through their root index', async () => {
  const violations: string[] = []
  for (const file of await sourceFiles(sourceRoot)) {
    const relativePath = relative(sourceRoot.pathname, file.pathname).replaceAll('\\', '/')
    const source = await readFile(file, 'utf8')
    for (const moduleName of ['harness-gateway', 'permission-gateway']) {
      if (relativePath.startsWith(`${moduleName}/`)) continue
      const internalImport = new RegExp(`from ['\"](?:\\.\\./)+${moduleName}/(?!index\\.js)[^'\"]+['\"]`, 'gu')
      if (internalImport.test(source)) violations.push(`${relativePath} imports ${moduleName} internals`)
    }
  }
  assert.deepEqual(violations, [])
})

async function sourceFiles(directory: URL): Promise<URL[]> {
  const files: URL[] = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const child = new URL(`${entry.name}${entry.isDirectory() ? '/' : ''}`, directory)
    if (entry.isDirectory()) files.push(...await sourceFiles(child))
    else if (entry.name.endsWith('.ts')) files.push(child)
  }
  return files
}
