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
  type InspectResult,
  type ScrollOptions,
  type SnapshotOptions,
  type SnapshotResult
} from './semantic-tree'
import { screenshotDocument, type ScreenshotOptions } from './screenshot'
import { evalResult } from './evaluate'
import { waitForBridgeResponseTurn } from './bridge-gate'
import type {
  AgentWindow,
  AgentEvent,
  CookieParams,
  CookieResult,
  EvalResult,
  FindResult,
  EventsParams,
  LocationParams,
  LocationResult,
  LogsParams,
  LogEntry,
  NetworkEntry,
  RecordingEntry,
  StorageParams,
  StorageResult,
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
  type DragOptions,
  type EvalResult,
  type EventsParams,
  type FindResult,
  type InspectResult,
  type LocationParams,
  type LocationResult,
  type LogEntry,
  type LogsParams,
  type NetworkEntry,
  type RecordingEntry,
  type ScreenshotOptions,
  type ScrollOptions,
  type SnapshotOptions,
  type SnapshotResult,
  type StorageParams,
  type StorageResult,
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

export interface AgentCheckRequest {
  window?: string
  ref: string
  checked?: boolean
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
}

export interface AgentLogRequest extends LogsParams {
  window?: string
}

export interface AgentEventsRequest extends EventsParams {
  window?: string
}

export interface AgentNetworkRequest {
  window?: string
  follow?: boolean
  clear?: boolean
}

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

export interface AgentStateRequest {
  window?: string
  key?: string
}

export interface AgentRecordRequest {
  window?: string
  action?: 'start' | 'stop' | 'get' | 'clear'
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

export async function agentSnapshot(request: AgentSnapshotRequest = {}): Promise<string> {
  return invokeAgentCommand('plugin:agent|agent_snapshot', { request: withCurrentWindow(request) })
}

export async function agentFind(request: AgentFindRequest = {}): Promise<FindResult> {
  return invokeAgentCommand('plugin:agent|agent_find', { request: withCurrentWindow(request) })
}

export async function agentAction(request: AgentActionRequest): Promise<void> {
  return invokeAgentCommand('plugin:agent|agent_action', { request: withCurrentWindow(request) })
}

export async function agentInspect(request: AgentInspectRequest): Promise<InspectResult> {
  return invokeAgentCommand('plugin:agent|agent_inspect', { request: withCurrentWindow(request) })
}

export async function agentEval(request: AgentEvalRequest): Promise<EvalResult> {
  return invokeAgentCommand('plugin:agent|agent_eval', { request: withCurrentWindow(request) })
}

export async function agentSelect(request: AgentSelectRequest): Promise<void> {
  return invokeAgentCommand('plugin:agent|agent_select', { request: withCurrentWindow(request) })
}

export async function agentCheck(request: AgentCheckRequest): Promise<void> {
  return invokeAgentCommand('plugin:agent|agent_check', { request: withCurrentWindow(request) })
}

export async function agentHover(request: AgentHoverRequest): Promise<void> {
  return invokeAgentCommand('plugin:agent|agent_hover', { request: withCurrentWindow(request) })
}

export async function agentFocus(request: AgentFocusRequest): Promise<void> {
  return invokeAgentCommand('plugin:agent|agent_focus', { request: withCurrentWindow(request) })
}

export async function agentBlur(request: AgentBlurRequest): Promise<void> {
  return invokeAgentCommand('plugin:agent|agent_blur', { request: withCurrentWindow(request) })
}

export async function agentScroll(request: AgentScrollRequest): Promise<void> {
  return invokeAgentCommand('plugin:agent|agent_scroll', { request: withCurrentWindow(request) })
}

export async function agentDrag(request: AgentDragRequest): Promise<void> {
  return invokeAgentCommand('plugin:agent|agent_drag', { request: withCurrentWindow(request) })
}

export async function agentScreenshot(request: AgentScreenshotRequest = {}): Promise<string> {
  return invokeAgentCommand('plugin:agent|agent_screenshot', { request: withCurrentWindow(request) })
}

export async function agentLogs(request: AgentLogRequest = {}): Promise<LogEntry[]> {
  return invokeAgentCommand('plugin:agent|agent_logs', { request: withCurrentWindow(request) })
}

export async function agentEvents(request: AgentEventsRequest | string = {}): Promise<AgentEvent[]> {
  return invokeAgentCommand('plugin:agent|agent_events', {
    request: withCurrentWindow(typeof request === 'string' ? { window: request } : request)
  })
}

export async function agentNetwork(request: AgentNetworkRequest = {}): Promise<NetworkEntry[]> {
  return invokeAgentCommand('plugin:agent|agent_network', { request: withCurrentWindow(request) })
}

export async function agentStorage(request: AgentStorageRequest = {}): Promise<StorageResult> {
  return invokeAgentCommand('plugin:agent|agent_storage', { request: withCurrentWindow(request) })
}

export async function agentCookies(request: AgentCookiesRequest = {}): Promise<CookieResult> {
  return invokeAgentCommand('plugin:agent|agent_cookies', { request: withCurrentWindow(request) })
}

export async function agentLocation(request: AgentLocationRequest = {}): Promise<LocationResult> {
  return invokeAgentCommand('plugin:agent|agent_location', { request: withCurrentWindow(request) })
}

export async function agentWait(request: AgentWaitRequest): Promise<AgentWaitResponse> {
  return invokeAgentCommand('plugin:agent|agent_wait', { request: withCurrentWindow(request) })
}

export async function agentState(request: AgentStateRequest = {}): Promise<Record<string, unknown>> {
  return invokeAgentCommand('plugin:agent|agent_state', { request: withCurrentWindow(request) })
}

export async function agentRecord(request: AgentRecordRequest = {}): Promise<AgentRecordResponse> {
  return invokeAgentCommand('plugin:agent|agent_record', { request: withCurrentWindow(request) })
}

export async function agentWindow(request: AgentWindowRequest = {}): Promise<AgentWindow> {
  return invokeAgentCommand('plugin:agent|agent_window', { request: withCurrentWindow(request) })
}

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
