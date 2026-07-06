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
    instrumentation.action({ action: 'press', value: 'Enter' })

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
      states: []
    })
    expect(instrumentation.logs()).toEqual([
      expect.objectContaining({ level: 'info', message: 'booted' })
    ])
    expect(instrumentation.events()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'click', detail: { ref: '@1' } }),
        expect.objectContaining({ kind: 'hover', detail: { ref: '@1' } }),
        expect.objectContaining({ kind: 'focus', detail: { ref: '@2' } }),
        expect.objectContaining({ kind: 'blur', detail: { ref: '@2' } }),
        expect.objectContaining({ kind: 'scroll', detail: { ref: '@7', y: 12, x: 3 } }),
        expect.objectContaining({ kind: 'drag', detail: { ref: '@1', toRef: '@8' } }),
        expect.objectContaining({ kind: 'fill', detail: { ref: '@2', value: 'worker-a' } }),
        expect.objectContaining({ kind: 'press', detail: { value: 'Enter' } }),
        expect.objectContaining({ kind: 'wait', detail: { text: 'Registered worker-a' } })
      ])
    )
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
        expect.objectContaining({ method: 'press', params: { value: 'Enter' } })
      ]
    })

    instrumentation.dispose()
    window.fetch = originalFetch
    history.replaceState(null, '', originalHref)
    localStorage.clear()
    sessionStorage.clear()
  })
})

function decodeDataUrl(dataUrl: string): string {
  const [, encoded = ''] = dataUrl.split(',', 2)
  return Buffer.from(encoded, 'base64').toString('utf8')
}
