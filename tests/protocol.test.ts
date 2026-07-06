import { describe, expect, it } from 'vitest'

import {
  AGENT_METHODS,
  createErrorResponse,
  createRequest,
  createSuccessResponse,
  isAgentMethod,
  parseJsonRpcMessage
} from '../protocol/json-rpc'

describe('agent debug protocol', () => {
  it('declares the headless debugger method surface', () => {
    expect(AGENT_METHODS).toEqual([
      'attach',
      'windows',
      'tree',
      'click',
      'hover',
      'focus',
      'blur',
      'scroll',
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
    ])
    expect(isAgentMethod('tree')).toBe(true)
    expect(isAgentMethod('unknown')).toBe(false)
  })

  it('creates request, success, and error messages with stable JSON-RPC 2.0 shape', () => {
    const request = createRequest(7, 'inspect', { window: 'main', ref: '@1' })
    expect(request).toEqual({
      jsonrpc: '2.0',
      id: 7,
      method: 'inspect',
      params: { window: 'main', ref: '@1' }
    })

    expect(createSuccessResponse(7, { text: '@1 button "Forge"' })).toEqual({
      jsonrpc: '2.0',
      id: 7,
      result: { text: '@1 button "Forge"' }
    })

    expect(createErrorResponse(7, 'STALE_REF', 'stale ref @4; run tree again')).toEqual({
      jsonrpc: '2.0',
      id: 7,
      error: {
        code: 'STALE_REF',
        message: 'stale ref @4; run tree again'
      }
    })
  })

  it('parses valid messages and rejects invalid messages clearly', () => {
    expect(parseJsonRpcMessage('{"jsonrpc":"2.0","id":"abc","method":"windows"}')).toEqual({
      jsonrpc: '2.0',
      id: 'abc',
      method: 'windows'
    })

    expect(() => parseJsonRpcMessage('not json')).toThrow('invalid JSON-RPC message')
    expect(() => parseJsonRpcMessage('{"jsonrpc":"1.0","id":1,"method":"windows"}')).toThrow(
      'invalid JSON-RPC 2.0 message'
    )
    expect(() => parseJsonRpcMessage('{"jsonrpc":"2.0","id":1,"method":"unknown"}')).toThrow(
      'unknown agent method: unknown'
    )
  })
})
