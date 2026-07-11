import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

// `jsdom` is an optional peer, loaded lazily so merely importing this module
// (e.g. for the client transports it lives beside) never requires it. Only the
// static `--from-html` adapter needs it, and only when actually instantiated.
import type { JSDOM } from 'jsdom'

import {
  assertExpectation,
  blurRef,
  checkRef,
  clickRef,
  dragRef,
  findRefs,
  fillRef,
  focusRef,
  hoverRef,
  inspectRef,
  pressKey,
  resetRefRegistry,
  resolveRef,
  scrollRef,
  selectRef,
  snapshotDocument,
  typeRef,
  uploadRef,
  type DragOptions,
  type ScrollOptions,
  type UploadFile,
  type SnapshotOptions
} from '../guest-js/semantic-tree'
import { screenshotDocument } from '../guest-js/screenshot'
import { evalResult, evalResultAsync } from '../guest-js/evaluate'
import { SemanticStream } from '../guest-js/semantic-stream'
import { CaptureBuffer } from '../guest-js/capture-buffer'
import { locateActionable } from '../guest-js/locator-action'
import { AGENT_METHODS } from '../protocol/json-rpc'
import { AgentProtocolError } from '../protocol/error'
import {
  applyCookieAction,
  applyStorageAction,
  cookieResult,
  DialogController,
  errorLikeMessage,
  hasSemanticWaitFilter,
  locationResult,
  requiredLocationUrl,
  runtimeErrorMessage,
  stateValue,
  storageArea,
  storageResult,
  waitEventDetail,
  waitTimeoutMessage,
  type DialogWindow
} from '../guest-js/dom-actions'
import type {
  ActParams,
  ActResult,
  AgentEvent,
  AgentWindow,
  AttachResult,
  CaptureResult,
  CookieParams,
  CookieResult,
  DialogParams,
  DialogResult,
  DetailResult,
  EvalResult,
  ExpectParams,
  ExpectResult,
  EventsParams,
  FindParams,
  FindResult,
  InspectResult,
  IpcDetail,
  IpcEntry,
  IpcParams,
  LocationParams,
  LocationResult,
  LogEntry,
  LogsParams,
  KeyModifier,
  NetworkEntry,
  NetworkDetail,
  NetworkParams,
  ShotParams,
  ScreenshotResult,
  StorageParams,
  StorageResult,
  StreamParams,
  StreamResult,
  WaitParams,
  WaitResult,
  WindowParams
} from '../protocol/types'

export interface StaticHtmlAppOptions {
  html: string
  title?: string
  url?: string
  window?: string
}

export class StaticHtmlAppAdapter {
  readonly label: string
  readonly title: string
  readonly url: string

  private dom: JSDOM
  private logs = new CaptureBuffer<LogEntry>(1000)
  private events = new CaptureBuffer<AgentEvent>(1000)
  private network = new CaptureBuffer<NetworkEntry>(1000)
  private readonly sessionId = crypto.randomUUID()
  private actionTraceId = 0
  private activeTraceId?: string
  private readonly dialogController = new DialogController((entry) =>
    this.pushEvent('dialog', { type: entry.type, message: entry.message, response: entry.response })
  )
  private semanticStream: SemanticStream
  private streamObserver?: MutationObserver
  private windowState: AgentWindow
  private storageAreas = {
    local: createMemoryStorage(),
    session: createMemoryStorage()
  }

  private constructor(dom: JSDOM, options: StaticHtmlAppOptions) {
    this.label = options.window ?? 'main'
    this.title = options.title ?? 'Tauri App'
    this.url = options.url ?? 'tauri-agent://static'
    this.dom = dom
    this.windowState = this.createInitialWindowState()
    this.bindGlobals()
    this.dialogController.install(this.dom.window as unknown as DialogWindow)
    this.installRuntimeLogCapture()
    this.semanticStream = new SemanticStream({
      capture: () => snapshotDocument(this.dom.window.document).text
    })
    this.semanticStream.prime()
    this.installSemanticStream()
  }

