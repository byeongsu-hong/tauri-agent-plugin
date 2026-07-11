import { afterEach, describe, expect, it } from 'vitest'
import { createConnection, createServer as createNetServer, type Server } from 'node:net'

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
        await StaticHtmlAppAdapter.create({
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

  it('preserves UTF-8 request text split across TCP chunks', async () => {
    server = createLineJsonRpcServer(
      new DebuggerSession(
        await StaticHtmlAppAdapter.create({
          html: '<main><button>서울 작업자</button></main>'
        })
      )
    )
    const port = await listen(server)
    const request = Buffer.from(JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'find', params: { role: 'button', name: '서울' }
    }) + '\n')
    const splitAt = request.indexOf(Buffer.from('서울')) + 1

    const response = await rawCall(port, request.subarray(0, splitAt), request.subarray(splitAt))

    expect(JSON.parse(response)).toMatchObject({
      result: { matches: [expect.objectContaining({ name: '서울 작업자' })] }
    })
  })

  it('preserves UTF-8 response text split across TCP chunks', async () => {
    server = createNetServer((socket) => {
      socket.once('data', () => {
        const response = Buffer.from(JSON.stringify({
          jsonrpc: '2.0', id: 1, result: { text: '서울 작업자' }
        }) + '\n')
        const splitAt = response.indexOf(Buffer.from('서울')) + 1
        socket.write(response.subarray(0, splitAt))
        setTimeout(() => socket.end(response.subarray(splitAt)), 5)
      })
    })
    const port = await listen(server)
    const client = new DebuggerClient(new SocketTransport({ port, host: '127.0.0.1' }))

    await expect(client.call('tree')).resolves.toEqual({ text: '서울 작업자' })
  })

  it('rejects responses that exceed the configured byte limit before a newline', async () => {
    server = createNetServer((socket) => {
      socket.once('data', () => socket.write('x'.repeat(33)))
    })
    const port = await listen(server)
    const client = new DebuggerClient(new SocketTransport({ port, host: '127.0.0.1' }, 1_000, 32))

    await expect(client.call('tree')).rejects.toThrow('debugger response exceeded 32 bytes')
  })

  it('returns INVALID_REQUEST before closing an oversized request', async () => {
    server = createLineJsonRpcServer(
      new DebuggerSession(await StaticHtmlAppAdapter.create({ html: '<main></main>' })),
      32
    )
    const port = await listen(server)

    const response = JSON.parse(await rawCall(port, Buffer.from('x'.repeat(33)), Buffer.alloc(0)))

    expect(response).toEqual({
      jsonrpc: '2.0',
      id: 0,
      error: { code: 'INVALID_REQUEST', message: 'request line exceeds the maximum length' }
    })
  })

  it('caps concurrent connections and closes idle sockets', async () => {
    server = createLineJsonRpcServer(
      new DebuggerSession(await StaticHtmlAppAdapter.create({ html: '<main></main>' })),
      1024,
      20
    )
    expect(server.maxConnections).toBe(64)
    const port = await listen(server)

    await expect(waitForSocketClose(port)).resolves.toBeUndefined()
  })
})

async function listen(target: Server): Promise<number> {
  await new Promise<void>((resolve) => target.listen(0, '127.0.0.1', resolve))
  const address = target.address()
  if (!address || typeof address === 'string') throw new Error('expected TCP address')
  return address.port
}

async function rawCall(port: number, first: Buffer, second: Buffer): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ port, host: '127.0.0.1' })
    let response = ''
    socket.setEncoding('utf8')
    socket.on('connect', () => {
      socket.write(first)
      setTimeout(() => socket.write(second), 5)
    })
    socket.on('data', (chunk) => {
      response += chunk
      const newline = response.indexOf('\n')
      if (newline !== -1) {
        socket.destroy()
        resolve(response.slice(0, newline))
      }
    })
    socket.on('error', reject)
  })
}

async function waitForSocketClose(port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ port, host: '127.0.0.1' })
    const timer = setTimeout(() => {
      socket.destroy()
      reject(new Error('socket did not close after idle timeout'))
    }, 1_000)
    socket.on('close', () => {
      clearTimeout(timer)
      resolve()
    })
    socket.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
  })
}
