import { describe, expect, it } from 'vitest'

import { WebviewAgentInstrumentation } from '../guest-js/instrumentation'

describe('WebviewAgentInstrumentation', () => {
  it('captures trees, actions, logs, events, state probes, waits, and recordings', async () => {
    const originalHref = window.location.href
    localStorage.clear()
    sessionStorage.clear()
    document.body.innerHTML = `
      <main aria-label="Ducktape">
        <button>Forge</button>
        <input aria-label="Agent name" />
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

    const instrumentation = new WebviewAgentInstrumentation({
      state: {
        route: () => '/agents'
      }
    })
    const originalFetch = window.fetch
    window.fetch = async () =>
      new Response('{"ok":true}', {
        status: 201,
        headers: { 'content-type': 'application/json' }
      })
    document.querySelector('input')?.addEventListener('keydown', (event) => {
      ;(window as typeof window & { __lastShortcut?: string }).__lastShortcut =
        `${event.key}:${event.metaKey}:${event.shiftKey}:${document.activeElement?.getAttribute('aria-label')}`
    })
    instrumentation.install()

    console.info('booted')
    const fetchResponse = await window.fetch('/api/agents', { method: 'POST', body: 'worker-a' })
    await window.fetch('ipc://localhost/plugin%3Aagent%7Cagent_bridge_response', { method: 'POST', body: '{}' })
    const tree = instrumentation.snapshot()
    instrumentation.record('start')
    instrumentation.action({ action: 'click', ref: '@1' })
    instrumentation.hover('@1')
    instrumentation.focus('@2')
    instrumentation.blur('@2')
    instrumentation.scroll('@7', { y: 12, x: 3 })
    instrumentation.drag('@1', { toRef: '@8' })
    instrumentation.action({ action: 'fill', ref: '@2', value: 'worker-a' })
    instrumentation.select('@3', 'remote')
    instrumentation.check('@6', true)
    instrumentation.action({ action: 'press', value: 'Enter', ref: '@2', modifiers: ['Meta', 'Shift'] })

    await expect(instrumentation.wait({ text: 'Registered worker-a', timeoutMs: 1 })).resolves.toEqual({
      matched: true,
      text: 'Registered worker-a'
    })
    await expect(instrumentation.wait({ role: 'button', name: 'Forge', timeoutMs: 1 })).resolves.toEqual({
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

    expect(fetchResponse.status).toBe(201)
    expect(instrumentation.network()).toEqual([
      expect.objectContaining({
        id: expect.any(String),
        type: 'fetch',
        method: 'POST',
        url: expect.stringContaining('/api/agents'),
        status: 201,
        ok: true,
        startedAt: expect.any(String),
        endedAt: expect.any(String),
        durationMs: expect.any(Number),
        requestBodySize: 8,
        responseBodySize: 11
      })
    ])
    expect(instrumentation.network({ clear: true })).toHaveLength(1)
    expect(instrumentation.network()).toEqual([])
    expect(tree.text).toBe(
      [
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
    )
    expect(instrumentation.find({ role: 'button', name: 'forge', limit: 1 })).toEqual({
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
    expect(instrumentation.inspect('@2')).toEqual({
      ref: '@2',
      role: 'textbox',
      name: 'Agent name',
      tagName: 'input',
      text: '',
      value: 'worker-a',
      attributes: {
        'aria-label': 'Agent name'
      },
      states: ['focused']
    })
    expect(instrumentation.logs()).toEqual([
      expect.objectContaining({ level: 'info', message: 'booted' })
    ])
    expect(instrumentation.logs({ clear: true })).toEqual([
      expect.objectContaining({ level: 'info', message: 'booted' })
    ])
    expect(instrumentation.logs()).toEqual([])
    expect(instrumentation.events()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'click', detail: { ref: '@1' } }),
        expect.objectContaining({ kind: 'hover', detail: { ref: '@1' } }),
        expect.objectContaining({ kind: 'focus', detail: { ref: '@2' } }),
        expect.objectContaining({ kind: 'blur', detail: { ref: '@2' } }),
        expect.objectContaining({ kind: 'scroll', detail: { ref: '@7', y: 12, x: 3 } }),
        expect.objectContaining({ kind: 'drag', detail: { ref: '@1', toRef: '@8' } }),
        expect.objectContaining({ kind: 'fill', detail: { ref: '@2', value: 'worker-a' } }),
        expect.objectContaining({ kind: 'press', detail: { value: 'Enter', ref: '@2', modifiers: ['Meta', 'Shift'] } }),
        expect.objectContaining({ kind: 'wait', detail: { text: 'Registered worker-a' } })
      ])
    )
    expect(instrumentation.events({ clear: true })).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'click', detail: { ref: '@1' } }),
        expect.objectContaining({ kind: 'hover', detail: { ref: '@1' } })
      ])
    )
    expect(instrumentation.events()).toEqual([])
    expect(instrumentation.state()).toEqual({
      url: window.location.href,
      title: '',
      values: {
        'Agent name': 'worker-a',
        Notify: true,
        Worker: 'remote'
      },
      probes: {
        route: '/agents'
      }
    })
    expect(instrumentation.state('values')).toEqual({
      'Agent name': 'worker-a',
      Notify: true,
      Worker: 'remote'
    })
    expect(instrumentation.state('missing')).toBeNull()
    expect(instrumentation.evaluate('document.querySelector("input")?.value')).toEqual({
      type: 'string',
      value: 'worker-a',
      text: 'worker-a'
    })
    expect(instrumentation.storage({ action: 'set', key: 'agent.token', value: 'ready' })).toEqual({
      area: 'local',
      entries: [{ area: 'local', key: 'agent.token', value: 'ready' }]
    })
    expect(localStorage.getItem('agent.token')).toBe('ready')
    expect(instrumentation.storage({ area: 'session', action: 'set', key: 'agent.route', value: '/agents' })).toEqual({
      area: 'session',
      entries: [{ area: 'session', key: 'agent.route', value: '/agents' }]
    })
    expect(sessionStorage.getItem('agent.route')).toBe('/agents')
    expect(instrumentation.storage({ action: 'clear' })).toEqual({ area: 'local', entries: [] })
    expect(instrumentation.cookies({ action: 'set', name: 'agent.cookie', value: 'ready' })).toEqual({
      entries: [{ name: 'agent.cookie', value: 'ready' }]
    })
    expect(document.cookie).toContain('agent.cookie=ready')
    document.cookie = 'agent.eval=seen; path=/'
    expect(instrumentation.cookies({ name: 'agent.eval' })).toEqual({
      entries: [{ name: 'agent.eval', value: 'seen' }]
    })
    expect(instrumentation.cookies({ action: 'remove', name: 'agent.cookie' })).toEqual({ entries: [] })
    expect(instrumentation.cookies()).toEqual({
      entries: [{ name: 'agent.eval', value: 'seen' }]
    })
    expect(instrumentation.cookies({ action: 'clear' })).toEqual({ entries: [] })
    expect(instrumentation.location()).toEqual({
      href: window.location.href,
      origin: window.location.origin,
      pathname: window.location.pathname,
      search: window.location.search,
      hash: window.location.hash
    })
    expect(instrumentation.location({ action: 'push', url: '/agents?view=debug#roster' })).toEqual({
      href: expect.stringContaining('/agents?view=debug#roster'),
      origin: window.location.origin,
      pathname: '/agents',
      search: '?view=debug',
      hash: '#roster'
    })
    document.cookie = 'agent.path=seen; path=/agents'
    expect(instrumentation.cookies({ name: 'agent.path' })).toEqual({
      entries: [{ name: 'agent.path', value: 'seen' }]
    })
    expect(instrumentation.cookies({ action: 'remove', name: 'agent.path' })).toEqual({ entries: [] })
    document.cookie = 'agent.path=seen; path=/agents'
    document.cookie = 'agent.path.second=ready; path=/agents'
    expect(instrumentation.cookies({ action: 'clear' })).toEqual({ entries: [] })
    expect(instrumentation.location({ action: 'replace', url: '/status' })).toEqual({
      href: expect.stringContaining('/status'),
      origin: window.location.origin,
      pathname: '/status',
      search: '',
      hash: ''
    })
    const screenshot = instrumentation.screenshot()
    expect(screenshot.mime).toBe('image/svg+xml')
    expect(screenshot.dataUrl).toMatch(/^data:image\/svg\+xml;base64,/)
    expect(decodeDataUrl(screenshot.dataUrl ?? '')).toContain('Ducktape')
    expect(instrumentation.record('get')).toEqual({
      recording: true,
      entries: [
        expect.objectContaining({ method: 'click', params: { ref: '@1' } }),
        expect.objectContaining({ method: 'hover', params: { ref: '@1' } }),
        expect.objectContaining({ method: 'focus', params: { ref: '@2' } }),
        expect.objectContaining({ method: 'blur', params: { ref: '@2' } }),
        expect.objectContaining({ method: 'scroll', params: { ref: '@7', y: 12, x: 3 } }),
        expect.objectContaining({ method: 'drag', params: { ref: '@1', toRef: '@8' } }),
        expect.objectContaining({ method: 'fill', params: { ref: '@2', value: 'worker-a' } }),
        expect.objectContaining({ method: 'select', params: { ref: '@3', value: 'remote' } }),
        expect.objectContaining({ method: 'check', params: { ref: '@6', checked: true } }),
        expect.objectContaining({ method: 'press', params: { value: 'Enter', ref: '@2', modifiers: ['Meta', 'Shift'] } })
      ]
    })
    expect((window as typeof window & { __lastShortcut?: string }).__lastShortcut).toBe('Enter:true:true:Agent name')

    instrumentation.dispose()
    window.fetch = originalFetch
    history.replaceState(null, '', originalHref)
    localStorage.clear()
    sessionStorage.clear()
  })

  it('captures console.log and serializes non-string arguments', () => {
    const instrumentation = new WebviewAgentInstrumentation()
    instrumentation.install()
    try {
      console.log('hello', { a: 1 }, 42)
      console.debug('dbg')
      expect(instrumentation.logs()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ level: 'info', message: 'hello {"a":1} 42' }),
          expect.objectContaining({ level: 'debug', message: 'dbg' })
        ])
      )
    } finally {
      instrumentation.dispose()
    }
  })

  it('rejects actions on a ref whose element was detached since the snapshot', () => {
    const instrumentation = new WebviewAgentInstrumentation()
    instrumentation.install()
    try {
      document.body.innerHTML = '<main aria-label="x"><button>Go</button></main>'
      instrumentation.snapshot()
      document.body.innerHTML = '' // detach the button that @1 points at
      expect(() => instrumentation.action({ action: 'click', ref: '@1' })).toThrow(/detached/)
    } finally {
      instrumentation.dispose()
    }
  })

  it('traces Tauri IPC invokes and skips its own bridge traffic', async () => {
    type Internals = { invoke: (command: string, args?: unknown) => Promise<unknown> }
    const withInternals = window as typeof window & { __TAURI_INTERNALS__?: Internals }
    withInternals.__TAURI_INTERNALS__ = {
      invoke: async (command: string) => {
        if (command === 'boom') {
          throw new Error('nope')
        }
        return 'ok'
      }
    }
    const instrumentation = new WebviewAgentInstrumentation()
    instrumentation.install()
    try {
      await withInternals.__TAURI_INTERNALS__!.invoke('greet', { name: 'x' })
      await expect(withInternals.__TAURI_INTERNALS__!.invoke('boom')).rejects.toThrow('nope')
      // The agent's own bridge traffic must not appear in the trace.
      await withInternals.__TAURI_INTERNALS__!.invoke('plugin:agent|agent_snapshot')
      await Promise.resolve()

      const traces = instrumentation.ipc()
      expect(traces.map((entry) => entry.command)).toEqual(['greet', 'boom'])
      expect(traces[0].ok).toBe(true)
      expect(traces[1].ok).toBe(false)
      expect(traces[1].error).toContain('nope')
      expect(instrumentation.ipc({ clear: true })).toHaveLength(2)
      expect(instrumentation.ipc()).toEqual([])
    } finally {
      instrumentation.dispose()
      delete withInternals.__TAURI_INTERNALS__
    }
  })

  it('captures runtime errors and unhandled rejections as logs', () => {
    const instrumentation = new WebviewAgentInstrumentation()
    instrumentation.install()
    const suppressHarnessUnhandled = (event: Event) => event.stopImmediatePropagation()
    window.addEventListener('error', suppressHarnessUnhandled, { capture: true })
    window.addEventListener('unhandledrejection', suppressHarnessUnhandled, { capture: true })

    try {
      const runtimeError = new Event('error', { cancelable: true }) as ErrorEvent
      Object.defineProperties(runtimeError, {
        message: { value: 'runtime boom' },
        error: { value: { message: 'runtime boom', stack: 'Error: runtime boom' } }
      })
      runtimeError.preventDefault()
      window.dispatchEvent(runtimeError)

      const rejection = new Event('unhandledrejection') as PromiseRejectionEvent
      Object.defineProperty(rejection, 'reason', {
        value: { message: 'promise boom', stack: 'eval code@\nrunCallback@user-script' }
      })
      window.dispatchEvent(rejection)

      const objectRejection = new Event('unhandledrejection') as PromiseRejectionEvent
      Object.defineProperty(objectRejection, 'reason', { value: { code: 'E_RUNTIME' } })
      window.dispatchEvent(objectRejection)

      expect(instrumentation.logs()).toEqual([
        expect.objectContaining({ level: 'error', message: expect.stringContaining('runtime boom') }),
        expect.objectContaining({ level: 'error', message: expect.stringContaining('promise boom') }),
        expect.objectContaining({ level: 'error', message: expect.stringContaining('E_RUNTIME') })
      ])
      expect(instrumentation.logs({ clear: true })).toHaveLength(3)
      expect(instrumentation.logs()).toEqual([])
    } finally {
      window.removeEventListener('error', suppressHarnessUnhandled, { capture: true })
      window.removeEventListener('unhandledrejection', suppressHarnessUnhandled, { capture: true })
      instrumentation.dispose()
    }
  })
})

function decodeDataUrl(dataUrl: string): string {
  const [, encoded = ''] = dataUrl.split(',', 2)
  return Buffer.from(encoded, 'base64').toString('utf8')
}