  /**
   * Build a static adapter, lazily loading the optional `jsdom` peer. Throws a
   * clear, actionable error if it is not installed rather than a bare module
   * resolution failure.
   */
  static async create(options: StaticHtmlAppOptions): Promise<StaticHtmlAppAdapter> {
    let JSDOMCtor: typeof JSDOM
    try {
      ;({ JSDOM: JSDOMCtor } = await import('jsdom'))
    } catch {
      throw new Error(
        "the static HTML adapter (--from-html / html:) requires the optional 'jsdom' package; install it with `npm install jsdom`"
      )
    }
    const dom = new JSDOMCtor(options.html, {
      pretendToBeVisual: true,
      runScripts: 'outside-only',
      url: options.url ?? 'tauri-agent://static'
    })
    // A newly created isolated jsdom is a deliberate fresh surface: restart ref
    // numbering at @1. Refs never span two `create()` calls (each is its own
    // session / self-contained html-per-call request), so this cannot recycle a
    // handle onto the wrong element — unlike re-snapshotting a live surface,
    // which never resets so its handles stay stable and are never reused.
    resetRefRegistry()
    return new StaticHtmlAppAdapter(dom, options)
  }

  async stream(params: StreamParams = {}): Promise<StreamResult> {
    return this.semanticStream.wait(params.since, params.timeoutMs ?? 0, params.lean ?? false)
  }

  private installSemanticStream(): void {
    const observerCtor = this.dom.window.MutationObserver
    if (!observerCtor) {
      return
    }
    this.streamObserver = new observerCtor(() => this.semanticStream.tick())
    this.streamObserver.observe(this.dom.window.document, {
      subtree: true,
      childList: true,
      attributes: true,
      characterData: true
    })
  }

  async attach(): Promise<AttachResult> {
    this.pushEvent('attach')
    return {
      attached: true,
      protocolVersion: 2,
      sessionId: this.sessionId,
      platform: staticPlatform(),
      runtime: 'unknown',
      methods: [...AGENT_METHODS],
      features: ['locator-action', 'lean-stream', 'capture-cursors', 'correlated-details'],
      screenshotBackends: ['dom'],
      windows: await this.windows()
    }
  }

  async windows(): Promise<AgentWindow[]> {
    return [this.windowInfo()]
  }

  async window(options: WindowParams = {}): Promise<AgentWindow> {
    if (options.window && options.window !== this.label) {
      throw new Error(`window not found: ${options.window}`)
    }

    const action = options.action ?? 'get'
    switch (action) {
      case 'get':
        break
      case 'focus':
        this.windowState.focused = true
        this.windowState.visible = true
        this.windowState.minimized = false
        break
      case 'show':
        this.windowState.visible = true
        break
      case 'hide':
        this.windowState.visible = false
        this.windowState.focused = false
        break
      case 'minimize':
        this.windowState.minimized = true
        this.windowState.focused = false
        break
      case 'unminimize':
        this.windowState.minimized = false
        break
      case 'maximize':
        this.windowState.maximized = true
        break
      case 'unmaximize':
        this.windowState.maximized = false
        break
      case 'setSize':
        this.setWindowSize(requiredPositiveNumber(options.width, 'width'), requiredPositiveNumber(options.height, 'height'))
        break
      case 'setPosition':
        this.setWindowPosition(requiredFiniteNumber(options.x, 'x'), requiredFiniteNumber(options.y, 'y'))
        break
      default:
        throw new Error(`unknown window action: ${String(action)}`)
    }

    if (action !== 'get') {
      this.pushEvent('window', { action })
    }
    return this.windowInfo()
  }

  private createInitialWindowState(): AgentWindow {
    const innerBounds = {
      x: 0,
      y: 0,
      width: this.dom.window.innerWidth,
      height: this.dom.window.innerHeight
    }
    return {
      label: this.label,
      title: this.title,
      focused: true,
      visible: true,
      minimized: false,
      maximized: false,
      scaleFactor: this.dom.window.devicePixelRatio || 1,
      innerBounds,
      outerBounds: {
        x: 0,
        y: 0,
        width: this.dom.window.outerWidth || innerBounds.width,
        height: this.dom.window.outerHeight || innerBounds.height
      }
    }
  }

  private windowInfo(): AgentWindow {
    return {
      ...this.windowState,
      innerBounds: this.windowState.innerBounds ? { ...this.windowState.innerBounds } : undefined,
      outerBounds: this.windowState.outerBounds ? { ...this.windowState.outerBounds } : undefined
    }
  }

