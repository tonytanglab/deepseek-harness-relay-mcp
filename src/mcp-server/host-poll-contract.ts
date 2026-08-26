import type { RunStatus } from '../types.js'

export const HOST_POLL_CONTRACT_SCHEMA_VERSION = 1 as const

export type HostPollNextTool = 'wait_run' | 'consume_assistantText' | 'inspect_error' | 'get_run_summary'

export interface HostPollContract {
  readonly schemaVersion: typeof HOST_POLL_CONTRACT_SCHEMA_VERSION
  readonly waitRunIsASlice: true
  readonly runComplete: boolean
  readonly hostMustCallWaitRunAgain: boolean
  readonly doNotConcludeHostTurn: boolean
  readonly nextTool: HostPollNextTool
  readonly consumeAssistantTextBeforeClosing: boolean
}

const TERMINAL_SUCCESS = new Set<RunStatus>(['succeeded', 'incomplete'])
const TERMINAL_FAILURE = new Set<RunStatus>(['failed', 'cancelled'])

export function hostPollContract(status: RunStatus): HostPollContract {
  const succeeded = TERMINAL_SUCCESS.has(status)
  const failed = TERMINAL_FAILURE.has(status)
  const runComplete = succeeded || failed
  const hostMustCallWaitRunAgain = status === 'running' || status === 'unknown'
  return {
    schemaVersion: HOST_POLL_CONTRACT_SCHEMA_VERSION,
    waitRunIsASlice: true,
    runComplete,
    hostMustCallWaitRunAgain,
    doNotConcludeHostTurn: !runComplete,
    nextTool: hostMustCallWaitRunAgain
      ? 'wait_run'
      : succeeded
        ? 'consume_assistantText'
        : failed
          ? 'inspect_error'
          : 'get_run_summary',
    consumeAssistantTextBeforeClosing: succeeded,
  }
}

export function withHostPollContract<T extends { readonly status: RunStatus }>(
  snapshot: T,
): T & { readonly hostPollContract: HostPollContract } {
  return {
    ...snapshot,
    hostPollContract: hostPollContract(snapshot.status),
  }
}
