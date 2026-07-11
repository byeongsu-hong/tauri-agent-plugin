import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { getCurrentWindow } from '@tauri-apps/api/window'
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
  resolveRef,
  scrollRef,
  selectRef,
  snapshotDocument,
  typeRef,
  uploadRef,
  type DragOptions,
  type ScrollOptions,
  type SnapshotOptions,
  type SnapshotResult,
  type UploadFile
} from './semantic-tree'
import { screenshotDocument, type ScreenshotOptions } from './screenshot'
import { evalResult, evalResultAsync } from './evaluate'
import { deferDirectAgentInvokes } from './bridge-gate'
import { SemanticStream } from './semantic-stream'
import { CaptureBuffer } from './capture-buffer'
import { locateActionable } from './locator-action'
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
} from './dom-actions'
import type {
  ActParams,
  ActResult,
  AgentEvent,
  AgentMethod,
  CaptureResult,
  CookieParams,
  CookieResult,
  DialogParams,
  DialogResult,
  EvalResult,
  ExpectParams,
  ExpectResult,
  FindParams,
  FindResult,
  InspectResult,
  IpcEntry,
  IpcParams,
  LocationParams,
  LocationResult,
  LogsParams,
  LogEntry,
  KeyModifier,
  EventsParams,
  NetworkEntry,
  NetworkParams,
  RecordingEntry,
  ScreenshotResult,
  StorageParams,
  StorageResult,
  StreamParams,
  StreamResult,
  WaitParams,
  WaitResult
} from '../protocol/types'

const BRIDGE_REQUEST_EVENT = 'tauri-agent://request'

export interface InstrumentationOptions {
  windowLabel?: string
  state?: Record<string, () => unknown>
}

export interface InstrumentedAction {
  action:
    | 'click'
    | 'hover'
    | 'focus'
    | 'blur'
    | 'scroll'
    | 'drag'
    | 'fill'
    | 'type'
    | 'press'
    | 'select'
    | 'check'
    | 'upload'
  ref?: string
  toRef?: string
  files?: UploadFile[]
  /**
   * Internal payload slot. `serializableAction` maps it onto the canonical wire
   * param for the method: `text` for fill/type, `key` for press, `value` for
   * select — so recorded entries replay unchanged on any surface.
   */
  value?: string
  checked?: boolean
  modifiers?: KeyModifier[]
  x?: number
  y?: number
}

type ConsoleMethod = 'log' | 'debug' | 'info' | 'warn' | 'error'

// `console.log` — the most common call — maps to info level. Ordered so the
// captured level is meaningful.
const CONSOLE_LEVELS: ReadonlyArray<[ConsoleMethod, LogEntry['level']]> = [
  ['log', 'info'],
  ['debug', 'debug'],
  ['info', 'info'],
  ['warn', 'warn'],
  ['error', 'error']
]

/** Maximum entries retained per capture buffer before old entries drop. */
const MAX_CAPTURE_ENTRIES = 1000

function formatConsoleArgs(args: unknown[]): string {
  return args.map(formatConsoleArg).join(' ')
}

function formatConsoleArg(value: unknown): string {
  if (typeof value === 'string') {
    return value
  }
  if (value instanceof Error) {
    return value.stack ?? value.message
  }
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
  }
}

function pushCapped<T>(buffer: T[], entry: T, max = MAX_CAPTURE_ENTRIES): void {
  buffer.push(entry)
  if (buffer.length > max) {
    buffer.shift()
  }
}

interface AgentBridgeRequest {
  id: string
  method: AgentMethod
  params?: Record<string, unknown>
}

export class WebviewAgentInstrumentation {
  private installed = false
  private bridgeInstalled = false
  private bridgeUnlisten?: UnlistenFn
  private capturedLogs = new CaptureBuffer<LogEntry>(MAX_CAPTURE_ENTRIES)
  private capturedEvents = new CaptureBuffer<AgentEvent>(MAX_CAPTURE_ENTRIES)
  private capturedNetwork = new CaptureBuffer<NetworkEntry>(MAX_CAPTURE_ENTRIES)
  private capturedIpc = new CaptureBuffer<IpcEntry>(MAX_CAPTURE_ENTRIES)
  private ipcEntryId = 0
  private ipcTarget?: TauriInternals
  private originalInvoke?: TauriInternals['invoke']
  private recording = false
  private recordingEntries: RecordingEntry[] = []
  private readonly originalConsole = new Map<ConsoleMethod, typeof console.info>()
  private originalFetch?: typeof window.fetch
  private originalXhrOpen?: XMLHttpRequest['open']
  private originalXhrSend?: XMLHttpRequest['send']
  private originalWebSocket?: typeof WebSocket
  private networkEntryId = 0
  /** In-flight fetch/XHR count, used by `wait({ networkIdle: true })`. */
  private inFlightRequests = 0
  private readonly dialogController = new DialogController((entry) =>
    this.pushEvent('dialog', { type: entry.type, message: entry.message, response: entry.response })
  )
  private semanticStream?: SemanticStream
  private streamObserver?: MutationObserver
  private readonly handleRuntimeError = (event: ErrorEvent): void => {
    this.pushLog('error', `Uncaught error: ${runtimeErrorMessage(event)}`)
  }
  private readonly handleUnhandledRejection = (event: PromiseRejectionEvent): void => {
    this.pushLog('error', `Unhandled rejection: ${errorLikeMessage(event.reason)}`)
  }

  constructor(private readonly options: InstrumentationOptions = {}) {}