  private setWindowSize(width: number, height: number): void {
    this.windowState.innerBounds = { ...(this.windowState.innerBounds ?? { x: 0, y: 0, width, height }), width, height }
    this.windowState.outerBounds = { ...(this.windowState.outerBounds ?? { x: 0, y: 0, width, height }), width, height }
  }

  private setWindowPosition(x: number, y: number): void {
    const inner = this.windowState.innerBounds ?? { x, y, width: this.dom.window.innerWidth, height: this.dom.window.innerHeight }
    const outer = this.windowState.outerBounds ?? { x, y, width: inner.width, height: inner.height }
    this.windowState.innerBounds = { ...inner, x, y }
    this.windowState.outerBounds = { ...outer, x, y }
  }

  async tree(options: SnapshotOptions = {}): Promise<{ text: string }> {
    this.bindGlobals()
    return { text: snapshotDocument(this.dom.window.document, options).text }
  }

  async find(options: FindParams = {}): Promise<FindResult> {
    this.bindGlobals()
    const snapshot = snapshotDocument(this.dom.window.document, { scope: options.scope })
    return { matches: findRefs(options, snapshot.refs) }
  }

  async act(params: ActParams): Promise<ActResult> {
    const match = await locateActionable(params, (locator) => {
      this.bindGlobals()
      const snapshot = snapshotDocument(this.dom.window.document, { scope: locator.scope })
      return findRefs(locator, snapshot.refs)
    })
    const previousTraceId = this.activeTraceId
    const traceId = `action-${++this.actionTraceId}`
    this.activeTraceId = traceId
    try {
      switch (params.action) {
        case 'click': await this.click(match!.ref); break
        case 'hover': await this.hover(match!.ref); break
        case 'focus': await this.focus(match!.ref); break
        case 'blur': await this.blur(match!.ref); break
        case 'fill': await this.fill(match!.ref, stringActionValue(params)); break
        case 'type': await this.type(match!.ref, stringActionValue(params)); break
        case 'press': await this.press(stringActionValue(params), { ref: match?.ref }); break
        case 'scroll': await this.scroll(match!.ref, { x: params.x, y: params.y }); break
        case 'select': await this.select(match!.ref, stringActionValue(params)); break
        case 'check': await this.check(match!.ref, typeof params.value === 'boolean' ? params.value : true); break
      }
      return { ok: true, traceId, ...(params.detail && match ? { match } : {}) }
    } finally {
      this.activeTraceId = previousTraceId
    }
  }

  async expect(options: ExpectParams): Promise<ExpectResult> {
    this.bindGlobals()
    const snapshot = snapshotDocument(this.dom.window.document, { scope: options.scope })
    const match = findRefs(
      { scope: options.scope, role: options.role, name: options.name, text: options.text, limit: 1 },
      snapshot.refs
    )[0]
    return assertExpectation(match, options)
  }

  async click(ref: string): Promise<{ ok: true }> {
    this.bindGlobals()
    clickRef(ref)
    this.pushEvent('click', { ref })
    return { ok: true }
  }

  async hover(ref: string): Promise<{ ok: true }> {
    this.bindGlobals()
    hoverRef(ref)
    this.pushEvent('hover', { ref })
    return { ok: true }
  }

  async focus(ref: string): Promise<{ ok: true }> {
    this.bindGlobals()
    focusRef(ref)
    this.pushEvent('focus', { ref })
    return { ok: true }
  }

  async blur(ref: string): Promise<{ ok: true }> {
    this.bindGlobals()
    blurRef(ref)
    this.pushEvent('blur', { ref })
    return { ok: true }
  }

  async scroll(ref: string, options: ScrollOptions = {}): Promise<{ ok: true }> {
    this.bindGlobals()
    scrollRef(ref, options)
    this.pushEvent('scroll', actionDetail({ ref, x: options.x, y: options.y }))
    return { ok: true }
  }

  async drag(ref: string, options: DragOptions = {}): Promise<{ ok: true }> {
    this.bindGlobals()
    dragRef(ref, options)
    this.pushEvent('drag', actionDetail({ ref, toRef: options.toRef }))
    return { ok: true }
  }

  async check(ref: string, checked?: boolean): Promise<{ ok: true }> {
    this.bindGlobals()
    checkRef(ref, checked ?? true)
    this.pushEvent('check', { ref, checked: checked ?? true })
    return { ok: true }
  }

