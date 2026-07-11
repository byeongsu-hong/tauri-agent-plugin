import type { StaticHtmlAppAdapter } from './static-app'
import type { AgentMethod, KeyModifier, RecordingEntry, ScreenshotBackend, WindowAction } from '../protocol/types'
import { isRecordableMethod } from '../protocol/json-rpc'
import type { UploadFile } from '../guest-js/semantic-tree'
import { AgentProtocolError } from '../protocol/error'

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
      case 'window': {
        const action = windowActionParam(params.action)
        const x = boundedIntegerParam(params.x, 'x', -2_147_483_648, 2_147_483_647)
        const y = boundedIntegerParam(params.y, 'y', -2_147_483_648, 2_147_483_647)
        const width = boundedIntegerParam(params.width, 'width', 0, 4_294_967_295)
        const height = boundedIntegerParam(params.height, 'height', 0, 4_294_967_295)
        if (action === 'setSize') {
          if (!width) invalidParam('window setSize requires positive width')
          if (!height) invalidParam('window setSize requires positive height')
        }
        if (action === 'setPosition') {
          if (x === undefined) invalidParam('window setPosition requires x')
          if (y === undefined) invalidParam('window setPosition requires y')
        }
        return this.app.window({
          window: stringParam(params.window),
          action,
          x,
          y,
          width,
          height
        })
      }
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
          limit: unsignedIntegerParam(params.limit, 'limit')
        })
      case 'act':
        return this.app.act({
          scope: stringParam(params.scope),
          role: stringParam(params.role),
          name: stringParam(params.name),
          text: stringParam(params.text),
          action: locatorActionParam(params.action),
          value: stringOrBooleanParam(params.value),
          x: numberParam(params.x),
          y: numberParam(params.y),
          timeoutMs: unsignedIntegerParam(params.timeoutMs, 'timeoutMs'),
          detail: booleanParam(params.detail)
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
        return this.app.type(requiredString(params.ref, 'ref'), requiredString(params.text, 'text'))
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
        return this.app.getLogs(captureParams(params))
      case 'events':
        return this.app.getEvents(captureParams(params))
      case 'network':
        return this.app.getNetwork(captureParams(params))
      case 'ipc':
        return this.app.ipc(captureParams(params))
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
          timeoutMs: unsignedIntegerParam(params.timeoutMs, 'timeoutMs'),
          state: waitStateParam(params.state),
          fn: stringParam(params.fn),
          networkIdle: booleanParam(params.networkIdle),
          idleMs: unsignedIntegerParam(params.idleMs, 'idleMs')
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
          since: unsignedIntegerParam(params.since, 'since'),
          timeoutMs: unsignedIntegerParam(params.timeoutMs, 'timeoutMs'),
          lean: booleanParam(params.lean)
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
        return invalidParam(`unknown record action: ${action}`)
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
    throw new AgentProtocolError('INVALID_PARAMS', `missing required string param: ${name}`)
  }
  return value
}

function stringParam(value: unknown): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string') invalidParam('expected a string parameter')
  return value
}

function numberParam(value: unknown): number | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isFinite(value)) invalidParam('expected a finite number parameter')
  return value
}

function unsignedIntegerParam(value: unknown, name: string): number | undefined {
  if (value === undefined) return undefined
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    return invalidParam(`${name} must be a non-negative safe integer`)
  }
  return value as number
}

function boundedIntegerParam(value: unknown, name: string, minimum: number, maximum: number): number | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isInteger(value) || value < minimum || value > maximum) {
    return invalidParam(`${name} must be an integer between ${minimum} and ${maximum}`)
  }
  return value
}

function booleanParam(value: unknown): boolean | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'boolean') invalidParam('expected a boolean parameter')
  return value
}

function stringOrBooleanParam(value: unknown): string | boolean | undefined {
  if (value === undefined || typeof value === 'string' || typeof value === 'boolean') return value
  return invalidParam('expected a string or boolean parameter')
}

function waitStateParam(value: unknown): 'present' | 'absent' | undefined {
  return enumParam(value, ['present', 'absent'], 'wait state')
}

function captureParams(params: Record<string, unknown>): {
  clear?: boolean
  since?: number
  limit?: number
  id?: string
} {
  return {
    clear: booleanParam(params.clear),
    since: unsignedIntegerParam(params.since, 'since'),
    limit: unsignedIntegerParam(params.limit, 'limit'),
    id: stringParam(params.id)
  }
}

function locatorActionParam(value: unknown): 'click' | 'hover' | 'focus' | 'blur' | 'fill' | 'type' | 'press' | 'scroll' | 'select' | 'check' {
  return enumParam(
    value,
    ['click', 'hover', 'focus', 'blur', 'fill', 'type', 'press', 'scroll', 'select', 'check'],
    'locator action'
  ) ?? invalidParam('missing locator action')
}

function dialogActionParam(value: unknown): 'get' | 'set' | 'clear' | undefined {
  return enumParam(value, ['get', 'set', 'clear'], 'dialog action')
}

function uploadFilesParam(value: unknown): UploadFile[] {
  if (!Array.isArray(value)) {
    return invalidParam('upload requires a files array')
  }
  return value.map((entry) => {
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

function keyModifiersParam(value: unknown): KeyModifier[] | undefined {
  if (value === undefined) {
    return undefined
  }
  if (!Array.isArray(value)) {
    return invalidParam('modifiers must be an array')
  }
  return value.map(keyModifierParam)
}

function keyModifierParam(value: unknown): KeyModifier {
  if (value === 'Alt' || value === 'Control' || value === 'Meta' || value === 'Shift') {
    return value
  }
  return invalidParam(`unknown key modifier: ${String(value)}`)
}

function screenshotBackendParam(value: unknown): ScreenshotBackend | undefined {
  return enumParam(value, ['dom', 'native', 'auto'], 'screenshot backend')
}

function modeParam(value: unknown): 'compact' | 'verbose' | undefined {
  return enumParam(value, ['compact', 'verbose'], 'snapshot mode')
}

function storageAreaParam(value: unknown): 'local' | 'session' | undefined {
  return enumParam(value, ['local', 'session'], 'storage area')
}

function storageActionParam(value: unknown): 'get' | 'set' | 'remove' | 'clear' | undefined {
  return enumParam(value, ['get', 'set', 'remove', 'clear'], 'storage action')
}

function cookieActionParam(value: unknown): 'get' | 'set' | 'remove' | 'clear' | undefined {
  return enumParam(value, ['get', 'set', 'remove', 'clear'], 'cookie action')
}

function locationActionParam(value: unknown): 'get' | 'push' | 'replace' | 'reload' | 'back' | 'forward' | undefined {
  return enumParam(value, ['get', 'push', 'replace', 'reload', 'back', 'forward'], 'location action')
}

function windowActionParam(value: unknown): WindowAction | undefined {
  return enumParam(value, [
    'get', 'focus', 'show', 'hide', 'minimize', 'unminimize', 'maximize', 'unmaximize', 'setSize', 'setPosition'
  ], 'window action')
}

function enumParam<const T extends string>(value: unknown, values: readonly T[], name: string): T | undefined {
  if (value === undefined) return undefined
  if (typeof value === 'string' && values.includes(value as T)) return value as T
  return invalidParam(`unknown ${name}: ${String(value)}`)
}

function invalidParam(message: string): never {
  throw new AgentProtocolError('INVALID_PARAMS', message)
}
