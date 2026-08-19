import {
  PermissionGatewayError,
  type PermissionGateway,
  type PermissionPreset,
  type PermissionProvider,
} from './types.js'

const permissionPresets = new Set<PermissionPreset>([
  'read-only',
  'workspace-write',
  'danger-full-access',
])

export class PermissionGatewayFacade implements PermissionGateway {
  constructor(private readonly provider: PermissionProvider) {}

  async current(sessionId: string): Promise<PermissionPreset> {
    const value = await this.provider.readCurrent(sessionId)
    if (!isPermissionPreset(value)) {
      throw new PermissionGatewayError(
        'PERMISSION_UNAVAILABLE',
        `Harness did not report the current permission preset for ${sessionId}`,
        { sessionId, actual: value },
      )
    }
    return value
  }

  async select(sessionId: string, preset: PermissionPreset): Promise<PermissionPreset> {
    const result = await this.provider.select(sessionId, preset)
    if (!result.accepted) {
      throw new PermissionGatewayError(
        'PERMISSION_DENIED',
        `Harness did not accept permission preset ${preset}`,
        { sessionId, expected: preset },
      )
    }
    return this.confirm(sessionId, preset)
  }

  async confirm(sessionId: string, expected: PermissionPreset): Promise<PermissionPreset> {
    const actual = await this.current(sessionId)
    if (actual !== expected) {
      throw new PermissionGatewayError(
        'PERMISSION_DENIED',
        `Harness did not confirm permission preset ${expected}; task prompt was not submitted`,
        { sessionId, expected, actual },
      )
    }
    return actual
  }
}

function isPermissionPreset(value: unknown): value is PermissionPreset {
  return typeof value === 'string' && permissionPresets.has(value as PermissionPreset)
}