  async fill(ref: string, text: string): Promise<{ ok: true }> {
    this.bindGlobals()
    fillRef(ref, text)
    this.pushEvent('fill', { ref, text })
    return { ok: true }
  }

  async type(ref: string, text: string): Promise<{ ok: true }> {
    this.bindGlobals()
    typeRef(ref, text)
    this.pushEvent('type', { ref, text })
    return { ok: true }
  }

  async select(ref: string, value?: string): Promise<{ ok: true }> {
    this.bindGlobals()
    selectRef(ref, value)
    this.pushEvent('select', value === undefined ? { ref } : { ref, value })
    return { ok: true }
  }

  async upload(ref: string, files: UploadFile[]): Promise<{ ok: true }> {
    this.bindGlobals()
    uploadRef(ref, files)
    this.pushEvent('upload', { ref, files })
    return { ok: true }
  }

  async inspect(ref: string): Promise<InspectResult> {
    this.bindGlobals()
    return inspectRef(ref)
  }

  async evaluate(code: string): Promise<EvalResult> {
    this.bindGlobals()
    return evalResultAsync(this.dom.window.eval(code))
  }

  async press(key: string, options: { ref?: string; modifiers?: KeyModifier[] } = {}): Promise<{ ok: true }> {
    this.bindGlobals()
    if (options.ref) {
      focusRef(options.ref)
    }
    pressKey(key, this.dom.window.document, { modifiers: options.modifiers })
    this.pushEvent('press', pressDetail(key, options))
    return { ok: true }
  }

  async shot(options: ShotParams = {}): Promise<ScreenshotResult> {
    this.bindGlobals()
    const backend = options.backend ?? 'dom'
    if (backend === 'native') {
      throw new Error('native screenshot backend requires a live Tauri window')
    }
    const path = options.path
    const element = options.ref
      ? resolveRef(options.ref, snapshotDocument(this.dom.window.document).refs)
      : undefined
    const screenshot = screenshotDocument(this.dom.window.document, { path, element })
    const result = path
      ? { path, mime: screenshot.mime, width: screenshot.width, height: screenshot.height }
      : screenshot
    if (path) {
      await mkdir(dirname(path), { recursive: true })
      await writeFile(path, Buffer.from(requiredDataUrlBody(screenshot.dataUrl), 'base64'))
    }
    this.pushEvent('shot', result)
    return result
  }

  async state(key?: string): Promise<unknown> {
    const values: Record<string, string | boolean> = {}
    for (const input of Array.from(this.dom.window.document.querySelectorAll('input, textarea, select'))) {
      const control = input as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement
      values[this.controlName(control)] =
        control instanceof this.dom.window.HTMLInputElement &&
        (control.type === 'checkbox' || control.type === 'radio')
          ? control.checked
          : control.value
    }

    const state = {
      url: this.dom.window.location.href,
      title: this.title,
      values
    }
    return stateValue(state, key)
  }

  async dialog(params: DialogParams = {}): Promise<DialogResult> {
    return this.dialogController.handle(params)
  }

  async wait(options: WaitParams = {}): Promise<WaitResult> {
    const startedAt = Date.now()
    const timeoutMs = options.timeoutMs ?? 1000
    const wantAbsent = options.state === 'absent'
    const semantic = hasSemanticWaitFilter(options)
    if (options.networkIdle) {
      // The static jsdom adapter has no live request model, so it is always idle.
      this.pushEvent('wait', { networkIdle: true })
      return { matched: true, text: '' }
    }
    if (options.fn) {
      return this.waitForFunction(options.fn, startedAt, timeoutMs)
    }
    if (!semantic && !options.text) {
      throw new Error('wait requires text, a semantic filter, fn, or networkIdle')
    }

    while (Date.now() - startedAt <= timeoutMs) {
      this.bindGlobals()
      if (semantic) {
        const snapshot = snapshotDocument(this.dom.window.document, { scope: options.scope })
        const match = findRefs({ ...options, limit: 1 }, snapshot.refs)[0]
        if (wantAbsent ? !match : Boolean(match)) {
          this.pushEvent('wait', match ? waitEventDetail(options, match) : { absent: true })
          return match ? { matched: true, text: match.text, match } : { matched: true, text: '' }
        }
      } else {
        const present = (this.dom.window.document.body.textContent ?? '').includes(
          options.text as string
        )
        if (wantAbsent ? !present : present) {
          this.pushEvent(
            'wait',
            wantAbsent ? { text: options.text, absent: true } : { text: options.text }
          )
          return { matched: true, text: options.text as string }
        }
      }
      await new Promise((resolve) => setTimeout(resolve, Math.min(10, timeoutMs)))
    }
    throw new Error(waitTimeoutMessage(options, wantAbsent, semantic))
  }

