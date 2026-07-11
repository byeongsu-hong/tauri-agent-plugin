import { readFile } from 'node:fs/promises'

import type { DebuggerClient } from '../daemon/client'
import { connectDebuggerClient, pollFollow, type DebuggerTarget } from '../daemon/connect'
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
type FollowMethod = 'logs' | 'events' | 'network' | 'ipc'

export interface McpServerOptions {
  target?: DebuggerTarget
  profile?: 'core' | 'full'
}

export function createMcpRequestHandler(options: McpServerOptions = {}): McpRequestHandler {
  const definitions = toolDefinitions(options)
  const names = new Set(definitions.map((definition) => definition.name))
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
          return jsonRpcResult(request.id, { tools: definitions })
        case 'tools/call':
          return jsonRpcResult(request.id, await callTool(request.params, names, options.target, options.profile))
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

async function callTool(
  params: unknown,
  names: Set<string>,
  target?: DebuggerTarget,
  profile?: 'core' | 'full'
): Promise<Record<string, unknown>> {
  const request = objectParam(params)
  const name = stringField(request, 'name')
  if (!names.has(name)) {
    throw new McpRequestError(-32602, `unknown MCP tool: ${name}`)
  }
  const args = objectParam(request.arguments ?? {})
  const client = await debuggerClient(args, target)
  const result = await executeTool(client, name, args, profile)
  const response: Record<string, unknown> = {
    content: toolContent(name, result),
    isError: false
  }
  if (!LARGE_RESULT_TOOLS.has(name)) response.structuredContent = structuredContent(result)
  return response
}

/**
 * Screenshots return an MCP image content block so clients can render them,
 * instead of burning tokens on a base64 data URL embedded in JSON text.
 */
function toolContent(name: string, result: unknown): Array<Record<string, unknown>> {
  if (name === 'tauri_shot' && typeof result === 'object' && result !== null) {
    const dataUrl = (result as { dataUrl?: unknown }).dataUrl
    if (typeof dataUrl === 'string') {
      const match = /^data:([^;,]+)(?:;base64)?,(.*)$/s.exec(dataUrl)
      if (match) {
        return [{ type: 'image', data: match[2], mimeType: match[1] }]
      }
    }
  }
  return [{ type: 'text', text: toolText(result) }]
}

async function executeTool(
  client: DebuggerClient,
  name: string,
  args: ToolCallArgs,
  profile?: 'core' | 'full'
): Promise<unknown> {
  switch (name) {
    case 'tauri_attach':
      return client.call('attach', windowParams(args))
    case 'tauri_windows':
      return client.call('windows')
    case 'tauri_window':
      return client.call('window', pick(args, ['window', 'action', 'x', 'y', 'width', 'height']))
    case 'tauri_tree':
      return client.call('tree', pick(args, ['window', 'scope', 'mode']))
    case 'tauri_find':
      return client.call('find', pick(args, ['window', 'scope', 'role', 'name', 'text', 'limit']))
    case 'tauri_act':
      return client.call('act', pick(args, ['window', 'scope', 'role', 'name', 'text', 'action', 'value', 'x', 'y', 'timeoutMs', 'detail']))
    case 'tauri_click':
      await client.call('tree', pick(args, ['window', 'scope']))
      return client.call('click', pick(args, ['window', 'ref']))
    case 'tauri_hover':
      await client.call('tree', pick(args, ['window', 'scope']))
      return client.call('hover', pick(args, ['window', 'ref']))
    case 'tauri_focus':
      await client.call('tree', pick(args, ['window', 'scope']))
      return client.call('focus', pick(args, ['window', 'ref']))
    case 'tauri_blur':
      await client.call('tree', pick(args, ['window', 'scope']))
      return client.call('blur', pick(args, ['window', 'ref']))
    case 'tauri_scroll':
      await client.call('tree', pick(args, ['window', 'scope']))
      return client.call('scroll', pick(args, ['window', 'ref', 'x', 'y']))
    case 'tauri_drag':
      await client.call('tree', pick(args, ['window', 'scope']))
      return client.call('drag', pick(args, ['window', 'ref', 'toRef']))
    case 'tauri_fill':
      await client.call('tree', pick(args, ['window', 'scope']))
      return client.call('fill', pick(args, ['window', 'ref', 'text']))
    case 'tauri_type':
      await client.call('tree', pick(args, ['window', 'scope']))
      return client.call('type', pick(args, ['window', 'ref', 'text']))
    case 'tauri_select':
      await client.call('tree', pick(args, ['window', 'scope']))
      return client.call('select', pick(args, ['window', 'ref', 'value']))
    case 'tauri_check':
      await client.call('tree', pick(args, ['window', 'scope']))
      return client.call('check', pick(args, ['window', 'ref', 'checked']))
    case 'tauri_upload':
      await client.call('tree', pick(args, ['window', 'scope']))
      return client.call('upload', pick(args, ['window', 'ref', 'files']))
    case 'tauri_inspect':
      await client.call('tree', pick(args, ['window', 'scope']))
      return client.call('inspect', pick(args, ['window', 'ref']))
    case 'tauri_eval':
      return client.call('eval', pick(args, ['window', 'code']))
    case 'tauri_press':
      if (args.ref !== undefined) {
        await client.call('tree', pick(args, ['window', 'scope']))
      }
      return client.call('press', { ...pick(args, ['window', 'ref', 'modifiers']), key: stringField(args, 'key') })
    case 'tauri_shot':
      return client.call('shot', pick(args, ['window', 'path', 'backend', 'ref']))
    case 'tauri_logs':
      return callFollowableEntries(client, 'logs', args)
    case 'tauri_events':
      return callFollowableEntries(client, 'events', args)
    case 'tauri_network':
      return callFollowableEntries(client, 'network', args)
    case 'tauri_ipc':
      return callFollowableEntries(client, 'ipc', args)
    case 'tauri_storage':
      return client.call('storage', pick(args, ['window', 'area', 'action', 'key', 'value']))
    case 'tauri_cookies':
      return client.call('cookies', pick(args, ['window', 'action', 'name', 'value']))
    case 'tauri_location':
      return client.call('location', pick(args, ['window', 'action', 'url']))
    case 'tauri_wait':
      return client.call(
        'wait',
        pick(args, [
          'window',
          'text',
          'scope',
          'role',
          'name',
          'timeoutMs',
          'state',
          'fn',
          'networkIdle',
          'idleMs'
        ])
      )
    case 'tauri_expect':
      return client.call(
        'expect',
        pick(args, ['window', 'scope', 'role', 'name', 'text', 'present', 'value', 'hasState'])
      )
    case 'tauri_state':
      return client.call('state', pick(args, ['window', 'key']))
    case 'tauri_dialog':
      return client.call('dialog', pick(args, ['window', 'action', 'accept', 'promptText']))
    case 'tauri_record':
      return client.call('record', pick(args, ['window', 'action']))
    case 'tauri_stream':
      return client.call('stream', {
        ...pick(args, ['window', 'since', 'timeoutMs', 'lean']),
        ...(profile === 'core' ? { lean: true } : {})
      })
    default:
      throw new Error(`unknown tool: ${name}`)
  }
}

async function callFollowableEntries(
  client: DebuggerClient,
  method: FollowMethod,
  args: ToolCallArgs
): Promise<unknown> {
  if (args.follow !== true) {
    return client.call(method, pick(args, ['window', 'follow', 'clear', 'since', 'limit']))
  }

  const entries: unknown[] = []
  const poll = pollFollow(client, method, windowParams(args), {
    pollMs: numberField(args, 'pollMs') ?? 250,
    timeoutMs: Math.max(0, numberField(args, 'timeoutMs') ?? 1000)
  })
  for await (const fresh of poll) {
    entries.push(...fresh)
  }
  return entries
}

async function debuggerClient(args: ToolCallArgs, target?: DebuggerTarget): Promise<DebuggerClient> {
  if (target) return connectDebuggerClient(target)
  return connectDebuggerClient({
    port: numberField(args, 'port'),
    host: stringField(args, 'host', '127.0.0.1'),
    app: stringField(args, 'app'),
    resolveHtml: () => htmlFromArgs(args)
  })
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
    },
    instructions:
      'Call tauri_tree or tauri_find first to obtain @-refs (e.g. @3); a ref is only valid until the next tree/find snapshot. Use tauri_type for realistic per-key input, tauri_ipc to trace the app’s Tauri command invokes, and tauri_stream for a live semantic-tree diff stream.'
  }
}

