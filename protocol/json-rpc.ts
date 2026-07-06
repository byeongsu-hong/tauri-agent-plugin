import type { AgentMethod, JsonRpcError, JsonRpcId, JsonRpcRequest, JsonRpcSuccess } from './types'

export const AGENT_METHODS = [
  'attach',
  'windows',
  'tree',
  'click',
  'hover',
  'focus',
  'blur',
  'fill',
  'select',
  'check',
  'inspect',
  'eval',
  'press',
  'shot',
  'logs',
  'events',
  'wait',
  'state',
  'record'
] as const satisfies readonly AgentMethod[]

const AGENT_METHOD_SET = new Set<string>(AGENT_METHODS)

export function isAgentMethod(method: string): method is AgentMethod {
  return AGENT_METHOD_SET.has(method)
}

export function createRequest<TParams>(
  id: JsonRpcId,
  method: AgentMethod,
  params?: TParams
): JsonRpcRequest<TParams> {
  return params === undefined ? { jsonrpc: '2.0', id, method } : { jsonrpc: '2.0', id, method, params }
}

export function createSuccessResponse<TResult>(
  id: JsonRpcId,
  result: TResult
): JsonRpcSuccess<TResult> {
  return { jsonrpc: '2.0', id, result }
}

export function createErrorResponse(
  id: JsonRpcId,
  code: string,
  message: string,
  data?: unknown
): JsonRpcError {
  return data === undefined
    ? { jsonrpc: '2.0', id, error: { code, message } }
    : { jsonrpc: '2.0', id, error: { code, message, data } }
}

export function parseJsonRpcMessage(message: string): JsonRpcRequest {
  let parsed: unknown
  try {
    parsed = JSON.parse(message)
  } catch {
    throw new Error('invalid JSON-RPC message')
  }

  if (!isObject(parsed) || parsed.jsonrpc !== '2.0' || !('id' in parsed) || typeof parsed.method !== 'string') {
    throw new Error('invalid JSON-RPC 2.0 message')
  }

  if (!isAgentMethod(parsed.method)) {
    throw new Error(`unknown agent method: ${parsed.method}`)
  }

  const id = parsed.id
  if (typeof id !== 'string' && typeof id !== 'number') {
    throw new Error('invalid JSON-RPC 2.0 message')
  }

  const request: JsonRpcRequest = {
    jsonrpc: '2.0',
    id,
    method: parsed.method
  }
  if ('params' in parsed) {
    request.params = parsed.params
  }
  return request
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
