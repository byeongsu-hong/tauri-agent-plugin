import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { getCurrentWindow } from '@tauri-apps/api/window'
import {
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
  scrollRef,
  selectRef,
  snapshotDocument,
  type DragOptions,
  type ScrollOptions,
  type SnapshotOptions,
  type SnapshotResult
} from './semantic-tree'
import { screenshotDocument, type ScreenshotOptions } from './screenshot'
import { evalResult } from './evaluate'
import { deferDirectAgentInvokes } from './bridge-gate'
import type {
  AgentEvent,
  AgentMethod,
  EvalResult,
  FindParams,
  FindResult,
  InspectResult,
  LocationParams,
  LocationResult,
  LogEntry,
  NetworkEntry,
  RecordingEntry,
  ScreenshotResult,
  StorageParams,
  StorageResult
} from '../protocol/types'

const BRIDGE_REQUEST_EVENT = 'tauri-agent://request'

export interface InstrumentationOptions {
  windowLabel?: string
  state?: Record<string, () => unknown>
}

export interface InstrumentedAction {
  action: 'click' | 'hover' | 'focus' | 'blur' | 'scroll' | 'drag' | 'fill' | 'press' | 'select' | 'check'
  ref?: string
  toRef?: string
  value?: string
  checked?: boolean
  x?: number
  y?: number
}

type ConsoleMethod = 'debug' | 'info' | 'warn' | 'error'

interface AgentBridgeRequest {
  id: string
  method: AgentMethod
  params?: Record<string, unknown>
}

export class WebviewAgentInstrumentation {
  private installed = false
  private bridgeInstalled = false
  private bridgeUnlisten?: UnlistenFn
  private capturedLogs: LogEntry[] = []
  private capturedEvents: AgentEvent[] = []
  private capturedNetwork: NetworkEntry[] = []
  private recording = false
  private recordingEntries: RecordingEntry[] = []
  private readonly originalConsole = new Map<ConsoleMethod, typeof console.info>()
  private originalFetch?: typeof window.fetch
  private networkEntryId = 0

  constructor(private readonly options: InstrumentationOptions = {}) {}

  install(): void {
    if (this.installed) {
      return
    }
    this.installed = true
    for (const level of ['debug', 'info', 'warn', 'error'] as const) {
      this.originalConsole.set(level, console[level])
      console[level] = (...args: unknown[]) => {
        this.pushLog(level, args.map(String).join(' '))
        this.originalConsole.get(level)?.apply(console, args)
      }
    }
    this.installNetworkCapture()
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
    this.bridgeUnlisten?.()
    this.bridgeUnlisten = undefined
    this.bridgeInstalled = false
    this.installed = false
  }

  snapshot(options: SnapshotOptions = {}): SnapshotResult {
    return snapshotDocument(document, options)
  }

  find(options: FindParams = {}): FindResult {
    const snapshot = this.snapshot({ scope: options.scope })
    return { matches: findRefs(options, snapshot.refs) }
  }

  action(action: InstrumentedAction): { ok: true } {
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
      case 'press':
        pressKey(action.value ?? '')
        break
      case 'select':
        selectRef(requiredRef(action.ref), action.value)
        break
      case 'check':
        checkRef(requiredRef(action.ref), action.checked ?? true)
        break
    }

    this.pushEvent(action.action, serializableAction(action))
    this.recordAction(action)
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

  evaluate(code: string): EvalResult {
    return evalResult(window.eval(code))
  }

  async wait(options: { text: string; timeoutMs?: number }): Promise<{ matched: true; text: string }> {
    const startedAt = Date.now()
    const timeoutMs = options.timeoutMs ?? 1000
    while (Date.now() - startedAt <= timeoutMs) {
      if ((document.body.textContent ?? '').includes(options.text)) {
        this.pushEvent('wait', { text: options.text })
        return { matched: true, text: options.text }
      }
      await new Promise((resolve) => setTimeout(resolve, Math.min(10, timeoutMs)))
    }
    throw new Error(`wait timed out for text: ${options.text}`)
  }

  state(): Record<string, unknown> {
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

    return {
      url: window.location.href,
      title: document.title,
      values,
      probes
    }
  }

  screenshot(options: ScreenshotOptions = {}): ScreenshotResult {
    return screenshotDocument(document, options)
  }

  logs(): LogEntry[] {
    return [...this.capturedLogs]
  }

  events(): AgentEvent[] {
    return [...this.capturedEvents]
  }

  network(options: { clear?: boolean } = {}): NetworkEntry[] {
    const entries = this.capturedNetwork.map((entry) => ({ ...entry }))
    if (options.clear) {
      this.capturedNetwork = []
    }
    return entries
  }

