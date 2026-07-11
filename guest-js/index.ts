/**
 * Guest-side control surface for the Tauri Agent bridge.
 *
 * These `agent*` helpers run inside the app webview and forward each request to
 * the Rust plugin's Tauri commands (`plugin:agent|agent_*`). They are the
 * in-process counterpart to the CLI/MCP/daemon surfaces, which reach the same
 * commands over the inline JSON-RPC server. Every helper defaults its target to
 * the current window (see {@link withCurrentWindow}) and waits for the bridge
 * response turn before invoking, so calls are safe to issue immediately after
 * {@link WebviewAgentInstrumentation} installs.
 *
 * @module
 */
import { invoke } from '@tauri-apps/api/core'
import { getCurrentWindow } from '@tauri-apps/api/window'
import {
  blurRef,
  checkRef,
  clickRef,
  currentRefRegistry,
  dragRef,
  findRefs,
  fillRef,
  focusRef,
  hoverRef,
  inspectRef,
  pressKey,
  resolveRef,
  scrollRef,
  selectRef,
  snapshotDocument,
  type DragOptions,
  type PressOptions,
  type InspectResult,
  type ScrollOptions,
  type SnapshotOptions,
  type SnapshotResult
} from './semantic-tree'
import { screenshotDocument, type ScreenshotOptions } from './screenshot'
import { evalResult } from './evaluate'
import { waitForBridgeResponseTurn } from './bridge-gate'
import type {
  ActParams,
  ActResult,
  AgentWindow,
  AgentEvent,
  CookieParams,
  CookieResult,
  CaptureResult,
  DetailResult,
  DialogParams,
  DialogResult,
  EvalResult,
  ExpectParams,
  ExpectResult,
  FindResult,
  EventsParams,
  LocationParams,
  LocationResult,
  LogsParams,
  LogEntry,
  KeyModifier,
  IpcDetail,
  IpcEntry,
  NetworkDetail,
  NetworkEntry,
  NetworkParams,
  IpcParams,
  RecordingEntry,
  StorageParams,
  StorageResult,
  StreamParams,
  StreamResult,
  UploadFileDescriptor,
  WindowAction,
  WindowBounds,
  WaitParams,
  WaitResult
} from '../protocol/types'
export { WebviewAgentInstrumentation, type InstrumentationOptions } from './instrumentation'

export {
  blurRef,
  clickRef,
  checkRef,
  currentRefRegistry,
  dragRef,
  findRefs,
  fillRef,
  focusRef,
  hoverRef,
  inspectRef,
  pressKey,
  resolveRef,
  screenshotDocument,
  scrollRef,
  selectRef,
  snapshotDocument,
  evalResult,
  type AgentEvent,
  type AgentWindow,
  type CookieParams,
  type CookieResult,
  type DialogParams,
  type DialogResult,
  type DetailResult,
  type DragOptions,
  type EvalResult,
  type ExpectParams,
  type ExpectResult,
  type EventsParams,
  type FindResult,
  type InspectResult,
  type LocationParams,
  type LocationResult,
  type LogEntry,
  type LogsParams,
  type KeyModifier,
  type IpcDetail,
  type IpcEntry,
  type NetworkDetail,
  type NetworkEntry,
  type PressOptions,
  type RecordingEntry,
  type ScreenshotOptions,
  type ScrollOptions,
  type SnapshotOptions,
  type SnapshotResult,
  type StorageParams,
  type StorageResult,
  type StreamParams,
  type StreamResult,
  type UploadFileDescriptor,
  type WindowAction,
  type WindowBounds,
  type WaitParams,
  type WaitResult
}

export interface AgentSnapshotRequest {
  window?: string
  scope?: string
  mode?: SnapshotOptions['mode']
}

export interface AgentFindRequest {
  window?: string
  scope?: string
  role?: string
  name?: string
  text?: string
  limit?: number
}

export interface AgentActRequest extends ActParams {
  window?: string
}

export type AgentActionRequest =
  | {
      window?: string
      ref: string
      action: 'click' | 'fill'
      value?: string
    }
  | {
      window?: string
      action: 'press'
      value: string
      ref?: string
      modifiers?: KeyModifier[]
    }

