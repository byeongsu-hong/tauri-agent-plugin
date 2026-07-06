import { WebviewAgentInstrumentation } from '@byeongsu-hong/tauri-plugin-agent'
import './style.css'

const roster = ['local-worker', 'remote-worker', 'backup-worker']
let activeView = 'agents'
let selectedWorker = roster[0]

const agent = new WebviewAgentInstrumentation({
  state: {
    route: () => activeView,
    registeredCount: () => roster.length,
    selectedWorker: () => selectedWorker
  }
})

agent.install()
console.info('tauri-agent fixture booted')

declare global {
  interface Window {
    __TAURI_AGENT_FIXTURE__?: WebviewAgentInstrumentation
  }
}

window.__TAURI_AGENT_FIXTURE__ = agent

const appRoot = mustFindAppRoot()

render()

function render(): void {
  appRoot.innerHTML = `
    <main aria-label="Ducktape" data-view="${activeView}">
      <nav aria-label="Primary">
        <button role="navitem" aria-selected="${activeView === 'status'}" data-nav="status">Status</button>
        <button role="navitem" aria-selected="${activeView === 'agents'}" data-nav="agents">Agents</button>
      </nav>

      <section aria-label="Agents" data-view="agents">
        <h1>Agents</h1>
        <button type="button" data-action="forge">Forge</button>
        <label>
          Agent name
          <input aria-label="Agent name" name="agentName" autocomplete="off" />
        </label>
        <button type="button" data-action="register" disabled>Register</button>
        <ul aria-label="Roster">
          ${roster
            .map(
              (worker) => `
                <li aria-selected="${worker === selectedWorker}">
                  ${worker}
                  <button type="button" data-inspect="${worker}">Inspect backing</button>
                </li>
              `
            )
            .join('')}
        </ul>
        <p role="status" data-status>Ready</p>
      </section>
    </main>
  `

  const input = appRoot.querySelector<HTMLInputElement>('input[name="agentName"]')
  const register = appRoot.querySelector<HTMLButtonElement>('[data-action="register"]')
  const status = appRoot.querySelector<HTMLElement>('[data-status]')

  input?.focus()
  input?.addEventListener('input', () => {
    if (register && input) {
      register.disabled = input.value.trim().length === 0
    }
  })

  register?.addEventListener('click', () => {
    const name = input?.value.trim()
    if (!name || !status) return
    status.textContent = `Registered ${name}`
    console.info(`registered ${name}`)
  })

  for (const nav of Array.from(appRoot.querySelectorAll<HTMLButtonElement>('[data-nav]'))) {
    nav.addEventListener('click', () => {
      activeView = nav.dataset.nav ?? 'agents'
      render()
    })
  }

  for (const inspect of Array.from(appRoot.querySelectorAll<HTMLButtonElement>('[data-inspect]'))) {
    inspect.addEventListener('click', () => {
      selectedWorker = inspect.dataset.inspect ?? selectedWorker
      if (status) status.textContent = `Inspecting ${selectedWorker}`
    })
  }
}

function mustFindAppRoot(): HTMLDivElement {
  const root = document.querySelector<HTMLDivElement>('#app')
  if (!root) {
    throw new Error('missing app root')
  }
  return root
}