  private async waitForFunction(fn: string, startedAt: number, timeoutMs: number): Promise<WaitResult> {
    while (Date.now() - startedAt <= timeoutMs) {
      this.bindGlobals()
      let raw: unknown = this.dom.window.eval(fn)
      if (raw && typeof (raw as { then?: unknown }).then === 'function') {
        raw = await (raw as PromiseLike<unknown>)
      }
      if (raw) {
        this.pushEvent('wait', { fn })
        return { matched: true, text: evalResult(raw).text }
      }
      await new Promise((resolve) => setTimeout(resolve, Math.min(10, timeoutMs)))
    }
    throw new Error(`wait timed out for function: ${fn}`)
  }

  getLogs(params: LogsParams = {}): CaptureResult<LogEntry> {
    return this.logs.read(params)
  }

  getEvents(params: EventsParams = {}): CaptureResult<AgentEvent> {
    return this.events.read(params)
  }

  getNetwork(params: NetworkParams & { id: string }): DetailResult<NetworkDetail>
  getNetwork(params?: NetworkParams): CaptureResult<NetworkEntry>
  getNetwork(params: NetworkParams = {}): CaptureResult<NetworkEntry> | DetailResult<NetworkDetail> {
    if (params.id !== undefined) {
      unavailableDetail(params)
    }
    return this.network.read(params)
  }

  // The static jsdom adapter has no Tauri IPC channel, so it captures nothing;
  // the method exists for surface parity with the live guest instrumentation.
  async ipc(params: IpcParams & { id: string }): Promise<DetailResult<IpcDetail>>
  async ipc(params?: IpcParams): Promise<CaptureResult<IpcEntry>>
  async ipc(params: IpcParams = {}): Promise<CaptureResult<IpcEntry> | DetailResult<IpcDetail>> {
    if (params.id !== undefined) {
      unavailableDetail(params)
    }
    return { entries: [], cursor: params.since ?? 0, dropped: false }
  }

  storage(options: StorageParams = {}): StorageResult {
    const area = storageArea(options.area)
    const store = this.storageAreas[area]
    applyStorageAction(store, options)
    return storageResult(store, area, options.key)
  }

  cookies(options: CookieParams = {}): CookieResult {
    applyCookieAction(this.dom.window.document, options)
    return cookieResult(this.dom.window.document, options.name)
  }

  location(options: LocationParams = {}): LocationResult {
    applyLocationAction(this.dom, options)
    return locationResult(this.dom.window.location)
  }

  addLog(level: LogEntry['level'], message: string): void {
    this.logs.push({
      level,
      message,
      window: this.label,
      timestamp: new Date().toISOString()
    })
  }

  private pushEvent(kind: string, detail?: unknown): void {
    this.events.push({
      kind,
      detail,
      window: this.label,
      timestamp: new Date().toISOString(),
      ...(this.activeTraceId ? { traceId: this.activeTraceId } : {})
    })
  }

  private controlName(control: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement): string {
    return (
      control.getAttribute('aria-label') ??
      control.getAttribute('name') ??
      control.getAttribute('placeholder') ??
      control.id ??
      'value'
    )
  }

  private bindGlobals(): void {
    globalThis.document = this.dom.window.document
    globalThis.Element = this.dom.window.Element
    globalThis.Document = this.dom.window.Document
    globalThis.Event = this.dom.window.Event
    globalThis.HTMLInputElement = this.dom.window.HTMLInputElement
    globalThis.HTMLOptionElement = this.dom.window.HTMLOptionElement
    globalThis.HTMLSelectElement = this.dom.window.HTMLSelectElement
    globalThis.HTMLTextAreaElement = this.dom.window.HTMLTextAreaElement
    globalThis.KeyboardEvent = this.dom.window.KeyboardEvent
    globalThis.InputEvent = this.dom.window.InputEvent
    globalThis.MouseEvent = this.dom.window.MouseEvent
    globalThis.Node = this.dom.window.Node
    this.bindStorageGlobals()
  }

