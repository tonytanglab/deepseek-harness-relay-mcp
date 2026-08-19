import {
  PermissionGatewayError,
  type PermissionPreset,
  type PermissionProvider,
  type PermissionSelectionResult,
} from './types.js'

/** Structural view of Harness's native PermissionPresetService. */
export interface InProcessPermissionPresetPort<TSession, TEvent> {
  current(events: readonly TEvent[]): string
  set(session: TSession, preset: string): void
}

/**
 * Native permission provider over `ctx.sessions` and `ctx.permissionPresets`.
 * The provider appends Harness permission events directly and never sends a
 * slash command or another chat message.
 */
export class InProcessPermissionProvider<TSession, TEvent> implements PermissionProvider {
  constructor(
    private readonly resolveSession: (sessionId: string) => TSession | undefined,
    private readonly eventsOf: (session: TSession) => readonly TEvent[],
    private readonly presets: InProcessPermissionPresetPort<TSession, TEvent>,
  ) {}

  async readCurrent(sessionId: string): Promise<unknown> {
    const session = this.requireSession(sessionId)
    return this.presets.current(this.eventsOf(session))
  }

  async select(sessionId: string, preset: PermissionPreset): Promise<PermissionSelectionResult> {
    const session = this.requireSession(sessionId)
    try {
      this.presets.set(session, preset)
    } catch (error: unknown) {
      throw new PermissionGatewayError(
        'PERMISSION_DENIED',
        `Harness rejected permission preset ${preset}: ${error instanceof Error ? error.message : String(error)}`,
        { sessionId, expected: preset },
      )
    }
    return { accepted: true }
  }

  private requireSession(sessionId: string): TSession {
    const session = this.resolveSession(sessionId)
    if (session === undefined) {
      throw new PermissionGatewayError(
        'PERMISSION_UNAVAILABLE',
        `Harness session ${sessionId} is not live in the injected session store`,
        { sessionId },
      )
    }
    return session
  }
}
