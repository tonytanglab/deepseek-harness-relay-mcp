import type { SettingsDescription } from './harness-gateway/index.js'
import type { ModelSelection, ModelSelectionResult } from './types.js'

interface ModelSelectionGateway {
  describeSettings(): Promise<SettingsDescription>
  selectSessionModel(sessionId: string, selection: ModelSelection): Promise<ModelSelection>
  replaceSettings(namespace: string, section: Record<string, unknown>, expectedRevision: number): Promise<void>
  mutateSettings(namespace: string, ops: Array<Record<string, unknown>>, expectedRevision: number): Promise<void>
}

export class ModelSelectionFacade {
  private tail = Promise.resolve()

  constructor(private readonly gateway: ModelSelectionGateway) {}

  select(sessionId: string, selection: ModelSelection): Promise<ModelSelectionResult> {
    const operation = this.tail.then(() => this.selectLocked(sessionId, selection))
    this.tail = operation.then(() => undefined, () => undefined)
    return operation
  }

  private async selectLocked(sessionId: string, selection: ModelSelection): Promise<ModelSelectionResult> {
    let before: SettingsDescription | undefined
    try {
      before = await this.gateway.describeSettings()
    } catch {
      before = undefined
    }
    const selected = await this.gateway.selectSessionModel(sessionId, selection)
    const warnings: string[] = []
    const namespaceBefore = before?.namespaces.find(item => item.ns === 'agent-default-model')
    if (before === undefined || !before.writable || namespaceBefore === undefined) {
      warnings.push('Host default-model settings were unavailable or read-only; the session selection is still active.')
      return { selected, restore: 'unavailable', warnings }
    }
    let after: SettingsDescription
    try {
      after = await this.gateway.describeSettings()
    } catch {
      warnings.push('The session model was selected, but the Host default-model setting could not be re-read for restoration.')
      return { selected, restore: 'unavailable', warnings }
    }
    const namespaceAfter = after.namespaces.find(item => item.ns === 'agent-default-model')
    if (namespaceAfter === undefined || namespaceAfter.revision === namespaceBefore.revision) {
      return { selected, restore: 'not-needed', warnings }
    }
    if (namespaceAfter.revision !== namespaceBefore.revision + 1 || !sameSelection(namespaceAfter.user, selected)) {
      warnings.push('The Host default model changed concurrently; DSH Relay preserved the newer setting instead of overwriting it.')
      return { selected, restore: 'skipped-concurrent-change', warnings }
    }
    try {
      if (isObject(namespaceBefore.user)) {
        await this.gateway.replaceSettings('agent-default-model', namespaceBefore.user, namespaceAfter.revision)
      } else {
        await this.gateway.mutateSettings('agent-default-model', [{ op: 'unset', path: [] }], namespaceAfter.revision)
      }
      return { selected, restore: 'restored', warnings }
    } catch (error) {
      warnings.push(`The session model was selected, but the previous Host default was not restored: ${errorText(error)}`)
      return { selected, restore: 'skipped-concurrent-change', warnings }
    }
  }
}

function sameSelection(value: unknown, selection: ModelSelection): boolean {
  if (!isObject(value)) return false
  if (value.provider !== selection.provider || value.model !== selection.model) return false
  return value.reasoningEffort === selection.reasoningEffort
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
