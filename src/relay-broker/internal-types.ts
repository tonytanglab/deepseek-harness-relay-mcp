import type { RpcEvent, RunSnapshot } from '../types.js'

export interface RunRecord {
  snapshot: RunSnapshot
  baselineSeq: number
  promptRpcId: string
  events: RpcEvent[]
  /** Last Host projection sequence seen in this process; not persisted as event truth. */
  lastObservedProjectionSeq?: number
}
