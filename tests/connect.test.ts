import { describe, expect, it } from 'vitest'

import { validateDebuggerTarget, type DebuggerTarget } from '../daemon/connect'

describe('debugger target validation', () => {
  it.each([
    { port: 45127 },
    { port: 45127, host: '127.0.0.1' },
    { app: 'dev.example.app' },
    { resolveHtml: async () => '<main></main>' }
  ])('accepts one complete connection source %#', (target) => {
    expect(() => validateDebuggerTarget(target)).not.toThrow()
  })

  it.each<[DebuggerTarget, string]>([
    [{}, 'requires exactly one connection source'],
    [{ port: 0 }, 'port must be an integer between 1 and 65535'],
    [{ port: 65_536 }, 'port must be an integer between 1 and 65535'],
    [{ app: ' ' }, 'app id must be non-empty'],
    [{ port: 45127, host: ' ' }, 'host must be non-empty'],
    [{ app: 'dev.example.app', host: 'localhost' }, 'host requires a port connection source'],
    [{ port: 45127, app: 'dev.example.app' }, 'requires exactly one connection source'],
    [{ app: 'dev.example.app', resolveHtml: async () => '<main></main>' }, 'requires exactly one connection source']
  ])('rejects malformed or ambiguous targets %#', (target, message) => {
    expect(() => validateDebuggerTarget(target)).toThrow(message)
  })
})