  private bindStorageGlobals(): void {
    defineStorage(this.dom.window, 'localStorage', this.storageAreas.local)
    defineStorage(this.dom.window, 'sessionStorage', this.storageAreas.session)
    defineStorage(globalThis, 'localStorage', this.storageAreas.local)
    defineStorage(globalThis, 'sessionStorage', this.storageAreas.session)
  }

  private installRuntimeLogCapture(): void {
    this.dom.window.addEventListener(
      'error',
      (event) => {
        this.addLog('error', `Uncaught error: ${runtimeErrorMessage(event)}`)
      },
      { capture: true }
    )
    this.dom.window.addEventListener(
      'unhandledrejection',
      (event) => {
        this.addLog('error', `Unhandled rejection: ${errorLikeMessage((event as PromiseRejectionEvent).reason)}`)
      },
      { capture: true }
    )
  }
}

function unavailableDetail(params: NetworkParams | IpcParams): never {
  if (!params.id?.trim()) throw new AgentProtocolError('INVALID_PARAMS', 'id must be a non-empty string')
  if (params.clear || params.since !== undefined || params.limit !== undefined) {
    throw new AgentProtocolError('INVALID_PARAMS', 'id cannot be combined with capture list options')
  }
  throw new AgentProtocolError('CAPTURE_NOT_FOUND', `capture detail not retained: ${params.id}`)
}

function requiredDataUrlBody(dataUrl: string | undefined): string {
  if (!dataUrl?.startsWith('data:')) {
    throw new Error('missing screenshot data URL')
  }
  const [, body] = dataUrl.split(',', 2)
  if (!body) {
    throw new Error('invalid screenshot data URL')
  }
  return body
}

function actionDetail(detail: Record<string, string | number | undefined>): Record<string, string | number> {
  return Object.fromEntries(
    Object.entries(detail).filter((entry): entry is [string, string | number] => entry[1] !== undefined)
  )
}

function pressDetail(key: string, options: { ref?: string; modifiers?: KeyModifier[] }): Record<string, unknown> {
  return {
    key,
    ...(options.ref ? { ref: options.ref } : {}),
    ...(options.modifiers?.length ? { modifiers: options.modifiers } : {})
  }
}

function requiredFiniteNumber(value: number | undefined, name: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`window action requires finite ${name}`)
  }
  return value
}

function requiredPositiveNumber(value: number | undefined, name: string): number {
  const number = requiredFiniteNumber(value, name)
  if (number <= 0) {
    throw new Error(`window action requires positive ${name}`)
  }
  return number
}

function createMemoryStorage(): Storage {
  const values = new Map<string, string>()
  return {
    get length() {
      return values.size
    },
    clear() {
      values.clear()
    },
    getItem(key: string) {
      return values.get(String(key)) ?? null
    },
    key(index: number) {
      return [...values.keys()][index] ?? null
    },
    removeItem(key: string) {
      values.delete(String(key))
    },
    setItem(key: string, value: string) {
      values.set(String(key), String(value))
    }
  }
}

function defineStorage(target: object, key: 'localStorage' | 'sessionStorage', storage: Storage): void {
  Object.defineProperty(target, key, {
    configurable: true,
    enumerable: true,
    value: storage
  })
}

function applyLocationAction(dom: JSDOM, options: LocationParams): void {
  const action = options.action ?? 'get'
  switch (action) {
    // reload/back/forward have no observable effect in the static jsdom adapter
    // (no real history/navigation); they exist for surface parity.
    case 'get':
    case 'reload':
    case 'back':
    case 'forward':
      return
    case 'push':
    case 'replace': {
      const href = new URL(requiredLocationUrl(options.url), dom.window.location.href).href
      dom.reconfigure({ url: href })
      dom.window.dispatchEvent(new dom.window.PopStateEvent('popstate'))
      return
    }
  }
}

function stringActionValue(params: ActParams): string {
  return typeof params.value === 'string' ? params.value : ''
}

function staticPlatform(): AttachResult['platform'] {
  switch (process.platform) {
    case 'linux': return 'linux'
    case 'darwin': return 'macos'
    case 'win32': return 'windows'
    default: return 'unknown'
  }
}
