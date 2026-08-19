/** Resolve a caller-supplied model name against a Harness session.models catalog. */

export interface CatalogModel {
  id: string
  name: string
}

export interface CatalogGroup {
  id?: string
  provider?: string
  name?: string
  models: CatalogModel[]
}

export interface ModelSelection {
  provider: string
  model: string
  reasoningEffort?: string
}

export interface SessionModels {
  current?: ModelSelection
  groups: CatalogGroup[]
}

/**
 * Pick one catalog route from a model id, display name, or unique substring.
 * Exact id matches beat names so `k3` does not resolve to `k3-256k`.
 */
export function resolveCatalogModel(
  groups: CatalogGroup[],
  input: { model?: string; provider?: string },
): { provider: string; model: string } {
  const modelNeedle = input.model?.trim() ?? ''
  const providerNeedle = input.provider?.trim() ?? ''
  if (modelNeedle === '' && providerNeedle === '') {
    throw new Error('dsh-relay: model or provider is required to select a Harness model')
  }
  const routes = groups.flatMap(group => {
    const provider = (group.id ?? group.provider ?? '').trim()
    if (provider === '') return []
    return group.models.map(entry => ({ provider, model: entry.id, name: entry.name }))
  })
  const inProvider = providerNeedle === ''
    ? routes
    : routes.filter(route => same(route.provider, providerNeedle) || same(route.provider, providerNeedle.replaceAll('_', '-')))
  if (inProvider.length === 0) {
    throw new Error(`dsh-relay: unknown provider ${JSON.stringify(providerNeedle)}. Available: ${unique(routes.map(route => route.provider)).join(', ')}`)
  }
  if (modelNeedle === '') {
    if (inProvider.length === 1) return { provider: inProvider[0]!.provider, model: inProvider[0]!.model }
    throw new Error(`dsh-relay: provider ${JSON.stringify(providerNeedle)} has multiple models; pass model`)
  }
  const exactId = inProvider.find(route => same(route.model, modelNeedle))
  if (exactId !== undefined) return { provider: exactId.provider, model: exactId.model }
  const exactName = inProvider.find(route => same(route.name, modelNeedle))
  if (exactName !== undefined) return { provider: exactName.provider, model: exactName.model }
  const loose = inProvider.filter(route =>
    route.model.toLowerCase().includes(modelNeedle.toLowerCase())
    || route.name.toLowerCase().includes(modelNeedle.toLowerCase()),
  )
  if (loose.length === 1) return { provider: loose[0]!.provider, model: loose[0]!.model }
  if (loose.length > 1) {
    throw new Error(`dsh-relay: model ${JSON.stringify(modelNeedle)} is ambiguous. Candidates: ${loose.map(route => `${route.provider}/${route.model}`).join(', ')}`)
  }
  throw new Error(`dsh-relay: unknown model ${JSON.stringify(modelNeedle)}. Available: ${inProvider.map(route => `${route.provider}/${route.model}`).join(', ')}`)
}

function same(left: string, right: string): boolean {
  return left.localeCompare(right, undefined, { sensitivity: 'accent' }) === 0
}

function unique(values: string[]): string[] {
  return [...new Set(values)]
}
