import { describe, expect, it } from 'vitest'

import { DebuggerClient } from '../daemon/client'
import { createDebuggerRpcHandler, InProcessTransport } from '../daemon/server'
import { DebuggerSession } from '../daemon/session'
import { StaticHtmlAppAdapter } from '../daemon/static-app'
import { createSuccessResponse } from '../protocol/json-rpc'

describe('debugger JSON-RPC transport', () => {
  it('round-trips client calls through the server handler', async () => {
    const session = new DebuggerSession(
      new StaticHtmlAppAdapter({
        title: 'Ducktape',
        html: '<main aria-label="Ducktape"><label>Agent name<input aria-label="Agent name"></label></main>'
      })
    )
    const client = new DebuggerClient(new InProcessTransport(createDebuggerRpcHandler(session)))

    await expect(client.call('windows')).resolves.toEqual([
      staticWindowInfo('Ducktape')
    ])
    await expect(client.call('tree')).resolves.toEqual({
      text: 'main "Ducktape"\n@1 textbox "Agent name" empty'
    })
    await expect(client.call('fill', { ref: '@1', text: 'worker-a' })).resolves.toEqual({ ok: true })
    await expect(client.call('state')).resolves.toEqual({
      url: 'tauri-agent://static',
      title: 'Ducktape',
      values: {
        'Agent name': 'worker-a'
      }
    })
  })

  it('turns server-side failures into client errors with protocol messages', async () => {
    const session = new DebuggerSession(new StaticHtmlAppAdapter({ html: '<main></main>' }))
    const client = new DebuggerClient(new InProcessTransport(createDebuggerRpcHandler(session)))

    await client.call('tree')

    await expect(client.call('click', { ref: '@404' })).rejects.toThrow(
      'STALE_REF: stale ref @404; run tree again'
    )
  })

  it('retries transient socket resets only for read-only calls', async () => {
    const readTransport = new FlakyResetTransport({ href: 'http://127.0.0.1:1420/' })
    const readClient = new DebuggerClient(readTransport)

    await expect(readClient.call('location')).resolves.toEqual({ href: 'http://127.0.0.1:1420/' })
    expect(readTransport.messages.map((message) => message.method)).toEqual(['location', 'location'])

    const waitTransport = new FlakyResetTransport({ matched: true, text: 'Ready' })
    const waitClient = new DebuggerClient(waitTransport)

    await expect(waitClient.call('wait', { text: 'Ready' })).resolves.toEqual({ matched: true, text: 'Ready' })
    expect(waitTransport.messages.map((message) => message.method)).toEqual(['wait', 'wait'])

    const cookieTransport = new FlakyResetTransport({ entries: [{ name: 'agent.cookie', value: 'ready' }] })
    const cookieClient = new DebuggerClient(cookieTransport)

    await expect(cookieClient.call('cookies', { name: 'agent.cookie' })).resolves.toEqual({
      entries: [{ name: 'agent.cookie', value: 'ready' }]
    })
    expect(cookieTransport.messages.map((message) => message.method)).toEqual(['cookies', 'cookies'])

    const writeTransport = new FlakyResetTransport({ ok: true })
    const writeClient = new DebuggerClient(writeTransport)

    await expect(writeClient.call('click', { ref: '@1' })).rejects.toThrow('read ECONNRESET')
    expect(writeTransport.messages.map((message) => message.method)).toEqual(['click'])

    for (const method of ['logs', 'events'] as const) {
      const clearTransport = new FlakyResetTransport([])
      const clearClient = new DebuggerClient(clearTransport)

      await expect(clearClient.call(method, { clear: true })).rejects.toThrow('read ECONNRESET')
      expect(clearTransport.messages.map((message) => message.method)).toEqual([method])
    }

    const cookieWriteTransport = new FlakyResetTransport({ entries: [] })
    const cookieWriteClient = new DebuggerClient(cookieWriteTransport)

    await expect(cookieWriteClient.call('cookies', { action: 'set', name: 'agent.cookie', value: 'ready' })).rejects.toThrow('read ECONNRESET')
    expect(cookieWriteTransport.messages.map((message) => message.method)).toEqual(['cookies'])
  })
})

class FlakyResetTransport {
  messages: Array<{ id: number; method: string; params?: unknown }> = []

  constructor(private readonly result: unknown) {}

  async send(message: string): Promise<string> {
    const request = JSON.parse(message) as { id: number; method: string; params?: unknown }
    this.messages.push(request)
    if (this.messages.length === 1) {
      const error = new Error('read ECONNRESET') as NodeJS.ErrnoException
      error.code = 'ECONNRESET'
      throw error
    }
    return JSON.stringify(createSuccessResponse(request.id, this.result))
  }
}

function staticWindowInfo(title: string): Record<string, unknown> {
  return {
    label: 'main',
    title,
    focused: true,
    visible: true,
    minimized: false,
    maximized: false,
    scaleFactor: 1,
    innerBounds: { x: 0, y: 0, width: 1024, height: 768 },
    outerBounds: { x: 0, y: 0, width: 1024, height: 768 }
  }
}
