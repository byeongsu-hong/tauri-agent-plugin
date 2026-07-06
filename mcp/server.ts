import { readFile } from 'node:fs/promises'

import { DebuggerClient, SocketTransport } from '../daemon/client'
import { readEndpointRegistry } from '../daemon/endpoint'
import { createDebuggerRpcHandler, InProcessTransport } from '../daemon/server'
import { DebuggerSession } from '../daemon/session'
import { StaticHtmlAppAdapter } from '../daemon/static-app'
import type { AgentMethod } from '../protocol/types'

const MCP_PROTOCOL_VERSION = '2025-11-25'

export type McpRequestHandler = (message: string) => Promise<string | undefined>
type JsonRpcId = string | number | null

interface JsonRpcRequest {
  jsonrpc: '2.0'
  id?: string | number
  method: string
  params?: unknown
}

interface ToolDefinition {
  name: string
  title: string
  description: string
  inputSchema: JsonSchema
}

type JsonSchema = {
  type: 'object'
  properties: Record<string, unknown>
  required?: string[]
  additionalProperties: boolean
}

type ToolCallArgs = Record<string, unknown>

export function createMcpRequestHandler(): McpRequestHandler {
  return async (message: string) => {
    let request: JsonRpcRequest
    try {
      request = parseJsonRpcRequest(message)
    } catch (error) {
      if (error instanceof JsonRpcParseError) {
        return jsonRpcError(null, -32700, error.message)
      }
      return jsonRpcError(null, -32600, errorMessage(error))
    }

    if (request.id === undefined) {
      return undefined
    }

    try {
      switch (request.method) {
        case 'initialize':
          return jsonRpcResult(request.id, initializeResult(request.params))
        case 'tools/list':
          return jsonRpcResult(request.id, { tools: TOOL_DEFINITIONS })
        case 'tools/call':
          return jsonRpcResult(request.id, await callTool(request.params))
        default:
          return jsonRpcError(request.id, -32601, `unsupported MCP method: ${request.method}`)
      }
    } catch (error) {
      if (error instanceof McpRequestError) {
        return jsonRpcError(request.id, error.code, error.message)
      }
      return jsonRpcResult(request.id, {
        content: [{ type: 'text', text: errorMessage(error) }],
        isError: true
      })
    }
  }
}

async function callTool(params: unknown): Promise<Record<string, unknown>> {
  const request = objectParam(params)
  const name = stringField(request, 'name')
  if (!TOOL_NAMES.has(name)) {
    throw new McpRequestError(-32602, `unknown MCP tool: ${name}`)
  }
  const args = objectParam(request.arguments ?? {})
  const client = await debuggerClient(args)
  const result = await executeTool(client, name, args)
  return {
    content: [{ type: 'text', text: toolText(result) }],
    structuredContent: structuredContent(result),
    isError: false
  }
}

async function executeTool(
  client: DebuggerClient,
  name: string,
  args: ToolCallArgs
): Promise<unknown> {
  switch (name) {
    case 'tauri_attach':
      return client.call('attach', windowParams(args))
    case 'tauri_windows':
      return client.call('windows')
    case 'tauri_tree':
      return client.call('tree', pick(args, ['window', 'scope', 'mode']))
    case 'tauri_click':
      await client.call('tree', pick(args, ['window', 'scope']))
      return client.call('click', pick(args, ['window', 'ref']))
    case 'tauri_fill':
      await client.call('tree', pick(args, ['window', 'scope']))
      return client.call('fill', pick(args, ['window', 'ref', 'text']))
    case 'tauri_select':
      await client.call('tree', pick(args, ['window', 'scope']))
      return client.call('select', pick(args, ['window', 'ref', 'value']))
    case 'tauri_check':
      await client.call('tree', pick(args, ['window', 'scope']))
      return client.call('check', pick(args, ['window', 'ref', 'checked']))
    case 'tauri_inspect':
      await client.call('tree', pick(args, ['window', 'scope']))
      return client.call('inspect', pick(args, ['window', 'ref']))
    case 'tauri_eval':
      return client.call('eval', pick(args, ['window', 'code']))
    case 'tauri_press':
      return client.call('press', { ...windowParams(args), key: stringField(args, 'key') })
    case 'tauri_shot':
      return client.call('shot', pick(args, ['window', 'path']))
    case 'tauri_logs':
      return client.call('logs', pick(args, ['window', 'follow']))
    case 'tauri_events':
      return client.call('events', pick(args, ['window', 'follow']))
    case 'tauri_wait':
      return client.call('wait', pick(args, ['window', 'text', 'timeoutMs']))
    case 'tauri_state':
      return client.call('state', pick(args, ['window', 'key']))
    case 'tauri_record':
      return client.call('record', pick(args, ['window', 'action']))
    default:
      throw new Error(`unknown tool: ${name}`)
  }
}

