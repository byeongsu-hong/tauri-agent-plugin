import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

import { JSDOM } from 'jsdom'

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
  type SnapshotOptions
} from '../guest-js/semantic-tree'
import { screenshotDocument } from '../guest-js/screenshot'
import { evalResult } from '../guest-js/evaluate'
import type {
  AgentEvent,
  AgentWindow,
  CookieParams,
  CookieResult,
  EvalResult,
  FindParams,
  FindResult,
  InspectResult,
  LocationParams,
  LocationResult,
  LogEntry,
  KeyModifier,
  NetworkEntry,
  ScreenshotResult,
  StorageParams,
  StorageResult,
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
  private logs: LogEntry[] = []
  private events: AgentEvent[] = []
  private network: NetworkEntry[] = []
  private windowState: AgentWindow
  private storageAreas = {
    local: createMemoryStorage(),
    session: createMemoryStorage()
  }

  constructor(options: StaticHtmlAppOptions) {
    this.label = options.window ?? 'main'
    this.title = options.title ?? 'Tauri App'
    this.url = options.url ?? 'tauri-agent://static'
    this.dom = new JSDOM(options.html, {
      pretendToBeVisual: true,
      runScripts: 'outside-only',
      url: this.url
    })
    this.windowState = this.createInitialWindowState()
    this.bindGlobals()
    this.installRuntimeLogCapture()
  }

  async attach(): Promise<{ attached: true; windows: AgentWindow[] }> {
    this.pushEvent('attach')
    return {
      attached: true,
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

  async select(ref: string, value?: string): Promise<{ ok: true }> {
    this.bindGlobals()
    selectRef(ref, value)
    this.pushEvent('select', value === undefined ? { ref } : { ref, value })
    return { ok: true }
  }

  async inspect(ref: string): Promise<InspectResult> {
    this.bindGlobals()
    return inspectRef(ref)
  }

  async evaluate(code: string): Promise<EvalResult> {
    this.bindGlobals()
    return evalResult(this.dom.window.eval(code))
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

  async shot(path?: string): Promise<ScreenshotResult> {
    this.bindGlobals()
    const screenshot = screenshotDocument(this.dom.window.document, { path })
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

  async wait(options: WaitParams = {}): Promise<WaitResult> {
    const timeoutMs = options.timeoutMs ?? 1000
    if (!hasSemanticWaitFilter(options)) {
      if (!options.text) {
        throw new Error('wait requires text or semantic filter')
      }
      return this.waitForText(options.text, timeoutMs)
    }

    const startedAt = Date.now()
    while (Date.now() - startedAt <= timeoutMs) {
      this.bindGlobals()
      const snapshot = snapshotDocument(this.dom.window.document, { scope: options.scope })
      const match = findRefs({ ...options, limit: 1 }, snapshot.refs)[0]
      if (match) {
        this.pushEvent('wait', waitEventDetail(options, match))
        return { matched: true, text: match.text, match }
      }
      await new Promise((resolve) => setTimeout(resolve, Math.min(10, timeoutMs)))
    }
    throw new Error('wait timed out for semantic target')
  }

  async waitForText(text: string, timeoutMs = 1000): Promise<WaitResult> {
    const startedAt = Date.now()
    while (Date.now() - startedAt <= timeoutMs) {
      if ((this.dom.window.document.body.textContent ?? '').includes(text)) {
        this.pushEvent('wait', { text })
        return { matched: true, text }
      }
      await new Promise((resolve) => setTimeout(resolve, Math.min(10, timeoutMs)))
    }
    throw new Error(`wait timed out for text: ${text}`)
  }

  getLogs(clear = false): LogEntry[] {
    const entries = [...this.logs]
    if (clear) {
      this.logs = []
    }
    return entries
  }

  getEvents(clear = false): AgentEvent[] {
    const entries = [...this.events]
    if (clear) {
      this.events = []
    }
    return entries
  }

  getNetwork(clear = false): NetworkEntry[] {
    const entries = [...this.network]
    if (clear) {
      this.network = []
    }
    return entries
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
      timestamp: new Date().toISOString()
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

function hasSemanticWaitFilter(options: WaitParams): boolean {
  return Boolean(options.scope || options.role || options.name)
}

function waitEventDetail(options: WaitParams, match: InspectResult): Record<string, unknown> {
  return {
    ...(options.text ? { text: options.text } : {}),
    ...(options.scope ? { scope: options.scope } : {}),
    ...(options.role ? { role: options.role } : {}),
    ...(options.name ? { name: options.name } : {}),
    match
  }
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

function stateValue(state: Record<string, unknown>, key: string | undefined): unknown {
  return key === undefined ? state : state[key] ?? null
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

function storageArea(area: StorageParams['area']): 'local' | 'session' {
  return area === 'session' ? 'session' : 'local'
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

function runtimeErrorMessage(event: Event): string {
  const errorEvent = event as ErrorEvent
  return errorLikeMessage(errorEvent.error) || errorEvent.message || 'Unknown runtime error'
}

function errorLikeMessage(value: unknown): string {
  if (value instanceof Error) {
    return messageWithStack(value.message, value.stack) || value.name
  }
  if (typeof value === 'string') {
    return value
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>
    const formatted = messageWithStack(
      typeof record.message === 'string' ? record.message : undefined,
      typeof record.stack === 'string' ? record.stack : undefined
    )
    if (formatted) {
      return formatted
    }
  }
  try {
    const serialized = JSON.stringify(value)
    if (serialized) {
      return serialized
    }
  } catch {
    // Fall through to String(value).
  }
  return String(value)
}

function messageWithStack(message?: string, stack?: string): string {
  if (message && stack) {
    return stack.includes(message) ? stack : `${message}\n${stack}`
  }
  return stack || message || ''
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

function storageResult(
  store: Storage,
  area: 'local' | 'session',
  key?: string
): StorageResult {
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

function applyCookieAction(document: Document, options: CookieParams): void {
  const action = options.action ?? 'get'
  switch (action) {
    case 'get':
      return
    case 'set':
      document.cookie = `${encodeURIComponent(requiredCookieName(options.name))}=${encodeURIComponent(requiredCookieValue(options.value))}; path=/`
      return
    case 'remove':
      expireCookie(document, requiredCookieName(options.name))
      return
    case 'clear':
      for (const entry of parseCookies(document.cookie)) {
        expireCookie(document, entry.name)
      }
      return
  }
}

function cookieResult(document: Document, name?: string): CookieResult {
  const entries = parseCookies(document.cookie)
  return {
    entries: name === undefined ? entries : entries.filter((entry) => entry.name === name)
  }
}

function parseCookies(cookie: string): CookieResult['entries'] {
  return cookie
    .split(';')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const separatorIndex = part.indexOf('=')
      const name = separatorIndex === -1 ? part : part.slice(0, separatorIndex)
      const value = separatorIndex === -1 ? '' : part.slice(separatorIndex + 1)
      return { name: safeDecode(name), value: safeDecode(value) }
    })
    .sort((a, b) => a.name.localeCompare(b.name))
}

function expireCookie(document: Document, name: string): void {
  const encodedName = encodeURIComponent(name)
  for (const path of cookiePathCandidates(document.location.pathname)) {
    document.cookie = `${encodedName}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=${path}`
  }
}

function cookiePathCandidates(pathname: string): string[] {
  const normalizedPath = pathname.startsWith('/') ? pathname : `/${pathname}`
  const paths = new Set<string>(['/'])
  let current = ''
  for (const segment of normalizedPath.split('/').filter(Boolean)) {
    current = `${current}/${segment}`
    paths.add(current)
    paths.add(`${current}/`)
  }
  return [...paths].sort((a, b) => b.length - a.length)
}

function requiredCookieName(name: string | undefined): string {
  if (!name) {
    throw new Error('cookie action requires name')
  }
  return name
}

function requiredCookieValue(value: string | undefined): string {
  if (value === undefined) {
    throw new Error('cookie set requires value')
  }
  return value
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

function applyLocationAction(dom: JSDOM, options: LocationParams): void {
  const action = options.action ?? 'get'
  switch (action) {
    case 'get':
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
