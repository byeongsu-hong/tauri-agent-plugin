import type { StaticHtmlAppAdapter } from './static-app'
import type { AgentMethod, RecordingEntry } from '../protocol/types'

export class DebuggerSession {
  private recording = false
  private recordingEntries: RecordingEntry[] = []

  constructor(private readonly app: StaticHtmlAppAdapter) {}

  async execute(method: AgentMethod, params: Record<string, unknown> = {}): Promise<unknown> {
    const result = await this.dispatch(method, params)
    this.record(method, params)
    return result
  }

  private async dispatch(method: AgentMethod, params: Record<string, unknown>): Promise<unknown> {
    switch (method) {
      case 'attach':
        return this.app.attach()
      case 'windows':
        return this.app.windows()
      case 'tree':
        return this.app.tree({
          scope: stringParam(params.scope),
          mode: modeParam(params.mode)
        })
      case 'click':
        return this.app.click(requiredString(params.ref, 'ref'))
      case 'hover':
        return this.app.hover(requiredString(params.ref, 'ref'))
      case 'focus':
        return this.app.focus(requiredString(params.ref, 'ref'))
      case 'blur':
        return this.app.blur(requiredString(params.ref, 'ref'))
      case 'scroll':
        return this.app.scroll(requiredString(params.ref, 'ref'), {
          x: numberParam(params.x),
          y: numberParam(params.y)
        })
      case 'fill':
        return this.app.fill(requiredString(params.ref, 'ref'), requiredString(params.text, 'text'))
      case 'select':
        return this.app.select(requiredString(params.ref, 'ref'), stringParam(params.value))
      case 'check':
        return this.app.check(requiredString(params.ref, 'ref'), booleanParam(params.checked))
      case 'inspect':
        return this.app.inspect(requiredString(params.ref, 'ref'))
      case 'eval':
        return this.app.evaluate(requiredString(params.code, 'code'))
      case 'press':
        return this.app.press(requiredString(params.key, 'key'))
      case 'shot':
        return this.app.shot(stringParam(params.path))
      case 'logs':
        return this.app.getLogs()
      case 'events':
        return this.app.getEvents()
      case 'wait':
        return this.app.waitForText(requiredString(params.text, 'text'), numberParam(params.timeoutMs))
      case 'state':
        return this.app.state()
      case 'record':
        return this.handleRecord(params)
    }
  }

  private handleRecord(params: Record<string, unknown>): unknown {
    const action = stringParam(params.action) ?? 'get'
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
      default:
        throw new Error(`unknown record action: ${action}`)
    }
  }

  private record(method: AgentMethod, params: Record<string, unknown>): void {
    if (!this.recording || method === 'record') {
      return
    }
    if (!['click', 'hover', 'focus', 'blur', 'scroll', 'fill', 'press'].includes(method)) {
      return
    }
    this.recordingEntries.push({
      method,
      params: { ...params },
      timestamp: new Date().toISOString()
    })
  }
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`missing required string param: ${name}`)
  }
  return value
}

function stringParam(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function numberParam(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined
}

function booleanParam(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined
}

function modeParam(value: unknown): 'compact' | 'verbose' | undefined {
  return value === 'compact' || value === 'verbose' ? value : undefined
}