const FIELD_SCHEMAS: Record<string, unknown> = {
  window: { type: 'string', description: 'Tauri window label.' },
  scope: { type: 'string', description: 'CSS selector used to scope tree/action ref refresh.' },
  mode: { type: 'string', enum: ['compact', 'verbose'] },
  role: { type: 'string', description: 'Semantic role to match exactly.' },
  name: { type: 'string', description: 'Accessible name substring to match.' },
  ref: { type: 'string', description: 'Snapshot-local ref such as @3.' },
  toRef: { type: 'string', description: 'Snapshot-local drag target ref such as @8.' },
  value: { type: 'string', description: 'Option value, visible label, or storage value.' },
  checked: { type: 'boolean', description: 'Desired checked state. Defaults to true.' },
  code: { type: 'string', description: 'JavaScript expression or snippet evaluated in the app webview.' },
  text: { type: 'string' },
  key: { type: 'string', description: 'Keyboard key, storage key, or top-level state field.' },
  modifiers: {
    type: 'array',
    items: { type: 'string', enum: ['Alt', 'Control', 'Meta', 'Shift'] },
    description: 'Keyboard modifiers held while dispatching the key.'
  },
  x: { type: 'number', description: 'Horizontal scroll delta.' },
  y: { type: 'number', description: 'Vertical scroll delta.' },
  width: { type: 'number', description: 'Width in physical pixels.' },
  height: { type: 'number', description: 'Height in physical pixels.' },
  limit: { type: 'number', description: 'Maximum number of matches.' },
  path: { type: 'string', description: 'Output path for screenshot file writes.' },
  backend: {
    type: 'string',
    enum: ['dom', 'native', 'auto'],
    description: 'Screenshot backend. dom preserves the SVG bridge path, native captures app-window pixels, auto tries native then falls back to dom.'
  },
  follow: { type: 'boolean', description: 'Poll for entries before returning a bounded tool result.' },
  clear: { type: 'boolean', description: 'Clear captured entries after reading.' },
  pollMs: { type: 'number', description: 'Follow polling interval in milliseconds.' },
  area: { type: 'string', enum: ['local', 'session'], description: 'Storage area.' },
  url: { type: 'string', description: 'URL or path for SPA location push/replace actions.' },
  timeoutMs: { type: 'number', description: 'Maximum wait or follow duration in milliseconds.' },
  action: { type: 'string', enum: ['start', 'stop', 'get', 'clear'] },
  since: { type: 'number', description: 'Stream cursor; return semantic-tree diff frames with a higher seq.' },
  lean: { type: 'boolean', description: 'Omit repeated semantic snapshots except for initial sync or dropped recovery.' },
  detail: { type: 'boolean', description: 'Include optional response detail.' },
  state: {
    type: 'string',
    enum: ['present', 'absent'],
    description: 'wait target state: present (default, appear) or absent (disappear).'
  },
  present: { type: 'boolean', description: 'expect: whether the target must exist (default true).' },
  accept: { type: 'boolean', description: 'dialog: whether confirm/prompt are accepted (default true).' },
  promptText: { type: 'string', description: 'dialog: text returned by accepted prompt dialogs.' },
  hasState: { type: 'string', description: 'expect: state flag the matched element must have (e.g. disabled, checked).' },
  files: {
    type: 'array',
    description: 'upload: synthetic files to set on a file input.',
    items: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'File name.' },
        type: { type: 'string', description: 'MIME type (optional).' },
        text: { type: 'string', description: 'Text content of the file (optional).' }
      },
      required: ['name']
    }
  },
  fn: { type: 'string', description: 'wait: JS expression polled until it evaluates truthy (waitForFunction).' },
  networkIdle: { type: 'boolean', description: 'wait: resolve once no fetch/XHR request is in flight for idleMs.' },
  idleMs: { type: 'number', description: 'wait: quiet window for networkIdle in milliseconds (default 500).' }
}

