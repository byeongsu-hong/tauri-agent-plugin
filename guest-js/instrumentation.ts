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
  DetailResult,
  EvalResult,
  ExpectParams,
  ExpectResult,
  FindParams,
  FindResult,
  InspectResult,
  IpcDetail,
  IpcEntry,
  IpcParams,
  LocationParams,
  LocationResult,
  LogsParams,
  LogEntry,
  KeyModifier,
  EventsParams,
  NetworkEntry,
  NetworkDetail,
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
const MAX_DETAIL_BYTES = 64 * 1024

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
  params?: unknown
}

interface NetworkDetailRecord {
  entry: NetworkEntry
  requestHeaders?: Record<string, string>
  requestBody?: unknown
  responseHeaders?: Record<string, string>
  responseBody?: unknown
}

interface IpcDetailRecord {
  entry: IpcEntry
  args?: unknown
  result?: unknown
}

export class WebviewAgentInstrumentation {
  private installed = false
  private bridgeInstalled = false
  private bridgeUnlisten?: UnlistenFn
  private capturedLogs = new CaptureBuffer<LogEntry>(MAX_CAPTURE_ENTRIES)
  private capturedEvents = new CaptureBuffer<AgentEvent>(MAX_CAPTURE_ENTRIES)
  private capturedNetwork = new CaptureBuffer<NetworkEntry>(MAX_CAPTURE_ENTRIES)
  private capturedIpc = new CaptureBuffer<IpcEntry>(MAX_CAPTURE_ENTRIES)
  private networkDetails = new Map<string, NetworkDetailRecord>()
  private ipcDetails = new Map<string, IpcDetailRecord>()
  private ipcEntryId = 0
  private actionTraceId = 0
  private activeTraceId?: string
  private ipcTarget?: TauriInternals
  private originalInvoke?: TauriInternals['invoke']
  private recording = false
  private recordingEntries: RecordingEntry[] = []
  private readonly originalConsole = new Map<ConsoleMethod, typeof console.info>()
  private originalFetch?: typeof window.fetch
  private originalXhrOpen?: XMLHttpRequest['open']
  private originalXhrSend?: XMLHttpRequest['send']
  private originalXhrSetRequestHeader?: XMLHttpRequest['setRequestHeader']
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
      if (this.originalXhrSetRequestHeader) {
        window.XMLHttpRequest.prototype.setRequestHeader = this.originalXhrSetRequestHeader
      }
      this.originalXhrOpen = undefined
      this.originalXhrSend = undefined
      this.originalXhrSetRequestHeader = undefined
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
    const result = this.actionWithTrace(action, false)
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
    const { traceId: _, ...result } = this.actionWithTrace(action, record)
    return result
  }

  private actionWithTrace(action: InstrumentedAction, record = true): ActResult {
    const previousTraceId = this.activeTraceId
    const traceId = `action-${++this.actionTraceId}`
    this.activeTraceId = traceId
    try {
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
          if (action.ref) focusRef(action.ref)
          pressKey(action.value ?? '', document, { modifiers: action.modifiers })
          break
        case 'select':
          selectRef(requiredRef(action.ref), action.value)
          break
        case 'check':
          checkRef(requiredRef(action.ref), action.checked ?? true)
          break
        case 'upload':
          uploadRef(requiredRef(action.ref), action.files ?? [])
          break
      }

      this.pushEvent(action.action, serializableAction(action))
      if (record) this.recordAction(action)
      return { ok: true, traceId }
    } finally {
      this.activeTraceId = previousTraceId
    }
  }

  inspect(ref: string): InspectResult {
    return inspectRef(ref)
  }

  hover(ref: string): { ok: true } {
    return this.action({ action: 'hover', ref })
  }

  focus(ref: string): { ok: true } {
    return this.action({ action: 'focus', ref })
  }

  blur(ref: string): { ok: true } {
    return this.action({ action: 'blur', ref })
  }

  scroll(ref: string, options: ScrollOptions = {}): { ok: true } {
    return this.action({ action: 'scroll', ref, x: options.x, y: options.y })
  }

  drag(ref: string, options: DragOptions = {}): { ok: true } {
    return this.action({ action: 'drag', ref, toRef: options.toRef })
  }

  select(ref: string, value?: string): { ok: true } {
    return this.action({ action: 'select', ref, value })
  }

  check(ref: string, checked = true): { ok: true } {
    return this.action({ action: 'check', ref, checked })
  }

  upload(ref: string, files: UploadFile[]): { ok: true } {
    return this.action({ action: 'upload', ref, files })
  }

  type(ref: string, text: string): { ok: true } {
    return this.action({ action: 'type', ref, value: text })
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

  logs(options: LogsParams = {}): CaptureResult<LogEntry> {
    return this.capturedLogs.read(options)
  }

  events(options: EventsParams = {}): CaptureResult<AgentEvent> {
    return this.capturedEvents.read(options)
  }

  network(options: NetworkParams & { id: string }): DetailResult<NetworkDetail>
  network(options?: NetworkParams): CaptureResult<NetworkEntry>
  network(options: NetworkParams = {}): CaptureResult<NetworkEntry> | DetailResult<NetworkDetail> {
    if (options.id !== undefined) return retainedDetail<NetworkDetail>(this.networkDetails, options)
    const result = this.capturedNetwork.read(options)
    if (options.clear) this.networkDetails.clear()
    return result
  }

  ipc(options: IpcParams & { id: string }): DetailResult<IpcDetail>
  ipc(options?: IpcParams): CaptureResult<IpcEntry>
  ipc(options: IpcParams = {}): CaptureResult<IpcEntry> | DetailResult<IpcDetail> {
    if (options.id !== undefined) return retainedDetail<IpcDetail>(this.ipcDetails, options)
    const result = this.capturedIpc.read(options)
    if (options.clear) this.ipcDetails.clear()
    return result
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
    if (
      request.params !== undefined &&
      (typeof request.params !== 'object' || request.params === null || Array.isArray(request.params))
    ) {
      throw new AgentProtocolError('INVALID_PARAMS', 'params must be an object')
    }
    const params = (request.params ?? {}) as Record<string, unknown>
    switch (request.method) {
      case 'tree':
        return { text: this.snapshot({ scope: stringParam(params, 'scope'), mode: modeParam(params) }).text }
      case 'find':
        return this.find({
          scope: stringParam(params, 'scope'),
          role: stringParam(params, 'role'),
          name: stringParam(params, 'name'),
          text: stringParam(params, 'text'),
          limit: unsignedIntegerParam(params, 'limit')
        })
      case 'act':
        return this.act({
          scope: stringParam(params, 'scope'),
          role: stringParam(params, 'role'),
          name: stringParam(params, 'name'),
          text: stringParam(params, 'text'),
          action: locatorActionParam(params),
          value: stringOrBooleanParam(params, 'value'),
          x: numberParam(params, 'x'),
          y: numberParam(params, 'y'),
          timeoutMs: unsignedIntegerParam(params, 'timeoutMs'),
          detail: booleanParam(params, 'detail')
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
          value: requiredStringParam(params, 'text')
        })
      case 'type':
        return this.type(
          requiredStringParam(params, 'ref'),
          requiredStringParam(params, 'text')
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
          value: requiredStringParam(params, 'key'),
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
          timeoutMs: unsignedIntegerParam(params, 'timeoutMs'),
          state: enumParam(params, 'state', ['present', 'absent'], 'wait state'),
          fn: stringParam(params, 'fn'),
          networkIdle: booleanParam(params, 'networkIdle'),
          idleMs: unsignedIntegerParam(params, 'idleMs')
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
          since: unsignedIntegerParam(params, 'since'),
          timeoutMs: unsignedIntegerParam(params, 'timeoutMs'),
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
      timestamp: new Date().toISOString(),
      ...(this.activeTraceId ? { traceId: this.activeTraceId } : {})
    })
  }

  private pushEvent(kind: string, detail?: unknown): void {
    this.capturedEvents.push({
      kind,
      detail,
      timestamp: new Date().toISOString(),
      ...(this.activeTraceId ? { traceId: this.activeTraceId } : {})
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
      const ipcCommand = tauriIpcCommand(url)
      if (ipcCommand !== undefined) {
        // ponytail: Tauri isolation/postMessage stays opaque; add a native interceptor if that mode needs tracing.
        if (!ipcCommand || ipcCommand.startsWith('plugin:agent|') || this.originalInvoke) {
          return originalFetch.call(window, input, init)
        }
        const entry: IpcEntry = {
          id: `ipc-${++this.ipcEntryId}`,
          command: ipcCommand,
          startedAt: new Date(startedAtMs).toISOString(),
          ...(this.activeTraceId ? { traceId: this.activeTraceId } : {})
        }
        const detail: IpcDetailRecord = { entry }
        setCapped(this.ipcDetails, entry.id, detail)
        this.capturedIpc.push(entry)
        void fetchRequestDetail(input, init).then(({ body }) => {
          if (body !== undefined) detail.args = body
        })
        try {
          const response = await originalFetch.call(window, input, init)
          const captured = await clonedResponseDetail(response)
          if (captured.body !== undefined) detail.result = captured.body
          finishIpcEntry(entry, startedAtMs, response.ok && response.headers.get('Tauri-Response') !== 'error')
          return response
        } catch (error) {
          entry.error = error instanceof Error ? error.message : String(error)
          finishIpcEntry(entry, startedAtMs, false)
          throw error
        }
      }
      const entry: NetworkEntry = {
        id: `fetch-${++this.networkEntryId}`,
        type: 'fetch',
        method: fetchMethod(input, init),
        url: redactUrl(url),
        startedAt: new Date(startedAtMs).toISOString(),
        ...(this.activeTraceId ? { traceId: this.activeTraceId } : {})
      }
      const detail: NetworkDetailRecord = {
        entry,
        requestHeaders: redactedHeaders(fetchRequestHeaders(input, init))
      }
      setCapped(this.networkDetails, entry.id, detail)
      void fetchRequestDetail(input, init).then((captured) => {
        if (captured.body !== undefined) detail.requestBody = captured.body
        if (entry.requestBodySize === undefined && captured.size !== undefined) {
          entry.requestBodySize = captured.size
        }
      })
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
        detail.responseHeaders = redactedHeaders(response.headers)
        const captured = await clonedResponseDetail(response)
        if (captured.size !== undefined) entry.responseBodySize = captured.size
        if (captured.body !== undefined) detail.responseBody = captured.body
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
    const setRequestHeaderImpl = XHR.prototype.setRequestHeader
    this.originalXhrOpen = openImpl
    this.originalXhrSend = sendImpl

    XHR.prototype.open = function (
      this: XMLHttpRequest & { __agentNet?: { method: string; url: string; headers: Record<string, string> } },
      method: string,
      url: string | URL,
      ...rest: unknown[]
    ) {
      this.__agentNet = {
        method: String(method ?? 'GET').toUpperCase(),
        url: resolveUrl(String(url)),
        headers: {}
      }
      // eslint-disable-next-line prefer-rest-params
      return (openImpl as (...args: unknown[]) => void).apply(this, [method, url, ...rest])
    } as XMLHttpRequest['open']

    if (typeof setRequestHeaderImpl === 'function') {
      this.originalXhrSetRequestHeader = setRequestHeaderImpl
      XHR.prototype.setRequestHeader = function (
        this: XMLHttpRequest & { __agentNet?: { headers: Record<string, string> } },
        name: string,
        value: string
      ): void {
        if (this.__agentNet) this.__agentNet.headers[name] = value
        setRequestHeaderImpl.call(this, name, value)
      }
    }

    XHR.prototype.send = function (
      this: XMLHttpRequest & { __agentNet?: { method: string; url: string; headers: Record<string, string> } },
      body?: Document | XMLHttpRequestBodyInit | null
    ) {
      const meta = this.__agentNet
      if (meta && tauriIpcCommand(meta.url) === undefined) {
        const startedAtMs = Date.now()
        const entry: NetworkEntry = {
          id: `xhr-${++capture.networkEntryId}`,
          type: 'xhr',
          method: meta.method,
          url: redactUrl(meta.url),
          startedAt: new Date(startedAtMs).toISOString(),
          ...(capture.activeTraceId ? { traceId: capture.activeTraceId } : {})
        }
        const detail: NetworkDetailRecord = {
          entry,
          requestHeaders: redactedHeaders(meta.headers)
        }
        setCapped(capture.networkDetails, entry.id, detail)
        void bodyDetail(body).then((capturedBody) => {
          if (capturedBody !== undefined) detail.requestBody = capturedBody
        })
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
          if (typeof this.getAllResponseHeaders === 'function') {
            detail.responseHeaders = redactedHeaders(parseXhrHeaders(this.getAllResponseHeaders()))
          }
          const responseBody = xhrResponseBody(this)
          if (responseBody !== undefined) detail.responseBody = responseBody
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
        url: redactUrl(resolveUrl(typeof url === 'string' ? url : url.href)),
        startedAt: new Date(startedAtMs).toISOString(),
        ...(capture.activeTraceId ? { traceId: capture.activeTraceId } : {})
      }
      let sent = 0
      let received = 0
      capture.capturedNetwork.push(entry)
      setCapped(capture.networkDetails, entry.id, { entry })
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
          startedAt: new Date(startedAtMs).toISOString(),
          ...(this.activeTraceId ? { traceId: this.activeTraceId } : {})
        }
        const detail: IpcDetailRecord = { entry, args: safeDetailValue(args) }
        setCapped(this.ipcDetails, entry.id, detail)
        this.capturedIpc.push(entry)
        Promise.resolve(promise).then(
          (result) => {
            detail.result = safeDetailValue(result)
            finishIpcEntry(entry, startedAtMs, true)
          },
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

function retainedDetail<T>(
  details: Map<string, { entry: unknown }>,
  options: NetworkParams | IpcParams
): DetailResult<T> {
  if (!options.id?.trim()) throw new AgentProtocolError('INVALID_PARAMS', 'id must be a non-empty string')
  if (options.clear || options.since !== undefined || options.limit !== undefined) {
    throw new AgentProtocolError('INVALID_PARAMS', 'id cannot be combined with capture list options')
  }
  const record = details.get(options.id)
  if (!record) throw new AgentProtocolError('CAPTURE_NOT_FOUND', `capture detail not retained: ${options.id}`)
  const { entry, ...detail } = record
  return { detail: { ...(entry as object), ...detail } as T }
}

function setCapped<K, V>(map: Map<K, V>, key: K, value: V): void {
  map.set(key, value)
  if (map.size > MAX_CAPTURE_ENTRIES) map.delete(map.keys().next().value as K)
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
    return invalidParam(`missing required param: ${key}`)
  }
  return value
}

function uploadFilesParam(params: Record<string, unknown>): UploadFile[] {
  const raw = params.files
  if (!Array.isArray(raw)) {
    return invalidParam('upload requires a files array')
  }
  return raw.map((entry) => {
    if (!entry || typeof entry !== 'object') {
      return invalidParam('each upload file must be an object with a name')
    }
    const record = entry as Record<string, unknown>
    if (typeof record.name !== 'string' || record.name.length === 0) {
      return invalidParam('each upload file requires a name')
    }
    if (record.type !== undefined && typeof record.type !== 'string') {
      return invalidParam('upload file type must be a string')
    }
    if (record.text !== undefined && typeof record.text !== 'string') {
      return invalidParam('upload file text must be a string')
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
  if (value === undefined) return undefined
  if (typeof value !== 'string') return invalidParam(`${key} must be a string`)
  return value
}

function numberParam(params: Record<string, unknown>, key: string): number | undefined {
  const value = params[key]
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isFinite(value)) return invalidParam(`${key} must be a finite number`)
  return value
}

function unsignedIntegerParam(params: Record<string, unknown>, key: string): number | undefined {
  const value = params[key]
  if (value === undefined) return undefined
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    return invalidParam(`${key} must be a non-negative safe integer`)
  }
  return value as number
}

function booleanParam(params: Record<string, unknown>, key: string): boolean | undefined {
  const value = params[key]
  if (value === undefined) return undefined
  if (typeof value !== 'boolean') return invalidParam(`${key} must be a boolean`)
  return value
}

function stringOrBooleanParam(params: Record<string, unknown>, key: string): string | boolean | undefined {
  const value = params[key]
  if (value === undefined || typeof value === 'string' || typeof value === 'boolean') return value
  return invalidParam(`${key} must be a string or boolean`)
}

function captureParams(params: Record<string, unknown>): NetworkParams {
  return {
    clear: booleanParam(params, 'clear'),
    since: unsignedIntegerParam(params, 'since'),
    limit: unsignedIntegerParam(params, 'limit'),
    id: stringParam(params, 'id')
  }
}

function locatorActionParam(params: Record<string, unknown>): ActParams['action'] {
  return enumParam(
    params,
    'action',
    ['click', 'hover', 'focus', 'blur', 'fill', 'type', 'press', 'scroll', 'select', 'check'],
    'locator action'
  ) ?? invalidParam('missing locator action')
}

function modifierListParam(params: Record<string, unknown>, key: string): KeyModifier[] | undefined {
  const value = params[key]
  if (value === undefined) {
    return undefined
  }
  if (!Array.isArray(value)) {
    return invalidParam(`${key} must be an array`)
  }
  return value.map((modifier) => keyModifierParam(modifier, key))
}

function keyModifierParam(value: unknown, key: string): KeyModifier {
  if (value === 'Alt' || value === 'Control' || value === 'Meta' || value === 'Shift') {
    return value
  }
  return invalidParam(`unknown ${key} value: ${String(value)}`)
}

function modeParam(params: Record<string, unknown>): SnapshotOptions['mode'] | undefined {
  return enumParam(params, 'mode', ['compact', 'verbose'], 'snapshot mode')
}

function recordActionParam(params: Record<string, unknown>): 'start' | 'stop' | 'get' | 'clear' {
  return enumParam(params, 'action', ['start', 'stop', 'get', 'clear'], 'record action') ?? 'get'
}

function dialogActionParam(params: Record<string, unknown>): 'get' | 'set' | 'clear' {
  return enumParam(params, 'action', ['get', 'set', 'clear'], 'dialog action') ?? 'get'
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

function fetchRequestHeaders(input: RequestInfo | URL, init?: RequestInit): Headers {
  const headers = new Headers(isRequest(input) ? input.headers : undefined)
  if (init?.headers) new Headers(init.headers).forEach((value, key) => headers.set(key, value))
  return headers
}

async function fetchRequestDetail(
  input: RequestInfo | URL,
  init?: RequestInit
): Promise<{ body?: unknown; size?: number }> {
  if (init?.body !== undefined) {
    return { body: await bodyDetail(init.body), size: bodySize(init.body) }
  }
  if (!isRequest(input) || input.body === null) return {}
  try {
    const text = await input.clone().text()
    return { body: bodyTextDetail(text), size: new TextEncoder().encode(text).byteLength }
  } catch {
    return {}
  }
}

async function bodyDetail(body: unknown): Promise<unknown> {
  if (body === null || body === undefined) return undefined
  if (typeof body === 'string') return bodyTextDetail(body)
  if (body instanceof URLSearchParams) return bodyTextDetail(body.toString())
  if (typeof FormData !== 'undefined' && body instanceof FormData) {
    return safeDetailValue(Object.fromEntries(Array.from(body.entries(), ([key, value]) => [
      key,
      typeof value === 'string' ? value : { name: value.name, type: value.type, size: value.size }
    ])))
  }
  if (typeof Blob !== 'undefined' && body instanceof Blob) {
    if (body.size > MAX_DETAIL_BYTES) return `[binary ${body.size} bytes]`
    return bodyTextDetail(await body.text())
  }
  if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) {
    return `[binary ${body.byteLength} bytes]`
  }
  return safeDetailValue(body)
}

function bodyTextDetail(text: string): unknown {
  try {
    return safeDetailValue(JSON.parse(text))
  } catch {
    if (text.includes('=')) {
      const params = new URLSearchParams(text)
      if ([...params].length > 0) {
        for (const key of [...params.keys()]) {
          if (isSensitiveKey(key)) params.set(key, '[REDACTED]')
        }
        return truncateUtf8(params.toString())
      }
    }
    return truncateUtf8(text)
  }
}

function safeDetailValue(value: unknown): unknown {
  if (value === undefined) return undefined
  try {
    const json = JSON.stringify(value, (key, nested) => isSensitiveKey(key) ? '[REDACTED]' : nested)
    if (json === undefined) return undefined
    const truncated = truncateUtf8(json)
    return truncated === json ? JSON.parse(json) : truncated
  } catch {
    return truncateUtf8(String(value))
  }
}

function truncateUtf8(text: string): string {
  const bytes = new TextEncoder().encode(text)
  if (bytes.byteLength <= MAX_DETAIL_BYTES) return text
  const suffix = '…[truncated]'
  const suffixBytes = new TextEncoder().encode(suffix).byteLength
  let prefix = new TextDecoder().decode(bytes.slice(0, MAX_DETAIL_BYTES - suffixBytes))
  while (new TextEncoder().encode(prefix).byteLength + suffixBytes > MAX_DETAIL_BYTES) {
    prefix = prefix.slice(0, -1)
  }
  return `${prefix}${suffix}`
}

function isSensitiveKey(key: string): boolean {
  return /authorization|cookie|credential|password|passwd|secret|session|token|api[-_]?key/i.test(key)
}

function redactedHeaders(input: HeadersInit | Record<string, string>): Record<string, string> {
  const result: Record<string, string> = {}
  new Headers(input).forEach((value, key) => {
    result[key] = isSensitiveKey(key) ? '[REDACTED]' : truncateUtf8(value)
  })
  return result
}

function redactUrl(value: string): string {
  try {
    const url = new URL(value)
    if (url.username) url.username = '[REDACTED]'
    if (url.password) url.password = '[REDACTED]'
    for (const key of [...url.searchParams.keys()]) {
      if (isSensitiveKey(key)) url.searchParams.set(key, '[REDACTED]')
    }
    return url.href
  } catch {
    return value
  }
}

function parseXhrHeaders(raw: string): Record<string, string> {
  return Object.fromEntries(raw.trim().split(/[\r\n]+/).filter(Boolean).map((line) => {
    const separator = line.indexOf(':')
    return separator === -1 ? [line, ''] : [line.slice(0, separator).trim(), line.slice(separator + 1).trim()]
  }))
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

function xhrResponseBody(xhr: XMLHttpRequest): unknown {
  try {
    if (typeof xhr.responseText === 'string') return bodyTextDetail(xhr.responseText)
  } catch {
    // responseText throws for non-text responseTypes; use response metadata.
  }
  const response: unknown = xhr.response
  return typeof response === 'string' ? bodyTextDetail(response) : safeDetailValue(response)
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

async function clonedResponseDetail(response: Response): Promise<{ size?: number; body?: unknown }> {
  try {
    const body = await response.clone().text()
    return {
      size: new TextEncoder().encode(body).byteLength,
      body: bodyTextDetail(body)
    }
  } catch {
    const size = Number(response.headers.get('content-length'))
    return Number.isSafeInteger(size) && size >= 0 ? { size } : {}
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

function tauriIpcCommand(value: string): string | undefined {
  try {
    const url = new URL(value)
    if (!(
      (url.protocol === 'ipc:' && url.hostname === 'localhost') ||
      ((url.protocol === 'http:' || url.protocol === 'https:') && url.hostname === 'ipc.localhost')
    )) return undefined
    return decodeURIComponent(url.pathname.replace(/^\/+/, ''))
  } catch {
    return undefined
  }
}

function storageAreaParam(params: Record<string, unknown>, key: string): 'local' | 'session' | undefined {
  return enumParam(params, key, ['local', 'session'], 'storage area')
}

function storageActionParam(
  params: Record<string, unknown>,
  key: string
): 'get' | 'set' | 'remove' | 'clear' | undefined {
  return enumParam(params, key, ['get', 'set', 'remove', 'clear'], 'storage action')
}

function cookieActionParam(
  params: Record<string, unknown>,
  key: string
): 'get' | 'set' | 'remove' | 'clear' | undefined {
  return enumParam(params, key, ['get', 'set', 'remove', 'clear'], 'cookie action')
}

function locationActionParam(
  params: Record<string, unknown>,
  key: string
): LocationParams['action'] {
  return enumParam(params, key, ['get', 'push', 'replace', 'reload', 'back', 'forward'], 'location action')
}

function enumParam<const T extends string>(
  params: Record<string, unknown>,
  key: string,
  values: readonly T[],
  name: string
): T | undefined {
  const value = params[key]
  if (value === undefined) return undefined
  if (typeof value === 'string' && values.includes(value as T)) return value as T
  return invalidParam(`unknown ${name}: ${String(value)}`)
}

function invalidParam(message: string): never {
  throw new AgentProtocolError('INVALID_PARAMS', message)
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
