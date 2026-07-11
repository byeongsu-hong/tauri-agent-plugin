import type { StreamFrame, StreamResult } from '../protocol/types'

export type { StreamFrame, StreamResult }

export interface SemanticStreamOptions {
  /** Returns the current compact semantic-tree text. */
  capture: () => string
  /** Maximum number of change frames retained in the ring buffer. */
  bufferSize?: number
}

const DEFAULT_BUFFER_SIZE = 256

interface Waiter {
  resolve: () => void
}

/**
 * A mutation-driven push stream of semantic-tree diffs. Capture is event-driven
 * (a `MutationObserver` calls {@link tick}); there is no polling loop. Each
 * change becomes a frame of added/removed compact-tree lines with a monotonic
 * `seq`, retained in a bounded ring buffer. Consumers drain frames with
 * {@link pull} (immediate) or {@link wait} (long-poll), advancing a cursor.
 */
export class SemanticStream {
  private readonly capture: () => string
  private readonly bufferSize: number
  private lastText = ''
  private lastLines: string[] = []
  private frames: StreamFrame[] = []
  private seq = 0
  private started = false
  private waiters: Waiter[] = []

  constructor(options: SemanticStreamOptions) {
    this.capture = options.capture
    this.bufferSize = Math.max(1, options.bufferSize ?? DEFAULT_BUFFER_SIZE)
  }

  /** Establish the baseline snapshot without emitting a frame. */
  prime(): void {
    this.lastText = this.capture()
    this.lastLines = splitLines(this.lastText)
    this.started = true
  }

  /** Recompute the snapshot and, if it changed, append a frame. */
  tick(): void {
    if (!this.started) {
      this.prime()
      return
    }
    const text = this.capture()
    if (text === this.lastText) {
      return
    }
    const nextLines = splitLines(text)
    const { added, removed } = diffLines(this.lastLines, nextLines)
    this.lastText = text
    this.lastLines = nextLines
    if (added.length === 0 && removed.length === 0) {
      return
    }
    this.frames.push({ seq: ++this.seq, added, removed })
    if (this.frames.length > this.bufferSize) {
      this.frames.shift()
    }
    this.wake()
  }

  /** Return buffered frames after `since` immediately. */
  pull(since: number | undefined = undefined, lean = false): StreamResult {
    if (!this.started) {
      this.prime()
    }
    const cursor = since ?? 0
    const frames = this.frames.filter((frame) => frame.seq > cursor)
    const oldestSeq = this.frames.length > 0 ? this.frames[0].seq : 0
    // A gap exists when frames between the cursor and the buffer were evicted.
    const dropped = cursor < this.seq && cursor + 1 < oldestSeq
    return {
      frames,
      cursor: this.seq,
      ...(!lean || since === undefined || dropped ? { snapshot: this.lastText } : {}),
      dropped
    }
  }

  /**
   * Wait up to `timeoutMs` for the next frame after `since`. Resolves
   * immediately if frames are already buffered or `timeoutMs <= 0`.
   */
  async wait(since: number | undefined = undefined, timeoutMs = 0, lean = false): Promise<StreamResult> {
    const immediate = this.pull(since, lean)
    if (immediate.frames.length > 0 || timeoutMs <= 0) {
      return immediate
    }
    await new Promise<void>((resolve) => {
      let settled = false
      const done = (): void => {
        if (settled) {
          return
        }
        settled = true
        clearTimeout(timer)
        this.waiters = this.waiters.filter((waiter) => waiter !== entry)
        resolve()
      }
      const timer = setTimeout(done, timeoutMs)
      const entry: Waiter = { resolve: done }
      this.waiters.push(entry)
    })
    return this.pull(since, lean)
  }

  private wake(): void {
    const pending = this.waiters
    this.waiters = []
    for (const waiter of pending) {
      waiter.resolve()
    }
  }
}

function splitLines(text: string): string[] {
  return text.length === 0 ? [] : text.split('\n')
}

/** Multiset line difference: lines present only in `next` / only in `prev`. */
function diffLines(prev: string[], next: string[]): { added: string[]; removed: string[] } {
  const counts = new Map<string, number>()
  for (const line of prev) {
    counts.set(line, (counts.get(line) ?? 0) + 1)
  }

  const added: string[] = []
  for (const line of next) {
    const remaining = counts.get(line) ?? 0
    if (remaining > 0) {
      counts.set(line, remaining - 1)
    } else {
      added.push(line)
    }
  }

  const removed: string[] = []
  for (const [line, remaining] of counts) {
    for (let i = 0; i < remaining; i++) {
      removed.push(line)
    }
  }

  return { added, removed }
}
