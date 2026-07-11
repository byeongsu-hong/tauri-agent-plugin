import type { CaptureParams, CaptureResult } from '../protocol/types'
import { AgentProtocolError } from '../protocol/error'

interface Buffered<T> {
  seq: number
  value: T
}

/** Bounded monotonic buffer shared by logs, events, network, and IPC. */
export class CaptureBuffer<T> {
  private entries: Buffered<T>[] = []
  private seq = 0

  constructor(private readonly capacity = 500) {}

  push(value: T): void {
    this.entries.push({ seq: ++this.seq, value })
    if (this.entries.length > this.capacity) this.entries.shift()
  }

  read(params: CaptureParams = {}): T[] | CaptureResult<T> {
    if (params.since !== undefined && (!Number.isSafeInteger(params.since) || params.since < 0)) {
      throw new AgentProtocolError('INVALID_PARAMS', 'since must be a non-negative integer')
    }
    if (params.limit !== undefined && (!Number.isSafeInteger(params.limit) || params.limit < 1)) {
      throw new AgentProtocolError('INVALID_PARAMS', 'limit must be a positive integer')
    }
    const cursorMode = params.since !== undefined || params.limit !== undefined
    const since = params.since ?? 0
    const available = this.entries.filter((entry) => entry.seq > since)
    const selected = params.limit === undefined ? available : available.slice(0, params.limit)
    const oldest = this.entries[0]?.seq ?? this.seq + 1
    const dropped = since < this.seq && since + 1 < oldest
    const cursor = selected.at(-1)?.seq ?? (available.length === 0 ? this.seq : since)
    const values = selected.map((entry) => entry.value)
    if (params.clear) this.entries = []
    return cursorMode ? { entries: values, cursor, dropped } : values
  }
}
