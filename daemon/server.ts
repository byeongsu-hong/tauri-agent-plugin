import { createServer, type Server, type Socket } from 'node:net'

import type { DebuggerSession } from './session'
import {
  createErrorResponse,
  createSuccessResponse,
  parseJsonRpcMessage
} from '../protocol/json-rpc'
import type { JsonRpcRequest, JsonRpcResponse } from '../protocol/types'
import { AgentProtocolError } from '../protocol/error'

export type RpcHandler = (message: string) => Promise<string>

export function createDebuggerRpcHandler(session: DebuggerSession): RpcHandler {
  return async (message: string) => {
    let request: JsonRpcRequest
    try {
      request = parseJsonRpcMessage(message)
    } catch (error) {
      return JSON.stringify(createErrorResponse(0, 'INVALID_REQUEST', errorMessage(error)))
    }

    try {
      const result = await session.execute(request.method, paramRecord(request.params))
      return JSON.stringify(createSuccessResponse(request.id, result))
    } catch (error) {
      return JSON.stringify(createErrorResponse(request.id, errorCode(error), errorMessage(error)))
    }
  }
}

export class InProcessTransport {
  constructor(private readonly handler: RpcHandler) {}

  async send(message: string): Promise<string> {
    return this.handler(message)
  }
}

export interface LineTransport {
  send(message: string): Promise<string>
}

const MAX_REQUEST_LINE_BYTES = 4 * 1024 * 1024

export function createLineJsonRpcServer(session: DebuggerSession): Server {
  const handler = createDebuggerRpcHandler(session)
  return createServer((socket) => handleLineSocket(socket, handler))
}

async function handleLineSocket(socket: Socket, handler: RpcHandler): Promise<void> {
  let buffer = ''
  let closed = false
  const stop = (): void => {
    closed = true
  }
  // Without an error handler a client reset (ECONNRESET) raises an unhandled
  // 'error' event and crashes the daemon process.
  socket.setEncoding('utf8')
  socket.on('error', stop)
  socket.on('close', stop)
  socket.on('data', (chunk) => {
    if (closed) {
      return
    }
    buffer += chunk.toString()
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''
    for (const line of lines) {
      if (Buffer.byteLength(line, 'utf8') + 1 > MAX_REQUEST_LINE_BYTES) {
        socket.destroy()
        closed = true
        return
      }
      if (!line.trim()) {
        continue
      }
      void handler(line)
        .then((response) => {
          if (!closed && socket.writable) {
            socket.write(`${response}\n`)
          }
        })
        .catch(() => {})
    }
    if (Buffer.byteLength(buffer, 'utf8') > MAX_REQUEST_LINE_BYTES) {
      // A client that never sends a newline would otherwise grow the buffer
      // without bound.
      socket.destroy()
      closed = true
    }
  })
}

export function parseResponse(message: string): JsonRpcResponse {
  let parsed: unknown
  try {
    parsed = JSON.parse(message)
  } catch {
    return invalidResponse('invalid JSON-RPC response')
  }
  if (!isObject(parsed) || parsed.jsonrpc !== '2.0' || !validId(parsed.id)) {
    return invalidResponse('invalid JSON-RPC response')
  }
  const hasResult = Object.hasOwn(parsed, 'result')
  const hasError = Object.hasOwn(parsed, 'error')
  if (hasResult === hasError) {
    return invalidResponse('JSON-RPC response must contain exactly one of result or error')
  }
  if (hasError) {
    const error = parsed.error
    if (!isObject(error) || typeof error.code !== 'string' || typeof error.message !== 'string') {
      return invalidResponse('invalid JSON-RPC error response')
    }
  }
  return parsed as unknown as JsonRpcResponse
}

function validId(value: unknown): value is string | number {
  return typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value))
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function invalidResponse(message: string): never {
  throw new AgentProtocolError('INVALID_RESPONSE', message)
}

function paramRecord(params: unknown): Record<string, unknown> {
  if (params === undefined) return {}
  if (typeof params !== 'object' || params === null || Array.isArray(params)) {
    throw new AgentProtocolError('INVALID_PARAMS', 'params must be an object')
  }
  return params as Record<string, unknown>
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function errorCode(error: unknown): string {
  if (error instanceof AgentProtocolError) return error.code
  const message = errorMessage(error)
  if (message.startsWith('stale ref ')) {
    return 'STALE_REF'
  }
  if (message.startsWith('wait timed out')) {
    return 'WAIT_TIMEOUT'
  }
  return 'AGENT_ERROR'
}