async function debuggerClient(args: ToolCallArgs): Promise<DebuggerClient> {
  const port = numberField(args, 'port')
  if (port !== undefined) {
    return new DebuggerClient(
      new SocketTransport({ port, host: stringField(args, 'host', '127.0.0.1') })
    )
  }

  const app = stringField(args, 'app')
  if (app) {
    const endpoint = await readEndpointRegistry(app)
    if (!isProcessAlive(endpoint.pid)) {
      throw new Error(`debugger endpoint for app ${app} is stale: pid ${endpoint.pid} is not running`)
    }
    return new DebuggerClient(
      new SocketTransport(
        endpoint.transport === 'tcp'
          ? { port: endpoint.port, host: endpoint.host }
          : { path: endpoint.path }
      )
    )
  }

  const html = await htmlFromArgs(args)
  const session = new DebuggerSession(new StaticHtmlAppAdapter({ html }))
  return new DebuggerClient(new InProcessTransport(createDebuggerRpcHandler(session)))
}

async function htmlFromArgs(args: ToolCallArgs): Promise<string> {
  const inlineHtml = stringField(args, 'html')
  if (inlineHtml) {
    return inlineHtml
  }
  const fromHtml = stringField(args, 'fromHtml')
  if (fromHtml) {
    return readFile(fromHtml, 'utf8')
  }
  throw new Error('MCP tool calls need app, port, html, or fromHtml')
}

function initializeResult(params: unknown): Record<string, unknown> {
  const requested = objectParam(params).protocolVersion
  return {
    protocolVersion: requested === MCP_PROTOCOL_VERSION ? requested : MCP_PROTOCOL_VERSION,
    capabilities: { tools: { listChanged: false } },
    serverInfo: {
      name: 'tauri-agent',
      title: 'Tauri Agent',
      version: '0.1.0'
    }
  }
}

const FIELD_SCHEMAS: Record<string, unknown> = {
  window: { type: 'string', description: 'Tauri window label.' },
  scope: { type: 'string', description: 'CSS selector used to scope tree/action ref refresh.' },
  mode: { type: 'string', enum: ['compact', 'verbose'] },
  ref: { type: 'string', description: 'Snapshot-local ref such as @3.' },
  value: { type: 'string', description: 'Option value or visible label.' },
  checked: { type: 'boolean', description: 'Desired checked state. Defaults to true.' },
  code: { type: 'string', description: 'JavaScript expression or snippet evaluated in the app webview.' },
  text: { type: 'string' },
  key: { type: 'string', description: 'Keyboard key, for example Enter.' },
  path: { type: 'string', description: 'Output path for screenshot file writes.' },
  follow: { type: 'boolean', description: 'Reserved for future streaming.' },
  timeoutMs: { type: 'number' },
  action: { type: 'string', enum: ['start', 'stop', 'get', 'clear'] }
}

const TOOL_DEFINITIONS: ToolDefinition[] = [
  tool('tauri_attach', 'Attach', 'Attach to a debuggable Tauri app.', schema(['window'])),
  tool('tauri_windows', 'Windows', 'List known Tauri windows.', baseSchema()),
  tool('tauri_tree', 'Tree', 'Return a compact semantic tree.', schema(['window', 'scope', 'mode'])),
  tool('tauri_click', 'Click', 'Click a snapshot-local ref.', schema(['window', 'scope', 'ref'], ['ref'])),
  tool('tauri_fill', 'Fill', 'Fill a snapshot-local ref.', schema(['window', 'scope', 'ref', 'text'], ['ref', 'text'])),
  tool('tauri_select', 'Select', 'Select an option in a snapshot-local select control.', schema(['window', 'scope', 'ref', 'value'], ['ref'])),
  tool('tauri_check', 'Check', 'Set checked state on a snapshot-local checkbox or radio ref.', schema(['window', 'scope', 'ref', 'checked'], ['ref'])),
  tool('tauri_inspect', 'Inspect', 'Inspect a snapshot-local ref.', schema(['window', 'scope', 'ref'], ['ref'])),
  tool('tauri_eval', 'Eval', 'Evaluate JavaScript in the app webview.', schema(['window', 'code'], ['code'])),
  tool('tauri_press', 'Press', 'Dispatch a keyboard key.', schema(['window', 'key'], ['key'])),
  tool('tauri_shot', 'Screenshot', 'Capture a DOM-rendered SVG screenshot.', schema(['window', 'path'])),
  tool('tauri_logs', 'Logs', 'Return captured app logs.', schema(['window', 'follow'])),
  tool('tauri_events', 'Events', 'Return captured app events.', schema(['window', 'follow'])),
  tool('tauri_wait', 'Wait', 'Wait for text to appear.', schema(['window', 'text', 'timeoutMs'], ['text'])),
  tool('tauri_state', 'State', 'Return current app state probes.', schema(['window', 'key'])),
  tool('tauri_record', 'Record', 'Manage action recording.', schema(['window', 'action']))
]