  install(): void {
    if (this.installed) {
      return
    }
    this.installed = true
    for (const [method, level] of CONSOLE_LEVELS) {
      this.originalConsole.set(method, console[method])
      console[method] = (...args: unknown[]) => {
        this.pushLog(level, formatConsoleArgs(args))
        this.originalConsole.get(method)?.apply(console, args)
      }
    }
    this.installNetworkCapture()
    this.installXhrCapture()
    this.installWebSocketCapture()
    this.installIpcCapture()
    this.dialogController.install(window as unknown as DialogWindow)
    this.installSemanticStream()
    window.addEventListener('error', this.handleRuntimeError, { capture: true })
    window.addEventListener('unhandledrejection', this.handleUnhandledRejection, { capture: true })
    window.__TAURI_AGENT__ = this
    this.installBridge()
  }

  dispose(): void {
    for (const [level, original] of this.originalConsole.entries()) {
      console[level] = original
    }
    this.originalConsole.clear()
    if (this.originalFetch) {
      window.fetch = this.originalFetch
      this.originalFetch = undefined
    }
    if (this.originalXhrOpen && this.originalXhrSend && typeof window.XMLHttpRequest === 'function') {
      window.XMLHttpRequest.prototype.open = this.originalXhrOpen
      window.XMLHttpRequest.prototype.send = this.originalXhrSend
      this.originalXhrOpen = undefined
      this.originalXhrSend = undefined
    }
    if (this.originalWebSocket) {
      window.WebSocket = this.originalWebSocket
      this.originalWebSocket = undefined
    }
    if (this.ipcTarget && this.originalInvoke) {
      this.ipcTarget.invoke = this.originalInvoke
      this.ipcTarget = undefined
      this.originalInvoke = undefined
    }
    this.dialogController.dispose(window as unknown as DialogWindow)
    window.removeEventListener('error', this.handleRuntimeError, { capture: true })
    window.removeEventListener('unhandledrejection', this.handleUnhandledRejection, { capture: true })
    this.streamObserver?.disconnect()
    this.streamObserver = undefined
    this.semanticStream = undefined
    this.bridgeUnlisten?.()
    this.bridgeUnlisten = undefined
    this.bridgeInstalled = false
    this.installed = false
  }

  snapshot(options: SnapshotOptions = {}): SnapshotResult {
    return snapshotDocument(document, options)
  }

  /**
   * Drain the mutation-driven semantic-tree diff stream. Frames after
   * `params.since` are returned; when none are buffered the call long-polls up
   * to `params.timeoutMs` for the next DOM mutation. Capture is driven by a
   * `MutationObserver`, so there is no polling at the source.
   */
  stream(params: StreamParams = {}): Promise<StreamResult> {
    return this.ensureSemanticStream().wait(params.since, params.timeoutMs ?? 0, params.lean ?? false)
  }

  private ensureSemanticStream(): SemanticStream {
    if (!this.semanticStream) {
      this.semanticStream = new SemanticStream({ capture: () => this.snapshot().text })
      this.semanticStream.prime()
    }
    return this.semanticStream
  }

  private installSemanticStream(): void {
    const stream = this.ensureSemanticStream()
    if (typeof MutationObserver === 'undefined') {
      return
    }
    // MutationObserver already coalesces a burst of mutations into one callback
    // per microtask checkpoint, so tick() runs at most once per batch.
    this.streamObserver = new MutationObserver(() => stream.tick())
    this.streamObserver.observe(document, {
      subtree: true,
      childList: true,
      attributes: true,
      characterData: true
    })
  }

  find(options: FindParams = {}): FindResult {
    const snapshot = this.snapshot({ scope: options.scope })
    return { matches: findRefs(options, snapshot.refs) }
  }

  async act(params: ActParams): Promise<ActResult> {
    const match = await locateActionable(
      params,
      (locator) => this.find(locator).matches,
      (candidate) => ['click', 'hover'].includes(params.action) ? this.stable(candidate) : Promise.resolve(true)
    )
    const action: InstrumentedAction = {
      action: params.action,
      ref: match?.ref,
      value: typeof params.value === 'string' ? params.value : undefined,
      checked: typeof params.value === 'boolean' ? params.value : undefined,
      x: params.x,
      y: params.y
    }
    const result = this.action(action, false)
    if (this.recording) {
      pushCapped(this.recordingEntries, {
        method: 'act',
        params: { ...params },
        timestamp: new Date().toISOString()
      })
    }
    return { ...result, ...(params.detail && match ? { match } : {}) }
  }

  private async stable(match: InspectResult): Promise<boolean> {
    try {
      const element = resolveRef(match.ref)
      const before = element.getBoundingClientRect()
      await new Promise((resolve) => setTimeout(resolve, 16))
      const after = element.getBoundingClientRect()
      return element.isConnected
        && before.x === after.x && before.y === after.y
        && before.width === after.width && before.height === after.height
    } catch {
      return false
    }
  }

  expect(options: ExpectParams): ExpectResult {
    const snapshot = this.snapshot({ scope: options.scope })
    const match = findRefs(
      { scope: options.scope, role: options.role, name: options.name, text: options.text, limit: 1 },
      snapshot.refs
    )[0]
    return assertExpectation(match, options)
  }

