import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

const python = process.platform === 'win32' ? 'python' : 'python3'
const script = new URL('../skills/delegate-to-deepseek-harness/scripts/build_task_manifest.py', import.meta.url)
const scriptPath = fileURLToPath(script)

test('task manifest exposes only authorized locations and scope without reading source contents', () => {
  const workspace = mkdtempSync(join(tmpdir(), 'dsh-relay-task-contract-'))
  try {
    mkdirSync(join(workspace, 'src'))
    writeFileSync(join(workspace, 'src', 'secret.ts'), 'const SOURCE_BODY_MUST_NOT_LEAVE_WORKSPACE = true\n', 'utf8')

    const execution = runManifest([
      workspace,
      '--path', 'src',
      '--exclude-path', 'dist',
      '--scope', '审查 src 中的任务契约并返回可复现发现',
    ])
    assert.equal(execution.status, 0, execution.stderr)
    const manifest = JSON.parse(execution.stdout) as Record<string, unknown>
    assert.deepEqual(Object.keys(manifest), [
      'schemaVersion',
      'sourceTransferPolicy',
      'workspaceRoot',
      'permissionMode',
      'scope',
      'locations',
    ])
    assert.equal(manifest.schemaVersion, 2)
    assert.equal(manifest.sourceTransferPolicy, 'path-reference-only')
    assert.equal(manifest.permissionMode, 'read-only')
    assert.deepEqual(manifest.locations, { include: ['src'], exclude: ['dist'], write: [] })
    assert.doesNotMatch(execution.stdout, /SOURCE_BODY_MUST_NOT_LEAVE_WORKSPACE|sha256|fileCount|bytes|lines/u)
  } finally {
    rmSync(workspace, { recursive: true, force: true })
  }
})

test('write authorization keeps the same path-reference-only contract and requires explicit write locations', () => {
  const workspace = mkdtempSync(join(tmpdir(), 'dsh-relay-write-contract-'))
  try {
    mkdirSync(join(workspace, 'src'))
    const valid = runManifest([
      workspace,
      '--path', 'src',
      '--write-path', 'src',
      '--scope', '在 src 内实施已请求的修改并运行相关测试',
      '--permission-mode', 'workspace-write',
    ])
    assert.equal(valid.status, 0, valid.stderr)
    const manifest = JSON.parse(valid.stdout) as { sourceTransferPolicy: string; locations: { write: string[] } }
    assert.equal(manifest.sourceTransferPolicy, 'path-reference-only')
    assert.deepEqual(manifest.locations.write, ['src'])

    const missingWriteLocation = runManifest([
      workspace,
      '--path', 'src',
      '--scope', '在 src 内实施已请求的修改',
      '--permission-mode', 'workspace-write',
    ])
    assert.notEqual(missingWriteLocation.status, 0)
    assert.match(missingWriteLocation.stderr, /require at least one --write-path/u)
  } finally {
    rmSync(workspace, { recursive: true, force: true })
  }
})

test('task manifest rejects multiline payloads and workspace escapes', () => {
  const workspace = mkdtempSync(join(tmpdir(), 'dsh-relay-scope-contract-'))
  try {
    const multiline = runManifest([
      workspace,
      '--path', '.',
      '--scope', 'review\nconst embedded = true',
    ])
    assert.notEqual(multiline.status, 0)
    assert.match(multiline.stderr, /single-line instructions/u)

    const escaped = runManifest([
      workspace,
      '--path', '..',
      '--scope', 'review parent',
    ])
    assert.notEqual(escaped.status, 0)
    assert.match(escaped.stderr, /path escapes workspace/u)
  } finally {
    rmSync(workspace, { recursive: true, force: true })
  }
})

function runManifest(args: string[]) {
  return spawnSync(python, ['-X', 'utf8', scriptPath, ...args], {
    encoding: 'utf8',
    windowsHide: true,
  })
}

// Ensure the packaged script itself remains strict UTF-8 without a BOM.
assert.equal(readFileSync(script).subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])), false)