  storage(options: StorageParams = {}): StorageResult {
    const area = storageArea(options.area)
    const store = area === 'session' ? window.sessionStorage : window.localStorage
    applyStorageAction(store, options)
    return storageResult(store, area, options.key)
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
          error: error instanceof Error ? error.message : String(error)
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
      case 'select':
        return this.select(requiredStringParam(params, 'ref'), stringParam(params, 'value'))
      case 'check':
        return this.check(requiredStringParam(params, 'ref'), booleanParam(params, 'checked') ?? true)
      case 'inspect':
        return this.inspect(requiredStringParam(params, 'ref'))
      case 'eval':
        return this.evaluate(requiredStringParam(params, 'code'))
      case 'press':
        return this.action({ action: 'press', value: stringParam(params, 'key') ?? stringParam(params, 'value') ?? '' })
      case 'shot':
        return this.screenshot({ path: stringParam(params, 'path') })
      case 'logs':
        return this.logs()
      case 'events':
        return this.events()
      case 'network':
        return this.network({ clear: booleanParam(params, 'clear') ?? false })
      case 'storage':
        return this.storage({
          area: storageAreaParam(params, 'area'),
          action: storageActionParam(params, 'action'),
          key: stringParam(params, 'key'),
          value: stringParam(params, 'value')
        })
      case 'location':
        return this.location({
          action: locationActionParam(params, 'action'),
          url: stringParam(params, 'url')
        })
      case 'wait':
        return this.wait({
          text: requiredStringParam(params, 'text'),
          timeoutMs: numberParam(params, 'timeoutMs')
        })
      case 'state':
        return this.state()
      case 'record':
        return this.record(recordActionParam(params))
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
      }
    }
  }

  private recordAction(action: InstrumentedAction): void {
    if (!this.recording) {
      return
    }
    this.recordingEntries.push({
      method: action.action,
      params: serializableAction(action),
      timestamp: new Date().toISOString()
    })
  }
}

declare global {
  interface Window {
    __TAURI_AGENT__?: WebviewAgentInstrumentation
  }
}

function requiredRef(ref: string | undefined): string {
  if (!ref) {
    throw new Error('missing required ref')
  }
  return ref
}

function serializableAction(action: InstrumentedAction): Record<string, string | boolean | number> {
  const params: Record<string, string | boolean | number> = {}
  if (action.ref) params.ref = action.ref
  if (action.toRef) params.toRef = action.toRef
  if (action.value) params.value = action.value
  if (action.checked !== undefined) params.checked = action.checked
  if (action.x !== undefined) params.x = action.x
  if (action.y !== undefined) params.y = action.y
  return params
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

function modeParam(params: Record<string, unknown>): SnapshotOptions['mode'] | undefined {
  const mode = params.mode
  return mode === 'compact' || mode === 'verbose' ? mode : undefined
}

function recordActionParam(params: Record<string, unknown>): 'start' | 'stop' | 'get' | 'clear' {
  const action = params.action
  return action === 'start' || action === 'stop' || action === 'clear' ? action : 'get'
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

function isRequest(value: RequestInfo | URL): value is Request {
  return typeof Request !== 'undefined' && value instanceof Request
}

function isTauriIpcUrl(url: string): boolean {
  return url.startsWith('ipc://localhost/')
}

function storageArea(area: StorageParams['area']): 'local' | 'session' {
  return area === 'session' ? 'session' : 'local'
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

function applyStorageAction(store: Storage, options: StorageParams): void {
  const action = options.action ?? 'get'
  switch (action) {
    case 'get':
      return
    case 'set':
      store.setItem(requiredStorageKey(options.key), requiredStorageValue(options.value))
      return
    case 'remove':
      store.removeItem(requiredStorageKey(options.key))
      return
    case 'clear':
      store.clear()
      return
  }
}

function storageResult(store: Storage, area: 'local' | 'session', key?: string): StorageResult {
  const keys = key === undefined
    ? Array.from({ length: store.length }, (_, index) => store.key(index)).filter((value): value is string => value !== null).sort()
    : store.getItem(key) === null ? [] : [key]
  return {
    area,
    entries: keys.map((entryKey) => ({
      area,
      key: entryKey,
      value: store.getItem(entryKey) ?? ''
    }))
  }
}

function requiredStorageKey(key: string | undefined): string {
  if (!key) {
    throw new Error('storage action requires key')
  }
  return key
}

function requiredStorageValue(value: string | undefined): string {
  if (value === undefined) {
    throw new Error('storage set requires value')
  }
  return value
}

function locationActionParam(params: Record<string, unknown>, key: string): 'get' | 'push' | 'replace' | undefined {
  const value = params[key]
  return value === 'get' || value === 'push' || value === 'replace' ? value : undefined
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
  }
}

function locationResult(location: Location): LocationResult {
  return {
    href: location.href,
    origin: location.origin,
    pathname: location.pathname,
    search: location.search,
    hash: location.hash
  }
}

function requiredLocationUrl(url: string | undefined): string {
  if (!url) {
    throw new Error('location action requires url')
  }
  return url
}
