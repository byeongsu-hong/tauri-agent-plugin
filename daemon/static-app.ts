import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

import { JSDOM } from 'jsdom'

import {
  clickRef,
  fillRef,
  pressKey,
  snapshotDocument,
  type SnapshotOptions
} from '../guest-js/semantic-tree'
import { screenshotDocument } from '../guest-js/screenshot'
import type { AgentEvent, AgentWindow, LogEntry, ScreenshotResult } from '../protocol/types'

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

  async click(ref: string): Promise<{ ok: true }> {
    this.bindGlobals()
    clickRef(ref)
    this.pushEvent('click', { ref })
    return { ok: true }
  }

  async fill(ref: string, text: string): Promise<{ ok: true }> {
    this.bindGlobals()
    fillRef(ref, text)
    this.pushEvent('fill', { ref, text })
    return { ok: true }
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
    const result = path ? { path, mime: screenshot.mime } : screenshot
    if (path) {
      await mkdir(dirname(path), { recursive: true })
      await writeFile(path, Buffer.from(requiredDataUrlBody(screenshot.dataUrl), 'base64'))
    }
    this.pushEvent('shot', result)
    return result
  }

  async state(): Promise<Record<string, unknown>> {
    const values: Record<string, string> = {}
    for (const input of Array.from(this.dom.window.document.querySelectorAll('input, textarea, select'))) {
      const control = input as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement
      values[this.controlName(control)] = control.value
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
    globalThis.HTMLSelectElement = this.dom.window.HTMLSelectElement
    globalThis.HTMLTextAreaElement = this.dom.window.HTMLTextAreaElement
    globalThis.KeyboardEvent = this.dom.window.KeyboardEvent
    globalThis.Node = this.dom.window.Node
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