const TOOL_DEFINITIONS: ToolDefinition[] = [
  tool('tauri_attach', 'Attach', 'Attach to a debuggable Tauri app.', schema(['window'])),
  tool('tauri_windows', 'Windows', 'List known Tauri windows with focus, visibility, state, scale, and bounds metadata.', baseSchema()),
  tool('tauri_window', 'Window', 'Inspect or control one Tauri window.', windowControlSchema()),
  tool('tauri_tree', 'Tree', 'Return a compact semantic tree.', schema(['window', 'scope', 'mode'])),
  tool('tauri_find', 'Find', 'Find current snapshot refs by semantic role, name, or text.', schema(['window', 'scope', 'role', 'name', 'text', 'limit'])),
  tool('tauri_act', 'Act', 'Locate, wait for actionability, and act in one request.', locatorActionSchema()),
  tool('tauri_click', 'Click', 'Click a snapshot-local ref.', schema(['window', 'scope', 'ref'], ['ref'])),
  tool('tauri_hover', 'Hover', 'Hover a snapshot-local ref.', schema(['window', 'scope', 'ref'], ['ref'])),
  tool('tauri_focus', 'Focus', 'Focus a snapshot-local ref.', schema(['window', 'scope', 'ref'], ['ref'])),
  tool('tauri_blur', 'Blur', 'Blur a snapshot-local ref.', schema(['window', 'scope', 'ref'], ['ref'])),
  tool('tauri_scroll', 'Scroll', 'Scroll a snapshot-local ref.', schema(['window', 'scope', 'ref', 'y', 'x'], ['ref'])),
  tool('tauri_drag', 'Drag', 'Drag a snapshot-local ref to another ref.', schema(['window', 'scope', 'ref', 'toRef'], ['ref'])),
  tool('tauri_fill', 'Fill', 'Fill a snapshot-local ref.', schema(['window', 'scope', 'ref', 'text'], ['ref', 'text'])),
  tool('tauri_type', 'Type', 'Type text into a snapshot-local ref with realistic per-key events.', schema(['window', 'scope', 'ref', 'text'], ['ref', 'text'])),
  tool('tauri_select', 'Select', 'Select an option in a snapshot-local select control.', schema(['window', 'scope', 'ref', 'value'], ['ref'])),
  tool('tauri_check', 'Check', 'Set checked state on a snapshot-local checkbox or radio ref.', schema(['window', 'scope', 'ref', 'checked'], ['ref'])),
  tool('tauri_upload', 'Upload', 'Set synthetic files on a snapshot-local file input ref.', schema(['window', 'scope', 'ref', 'files'], ['ref', 'files'])),
  tool('tauri_inspect', 'Inspect', 'Inspect a snapshot-local ref.', schema(['window', 'scope', 'ref'], ['ref'])),
  tool('tauri_eval', 'Eval', 'Evaluate JavaScript in the app webview.', schema(['window', 'code'], ['code'])),
  tool('tauri_press', 'Press', 'Dispatch a keyboard key.', schema(['window', 'scope', 'ref', 'key', 'modifiers'], ['key'])),
  tool('tauri_shot', 'Screenshot', 'Capture a DOM or native screenshot; pass ref to scope the capture to one element (forces the DOM backend).', schema(['window', 'path', 'backend', 'ref'])),
  tool('tauri_logs', 'Logs', 'Return captured app logs.', schema(['window', 'follow', 'clear', 'since', 'limit', 'pollMs', 'timeoutMs'])),
  tool('tauri_events', 'Events', 'Return captured app events.', schema(['window', 'follow', 'clear', 'since', 'limit', 'pollMs', 'timeoutMs'])),
  tool('tauri_network', 'Network', 'Return captured fetch network entries.', schema(['window', 'follow', 'clear', 'since', 'limit', 'pollMs', 'timeoutMs'])),
  tool('tauri_ipc', 'IPC', 'Return captured Tauri IPC invoke traces (command, timing, ok/error).', schema(['window', 'follow', 'clear', 'since', 'limit', 'pollMs', 'timeoutMs'])),
  tool('tauri_storage', 'Storage', 'Inspect or mutate webview storage.', storageSchema()),
  tool('tauri_cookies', 'Cookies', 'Inspect or mutate webview-visible cookies.', cookieSchema()),
  tool('tauri_location', 'Location', 'Inspect or update the webview location.', locationSchema()),
  tool('tauri_wait', 'Wait', 'Wait for text/a semantic element to appear (or disappear with state=absent), a JS expression to become truthy (fn), or the network to go idle (networkIdle).', schema(['window', 'text', 'scope', 'role', 'name', 'timeoutMs', 'state', 'fn', 'networkIdle', 'idleMs'])),
  tool('tauri_expect', 'Expect', 'Assert a semantic target exists (or is absent) and matches value/state; errors on mismatch.', schema(['window', 'scope', 'role', 'name', 'text', 'present', 'value', 'hasState'])),
  tool('tauri_state', 'State', 'Return current app state probes.', schema(['window', 'key'])),
  tool('tauri_dialog', 'Dialog', 'Auto-handle alert/confirm/prompt: set accept/promptText policy up front, then read what fired.', dialogSchema()),
  tool('tauri_record', 'Record', 'Manage action recording.', schema(['window', 'action'])),
  tool(
    'tauri_stream',
    'Stream',
    'Drain mutation-driven semantic-tree diff frames since a cursor, long-polling up to timeoutMs for the next change.',
    schema(['window', 'since', 'timeoutMs', 'lean'])
  )
]

