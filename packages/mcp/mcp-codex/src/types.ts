/** Public snapshots and branded identifiers for the Codex MCP supervisor. */

import type { Branded } from '@deepseek-ai/dsh-brand'
import type { MessageId } from '@deepseek-ai/dsh-llm/brand'

/** MCP-process-local service identifier. */
export type ServiceId = Branded<'CodexServiceId'>

/** MCP-process-local run identifier. */
export type RunId = Branded<'CodexRunId'>

/** Lifecycle state for one submitted task. */
export type RunStatus = 'running' | 'succeeded' | 'failed' | 'cancelled'

/** Lifecycle state for one managed Harness Web service. */
export type ServiceStatus = 'starting' | 'running' | 'stopped' | 'failed'

/** One retained tool-activity entry in a run snapshot. */
export type ToolActivity =
  | {
    kind: 'call'
    callId: string
    name: string
    /** Raw model-produced JSON arguments; the retained tail when truncated. */
    arguments: string
    truncated: boolean
  }
  | {
    kind: 'result'
    callId: string
    /** Joined text blocks of the model-facing result; the retained tail when truncated. */
    summary: string
    /** Internal failure identity (`name: code`) when the tool reported one. */
    error: string | null
    truncated: boolean
  }

/** Public state of one managed Harness Web service. */
export interface ServiceSnapshot {
  serviceId: ServiceId
  workspace: string
  status: ServiceStatus
  webUrl: string | null
  browserOpened: boolean
  browserError: string | null
  startedAt: string
  stoppedAt: string | null
  processId: number | null
  logTail: string
}

/** Public state of one task submitted into a visible Web session. */
export interface RunSnapshot {
  runId: RunId
  serviceId: ServiceId
  sessionId: string
  sessionReused: boolean
  task: string
  workspace: string
  webUrl: string
  status: RunStatus
  cancelRequested: boolean
  startedAt: string
  finishedAt: string | null
  assistantText: string
  assistantTextBytes: number
  assistantTextTruncated: boolean
  /** Most recent bounded tool calls and results in the run's owned suffix, in log order. */
  lastToolEvents: ToolActivity[]
  lastEventSeq: number
  error: string | null
}

/** Inputs for a visible Harness task. */
export interface StartRunInput {
  task: string
  workspace: string
  sessionId?: string
  openBrowser?: boolean
}

/** Result of inserting a correction into an active run. */
export interface SteerRunResult {
  accepted: true
  messageId: MessageId
  run: RunSnapshot
}

/** Inputs for starting or reusing a Harness Web service. */
export interface StartServiceInput {
  workspace: string
  openBrowser?: boolean
}
