import { describe, expect, it } from 'vitest'

import { DebuggerSession } from '../daemon/session'
import { StaticHtmlAppAdapter } from '../daemon/static-app'
import type { StreamResult } from '../protocol/types'

const html = `
  <main aria-label="Ducktape">
    <button>Forge</button>
    <label>Agent name <input aria-label="Agent name" value="" /></label>
    <select aria-label="Worker">
      <option value="local">Local worker</option>
      <option value="remote">Remote worker</option>
    </select>
    <label><input type="checkbox" aria-label="Notify" /> Notify</label>
    <ul aria-label="Roster"><li>local-worker</li></ul>
    <button type="button">Drop zone</button>
    <p>Registered worker-a</p>
  </main>
`

describe('DebuggerSession', () => {
  it('attaches, inspects windows, snapshots trees, performs actions, and records activity', async () => {
    const adapter = await StaticHtmlAppAdapter.create({ html, title: 'Ducktape' })
    adapter.addLog('info', 'booted')
    const session = new DebuggerSession(adapter)

    await expect(session.execute('attach', {})).resolves.toEqual({
      attached: true,
      protocolVersion: 2,
      sessionId: expect.any(String),
      platform: expect.stringMatching(/^(linux|macos|windows|unknown)$/),
      runtime: 'unknown',
      methods: expect.arrayContaining(['attach', 'act', 'stream', 'ipc']),
      features: ['locator-action', 'lean-stream', 'capture-cursors', 'correlated-details'],
      screenshotBackends: expect.arrayContaining(['dom']),
      windows: [staticWindowInfo('Ducktape')]
    })
    await expect(session.execute('windows', {})).resolves.toEqual([
      staticWindowInfo('Ducktape')
    ])
    await expect(session.execute('tree', { window: 'main' })).resolves.toEqual({
      text: [
        'main "Ducktape"',
        '@1 button "Forge"',
        '@2 textbox "Agent name" empty',
        '@3 combobox "Worker"',
        '  @4 option "Local worker" selected',
        '  @5 option "Remote worker"',
        '@6 checkbox "Notify"',
        '@7 list "Roster" 1',
        '@8 button "Drop zone"'
      ].join('\n')
    })
    await expect(session.execute('find', { role: 'button', name: 'forge', limit: 1 })).resolves.toEqual({
      matches: [
        expect.objectContaining({
          ref: '@1',
          role: 'button',
          name: 'Forge',
          tagName: 'button',
          text: 'Forge'
        })
      ]
    })
    await expect(session.execute('inspect', { ref: '@2' })).resolves.toEqual({
      ref: '@2',
      role: 'textbox',
      name: 'Agent name',
      tagName: 'input',
      text: '',
      value: '',
      attributes: {
        'aria-label': 'Agent name',
        value: ''
      },
      states: ['empty']
    })

    await expect(session.execute('record', { action: 'start' })).resolves.toEqual({ recording: true })
    await expect(session.execute('act', {
      role: 'textbox', name: 'Agent name', action: 'fill', value: 'fleet', timeoutMs: 100
    })).resolves.toEqual(expect.objectContaining({ ok: true, traceId: expect.any(String) }))
    await expect(session.execute('click', { ref: '@1' })).resolves.toEqual({ ok: true })
    await expect(session.execute('hover', { ref: '@1' })).resolves.toEqual({ ok: true })
    await expect(session.execute('focus', { ref: '@2' })).resolves.toEqual({ ok: true })
    await expect(session.execute('blur', { ref: '@2' })).resolves.toEqual({ ok: true })
    await expect(session.execute('scroll', { ref: '@7', y: 12, x: 3 })).resolves.toEqual({ ok: true })
    await expect(session.execute('drag', { ref: '@1', toRef: '@8' })).resolves.toEqual({ ok: true })
    await expect(session.execute('fill', { ref: '@2', text: 'worker-a' })).resolves.toEqual({ ok: true })
    await expect(session.execute('select', { ref: '@3', value: 'remote' })).resolves.toEqual({ ok: true })
    await expect(session.execute('check', { ref: '@6', checked: true })).resolves.toEqual({ ok: true })
    await expect(
      session.execute('eval', { code: 'document.querySelector("input")?.value' })
    ).resolves.toEqual({
      type: 'string',
      value: 'worker-a',
      text: 'worker-a'
    })
    await session.execute('eval', {
      code: 'document.querySelector("input")?.addEventListener("keydown", (event) => { window.__lastShortcut = `${event.key}:${event.metaKey}:${event.shiftKey}:${document.activeElement?.getAttribute("aria-label")}` })'
    })
    await expect(session.execute('press', { key: 'Enter' })).resolves.toEqual({ ok: true })
    await expect(session.execute('press', { key: 'k', ref: '@2', modifiers: ['Meta', 'Shift'] })).resolves.toEqual({ ok: true })
    await expect(session.execute('eval', { code: 'window.__lastShortcut' })).resolves.toEqual({
      type: 'string',
      value: 'k:true:true:Agent name',
      text: 'k:true:true:Agent name'
    })

    await expect(session.execute('state', {})).resolves.toEqual({
      url: 'tauri-agent://static',
      title: 'Ducktape',
      values: {
        'Agent name': 'worker-a',
        Notify: true,
        Worker: 'remote'
      }
    })
    await expect(session.execute('state', { key: 'values' })).resolves.toEqual({
      'Agent name': 'worker-a',
      Notify: true,
      Worker: 'remote'
    })
    await expect(session.execute('state', { key: 'missing' })).resolves.toBeNull()
    await expect(session.execute('wait', { text: 'Registered worker-a', timeoutMs: 1 })).resolves.toEqual({
      matched: true,
      text: 'Registered worker-a'
    })
    await expect(session.execute('wait', { role: 'button', name: 'Forge', timeoutMs: 1 })).resolves.toEqual({
      matched: true,
      text: 'Forge',
      match: expect.objectContaining({
        ref: '@1',
        role: 'button',
        name: 'Forge',
        tagName: 'button',
        text: 'Forge'
      })
    })
    await expect(session.execute('logs', {})).resolves.toMatchObject({
      entries: [{ level: 'info', message: 'booted', window: 'main' }]
    })
    await expect(session.execute('logs', { clear: true })).resolves.toMatchObject({
      entries: [{ level: 'info', message: 'booted', window: 'main' }]
    })
    await expect(session.execute('logs', {})).resolves.toMatchObject({ entries: [] })
    await expect(session.execute('network', {})).resolves.toMatchObject({ entries: [] })
    await expect(
      session.execute('storage', { action: 'set', key: 'agent.token', value: 'ready' })
    ).resolves.toEqual({
      area: 'local',
      entries: [{ area: 'local', key: 'agent.token', value: 'ready' }]
    })
    await expect(session.execute('storage', { key: 'agent.token' })).resolves.toEqual({
      area: 'local',
      entries: [{ area: 'local', key: 'agent.token', value: 'ready' }]
    })
    await expect(session.execute('eval', { code: 'localStorage.getItem("agent.token")' })).resolves.toEqual({
      type: 'string',
      value: 'ready',
      text: 'ready'
    })
    await expect(
      session.execute('eval', { code: 'sessionStorage.setItem("agent.eval", "seen"); sessionStorage.getItem("agent.eval")' })
    ).resolves.toEqual({
      type: 'string',
      value: 'seen',
      text: 'seen'
    })
    await expect(session.execute('storage', { area: 'session', key: 'agent.eval' })).resolves.toEqual({
      area: 'session',
      entries: [{ area: 'session', key: 'agent.eval', value: 'seen' }]
    })
    await expect(
      session.execute('storage', { area: 'session', action: 'set', key: 'agent.route', value: '/agents' })
    ).resolves.toEqual({
      area: 'session',
      entries: [{ area: 'session', key: 'agent.route', value: '/agents' }]
    })
    await expect(session.execute('storage', { action: 'remove', key: 'agent.token' })).resolves.toEqual({
      area: 'local',
      entries: []
    })
    await expect(
      session.execute('cookies', { action: 'set', name: 'agent.cookie', value: 'ready' })
    ).resolves.toEqual({
      entries: [{ name: 'agent.cookie', value: 'ready' }]
    })
    await expect(session.execute('cookies', { name: 'agent.cookie' })).resolves.toEqual({
      entries: [{ name: 'agent.cookie', value: 'ready' }]
    })
    await expect(session.execute('eval', { code: 'document.cookie.includes("agent.cookie=ready")' })).resolves.toEqual({
      type: 'boolean',
      value: true,
      text: 'true'
    })
    await expect(
      session.execute('eval', { code: 'document.cookie = "agent.eval=seen; path=/"; document.cookie' })
    ).resolves.toEqual({
      type: 'string',
      value: expect.stringContaining('agent.eval=seen'),
      text: expect.stringContaining('agent.eval=seen')
    })
    await expect(session.execute('cookies', { name: 'agent.eval' })).resolves.toEqual({
      entries: [{ name: 'agent.eval', value: 'seen' }]
    })
    await expect(session.execute('cookies', { action: 'remove', name: 'agent.cookie' })).resolves.toEqual({ entries: [] })
    await expect(session.execute('cookies', {})).resolves.toEqual({
      entries: [{ name: 'agent.eval', value: 'seen' }]
    })
    await expect(session.execute('cookies', { action: 'clear' })).resolves.toEqual({ entries: [] })
    await expect(session.execute('location', {})).resolves.toEqual({
      href: 'tauri-agent://static',
      origin: 'null',
      pathname: '',
      search: '',
      hash: ''
    })
    await expect(session.execute('location', { action: 'push', url: '/agents?view=debug#roster' })).resolves.toEqual({
      href: 'tauri-agent://static/agents?view=debug#roster',
      origin: 'null',
      pathname: '/agents',
      search: '?view=debug',
      hash: '#roster'
    })
    await expect(session.execute('location', { action: 'replace', url: '/status' })).resolves.toEqual({
      href: 'tauri-agent://static/status',
      origin: 'null',
      pathname: '/status',
      search: '',
      hash: ''
    })
    await expect(session.execute('events', {})).resolves.toEqual(
      expect.objectContaining({ entries: expect.arrayContaining([
        expect.objectContaining({ kind: 'attach', window: 'main' }),
        expect.objectContaining({ kind: 'click', detail: { ref: '@1' } }),
        expect.objectContaining({ kind: 'hover', detail: { ref: '@1' } }),
        expect.objectContaining({ kind: 'focus', detail: { ref: '@2' } }),
        expect.objectContaining({ kind: 'blur', detail: { ref: '@2' } }),
        expect.objectContaining({ kind: 'scroll', detail: { ref: '@7', y: 12, x: 3 } }),
        expect.objectContaining({ kind: 'drag', detail: { ref: '@1', toRef: '@8' } }),
        expect.objectContaining({ kind: 'fill', detail: { ref: '@2', text: 'worker-a' } }),
        expect.objectContaining({ kind: 'press', detail: { key: 'Enter' } }),
        expect.objectContaining({ kind: 'press', detail: { key: 'k', ref: '@2', modifiers: ['Meta', 'Shift'] } })
      ]) })
    )
    await expect(session.execute('events', { clear: true })).resolves.toEqual(
      expect.objectContaining({ entries: expect.arrayContaining([
        expect.objectContaining({ kind: 'attach', window: 'main' }),
        expect.objectContaining({ kind: 'click', detail: { ref: '@1' } })
      ]) })
    )
    await expect(session.execute('events', {})).resolves.toMatchObject({ entries: [] })
    await expect(session.execute('record', { action: 'get' })).resolves.toEqual({
      recording: true,
      entries: [
        expect.objectContaining({ method: 'act', params: { role: 'textbox', name: 'Agent name', action: 'fill', value: 'fleet', timeoutMs: 100 } }),
        expect.objectContaining({ method: 'click', params: { ref: '@1' } }),
        expect.objectContaining({ method: 'hover', params: { ref: '@1' } }),
        expect.objectContaining({ method: 'focus', params: { ref: '@2' } }),
        expect.objectContaining({ method: 'blur', params: { ref: '@2' } }),
        expect.objectContaining({ method: 'scroll', params: { ref: '@7', y: 12, x: 3 } }),
        expect.objectContaining({ method: 'drag', params: { ref: '@1', toRef: '@8' } }),
        expect.objectContaining({ method: 'fill', params: { ref: '@2', text: 'worker-a' } }),
        expect.objectContaining({ method: 'select', params: { ref: '@3', value: 'remote' } }),
        expect.objectContaining({ method: 'check', params: { ref: '@6', checked: true } }),
        expect.objectContaining({ method: 'press', params: { key: 'Enter' } }),
        expect.objectContaining({ method: 'press', params: { key: 'k', ref: '@2', modifiers: ['Meta', 'Shift'] } })
      ]
    })
  })

  it('reports stale refs and missing wait text clearly', async () => {
    const session = new DebuggerSession(await StaticHtmlAppAdapter.create({ html, title: 'Ducktape' }))

    await session.execute('tree', {})

    await expect(session.execute('click', { ref: '@9' })).rejects.toThrow('stale ref @9; run tree again')
    await expect(session.execute('wait', { text: 'Never appears', timeoutMs: 1 })).rejects.toThrow(
      'wait timed out for text: Never appears'
    )
  })

  it('controls static window state and bounds', async () => {
    const session = new DebuggerSession(await StaticHtmlAppAdapter.create({ html, title: 'Ducktape' }))

    await expect(session.execute('window', { action: 'setSize', width: 800, height: 600 })).resolves.toEqual({
      ...staticWindowInfo('Ducktape'),
      innerBounds: { x: 0, y: 0, width: 800, height: 600 },
      outerBounds: { x: 0, y: 0, width: 800, height: 600 }
    })
    await expect(session.execute('window', { action: 'setPosition', x: 20, y: 30 })).resolves.toMatchObject({
      innerBounds: { x: 20, y: 30, width: 800, height: 600 },
      outerBounds: { x: 20, y: 30, width: 800, height: 600 }
    })
    await expect(session.execute('window', { action: 'hide' })).resolves.toMatchObject({ visible: false })
    await expect(session.execute('window', { action: 'show' })).resolves.toMatchObject({ visible: true })
    await expect(session.execute('window', { action: 'minimize' })).resolves.toMatchObject({ minimized: true })
    await expect(session.execute('window', { action: 'unminimize' })).resolves.toMatchObject({ minimized: false })
    await expect(session.execute('window', { action: 'maximize' })).resolves.toMatchObject({ maximized: true })
    await expect(session.execute('window', { action: 'unmaximize' })).resolves.toMatchObject({ maximized: false })
    await expect(session.execute('window', { action: 'focus' })).resolves.toMatchObject({ focused: true })
    await expect(session.execute('window', { action: 'teleport' })).rejects.toThrow('unknown window action: teleport')
  })

  it('removes path-scoped cookies visible on the current route', async () => {
    const session = new DebuggerSession(
      await StaticHtmlAppAdapter.create({
        html: '<main aria-label="Cookies"></main>',
        url: 'https://app.test/agents/list'
      })
    )

    await session.execute('eval', {
      code: [
        'document.cookie = "agent.path=seen; path=/agents"',
        'document.cookie = "agent.deep=ready; path=/agents/list"',
        'document.cookie'
      ].join('; ')
    })

    await expect(session.execute('cookies', {})).resolves.toEqual({
      entries: [
        { name: 'agent.deep', value: 'ready' },
        { name: 'agent.path', value: 'seen' }
      ]
    })
    await expect(session.execute('cookies', { action: 'remove', name: 'agent.path' })).resolves.toEqual({
      entries: []
    })
    await expect(session.execute('cookies', {})).resolves.toEqual({
      entries: [{ name: 'agent.deep', value: 'ready' }]
    })
    await expect(session.execute('cookies', { action: 'clear' })).resolves.toEqual({ entries: [] })
  })

  it('captures static runtime errors and unhandled rejections as logs', async () => {
    const session = new DebuggerSession(await StaticHtmlAppAdapter.create({ html, title: 'Ducktape' }))

    await session.execute('eval', {
      code: [
        'const suppressHarnessUnhandled = (event) => event.stopImmediatePropagation()',
        'window.addEventListener("error", suppressHarnessUnhandled, { capture: true })',
        'window.addEventListener("unhandledrejection", suppressHarnessUnhandled, { capture: true })',
        'const runtimeError = new Event("error", { cancelable: true })',
        'Object.defineProperties(runtimeError, { message: { value: "static boom" }, error: { value: { message: "static boom", stack: "Error: static boom" } } })',
        'runtimeError.preventDefault()',
        'window.dispatchEvent(runtimeError)',
        'const rejection = new Event("unhandledrejection")',
        'Object.defineProperty(rejection, "reason", { value: { message: "static promise boom", stack: "eval code@\\nrunCallback@user-script" } })',
        'window.dispatchEvent(rejection)',
        'const objectRejection = new Event("unhandledrejection")',
        'Object.defineProperty(objectRejection, "reason", { value: { code: "E_STATIC_RUNTIME" } })',
        'window.dispatchEvent(objectRejection)',
        'window.removeEventListener("error", suppressHarnessUnhandled, { capture: true })',
        'window.removeEventListener("unhandledrejection", suppressHarnessUnhandled, { capture: true })',
        '"ok"'
      ].join('; ')
    })

    await expect(session.execute('logs', {})).resolves.toMatchObject({ entries: [
      expect.objectContaining({ level: 'error', message: expect.stringContaining('static boom'), window: 'main' }),
      expect.objectContaining({ level: 'error', message: expect.stringContaining('static promise boom'), window: 'main' }),
      expect.objectContaining({ level: 'error', message: expect.stringContaining('E_STATIC_RUNTIME'), window: 'main' })
    ] })
    await expect(session.execute('logs', { clear: true })).resolves.toMatchObject({ entries: expect.any(Array) })
    await expect(session.execute('logs', {})).resolves.toMatchObject({ entries: [] })
  })

  it('asserts semantic targets with expect', async () => {
    const session = new DebuggerSession(
      await StaticHtmlAppAdapter.create({
        html: '<main aria-label="Scene"><button disabled>Save</button><input aria-label="Name" value="ada" /></main>'
      })
    )

    await expect(
      session.execute('expect', { role: 'button', name: 'Save', hasState: 'disabled' })
    ).resolves.toMatchObject({ ok: true })
    await expect(
      session.execute('expect', { role: 'textbox', name: 'Name', value: 'ada' })
    ).resolves.toMatchObject({ ok: true })
    await expect(
      session.execute('expect', { role: 'button', name: 'Delete', present: false })
    ).resolves.toEqual({ ok: true })

    await expect(
      session.execute('expect', { role: 'textbox', name: 'Name', value: 'bob' })
    ).rejects.toThrow(/value/)
    await expect(
      session.execute('expect', { role: 'button', name: 'Save', hasState: 'checked' })
    ).rejects.toThrow(/missing state/)
    await expect(session.execute('expect', { role: 'button', name: 'Delete' })).rejects.toThrow(
      /no element matched/
    )
  })

  it('waits for text and semantic targets to disappear with state=absent', async () => {
    const adapter = await StaticHtmlAppAdapter.create({
      html: '<main aria-label="Scene"><p>Loading</p><button>Cancel</button></main>'
    })
    const session = new DebuggerSession(adapter)

    // Already-absent resolves immediately.
    await expect(
      session.execute('wait', { text: 'Ready', state: 'absent', timeoutMs: 50 })
    ).resolves.toEqual({ matched: true, text: 'Ready' })

    // Still-present times out.
    await expect(
      session.execute('wait', { text: 'Loading', state: 'absent', timeoutMs: 30 })
    ).rejects.toThrow(/still present/)

    // A semantic target that is gone resolves.
    await expect(
      session.execute('wait', { role: 'button', name: 'Save', state: 'absent', timeoutMs: 50 })
    ).resolves.toEqual({ matched: true, text: '' })
  })

  it('accepts reload, back, and forward navigation actions', async () => {
    const session = new DebuggerSession(await StaticHtmlAppAdapter.create({ html: '<main></main>' }))
    for (const action of ['reload', 'back', 'forward'] as const) {
      await expect(session.execute('location', { action })).resolves.toMatchObject({
        href: expect.any(String)
      })
    }
  })

  it('types text into a ref character by character', async () => {
    const session = new DebuggerSession(
      await StaticHtmlAppAdapter.create({
        html: '<main aria-label="Scene"><input aria-label="Name" value="" /></main>'
      })
    )
    let keydowns = 0
    // The adapter dispatches per-key events, observable from the page.
    const doc = (session as unknown as { app: { dom: { window: { document: Document } } } }).app.dom
      .window.document
    doc.querySelector('input')?.addEventListener('keydown', () => {
      keydowns += 1
    })

    await session.execute('tree', {})
    await expect(session.execute('type', { ref: '@1', text: 'abc' })).resolves.toEqual({ ok: true })

    expect(keydowns).toBe(3)
    await expect(session.execute('state', { key: 'values' })).resolves.toEqual({ Name: 'abc' })
  })

  it('streams mutation-driven semantic-tree diffs against a cursor', async () => {
    const session = new DebuggerSession(
      await StaticHtmlAppAdapter.create({ html: '<main aria-label="Scene"><button>One</button></main>' })
    )

    const base = (await session.execute('stream', { lean: true })) as StreamResult
    expect(base.frames).toEqual([])
    expect(base.snapshot).toContain('button "One"')

    // Mutate the DOM; the MutationObserver drives a diff frame, which the
    // long-poll resolves without any polling interval.
    await session.execute('eval', {
      code: "document.querySelector('main').appendChild(Object.assign(document.createElement('button'), { textContent: 'Two' }))"
    })
    const next = (await session.execute('stream', {
      since: base.cursor,
      timeoutMs: 1000,
      lean: true
    })) as StreamResult

    expect(next.cursor).toBeGreaterThan(base.cursor)
    expect(next.dropped).toBe(false)
    expect(next.frames.flatMap((frame) => frame.added).join('\n')).toContain('button "Two"')
    expect(next.snapshot).toBeUndefined()
  })

  it('returns cursor capture results without skipping limited entries', async () => {
    const adapter = await StaticHtmlAppAdapter.create({ html: '<main></main>' })
    adapter.addLog('info', 'one')
    adapter.addLog('info', 'two')
    const session = new DebuggerSession(adapter)

    const first = await session.execute('logs', { since: 0, limit: 1 })
    expect(first).toMatchObject({ entries: [expect.objectContaining({ message: 'one' })], cursor: 1, dropped: false })
    await session.execute('logs', { clear: true })
    adapter.addLog('info', 'three')
    await expect(session.execute('logs', { since: 1 })).resolves.toMatchObject({
      entries: [expect.objectContaining({ message: 'three' })],
      cursor: 3,
      dropped: true
    })
  })
})

function staticWindowInfo(title: string): Record<string, unknown> {
  return {
    label: 'main',
    title,
    focused: true,
    visible: true,
    minimized: false,
    maximized: false,
    scaleFactor: 1,
    innerBounds: { x: 0, y: 0, width: 1024, height: 768 },
    outerBounds: { x: 0, y: 0, width: 1024, height: 768 }
  }
}
