import {
  WebviewAgentInstrumentation,
  agentAction,
  agentBlur,
  agentCheck,
  agentDrag,
  agentEval,
  agentEvents,
  agentFocus,
  agentHover,
  agentInspect,
  agentLogs,
  agentRecord,
  agentScreenshot,
  agentSelect,
  agentScroll,
  agentSnapshot,
  agentState,
  agentWait
} from '@byeongsu-hong/tauri-plugin-agent'
import './style.css'

const roster = ['local-worker', 'remote-worker', 'backup-worker']
let activeView = 'agents'
let selectedWorker = roster[0]
let hoveredForge = false
let focusedForge = false
let blurredForge = false
let scrolledRoster = false
let draggedForge = false

const agent = new WebviewAgentInstrumentation({
  state: {
    route: () => activeView,
    registeredCount: () => roster.length,
    selectedWorker: () => selectedWorker,
    hoveredForge: () => hoveredForge,
    focusedForge: () => focusedForge,
    blurredForge: () => blurredForge,
    scrolledRoster: () => scrolledRoster,
    draggedForge: () => draggedForge
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
        <label>
          Worker priority
          <select aria-label="Worker priority" name="workerPriority">
            <option value="local">Local</option>
            <option value="remote">Remote</option>
            <option value="backup">Backup</option>
          </select>
        </label>
        <label>
          Notify agents
          <input type="checkbox" aria-label="Notify agents" name="notifyAgents" />
        </label>
        <button type="button" data-action="register" disabled>Register</button>
        <ul aria-label="Roster" style="max-height: 4rem; overflow: auto;">
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
        <button type="button" data-action="drop-zone">Deployment queue</button>
        <p role="status" data-status>Ready</p>
        <button type="button" data-action="bridge-self-test">Verify command bridge</button>
      </section>
    </main>
  `

  const input = appRoot.querySelector<HTMLInputElement>('input[name="agentName"]')
  const forge = appRoot.querySelector<HTMLButtonElement>('[data-action="forge"]')
  const register = appRoot.querySelector<HTMLButtonElement>('[data-action="register"]')
  const rosterList = appRoot.querySelector<HTMLElement>('[aria-label="Roster"]')
  const dropZone = appRoot.querySelector<HTMLButtonElement>('[data-action="drop-zone"]')
  const status = appRoot.querySelector<HTMLElement>('[data-status]')

  forge?.addEventListener('mouseenter', () => {
    hoveredForge = true
  })
  forge?.addEventListener('focus', () => {
    focusedForge = true
  })
  forge?.addEventListener('blur', () => {
    blurredForge = true
  })
  rosterList?.addEventListener('scroll', () => {
    scrolledRoster = true
  })
  dropZone?.addEventListener('drop', () => {
    draggedForge = true
  })

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
  const forgeRef = tree.match(/(@\d+) button "Forge"/)?.[1]
  const priorityRef = tree.match(/(@\d+) combobox "Worker priority"/)?.[1]
  const notifyRef = tree.match(/(@\d+) checkbox "Notify agents"/)?.[1]
  const rosterRef = tree.match(/(@\d+) list "Roster"/)?.[1]
  const dropRef = tree.match(/(@\d+) button "Deployment queue"/)?.[1]
  const inspected = agentNameRef ? await agentInspect({ ref: agentNameRef }) : null
  const evaluated = await agentEval({ code: 'document.querySelector("[data-status]")?.textContent' })
  if (forgeRef) await agentFocus({ ref: forgeRef })
  if (forgeRef) await agentBlur({ ref: forgeRef })
  if (forgeRef) await agentHover({ ref: forgeRef })
  if (rosterRef) await agentScroll({ ref: rosterRef, y: 12 })
  if (forgeRef) await agentDrag({ ref: forgeRef, toRef: dropRef })
  if (priorityRef) await agentSelect({ ref: priorityRef, value: 'remote' })
  if (notifyRef) await agentCheck({ ref: notifyRef, checked: true })
  await agentAction({ action: 'press', value: 'Escape' })
  const state = await agentState()
  const logs = await agentLogs()
  const events = await agentEvents()
  const shot = await agentScreenshot()
  const wait = await agentWait({ text: 'Command bridge running', timeoutMs: 500 })
  const record = await agentRecord()
  const probes = isRecord(state.probes) ? state.probes : {}
  const values = isRecord(state.values) ? state.values : {}

  const verified =
    tree.includes('Ducktape') &&
    inspected?.role === 'textbox' &&
    inspected.name === 'Agent name' &&
    evaluated.type === 'string' &&
    evaluated.value === 'Command bridge running' &&
    values['Notify agents'] === true &&
    values['Worker priority'] === 'remote' &&
    isRecord(state) &&
    probes.route === activeView &&
    probes.hoveredForge === true &&
    probes.focusedForge === true &&
    probes.blurredForge === true &&
    probes.scrolledRoster === true &&
    probes.draggedForge === true &&
    logs.some((entry) => entry.message.includes('tauri-agent fixture booted')) &&
    events.some((event) => event.kind === 'click') &&
    events.some((event) => event.kind === 'hover') &&
    events.some((event) => event.kind === 'focus') &&
    events.some((event) => event.kind === 'blur') &&
    events.some((event) => event.kind === 'scroll') &&
    events.some((event) => event.kind === 'drag') &&
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
