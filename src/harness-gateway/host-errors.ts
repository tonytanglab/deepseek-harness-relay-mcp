/** Stable Relay error raised by a Harness gateway adapter. */
export class HostRpcError extends Error {
  constructor(
    message: string,
    readonly definitiveRejection: boolean,
    readonly code: string = 'HOST_RPC_ERROR',
    readonly retryable: boolean = !definitiveRejection,
    readonly details?: unknown,
  ) {
    super(message)
    this.name = 'HostRpcError'
  }
}

/**
 * Classify a Harness business error without leaking transport details.
 * @param code - Harness error code.
 * @returns Whether retrying or reconciling may produce a different result.
 */
export function isTransientHostCode(code: string): boolean {
  return /^(?:HOST[_-])?(?:TIMEOUT|UNAVAILABLE|TRANSPORT|RATE[_-]LIMIT|TOO[_-]MANY|BUSY|OVERLOADED|INTERNAL|TEMPORARY)(?:[_-]|$)/iu.test(code)
}

/**
 * Normalize an in-process carrier exception.
 * @param operation - Semantic operation name used in diagnostics.
 * @param error - Exception raised by the official in-process client.
 * @returns Stable Relay gateway error.
 */
export function inProcessTransportError(operation: string, error: unknown): HostRpcError {
  if (error instanceof HostRpcError) return error
  const message = error instanceof Error ? error.message : String(error)
  const name = error instanceof Error ? error.name : ''
  const code = name === 'AbortError' || /timeout|timed out/iu.test(message)
    ? 'HOST_TIMEOUT'
    : 'HOST_IN_PROCESS_TRANSPORT'
  return new HostRpcError(`${operation} transport failed: ${message}`, false, code, true)
}
