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
  | 'type'
  | 'shot'
  | 'logs'
  | 'events'
  | 'network'
  | 'ipc'
  | 'storage'
  | 'cookies'
  | 'location'
  | 'wait'
  | 'expect'
  | 'state'
  | 'record'
  | 'stream'

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

/**
 * Set a control's value in one shot. Canonical payload param is `text`; the
 * guest bridge also accepts a legacy `value` alias, but recordings and all
 * first-party surfaces emit `text`.
 */
export interface FillParams extends RefActionParams {
  text: string
}

/** Type per-keystroke into a control. Canonical payload param is `text`. */
export interface TypeParams extends RefActionParams {
  text: string
}

/** Choose a `<select>` option. Canonical payload param is `value`. */
export interface SelectParams extends RefActionParams {
  value?: string
}

/** Toggle a checkbox/radio. Canonical payload param is `checked`. */
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
export type ScreenshotBackend = 'dom' | 'native' | 'auto'

export interface EvalParams extends WindowTarget {
  code: string
}

/**
 * Dispatch a keyboard press. Canonical payload param is `key`; the guest bridge
 * also accepts a legacy `value` alias. `ref` optionally focuses a target first.
 */
export interface PressParams extends WindowTarget {
  key: string
  ref?: string
  modifiers?: KeyModifier[]
}

export interface ShotParams extends WindowTarget {
  path?: string
  backend?: ScreenshotBackend
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

export interface IpcParams extends WindowTarget {
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
  action?: 'get' | 'push' | 'replace' | 'reload' | 'back' | 'forward'
  url?: string
}

export interface WaitParams extends WindowTarget {
  text?: string
  scope?: string
  role?: string
  name?: string
  timeoutMs?: number
  /** `present` (default) waits for appearance; `absent` waits for disappearance. */
  state?: 'present' | 'absent'
  /**
   * Poll a JS expression, resolving when it evaluates to a truthy value
   * (Playwright's `waitForFunction`). Thenable results are awaited each poll.
   */
  fn?: string
  /**
   * Wait until no fetch/XHR request is in flight for `idleMs` consecutive
   * milliseconds. WebSockets are excluded (they stay open by design).
   */
  networkIdle?: boolean
  /** Quiet window for `networkIdle`, in ms. Defaults to 500. */
  idleMs?: number
}

export interface ExpectParams extends WindowTarget {
  // Locator (substring/role match, like find):
  scope?: string
  role?: string
  name?: string
  text?: string
  // Assertions:
  /** Whether the target must exist (default true). Set false to assert absence. */
  present?: boolean
  /** The matched control's value must equal this. */
  value?: string
  /** The matched element must carry this state flag (e.g. disabled, checked). */
  hasState?: string
}

export interface ExpectResult {
  ok: true
  match?: InspectResult
}

export interface StateParams extends WindowTarget {
  key?: string
}

export interface RecordParams extends WindowTarget {
  action?: 'start' | 'stop' | 'get' | 'clear'
}

export interface StreamParams extends WindowTarget {
  /** Cursor from a previous result. Frames with a higher seq are returned. */
  since?: number
  /**
   * Long-poll budget. When no frames are buffered after `since`, the call waits
   * up to this many milliseconds for the next mutation-driven frame before
   * returning empty. Omitted or <= 0 returns immediately (a snapshot poll).
   */
  timeoutMs?: number
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
  /** Transport that produced the entry. WebSocket entries carry a `101` status on open. */
  type: 'fetch' | 'xhr' | 'websocket'
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

export interface IpcEntry {
  id: string
  command: string
  startedAt: string
  endedAt?: string
  durationMs?: number
  ok?: boolean
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

/**
 * A single mutation-driven change to the semantic tree, expressed as the set of
 * compact-tree lines added and removed since the previous frame.
 */
export interface StreamFrame {
  seq: number
  added: string[]
  removed: string[]
}

export interface StreamResult {
  /** Change frames with seq greater than the requested cursor. */
  frames: StreamFrame[]
  /** Latest seq; pass back as `since` to continue the stream. */
  cursor: number
  /** The full current compact tree, for initial sync or after `dropped`. */
  snapshot: string
  /**
   * True when frames between the requested cursor and the buffer were evicted;
   * the consumer should resync from `snapshot` rather than applying frames.
   */
  dropped: boolean
}
