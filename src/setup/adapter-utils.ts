import type {
  ClientName,
  ClientScope,
  ConfigLocation,
  ConfigPatch,
  DetectRequest,
  DetectedClientConfig,
  ScopeSupport,
  SetupIssue,
  StdioLauncherPlan,
  ValidationResult,
} from './types.js'
import { MCP_SERVER_ID } from '../product-identity/index.js'
import { pathFor } from './path-policy.js'

export abstract class StructuredClientConfigAdapter {
  abstract readonly client: ClientName
  abstract readonly support: ScopeSupport

  detect(request: DetectRequest): DetectedClientConfig {
    if (!this.support.supportedScopes.includes(request.scope)) {
      return {
        client: this.client,
        scope: request.scope,
        supported: false,
        alreadyConfigured: false,
        existingServerIds: request.snapshot?.serverIds ?? [],
        issues: [{
          code: 'SCOPE_UNSUPPORTED',
          severity: 'error',
          message: `${this.client} does not support the ${request.scope} scope in this setup core.`,
          ...(this.support.notes[request.scope] === undefined ? {} : { remediation: this.support.notes[request.scope] }),
        }],
      }
    }

    const directoryIssues = validateDirectories(request)
    if (directoryIssues.length > 0) {
      return {
        client: this.client,
        scope: request.scope,
        supported: true,
        alreadyConfigured: false,
        existingServerIds: request.snapshot?.serverIds ?? [],
        issues: directoryIssues,
      }
    }

    const location = this.location(request)
    const issues: SetupIssue[] = []
    if (request.snapshot?.parseError !== undefined) {
      issues.push({
        code: 'CONFIG_PARSE_FAILED',
        severity: 'error',
        message: request.snapshot.parseError,
        remediation: 'Repair the existing configuration before generating an apply operation.',
      })
    } else if (request.snapshot?.readable === false) {
      issues.push({
        code: 'CONFIG_NOT_READABLE',
        severity: 'error',
        message: `The existing ${this.client} configuration is not readable.`,
      })
    }

    const existingServerIds = request.snapshot?.serverIds ?? []
    return {
      client: this.client,
      scope: request.scope,
      supported: true,
      alreadyConfigured: existingServerIds.includes(MCP_SERVER_ID),
      existingServerIds,
      location,
      issues,
    }
  }

  render(detection: DetectedClientConfig, launcher: StdioLauncherPlan): ConfigPatch {
    if (!detection.supported || detection.location === undefined) {
      throw new Error(`Cannot render an unsupported ${detection.client}/${detection.scope} configuration.`)
    }
    if (detection.client !== this.client) throw new Error('Adapter/client mismatch.')
    return this.renderSupported(detection.scope, detection.location, launcher)
  }

  validate(patch: ConfigPatch): ValidationResult {
    const issues: SetupIssue[] = []
    if (patch.client !== this.client) {
      issues.push({ code: 'PATCH_CLIENT_MISMATCH', severity: 'error', message: 'Patch belongs to another client adapter.' })
    }
    if (patch.serverId !== MCP_SERVER_ID || patch.target.selector.at(-1) !== MCP_SERVER_ID) {
      issues.push({ code: 'PATCH_SERVER_MISMATCH', severity: 'error', message: `Patch does not target the ${MCP_SERVER_ID} server.` })
    }
    issues.push(...this.validateValue(patch.value))
    return { valid: !issues.some(issue => issue.severity === 'error'), issues }
  }

  protected abstract location(request: DetectRequest): ConfigLocation

  protected abstract renderSupported(
    scope: ClientScope,
    location: ConfigLocation,
    launcher: StdioLauncherPlan,
  ): ConfigPatch

  protected abstract validateValue(value: Readonly<Record<string, unknown>>): readonly SetupIssue[]
}

function validateDirectories(request: DetectRequest): readonly SetupIssue[] {
  const pathApi = pathFor(request.platform)
  const issues: SetupIssue[] = []
  if (!pathApi.isAbsolute(request.homeDirectory)) {
    issues.push({ code: 'HOME_NOT_ABSOLUTE', severity: 'error', message: 'homeDirectory must be an absolute path.' })
  }
  if (request.scope !== 'user') {
    if (request.workspaceDirectory === undefined) {
      issues.push({ code: 'WORKSPACE_REQUIRED', severity: 'error', message: `${request.client}/${request.scope} requires workspaceDirectory.` })
    } else if (!pathApi.isAbsolute(request.workspaceDirectory)) {
      issues.push({ code: 'WORKSPACE_NOT_ABSOLUTE', severity: 'error', message: 'workspaceDirectory must be an absolute path.' })
    }
  }
  return issues
}

export function stdioValue(launcher: StdioLauncherPlan): Readonly<Record<string, unknown>> {
  return {
    command: launcher.command,
    args: [...launcher.args],
    ...(Object.keys(launcher.environment).length === 0 ? {} : { env: { ...launcher.environment } }),
  }
}

export function validateStdioValue(value: Readonly<Record<string, unknown>>): readonly SetupIssue[] {
  const issues: SetupIssue[] = []
  if (typeof value.command !== 'string' || !isAbsoluteNodeCommand(value.command)) {
    issues.push({ code: 'PATCH_COMMAND_INVALID', severity: 'error', message: 'Rendered command is not an absolute Node executable.' })
  }
  if (!Array.isArray(value.args) || value.args.length !== 1 || typeof value.args[0] !== 'string' || !isAbsoluteScriptEntry(value.args[0])) {
    issues.push({ code: 'PATCH_ARGS_INVALID', severity: 'error', message: 'Rendered args must contain exactly one Relay module entry.' })
  }
  return issues
}

export function isAbsoluteNodeCommand(command: string): boolean {
  return isAbsolutePortable(command) && isNodeName(command)
}

export function isAbsoluteScriptEntry(entry: string): boolean {
  if (!isAbsolutePortable(entry)) return false
  const normalized = entry.replaceAll('\\', '/').toLowerCase()
  return normalized.endsWith('.mjs') || normalized.endsWith('.js') || normalized.endsWith('.cjs')
}

export function jsonSnippet(selector: readonly string[], value: Readonly<Record<string, unknown>>): string {
  let document: unknown = value
  for (let index = selector.length - 1; index >= 0; index -= 1) {
    const key = selector[index]
    if (key === undefined) continue
    document = { [key]: document }
  }
  return `${JSON.stringify(document, null, 2)}\n`
}

function isNodeName(command: string): boolean {
  const normalized = command.replaceAll('\\', '/').toLowerCase()
  return normalized.endsWith('/node') || normalized.endsWith('/node.exe')
}

function isAbsolutePortable(value: string): boolean {
  return pathFor('win32').isAbsolute(value) || pathFor('linux').isAbsolute(value)
}