const TOOL_NAMES = new Set(TOOL_DEFINITIONS.map((toolDefinition) => toolDefinition.name))

class McpRequestError extends Error {
  constructor(
    readonly code: number,
    message: string
  ) {
    super(message)
  }
}

class JsonRpcParseError extends Error {}

function tool(name: string, title: string, description: string, inputSchema: JsonSchema): ToolDefinition {
  return { name, title, description, inputSchema }
}

function baseSchema(): JsonSchema {
  return schema([])
}

function schema(fields: string[], required: string[] = []): JsonSchema {
  return {
    type: 'object',
    properties: {
      ...connectionProperties(),
      ...fieldProperties(fields)
    },
    ...(required.length > 0 ? { required } : {}),
    additionalProperties: false
  }
}

function connectionProperties(): Record<string, unknown> {
  return {
    app: { type: 'string', description: 'Tauri app identifier for endpoint discovery.' },
    port: { type: 'number', description: 'Debugger daemon TCP port.' },
    host: { type: 'string', description: 'Debugger daemon host.' },
    html: { type: 'string', description: 'Inline static HTML for deterministic prototyping.' },
    fromHtml: { type: 'string', description: 'Path to a static HTML file.' }
  }
}

function fieldProperties(fields: string[]): Record<string, unknown> {
  const properties: Record<string, unknown> = {}
  for (const field of fields) {
    properties[field] = FIELD_SCHEMAS[field]
  }
  return properties
}

function toolText(result: unknown): string {
  if (typeof result === 'object' && result !== null && 'text' in result && typeof result.text === 'string') {
    return result.text
  }
  return JSON.stringify(result, null, 2)
}

function structuredContent(result: unknown): Record<string, unknown> {
  return typeof result === 'object' && result !== null && !Array.isArray(result)
    ? (result as Record<string, unknown>)
    : { result }
}

function pick(args: ToolCallArgs, keys: string[]): Record<string, unknown> {
  const picked: Record<string, unknown> = {}
  for (const key of keys) {
    if (args[key] !== undefined) {
      picked[key] = args[key]
    }
  }
  return picked
}

function windowParams(args: ToolCallArgs): Record<string, unknown> {
  return pick(args, ['window'])
}

function parseJsonRpcRequest(message: string): JsonRpcRequest {
  let parsed: JsonRpcRequest
  try {
    parsed = JSON.parse(message) as JsonRpcRequest
  } catch {
    throw new JsonRpcParseError('invalid MCP JSON-RPC message')
  }
  if (parsed.jsonrpc !== '2.0' || typeof parsed.method !== 'string') {
    throw new Error('invalid MCP JSON-RPC request')
  }
  return parsed
}

function objectParam(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function stringField(value: Record<string, unknown>, field: string, fallback = ''): string {
  const fieldValue = value[field]
  return typeof fieldValue === 'string' ? fieldValue : fallback
}

function numberField(value: Record<string, unknown>, field: string): number | undefined {
  const fieldValue = value[field]
  return typeof fieldValue === 'number' ? fieldValue : undefined
}

function jsonRpcResult(id: string | number, result: unknown): string {
  return JSON.stringify({ jsonrpc: '2.0', id, result })
}

function jsonRpcError(id: JsonRpcId, code: number, message: string): string {
  return JSON.stringify({
    jsonrpc: '2.0',
    id,
    error: { code, message }
  })
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return typeof error === 'object' && error !== null && 'code' in error && error.code === 'EPERM'
  }
}