  action(action: InstrumentedAction, record = true): { ok: true } {
    switch (action.action) {
      case 'click':
        clickRef(requiredRef(action.ref))
        break
      case 'hover':
        hoverRef(requiredRef(action.ref))
        break
      case 'focus':
        focusRef(requiredRef(action.ref))
        break
      case 'blur':
        blurRef(requiredRef(action.ref))
        break
      case 'scroll':
        scrollRef(requiredRef(action.ref), { x: action.x, y: action.y })
        break
      case 'drag':
        dragRef(requiredRef(action.ref), { toRef: action.toRef })
        break
      case 'fill':
        fillRef(requiredRef(action.ref), action.value ?? '')
        break
      case 'type':
        typeRef(requiredRef(action.ref), action.value ?? '')
        break
      case 'press':
        if (action.ref) {
          focusRef(action.ref)
        }
        pressKey(action.value ?? '', document, { modifiers: action.modifiers })
        break
      case 'select':
        selectRef(requiredRef(action.ref), action.value)
        break
      case 'check':
        checkRef(requiredRef(action.ref), action.checked ?? true)
        break
    }

    this.pushEvent(action.action, serializableAction(action))
    if (record) this.recordAction(action)
    return { ok: true }
  }

  inspect(ref: string): InspectResult {
    return inspectRef(ref)
  }

  hover(ref: string): { ok: true } {
    hoverRef(ref)
    const action: InstrumentedAction = { action: 'hover', ref }
    this.pushEvent('hover', serializableAction(action))
    this.recordAction(action)
    return { ok: true }
  }

  focus(ref: string): { ok: true } {
    focusRef(ref)
    const action: InstrumentedAction = { action: 'focus', ref }
    this.pushEvent('focus', serializableAction(action))
    this.recordAction(action)
    return { ok: true }
  }

  blur(ref: string): { ok: true } {
    blurRef(ref)
    const action: InstrumentedAction = { action: 'blur', ref }
    this.pushEvent('blur', serializableAction(action))
    this.recordAction(action)
    return { ok: true }
  }

  scroll(ref: string, options: ScrollOptions = {}): { ok: true } {
    scrollRef(ref, options)
    const action: InstrumentedAction = { action: 'scroll', ref, x: options.x, y: options.y }
    this.pushEvent('scroll', serializableAction(action))
    this.recordAction(action)
    return { ok: true }
  }

  drag(ref: string, options: DragOptions = {}): { ok: true } {
    dragRef(ref, options)
    const action: InstrumentedAction = { action: 'drag', ref, toRef: options.toRef }
    this.pushEvent('drag', serializableAction(action))
    this.recordAction(action)
    return { ok: true }
  }

  select(ref: string, value?: string): { ok: true } {
    selectRef(ref, value)
    const action: InstrumentedAction = { action: 'select', ref, value }
    this.pushEvent('select', serializableAction(action))
    this.recordAction(action)
    return { ok: true }
  }

  check(ref: string, checked = true): { ok: true } {
    checkRef(ref, checked)
    const action: InstrumentedAction = { action: 'check', ref, checked }
    this.pushEvent('check', serializableAction(action))
    this.recordAction(action)
    return { ok: true }
  }

  upload(ref: string, files: UploadFile[]): { ok: true } {
    uploadRef(ref, files)
    const action: InstrumentedAction = { action: 'upload', ref, files }
    this.pushEvent('upload', serializableAction(action))
    this.recordAction(action)
    return { ok: true }
  }

  type(ref: string, text: string): { ok: true } {
    typeRef(ref, text)
    const action: InstrumentedAction = { action: 'type', ref, value: text }
    this.pushEvent('type', serializableAction(action))
    this.recordAction(action)
    return { ok: true }
  }

  evaluate(code: string): Promise<EvalResult> {
    return evalResultAsync(window.eval(code))
  }

  async wait(options: WaitParams): Promise<WaitResult> {
    const startedAt = Date.now()
    const timeoutMs = options.timeoutMs ?? 1000
    const wantAbsent = options.state === 'absent'
    const semantic = hasSemanticWaitFilter(options)
    if (options.networkIdle) {
      return this.waitForNetworkIdle(options, startedAt, timeoutMs)
    }
    if (options.fn) {
      return this.waitForFunction(options.fn, startedAt, timeoutMs)
    }
    if (!semantic && !options.text) {
      throw new Error('wait requires text, a semantic filter, fn, or networkIdle')
    }

    while (Date.now() - startedAt <= timeoutMs) {
      if (semantic) {
        const snapshot = this.snapshot({ scope: options.scope })
        const match = findRefs({ ...options, limit: 1 }, snapshot.refs)[0]
        if (wantAbsent ? !match : Boolean(match)) {
          this.pushEvent('wait', match ? waitEventDetail(options, match) : { absent: true })
          return match ? { matched: true, text: match.text, match } : { matched: true, text: '' }
        }
      } else {
        const present = (document.body.textContent ?? '').includes(options.text as string)
        if (wantAbsent ? !present : present) {
          this.pushEvent('wait', wantAbsent ? { text: options.text, absent: true } : { text: options.text })
          return { matched: true, text: options.text as string }
        }
      }
      await new Promise((resolve) => setTimeout(resolve, Math.min(10, timeoutMs)))
    }
    throw new Error(waitTimeoutMessage(options, wantAbsent, semantic))
  }

