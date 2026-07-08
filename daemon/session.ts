import type { StaticHtmlAppAdapter } from './static-app'
import type { AgentMethod, KeyModifier, RecordingEntry, ScreenshotBackend, WindowAction } from '../protocol/types'
import { isRecordableMethod } from '../protocol/json-rpc'
import type { UploadFile } from '../guest-js/semantic-tree'

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
      case 'window':
        return this.app.window({
          window: stringParam(params.window),
          action: windowActionParam(params.action),
          x: numberParam(params.x),
          y: numberParam(params.y),
          width: numberParam(params.width),
          height: numberParam(params.height)
        })
      case 'tree':
        return this.app.tree({
          scope: stringParam(params.scope),
          mode: modeParam(params.mode)
        })
      case 'find':
        return this.app.find({
          scope: stringParam(params.scope),
          role: stringParam(params.role),
          name: stringParam(params.name),
          text: stringParam(params.text),
          limit: numberParam(params.limit)
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
      case 'drag':
        return this.app.drag(requiredString(params.ref, 'ref'), {
          toRef: stringParam(params.toRef)
        })
      case 'type':
        return this.app.type(requiredString(params.ref, 'ref'), stringParam(params.text) ?? '')
      case 'fill':
        return this.app.fill(requiredString(params.ref, 'ref'), requiredString(params.text, 'text'))
      case 'select':
        return this.app.select(requiredString(params.ref, 'ref'), stringParam(params.value))
      case 'check':
        return this.app.check(requiredString(params.ref, 'ref'), booleanParam(params.checked))
      case 'upload':
        return this.app.upload(requiredString(params.ref, 'ref'), uploadFilesParam(params.files))
      case 'inspect':
        return this.app.inspect(requiredString(params.ref, 'ref'))
      case 'eval':
        return this.app.evaluate(requiredString(params.code, 'code'))
      case 'press':
        return this.app.press(requiredString(params.key, 'key'), {
          ref: stringParam(params.ref),
          modifiers: keyModifiersParam(params.modifiers)
        })
      case 'shot':
        return this.app.shot({
          path: stringParam(params.path),
          backend: screenshotBackendParam(params.backend),
          ref: stringParam(params.ref)
        })
      case 'logs':
        return this.app.getLogs(booleanParam(params.clear) ?? false)
      case 'events':
        return this.app.getEvents(booleanParam(params.clear) ?? false)
      case 'network':
        return this.app.getNetwork(booleanParam(params.clear) ?? false)
      case 'ipc':
        return this.app.ipc(booleanParam(params.clear) ?? false)
      case 'storage':
        return this.app.storage({
          area: storageAreaParam(params.area),
          action: storageActionParam(params.action),
          key: stringParam(params.key),
          value: stringParam(params.value)
        })
      case 'cookies':
        return this.app.cookies({
          action: cookieActionParam(params.action),
          name: stringParam(params.name),
          value: stringParam(params.value)
        })
      case 'location':
        return this.app.location({
          action: locationActionParam(params.action),
          url: stringParam(params.url)
        })
      case 'wait':
        return this.app.wait({
          text: stringParam(params.text),
          scope: stringParam(params.scope),
          role: stringParam(params.role),
          name: stringParam(params.name),
          timeoutMs: numberParam(params.timeoutMs),
          state: params.state === 'absent' ? 'absent' : undefined,
          fn: stringParam(params.fn),
          networkIdle: booleanParam(params.networkIdle),
          idleMs: numberParam(params.idleMs)
        })
      case 'expect':
        return this.app.expect({
          scope: stringParam(params.scope),
          role: stringParam(params.role),
          name: stringParam(params.name),
          text: stringParam(params.text),
          present: booleanParam(params.present),
          value: stringParam(params.value),
          hasState: stringParam(params.hasState)
        })
      case 'state':
        return this.app.state(stringParam(params.key))
      case 'dialog':
        return this.app.dialog({
          action: dialogActionParam(params.action),
          accept: booleanParam(params.accept),
          promptText: stringParam(params.promptText)
        })
      case 'record':
        return this.handleRecord(params)
      case 'stream':
        return this.app.stream({
          since: numberParam(params.since),
          timeoutMs: numberParam(params.timeoutMs)
        })
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
    if (!isRecordableMethod(method)) {
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

function dialogActionParam(value: unknown): 'get' | 'set' | 'clear' | undefined {
  return value === 'get' || value === 'set' || value === 'clear' ? value : undefined
}

function uploadFilesParam(value: unknown): UploadFile[] {
  if (!Array.isArray(value)) {
    throw new Error('upload requires a files array')
  }
  return value.map((entry) => {
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

function keyModifiersParam(value: unknown): KeyModifier[] | undefined {
  if (value === undefined) {
    return undefined
  }
  if (!Array.isArray(value)) {
    throw new Error('modifiers must be an array')
  }
  return value.map(keyModifierParam)
}

function keyModifierParam(value: unknown): KeyModifier {
  if (value === 'Alt' || value === 'Control' || value === 'Meta' || value === 'Shift') {
    return value
  }
  throw new Error(`unknown key modifier: ${String(value)}`)
}

function screenshotBackendParam(value: unknown): ScreenshotBackend | undefined {
  if (value === undefined) {
    return undefined
  }
  if (value === 'dom' || value === 'native' || value === 'auto') {
    return value
  }
  throw new Error(`unknown screenshot backend: ${String(value)}`)
}

function modeParam(value: unknown): 'compact' | 'verbose' | undefined {
  return value === 'compact' || value === 'verbose' ? value : undefined
}

function storageAreaParam(value: unknown): 'local' | 'session' | undefined {
  return value === 'local' || value === 'session' ? value : undefined
}

function storageActionParam(value: unknown): 'get' | 'set' | 'remove' | 'clear' | undefined {
  return value === 'get' || value === 'set' || value === 'remove' || value === 'clear' ? value : undefined
}

function cookieActionParam(value: unknown): 'get' | 'set' | 'remove' | 'clear' | undefined {
  return value === 'get' || value === 'set' || value === 'remove' || value === 'clear' ? value : undefined
}

function locationActionParam(value: unknown): 'get' | 'push' | 'replace' | undefined {
  return value === 'get' || value === 'push' || value === 'replace' ? value : undefined
}

function windowActionParam(value: unknown): WindowAction | undefined {
  if (value === undefined) {
    return undefined
  }
  if (
    value === 'get' ||
    value === 'focus' ||
    value === 'show' ||
    value === 'hide' ||
    value === 'minimize' ||
    value === 'unminimize' ||
    value === 'maximize' ||
    value === 'unmaximize' ||
    value === 'setSize' ||
    value === 'setPosition'
  ) {
    return value
  }
  throw new Error(`unknown window action: ${String(value)}`)
}