export interface AgentInspectRequest {
  window?: string
  ref: string
}

export interface AgentEvalRequest {
  window?: string
  code: string
}

export interface AgentSelectRequest {
  window?: string
  ref: string
  value?: string
}

export interface AgentTypeRequest {
  window?: string
  ref: string
  text: string
}

export interface AgentCheckRequest {
  window?: string
  ref: string
  checked?: boolean
}

export interface AgentUploadRequest {
  window?: string
  ref: string
  files: UploadFileDescriptor[]
}

export interface AgentHoverRequest {
  window?: string
  ref: string
}

export interface AgentFocusRequest {
  window?: string
  ref: string
}

export interface AgentBlurRequest {
  window?: string
  ref: string
}

export interface AgentScrollRequest {
  window?: string
  ref: string
  x?: number
  y?: number
}

export interface AgentDragRequest {
  window?: string
  ref: string
  toRef?: string
}

export interface AgentScreenshotRequest {
  window?: string
  path?: string
  backend?: ScreenshotOptions['backend']
  /** Snapshot-local ref to scope the capture to a single element (forces the DOM backend). */
  ref?: string
}

export interface AgentLogRequest extends LogsParams {
  window?: string
}

export interface AgentEventsRequest extends EventsParams {
  window?: string
}

export interface AgentNetworkRequest extends NetworkParams {}

export interface AgentIpcRequest extends IpcParams {}

export interface AgentStorageRequest extends StorageParams {
  window?: string
}

export interface AgentCookiesRequest extends CookieParams {
  window?: string
}

export interface AgentLocationRequest extends LocationParams {
  window?: string
}

export interface AgentWaitRequest extends WaitParams {
  window?: string
}

export interface AgentExpectRequest extends ExpectParams {
  window?: string
}

export interface AgentStateRequest {
  window?: string
  key?: string
}

export interface AgentDialogRequest extends DialogParams {
  window?: string
}

export interface AgentRecordRequest {
  window?: string
  action?: 'start' | 'stop' | 'get' | 'clear'
}

export interface AgentStreamRequest extends StreamParams {
  window?: string
}

export interface AgentWindowRequest {
  window?: string
  action?: WindowAction
  x?: number
  y?: number
  width?: number
  height?: number
}

export interface AgentWaitResponse extends WaitResult {}

export interface AgentRecordResponse {
  recording: boolean
  entries: RecordingEntry[]
}