  private async waitForFunction(fn: string, startedAt: number, timeoutMs: number): Promise<WaitResult> {
    while (Date.now() - startedAt <= timeoutMs) {
      let raw: unknown = window.eval(fn)
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

  private async waitForNetworkIdle(
    options: WaitParams,
    startedAt: number,
    timeoutMs: number
  ): Promise<WaitResult> {
    const idleMs = options.idleMs ?? 500
    let idleSince: number | undefined = this.inFlightRequests === 0 ? startedAt : undefined
    while (Date.now() - startedAt <= timeoutMs) {
      if (this.inFlightRequests === 0) {
        idleSince ??= Date.now()
        if (Date.now() - idleSince >= idleMs) {
          this.pushEvent('wait', { networkIdle: true })
          return { matched: true, text: '' }
        }
      } else {
        idleSince = undefined
      }
      await new Promise((resolve) => setTimeout(resolve, Math.min(10, timeoutMs)))
    }
    throw new Error('wait timed out: network did not become idle')
  }

  state(key?: string): unknown {
    const values: Record<string, string | boolean> = {}
    for (const input of Array.from(document.querySelectorAll('input, textarea, select'))) {
      const control = input as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement
      values[controlName(control)] =
        control instanceof HTMLInputElement && (control.type === 'checkbox' || control.type === 'radio')
          ? control.checked
          : control.value
    }

    const probes: Record<string, unknown> = {}
    for (const [key, read] of Object.entries(this.options.state ?? {})) {
      probes[key] = read()
    }

    const state = {
      url: window.location.href,
      title: document.title,
      values,
      probes
    }
    return stateValue(state, key)
  }

  screenshot(options: ScreenshotOptions = {}): ScreenshotResult {
    if (options.ref) {
      return screenshotDocument(document, { ...options, element: resolveRef(options.ref) })
    }
    return screenshotDocument(document, options)
  }

  logs(): LogEntry[]
  logs(options: LogsParams): LogEntry[] | CaptureResult<LogEntry>
  logs(options: LogsParams = {}): LogEntry[] | CaptureResult<LogEntry> {
    return this.capturedLogs.read(options)
  }

  events(): AgentEvent[]
  events(options: EventsParams): AgentEvent[] | CaptureResult<AgentEvent>
  events(options: EventsParams = {}): AgentEvent[] | CaptureResult<AgentEvent> {
    return this.capturedEvents.read(options)
  }

  network(): NetworkEntry[]
  network(options: NetworkParams): NetworkEntry[] | CaptureResult<NetworkEntry>
  network(options: NetworkParams = {}): NetworkEntry[] | CaptureResult<NetworkEntry> {
    return this.capturedNetwork.read(options)
  }

  ipc(): IpcEntry[]
  ipc(options: IpcParams): IpcEntry[] | CaptureResult<IpcEntry>
  ipc(options: IpcParams = {}): IpcEntry[] | CaptureResult<IpcEntry> {
    return this.capturedIpc.read(options)
  }

  storage(options: StorageParams = {}): StorageResult {
    const area = storageArea(options.area)
    const store = area === 'session' ? window.sessionStorage : window.localStorage
    applyStorageAction(store, options)
    return storageResult(store, area, options.key)
  }

  cookies(options: CookieParams = {}): CookieResult {
    applyCookieAction(document, options)
    return cookieResult(document, options.name)
  }

  location(options: LocationParams = {}): LocationResult {
    applyLocationAction(options)
    return locationResult(window.location)
  }

  record(action: 'start' | 'stop' | 'get' | 'clear' = 'get'): Record<string, unknown> {
    switch (action) {
      case 'start':
        this.recording = true
        this.recordingEntries = []
        return { recording: true }
      case 'stop':
        this.recording = false
        return { recording: false, entries: [...this.recordingEntries] }
      case 'clear':
        this.recordingEntries = []
        return { recording: this.recording, entries: [] }
      case 'get':
        return { recording: this.recording, entries: [...this.recordingEntries] }
    }
  }

  private installBridge(): void {
    if (this.bridgeInstalled) {
      return
    }
    this.bridgeInstalled = true
    try {
      const bridgeListener = this.options.windowLabel
        ? listen<AgentBridgeRequest>(
            BRIDGE_REQUEST_EVENT,
            (event) => {
              void this.handleBridgeRequest(event.payload)
            },
            { target: { kind: 'Window', label: this.options.windowLabel } }
          )
        : getCurrentWindow().listen<AgentBridgeRequest>(BRIDGE_REQUEST_EVENT, (event) => {
            void this.handleBridgeRequest(event.payload)
          })

      void bridgeListener
        .then((unlisten) => {
          this.bridgeUnlisten = unlisten
        })
        .catch(() => {
          this.bridgeInstalled = false
        })
    } catch {
      this.bridgeInstalled = false
    }
  }

  private async handleBridgeRequest(request: AgentBridgeRequest): Promise<void> {
    const releaseDirectInvokes = deferDirectAgentInvokes()
    try {
      const result = await this.executeBridgeRequest(request)
      await invoke('plugin:agent|agent_bridge_response', {
        response: {
          id: request.id,
          result
        }
      })
    } catch (error) {
      await invoke('plugin:agent|agent_bridge_response', {
        response: {
          id: request.id,
          error: error instanceof Error ? error.message : String(error),
          ...(error instanceof AgentProtocolError ? { errorCode: error.code } : {})
        }
      })
    } finally {
      releaseDirectInvokes()
    }
  }

  private async executeBridgeRequest(request: AgentBridgeRequest): Promise<unknown> {
    const params = request.params ?? {}
    switch (request.method) {
      case 'tree':
        return { text: this.snapshot({ scope: stringParam(params, 'scope'), mode: modeParam(params) }).text }
      case 'find':
        return this.find({
          scope: stringParam(params, 'scope'),
          role: stringParam(params, 'role'),
          name: stringParam(params, 'name'),
          text: stringParam(params, 'text'),
          limit: numberParam(params, 'limit')
        })
      case 'act':
        return this.act({
          scope: stringParam(params, 'scope'),
          role: stringParam(params, 'role'),
          name: stringParam(params, 'name'),
          text: stringParam(params, 'text'),
          action: locatorActionParam(params),
          value: stringParam(params, 'value') ?? booleanParam(params, 'value'),
          x: numberParam(params, 'x'),
          y: numberParam(params, 'y'),
          timeoutMs: numberParam(params, 'timeoutMs')
        })
      case 'click':
        return this.action({ action: 'click', ref: requiredStringParam(params, 'ref') })
      case 'hover':
        return this.hover(requiredStringParam(params, 'ref'))
      case 'focus':
        return this.focus(requiredStringParam(params, 'ref'))
      case 'blur':
        return this.blur(requiredStringParam(params, 'ref'))
      case 'scroll':
        return this.scroll(requiredStringParam(params, 'ref'), {
          x: numberParam(params, 'x'),
          y: numberParam(params, 'y')
        })
      case 'drag':
        return this.drag(requiredStringParam(params, 'ref'), {
          toRef: stringParam(params, 'toRef')
        })
      case 'fill':
        return this.action({
          action: 'fill',
          ref: requiredStringParam(params, 'ref'),
          value: stringParam(params, 'text') ?? stringParam(params, 'value') ?? ''
        })
      case 'type':
        return this.type(
          requiredStringParam(params, 'ref'),
          stringParam(params, 'text') ?? stringParam(params, 'value') ?? ''
        )
      case 'select':
        return this.select(requiredStringParam(params, 'ref'), stringParam(params, 'value'))
      case 'check':
        return this.check(requiredStringParam(params, 'ref'), booleanParam(params, 'checked') ?? true)
      case 'upload':
        return this.upload(requiredStringParam(params, 'ref'), uploadFilesParam(params))
      case 'inspect':
        return this.inspect(requiredStringParam(params, 'ref'))
      case 'eval':
        return this.evaluate(requiredStringParam(params, 'code'))
      case 'press':
        return this.action({
          action: 'press',
          ref: stringParam(params, 'ref'),
          value: stringParam(params, 'key') ?? stringParam(params, 'value') ?? '',
          modifiers: modifierListParam(params, 'modifiers')
        })
      case 'shot':
        return this.screenshot({ path: stringParam(params, 'path'), ref: stringParam(params, 'ref') })
      case 'logs':
        return this.logs(captureParams(params))
      case 'events':
        return this.events(captureParams(params))
      case 'network':
        return this.network(captureParams(params))
      case 'ipc':
        return this.ipc(captureParams(params))
      case 'storage':
        return this.storage({
          area: storageAreaParam(params, 'area'),
          action: storageActionParam(params, 'action'),
          key: stringParam(params, 'key'),
          value: stringParam(params, 'value')
        })
      case 'cookies':
        return this.cookies({
          action: cookieActionParam(params, 'action'),
          name: stringParam(params, 'name'),
          value: stringParam(params, 'value')
        })
      case 'location':
        return this.location({
          action: locationActionParam(params, 'action'),
          url: stringParam(params, 'url')
        })
      case 'wait':
        return this.wait({
          text: stringParam(params, 'text'),
          scope: stringParam(params, 'scope'),
          role: stringParam(params, 'role'),
          name: stringParam(params, 'name'),
          timeoutMs: numberParam(params, 'timeoutMs'),
          state: stringParam(params, 'state') === 'absent' ? 'absent' : undefined,
          fn: stringParam(params, 'fn'),
          networkIdle: booleanParam(params, 'networkIdle'),
          idleMs: numberParam(params, 'idleMs')
        })
      case 'expect':
        return this.expect({
          scope: stringParam(params, 'scope'),
          role: stringParam(params, 'role'),
          name: stringParam(params, 'name'),
          text: stringParam(params, 'text'),
          present: booleanParam(params, 'present'),
          value: stringParam(params, 'value'),
          hasState: stringParam(params, 'hasState')
        })
      case 'state':
        return this.state(stringParam(params, 'key'))
      case 'dialog':
        return this.dialog({
          action: dialogActionParam(params),
          accept: booleanParam(params, 'accept'),
          promptText: stringParam(params, 'promptText')
        })
      case 'record':
        return this.record(recordActionParam(params))
      case 'stream':
        return this.stream({
          since: numberParam(params, 'since'),
          timeoutMs: numberParam(params, 'timeoutMs'),
          lean: booleanParam(params, 'lean')
        })
      default:
        throw new Error(`unsupported agent bridge method: ${request.method}`)
    }
  }

  private pushLog(level: LogEntry['level'], message: string): void {
    this.capturedLogs.push({
      level,
      message,
      timestamp: new Date().toISOString()
    })
  }

  private pushEvent(kind: string, detail?: unknown): void {
    this.capturedEvents.push({
      kind,
      detail,
      timestamp: new Date().toISOString()
    })
  }

  private installNetworkCapture(): void {
    if (typeof window.fetch !== 'function' || this.originalFetch) {
      return
    }
    const originalFetch = window.fetch
    this.originalFetch = originalFetch

    window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const startedAtMs = Date.now()
      const url = fetchUrl(input)
      if (isTauriIpcUrl(url)) {
        return originalFetch.call(window, input, init)
      }
      const entry: NetworkEntry = {
        id: `fetch-${++this.networkEntryId}`,
        type: 'fetch',
        method: fetchMethod(input, init),
        url,
        startedAt: new Date(startedAtMs).toISOString()
      }
      const requestBodySize = bodySize(requestBody(input, init))
      if (requestBodySize !== undefined) {
        entry.requestBodySize = requestBodySize
      }
      this.capturedNetwork.push(entry)
      this.inFlightRequests++

      try {
        const response = await originalFetch.call(window, input, init)
        entry.status = response.status
        entry.ok = response.ok
        const responseBodySize = await clonedResponseBodySize(response)
        if (responseBodySize !== undefined) {
          entry.responseBodySize = responseBodySize
        }
        finishNetworkEntry(entry, startedAtMs)
        return response
      } catch (error) {
        entry.error = error instanceof Error ? error.message : String(error)
        finishNetworkEntry(entry, startedAtMs)
        throw error
      } finally {
        this.inFlightRequests = Math.max(0, this.inFlightRequests - 1)
      }
    }
  }

  private installXhrCapture(): void {
    const XHR = window.XMLHttpRequest
    if (typeof XHR !== 'function' || this.originalXhrOpen) {
      return
    }
    const capture = this
    const openImpl = XHR.prototype.open
    const sendImpl = XHR.prototype.send
    this.originalXhrOpen = openImpl
    this.originalXhrSend = sendImpl

    XHR.prototype.open = function (
      this: XMLHttpRequest & { __agentNet?: { method: string; url: string } },
      method: string,
      url: string | URL,
      ...rest: unknown[]
    ) {
      this.__agentNet = { method: String(method ?? 'GET').toUpperCase(), url: resolveUrl(String(url)) }
      // eslint-disable-next-line prefer-rest-params
      return (openImpl as (...args: unknown[]) => void).apply(this, [method, url, ...rest])
    } as XMLHttpRequest['open']

    XHR.prototype.send = function (
      this: XMLHttpRequest & { __agentNet?: { method: string; url: string } },
      body?: Document | XMLHttpRequestBodyInit | null
    ) {
      const meta = this.__agentNet
      if (meta && !isTauriIpcUrl(meta.url)) {
        const startedAtMs = Date.now()
        const entry: NetworkEntry = {
          id: `xhr-${++capture.networkEntryId}`,
          type: 'xhr',
          method: meta.method,
          url: meta.url,
          startedAt: new Date(startedAtMs).toISOString()
        }
        const requestBodySize = bodySize(body as BodyInit | null | undefined)
        if (requestBodySize !== undefined) {
          entry.requestBodySize = requestBodySize
        }
        capture.capturedNetwork.push(entry)
        capture.inFlightRequests++
        let settled = false
        const settle = (): void => {
          if (settled) {
            return
          }
          settled = true
          capture.inFlightRequests = Math.max(0, capture.inFlightRequests - 1)
        }
        this.addEventListener('loadend', () => {
          entry.status = this.status
          entry.ok = this.status >= 200 && this.status < 400
          const responseBodySize = xhrResponseSize(this)
          if (responseBodySize !== undefined) {
            entry.responseBodySize = responseBodySize
          }
          finishNetworkEntry(entry, startedAtMs)
          settle()
        })
        this.addEventListener('error', () => {
          entry.error = 'XHR network error'
          finishNetworkEntry(entry, startedAtMs)
          settle()
        })
      }
      return (sendImpl as (this: XMLHttpRequest, body?: Document | XMLHttpRequestBodyInit | null) => void).call(
        this,
        body
      )
    } as XMLHttpRequest['send']
  }

  private installWebSocketCapture(): void {
    const OriginalWebSocket = window.WebSocket
    if (typeof OriginalWebSocket !== 'function' || this.originalWebSocket) {
      return
    }
    const capture = this
    this.originalWebSocket = OriginalWebSocket

    const Wrapped = function (this: unknown, url: string | URL, protocols?: string | string[]): WebSocket {
      const socket =
        protocols === undefined ? new OriginalWebSocket(url) : new OriginalWebSocket(url, protocols)
      const startedAtMs = Date.now()
      const entry: NetworkEntry = {
        id: `ws-${++capture.networkEntryId}`,
        type: 'websocket',
        method: 'GET',
        url: resolveUrl(typeof url === 'string' ? url : url.href),
        startedAt: new Date(startedAtMs).toISOString()
      }
      let sent = 0
      let received = 0
      capture.capturedNetwork.push(entry)
      socket.addEventListener('open', () => {
        entry.status = 101
        entry.ok = true
      })
      socket.addEventListener('message', (event: MessageEvent) => {
        received += messageSize(event.data)
        entry.responseBodySize = received
      })
      socket.addEventListener('error', () => {
        entry.error = 'WebSocket error'
        finishNetworkEntry(entry, startedAtMs)
      })
      socket.addEventListener('close', () => {
        finishNetworkEntry(entry, startedAtMs)
      })
      const originalSend = socket.send.bind(socket)
      socket.send = (data: string | ArrayBufferLike | Blob | ArrayBufferView): void => {
        sent += messageSize(data)
        entry.requestBodySize = sent
        originalSend(data)
      }
      return socket
    } as unknown as typeof WebSocket
    // Preserve the readyState constants and prototype so `instanceof` and
    // `WebSocket.OPEN` keep working through the wrapper.
    Wrapped.prototype = OriginalWebSocket.prototype
    const statics = Wrapped as unknown as Record<'CONNECTING' | 'OPEN' | 'CLOSING' | 'CLOSED', number>
    statics.CONNECTING = OriginalWebSocket.CONNECTING
    statics.OPEN = OriginalWebSocket.OPEN
    statics.CLOSING = OriginalWebSocket.CLOSING
    statics.CLOSED = OriginalWebSocket.CLOSED
    window.WebSocket = Wrapped
  }

  dialog(params: DialogParams = {}): DialogResult {
    return this.dialogController.handle(params)
  }

  private installIpcCapture(): void {
    const internals = window.__TAURI_INTERNALS__
    if (!internals || typeof internals.invoke !== 'function' || this.originalInvoke) {
      return
    }
    const originalInvoke = internals.invoke
    const original = internals.invoke.bind(internals)
    const wrappedInvoke = (command: string, args?: unknown, options?: unknown): Promise<unknown> => {
      const promise = original(command, args, options)
      // Skip the agent's own bridge traffic so tracing stays signal, not noise.
      if (typeof command === 'string' && !command.startsWith('plugin:agent|')) {
        const startedAtMs = Date.now()
        const entry: IpcEntry = {
          id: `ipc-${++this.ipcEntryId}`,
          command,
          startedAt: new Date(startedAtMs).toISOString()
        }
        this.capturedIpc.push(entry)
        Promise.resolve(promise).then(
          () => finishIpcEntry(entry, startedAtMs, true),
          (error: unknown) => {
            entry.error = error instanceof Error ? error.message : String(error)
            finishIpcEntry(entry, startedAtMs, false)
          }
        )
      }
      return promise
    }
    try {
      internals.invoke = wrappedInvoke
    } catch {
      // Tauri may expose this security-sensitive hook as read-only. IPC tracing
      // is optional, so do not prevent the rest of the agent from installing.
      return
    }
    this.ipcTarget = internals
    this.originalInvoke = originalInvoke
  }

  private recordAction(action: InstrumentedAction): void {
    if (!this.recording) {
      return
    }
    pushCapped(this.recordingEntries, {
      method: action.action,
      params: serializableAction(action),
      timestamp: new Date().toISOString()
    })
  }
}

interface TauriInternals {
  invoke: (command: string, args?: unknown, options?: unknown) => Promise<unknown>
}

declare global {
  interface Window {
    __TAURI_AGENT__?: WebviewAgentInstrumentation
    __TAURI_INTERNALS__?: TauriInternals
  }
}

function requiredRef(ref: string | undefined): string {
  if (!ref) {
    throw new Error('missing required ref')
  }
  return ref
}

function serializableAction(action: InstrumentedAction): Record<string, unknown> {
  const params: Record<string, unknown> = {}
  if (action.ref) params.ref = action.ref
  if (action.toRef) params.toRef = action.toRef
  if (action.value !== undefined && action.value.length > 0) {
    // Emit the canonical wire param for this method rather than the internal
    // `value` slot, so recordings replay through the daemon/protocol executors
    // (which read `text`/`key`/`value` per method) without translation.
    params[canonicalPayloadKey(action.action)] = action.value
  }
  if (action.checked !== undefined) params.checked = action.checked
  if (action.files) params.files = action.files
  if (action.modifiers?.length) params.modifiers = action.modifiers
  if (action.x !== undefined) params.x = action.x
  if (action.y !== undefined) params.y = action.y
  return params
}

function canonicalPayloadKey(action: InstrumentedAction['action']): 'text' | 'key' | 'value' {
  switch (action) {
    case 'fill':
    case 'type':
      return 'text'
    case 'press':
      return 'key'
    default:
      return 'value'
  }
}

function controlName(control: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement): string {
  return (
    control.getAttribute('aria-label') ??
    control.getAttribute('name') ??
    control.getAttribute('placeholder') ??
    control.id ??
    'value'
  )
}

function requiredStringParam(params: Record<string, unknown>, key: string): string {
  const value = stringParam(params, key)
  if (value === undefined) {
    throw new Error(`missing required param: ${key}`)
  }
  return value
}

function uploadFilesParam(params: Record<string, unknown>): UploadFile[] {
  const raw = params.files
  if (!Array.isArray(raw)) {
    throw new Error('upload requires a files array')
  }
  return raw.map((entry) => {
    if (!entry || typeof entry !== 'object') {
      throw new Error('each upload file must be an object with a name')
    }
    const record = entry as Record<string, unknown>
    if (typeof record.name !== 'string' || record.name.length === 0) {
      throw new Error('each upload file requires a name')
    }
    return {
      name: record.name,
      type: typeof record.type === 'string' ? record.type : undefined,
      text: typeof record.text === 'string' ? record.text : undefined
    }
  })
}

function stringParam(params: Record<string, unknown>, key: string): string | undefined {
  const value = params[key]
  return typeof value === 'string' ? value : undefined
}

function numberParam(params: Record<string, unknown>, key: string): number | undefined {
  const value = params[key]
  return typeof value === 'number' ? value : undefined
}

function booleanParam(params: Record<string, unknown>, key: string): boolean | undefined {
  const value = params[key]
  return typeof value === 'boolean' ? value : undefined
}

function captureParams(params: Record<string, unknown>): LogsParams {
  return {
    clear: booleanParam(params, 'clear'),
    since: numberParam(params, 'since'),
    limit: numberParam(params, 'limit')
  }
}

function locatorActionParam(params: Record<string, unknown>): ActParams['action'] {
  const value = stringParam(params, 'action')
  if (value && ['click', 'hover', 'focus', 'blur', 'fill', 'type', 'press', 'scroll', 'select', 'check'].includes(value)) {
    return value as ActParams['action']
  }
  throw new Error(`unknown locator action: ${String(value)}`)
}

function modifierListParam(params: Record<string, unknown>, key: string): KeyModifier[] | undefined {
  const value = params[key]
  if (value === undefined) {
    return undefined
  }
  if (!Array.isArray(value)) {
    throw new Error(`${key} must be an array`)
  }
  return value.map((modifier) => keyModifierParam(modifier, key))
}

function keyModifierParam(value: unknown, key: string): KeyModifier {
  if (value === 'Alt' || value === 'Control' || value === 'Meta' || value === 'Shift') {
    return value
  }
  throw new Error(`unknown ${key} value: ${String(value)}`)
}

function modeParam(params: Record<string, unknown>): SnapshotOptions['mode'] | undefined {
  const mode = params.mode
  return mode === 'compact' || mode === 'verbose' ? mode : undefined
}

function recordActionParam(params: Record<string, unknown>): 'start' | 'stop' | 'get' | 'clear' {
  const action = params.action
  return action === 'start' || action === 'stop' || action === 'clear' ? action : 'get'
}

function dialogActionParam(params: Record<string, unknown>): 'get' | 'set' | 'clear' {
  const action = params.action
  return action === 'set' || action === 'clear' ? action : 'get'
}

function fetchMethod(input: RequestInfo | URL, init?: RequestInit): string {
  const method = init?.method ?? (isRequest(input) ? input.method : undefined) ?? 'GET'
  return method.toUpperCase()
}

function fetchUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') {
    return new URL(input, window.location.href).href
  }
  if (input instanceof URL) {
    return input.href
  }
  if (isRequest(input)) {
    return input.url
  }
  return String(input)
}

