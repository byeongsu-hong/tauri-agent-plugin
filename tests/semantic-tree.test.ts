import { describe, expect, it } from 'vitest'
import { clickRef, fillRef, pressKey, resolveRef, snapshotDocument } from '../guest-js/semantic-tree'

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
})