export interface WindowInfo {
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

/** Return the compact semantic tree of the target window as ref-annotated text. */
export async function agentSnapshot(request: AgentSnapshotRequest = {}): Promise<string> {
  return invokeAgentCommand('plugin:agent|agent_snapshot', { request: withCurrentWindow(request) })
}

/** Find elements matching a role/name/text query, returning inspectable refs. */
export async function agentFind(request: AgentFindRequest = {}): Promise<FindResult> {
  return invokeAgentCommand('plugin:agent|agent_find', { request: withCurrentWindow(request) })
}

/** Locate, wait for actionability, and act in one guest turn. */
export async function agentAct(request: AgentActRequest): Promise<ActResult> {
  return invokeAgentCommand('plugin:agent|agent_act', { request: withCurrentWindow(request) })
}

/** Perform a ref-targeted action (click/fill) or a keyboard press on the window. */
export async function agentAction(request: AgentActionRequest): Promise<void> {
  return invokeAgentCommand('plugin:agent|agent_action', { request: withCurrentWindow(request) })
}

/** Return the role, name, value, attributes, and state flags for a single ref. */
export async function agentInspect(request: AgentInspectRequest): Promise<InspectResult> {
  return invokeAgentCommand('plugin:agent|agent_inspect', { request: withCurrentWindow(request) })
}

/** Evaluate arbitrary JS in the webview and return its serialized result (awaits thenables). */
export async function agentEval(request: AgentEvalRequest): Promise<EvalResult> {
  return invokeAgentCommand('plugin:agent|agent_eval', { request: withCurrentWindow(request) })
}

/** Set the selected option(s) of a `<select>` ref by value. */
export async function agentSelect(request: AgentSelectRequest): Promise<void> {
  return invokeAgentCommand('plugin:agent|agent_select', { request: withCurrentWindow(request) })
}

/** Type text into a ref one key at a time, dispatching per-keystroke input events. */
export async function agentType(request: AgentTypeRequest): Promise<void> {
  return invokeAgentCommand('plugin:agent|agent_type', { request: withCurrentWindow(request) })
}

/** Set the checked state of a checkbox/radio ref (toggles when `checked` omitted). */
export async function agentCheck(request: AgentCheckRequest): Promise<void> {
  return invokeAgentCommand('plugin:agent|agent_check', { request: withCurrentWindow(request) })
}

/** Set synthetic files on an `<input type="file">` ref and fire input/change. */
export async function agentUpload(request: AgentUploadRequest): Promise<void> {
  return invokeAgentCommand('plugin:agent|agent_upload', { request: withCurrentWindow(request) })
}

/** Dispatch pointer hover events over a ref. */
export async function agentHover(request: AgentHoverRequest): Promise<void> {
  return invokeAgentCommand('plugin:agent|agent_hover', { request: withCurrentWindow(request) })
}

/** Move keyboard focus to a ref. */
export async function agentFocus(request: AgentFocusRequest): Promise<void> {
  return invokeAgentCommand('plugin:agent|agent_focus', { request: withCurrentWindow(request) })
}

/** Remove keyboard focus from a ref. */
export async function agentBlur(request: AgentBlurRequest): Promise<void> {
  return invokeAgentCommand('plugin:agent|agent_blur', { request: withCurrentWindow(request) })
}

/** Scroll a ref into view, or by an (x, y) delta when provided. */
export async function agentScroll(request: AgentScrollRequest): Promise<void> {
  return invokeAgentCommand('plugin:agent|agent_scroll', { request: withCurrentWindow(request) })
}

/** Dispatch a drag gesture from a ref, optionally dropping onto `toRef`. */
export async function agentDrag(request: AgentDragRequest): Promise<void> {
  return invokeAgentCommand('plugin:agent|agent_drag', { request: withCurrentWindow(request) })
}

/** Capture a screenshot of the window (DOM or native backend) as a data URL or file path. */
export async function agentScreenshot(request: AgentScreenshotRequest = {}): Promise<string> {
  return invokeAgentCommand('plugin:agent|agent_screenshot', { request: withCurrentWindow(request) })
}

/** Return captured `console` log entries, optionally clearing the buffer. */
export async function agentLogs(request: AgentLogRequest = {}): Promise<CaptureResult<LogEntry>> {
  return invokeAgentCommand('plugin:agent|agent_logs', { request: withCurrentWindow(request) })
}

/** Return captured lifecycle/runtime events; a bare string is treated as a window label. */
export async function agentEvents(request: AgentEventsRequest | string = {}): Promise<CaptureResult<AgentEvent>> {
  return invokeAgentCommand('plugin:agent|agent_events', {
    request: withCurrentWindow(typeof request === 'string' ? { window: request } : request)
  })
}

/** Return captured network (fetch/XHR/WebSocket) entries, optionally clearing the buffer. */
export function agentNetwork(request: AgentNetworkRequest & { id: string }): Promise<DetailResult<NetworkDetail>>
export function agentNetwork(request?: AgentNetworkRequest): Promise<CaptureResult<NetworkEntry>>
export async function agentNetwork(request: AgentNetworkRequest = {}): Promise<CaptureResult<NetworkEntry> | DetailResult<NetworkDetail>> {
  return invokeAgentCommand('plugin:agent|agent_network', { request: withCurrentWindow(request) })
}

/** Return captured Tauri IPC invoke entries (command, timing, ok/error). */
export function agentIpc(request: AgentIpcRequest & { id: string }): Promise<DetailResult<IpcDetail>>
export function agentIpc(request?: AgentIpcRequest): Promise<CaptureResult<IpcEntry>>
export async function agentIpc(request: AgentIpcRequest = {}): Promise<CaptureResult<IpcEntry> | DetailResult<IpcDetail>> {
  return invokeAgentCommand('plugin:agent|agent_ipc', { request: withCurrentWindow(request) })
}

/** Read or mutate localStorage/sessionStorage for the target window. */
export async function agentStorage(request: AgentStorageRequest = {}): Promise<StorageResult> {
  return invokeAgentCommand('plugin:agent|agent_storage', { request: withCurrentWindow(request) })
}

/** Read or mutate document cookies for the target window. */
export async function agentCookies(request: AgentCookiesRequest = {}): Promise<CookieResult> {
  return invokeAgentCommand('plugin:agent|agent_cookies', { request: withCurrentWindow(request) })
}

/** Read the current location or drive navigation (push/replace/reload/back/forward). */
export async function agentLocation(request: AgentLocationRequest = {}): Promise<LocationResult> {
  return invokeAgentCommand('plugin:agent|agent_location', { request: withCurrentWindow(request) })
}

/** Wait for a text/semantic target to appear (or disappear, with `state: 'absent'`). */
export async function agentWait(request: AgentWaitRequest): Promise<AgentWaitResponse> {
  return invokeAgentCommand('plugin:agent|agent_wait', { request: withCurrentWindow(request) })
}

/** Assert a locator's presence/absence, value, or state flag in one round trip. */
export async function agentExpect(request: AgentExpectRequest): Promise<ExpectResult> {
  return invokeAgentCommand('plugin:agent|agent_expect', { request: withCurrentWindow(request) })
}

/** Read or set the auto-dialog policy (alert/confirm/prompt) and read the dialog log. */
export async function agentDialog(request: AgentDialogRequest = {}): Promise<DialogResult> {
  return invokeAgentCommand('plugin:agent|agent_dialog', { request: withCurrentWindow(request) })
}

/** Read the app's exposed agent state map, or a single key when `key` is set. */
export async function agentState(request?: AgentStateRequest & { key?: undefined }): Promise<Record<string, unknown>>
export async function agentState(request: AgentStateRequest & { key: string }): Promise<unknown>
export async function agentState(request: AgentStateRequest): Promise<unknown>
export async function agentState(request: AgentStateRequest = {}): Promise<unknown> {
  return invokeAgentCommand('plugin:agent|agent_state', { request: withCurrentWindow(request) })
}

/** Control action recording (start/stop/get/clear) for replayable scripts. */
export async function agentRecord(request: AgentRecordRequest = {}): Promise<AgentRecordResponse> {
  return invokeAgentCommand('plugin:agent|agent_record', { request: withCurrentWindow(request) })
}

/** Long-poll the mutation-driven semantic diff stream from a cursor. */
export async function agentStream(request: AgentStreamRequest = {}): Promise<StreamResult> {
  return invokeAgentCommand('plugin:agent|agent_stream', { request: withCurrentWindow(request) })
}

/** Query or control a single window (get/focus/show/hide/size/position). */
export async function agentWindow(request: AgentWindowRequest = {}): Promise<AgentWindow> {
  return invokeAgentCommand('plugin:agent|agent_window', { request: withCurrentWindow(request) })
}

/** Enumerate all webview windows the plugin can address. */
export async function agentWindows(): Promise<WindowInfo[]> {
  return invokeAgentCommand('plugin:agent|agent_windows')
}

type WindowRequest = { window?: string }

function withCurrentWindow<TRequest extends WindowRequest>(request: TRequest): TRequest {
  if (request.window) {
    return request
  }
  try {
    const windowLabel = getCurrentWindow().label
    return windowLabel ? { ...request, window: windowLabel } : request
  } catch {
    return request
  }
}

type AgentInvokeArgs = Parameters<typeof invoke>[1]

async function invokeAgentCommand<TResponse>(command: string, args?: AgentInvokeArgs): Promise<TResponse> {
  await waitForBridgeResponseTurn()
  return args === undefined ? invoke<TResponse>(command) : invoke<TResponse>(command, args)
}