function requestBody(input: RequestInfo | URL, init?: RequestInit): BodyInit | null | undefined {
  if (init?.body !== undefined) {
    return init.body
  }
  return isRequest(input) ? input.body : undefined
}

function bodySize(body: BodyInit | ReadableStream<Uint8Array> | null | undefined): number | undefined {
  if (body === null || body === undefined) {
    return undefined
  }
  if (typeof body === 'string') {
    return new TextEncoder().encode(body).byteLength
  }
  if (body instanceof URLSearchParams) {
    return new TextEncoder().encode(body.toString()).byteLength
  }
  if (body instanceof ArrayBuffer) {
    return body.byteLength
  }
  if (ArrayBuffer.isView(body)) {
    return body.byteLength
  }
  if (typeof Blob !== 'undefined' && body instanceof Blob) {
    return body.size
  }
  return undefined
}

function resolveUrl(url: string): string {
  try {
    return new URL(url, window.location.href).href
  } catch {
    return url
  }
}

function xhrResponseSize(xhr: XMLHttpRequest): number | undefined {
  try {
    if (typeof xhr.responseText === 'string') {
      return new TextEncoder().encode(xhr.responseText).byteLength
    }
  } catch {
    // responseText throws for non-text responseTypes; fall through.
  }
  const response: unknown = xhr.response
  if (typeof response === 'string') {
    return new TextEncoder().encode(response).byteLength
  }
  if (response instanceof ArrayBuffer) {
    return response.byteLength
  }
  if (typeof Blob !== 'undefined' && response instanceof Blob) {
    return response.size
  }
  return undefined
}

