import { describe, expect, it } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer, type Server } from 'node:net'

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
        },
        instructions: expect.stringContaining('tauri_tree')
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
      'tauri_window',
      'tauri_tree',
      'tauri_find',
      'tauri_act',
      'tauri_click',
      'tauri_hover',
      'tauri_focus',
      'tauri_blur',
      'tauri_scroll',
      'tauri_drag',
      'tauri_fill',
      'tauri_type',
      'tauri_select',
      'tauri_check',
      'tauri_upload',
      'tauri_inspect',
      'tauri_eval',
      'tauri_press',
      'tauri_shot',
      'tauri_logs',
      'tauri_events',
      'tauri_network',
      'tauri_ipc',
      'tauri_diagnose',
      'tauri_storage',
      'tauri_cookies',
      'tauri_location',
      'tauri_wait',
      'tauri_expect',
      'tauri_state',
      'tauri_dialog',
      'tauri_record',
      'tauri_stream'
    ])
    expect(list.result.tools[0].inputSchema).toEqual(
      expect.objectContaining({ type: 'object', properties: expect.any(Object) })
    )
    const pressTool = list.result.tools.find((tool: { name: string }) => tool.name === 'tauri_press')
    expect(pressTool.inputSchema.properties.ref).toEqual({ type: 'string', description: 'Snapshot-local ref such as @3.' })
    expect(pressTool.inputSchema.properties.modifiers).toEqual({
      type: 'array',
      items: { type: 'string', enum: ['Alt', 'Control', 'Meta', 'Shift'] },
      description: 'Keyboard modifiers held while dispatching the key.'
    })
    const shotTool = list.result.tools.find((tool: { name: string }) => tool.name === 'tauri_shot')
    expect(shotTool.description).toBe(
      'Capture a DOM or native screenshot; pass ref to scope the capture to one element (forces the DOM backend).'
    )
    expect(shotTool.inputSchema.properties.ref).toEqual({ type: 'string', description: 'Snapshot-local ref such as @3.' })
    expect(shotTool.inputSchema.properties.backend).toEqual({
      type: 'string',
      enum: ['dom', 'native', 'auto'],
      description: 'Screenshot backend. dom preserves the SVG bridge path, native captures app-window pixels, auto tries native then falls back to dom.'
    })
    for (const toolName of ['tauri_logs', 'tauri_events', 'tauri_network']) {
      const followTool = list.result.tools.find((tool: { name: string }) => tool.name === toolName)
      expect(followTool.inputSchema.properties.follow).toEqual({
        type: 'boolean',
        description: 'Poll for entries before returning a bounded tool result.'
      })
      expect(followTool.inputSchema.properties.pollMs).toEqual({
        type: 'number',
        description: 'Follow polling interval in milliseconds.'
      })
      expect(followTool.inputSchema.properties.timeoutMs).toEqual({
        type: 'number',
        description: 'Maximum wait or follow duration in milliseconds.'
      })
    }
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

  it('keeps the scoped core tool schema below 40% of the full schema', async () => {
    const request = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
    const full = await requiredResponse(createMcpRequestHandler()(request))
    const core = await requiredResponse(createMcpRequestHandler({
      profile: 'core',
      target: { resolveHtml: async () => '<main></main>' }
    })(request))
    const parsed = JSON.parse(core)

    expect(parsed.result.tools.map((tool: { name: string }) => tool.name)).toEqual([
      'tauri_attach', 'tauri_tree', 'tauri_act', 'tauri_shot', 'tauri_ipc', 'tauri_diagnose', 'tauri_expect', 'tauri_state', 'tauri_stream'
    ])
    expect(parsed.result.tools.every((tool: { inputSchema: { properties: Record<string, unknown> } }) =>
      !('app' in tool.inputSchema.properties) && !('port' in tool.inputSchema.properties)
    )).toBe(true)
    expect(parsed.result.tools.find((tool: { name: string }) => tool.name === 'tauri_act')
      .inputSchema.properties).not.toHaveProperty('detail')
    expect(new TextEncoder().encode(core).length).toBeLessThanOrEqual(new TextEncoder().encode(full).length * 0.4)

    const stream = JSON.parse(await requiredResponse(createMcpRequestHandler({
      profile: 'core',
      target: { resolveHtml: async () => '<main></main>' }
    })(JSON.stringify({
      jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'tauri_stream', arguments: { since: 0 } }
    }))))
    expect(stream.result.content[0].text).not.toContain('snapshot')

    const diagnosis = JSON.parse(await requiredResponse(createMcpRequestHandler({
      profile: 'core',
      target: { resolveHtml: async () => '<main><button>Save</button></main>' }
    })(JSON.stringify({
      jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'tauri_diagnose', arguments: {} }
    }))))
    expect(JSON.parse(diagnosis.result.content[0].text)).toMatchObject({
      attach: { attached: true },
      logs: [],
      network: [],
      ipc: []
    })
  })

  it('diagnoses one action trace and expands its retained details', async () => {
    const fakeServer = await startFakeRpcServer({
      attach: { attached: true },
      state: { title: 'Agents' },
      logs: {
        entries: [
          { message: 'old', traceId: 'action-1' },
          { message: 'saving', traceId: 'action-2' }
        ],
        cursor: 2,
        dropped: false
      },
      events: {
        entries: [{ kind: 'click', traceId: 'action-2' }],
        cursor: 1,
        dropped: false
      },
      network: (callIndex: number) => callIndex === 0
        ? { entries: [{ id: 'fetch-2', traceId: 'action-2' }], cursor: 1, dropped: false }
        : { detail: { id: 'fetch-2', traceId: 'action-2', requestBody: { token: '[REDACTED]' } } },
      ipc: (callIndex: number) => callIndex === 0
        ? { entries: [{ id: 'ipc-2', command: 'save', traceId: 'action-2' }], cursor: 1, dropped: false }
        : { detail: { id: 'ipc-2', command: 'save', traceId: 'action-2', args: { token: '[REDACTED]' } } }
    })

    try {
      const response = JSON.parse(await requiredResponse(createMcpRequestHandler()(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 4,
          method: 'tools/call',
          params: {
            name: 'tauri_diagnose',
            arguments: { port: fakeServer.port, traceId: 'action-2' }
          }
        })
      )))

      expect(JSON.parse(response.result.content[0].text)).toMatchObject({
        traceId: 'action-2',
        logs: [{ message: 'saving', traceId: 'action-2' }],
        events: [{ kind: 'click', traceId: 'action-2' }],
        network: [{ id: 'fetch-2', requestBody: { token: '[REDACTED]' } }],
        ipc: [{ id: 'ipc-2', args: { token: '[REDACTED]' } }]
      })
      expect(fakeServer.requests.filter((request) => request.method === 'network')[1].params)
        .toEqual({ id: 'fetch-2' })
      expect(fakeServer.requests.filter((request) => request.method === 'ipc')[1].params)
        .toEqual({ id: 'ipc-2' })
    } finally {
      fakeServer.close()
    }
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

  it('polls followed log tools and returns accumulated entries', async () => {
    const fakeServer = await startFakeRpcServer({
      logs: (callIndex: number) =>
        callIndex === 0
          ? { entries: [{ level: 'info', message: 'booted' }], cursor: 8, dropped: false }
          : callIndex === 1
            ? { entries: [{ level: 'error', message: 'late failure' }], cursor: 9, dropped: false }
            : { entries: [], cursor: 9, dropped: false }
    })

    try {
      const response = JSON.parse(
        await requiredResponse(
          createMcpRequestHandler()(
            JSON.stringify({
              jsonrpc: '2.0',
              id: 19,
              method: 'tools/call',
              params: {
                name: 'tauri_logs',
                arguments: { port: fakeServer.port, follow: true, since: 7, pollMs: 1, timeoutMs: 50 }
              }
            })
          )
        )
      )

      expect(response.result.structuredContent).toBeUndefined()
      expect(JSON.parse(response.result.content[0].text)).toEqual([
        { level: 'info', message: 'booted' },
        { level: 'error', message: 'late failure' }
      ])
      expect(fakeServer.requests.length).toBeGreaterThanOrEqual(2)
      expect(fakeServer.requests.every((request) => request.method === 'logs')).toBe(true)
      expect(fakeServer.requests.map((request) => request.params?.since).slice(0, 2)).toEqual([7, 8])
      expect(fakeServer.requests.every((request) => request.params?.clear === undefined)).toBe(true)
    } finally {
      fakeServer.close()
    }
  })

  it('forwards screenshot backend requests through MCP tools', async () => {
    const fakeServer = await startFakeRpcServer({
      shot: {
        path: '/tmp/app.png',
        mime: 'image/png',
        width: 32,
        height: 24
      }
    })

    try {
      const response = JSON.parse(
        await requiredResponse(
          createMcpRequestHandler()(
            JSON.stringify({
              jsonrpc: '2.0',
              id: 25,
              method: 'tools/call',
              params: {
                name: 'tauri_shot',
                arguments: { port: fakeServer.port, path: '/tmp/app.png', backend: 'native' }
              }
            })
          )
        )
      )

      expect(response.result.structuredContent).toEqual({
        path: '/tmp/app.png',
        mime: 'image/png',
        width: 32,
        height: 24
      })
      expect(fakeServer.requests).toEqual([
        { method: 'shot', params: { path: '/tmp/app.png', backend: 'native' } }
      ])
    } finally {
      fakeServer.close()
    }
  })

  it('returns screenshots as MCP image content blocks', async () => {
    const fakeServer = await startFakeRpcServer({
      shot: {
        dataUrl: 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=',
        mime: 'image/svg+xml',
        width: 10,
        height: 10
      }
    })

    try {
      const response = JSON.parse(
        await requiredResponse(
          createMcpRequestHandler()(
            JSON.stringify({
              jsonrpc: '2.0',
              id: 26,
              method: 'tools/call',
              params: { name: 'tauri_shot', arguments: { port: fakeServer.port } }
            })
          )
        )
      )

      expect(response.result.content).toEqual([
        { type: 'image', data: 'PHN2Zz48L3N2Zz4=', mimeType: 'image/svg+xml' }
      ])
    } finally {
      fakeServer.close()
    }
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
        isError: false
      }
    })

    const windowResult = JSON.parse(
      await requiredResponse(
        handler(
          JSON.stringify({
            jsonrpc: '2.0',
            id: 17,
            method: 'tools/call',
            params: {
              name: 'tauri_window',
              arguments: { html, action: 'setSize', width: 800, height: 600 }
            }
          })
        )
      )
    )

    expect(windowResult.result.structuredContent).toEqual({
      ...staticWindowInfo('Tauri App'),
      innerBounds: { x: 0, y: 0, width: 800, height: 600 },
      outerBounds: { x: 0, y: 0, width: 800, height: 600 }
    })

    const pressed = JSON.parse(
      await requiredResponse(
        handler(
          JSON.stringify({
            jsonrpc: '2.0',
            id: 18,
            method: 'tools/call',
            params: {
              name: 'tauri_press',
              arguments: { html, scope: 'main', ref: '@1', key: 'k', modifiers: ['Meta', 'Shift'] }
            }
          })
        )
      )
    )

    expect(pressed.result.structuredContent).toEqual({ ok: true })

    const found = JSON.parse(
      await requiredResponse(
        handler(
          JSON.stringify({
            jsonrpc: '2.0',
            id: 16,
            method: 'tools/call',
            params: {
              name: 'tauri_find',
              arguments: { html, role: 'textbox', name: 'agent' }
            }
          })
        )
      )
    )

    expect(found.result.structuredContent).toEqual({
      matches: [
        expect.objectContaining({
          ref: '@1',
          role: 'textbox',
          name: 'Agent name',
          tagName: 'input'
        })
      ]
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

    const uploaded = JSON.parse(
      await requiredResponse(
        handler(
          JSON.stringify({
            jsonrpc: '2.0',
            id: 11,
            method: 'tools/call',
            params: {
              name: 'tauri_upload',
              arguments: {
                html: '<main><input type="file" aria-label="Attachment"></main>',
                ref: '@1',
                files: [{ name: 'notes.txt', text: 'hello' }]
              }
            }
          })
        )
      )
    )

    expect(uploaded.result.structuredContent).toEqual({ ok: true })

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

    const focused = JSON.parse(
      await requiredResponse(
        handler(
          JSON.stringify({
            jsonrpc: '2.0',
            id: 12,
            method: 'tools/call',
            params: {
              name: 'tauri_focus',
              arguments: { html, ref: '@1' }
            }
          })
        )
      )
    )

    expect(focused.result.structuredContent).toEqual({ ok: true })

    const blurred = JSON.parse(
      await requiredResponse(
        handler(
          JSON.stringify({
            jsonrpc: '2.0',
            id: 13,
            method: 'tools/call',
            params: {
              name: 'tauri_blur',
              arguments: { html, ref: '@1' }
            }
          })
        )
      )
    )

    expect(blurred.result.structuredContent).toEqual({ ok: true })

    const scrolled = JSON.parse(
      await requiredResponse(
        handler(
          JSON.stringify({
            jsonrpc: '2.0',
            id: 14,
            method: 'tools/call',
            params: {
              name: 'tauri_scroll',
              arguments: {
                html: '<main><ul aria-label="Roster"><li>local-worker</li></ul></main>',
                ref: '@1',
                y: 12,
                x: 3
              }
            }
          })
        )
      )
    )

    expect(scrolled.result.structuredContent).toEqual({ ok: true })

    const dragged = JSON.parse(
      await requiredResponse(
        handler(
          JSON.stringify({
            jsonrpc: '2.0',
            id: 15,
            method: 'tools/call',
            params: {
              name: 'tauri_drag',
              arguments: {
                html: '<main><button draggable="true">Drag source</button><button>Drop target</button></main>',
                ref: '@1',
                toRef: '@2'
              }
            }
          })
        )
      )
    )

    expect(dragged.result.structuredContent).toEqual({ ok: true })

    const logs = JSON.parse(
      await requiredResponse(
        handler(
          JSON.stringify({
            jsonrpc: '2.0',
            id: 21,
            method: 'tools/call',
            params: {
              name: 'tauri_logs',
              arguments: { html, clear: true }
            }
          })
        )
      )
    )

    expect(logs.result.structuredContent).toBeUndefined()
    expect(JSON.parse(logs.result.content[0].text)).toEqual({ entries: [], cursor: 0, dropped: false })

    const events = JSON.parse(
      await requiredResponse(
        handler(
          JSON.stringify({
            jsonrpc: '2.0',
            id: 22,
            method: 'tools/call',
            params: {
              name: 'tauri_events',
              arguments: { html, clear: true }
            }
          })
        )
      )
    )

    expect(events.result.structuredContent).toBeUndefined()
    expect(JSON.parse(events.result.content[0].text)).toEqual({ entries: [], cursor: 0, dropped: false })

    const network = JSON.parse(
      await requiredResponse(
        handler(
          JSON.stringify({
            jsonrpc: '2.0',
            id: 17,
            method: 'tools/call',
            params: {
              name: 'tauri_network',
              arguments: { html, clear: true }
            }
          })
        )
      )
    )

    expect(network.result.structuredContent).toBeUndefined()
    expect(JSON.parse(network.result.content[0].text)).toEqual({ entries: [], cursor: 0, dropped: false })

    const wait = JSON.parse(
      await requiredResponse(
        handler(
          JSON.stringify({
            jsonrpc: '2.0',
            id: 18,
            method: 'tools/call',
            params: {
              name: 'tauri_wait',
              arguments: { html: '<main><button>Forge</button></main>', role: 'button', name: 'Forge', timeoutMs: 1 }
            }
          })
        )
      )
    )

    expect(wait.result.structuredContent).toEqual({
      matched: true,
      text: 'Forge',
      match: expect.objectContaining({
        ref: '@1',
        role: 'button',
        name: 'Forge',
        tagName: 'button',
        text: 'Forge'
      })
    })

    const stateValues = JSON.parse(
      await requiredResponse(
        handler(
          JSON.stringify({
            jsonrpc: '2.0',
            id: 24,
            method: 'tools/call',
            params: {
              name: 'tauri_state',
              arguments: {
                html: '<main><label>Agent name<input aria-label="Agent name" value="worker-a"></label></main>',
                key: 'values'
              }
            }
          })
        )
      )
    )

    expect(stateValues.result.structuredContent).toEqual({ 'Agent name': 'worker-a' })

    const missingState = JSON.parse(
      await requiredResponse(
        handler(
          JSON.stringify({
            jsonrpc: '2.0',
            id: 25,
            method: 'tools/call',
            params: {
              name: 'tauri_state',
              arguments: { html, key: 'missing' }
            }
          })
        )
      )
    )

    expect(missingState.result.structuredContent).toEqual({ result: null })

    const storage = JSON.parse(
      await requiredResponse(
        handler(
          JSON.stringify({
            jsonrpc: '2.0',
            id: 19,
            method: 'tools/call',
            params: {
              name: 'tauri_storage',
              arguments: { html, action: 'set', key: 'agent.token', value: 'ready' }
            }
          })
        )
      )
    )

    expect(storage.result.structuredContent).toEqual({
      area: 'local',
      entries: [{ area: 'local', key: 'agent.token', value: 'ready' }]
    })

    const cookies = JSON.parse(
      await requiredResponse(
        handler(
          JSON.stringify({
            jsonrpc: '2.0',
            id: 23,
            method: 'tools/call',
            params: {
              name: 'tauri_cookies',
              arguments: { html, action: 'set', name: 'agent.cookie', value: 'ready' }
            }
          })
        )
      )
    )

    expect(cookies.result.structuredContent).toEqual({
      entries: [{ name: 'agent.cookie', value: 'ready' }]
    })

    const location = JSON.parse(
      await requiredResponse(
        handler(
          JSON.stringify({
            jsonrpc: '2.0',
            id: 20,
            method: 'tools/call',
            params: {
              name: 'tauri_location',
              arguments: { html, action: 'push', url: '/agents?view=debug#roster' }
            }
          })
        )
      )
    )

    expect(location.result.structuredContent).toEqual({
      href: 'tauri-agent://static/agents?view=debug#roster',
      origin: 'null',
      pathname: '/agents',
      search: '?view=debug',
      hash: '#roster'
    })
  })

  it('discovers app-scoped endpoint registries for live MCP tool calls', async () => {
    const originalRuntimeDir = process.env.XDG_RUNTIME_DIR
    const runtimeDir = mkdtempSync(join(tmpdir(), 'tauri-agent-mcp-registry-'))
    process.env.XDG_RUNTIME_DIR = runtimeDir
    const appId = 'dev.byeongsu.fixture'
    const server = createLineJsonRpcServer(
      new DebuggerSession(
        await StaticHtmlAppAdapter.create({
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
        result: [staticWindowInfo('Ducktape')]
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

type RpcResponse = unknown | ((callIndex: number) => unknown)

async function startFakeRpcServer(responses: Record<string, RpcResponse>): Promise<{
  close: () => void
  port: number
  requests: Array<{ method: string; params?: Record<string, unknown> }>
}> {
  const requests: Array<{ method: string; params?: Record<string, unknown> }> = []
  const callCounts = new Map<string, number>()
  const server = createServer((socket) => {
    let buffer = ''
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8')
      let newlineIndex = buffer.indexOf('\n')
      while (newlineIndex !== -1) {
        const line = buffer.slice(0, newlineIndex)
        buffer = buffer.slice(newlineIndex + 1)
        const request = JSON.parse(line) as { id: number; method: string; params?: Record<string, unknown> }
        requests.push({ method: request.method, params: request.params })
        const callIndex = callCounts.get(request.method) ?? 0
        callCounts.set(request.method, callIndex + 1)
        const response = responses[request.method]
        const result = typeof response === 'function' ? response(callIndex) : response
        socket.write(
          `${JSON.stringify({
            jsonrpc: '2.0',
            id: request.id,
            result: result ?? { ok: true }
          })}\n`,
          () => socket.end()
        )
        newlineIndex = buffer.indexOf('\n')
      }
    })
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('fake RPC server did not bind to a TCP port')
  }
  return {
    close: () => server.close(),
    port: address.port,
    requests
  }
}

function staticWindowInfo(title: string): Record<string, unknown> {
  return {
    label: 'main',
    title,
    focused: true,
    visible: true,
    minimized: false,
    maximized: false,
    scaleFactor: 1,
    innerBounds: { x: 0, y: 0, width: 1024, height: 768 },
    outerBounds: { x: 0, y: 0, width: 1024, height: 768 }
  }
}
