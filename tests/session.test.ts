import { describe, expect, it } from 'vitest'

import { DebuggerSession } from '../daemon/session'
import { StaticHtmlAppAdapter } from '../daemon/static-app'

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
    const adapter = new StaticHtmlAppAdapter({ html, title: 'Ducktape' })
    adapter.addLog('info', 'booted')
    const session = new DebuggerSession(adapter)

    await expect(session.execute('attach', {})).resolves.toEqual({
      attached: true,
      windows: [{ label: 'main', title: 'Ducktape', focused: true, visible: true }]
    })
    await expect(session.execute('windows', {})).resolves.toEqual([
      { label: 'main', title: 'Ducktape', focused: true, visible: true }
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
    await expect(session.execute('press', { key: 'Enter' })).resolves.toEqual({ ok: true })

    await expect(session.execute('state', {})).resolves.toEqual({
      url: 'tauri-agent://static',
      title: 'Ducktape',
      values: {
        'Agent name': 'worker-a',
        Notify: true,
        Worker: 'remote'
      }
    })
    await expect(session.execute('wait', { text: 'Registered worker-a', timeoutMs: 1 })).resolves.toEqual({
      matched: true,
      text: 'Registered worker-a'
    })
    await expect(session.execute('logs', {})).resolves.toMatchObject([
      { level: 'info', message: 'booted', window: 'main' }
    ])
    await expect(session.execute('network', {})).resolves.toEqual([])
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
      expect.arrayContaining([
        expect.objectContaining({ kind: 'attach', window: 'main' }),
        expect.objectContaining({ kind: 'click', detail: { ref: '@1' } }),
        expect.objectContaining({ kind: 'hover', detail: { ref: '@1' } }),
        expect.objectContaining({ kind: 'focus', detail: { ref: '@2' } }),
        expect.objectContaining({ kind: 'blur', detail: { ref: '@2' } }),
        expect.objectContaining({ kind: 'scroll', detail: { ref: '@7', y: 12, x: 3 } }),
        expect.objectContaining({ kind: 'drag', detail: { ref: '@1', toRef: '@8' } }),
        expect.objectContaining({ kind: 'fill', detail: { ref: '@2', text: 'worker-a' } }),
        expect.objectContaining({ kind: 'press', detail: { key: 'Enter' } })
      ])
    )
    await expect(session.execute('record', { action: 'get' })).resolves.toEqual({
      recording: true,
      entries: [
        expect.objectContaining({ method: 'click', params: { ref: '@1' } }),
        expect.objectContaining({ method: 'hover', params: { ref: '@1' } }),
        expect.objectContaining({ method: 'focus', params: { ref: '@2' } }),
        expect.objectContaining({ method: 'blur', params: { ref: '@2' } }),
        expect.objectContaining({ method: 'scroll', params: { ref: '@7', y: 12, x: 3 } }),
        expect.objectContaining({ method: 'drag', params: { ref: '@1', toRef: '@8' } }),
        expect.objectContaining({ method: 'fill', params: { ref: '@2', text: 'worker-a' } }),
        expect.objectContaining({ method: 'press', params: { key: 'Enter' } })
      ]
    })
  })

  it('reports stale refs and missing wait text clearly', async () => {
    const session = new DebuggerSession(new StaticHtmlAppAdapter({ html, title: 'Ducktape' }))

    await session.execute('tree', {})

    await expect(session.execute('click', { ref: '@9' })).rejects.toThrow('stale ref @9; run tree again')
    await expect(session.execute('wait', { text: 'Never appears', timeoutMs: 1 })).rejects.toThrow(
      'wait timed out for text: Never appears'
    )
  })
})
