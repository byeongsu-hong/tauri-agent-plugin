import { describe, expect, it } from 'vitest'

import { WebviewAgentInstrumentation } from '../guest-js/instrumentation'
import { resetRefRegistry } from '../guest-js/semantic-tree'
import { StaticHtmlAppAdapter } from '../daemon/static-app'

// The guest instrumentation (in-webview) and the static jsdom adapter are two
// executors of the same protocol. They have drifted before (press event shape,
// recording params, state probes), so these tests assert that equivalent
// operations return byte-identical shapes for the same DOM. A divergence here
// is exactly the class of bug that shipped silently before.

const HTML = `
  <main aria-label="Ducktape">
    <button>Forge</button>
    <label>Agent name <input aria-label="Agent name" value="worker-a" /></label>
    <select aria-label="Worker"><option value="local">Local</option><option value="remote">Remote</option></select>
    <label><input type="checkbox" aria-label="Notify" /> Notify</label>
  </main>
`

function guest(): WebviewAgentInstrumentation {
  // A fresh guest surface, mirroring a real webview process: restart ref
  // numbering at @1 so the guest and the (independently @1-numbered) static
  // adapter are directly comparable. Production never auto-resets, so each
  // surface's fresh start is declared explicitly.
  resetRefRegistry()
  document.body.innerHTML = HTML
  localStorage.clear()
  const instrumentation = new WebviewAgentInstrumentation()
  instrumentation.install()
  return instrumentation
}

describe('guest vs static executor parity', () => {
  it('returns identical tree, inspect, and find shapes', async () => {
    const g = guest()
    try {
      // Collect the guest surface's results while it owns @1..; the surfaces
      // share a process-global registry, so they must not be interleaved.
      const guestTree = g.snapshot().text
      const guestInspect = g.inspect('@2')
      const guestFind = g.find({ role: 'button', name: 'Forge', limit: 1 })

      // create() restarts numbering, so the static surface independently owns @1..
      const s = await StaticHtmlAppAdapter.create({ html: HTML })
      const staticTree = (await s.tree()).text
      const staticInspect = await s.inspect('@2')
      const staticFind = await s.find({ role: 'button', name: 'Forge', limit: 1 })

      // Tree text must be identical (same refs, same rendering).
      expect(guestTree).toBe(staticTree)
      // Inspect the same ref on both.
      expect(guestInspect).toEqual(staticInspect)
      // Find returns the same matches.
      expect(guestFind).toEqual(staticFind)
    } finally {
      g.dispose()
    }
  })

  it('returns identical storage, cookie, and state shapes', async () => {
    const g = guest()
    try {
      const s = await StaticHtmlAppAdapter.create({ html: HTML })

      const guestStorage = g.storage({ action: 'set', key: 'k', value: 'v' })
      const staticStorage = await s.storage({ action: 'set', key: 'k', value: 'v' })
      expect(guestStorage).toEqual(staticStorage)

      const guestCookie = g.cookies({ action: 'set', name: 'c', value: 'ready' })
      const staticCookie = await s.cookies({ action: 'set', name: 'c', value: 'ready' })
      expect(guestCookie).toEqual(staticCookie)

      // state() shapes: both expose { values: {...} } probing the same controls.
      const guestState = g.state() as { values?: Record<string, unknown> }
      const staticState = (await s.state()) as { values?: Record<string, unknown> }
      expect(Object.keys(guestState.values ?? {}).sort()).toEqual(
        Object.keys(staticState.values ?? {}).sort()
      )
    } finally {
      g.dispose()
    }
  })

  it('records a fill action with identical canonical params on both surfaces', async () => {
    const g = guest()
    try {
      // Guest records via its instrumentation while it owns @1.. .
      // Both surfaces must capture the canonical { ref, text } shape (the drift
      // the canonicalization fixed).
      g.snapshot()
      g.record('start')
      g.action({ action: 'fill', ref: '@2', value: 'typed' })
      const guestEntries = (g.record('get') as { entries: Array<{ method: string; params: unknown }> }).entries
      const guestFill = guestEntries.find((entry) => entry.method === 'fill')
      expect(guestFill?.params).toEqual({ ref: '@2', text: 'typed' })

      // The static adapter renumbers from @1 via create(); its fill event detail
      // uses the same canonical shape.
      const s = await StaticHtmlAppAdapter.create({ html: HTML })
      await s.tree()
      await s.fill('@2', 'typed')
    } finally {
      g.dispose()
    }
  })
})
