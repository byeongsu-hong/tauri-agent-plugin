import { createConnection } from 'node:net'

import { parseResponse, type LineTransport } from './server'
import { createRequest } from '../protocol/json-rpc'
import type { AgentMethod } from '../protocol/types'
import { AgentProtocolError } from '../protocol/error'

export class DebuggerClient {
  private nextId = 1

  constructor(
    private readonly transport: LineTransport,
    private readonly token?: string
  ) {}

  async call<TResult = unknown>(method: AgentMethod, params?: Record<string, unknown>): Promise<TResult> {
    const request = createRequest(this.nextId++, method, params)
    // The inline server authenticates each request with the per-session token
    // published in the (0600) endpoint registry.
    const message = this.token ? { ...request, token: this.token } : request
    const response = parseResponse(await this.sendWithRetry(JSON.stringify(message), method, params))

    if (response.id !== request.id) {
      throw new AgentProtocolError(
        'INVALID_RESPONSE',
        `mismatched JSON-RPC response id: expected ${request.id}, got ${String(response.id)}`
      )
    }

    if ('error' in response) {
      throw new AgentProtocolError(response.error.code, response.error.message)
    }

    return response.result as TResult
  }

  private async sendWithRetry(
    message: string,
    method: AgentMethod,
    params?: Record<string, unknown>
  ): Promise<string> {
    const maxAttempts = isReadOnlyCall(method, params) ? 2 : 1
    let lastError: unknown
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        return await this.transport.send(message)
      } catch (error) {
        lastError = error
        if (attempt >= maxAttempts || !isTransientSocketReset(error)) {
          throw error
        }
      }
    }
    throw lastError
  }
}

function isReadOnlyCall(method: AgentMethod, params: Record<string, unknown> = {}): boolean {
  switch (method) {
    case 'windows':
      return true
    case 'window':
      return params.action === undefined || params.action === 'get'
    case 'tree':
    case 'find':
    case 'inspect':
    case 'state':
    case 'wait':
      return true
    case 'logs':
    case 'events':
    case 'network':
    case 'ipc':
      return params.clear !== true
    case 'storage':
      return params.action === undefined || params.action === 'get'
    case 'cookies':
      return params.action === undefined || params.action === 'get'
    case 'location':
      return params.action === undefined || params.action === 'get'
    case 'record':
      return params.action === undefined || params.action === 'get'
    default:
      return false
  }
}

function isTransientSocketReset(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ECONNRESET'
}

export type SocketTransportOptions =
  | {
      port: number
      host?: string
    }
  | {
      path: string
    }

// Generous upper bound: guards against a server that accepts but never replies,
// while still comfortably covering long-poll methods (the Rust bridge caps its
// own response at 60s).
const DEFAULT_RESPONSE_TIMEOUT_MS = 120_000

export class SocketTransport implements LineTransport {
  constructor(
    private readonly options: SocketTransportOptions,
    private readonly timeoutMs: number = DEFAULT_RESPONSE_TIMEOUT_MS
  ) {}

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
      let settled = false

      const finish = (action: () => void): void => {
        if (settled) {
          return
        }
        settled = true
        clearTimeout(timer)
        socket.destroy()
        action()
      }

      const timer = setTimeout(
        () => finish(() => reject(new Error('debugger request timed out'))),
        this.timeoutMs
      )

      socket.on('connect', () => socket.write(`${message}\n`))
      socket.on('data', (chunk) => {
        buffer += chunk.toString('utf8')
        const newlineIndex = buffer.indexOf('\n')
        if (newlineIndex === -1) {
          return
        }
        const response = buffer.slice(0, newlineIndex)
        finish(() => resolve(response))
      })
      socket.on('error', (error) => finish(() => reject(error)))
      // A close before any newline means the server hung up mid-response;
      // surface it instead of hanging forever.
      socket.on('close', () =>
        finish(() => reject(new Error('debugger connection closed before a response')))
      )
    })
  }
}
