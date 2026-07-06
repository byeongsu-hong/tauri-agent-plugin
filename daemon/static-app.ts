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
  EvalResult,
  FindParams,
  FindResult,
  InspectResult,
  LogEntry,
  NetworkEntry,
  ScreenshotResult,
  StorageParams,
  StorageResult
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
      url: this.url
    })
    this.bindGlobals()
  }

  async attach(): Promise<{ attached: true; windows: AgentWindow[] }> {
    this.pushEvent('attach')
    return {
      attached: true,
      windows: await this.windows()
    }
  }

  async windows(): Promise<AgentWindow[]> {
    return [{ label: this.label, title: this.title, focused: true, visible: true }]
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

  async press(key: string): Promise<{ ok: true }> {
    this.bindGlobals()
    pressKey(key, this.dom.window.document)
    this.pushEvent('press', { key })
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

  async state(): Promise<Record<string, unknown>> {
    const values: Record<string, string | boolean> = {}
    for (const input of Array.from(this.dom.window.document.querySelectorAll('input, textarea, select'))) {
      const control = input as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement
      values[this.controlName(control)] =
        control instanceof this.dom.window.HTMLInputElement &&
        (control.type === 'checkbox' || control.type === 'radio')
          ? control.checked
          : control.value
    }

    return {
      url: this.url,
      title: this.title,
      values
    }
  }

  async waitForText(text: string, timeoutMs = 1000): Promise<{ matched: true; text: string }> {
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

  getLogs(): LogEntry[] {
    return [...this.logs]
  }

  getEvents(): AgentEvent[] {
    return [...this.events]
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
