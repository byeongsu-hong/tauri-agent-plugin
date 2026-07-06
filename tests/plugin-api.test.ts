import { beforeEach, describe, expect, it, vi } from 'vitest'

const invokeMock = vi.hoisted(() => vi.fn())
const currentWindowMock = vi.hoisted(() => ({
  label: 'secondary'
}))

vi.mock('@tauri-apps/api/core', () => ({
  invoke: invokeMock
}))

vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => currentWindowMock
}))

import {
  agentAction,
  agentBlur,
  agentCheck,
  agentDrag,
  agentEvents,
  agentEval,
  agentFind,
  agentFocus,
  agentHover,
  agentInspect,
  agentLocation,
  agentLogs,
  agentNetwork,
  agentRecord,
  agentScreenshot,
  agentSelect,
  agentScroll,
  agentSnapshot,
  agentState,
  agentStorage,
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
    await agentFind({ window: 'main', role: 'button', name: 'Forge', limit: 1 })
    await agentInspect({ window: 'main', ref: '@1' })
    await agentEval({ window: 'main', code: 'document.title' })
    await agentSelect({ window: 'main', ref: '@2', value: 'remote' })
    await agentCheck({ window: 'main', ref: '@3', checked: true })
    await agentHover({ window: 'main', ref: '@4' })
    await agentFocus({ window: 'main', ref: '@5' })
    await agentBlur({ window: 'main', ref: '@6' })
    await agentScroll({ window: 'main', ref: '@7', y: 12, x: 3 })
    await agentDrag({ window: 'main', ref: '@8', toRef: '@9' })
    await agentAction({ window: 'main', action: 'click', ref: '@1' })
    await agentAction({ window: 'main', action: 'press', value: 'Enter' })
    await agentScreenshot({ window: 'main', path: '/tmp/app.svg' })
    await agentLogs({ window: 'main', clear: true })
    await agentNetwork({ window: 'main', clear: true })
    await agentEvents({ window: 'main', clear: true })
    await agentStorage({ window: 'main', action: 'set', key: 'agent.token', value: 'ready' })
    await agentLocation({ window: 'main', action: 'push', url: '/agents' })
    await agentWait({ window: 'main', text: 'Ready', timeoutMs: 250 })
    await agentWait({ window: 'main', role: 'button', name: 'Forge', timeoutMs: 250 })
    await agentState({ window: 'main' })
    await agentRecord({ window: 'main', action: 'start' })
    await agentWindows()

    expect(invokeMock.mock.calls).toEqual([
      ['plugin:agent|agent_snapshot', { request: { window: 'main', scope: 'main' } }],
      ['plugin:agent|agent_find', { request: { window: 'main', role: 'button', name: 'Forge', limit: 1 } }],
      ['plugin:agent|agent_inspect', { request: { window: 'main', ref: '@1' } }],
      ['plugin:agent|agent_eval', { request: { window: 'main', code: 'document.title' } }],
      ['plugin:agent|agent_select', { request: { window: 'main', ref: '@2', value: 'remote' } }],
      ['plugin:agent|agent_check', { request: { window: 'main', ref: '@3', checked: true } }],
      ['plugin:agent|agent_hover', { request: { window: 'main', ref: '@4' } }],
      ['plugin:agent|agent_focus', { request: { window: 'main', ref: '@5' } }],
      ['plugin:agent|agent_blur', { request: { window: 'main', ref: '@6' } }],
      ['plugin:agent|agent_scroll', { request: { window: 'main', ref: '@7', y: 12, x: 3 } }],
      ['plugin:agent|agent_drag', { request: { window: 'main', ref: '@8', toRef: '@9' } }],
      ['plugin:agent|agent_action', { request: { window: 'main', action: 'click', ref: '@1' } }],
      ['plugin:agent|agent_action', { request: { window: 'main', action: 'press', value: 'Enter' } }],
      ['plugin:agent|agent_screenshot', { request: { window: 'main', path: '/tmp/app.svg' } }],
      ['plugin:agent|agent_logs', { request: { window: 'main', clear: true } }],
      ['plugin:agent|agent_network', { request: { window: 'main', clear: true } }],
      ['plugin:agent|agent_events', { request: { window: 'main', clear: true } }],
      ['plugin:agent|agent_storage', { request: { window: 'main', action: 'set', key: 'agent.token', value: 'ready' } }],
      ['plugin:agent|agent_location', { request: { window: 'main', action: 'push', url: '/agents' } }],
      ['plugin:agent|agent_wait', { request: { window: 'main', text: 'Ready', timeoutMs: 250 } }],
      ['plugin:agent|agent_wait', { request: { window: 'main', role: 'button', name: 'Forge', timeoutMs: 250 } }],
      ['plugin:agent|agent_state', { request: { window: 'main' } }],
      ['plugin:agent|agent_record', { request: { window: 'main', action: 'start' } }],
      ['plugin:agent|agent_windows']
    ])
  })

  it('defaults direct Tauri command helpers to the current window label', async () => {
    await agentSnapshot({ scope: 'main' })
    await agentFind({ role: 'button', name: 'Forge', limit: 1 })
    await agentInspect({ ref: '@1' })
    await agentEval({ code: 'document.title' })
    await agentSelect({ ref: '@2', value: 'remote' })
    await agentCheck({ ref: '@3', checked: true })
    await agentHover({ ref: '@4' })
    await agentFocus({ ref: '@5' })
    await agentBlur({ ref: '@6' })
    await agentScroll({ ref: '@7', y: 12, x: 3 })
    await agentDrag({ ref: '@8', toRef: '@9' })
    await agentAction({ action: 'click', ref: '@1' })
    await agentAction({ action: 'press', value: 'Enter' })
    await agentScreenshot({ path: '/tmp/app.svg' })
    await agentLogs()
    await agentNetwork()
    await agentEvents()
    await agentStorage({ key: 'agent.token' })
    await agentLocation({ url: '/status' })
    await agentWait({ text: 'Ready', timeoutMs: 250 })
    await agentState()
    await agentRecord({ action: 'start' })

    expect(invokeMock.mock.calls).toEqual([
      ['plugin:agent|agent_snapshot', { request: { window: 'secondary', scope: 'main' } }],
      ['plugin:agent|agent_find', { request: { window: 'secondary', role: 'button', name: 'Forge', limit: 1 } }],
      ['plugin:agent|agent_inspect', { request: { window: 'secondary', ref: '@1' } }],
      ['plugin:agent|agent_eval', { request: { window: 'secondary', code: 'document.title' } }],
      ['plugin:agent|agent_select', { request: { window: 'secondary', ref: '@2', value: 'remote' } }],
      ['plugin:agent|agent_check', { request: { window: 'secondary', ref: '@3', checked: true } }],
      ['plugin:agent|agent_hover', { request: { window: 'secondary', ref: '@4' } }],
      ['plugin:agent|agent_focus', { request: { window: 'secondary', ref: '@5' } }],
      ['plugin:agent|agent_blur', { request: { window: 'secondary', ref: '@6' } }],
      ['plugin:agent|agent_scroll', { request: { window: 'secondary', ref: '@7', y: 12, x: 3 } }],
      ['plugin:agent|agent_drag', { request: { window: 'secondary', ref: '@8', toRef: '@9' } }],
      ['plugin:agent|agent_action', { request: { window: 'secondary', action: 'click', ref: '@1' } }],
      ['plugin:agent|agent_action', { request: { window: 'secondary', action: 'press', value: 'Enter' } }],
      ['plugin:agent|agent_screenshot', { request: { window: 'secondary', path: '/tmp/app.svg' } }],
      ['plugin:agent|agent_logs', { request: { window: 'secondary' } }],
      ['plugin:agent|agent_network', { request: { window: 'secondary' } }],
      ['plugin:agent|agent_events', { request: { window: 'secondary' } }],
      ['plugin:agent|agent_storage', { request: { window: 'secondary', key: 'agent.token' } }],
      ['plugin:agent|agent_location', { request: { window: 'secondary', url: '/status' } }],
      ['plugin:agent|agent_wait', { request: { window: 'secondary', text: 'Ready', timeoutMs: 250 } }],
      ['plugin:agent|agent_state', { request: { window: 'secondary' } }],
      ['plugin:agent|agent_record', { request: { window: 'secondary', action: 'start' } }]
    ])
  })
})
