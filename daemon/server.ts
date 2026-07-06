import { createServer, type Server, type Socket } from 'node:net'

import type { DebuggerSession } from './session'
import {
  createErrorResponse,
  createSuccessResponse,
  parseJsonRpcMessage
} from '../protocol/json-rpc'
import type { JsonRpcRequest, JsonRpcResponse } from '../protocol/types'

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

export function createLineJsonRpcServer(session: DebuggerSession): Server {
  const handler = createDebuggerRpcHandler(session)
  return createServer((socket) => handleLineSocket(socket, handler))
}

async function handleLineSocket(socket: Socket, handler: RpcHandler): Promise<void> {
  let buffer = ''
  socket.on('data', (chunk) => {
    buffer += chunk.toString('utf8')
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''
    for (const line of lines) {
      if (!line.trim()) {
        continue
      }
      void handler(line).then((response) => socket.write(`${response}\n`))
    }
  })
}

export function parseResponse(message: string): JsonRpcResponse {
  const parsed = JSON.parse(message) as JsonRpcResponse
  return parsed
}

function paramRecord(params: unknown): Record<string, unknown> {
  return typeof params === 'object' && params !== null && !Array.isArray(params)
    ? (params as Record<string, unknown>)
    : {}
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function errorCode(error: unknown): string {
  const message = errorMessage(error)
  if (message.startsWith('stale ref ')) {
    return 'STALE_REF'
  }
  if (message.startsWith('wait timed out')) {
    return 'WAIT_TIMEOUT'
  }
  return 'AGENT_ERROR'
}
