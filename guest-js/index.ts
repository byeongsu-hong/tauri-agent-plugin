import { invoke } from '@tauri-apps/api/core'
import {
  blurRef,
  checkRef,
  clickRef,
  currentRefRegistry,
  fillRef,
  focusRef,
  hoverRef,
  inspectRef,
  pressKey,
  resolveRef,
  selectRef,
  snapshotDocument,
  type InspectResult,
  type SnapshotOptions,
  type SnapshotResult
} from './semantic-tree'
import { screenshotDocument, type ScreenshotOptions } from './screenshot'
import { evalResult } from './evaluate'
import type { AgentEvent, EvalResult, LogEntry, RecordingEntry } from '../protocol/types'
export { WebviewAgentInstrumentation, type InstrumentationOptions } from './instrumentation'

export {
  blurRef,
  clickRef,
  checkRef,
  currentRefRegistry,
  fillRef,
  focusRef,
  hoverRef,
  inspectRef,
  pressKey,
  resolveRef,
  screenshotDocument,
  selectRef,
  snapshotDocument,
  evalResult,
  type AgentEvent,
  type EvalResult,
  type InspectResult,
  type LogEntry,
  type RecordingEntry,
  type ScreenshotOptions,
  type SnapshotOptions,
  type SnapshotResult
}

export interface AgentSnapshotRequest {
  window?: string
  scope?: string
  mode?: SnapshotOptions['mode']
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

export interface AgentScreenshotRequest {
  window?: string
  path?: string
}

export interface AgentLogRequest {
  window?: string
  follow?: boolean
}

export interface AgentEventsRequest {
  window?: string
  follow?: boolean
}

export interface AgentWaitRequest {
  window?: string
  text: string
  timeoutMs?: number
}

export interface AgentStateRequest {
  window?: string
  key?: string
}

export interface AgentRecordRequest {
  window?: string
  action?: 'start' | 'stop' | 'get' | 'clear'
}

export interface AgentWaitResponse {
  matched: boolean
  text: string
}

export interface AgentRecordResponse {
  recording: boolean
  entries: RecordingEntry[]
}

export interface WindowInfo {
  label: string
  title?: string
  focused: boolean
  visible: boolean
}

export async function agentSnapshot(request: AgentSnapshotRequest = {}): Promise<string> {
  return invoke('plugin:agent|agent_snapshot', { request })
}

export async function agentAction(request: AgentActionRequest): Promise<void> {
  return invoke('plugin:agent|agent_action', { request })
}

export async function agentInspect(request: AgentInspectRequest): Promise<InspectResult> {
  return invoke('plugin:agent|agent_inspect', { request })
}

export async function agentEval(request: AgentEvalRequest): Promise<EvalResult> {
  return invoke('plugin:agent|agent_eval', { request })
}

export async function agentSelect(request: AgentSelectRequest): Promise<void> {
  return invoke('plugin:agent|agent_select', { request })
}

export async function agentCheck(request: AgentCheckRequest): Promise<void> {
  return invoke('plugin:agent|agent_check', { request })
}

export async function agentHover(request: AgentHoverRequest): Promise<void> {
  return invoke('plugin:agent|agent_hover', { request })
}

export async function agentFocus(request: AgentFocusRequest): Promise<void> {
  return invoke('plugin:agent|agent_focus', { request })
}

export async function agentBlur(request: AgentBlurRequest): Promise<void> {
  return invoke('plugin:agent|agent_blur', { request })
}

export async function agentScreenshot(request: AgentScreenshotRequest = {}): Promise<string> {
  return invoke('plugin:agent|agent_screenshot', { request })
}

export async function agentLogs(request: AgentLogRequest = {}): Promise<LogEntry[]> {
  return invoke('plugin:agent|agent_logs', { request })
}

export async function agentEvents(request: AgentEventsRequest | string = {}): Promise<AgentEvent[]> {
  return invoke('plugin:agent|agent_events', {
    request: typeof request === 'string' ? { window: request } : request
  })
}

export async function agentWait(request: AgentWaitRequest): Promise<AgentWaitResponse> {
  return invoke('plugin:agent|agent_wait', { request })
}

export async function agentState(request: AgentStateRequest = {}): Promise<Record<string, unknown>> {
  return invoke('plugin:agent|agent_state', { request })
}

export async function agentRecord(request: AgentRecordRequest = {}): Promise<AgentRecordResponse> {
  return invoke('plugin:agent|agent_record', { request })
}

export async function agentWindows(): Promise<WindowInfo[]> {
  return invoke('plugin:agent|agent_windows')
}