const CORE_TOOLS = new Set(['tauri_attach', 'tauri_tree', 'tauri_act', 'tauri_expect', 'tauri_state', 'tauri_stream', 'tauri_ipc', 'tauri_shot'])
const LARGE_RESULT_TOOLS = new Set(['tauri_tree', 'tauri_logs', 'tauri_events', 'tauri_network', 'tauri_ipc', 'tauri_stream'])

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

function locatorActionSchema(): JsonSchema {
  const inputSchema = schema(['window', 'scope', 'role', 'name', 'text', 'value', 'x', 'y', 'timeoutMs', 'detail'], ['action'])
  inputSchema.properties.action = {
    type: 'string',
    enum: ['click', 'hover', 'focus', 'blur', 'fill', 'type', 'press', 'scroll', 'select', 'check']
  }
  inputSchema.properties.value = { type: ['string', 'boolean'] }
  return inputSchema
}

function toolDefinitions(options: McpServerOptions): ToolDefinition[] {
  const selected = options.profile === 'core'
    ? TOOL_DEFINITIONS.filter((definition) => CORE_TOOLS.has(definition.name))
    : TOOL_DEFINITIONS
  const omitted = new Set(options.target ? Object.keys(connectionProperties()) : [])
  if (options.profile === 'core') omitted.add('detail')
  if (omitted.size === 0) return selected
  return selected.map((definition) => ({
    ...definition,
    inputSchema: {
      ...definition.inputSchema,
      properties: Object.fromEntries(
        Object.entries(definition.inputSchema.properties).filter(([key]) => !omitted.has(key))
      )
    }
  }))
}

