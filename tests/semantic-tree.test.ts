import { describe, expect, it } from 'vitest'
import {
  blurRef,
  clickRef,
  checkRef,
  dragRef,
  findRefs,
  fillRef,
  focusRef,
  hoverRef,
  inspectRef,
  pressKey,
  resolveRef,
  selectRef,
  scrollRef,
  snapshotDocument
} from '../guest-js/semantic-tree'

describe('snapshotDocument', () => {
  it('formats a compact semantic tree with snapshot-local refs and useful state', () => {
    document.body.innerHTML = `
      <main aria-label="Ducktape">
        <div class="layout-noise">
          <span>ignored wrapper text</span>
          <button role="navitem" aria-selected="true">Status</button>
          <button role="navitem">Agents</button>
          <button>Forge</button>
          <label>
            Agent name
            <input value="" autofocus />
          </label>
          <button disabled>Register</button>
          <ul aria-label="Roster">
            <li aria-selected="true">
              local-worker
              <button>Inspect backing</button>
            </li>
            <li>remote-worker</li>
            <li>backup-worker</li>
          </ul>
        </div>
      </main>
    `

    const input = document.querySelector('input')
    input?.focus()

    const snapshot = snapshotDocument(document)

    expect(snapshot.text).toBe(
      [
        'main "Ducktape"',
        '@1 navitem "Status" selected',
        '@2 navitem "Agents"',
        '@3 button "Forge"',
        '@4 textbox "Agent name" empty focused',
        '@5 button "Register" disabled',
        '@6 list "Roster" 3',
        '  @7 item "local-worker" selected',
        '    @8 button "Inspect backing"'
      ].join('\n')
    )
    expect([...snapshot.refs.keys()]).toEqual(['@1', '@2', '@3', '@4', '@5', '@6', '@7', '@8'])
  })

  it('annotates lines in verbose mode without changing tree shape or refs', () => {
    document.body.innerHTML = `
      <main aria-label="Ducktape">
        <input id="agent-name" data-testid="name" type="text" value="local-worker" aria-label="Agent name" />
        <button>Forge</button>
      </main>
    `

    const compact = snapshotDocument(document, { mode: 'compact' })
    const verbose = snapshotDocument(document, { mode: 'verbose' })

    // Same elements, same refs — verbose only adds detail to existing lines.
    expect([...verbose.refs.keys()]).toEqual([...compact.refs.keys()])
    expect(verbose.text).toBe(
      [
        'main "Ducktape"',
        '@1 textbox "Agent name" value="local-worker" #agent-name [testid=name] type=text',
        '@2 button "Forge"'
      ].join('\n')
    )
  })

  it('scopes snapshots and fails stale refs clearly', () => {
    document.body.innerHTML = `
      <main>
        <section data-view="agents">
          <button>Register</button>
        </section>
        <section data-view="settings">
          <button>Delete</button>
        </section>
      </main>
    `

    const snapshot = snapshotDocument(document, { scope: '[data-view="agents"]' })

    expect(snapshot.text).toBe('@1 button "Register"')
    expect(snapshot.refs.get('@2')).toBeUndefined()
    expect(resolveRef('@1')).toBe(snapshot.refs.get('@1'))
    expect(() => resolveRef('@2')).toThrow('stale ref @2; run tree again')
  })

  it('dispatches actions through the current snapshot ref registry', () => {
    const seen: string[] = []
    document.body.innerHTML = `
      <main>
        <button>Forge</button>
        <input aria-label="Agent name" />
      </main>
    `
    document.querySelector('button')?.addEventListener('click', () => seen.push('clicked'))
    document.querySelector('input')?.addEventListener('input', () => seen.push('input'))
    document.body.addEventListener('keydown', (event) => seen.push(`key:${event.key}`))
    document.querySelector('input')?.addEventListener('keydown', (event) =>
      seen.push(`target:${event.key}:${event.metaKey}:${event.shiftKey}`)
    )

    snapshotDocument(document)

    clickRef('@1')
    fillRef('@2', 'worker-a')
    pressKey('Enter')
    pressKey('k', resolveRef('@2'), { modifiers: ['Meta', 'Shift'] })

    expect(seen).toEqual(['clicked', 'input', 'key:Enter', 'target:k:true:true', 'key:k'])
    expect((resolveRef('@2') as HTMLInputElement).value).toBe('worker-a')
  })

  it('exposes select controls and chooses options by value or label', () => {
    const seen: string[] = []
    document.body.innerHTML = `
      <select aria-label="Worker">
        <option value="">Choose worker</option>
        <option value="local">Local worker</option>
        <option value="remote" selected>Remote worker</option>
      </select>
    `
    document.querySelector('select')?.addEventListener('input', () => seen.push('input'))
    document.querySelector('select')?.addEventListener('change', () => seen.push('change'))

    const snapshot = snapshotDocument(document)

    expect(snapshot.text).toBe(
      [
        '@1 combobox "Worker"',
        '  @2 option "Choose worker"',
        '  @3 option "Local worker"',
        '  @4 option "Remote worker" selected'
      ].join('\n')
    )

    selectRef('@1', 'local')
    expect((resolveRef('@1') as HTMLSelectElement).value).toBe('local')
    selectRef('@1', 'Remote worker')
    expect((resolveRef('@1') as HTMLSelectElement).value).toBe('remote')
    selectRef('@3')
    expect((resolveRef('@1') as HTMLSelectElement).value).toBe('local')
    expect(seen).toEqual(['input', 'change', 'input', 'change', 'input', 'change'])
  })

  it('sets checkbox and radio checked state idempotently', () => {
    const seen: string[] = []
    document.body.innerHTML = `
      <label><input type="checkbox" aria-label="Notify" /> Notify</label>
      <label><input type="radio" name="mode" value="local" aria-label="Local" /> Local</label>
      <label><input type="radio" name="mode" value="remote" aria-label="Remote" checked /> Remote</label>
    `
    for (const input of Array.from(document.querySelectorAll('input'))) {
      input.addEventListener('input', () => seen.push(`input:${input.getAttribute('aria-label')}`))
      input.addEventListener('change', () => seen.push(`change:${input.getAttribute('aria-label')}`))
    }

    const snapshot = snapshotDocument(document)

    expect(snapshot.text).toBe(
      [
        '@1 checkbox "Notify"',
        '@2 radio "Local"',
        '@3 radio "Remote" checked'
      ].join('\n')
    )

    checkRef('@1', true)
    checkRef('@2', true)
    checkRef('@1', true)
    expect((resolveRef('@1') as HTMLInputElement).checked).toBe(true)
    expect((resolveRef('@2') as HTMLInputElement).checked).toBe(true)
    expect((resolveRef('@3') as HTMLInputElement).checked).toBe(false)
    expect(seen).toEqual(['input:Notify', 'change:Notify', 'input:Local', 'change:Local'])
    expect(() => checkRef('@2', false)).toThrow('radio @2 cannot be unchecked directly')
  })

  it('dispatches hover events through the current snapshot ref registry', () => {
    const seen: string[] = []
    document.body.innerHTML = '<button>Forge</button>'
    const button = document.querySelector('button')
    button?.addEventListener('mouseover', () => seen.push('mouseover'))
    button?.addEventListener('mouseenter', () => seen.push('mouseenter'))
    button?.addEventListener('mousemove', () => seen.push('mousemove'))

    snapshotDocument(document)
    hoverRef('@1')

    expect(seen).toEqual(['mouseover', 'mouseenter', 'mousemove'])
  })

  it('focuses refs through the current snapshot ref registry', () => {
    const seen: string[] = []
    document.body.innerHTML = '<button>Forge</button><input aria-label="Agent name" />'
    const input = document.querySelector('input')
    input?.addEventListener('focus', () => seen.push('focus'))
    input?.addEventListener('focusin', () => seen.push('focusin'))

    snapshotDocument(document)
    focusRef('@2')

    expect(document.activeElement).toBe(input)
    expect(seen).toEqual(['focus', 'focusin'])
  })

  it('blurs refs through the current snapshot ref registry', () => {
    const seen: string[] = []
    document.body.innerHTML = '<input aria-label="Agent name" />'
    const input = document.querySelector('input')
    input?.addEventListener('blur', () => seen.push('blur'))
    input?.addEventListener('focusout', () => seen.push('focusout'))

    snapshotDocument(document)
    focusRef('@1')
    blurRef('@1')

    expect(document.activeElement).not.toBe(input)
    expect(seen).toEqual(['blur', 'focusout'])
  })

  it('scrolls refs through the current snapshot ref registry', () => {
    const seen: string[] = []
    document.body.innerHTML = `
      <div role="list" aria-label="Roster" style="width: 20px; height: 20px; overflow: auto;">
        <div style="width: 100px; height: 100px;">Workers</div>
      </div>
    `
    const list = document.querySelector<HTMLElement>('[role="list"]')
    list?.addEventListener('scroll', () => seen.push('scroll'))

    snapshotDocument(document)
    scrollRef('@1', { y: 12, x: 3 })

    expect(list?.scrollTop).toBe(12)
    expect(list?.scrollLeft).toBe(3)
    expect(seen).toEqual(['scroll'])
  })

  it('drags refs through the current snapshot ref registry', () => {
    const seen: string[] = []
    document.body.innerHTML = `
      <button draggable="true">Drag source</button>
      <button>Drop target</button>
    `
    const source = document.querySelectorAll('button')[0]
    const target = document.querySelectorAll('button')[1]
    source?.addEventListener('mousedown', () => seen.push('source:mousedown'))
    source?.addEventListener('dragstart', () => seen.push('source:dragstart'))
    source?.addEventListener('dragend', () => seen.push('source:dragend'))
    source?.addEventListener('mouseup', () => seen.push('source:mouseup'))
    target?.addEventListener('dragenter', () => seen.push('target:dragenter'))
    target?.addEventListener('dragover', () => seen.push('target:dragover'))
    target?.addEventListener('drop', () => seen.push('target:drop'))

    snapshotDocument(document)
    dragRef('@1', { toRef: '@2' })

    expect(seen).toEqual([
      'source:mousedown',
      'source:dragstart',
      'target:dragenter',
      'target:dragover',
      'target:drop',
      'source:dragend',
      'source:mouseup'
    ])
  })

  it('inspects snapshot-local refs with structured element details', () => {
    document.body.innerHTML = `
      <main>
        <button id="forge" data-action="forge" aria-expanded="true" disabled>
          Forge <span>now</span>
        </button>
        <input aria-label="Agent name" value="worker-a" />
      </main>
    `

    snapshotDocument(document)

    expect(inspectRef('@1')).toEqual({
      ref: '@1',
      role: 'button',
      name: 'Forge now',
      tagName: 'button',
      text: 'Forge now',
      attributes: {
        'aria-expanded': 'true',
        'data-action': 'forge',
        disabled: '',
        id: 'forge'
      },
      states: ['disabled', 'expanded']
    })
    expect(inspectRef('@2')).toEqual({
      ref: '@2',
      role: 'textbox',
      name: 'Agent name',
      tagName: 'input',
      text: '',
      value: 'worker-a',
      attributes: {
        'aria-label': 'Agent name',
        value: 'worker-a'
      },
      states: []
    })
    expect(() => inspectRef('@9')).toThrow('stale ref @9; run tree again')
  })

  it('finds current snapshot refs by role, name, text, and limit', () => {
    document.body.innerHTML = `
      <main aria-label="Ducktape">
        <button data-action="forge">Forge</button>
        <label>Agent name<input aria-label="Agent name"></label>
        <ul aria-label="Roster">
          <li aria-selected="true">local-worker <button>Inspect backing</button></li>
          <li>remote-worker <button>Inspect backing</button></li>
        </ul>
      </main>
    `

    snapshotDocument(document)

    expect(findRefs({ role: 'button', name: 'inspect' })).toEqual([
      expect.objectContaining({ ref: '@5', role: 'button', name: 'Inspect backing' }),
      expect.objectContaining({ ref: '@7', role: 'button', name: 'Inspect backing' })
    ])
    expect(findRefs({ role: 'item', text: 'remote-worker', limit: 1 })).toEqual([
      expect.objectContaining({ ref: '@6', role: 'item', name: 'remote-worker' })
    ])
  })
})
