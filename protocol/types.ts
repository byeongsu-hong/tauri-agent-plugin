export type JsonRpcId = string | number

export type AgentMethod =
  | 'attach'
  | 'windows'
  | 'tree'
  | 'click'
  | 'fill'
  | 'inspect'
  | 'eval'
  | 'press'
  | 'shot'
  | 'logs'
  | 'events'
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

export interface TreeParams extends WindowTarget {
  scope?: string
  mode?: 'compact' | 'verbose'
}

export interface RefActionParams extends WindowTarget {
  ref: string
}

export interface FillParams extends RefActionParams {
  text: string
}

export interface InspectParams extends RefActionParams {}

export interface EvalParams extends WindowTarget {
  code: string
}

export interface PressParams extends WindowTarget {
  key: string
}

export interface ShotParams extends WindowTarget {
  path?: string
}

export interface LogsParams extends WindowTarget {
  follow?: boolean
}

export interface EventsParams extends WindowTarget {
  follow?: boolean
}

export interface WaitParams extends WindowTarget {
  text?: string
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

export interface ScreenshotResult {
  path?: string
  dataUrl?: string
  mime?: string
}

export interface RecordingEntry {
  method: AgentMethod
  params?: unknown
  timestamp: string
}
