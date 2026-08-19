import assert from 'node:assert/strict'
import test from 'node:test'
import { ModelSelectionFacade } from '../src/model-selection.js'

test('restores the previous shared default after selecting a session model', async () => {
  const calls: Array<{ method: string; payload: object }> = []
  let describes = 0
  const client = {
    async describeSettings() {
      calls.push({ method: 'settings.describe', payload: {} })
      describes += 1
      return describes === 1
        ? { writable: true, namespaces: [{ ns: 'agent-default-model', user: { provider: 'kimi-coding', model: 'k3', reasoningEffort: 'max' }, revision: 9 }] }
        : { writable: true, namespaces: [{ ns: 'agent-default-model', user: { provider: 'deepseek-official', model: 'deepseek-v4-flash', reasoningEffort: 'max' }, revision: 10 }] }
    },
    async selectSessionModel() {
      calls.push({ method: 'session.selectModel', payload: {} })
      return { provider: 'deepseek-official', model: 'deepseek-v4-flash', reasoningEffort: 'max' }
    },
    async replaceSettings(namespace: string, section: Record<string, unknown>, expectedRevision: number) {
      calls.push({ method: 'settings.replace', payload: { ns: namespace, section, expectedRevision } })
    },
    async mutateSettings(namespace: string, ops: Array<Record<string, unknown>>, expectedRevision: number) {
      calls.push({ method: 'settings.mutate', payload: { ns: namespace, ops, expectedRevision } })
    },
  }
  const result = await new ModelSelectionFacade(client).select('session-1', { provider: 'deepseek-official', model: 'deepseek-v4-flash', reasoningEffort: 'max' })
  assert.equal(result.restore, 'restored')
  assert.deepEqual(calls.at(-1), { method: 'settings.replace', payload: { ns: 'agent-default-model', section: { provider: 'kimi-coding', model: 'k3', reasoningEffort: 'max' }, expectedRevision: 10 } })
})

test('does not overwrite a concurrent default-model change', async () => {
  let describes = 0
  const calls: string[] = []
  const client = {
    async describeSettings() {
      calls.push('settings.describe')
      describes += 1
      return describes === 1
        ? { writable: true, namespaces: [{ ns: 'agent-default-model', user: { provider: 'kimi-coding', model: 'k3' }, revision: 9 }] }
        : { writable: true, namespaces: [{ ns: 'agent-default-model', user: { provider: 'other', model: 'new' }, revision: 11 }] }
    },
    async selectSessionModel() {
      calls.push('session.selectModel')
      return { provider: 'deepseek-official', model: 'deepseek-v4-flash', reasoningEffort: 'max' }
    },
    async replaceSettings() {
      calls.push('settings.replace')
    },
    async mutateSettings() {
      calls.push('settings.mutate')
    },
  }
  const result = await new ModelSelectionFacade(client).select('session-1', { provider: 'deepseek-official', model: 'deepseek-v4-flash', reasoningEffort: 'max' })
  assert.equal(result.restore, 'skipped-concurrent-change')
  assert.equal(calls.includes('settings.replace'), false)
})

test('removes a newly created user default when none existed before selection', async () => {
  const calls: Array<{ method: string; payload: object }> = []
  let describes = 0
  const client = {
    async describeSettings() {
      calls.push({ method: 'settings.describe', payload: {} })
      describes += 1
      return describes === 1
        ? { writable: true, namespaces: [{ ns: 'agent-default-model', revision: 0 }] }
        : { writable: true, namespaces: [{ ns: 'agent-default-model', user: { provider: 'kimi-coding', model: 'k3' }, revision: 1 }] }
    },
    async selectSessionModel() {
      calls.push({ method: 'session.selectModel', payload: {} })
      return { provider: 'kimi-coding', model: 'k3' }
    },
    async replaceSettings(namespace: string, section: Record<string, unknown>, expectedRevision: number) {
      calls.push({ method: 'settings.replace', payload: { ns: namespace, section, expectedRevision } })
    },
    async mutateSettings(namespace: string, ops: Array<Record<string, unknown>>, expectedRevision: number) {
      calls.push({ method: 'settings.mutate', payload: { ns: namespace, ops, expectedRevision } })
    },
  }
  const result = await new ModelSelectionFacade(client).select('session-1', { provider: 'kimi-coding', model: 'k3' })
  assert.equal(result.restore, 'restored')
  assert.deepEqual(calls.at(-1), {
    method: 'settings.mutate',
    payload: { ns: 'agent-default-model', ops: [{ op: 'unset', path: [] }], expectedRevision: 1 },
  })
})
