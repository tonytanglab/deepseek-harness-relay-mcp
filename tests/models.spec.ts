import { describe, expect, it } from 'vitest'
import { parseModelRequest, resolveCatalogModel } from '../src/models.ts'

const groups = [
  {
    id: 'deepseek-official',
    name: 'DeepSeek',
    models: [
      { id: 'deepseek-v4-flash', name: 'DeepSeek-V4-Flash' },
      { id: 'deepseek-v4-pro', name: 'DeepSeek-V4-Pro' },
    ],
  },
  {
    id: 'kimi-coding',
    name: 'kimi-coding',
    models: [
      { id: 'k3', name: 'Kimi K3' },
      { id: 'k3-256k', name: 'Kimi K3-256K' },
      { id: 'kimi-for-coding', name: 'Kimi K2.7 Code' },
    ],
  },
]

describe('resolveCatalogModel', () => {
  it('resolves K3 to kimi-coding/k3 without matching k3-256k', () => {
    expect(resolveCatalogModel(groups, { model: 'K3' })).toEqual({ provider: 'kimi-coding', model: 'k3' })
    expect(resolveCatalogModel(groups, { model: 'k3' })).toEqual({ provider: 'kimi-coding', model: 'k3' })
    expect(resolveCatalogModel(groups, { model: 'Kimi K3' })).toEqual({ provider: 'kimi-coding', model: 'k3' })
  })

  it('accepts an explicit provider', () => {
    expect(resolveCatalogModel(groups, { provider: 'kimi-coding', model: 'k3' }))
      .toEqual({ provider: 'kimi-coding', model: 'k3' })
  })

  it('treats a trailing MAX as reasoning effort, not a different model', () => {
    expect(parseModelRequest({ model: 'K3 MAX' })).toEqual({ model: 'K3', reasoningEffort: 'max' })
    expect(parseModelRequest({ model: 'deepseek v4 flash max' })).toEqual({
      model: 'deepseek v4 flash',
      reasoningEffort: 'max',
    })
    expect(resolveCatalogModel(groups, { model: 'K3 MAX' })).toEqual({
      provider: 'kimi-coding',
      model: 'k3',
      reasoningEffort: 'max',
    })
    expect(resolveCatalogModel(groups, { model: 'deepseek v4 flash max' })).toEqual({
      provider: 'deepseek-official',
      model: 'deepseek-v4-flash',
      reasoningEffort: 'max',
    })
    expect(resolveCatalogModel(groups, { model: 'DeepSeek-V4-Flash', reasoningEffort: 'high' })).toEqual({
      provider: 'deepseek-official',
      model: 'deepseek-v4-flash',
      reasoningEffort: 'high',
    })
  })

  it('rejects an unknown model with the catalog', () => {
    expect(() => resolveCatalogModel(groups, { model: 'nope' })).toThrow(/unknown model/)
  })
})
