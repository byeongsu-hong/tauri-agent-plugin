import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { PassThrough, Writable } from 'node:stream'

import { afterEach, describe, expect, it } from 'vitest'

import { serveMcpStdio } from '../mcp/stdio'

let server: ChildProcessWithoutNullStreams | undefined

afterEach(() => {
  server?.kill()
  server = undefined
})

describe('tauri-agent MCP stdio binary', () => {
  it('serves newline-delimited MCP JSON-RPC over stdio', async () => {
    server = spawn('bun', ['bin/tauri-agent-mcp.ts'], { cwd: process.cwd() })
    const responses: string[] = []
    server.stdout.on('data', (chunk) => {
      responses.push(
        ...chunk
          .toString('utf8')
          .split('\n')
          .filter((line: string) => line.length > 0)
      )
    })

    server.stdin.write(
      `${JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'test', version: '0' } }
      })}\n`
    )
    server.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`)
    server.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' })}\n`)

    const initialize = await waitForResponse(responses, 1)
    const tools = await waitForResponse(responses, 2)

    expect(initialize.result.serverInfo.name).toBe('tauri-agent')
    expect(tools.result.tools.map((tool: { name: string }) => tool.name)).toContain('tauri_tree')
    expect(responses).toHaveLength(2)
  })

  it('parses scoped core profile options', async () => {
    server = spawn('bun', ['bin/tauri-agent-mcp.ts', '--from-html', 'README.md', '--profile', 'core'], { cwd: process.cwd() })
    const responses: string[] = []
    server.stdout.on('data', (chunk) => responses.push(...chunk.toString('utf8').split('\n').filter(Boolean)))
    server.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/list' })}\n`)

    const tools = await waitForResponse(responses, 3)
    expect(tools.result.tools).toHaveLength(9)
    expect(tools.result.tools.every((tool: { inputSchema: { properties: Record<string, unknown> } }) =>
      !('app' in tool.inputSchema.properties)
    )).toBe(true)
  })

  it('bounds oversized lines and resumes at the next request', async () => {
    const input = new PassThrough()
    const responses: string[] = []
    let buffered = ''
    const output = new Writable({
      write(chunk, _encoding, callback) {
        buffered += chunk.toString()
        const lines = buffered.split('\n')
        buffered = lines.pop() ?? ''
        responses.push(...lines.filter(Boolean))
        callback()
      }
    })
    serveMcpStdio(undefined, input, output, 256)

    input.write('x'.repeat(257))
    input.write(`\n${JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/list' })}\n`)

    const oversized = await waitForResponse(responses, null)
    const tools = await waitForResponse(responses, 7)
    expect(oversized.error).toEqual({
      code: -32700,
      message: 'MCP request line exceeds the maximum length'
    })
    expect(tools.result.tools).toEqual(expect.any(Array))
  })
})

async function waitForResponse(responses: string[], id: number | null): Promise<any> {
  const startedAt = Date.now()
  while (Date.now() - startedAt < 3000) {
    for (const response of responses) {
      const parsed = JSON.parse(response)
      if (parsed.id === id) {
        return parsed
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error(`timed out waiting for MCP response ${id}`)
}
