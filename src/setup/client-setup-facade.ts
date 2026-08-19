import { ClaudeConfigAdapter } from './claude-config-adapter.js'
import { CodexConfigAdapter } from './codex-config-adapter.js'
import { CursorConfigAdapter } from './cursor-config-adapter.js'
import { OpenCodeConfigAdapter } from './opencode-config-adapter.js'
import { StdioLauncherPlanner } from './path-policy.js'
import { SetupDoctor } from './setup-doctor.js'
import type {
  ClientConfigAdapter,
  ClientName,
  ConfigPatch,
  DetectRequest,
  DetectedClientConfig,
  DoctorReport,
  DoctorRequest,
  ScopeSupport,
  SetupPlan,
  SetupRequest,
  StdioLauncherPlan,
  ValidationResult,
} from './types.js'

export class ClientSetupFacade {
  private readonly adapters: ReadonlyMap<ClientName, ClientConfigAdapter>

  constructor(
    adapters: readonly ClientConfigAdapter[] = defaultAdapters(),
    private readonly launcherPlanner = new StdioLauncherPlanner(),
    private readonly setupDoctor = new SetupDoctor(),
  ) {
    this.adapters = new Map(adapters.map(adapter => [adapter.client, adapter]))
  }

  getScopeSupport(): readonly ScopeSupport[] {
    return [...this.adapters.values()].map(adapter => adapter.support)
  }

  detect(request: DetectRequest): DetectedClientConfig {
    return this.adapter(request.client).detect(request)
  }

  render(client: ClientName, detection: DetectedClientConfig, launcher: StdioLauncherPlan): ConfigPatch {
    return this.adapter(client).render(detection, launcher)
  }

  validate(client: ClientName, patch: ConfigPatch): ValidationResult {
    return this.adapter(client).validate(patch)
  }

  plan(request: SetupRequest): SetupPlan {
    let detection: DetectedClientConfig
    try {
      detection = this.detect(request)
    } catch (error) {
      detection = {
        client: request.client,
        scope: request.scope,
        supported: true,
        alreadyConfigured: false,
        existingServerIds: request.snapshot?.serverIds ?? [],
        issues: [{
          code: 'CONFIG_LOCATION_INVALID',
          severity: 'error',
          message: error instanceof Error ? error.message : String(error),
        }],
      }
    }
    const platformIssues = request.platform === request.launcher.platform ? [] : [{
      code: 'PLATFORM_MISMATCH',
      severity: 'error' as const,
      message: `Configuration platform ${request.platform} does not match launcher platform ${request.launcher.platform}.`,
      remediation: 'Resolve both paths with the same target platform before rendering configuration.',
    }]
    const launcherResult = platformIssues.length === 0
      ? this.launcherPlanner.plan(request.launcher)
      : { issues: platformIssues }
    const issues = [...detection.issues, ...launcherResult.issues]
    if (!detection.supported || detection.location === undefined || launcherResult.launcher === undefined) {
      return { ready: false, writeAuthorized: false, detection, issues, actions: [] }
    }

    const patch = this.render(request.client, detection, launcherResult.launcher)
    const validation = this.validate(request.client, patch)
    issues.push(...validation.issues)
    const ready = !issues.some(issue => issue.severity === 'error')
    return {
      ready,
      writeAuthorized: false,
      detection,
      launcher: launcherResult.launcher,
      patch,
      issues,
      actions: ready ? [{
        kind: 'review-config-patch',
        target: patch.target.path,
        description: 'Review this minimal structured upsert before an authorized executor applies it.',
      }] : [],
    }
  }

  doctor(request: DoctorRequest): DoctorReport {
    return this.setupDoctor.diagnose(this.plan(request.setup), request.facts)
  }

  private adapter(client: ClientName): ClientConfigAdapter {
    const adapter = this.adapters.get(client)
    if (adapter === undefined) throw new Error(`Unsupported MCP client: ${client as string}`)
    return adapter
  }
}

function defaultAdapters(): readonly ClientConfigAdapter[] {
  return [new CodexConfigAdapter(), new ClaudeConfigAdapter(), new CursorConfigAdapter(), new OpenCodeConfigAdapter()]
}
