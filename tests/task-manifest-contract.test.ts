import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
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
      '--context-path', '.',
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
      'reviewTargets',
      'contextReadScope',
      'excludedPaths',
      'writeScope',
      'scopeEnforcement',
    ])
    assert.equal(manifest.schemaVersion, 3)
    assert.equal(manifest.sourceTransferPolicy, 'path-reference-only')
    assert.equal(manifest.permissionMode, 'read-only')
    assert.deepEqual(manifest.reviewTargets, ['src'])
    assert.deepEqual(manifest.contextReadScope, ['.'])
    assert.deepEqual(manifest.excludedPaths, ['dist'])
    assert.deepEqual(manifest.writeScope, [])
    assert.equal(manifest.scopeEnforcement, 'instruction-only')
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
      '--context-path', 'src',
      '--write-path', 'src',
      '--scope', '在 src 内实施已请求的修改并运行相关测试',
      '--permission-mode', 'workspace-write',
    ])
    assert.equal(valid.status, 0, valid.stderr)
    const manifest = JSON.parse(valid.stdout) as { sourceTransferPolicy: string; writeScope: string[] }
    assert.equal(manifest.sourceTransferPolicy, 'path-reference-only')
    assert.deepEqual(manifest.writeScope, ['src'])

    const missingWriteLocation = runManifest([
      workspace,
      '--path', 'src',
      '--context-path', 'src',
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
      '--context-path', '.',
      '--scope', 'review\nconst embedded = true',
    ])
    assert.notEqual(multiline.status, 0)
    assert.match(multiline.stderr, /single-line instructions/u)

    const escaped = runManifest([
      workspace,
      '--path', '..',
      '--context-path', '.',
      '--scope', 'review parent',
    ])
    assert.notEqual(escaped.status, 0)
    assert.match(escaped.stderr, /path escapes workspace/u)
  } finally {
    rmSync(workspace, { recursive: true, force: true })
  }
})

test('task manifest rejects a context symlink that resolves outside the workspace', t => {
  const workspace = mkdtempSync(join(tmpdir(), 'dsh-relay-symlink-contract-'))
  const outside = mkdtempSync(join(tmpdir(), 'dsh-relay-outside-'))
  try {
    try {
      symlinkSync(outside, join(workspace, 'escape'), process.platform === 'win32' ? 'junction' : 'dir')
    } catch (error) {
      t.skip(`symlink creation is unavailable: ${String(error)}`)
      return
    }
    const escaped = runManifest([
      workspace,
      '--path', '.',
      '--context-path', 'escape',
      '--scope', 'review workspace context',
    ])
    assert.notEqual(escaped.status, 0)
    assert.match(escaped.stderr, /path escapes workspace/u)

    mkdirSync(join(workspace, 'docs'))
    writeFileSync(join(workspace, 'docs', 'plan.md'), '# plan\n', 'utf8')
    mkdirSync(join(workspace, 'src'))
    const targetOutsideContext = runManifest([
      workspace,
      '--path', 'docs/plan.md',
      '--context-path', 'src',
      '--scope', 'review plan against source',
    ])
    assert.notEqual(targetOutsideContext.status, 0)
    assert.match(targetOutsideContext.stderr, /review target is outside context read scope/u)
  } finally {
    rmSync(workspace, { recursive: true, force: true })
    rmSync(outside, { recursive: true, force: true })
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
