import type { AgentMethod, JsonRpcError, JsonRpcId, JsonRpcRequest, JsonRpcSuccess } from './types'

export const AGENT_METHODS = [
  'attach',
  'windows',
  'window',
  'tree',
  'find',
  'act',
  'click',
  'hover',
  'focus',
  'blur',
  'scroll',
  'drag',
  'fill',
  'select',
  'check',
  'upload',
  'inspect',
  'eval',
  'press',
  'type',
  'shot',
  'logs',
  'events',
  'network',
  'ipc',
  'storage',
  'cookies',
  'location',
  'wait',
  'expect',
  'state',
  'record',
  'stream',
  'dialog'
] as const satisfies readonly AgentMethod[]

const AGENT_METHOD_SET = new Set<string>(AGENT_METHODS)

export function isAgentMethod(method: string): method is AgentMethod {
  return AGENT_METHOD_SET.has(method)
}

/**
 * Mutating/interaction methods captured into a recording so a session can be
 * replayed. Single-sourced here so the guest instrumentation and the daemon
 * session record exactly the same set — they had drifted (the daemon omitted
 * `type`/`select`/`check`). Recorded params use the canonical wire names
 * (`text` for fill/type, `key` for press, `value` for select) so a recording
 * captured on one surface replays on any other.
 */
export const RECORDABLE_METHODS = [
  'act',
  'click',
  'hover',
  'focus',
  'blur',
  'scroll',
  'drag',
  'fill',
  'type',
  'press',
  'select',
  'check',
  'upload'
] as const satisfies readonly AgentMethod[]

const RECORDABLE_METHOD_SET = new Set<string>(RECORDABLE_METHODS)

export function isRecordableMethod(method: string): method is (typeof RECORDABLE_METHODS)[number] {
  return RECORDABLE_METHOD_SET.has(method)
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
