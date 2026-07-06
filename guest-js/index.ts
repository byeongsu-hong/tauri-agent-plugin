import { invoke } from '@tauri-apps/api/core'
import {
  clickRef,
  currentRefRegistry,
  fillRef,
  pressKey,
  resolveRef,
  snapshotDocument,
  type SnapshotOptions,
  type SnapshotResult
} from './semantic-tree'
import { screenshotDocument, type ScreenshotOptions } from './screenshot'
export { WebviewAgentInstrumentation, type InstrumentationOptions } from './instrumentation'

export {
  clickRef,
  currentRefRegistry,
  fillRef,
  pressKey,
  resolveRef,
  screenshotDocument,
  snapshotDocument,
  type ScreenshotOptions,
  type SnapshotOptions,
  type SnapshotResult
}

export interface AgentSnapshotRequest {
  window?: string
  scope?: string
  mode?: SnapshotOptions['mode']
}

export interface AgentActionRequest {
  window?: string
  ref: string
  action: 'click' | 'fill' | 'press'
  value?: string
}

export interface AgentScreenshotRequest {
  window?: string
  path?: string
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

export async function agentScreenshot(request: AgentScreenshotRequest = {}): Promise<string> {
  return invoke('plugin:agent|agent_screenshot', { request })
}

export async function agentEvents(window?: string): Promise<void> {
  return invoke('plugin:agent|agent_events', { window })
}

export async function agentWindows(): Promise<WindowInfo[]> {
  return invoke('plugin:agent|agent_windows')
}
