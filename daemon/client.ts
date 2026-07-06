import { createConnection } from 'node:net'

import type { LineTransport } from './server'
import { createRequest } from '../protocol/json-rpc'
import type { AgentMethod } from '../protocol/types'

export class DebuggerClient {
  private nextId = 1

  constructor(private readonly transport: LineTransport) {}

  async call<TResult = unknown>(method: AgentMethod, params?: Record<string, unknown>): Promise<TResult> {
    const request = createRequest(this.nextId++, method, params)
    const response = JSON.parse(await this.transport.send(JSON.stringify(request)))

    if ('error' in response) {
      throw new Error(`${response.error.code}: ${response.error.message}`)
    }

    return response.result as TResult
  }
}

export type SocketTransportOptions =
  | {
      port: number
      host?: string
    }
  | {
      path: string
    }

export class SocketTransport implements LineTransport {
  constructor(private readonly options: SocketTransportOptions) {}

  async send(message: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const socket =
        'path' in this.options
          ? createConnection(this.options.path)
          : createConnection({
              port: this.options.port,
              host: this.options.host ?? '127.0.0.1'
            })
      let buffer = ''

      socket.on('connect', () => socket.write(`${message}\n`))
      socket.on('data', (chunk) => {
        buffer += chunk.toString('utf8')
        const newlineIndex = buffer.indexOf('\n')
        if (newlineIndex === -1) {
          return
        }
        const response = buffer.slice(0, newlineIndex)
        socket.end()
        resolve(response)
      })
      socket.on('error', reject)
    })
  }
}
