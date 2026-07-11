import { beforeEach, describe, expect, it, vi } from 'vitest'

const invokeMock = vi.hoisted(() => vi.fn())
const listenMock = vi.hoisted(() => vi.fn())
const currentWindowListenMock = vi.hoisted(() => vi.fn())

vi.mock('@tauri-apps/api/core', () => ({
  invoke: invokeMock
}))

vi.mock('@tauri-apps/api/event', () => ({
  listen: listenMock
}))

vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({
    label: 'main',
    listen: currentWindowListenMock
  })
}))

import { WebviewAgentInstrumentation } from '../guest-js/instrumentation'
import { agentFind } from '../guest-js/index'

interface CapturedEvent {
  payload: {
    id: string
    method: 'click' | 'act' | 'find'
    params: unknown
  }
}

describe('WebviewAgentInstrumentation bridge handling', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
    invokeMock.mockReset()
    invokeMock.mockImplementation(() => Promise.resolve({ matches: [] }))
    listenMock.mockReset()
    currentWindowListenMock.mockReset()
    currentWindowListenMock.mockResolvedValue(() => {})
  })

  it('sends the active bridge response before direct helper calls started by the DOM action', async () => {
    let bridgeHandler: ((event: CapturedEvent) => void) | undefined
    listenMock.mockImplementation((_event, handler) => {
      bridgeHandler = handler
      return Promise.resolve(() => {})
    })
    document.body.innerHTML = '<button>Verify command bridge</button>'
    document.querySelector('button')?.addEventListener('click', () => {
      void agentFind({ role: 'button', name: 'Verify' })
    })

    const instrumentation = new WebviewAgentInstrumentation({ windowLabel: 'main' })
    instrumentation.install()
    instrumentation.snapshot()

    bridgeHandler?.({
      payload: {
        id: 'bridge-1',
        method: 'click',
        params: { ref: '@1' }
      }
    })

    await waitForInvoke('plugin:agent|agent_find')

    expect(invokeMock.mock.calls.map(([command]) => command)).toEqual([
      'plugin:agent|agent_bridge_response',
      'plugin:agent|agent_find'
    ])

    instrumentation.dispose()
  })

  it('returns stable atomic-action error codes through the bridge', async () => {
    let bridgeHandler: ((event: CapturedEvent) => void) | undefined
    listenMock.mockImplementation((_event, handler) => {
      bridgeHandler = handler
      return Promise.resolve(() => {})
    })
    const instrumentation = new WebviewAgentInstrumentation({ windowLabel: 'main' })
    instrumentation.install()

    bridgeHandler?.({ payload: { id: 'bridge-2', method: 'act', params: { action: 'click' } } })
    await waitForInvoke('plugin:agent|agent_bridge_response')
    expect(invokeMock).toHaveBeenCalledWith('plugin:agent|agent_bridge_response', {
      response: {
        id: 'bridge-2',
        error: 'act requires a locator',
        errorCode: 'INVALID_PARAMS'
      }
    })
    instrumentation.dispose()
  })

  it('returns requested atomic-action match detail through the bridge', async () => {
    let bridgeHandler: ((event: CapturedEvent) => void) | undefined
    listenMock.mockImplementation((_event, handler) => {
      bridgeHandler = handler
      return Promise.resolve(() => {})
    })
    document.body.innerHTML = '<button>Save</button>'
    const instrumentation = new WebviewAgentInstrumentation({ windowLabel: 'main' })
    instrumentation.install()

    bridgeHandler?.({
      payload: {
        id: 'bridge-3',
        method: 'act',
        params: { role: 'button', name: 'Save', action: 'focus', detail: true }
      }
    })
    await waitForInvoke('plugin:agent|agent_bridge_response')
    expect(invokeMock).toHaveBeenCalledWith('plugin:agent|agent_bridge_response', {
      response: {
        id: 'bridge-3',
        result: expect.objectContaining({
          ok: true,
          match: expect.objectContaining({ role: 'button', name: 'Save' })
        })
      }
    })
    instrumentation.dispose()
  })

  it('returns INVALID_PARAMS for malformed live bridge fields', async () => {
    let bridgeHandler: ((event: CapturedEvent) => void) | undefined
    listenMock.mockImplementation((_event, handler) => {
      bridgeHandler = handler
      return Promise.resolve(() => {})
    })
    const instrumentation = new WebviewAgentInstrumentation({ windowLabel: 'main' })
    instrumentation.install()

    bridgeHandler?.({ payload: { id: 'bridge-4', method: 'find', params: { limit: '1' } } })
    await waitForInvoke('plugin:agent|agent_bridge_response')
    expect(invokeMock).toHaveBeenCalledWith('plugin:agent|agent_bridge_response', {
      response: {
        id: 'bridge-4',
        error: 'limit must be a non-negative safe integer',
        errorCode: 'INVALID_PARAMS'
      }
    })
    instrumentation.dispose()
  })

  it('returns INVALID_PARAMS for non-object live bridge params', async () => {
    let bridgeHandler: ((event: CapturedEvent) => void) | undefined
    listenMock.mockImplementation((_event, handler) => {
      bridgeHandler = handler
      return Promise.resolve(() => {})
    })
    const instrumentation = new WebviewAgentInstrumentation({ windowLabel: 'main' })
    instrumentation.install()

    bridgeHandler?.({ payload: { id: 'bridge-5', method: 'find', params: [] } })
    await waitForInvoke('plugin:agent|agent_bridge_response')
    expect(invokeMock).toHaveBeenCalledWith('plugin:agent|agent_bridge_response', {
      response: {
        id: 'bridge-5',
        error: 'params must be an object',
        errorCode: 'INVALID_PARAMS'
      }
    })
    instrumentation.dispose()
  })

  it('returns INVALID_PARAMS for negative unsigned live bridge fields', async () => {
    let bridgeHandler: ((event: CapturedEvent) => void) | undefined
    listenMock.mockImplementation((_event, handler) => {
      bridgeHandler = handler
      return Promise.resolve(() => {})
    })
    const instrumentation = new WebviewAgentInstrumentation({ windowLabel: 'main' })
    instrumentation.install()

    bridgeHandler?.({ payload: { id: 'bridge-6', method: 'find', params: { limit: -1 } } })
    await waitForInvoke('plugin:agent|agent_bridge_response')
    expect(invokeMock).toHaveBeenCalledWith('plugin:agent|agent_bridge_response', {
      response: {
        id: 'bridge-6',
        error: 'limit must be a non-negative safe integer',
        errorCode: 'INVALID_PARAMS'
      }
    })
    instrumentation.dispose()
  })
})

async function waitForInvoke(command: string): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt++) {
    if (invokeMock.mock.calls.some(([calledCommand]) => calledCommand === command)) {
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 1))
  }
  throw new Error(`timed out waiting for ${command}`)
}
