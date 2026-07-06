import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import {
  clickRef,
  fillRef,
  pressKey,
  snapshotDocument,
  type SnapshotOptions,
  type SnapshotResult
} from './semantic-tree'
import { screenshotDocument, type ScreenshotOptions } from './screenshot'
import type { AgentEvent, AgentMethod, LogEntry, RecordingEntry, ScreenshotResult } from '../protocol/types'

const BRIDGE_REQUEST_EVENT = 'tauri-agent://request'

export interface InstrumentationOptions {
  state?: Record<string, () => unknown>
}

export interface InstrumentedAction {
  action: 'click' | 'fill' | 'press'
  ref?: string
  value?: string
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
  private recording = false
  private recordingEntries: RecordingEntry[] = []
  private readonly originalConsole = new Map<ConsoleMethod, typeof console.info>()

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
    window.__TAURI_AGENT__ = this
    this.installBridge()
  }

  dispose(): void {
    for (const [level, original] of this.originalConsole.entries()) {
      console[level] = original
    }
    this.originalConsole.clear()
    this.bridgeUnlisten?.()
    this.bridgeUnlisten = undefined
    this.bridgeInstalled = false
    this.installed = false
  }

  snapshot(options: SnapshotOptions = {}): SnapshotResult {
    return snapshotDocument(document, options)
  }

  action(action: InstrumentedAction): { ok: true } {
    switch (action.action) {
      case 'click':
        clickRef(requiredRef(action.ref))
        break
      case 'fill':
        fillRef(requiredRef(action.ref), action.value ?? '')
        break
      case 'press':
        pressKey(action.value ?? '')
        break
    }

    this.pushEvent(action.action, serializableAction(action))
    this.recordAction(action)
    return { ok: true }
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
    const values: Record<string, string> = {}
    for (const input of Array.from(document.querySelectorAll('input, textarea, select'))) {
      const control = input as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement
      values[controlName(control)] = control.value
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
    void listen<AgentBridgeRequest>(BRIDGE_REQUEST_EVENT, (event) => {
      void this.handleBridgeRequest(event.payload)
    })
      .then((unlisten) => {
        this.bridgeUnlisten = unlisten
      })
      .catch(() => {
        this.bridgeInstalled = false
      })
  }

  private async handleBridgeRequest(request: AgentBridgeRequest): Promise<void> {
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
    }
  }

  private async executeBridgeRequest(request: AgentBridgeRequest): Promise<unknown> {
    const params = request.params ?? {}
    switch (request.method) {
      case 'tree':
        return { text: this.snapshot({ scope: stringParam(params, 'scope'), mode: modeParam(params) }).text }
      case 'click':
        return this.action({ action: 'click', ref: requiredStringParam(params, 'ref') })
      case 'fill':
        return this.action({
          action: 'fill',
          ref: requiredStringParam(params, 'ref'),
          value: stringParam(params, 'text') ?? stringParam(params, 'value') ?? ''
        })
      case 'press':
        return this.action({ action: 'press', value: stringParam(params, 'key') ?? stringParam(params, 'value') ?? '' })
      case 'shot':
        return this.screenshot({ path: stringParam(params, 'path') })
      case 'logs':
        return this.logs()
      case 'events':
        return this.events()
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

function serializableAction(action: InstrumentedAction): Record<string, string> {
  const params: Record<string, string> = {}
  if (action.ref) params.ref = action.ref
  if (action.value) params.value = action.value
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

function modeParam(params: Record<string, unknown>): SnapshotOptions['mode'] | undefined {
  const mode = params.mode
  return mode === 'compact' || mode === 'verbose' ? mode : undefined
}

function recordActionParam(params: Record<string, unknown>): 'start' | 'stop' | 'get' | 'clear' {
  const action = params.action
  return action === 'start' || action === 'stop' || action === 'clear' ? action : 'get'
}
