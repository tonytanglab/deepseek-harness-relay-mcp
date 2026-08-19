import { createHash } from 'node:crypto'
import type { RunSnapshot } from '../types.js'

export function cloneRun(run: RunSnapshot): RunSnapshot {
  return { ...run, modelSelection: run.modelSelection === null ? null : { ...run.modelSelection }, warnings: [...run.warnings] }
}

export function persistedSnapshot(run: RunSnapshot, persistPromptText: boolean): RunSnapshot {
  const snapshot = cloneRun(run)
  if (persistPromptText) return snapshot
  snapshot.task = '[prompt text not persisted]'
  snapshot.taskPersisted = false
  return snapshot
}

export function requestFingerprint(value: unknown): string {
  return createHash('sha256').update(stableJson(value), 'utf8').digest('hex')
}

export function delay(timeoutMs: number): Promise<void> {
  return new Promise(resolveDelay => setTimeout(resolveDelay, timeoutMs))
}

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (typeof value === 'object' && value !== null) {
    const record = value as Record<string, unknown>
    return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}
