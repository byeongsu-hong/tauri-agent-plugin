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

  it('processes pipelined requests in connection order', async () => {
    server = createLineJsonRpcServer(
      new DebuggerSession(await StaticHtmlAppAdapter.create({ html: '<main>ready</main>' }))
    )
    const port = await listen(server)
    const responses = await rawResponses(port, [
      request(1, 'wait', { text: 'missing', timeoutMs: 30 }),
      request(2, 'tree')
    ])

    expect(responses.map(({ id }) => id)).toEqual([1, 2])
    expect(responses[0]?.error?.code).toBe('WAIT_TIMEOUT')
  })

  it('does not treat request processing time as connection idleness', async () => {
    server = createLineJsonRpcServer(
      new DebuggerSession(await StaticHtmlAppAdapter.create({ html: '<main>ready</main>' })),
      1024,
      20
    )
    const port = await listen(server)

    const responses = await rawResponses(port, [request(1, 'wait', { text: 'missing', timeoutMs: 40 })])

    expect(responses[0]?.error?.code).toBe('WAIT_TIMEOUT')
  })

  it('responds to valid requests queued before an oversized line', async () => {
    server = createLineJsonRpcServer(
      new DebuggerSession(await StaticHtmlAppAdapter.create({ html: '<main>ready</main>' })),
      100
    )
    const port = await listen(server)

    const responses = await rawResponses(port, [request(1, 'tree'), 'x'.repeat(101)])

    expect(responses.map(({ id }) => id)).toEqual([1, 0])
    expect(responses[1]?.error?.code).toBe('INVALID_REQUEST')
  })

  it('waits for response writes to flush before running the next request', async () => {
    const session = new DebuggerSession(
      await StaticHtmlAppAdapter.create({ html: '<main>ready</main>' })
    )
    const executed: string[] = []
    const execute = session.execute.bind(session)
    session.execute = async (method, params) => {
      executed.push(method)
      return execute(method, params)
    }
    server = createLineJsonRpcServer(session)
    let releaseWrite: (() => void) | undefined
    let markWriteHeld: () => void = () => {}
    const writeHeld = new Promise<void>((resolve) => {
      markWriteHeld = resolve
    })
    server.on('connection', (socket) => {
      const write = socket.write.bind(socket)
      socket.write = ((chunk: string | Uint8Array, ...args: unknown[]) => {
        const text = chunk.toString()
        if (text.includes('"id":1') && text.includes('"result"')) {
          releaseWrite = args.find((arg): arg is () => void => typeof arg === 'function')
          markWriteHeld()
          return Reflect.apply(write, socket, [chunk]) as boolean
        }
        return Reflect.apply(write, socket, [chunk, ...args]) as boolean
      }) as typeof socket.write
    })
    const port = await listen(server)

    const responsesPromise = rawResponses(port, [
      request(1, 'wait', { networkIdle: true }),
      request(2, 'tree')
    ])
    await writeHeld

    expect(releaseWrite).toBeTypeOf('function')
    expect(executed).toEqual(['wait'])
    releaseWrite?.()
    expect((await responsesPromise).map(({ id }) => id)).toEqual([1, 2])
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

interface RawResponse {
  id: number
  error?: { code: string }
}

function request(id: number, method: string, params?: Record<string, unknown>): string {
  return JSON.stringify({ jsonrpc: '2.0', id, method, params })
}

async function rawResponses(port: number, requests: string[]): Promise<RawResponse[]> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ port, host: '127.0.0.1' })
    const responses: RawResponse[] = []
    let buffer = ''
    const timer = setTimeout(() => finish(new Error('timed out waiting for raw responses')), 1_000)
    const finish = (error?: Error): void => {
      clearTimeout(timer)
      socket.destroy()
      if (error) reject(error)
      else resolve(responses)
    }
    socket.setEncoding('utf8')
    socket.on('connect', () => socket.write(`${requests.join('\n')}\n`))
    socket.on('data', (chunk) => {
      buffer += chunk
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      responses.push(...lines.filter(Boolean).map((line) => JSON.parse(line) as RawResponse))
      if (responses.length === requests.length) finish()
    })
    socket.on('close', () => {
      if (responses.length < requests.length) finish(new Error('socket closed before all responses arrived'))
    })
    socket.on('error', finish)
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
