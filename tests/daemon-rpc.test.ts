import { describe, expect, it } from 'vitest'

import { DebuggerClient } from '../daemon/client'
import { createDebuggerRpcHandler, InProcessTransport } from '../daemon/server'
import { DebuggerSession } from '../daemon/session'
import { StaticHtmlAppAdapter } from '../daemon/static-app'

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
})
