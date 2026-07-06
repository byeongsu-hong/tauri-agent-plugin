import {
  WebviewAgentInstrumentation,
  agentAction,
  agentEvents,
  agentInspect,
  agentLogs,
  agentRecord,
  agentScreenshot,
  agentSnapshot,
  agentState,
  agentWait
} from '@byeongsu-hong/tauri-plugin-agent'
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
        <button type="button" data-action="bridge-self-test">Verify command bridge</button>
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

  appRoot.querySelector<HTMLButtonElement>('[data-action="bridge-self-test"]')?.addEventListener('click', () => {
    void runCommandBridgeSelfTest(status)
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

async function runCommandBridgeSelfTest(status: HTMLElement | null): Promise<void> {
  if (!status) return
  status.textContent = 'Command bridge running'
  const tree = await agentSnapshot({ scope: 'main' })
  const agentNameRef = tree.match(/(@\d+) textbox "Agent name"/)?.[1]
  const inspected = agentNameRef ? await agentInspect({ ref: agentNameRef }) : null
  await agentAction({ action: 'press', value: 'Escape' })
  const state = await agentState()
  const logs = await agentLogs()
  const events = await agentEvents()
  const shot = await agentScreenshot()
  const wait = await agentWait({ text: 'Command bridge running', timeoutMs: 500 })
  const record = await agentRecord()
  const probes = isRecord(state.probes) ? state.probes : {}

  const verified =
    tree.includes('Ducktape') &&
    inspected?.role === 'textbox' &&
    inspected.name === 'Agent name' &&
    isRecord(state) &&
    probes.route === activeView &&
    logs.some((entry) => entry.message.includes('tauri-agent fixture booted')) &&
    events.some((event) => event.kind === 'click') &&
    events.some((event) => event.kind === 'press') &&
    shot.startsWith('data:image/svg+xml;base64,') &&
    wait.matched &&
    !record.recording

  status.textContent = verified ? 'Command bridge verified' : 'Command bridge failed'
  console.info(status.textContent)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function mustFindAppRoot(): HTMLDivElement {
  const root = document.querySelector<HTMLDivElement>('#app')
  if (!root) {
    throw new Error('missing app root')
  }
  return root
}
