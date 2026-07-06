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
      { label: 'main', title: 'Ducktape', focused: true, visible: true }
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

    const writeTransport = new FlakyResetTransport({ ok: true })
    const writeClient = new DebuggerClient(writeTransport)

    await expect(writeClient.call('click', { ref: '@1' })).rejects.toThrow('read ECONNRESET')
    expect(writeTransport.messages.map((message) => message.method)).toEqual(['click'])
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