function messageSize(data: unknown): number {
  if (typeof data === 'string') {
    return new TextEncoder().encode(data).byteLength
  }
  if (data instanceof ArrayBuffer) {
    return data.byteLength
  }
  if (ArrayBuffer.isView(data)) {
    return data.byteLength
  }
  if (typeof Blob !== 'undefined' && data instanceof Blob) {
    return data.size
  }
  return 0
}

async function clonedResponseBodySize(response: Response): Promise<number | undefined> {
  try {
    const body = await response.clone().text()
    return new TextEncoder().encode(body).byteLength
  } catch {
    return undefined
  }
}

function finishNetworkEntry(entry: NetworkEntry, startedAtMs: number): void {
  const endedAtMs = Date.now()
  entry.endedAt = new Date(endedAtMs).toISOString()
  entry.durationMs = Math.max(0, endedAtMs - startedAtMs)
}

function finishIpcEntry(entry: IpcEntry, startedAtMs: number, ok: boolean): void {
  const endedAtMs = Date.now()
  entry.endedAt = new Date(endedAtMs).toISOString()
  entry.durationMs = Math.max(0, endedAtMs - startedAtMs)
  entry.ok = ok
}

function isRequest(value: RequestInfo | URL): value is Request {
  return typeof Request !== 'undefined' && value instanceof Request
}

