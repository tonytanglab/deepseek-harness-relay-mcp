export type ClientName = 'codex' | 'claude' | 'cursor' | 'opencode'

export type ClientScope = 'local' | 'project' | 'user'

export type SetupPlatform = 'win32' | 'darwin' | 'linux'

export type ConfigFormat = 'json' | 'jsonc' | 'toml'

export type IssueSeverity = 'info' | 'warning' | 'error'

export interface SetupIssue {
  code: string
  severity: IssueSeverity
  message: string
  remediation?: string
}

export interface ScopeSupport {
  client: ClientName
  supportedScopes: readonly ClientScope[]
  notes: Readonly<Partial<Record<ClientScope, string>>>
}

export interface ExistingConfigSnapshot {
  exists: boolean
  readable: boolean
  serverIds: readonly string[]
  parseError?: string
}

export interface DetectRequest {
  client: ClientName
  scope: ClientScope
  platform: SetupPlatform
  homeDirectory: string
  workspaceDirectory?: string
  snapshot?: ExistingConfigSnapshot
}

export interface ConfigLocation {
  path: string
  format: ConfigFormat
  selector: readonly string[]
  managedBy: 'structured-patch' | 'client-cli'
  dialect?: 'opencode-v2'
}

export interface DetectedClientConfig {
  client: ClientName
  scope: ClientScope
  supported: boolean
  alreadyConfigured: boolean
  existingServerIds: readonly string[]
  location?: ConfigLocation
  issues: readonly SetupIssue[]
}

export interface StdioLauncherRequest {
  platform: SetupPlatform
  nodeExecutable: string
  relayEntry: string
  environment?: Readonly<Record<string, string>>
}

export interface StdioLauncherPlan {
  transport: 'stdio'
  command: string
  args: readonly string[]
  environment: Readonly<Record<string, string>>
  resolution: 'absolute-node'
}

export interface LauncherPlanResult {
  launcher?: StdioLauncherPlan
  issues: readonly SetupIssue[]
}

export interface ConfigPatch {
  client: ClientName
  scope: ClientScope
  target: ConfigLocation
  operation: 'upsert'
  serverId: 'harness-relay-mcp'
  value: Readonly<Record<string, unknown>>
  snippet: string
}

export interface ValidationResult {
  valid: boolean
  issues: readonly SetupIssue[]
}

export interface SetupRequest extends DetectRequest {
  launcher: StdioLauncherRequest
}

export interface SetupPlan {
  ready: boolean
  writeAuthorized: false
  detection: DetectedClientConfig
  launcher?: StdioLauncherPlan
  patch?: ConfigPatch
  issues: readonly SetupIssue[]
  actions: readonly SetupAction[]
}

export interface SetupAction {
  kind: 'review-config-patch'
  target: string
  description: string
}

export interface ClientConfigAdapter {
  readonly client: ClientName
  readonly support: ScopeSupport
  detect(request: DetectRequest): DetectedClientConfig
  render(detection: DetectedClientConfig, launcher: StdioLauncherPlan): ConfigPatch
  validate(patch: ConfigPatch): ValidationResult
}

export interface DoctorFacts {
  nodeExecutableExists?: boolean | undefined
  relayEntryExists?: boolean | undefined
  configParentWritable?: boolean | undefined
  brokerReachable?: boolean | undefined
  hostReachable?: boolean | undefined
  workspaceExists?: boolean | undefined
  modelAvailable?: boolean | undefined
  permissionAvailable?: boolean | undefined
  targetWebProfile?: boolean | undefined
  bundleInstalled?: boolean | undefined
  httpRouteReachable?: boolean | undefined
  tokenFileSecure?: boolean | undefined
  authorityOwnerHealthy?: boolean | undefined
  recursiveConfigurationAbsent?: boolean | undefined
}

export interface DoctorRequest {
  setup: SetupRequest
  facts?: DoctorFacts
}

export type DoctorCheckStatus = 'pass' | 'warn' | 'fail' | 'skipped'

export interface DoctorCheck {
  id: string
  status: DoctorCheckStatus
  summary: string
  remediation?: string
}

export interface DoctorReport {
  schemaVersion: 1
  client: ClientName
  scope: ClientScope
  status: 'healthy' | 'degraded' | 'blocked'
  planReady: boolean
  checks: readonly DoctorCheck[]
  plan: SetupPlan
}
