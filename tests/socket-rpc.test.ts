import { afterEach, describe, expect, it } from 'vitest'
import type { Server } from 'node:net'

import { SocketTransport } from '../daemon/client'
import { createLineJsonRpcServer } from '../daemon/server'
import { DebuggerSession } from '../daemon/session'
import { StaticHtmlAppAdapter } from '../daemon/static-app'
import { DebuggerClient } from '../daemon/client'

let server: Server | undefined

afterEach(async () => {
  if (!server) return
  await new Promise<void>((resolve, reject) => {
    server?.close((error) => (error ? reject(error) : resolve()))
  })
  server = undefined
})

describe('socket JSON-RPC transport', () => {
  it('serves headless debugger calls over localhost TCP', async () => {
    server = createLineJsonRpcServer(
      new DebuggerSession(
        new StaticHtmlAppAdapter({
          title: 'Ducktape',
          html: '<main aria-label="Ducktape"><button>Forge</button></main>'
        })
      )
    )
    await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('expected TCP address')

    const client = new DebuggerClient(new SocketTransport({ port: address.port, host: '127.0.0.1' }))

    await expect(client.call('tree')).resolves.toEqual({
      text: 'main "Ducktape"\n@1 button "Forge"'
    })
    await expect(client.call('click', { ref: '@1' })).resolves.toEqual({ ok: true })
  })
})