function isTauriIpcUrl(url: string): boolean {
  return url.startsWith('ipc://localhost/')
}

function storageAreaParam(params: Record<string, unknown>, key: string): 'local' | 'session' | undefined {
  const value = params[key]
  return value === 'local' || value === 'session' ? value : undefined
}

function storageActionParam(
  params: Record<string, unknown>,
  key: string
): 'get' | 'set' | 'remove' | 'clear' | undefined {
  const value = params[key]
  return value === 'get' || value === 'set' || value === 'remove' || value === 'clear' ? value : undefined
}

function cookieActionParam(
  params: Record<string, unknown>,
  key: string
): 'get' | 'set' | 'remove' | 'clear' | undefined {
  const value = params[key]
  return value === 'get' || value === 'set' || value === 'remove' || value === 'clear' ? value : undefined
}

function locationActionParam(
  params: Record<string, unknown>,
  key: string
): LocationParams['action'] {
  const value = params[key]
  return value === 'get' ||
    value === 'push' ||
    value === 'replace' ||
    value === 'reload' ||
    value === 'back' ||
    value === 'forward'
    ? value
    : undefined
}

function applyLocationAction(options: LocationParams): void {
  const action = options.action ?? 'get'
  switch (action) {
    case 'get':
      return
    case 'push':
      window.history.pushState(null, '', requiredLocationUrl(options.url))
      window.dispatchEvent(new PopStateEvent('popstate'))
      return
    case 'replace':
      window.history.replaceState(null, '', requiredLocationUrl(options.url))
      window.dispatchEvent(new PopStateEvent('popstate'))
      return
    case 'reload':
      window.location.reload()
      return
    case 'back':
      window.history.back()
      return
    case 'forward':
      window.history.forward()
      return
  }
}
