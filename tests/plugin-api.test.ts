import { beforeEach, describe, expect, it, vi } from 'vitest'

const invokeMock = vi.hoisted(() => vi.fn())

vi.mock('@tauri-apps/api/core', () => ({
  invoke: invokeMock
}))

import {
  agentAction,
  agentBlur,
  agentCheck,
  agentEvents,
  agentEval,
  agentFocus,
  agentHover,
  agentInspect,
  agentLogs,
  agentRecord,
  agentScreenshot,
  agentSelect,
  agentSnapshot,
  agentState,
  agentWait,
  agentWindows
} from '../guest-js/index'

describe('plugin command helpers', () => {
  beforeEach(() => {
    invokeMock.mockReset()
    invokeMock.mockResolvedValue(undefined)
  })

  it('routes every direct Tauri command helper through the plugin invoke surface', async () => {
    await agentSnapshot({ window: 'main', scope: 'main' })
    await agentInspect({ window: 'main', ref: '@1' })
    await agentEval({ window: 'main', code: 'document.title' })
    await agentSelect({ window: 'main', ref: '@2', value: 'remote' })
    await agentCheck({ window: 'main', ref: '@3', checked: true })
    await agentHover({ window: 'main', ref: '@4' })
    await agentFocus({ window: 'main', ref: '@5' })
    await agentBlur({ window: 'main', ref: '@6' })
    await agentAction({ window: 'main', action: 'click', ref: '@1' })
    await agentAction({ window: 'main', action: 'press', value: 'Enter' })
    await agentScreenshot({ window: 'main', path: '/tmp/app.svg' })
    await agentLogs({ window: 'main' })
    await agentEvents({ window: 'main' })
    await agentWait({ window: 'main', text: 'Ready', timeoutMs: 250 })
    await agentState({ window: 'main' })
    await agentRecord({ window: 'main', action: 'start' })
    await agentWindows()

    expect(invokeMock.mock.calls).toEqual([
      ['plugin:agent|agent_snapshot', { request: { window: 'main', scope: 'main' } }],
      ['plugin:agent|agent_inspect', { request: { window: 'main', ref: '@1' } }],
      ['plugin:agent|agent_eval', { request: { window: 'main', code: 'document.title' } }],
      ['plugin:agent|agent_select', { request: { window: 'main', ref: '@2', value: 'remote' } }],
      ['plugin:agent|agent_check', { request: { window: 'main', ref: '@3', checked: true } }],
      ['plugin:agent|agent_hover', { request: { window: 'main', ref: '@4' } }],
      ['plugin:agent|agent_focus', { request: { window: 'main', ref: '@5' } }],
      ['plugin:agent|agent_blur', { request: { window: 'main', ref: '@6' } }],
      ['plugin:agent|agent_action', { request: { window: 'main', action: 'click', ref: '@1' } }],
      ['plugin:agent|agent_action', { request: { window: 'main', action: 'press', value: 'Enter' } }],
      ['plugin:agent|agent_screenshot', { request: { window: 'main', path: '/tmp/app.svg' } }],
      ['plugin:agent|agent_logs', { request: { window: 'main' } }],
      ['plugin:agent|agent_events', { request: { window: 'main' } }],
      ['plugin:agent|agent_wait', { request: { window: 'main', text: 'Ready', timeoutMs: 250 } }],
      ['plugin:agent|agent_state', { request: { window: 'main' } }],
      ['plugin:agent|agent_record', { request: { window: 'main', action: 'start' } }],
      ['plugin:agent|agent_windows']
    ])
  })
})
