export type JsonRpcId = string | number

export type AgentMethod =
  | 'attach'
  | 'windows'
  | 'window'
  | 'tree'
  | 'find'
  | 'click'
  | 'hover'
  | 'focus'
  | 'blur'
  | 'scroll'
  | 'drag'
  | 'fill'
  | 'select'
  | 'check'
  | 'inspect'
  | 'eval'
  | 'press'
  | 'shot'
  | 'logs'
  | 'events'
  | 'network'
  | 'storage'
  | 'cookies'
  | 'location'
  | 'wait'
  | 'state'
  | 'record'

export interface JsonRpcRequest<TParams = unknown> {
  jsonrpc: '2.0'
  id: JsonRpcId
  method: AgentMethod
  params?: TParams
}

export interface JsonRpcSuccess<TResult = unknown> {
  jsonrpc: '2.0'
  id: JsonRpcId
  result: TResult
}

export interface JsonRpcError {
  jsonrpc: '2.0'
  id: JsonRpcId
  error: {
    code: string
    message: string
    data?: unknown
  }
}

export type JsonRpcResponse<TResult = unknown> = JsonRpcSuccess<TResult> | JsonRpcError

export interface AttachParams {
  app?: string
  window?: string
}

export interface WindowTarget {
  window?: string
}

export type WindowAction =
  | 'get'
  | 'focus'
  | 'show'
  | 'hide'
  | 'minimize'
  | 'unminimize'
  | 'maximize'
  | 'unmaximize'
  | 'setSize'
  | 'setPosition'

export interface WindowParams extends WindowTarget {
  action?: WindowAction
  x?: number
  y?: number
  width?: number
  height?: number
}

export interface TreeParams extends WindowTarget {
  scope?: string
  mode?: 'compact' | 'verbose'
}

export interface FindParams extends WindowTarget {
  scope?: string
  role?: string
  name?: string
  text?: string
  limit?: number
}

export interface RefActionParams extends WindowTarget {
  ref: string
}

export interface FillParams extends RefActionParams {
  text: string
}

export interface SelectParams extends RefActionParams {
  value?: string
}

export interface CheckParams extends RefActionParams {
  checked?: boolean
}

export interface FocusParams extends RefActionParams {}

export interface BlurParams extends RefActionParams {}

export interface ScrollParams extends RefActionParams {
  x?: number
  y?: number
}

export interface DragParams extends RefActionParams {
  toRef?: string
}

export interface InspectParams extends RefActionParams {}

export type KeyModifier = 'Alt' | 'Control' | 'Meta' | 'Shift'

export interface EvalParams extends WindowTarget {
  code: string
}

export interface PressParams extends WindowTarget {
  key: string
  ref?: string
  modifiers?: KeyModifier[]
}

export interface ShotParams extends WindowTarget {
  path?: string
}

export interface LogsParams extends WindowTarget {
  follow?: boolean
  clear?: boolean
}

export interface EventsParams extends WindowTarget {
  follow?: boolean
  clear?: boolean
}

export interface NetworkParams extends WindowTarget {
  follow?: boolean
  clear?: boolean
}

export interface StorageParams extends WindowTarget {
  area?: 'local' | 'session'
  action?: 'get' | 'set' | 'remove' | 'clear'
  key?: string
  value?: string
}

export interface CookieParams extends WindowTarget {
  action?: 'get' | 'set' | 'remove' | 'clear'
  name?: string
  value?: string
}

export interface LocationParams extends WindowTarget {
  action?: 'get' | 'push' | 'replace'
  url?: string
}

export interface WaitParams extends WindowTarget {
  text?: string
  scope?: string
  role?: string
  name?: string
  timeoutMs?: number
}

export interface StateParams extends WindowTarget {
  key?: string
}

export interface RecordParams extends WindowTarget {
  action?: 'start' | 'stop' | 'get' | 'clear'
}

export interface AgentWindow {
  label: string
  title?: string
  focused: boolean
  visible: boolean
  minimized?: boolean
  maximized?: boolean
  scaleFactor?: number
  innerBounds?: WindowBounds
  outerBounds?: WindowBounds
}

export interface WindowBounds {
  x: number
  y: number
  width: number
  height: number
}

export interface TreeResult {
  text: string
}

export interface InspectResult {
  ref: string
  role: string
  name: string
  tagName: string
  text: string
  value?: string
  attributes: Record<string, string>
  states: string[]
}

export interface FindResult {
  matches: InspectResult[]
}

export interface EvalResult {
  type: string
  text: string
  value?: unknown
}

export interface LogEntry {
  level: 'debug' | 'info' | 'warn' | 'error'
  message: string
  timestamp: string
  window?: string
}

export interface AgentEvent {
  kind: string
  timestamp: string
  window?: string
  detail?: unknown
}

export interface NetworkEntry {
  id: string
  type: 'fetch'
  method: string
  url: string
  status?: number
  ok?: boolean
  startedAt: string
  endedAt?: string
  durationMs?: number
  requestBodySize?: number
  responseBodySize?: number
  error?: string
  window?: string
}

export interface StorageEntry {
  area: 'local' | 'session'
  key: string
  value: string
}

export interface StorageResult {
  area: 'local' | 'session'
  entries: StorageEntry[]
}

export interface CookieEntry {
  name: string
  value: string
}

export interface CookieResult {
  entries: CookieEntry[]
}

export interface LocationResult {
  href: string
  origin: string
  pathname: string
  search: string
  hash: string
}

export interface WaitResult {
  matched: true
  text: string
  match?: InspectResult
}

export interface ScreenshotResult {
  path?: string
  dataUrl?: string
  mime?: string
  width?: number
  height?: number
}

export interface RecordingEntry {
  method: AgentMethod
  params?: unknown
  timestamp: string
}
