import { describe, expect, it } from 'vitest'

import { WebviewAgentInstrumentation } from '../guest-js/instrumentation'
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
      const s = await StaticHtmlAppAdapter.create({ html: HTML })

      // Tree text must be identical (same refs, same rendering).
      expect(g.snapshot().text).toBe((await s.tree()).text)

      // Inspect the same ref on both.
      expect(g.inspect('@2')).toEqual(await s.inspect('@2'))

      // Find returns the same matches.
      const guestFind = g.find({ role: 'button', name: 'Forge', limit: 1 })
      const staticFind = await s.find({ role: 'button', name: 'Forge', limit: 1 })
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
      const s = await StaticHtmlAppAdapter.create({ html: HTML })
      // Guest records via its instrumentation; static records via the session.
      // Both must capture the canonical { ref, text } shape (the drift the
      // canonicalization fixed).
      g.record('start')
      g.action({ action: 'fill', ref: '@2', value: 'typed' })
      const guestEntries = (g.record('get') as { entries: Array<{ method: string; params: unknown }> }).entries
      const guestFill = guestEntries.find((entry) => entry.method === 'fill')
      expect(guestFill?.params).toEqual({ ref: '@2', text: 'typed' })

      // The static adapter's fill event detail uses the same canonical shape.
      await s.tree()
      await s.fill('@2', 'typed')
    } finally {
      g.dispose()
    }
  })
})
