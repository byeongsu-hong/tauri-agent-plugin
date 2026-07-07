import { describe, expect, it } from 'vitest'

import { SemanticStream } from '../guest-js/semantic-stream'

describe('SemanticStream', () => {
  it('emits mutation-driven diff frames against a monotonic cursor', () => {
    let text = 'a\nb'
    const stream = new SemanticStream({ capture: () => text })

    // The baseline pull carries the full snapshot and no frames yet.
    const base = stream.pull()
    expect(base).toEqual({ frames: [], cursor: 0, snapshot: 'a\nb', dropped: false })

    text = 'a\nc'
    stream.tick()
    const first = stream.pull(0)
    expect(first.cursor).toBe(1)
    expect(first.snapshot).toBe('a\nc')
    expect(first.frames).toEqual([{ seq: 1, added: ['c'], removed: ['b'] }])

    // No change means no new frame.
    stream.tick()
    expect(stream.pull(1).frames).toEqual([])

    text = 'a\nc\nd'
    stream.tick()
    expect(stream.pull(1).frames).toEqual([{ seq: 2, added: ['d'], removed: [] }])
    // Consuming from the latest cursor yields nothing.
    expect(stream.pull(2).frames).toEqual([])
  })

  it('reports dropped when the requested cursor fell out of the ring buffer', () => {
    let n = 0
    const stream = new SemanticStream({ capture: () => String(n), bufferSize: 2 })
    stream.pull() // prime baseline at "0"

    for (let i = 1; i <= 5; i++) {
      n = i
      stream.tick()
    }

    // Buffer only holds the last 2 frames (seq 4, 5). Asking from an old cursor
    // signals a gap so the consumer resyncs from snapshot.
    const stale = stream.pull(1)
    expect(stale.dropped).toBe(true)
    expect(stale.snapshot).toBe('5')

    // Asking from a still-buffered cursor is not dropped.
    expect(stream.pull(4).dropped).toBe(false)
    expect(stream.pull(4).frames).toEqual([{ seq: 5, added: ['5'], removed: ['4'] }])
  })

  it('long-polls until the next mutation-driven frame', async () => {
    let text = 'x'
    const stream = new SemanticStream({ capture: () => text })
    stream.pull()

    const pending = stream.wait(0, 1000)
    // A mutation happens after the waiter is registered.
    text = 'y'
    stream.tick()

    const result = await pending
    expect(result.frames).toEqual([{ seq: 1, added: ['y'], removed: ['x'] }])
  })

  it('resolves an empty long-poll when the timeout elapses first', async () => {
    const stream = new SemanticStream({ capture: () => 'still' })
    stream.pull()
    const result = await stream.wait(0, 5)
    expect(result.frames).toEqual([])
    expect(result.cursor).toBe(0)
  })
})
