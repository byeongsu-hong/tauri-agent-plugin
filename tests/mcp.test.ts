import { describe, expect, it } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Server } from 'node:net'

import { createEndpointDescriptor, writeEndpointRegistry } from '../daemon/endpoint'
import { createLineJsonRpcServer } from '../daemon/server'
import { DebuggerSession } from '../daemon/session'
import { StaticHtmlAppAdapter } from '../daemon/static-app'
import { createMcpRequestHandler } from '../mcp/server'

describe('tauri-agent MCP server', () => {
  it('negotiates MCP initialization and lists debugger tools', async () => {
    const handler = createMcpRequestHandler()

    expect(
      JSON.parse(
        await requiredResponse(
          handler(
            JSON.stringify({
              jsonrpc: '2.0',
              id: 1,
              method: 'initialize',
              params: {
                protocolVersion: '2025-11-25',
                capabilities: {},
                clientInfo: { name: 'test-client', version: '0.0.0' }
              }
            })
          )
        )
      )
    ).toEqual({
      jsonrpc: '2.0',
      id: 1,
      result: {
        protocolVersion: '2025-11-25',
        capabilities: { tools: { listChanged: false } },
        serverInfo: {
          name: 'tauri-agent',
          title: 'Tauri Agent',
          version: '0.1.0'
        }
      }
    })

    await expect(
      handler(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }))
    ).resolves.toBeUndefined()

    const list = JSON.parse(
      await requiredResponse(
        handler(
          JSON.stringify({
            jsonrpc: '2.0',
            id: 2,
            method: 'tools/list'
          })
        )
      )
    )

    expect(list.result.tools.map((tool: { name: string }) => tool.name)).toEqual([
      'tauri_attach',
      'tauri_windows',
      'tauri_tree',
      'tauri_click',
      'tauri_hover',
      'tauri_fill',
      'tauri_select',
      'tauri_check',
      'tauri_inspect',
      'tauri_eval',
      'tauri_press',
      'tauri_shot',
      'tauri_logs',
      'tauri_events',
      'tauri_wait',
      'tauri_state',
      'tauri_record'
    ])
    expect(list.result.tools[0].inputSchema).toEqual(
      expect.objectContaining({ type: 'object', properties: expect.any(Object) })
    )
  })

  it('falls back to the supported MCP protocol version when the client asks for another version', async () => {
    const response = JSON.parse(
      await requiredResponse(
        createMcpRequestHandler()(
          JSON.stringify({
            jsonrpc: '2.0',
            id: 5,
            method: 'initialize',
            params: {
              protocolVersion: '1900-01-01',
              capabilities: {},
              clientInfo: { name: 'test-client', version: '0.0.0' }
            }
          })
        )
      )
    )

    expect(response.result.protocolVersion).toBe('2025-11-25')
  })

  it('reports unknown tools as MCP request errors without requiring a debugger connection', async () => {
    const response = JSON.parse(
      await requiredResponse(
        createMcpRequestHandler()(
          JSON.stringify({
            jsonrpc: '2.0',
            id: 6,
            method: 'tools/call',
            params: {
              name: 'tauri_missing',
              arguments: {}
            }
          })
        )
      )
    )

    expect(response).toEqual({
      jsonrpc: '2.0',
      id: 6,
      error: {
        code: -32602,
        message: 'unknown MCP tool: tauri_missing'
      }
    })
  })

  it('returns JSON-RPC parse errors for malformed MCP input', async () => {
    const response = JSON.parse(await requiredResponse(createMcpRequestHandler()('{not-json')))

    expect(response).toEqual({
      jsonrpc: '2.0',
      id: null,
      error: {
        code: -32700,
        message: 'invalid MCP JSON-RPC message'
      }
    })
  })

  it('calls debugger tools through the existing protocol path', async () => {
    const handler = createMcpRequestHandler()
    const html = '<main aria-label="Ducktape"><label>Agent name<input aria-label="Agent name"></label></main>'
    const tree = JSON.parse(
      await requiredResponse(
        handler(
          JSON.stringify({
            jsonrpc: '2.0',
            id: 3,
            method: 'tools/call',
            params: {
              name: 'tauri_tree',
              arguments: { html }
            }
          })
        )
      )
    )

    expect(tree).toEqual({
      jsonrpc: '2.0',
      id: 3,
      result: {
        content: [
          {
            type: 'text',
            text: 'main "Ducktape"\n@1 textbox "Agent name" empty'
          }
        ],
        structuredContent: {
          text: 'main "Ducktape"\n@1 textbox "Agent name" empty'
        },
        isError: false
      }
    })

    const inspected = JSON.parse(
      await requiredResponse(
        handler(
          JSON.stringify({
            jsonrpc: '2.0',
            id: 7,
            method: 'tools/call',
            params: {
              name: 'tauri_inspect',
              arguments: { html, ref: '@1' }
            }
          })
        )
      )
    )

    expect(inspected.result.structuredContent).toEqual({
      ref: '@1',
      role: 'textbox',
      name: 'Agent name',
      tagName: 'input',
      text: '',
      value: '',
      attributes: {
        'aria-label': 'Agent name'
      },
      states: ['empty']
    })

    const evaluated = JSON.parse(
      await requiredResponse(
        handler(
          JSON.stringify({
            jsonrpc: '2.0',
            id: 8,
            method: 'tools/call',
            params: {
              name: 'tauri_eval',
              arguments: { html, code: 'document.querySelector("input")?.getAttribute("aria-label")' }
            }
          })
        )
      )
    )

    expect(evaluated.result.structuredContent).toEqual({
      type: 'string',
      value: 'Agent name',
      text: 'Agent name'
    })

    const selected = JSON.parse(
      await requiredResponse(
        handler(
          JSON.stringify({
            jsonrpc: '2.0',
            id: 9,
            method: 'tools/call',
            params: {
              name: 'tauri_select',
              arguments: {
                html: '<main><select aria-label="Worker"><option value="local">Local worker</option><option value="remote">Remote worker</option></select></main>',
                ref: '@1',
                value: 'remote'
              }
            }
          })
        )
      )
    )

    expect(selected.result.structuredContent).toEqual({ ok: true })

    const checked = JSON.parse(
      await requiredResponse(
        handler(
          JSON.stringify({
            jsonrpc: '2.0',
            id: 10,
            method: 'tools/call',
            params: {
              name: 'tauri_check',
              arguments: {
                html: '<main><label><input type="checkbox" aria-label="Notify"> Notify</label></main>',
                ref: '@1',
                checked: true
              }
            }
          })
        )
      )
    )

    expect(checked.result.structuredContent).toEqual({ ok: true })

    const hovered = JSON.parse(
      await requiredResponse(
        handler(
          JSON.stringify({
            jsonrpc: '2.0',
            id: 11,
            method: 'tools/call',
            params: {
              name: 'tauri_hover',
              arguments: { html, ref: '@1' }
            }
          })
        )
      )
    )

    expect(hovered.result.structuredContent).toEqual({ ok: true })
  })

  it('discovers app-scoped endpoint registries for live MCP tool calls', async () => {
    const originalRuntimeDir = process.env.XDG_RUNTIME_DIR
    const runtimeDir = mkdtempSync(join(tmpdir(), 'tauri-agent-mcp-registry-'))
    process.env.XDG_RUNTIME_DIR = runtimeDir
    const appId = 'dev.byeongsu.fixture'
    const server = createLineJsonRpcServer(
      new DebuggerSession(
        new StaticHtmlAppAdapter({
          title: 'Ducktape',
          html: '<main aria-label="Ducktape"><label>Agent name<input aria-label="Agent name"></label></main>'
        })
      )
    )

    try {
      const port = await listen(server)
      await writeEndpointRegistry(
        createEndpointDescriptor({
          appId,
          pid: process.pid,
          tcp: { host: '127.0.0.1', port }
        })
      )

      const response = JSON.parse(
        await requiredResponse(
          createMcpRequestHandler()(
            JSON.stringify({
              jsonrpc: '2.0',
              id: 4,
              method: 'tools/call',
              params: {
                name: 'tauri_windows',
                arguments: { app: appId }
              }
            })
          )
        )
      )

      expect(response.result.structuredContent).toEqual({
        result: [{ label: 'main', title: 'Ducktape', focused: true, visible: true }]
      })
    } finally {
      server.close()
      process.env.XDG_RUNTIME_DIR = originalRuntimeDir
    }
  })
})

async function requiredResponse(response: Promise<string | undefined>): Promise<string> {
  const resolved = await response
  if (!resolved) {
    throw new Error('expected JSON-RPC response')
  }
  return resolved
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('server did not bind a TCP port')
  }
  return address.port
}
