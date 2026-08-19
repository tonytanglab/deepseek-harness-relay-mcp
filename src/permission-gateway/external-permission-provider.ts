import type {
  ExternalPermissionClient,
  PermissionPreset,
  PermissionProvider,
  PermissionSelectionResult,
} from './types.js'

export class ExternalPermissionProvider implements PermissionProvider {
  constructor(private readonly client: ExternalPermissionClient) {}

  async readCurrent(sessionId: string): Promise<unknown> {
    const projection = await this.client.readPermissionProjection(sessionId)
    return projection.currentValue
  }

  async select(sessionId: string, preset: PermissionPreset): Promise<PermissionSelectionResult> {
    const result = await this.client.requestPermissionSelection(sessionId, preset)
    return { accepted: result.kind === 'success' }
  }
}
