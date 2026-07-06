import { describe, expect, it } from 'vitest'

import { evalResult } from '../guest-js/evaluate'

describe('evalResult', () => {
  it('normalizes evaluated JavaScript values for JSON-RPC and MCP responses', () => {
    expect(evalResult('worker-a')).toEqual({
      type: 'string',
      value: 'worker-a',
      text: 'worker-a'
    })
    expect(evalResult({ worker: 'a', count: 1 })).toEqual({
      type: 'object',
      value: { worker: 'a', count: 1 },
      text: '{"worker":"a","count":1}'
    })
    expect(evalResult(undefined)).toEqual({
      type: 'undefined',
      text: 'undefined'
    })
    const functionResult = evalResult(() => 'hidden')
    expect(functionResult.type).toBe('function')
    expect(functionResult.text).toContain('hidden')
  })
})
