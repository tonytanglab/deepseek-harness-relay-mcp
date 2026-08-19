import type { RpcEvent, RunSnapshot } from '../types.js'

export interface RunRecord {
  snapshot: RunSnapshot
  baselineSeq: number
  promptRpcId: string
  events: RpcEvent[]
}