function storageSchema(): JsonSchema {
  const inputSchema = schema(['window', 'area', 'key', 'value'])
  inputSchema.properties.action = { type: 'string', enum: ['get', 'set', 'remove', 'clear'] }
  return inputSchema
}

function dialogSchema(): JsonSchema {
  const inputSchema = schema(['window', 'accept', 'promptText'])
  inputSchema.properties.action = {
    type: 'string',
    enum: ['get', 'set', 'clear'],
    description: 'get (default) reads state; set updates the policy; clear empties the log.'
  }
  return inputSchema
}

function cookieSchema(): JsonSchema {
  const inputSchema = schema(['window', 'name', 'value'])
  inputSchema.properties.action = { type: 'string', enum: ['get', 'set', 'remove', 'clear'] }
  inputSchema.properties.name = { type: 'string', description: 'Cookie name.' }
  return inputSchema
}

function locationSchema(): JsonSchema {
  const inputSchema = schema(['window', 'url'])
  inputSchema.properties.action = {
    type: 'string',
    enum: ['get', 'push', 'replace', 'reload', 'back', 'forward']
  }
  return inputSchema
}

function windowControlSchema(): JsonSchema {
  const inputSchema = schema(['window', 'x', 'y', 'width', 'height'])
  inputSchema.properties.action = {
    type: 'string',
    enum: ['get', 'focus', 'show', 'hide', 'minimize', 'unminimize', 'maximize', 'unmaximize', 'setSize', 'setPosition']
  }
  inputSchema.properties.x = { type: 'number', description: 'Window x position for setPosition.' }
  inputSchema.properties.y = { type: 'number', description: 'Window y position for setPosition.' }
  return inputSchema
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
  return JSON.stringify(result)
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
