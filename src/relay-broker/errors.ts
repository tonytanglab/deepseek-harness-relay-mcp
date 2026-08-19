export type RelayNextAction = 'wait' | 'status' | 'reply' | 'reconcile' | 'choose-model' | 'confirm' | 'none'

export class RelayError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable: boolean,
    readonly details: {
      operationId?: string
      runId?: string
      lastKnownState?: string
      nextAction?: RelayNextAction
    } = {},
  ) {
    super(message)
    this.name = 'RelayError'
  }

  toStructuredContent(): Record<string, unknown> {
    return {
      code: this.code,
      message: this.message,
      retryable: this.retryable,
      ...this.details,
    }
  }
}
