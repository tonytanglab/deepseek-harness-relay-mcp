/** Resolve a caller-supplied model name against a Harness session.models catalog. */

export interface CatalogModel {
  id: string
  name: string
  reasoning?: {
    efforts: Array<{ id: string; name: string }>
    defaultEffort?: string
  }
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

const EFFORT_ALIASES: Record<string, string> = {
  max: 'max',
  maximum: 'max',
  high: 'high',
  medium: 'medium',
  mid: 'medium',
  low: 'low',
  minimal: 'minimal',
  min: 'minimal',
  none: 'none',
}

/**
 * Split a combined label such as `K3 MAX` or `deepseek v4 flash max`
 * into a model needle and reasoning effort. Explicit `reasoningEffort` wins.
 */
export function parseModelRequest(input: { model?: string; provider?: string; reasoningEffort?: string }): {
  model?: string
  provider?: string
  reasoningEffort?: string
} {
  const explicit = input.reasoningEffort?.trim()
  const parts = (input.model ?? '').trim().split(/\s+/).filter(Boolean)
  let effort: string | undefined
  let modelParts = parts
  if (parts.length >= 2) {
    const aliased = EFFORT_ALIASES[parts[parts.length - 1]!.toLowerCase()]
    if (aliased !== undefined) {
      effort = aliased
      modelParts = parts.slice(0, -1)
    }
  }
  const model = modelParts.join(' ')
  return {
    ...input.provider?.trim() ? { provider: input.provider.trim() } : {},
    ...model !== '' ? { model } : {},
    ...explicit ? { reasoningEffort: explicit } : effort !== undefined ? { reasoningEffort: effort } : {},
  }
}

/**
 * Pick one catalog route from a model id, display name, or spaced label.
 * Exact id matches beat names so `k3` does not resolve to `k3-256k`.
 * A trailing effort word (`max`/`high`/`low`) is not part of the model id.
 */
export function resolveCatalogModel(
  groups: CatalogGroup[],
  input: { model?: string; provider?: string; reasoningEffort?: string },
): ModelSelection {
  const parsed = parseModelRequest(input)
  const modelNeedle = parsed.model ?? ''
  const providerNeedle = parsed.provider ?? ''
  if (modelNeedle === '' && providerNeedle === '') {
    throw new Error('dsh-relay: model or provider is required to select a Harness model')
  }
  const routes = groups.flatMap(group => {
    const provider = (group.id ?? group.provider ?? '').trim()
    if (provider === '') return []
    return group.models.map(entry => ({
      provider,
      model: entry.id,
      name: entry.name,
      reasoning: entry.reasoning,
    }))
  })
  const inProvider = providerNeedle === ''
    ? routes
    : routes.filter(route => same(route.provider, providerNeedle) || same(route.provider, providerNeedle.replaceAll('_', '-')))
  if (inProvider.length === 0) {
    throw new Error(`dsh-relay: unknown provider ${JSON.stringify(providerNeedle)}. Available: ${unique(routes.map(route => route.provider)).join(', ')}`)
  }
  if (modelNeedle === '') {
    if (inProvider.length === 1) return withEffort(inProvider[0]!, parsed.reasoningEffort)
    throw new Error(`dsh-relay: provider ${JSON.stringify(providerNeedle)} has multiple models; pass model`)
  }
  const exactId = inProvider.find(route => same(route.model, modelNeedle))
  if (exactId !== undefined) return withEffort(exactId, parsed.reasoningEffort)
  const exactName = inProvider.find(route => same(route.name, modelNeedle))
  if (exactName !== undefined) return withEffort(exactName, parsed.reasoningEffort)
  const foldedId = inProvider.find(route => fold(route.model) === fold(modelNeedle))
  if (foldedId !== undefined) return withEffort(foldedId, parsed.reasoningEffort)
  const foldedName = inProvider.find(route => fold(route.name) === fold(modelNeedle))
  if (foldedName !== undefined) return withEffort(foldedName, parsed.reasoningEffort)
  const loose = inProvider.filter(route =>
    route.model.toLowerCase().includes(modelNeedle.toLowerCase())
    || route.name.toLowerCase().includes(modelNeedle.toLowerCase())
    || fold(route.model).includes(fold(modelNeedle))
    || fold(route.name).includes(fold(modelNeedle)),
  )
  if (loose.length === 1) return withEffort(loose[0]!, parsed.reasoningEffort)
  if (loose.length > 1) {
    throw new Error(`dsh-relay: model ${JSON.stringify(modelNeedle)} is ambiguous. Candidates: ${loose.map(route => `${route.provider}/${route.model}`).join(', ')}`)
  }
  throw new Error(`dsh-relay: unknown model ${JSON.stringify(modelNeedle)}. Available: ${inProvider.map(route => `${route.provider}/${route.model}`).join(', ')}`)
}

/** Compact catalog for `doctor`, including effort ids when the adapter publishes them. */
export function summarizeCatalog(directory: SessionModels): {
  current: ModelSelection | null
  groups: Array<{ provider: string; models: Array<{ id: string; name: string; efforts: string[] }> }>
} {
  return {
    current: directory.current ?? null,
    groups: directory.groups.flatMap(group => {
      const provider = (group.id ?? group.provider ?? '').trim()
      if (provider === '') return []
      return [{
        provider,
        models: group.models.map(entry => ({
          id: entry.id,
          name: entry.name,
          efforts: (entry.reasoning?.efforts ?? []).map(effort => effort.id),
        })),
      }]
    }),
  }
}

function withEffort(
  route: { provider: string; model: string; reasoning?: CatalogModel['reasoning'] },
  effort: string | undefined,
): ModelSelection {
  const selected: ModelSelection = { provider: route.provider, model: route.model }
  if (effort === undefined) return selected
  const published = route.reasoning?.efforts ?? []
  if (published.length === 0) {
    selected.reasoningEffort = effort
    return selected
  }
  const match = published.find(item =>
    same(item.id, effort)
    || same(item.name, effort)
    || EFFORT_ALIASES[item.id.toLowerCase()] === effort
    || EFFORT_ALIASES[item.name.toLowerCase()] === effort,
  )
  if (match === undefined) {
    throw new Error(`dsh-relay: unknown reasoningEffort ${JSON.stringify(effort)} for ${route.provider}/${route.model}. Available: ${published.map(item => item.id).join(', ')}`)
  }
  selected.reasoningEffort = match.id
  return selected
}

function fold(value: string): string {
  return value.toLowerCase().replace(/[\s_\-]+/g, '')
}

function same(left: string, right: string): boolean {
  return left.localeCompare(right, undefined, { sensitivity: 'accent' }) === 0
}

function unique(values: string[]): string[] {
  return [...new Set(values)]
}
