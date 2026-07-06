import { beforeEach, describe, expect, it, vi } from 'vitest'

const invokeMock = vi.hoisted(() => vi.fn())

vi.mock('@tauri-apps/api/core', () => ({
  invoke: invokeMock
}))

import {
  agentAction,
  agentEvents,
  agentLogs,
  agentRecord,
  agentScreenshot,
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
