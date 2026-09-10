import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { appendTaskScope } from '../src/prompt.js'
import { inheritTaskScope, resolveTaskScope } from '../src/relay-broker/run-input.js'

test('plan review separates the target from workspace context without reading source', () => {
  const workspace = mkdtempSync(join(tmpdir(), 'dsh-relay-task-scope-'))
  try {
    const scope = resolveTaskScope({
      workspace,
      task: 'review the plan',
      reviewTargets: ['docs/plan.md'],
      contextReadScope: ['.'],
      excludedPaths: ['secrets'],
    })
    assert.deepEqual(scope, {
      reviewTargets: ['docs/plan.md'],
      contextReadScope: ['.'],
      excludedPaths: ['secrets'],
      writeScope: [],
      enforcement: 'instruction-only',
    })
    const prompt = appendTaskScope({ task: 'review the plan' }, scope)
    assert.match(prompt.task ?? '', /reviewTargets: \["docs\/plan\.md"\]/u)
    assert.match(prompt.task ?? '', /contextReadScope: \["\."\]/u)
    assert.match(prompt.task ?? '', /not as a read whitelist/u)
    assert.match(prompt.task ?? '', /not a filesystem access control/u)
  } finally {
    rmSync(workspace, { recursive: true, force: true })
  }
})

test('target-only review is represented by matching target and context scopes', () => {
  const workspace = mkdtempSync(join(tmpdir(), 'dsh-relay-target-only-'))
  try {
    const scope = resolveTaskScope({
      workspace,
      task: 'read only this plan',
      reviewTargets: ['plan.md'],
      contextReadScope: ['plan.md'],
    })
    assert.deepEqual(scope?.reviewTargets, ['plan.md'])
    assert.deepEqual(scope?.contextReadScope, ['plan.md'])
  } finally {
    rmSync(workspace, { recursive: true, force: true })
  }
})

test('explicit Harness authorization is recorded without broadening scope', () => {
  const prompt = appendTaskScope(
    { task: 'review README.zh-CN.md' },
    {
      reviewTargets: ['README.zh-CN.md'],
      contextReadScope: ['README.zh-CN.md'],
      excludedPaths: [],
      writeScope: [],
      enforcement: 'instruction-only',
    },
    'explicit-user-request',
  )
  assert.match(prompt.task ?? '', /authorizationBasis: explicit-user-request/u)
  assert.match(prompt.task ?? '', /user explicitly selected Harness/u)
  assert.match(prompt.task ?? '', /does not authorize any broader workspace, scope, permission, provider, or external action/u)
})

test('reply scope inherits every prior field and changes only explicit fields', () => {
  const workspace = mkdtempSync(join(tmpdir(), 'dsh-relay-reply-scope-'))
  try {
    const inherited = resolveTaskScope({
      workspace,
      task: 'review',
      reviewTargets: ['docs/plan.md'],
      contextReadScope: ['docs', 'src', 'tests'],
      excludedPaths: ['src/private'],
    })
    assert.notEqual(inherited, undefined)
    const unchanged = inheritTaskScope({ workspace, task: 'continue' }, inherited)
    assert.deepEqual(resolveTaskScope(unchanged), inherited)

    const adjusted = inheritTaskScope({ workspace, task: 'include config', contextReadScope: ['docs', 'src', 'tests', 'config'] }, inherited)
    assert.deepEqual(resolveTaskScope(adjusted), {
      ...inherited,
      contextReadScope: ['docs', 'src', 'tests', 'config'],
    })
  } finally {
    rmSync(workspace, { recursive: true, force: true })
  }
})

test('structured scope rejects traversal and writes in read-only mode', () => {
  const workspace = mkdtempSync(join(tmpdir(), 'dsh-relay-scope-reject-'))
  try {
    assert.throws(() => resolveTaskScope({
      workspace,
      task: 'review',
      reviewTargets: ['plan.md'],
      contextReadScope: ['..'],
    }), /contextReadScope path escapes workspace/u)
    assert.throws(() => resolveTaskScope({
      workspace,
      task: 'review',
      reviewTargets: ['plan.md'],
      contextReadScope: ['.'],
      writeScope: ['plan.md'],
      permissionPreset: 'read-only',
    }), /writeScope must be empty/u)
    assert.throws(() => resolveTaskScope({
      workspace,
      task: 'review',
      reviewTargets: ['docs/plan.md'],
      contextReadScope: ['src'],
    }), /outside contextReadScope/u)
    assert.throws(() => resolveTaskScope({
      workspace,
      task: 'review',
      reviewTargets: ['docs/plan.md'],
      contextReadScope: ['.'],
      excludedPaths: ['docs'],
    }), /reviewTargets entry is excluded/u)
  } finally {
    rmSync(workspace, { recursive: true, force: true })
  }
})
