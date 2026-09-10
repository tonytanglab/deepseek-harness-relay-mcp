import { isAbsolute, relative, resolve } from 'node:path'
import type { PermissionPreset, PromptPart, TaskScopeDeclaration } from '../types.js'
import type { SessionMode } from '../session-routing/index.js'
import { RelayError } from './errors.js'

export interface StartRunInput {
  task?: string
  content?: PromptPart[]
  workspace: string
  sessionId?: string
  sessionMode?: SessionMode
  provider?: string
  model?: string
  reasoningEffort?: string
  agentPreset?: string
  permissionPreset?: PermissionPreset
  openBrowser?: boolean
  parentRunId?: string
  idempotencyKey?: string
  confirmedDangerousPermission?: boolean
  operationKind?: 'start' | 'reply'
  reviewTargets?: string[]
  contextReadScope?: string[]
  excludedPaths?: string[]
  writeScope?: string[]
  authorizationBasis?: 'explicit-user-request'
}

export function validateStartRunInput(input: StartRunInput): void {
  if (input.sessionId !== undefined && input.sessionMode !== undefined) {
    throw new Error('sessionId and sessionMode cannot be supplied together')
  }
  if ((input.provider === undefined) !== (input.model === undefined)) throw new Error('provider and model must be supplied together')
  if (input.reasoningEffort !== undefined && (input.provider === undefined || input.model === undefined)) {
    throw new Error('reasoningEffort requires provider and model')
  }
  if (input.permissionPreset === 'danger-full-access' && input.confirmedDangerousPermission !== true) {
    throw new RelayError('DANGEROUS_PERMISSION_CONFIRMATION_REQUIRED', 'danger-full-access requires confirmedDangerousPermission=true', false, { nextAction: 'confirm' })
  }
  resolveTaskScope(input)
}

export function resolveTaskScope(input: StartRunInput): TaskScopeDeclaration | undefined {
  const supplied = [input.reviewTargets, input.contextReadScope, input.excludedPaths, input.writeScope]
    .some(value => value !== undefined)
  if (!supplied) return undefined
  if (input.reviewTargets === undefined || input.reviewTargets.length === 0) {
    throw new Error('reviewTargets is required when a structured task scope is supplied')
  }
  if (input.contextReadScope === undefined || input.contextReadScope.length === 0) {
    throw new Error('contextReadScope is required when a structured task scope is supplied')
  }
  const scope: TaskScopeDeclaration = {
    reviewTargets: normalizePaths(input.workspace, input.reviewTargets, 'reviewTargets'),
    contextReadScope: normalizePaths(input.workspace, input.contextReadScope, 'contextReadScope'),
    excludedPaths: normalizePaths(input.workspace, input.excludedPaths ?? [], 'excludedPaths'),
    writeScope: normalizePaths(input.workspace, input.writeScope ?? [], 'writeScope'),
    enforcement: 'instruction-only',
  }
  for (const target of scope.reviewTargets) {
    if (!scope.contextReadScope.some(context => containsPath(context, target))) {
      throw new Error(`reviewTargets entry is outside contextReadScope: ${target}`)
    }
    if (scope.excludedPaths.some(excluded => containsPath(excluded, target))) {
      throw new Error(`reviewTargets entry is excluded: ${target}`)
    }
  }
  if ((input.permissionPreset ?? 'read-only') === 'read-only' && scope.writeScope.length > 0) {
    throw new Error('writeScope must be empty when permissionPreset is read-only')
  }
  if ((input.permissionPreset ?? 'read-only') !== 'read-only' && scope.writeScope.length === 0) {
    throw new Error('writeScope is required for a structured write-capable task scope')
  }
  return scope
}

function containsPath(parent: string, child: string): boolean {
  const normalizedParent = process.platform === 'win32' ? parent.toLowerCase() : parent
  const normalizedChild = process.platform === 'win32' ? child.toLowerCase() : child
  return normalizedParent === '.' || normalizedChild === normalizedParent || normalizedChild.startsWith(`${normalizedParent}/`)
}

export function inheritTaskScope(input: StartRunInput, inherited?: TaskScopeDeclaration): StartRunInput {
  const supplied = [input.reviewTargets, input.contextReadScope, input.excludedPaths, input.writeScope]
    .some(value => value !== undefined)
  if (inherited === undefined) return input
  if (!supplied) return {
    ...input,
    reviewTargets: inherited.reviewTargets,
    contextReadScope: inherited.contextReadScope,
    excludedPaths: inherited.excludedPaths,
    writeScope: inherited.writeScope,
  }
  return {
    ...input,
    reviewTargets: input.reviewTargets ?? inherited.reviewTargets,
    contextReadScope: input.contextReadScope ?? inherited.contextReadScope,
    excludedPaths: input.excludedPaths ?? inherited.excludedPaths,
    writeScope: input.writeScope ?? inherited.writeScope,
  }
}

function normalizePaths(workspace: string, values: string[], field: string): string[] {
  const root = resolve(workspace)
  return [...new Set(values.map(value => {
    if (value.trim() === '' || value.includes('\0')) throw new Error(`${field} entries must be non-empty and contain no NUL`)
    const target = resolve(root, value)
    const local = relative(root, target)
    if (local === '..' || local.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(local)) {
      throw new Error(`${field} path escapes workspace: ${value}`)
    }
    return local === '' ? '.' : local.replaceAll('\\', '/')
  }))]
}

export function operationRequest(input: StartRunInput, summary: string, imageCount: number): object {
  const taskScope = resolveTaskScope(input)
  return {
    workspace: input.workspace,
    sessionId: input.sessionId ?? null,
    sessionMode: input.sessionMode ?? 'fresh',
    provider: input.provider ?? null,
    model: input.model ?? null,
    reasoningEffort: input.reasoningEffort ?? null,
    agentPreset: input.agentPreset ?? null,
    permissionPreset: input.permissionPreset ?? 'read-only',
    parentRunId: input.parentRunId ?? null,
    ...(taskScope === undefined ? {} : { taskScope }),
    ...(input.authorizationBasis === undefined ? {} : { authorizationBasis: input.authorizationBasis }),
    summary,
    imageCount,
  }
}
