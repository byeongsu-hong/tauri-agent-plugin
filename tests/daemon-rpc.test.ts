import { describe, expect, it } from 'vitest'

import { DebuggerClient } from '../daemon/client'
import { createDebuggerRpcHandler, InProcessTransport } from '../daemon/server'
import { DebuggerSession } from '../daemon/session'
import { StaticHtmlAppAdapter } from '../daemon/static-app'
import { createSuccessResponse } from '../protocol/json-rpc'

describe('debugger JSON-RPC transport', () => {
  it('round-trips client calls through the server handler', async () => {
    const session = new DebuggerSession(
      await StaticHtmlAppAdapter.create({
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

  it('injects the per-session auth token into every request when configured', async () => {
    const seen: unknown[] = []
    const transport = {
      async send(message: string): Promise<string> {
        const request = JSON.parse(message)
        seen.push(request.token)
        return JSON.stringify(createSuccessResponse(request.id, { ok: true }))
      }
    }
    const client = new DebuggerClient(transport, 'sekret')
    await client.call('tree')
    await client.call('windows')
    expect(seen).toEqual(['sekret', 'sekret'])

    // Without a token, requests carry none (e.g. local --port daemons).
    const anon: unknown[] = []
    const anonClient = new DebuggerClient({
      async send(message: string): Promise<string> {
        const request = JSON.parse(message)
        anon.push('token' in request)
        return JSON.stringify(createSuccessResponse(request.id, { ok: true }))
      }
    })
    await anonClient.call('tree')
    expect(anon).toEqual([false])
  })

  it('turns server-side failures into client errors with protocol messages', async () => {
    const session = new DebuggerSession(await StaticHtmlAppAdapter.create({ html: '<main></main>' }))
    const client = new DebuggerClient(new InProcessTransport(createDebuggerRpcHandler(session)))

    await client.call('tree')

    await expect(client.call('click', { ref: '@404' })).rejects.toMatchObject({
      code: 'STALE_REF',
      message: 'stale ref @404; run tree again'
    })
  })

  it('rejects malformed and mismatched JSON-RPC responses', async () => {
    for (const response of [
      'not json',
      JSON.stringify({ jsonrpc: '1.0', id: 1, result: null }),
      JSON.stringify({ jsonrpc: '2.0', id: 1 }),
      JSON.stringify({ jsonrpc: '2.0', id: 1, result: null, error: { code: 'NOPE', message: 'bad' } }),
      JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: 1, message: 'bad' } }),
      '{"jsonrpc":"2.0","id":1.5,"result":null}',
      '{"jsonrpc":"2.0","id":9007199254740992,"result":null}',
      JSON.stringify({ jsonrpc: '2.0', id: 2, result: null })
    ]) {
      const client = new DebuggerClient({ send: async () => response })
      await expect(client.call('windows')).rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
    }
  })

  it('rejects malformed params instead of silently applying defaults', async () => {
    const session = new DebuggerSession(await StaticHtmlAppAdapter.create({ html: '<main></main>' }))
    const handler = createDebuggerRpcHandler(session)
    const client = new DebuggerClient(new InProcessTransport(handler))

    expect(JSON.parse(await handler(JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'tree', params: []
    })))).toMatchObject({ error: { code: 'INVALID_PARAMS', message: 'params must be an object' } })
    await expect(client.call('find', { limit: '2' })).rejects.toMatchObject({ code: 'INVALID_PARAMS' })
    await expect(client.call('location', { action: 'sideways' })).rejects.toMatchObject({ code: 'INVALID_PARAMS' })
    await expect(client.call('location', { action: 'reload' })).resolves.toMatchObject({
      href: 'tauri-agent://static'
    })
  })

  it('preserves valid request ids when rejecting unknown methods', async () => {
    const session = new DebuggerSession(await StaticHtmlAppAdapter.create({ html: '<main></main>' }))
    const handler = createDebuggerRpcHandler(session)

    expect(JSON.parse(await handler(JSON.stringify({
      jsonrpc: '2.0', id: 9, method: 'missing'
    })))).toEqual({
      jsonrpc: '2.0',
      id: 9,
      error: { code: 'INVALID_REQUEST', message: 'unknown agent method: missing' }
    })
    expect(JSON.parse(await handler(JSON.stringify({
      jsonrpc: '2.0', id: null, method: 'missing'
    })))).toMatchObject({ id: 0, error: { code: 'INVALID_REQUEST' } })
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
