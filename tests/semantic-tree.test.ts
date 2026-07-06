import { describe, expect, it } from 'vitest'
import {
  clickRef,
  checkRef,
  fillRef,
  inspectRef,
  pressKey,
  resolveRef,
  selectRef,
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

    snapshotDocument(document)

    clickRef('@1')
    fillRef('@2', 'worker-a')
    pressKey('Enter')

    expect(seen).toEqual(['clicked', 'input', 'key:Enter'])
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
})
