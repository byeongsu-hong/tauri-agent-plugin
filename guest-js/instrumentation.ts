import {
  clickRef,
  fillRef,
  pressKey,
  snapshotDocument,
  type SnapshotOptions,
  type SnapshotResult
} from './semantic-tree'
import type { AgentEvent, LogEntry, RecordingEntry } from '../protocol/types'

export interface InstrumentationOptions {
  state?: Record<string, () => unknown>
}

export interface InstrumentedAction {
  action: 'click' | 'fill' | 'press'
  ref?: string
  value?: string
}

type ConsoleMethod = 'debug' | 'info' | 'warn' | 'error'

export class WebviewAgentInstrumentation {
  private installed = false
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
  }

  dispose(): void {
    for (const [level, original] of this.originalConsole.entries()) {
      console[level] = original
    }
    this.originalConsole.clear()
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
