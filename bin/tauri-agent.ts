#!/usr/bin/env node
import { readFile } from 'node:fs/promises'

import { Command } from 'commander'

import { DebuggerClient, SocketTransport } from '../daemon/client'
import { readEndpointRegistry } from '../daemon/endpoint'
import { createDebuggerRpcHandler, createLineJsonRpcServer, InProcessTransport } from '../daemon/server'
import { DebuggerSession } from '../daemon/session'
import { StaticHtmlAppAdapter } from '../daemon/static-app'
import type { AgentMethod } from '../protocol/types'

interface ConnectionOptions {
  app?: string
  fromHtml?: string
  mode?: 'compact' | 'verbose'
  scope?: string
  window?: string
  host?: string
  port?: number
}

interface FollowOptions extends ConnectionOptions {
  follow?: boolean
  clear?: boolean
  pollMs?: number
  timeoutMs?: number
}

interface TreeOptions extends ConnectionOptions {
  interactive?: boolean
  pollMs?: number
  timeoutMs?: number
}

interface FindOptions extends ConnectionOptions {
  role?: string
  name?: string
  text?: string
  limit?: number
}

interface StorageOptions extends ConnectionOptions {
  area?: 'local' | 'session'
  action?: 'get' | 'set' | 'remove' | 'clear'
  key?: string
  value?: string
}

interface LocationOptions extends ConnectionOptions {
  action?: 'get' | 'push' | 'replace'
  url?: string
}

const program = new Command()

program
  .name('tauri-agent')
  .description('Headless agent debugger for Tauri apps.')
  .version('0.1.0')

program
  .command('serve')
  .description('Serve the headless debugger JSON-RPC protocol.')
  .option('--from-html <path>', 'serve a static HTML adapter')
  .option('--host <host>', 'host to bind', '127.0.0.1')
  .option('--port <port>', 'port to bind', Number, 45127)
  .action(async (options: ConnectionOptions & { host: string; port: number }) => {
    if (!options.fromHtml) {
      exitBridgePending()
    }
    const html = await readFile(options.fromHtml, 'utf8')
    const server = createLineJsonRpcServer(new DebuggerSession(new StaticHtmlAppAdapter({ html })))
    await new Promise<void>((resolve) => server.listen(options.port, options.host, resolve))
    const address = server.address()
    printJson({ listening: true, address })
  })

program
  .command('attach')
  .description('Attach to a debuggable Tauri app.')
  .option('--app <appId>', 'Tauri app identifier for endpoint discovery')
  .option('--from-html <path>', 'prototype against a static HTML file')
  .option('--host <host>', 'debug daemon host', '127.0.0.1')
  .option('--port <port>', 'debug daemon port', Number)
  .option('--window <label>', 'Tauri window label')
  .action(async (options: ConnectionOptions) => printJson(await call(options, 'attach', targetParams(options))))

program
  .command('windows')
  .description('List known Tauri windows.')
  .option('--app <appId>', 'Tauri app identifier for endpoint discovery')
  .option('--from-html <path>', 'prototype against a static HTML file')
  .option('--host <host>', 'debug daemon host', '127.0.0.1')
  .option('--port <port>', 'debug daemon port', Number)
  .action(async (options: ConnectionOptions) => printJson(await call(options, 'windows')))

program
  .command('tree')
  .description('Print a compact semantic tree.')
  .option('--app <appId>', 'Tauri app identifier for endpoint discovery')
  .option('--from-html <path>', 'prototype against a static HTML file')
  .option('--host <host>', 'debug daemon host', '127.0.0.1')
  .option('--port <port>', 'debug daemon port', Number)
  .option('--window <label>', 'Tauri window label')
  .option('--scope <selector>', 'limit the snapshot to a CSS selector')
  .option('--mode <mode>', 'tree output mode: compact or verbose', parseTreeMode)
  .option('--interactive', 'poll and stream changed semantic tree snapshots as newline-delimited JSON')
  .option('--poll-ms <ms>', 'interactive polling interval in milliseconds', parseNumber, 250)
  .option('--timeout-ms <ms>', 'stop interactive polling after this many milliseconds', parseNumber)
  .action(async (options: TreeOptions) => {
    if (options.interactive) {
      await watchTree(options)
      return
    }
    const result = (await call(options, 'tree', treeParams(options))) as { text: string }
    process.stdout.write(`${result.text}\n`)
  })

program
  .command('find')
  .description('Find current snapshot refs by semantic role, name, or text.')
  .option('--app <appId>', 'Tauri app identifier for endpoint discovery')
  .option('--from-html <path>', 'prototype against a static HTML file')
  .option('--host <host>', 'debug daemon host', '127.0.0.1')
  .option('--port <port>', 'debug daemon port', Number)
  .option('--window <label>', 'Tauri window label')
  .option('--scope <selector>', 'limit the snapshot to a CSS selector')
  .option('--role <role>', 'semantic role to match exactly')
  .option('--name <name>', 'accessible name substring to match')
  .option('--text <text>', 'visible text substring to match')
  .option('--limit <count>', 'maximum number of matches', parseNumber)
  .action(async (options: FindOptions) => printJson(await call(options, 'find', findParams(options))))

program
  .command('click')
  .description('Click a snapshot-local ref.')
  .argument('<ref>', 'snapshot-local ref, for example @3')
  .option('--app <appId>', 'Tauri app identifier for endpoint discovery')
  .option('--from-html <path>', 'prototype against a static HTML file')
  .option('--host <host>', 'debug daemon host', '127.0.0.1')
  .option('--port <port>', 'debug daemon port', Number)
  .option('--window <label>', 'Tauri window label')
  .option('--scope <selector>', 'limit the snapshot to a CSS selector')
  .action(async (ref: string, options: ConnectionOptions) => {
    const client = await debuggerClient(options)
    await client.call('tree', treeParams(options))
    printJson(await client.call('click', refActionParams(options, ref)))
  })

program
  .command('hover')
  .description('Hover a snapshot-local ref.')
  .argument('<ref>', 'snapshot-local ref, for example @3')
  .option('--app <appId>', 'Tauri app identifier for endpoint discovery')
  .option('--from-html <path>', 'prototype against a static HTML file')
  .option('--host <host>', 'debug daemon host', '127.0.0.1')
  .option('--port <port>', 'debug daemon port', Number)
  .option('--window <label>', 'Tauri window label')
  .option('--scope <selector>', 'limit the snapshot ref refresh to a CSS selector')
  .action(async (ref: string, options: ConnectionOptions) => {
    const client = await debuggerClient(options)
    await client.call('tree', treeParams(options))
    printJson(await client.call('hover', refActionParams(options, ref)))
  })

program
  .command('focus')
  .description('Focus a snapshot-local ref.')
  .argument('<ref>', 'snapshot-local ref, for example @4')
  .option('--app <appId>', 'Tauri app identifier for endpoint discovery')
  .option('--from-html <path>', 'prototype against a static HTML file')
  .option('--host <host>', 'debug daemon host', '127.0.0.1')
  .option('--port <port>', 'debug daemon port', Number)
  .option('--window <label>', 'Tauri window label')
  .option('--scope <selector>', 'limit the snapshot ref refresh to a CSS selector')
  .action(async (ref: string, options: ConnectionOptions) => {
    const client = await debuggerClient(options)
    await client.call('tree', treeParams(options))
    printJson(await client.call('focus', refActionParams(options, ref)))
  })

program
  .command('blur')
  .description('Blur a snapshot-local ref.')
  .argument('<ref>', 'snapshot-local ref, for example @4')
  .option('--app <appId>', 'Tauri app identifier for endpoint discovery')
  .option('--from-html <path>', 'prototype against a static HTML file')
  .option('--host <host>', 'debug daemon host', '127.0.0.1')
  .option('--port <port>', 'debug daemon port', Number)
  .option('--window <label>', 'Tauri window label')
  .option('--scope <selector>', 'limit the snapshot ref refresh to a CSS selector')
  .action(async (ref: string, options: ConnectionOptions) => {
    const client = await debuggerClient(options)
    await client.call('tree', treeParams(options))
    printJson(await client.call('blur', refActionParams(options, ref)))
  })

program
  .command('scroll')
  .description('Scroll a snapshot-local ref by x/y deltas.')
  .argument('<ref>', 'snapshot-local ref, for example @7')
  .argument('[y]', 'vertical scroll delta', parseNumber, 0)
  .argument('[x]', 'horizontal scroll delta', parseNumber, 0)
  .option('--app <appId>', 'Tauri app identifier for endpoint discovery')
  .option('--from-html <path>', 'prototype against a static HTML file')
  .option('--host <host>', 'debug daemon host', '127.0.0.1')
  .option('--port <port>', 'debug daemon port', Number)
  .option('--window <label>', 'Tauri window label')
  .option('--scope <selector>', 'limit the snapshot ref refresh to a CSS selector')
  .action(async (ref: string, y: number, x: number, options: ConnectionOptions) => {
    const client = await debuggerClient(options)
    await client.call('tree', treeParams(options))
    printJson(await client.call('scroll', refActionParams(options, ref, { y, x })))
  })

program
  .command('drag')
  .description('Drag a snapshot-local ref to another snapshot-local ref.')
  .argument('<ref>', 'snapshot-local source ref, for example @3')
  .argument('[toRef]', 'snapshot-local target ref, for example @8')
  .option('--app <appId>', 'Tauri app identifier for endpoint discovery')
  .option('--from-html <path>', 'prototype against a static HTML file')
  .option('--host <host>', 'debug daemon host', '127.0.0.1')
  .option('--port <port>', 'debug daemon port', Number)
  .option('--window <label>', 'Tauri window label')
  .option('--scope <selector>', 'limit the snapshot ref refresh to a CSS selector')
  .action(async (ref: string, toRef: string | undefined, options: ConnectionOptions) => {
    const client = await debuggerClient(options)
    await client.call('tree', treeParams(options))
    printJson(await client.call('drag', refActionParams(options, ref, { toRef })))
  })

program
  .command('fill')
  .description('Fill a snapshot-local ref.')
  .argument('<ref>', 'snapshot-local ref, for example @4')
  .argument('<text>', 'text value')
  .option('--app <appId>', 'Tauri app identifier for endpoint discovery')
  .option('--from-html <path>', 'prototype against a static HTML file')
  .option('--host <host>', 'debug daemon host', '127.0.0.1')
  .option('--port <port>', 'debug daemon port', Number)
  .option('--window <label>', 'Tauri window label')
  .option('--scope <selector>', 'limit the snapshot to a CSS selector')
  .action(async (ref: string, text: string, options: ConnectionOptions) => {
    const client = await debuggerClient(options)
    await client.call('tree', treeParams(options))
    printJson(await client.call('fill', refActionParams(options, ref, { text })))
  })

program
  .command('select')
  .description('Select an option in a snapshot-local select control.')
  .argument('<ref>', 'snapshot-local select or option ref, for example @4')
  .argument('[value]', 'option value or visible label')
  .option('--app <appId>', 'Tauri app identifier for endpoint discovery')
  .option('--from-html <path>', 'prototype against a static HTML file')
  .option('--host <host>', 'debug daemon host', '127.0.0.1')
  .option('--port <port>', 'debug daemon port', Number)
  .option('--window <label>', 'Tauri window label')
  .option('--scope <selector>', 'limit the snapshot ref refresh to a CSS selector')
  .action(async (ref: string, value: string | undefined, options: ConnectionOptions) => {
    const client = await debuggerClient(options)
    await client.call('tree', treeParams(options))
    printJson(await client.call('select', refActionParams(options, ref, { value })))
  })

program
  .command('check')
  .description('Set checked state on a snapshot-local checkbox or radio ref.')
  .argument('<ref>', 'snapshot-local checkbox or radio ref, for example @6')
  .argument('[checked]', 'true or false', parseBoolean)
  .option('--app <appId>', 'Tauri app identifier for endpoint discovery')
  .option('--from-html <path>', 'prototype against a static HTML file')
  .option('--host <host>', 'debug daemon host', '127.0.0.1')
  .option('--port <port>', 'debug daemon port', Number)
  .option('--window <label>', 'Tauri window label')
  .option('--scope <selector>', 'limit the snapshot ref refresh to a CSS selector')
  .action(async (ref: string, checked: boolean | undefined, options: ConnectionOptions) => {
    const client = await debuggerClient(options)
    await client.call('tree', treeParams(options))
    printJson(await client.call('check', refActionParams(options, ref, { checked })))
  })

program
  .command('inspect')
  .description('Inspect a snapshot-local ref.')
  .argument('<ref>', 'snapshot-local ref, for example @4')
  .option('--app <appId>', 'Tauri app identifier for endpoint discovery')
  .option('--from-html <path>', 'prototype against a static HTML file')
  .option('--host <host>', 'debug daemon host', '127.0.0.1')
  .option('--port <port>', 'debug daemon port', Number)
  .option('--window <label>', 'Tauri window label')
  .option('--scope <selector>', 'limit the snapshot ref refresh to a CSS selector')
  .action(async (ref: string, options: ConnectionOptions) => {
    const client = await debuggerClient(options)
    await client.call('tree', treeParams(options))
    printJson(await client.call('inspect', refActionParams(options, ref)))
  })

program
  .command('eval')
  .description('Evaluate JavaScript in the app webview.')
  .argument('<code>', 'JavaScript expression or snippet')
  .option('--app <appId>', 'Tauri app identifier for endpoint discovery')
  .option('--from-html <path>', 'prototype against a static HTML file')
  .option('--host <host>', 'debug daemon host', '127.0.0.1')
  .option('--port <port>', 'debug daemon port', Number)
  .option('--window <label>', 'Tauri window label')
  .action(async (code: string, options: ConnectionOptions) =>
    printJson(await call(options, 'eval', { ...targetParams(options), code }))
  )

program
  .command('press')
  .description('Dispatch a keyboard key.')
  .argument('<key>', 'key name, for example Enter')
  .option('--app <appId>', 'Tauri app identifier for endpoint discovery')
  .option('--from-html <path>', 'prototype against a static HTML file')
  .option('--host <host>', 'debug daemon host', '127.0.0.1')
  .option('--port <port>', 'debug daemon port', Number)
  .option('--window <label>', 'Tauri window label')
  .action(async (key: string, options: ConnectionOptions) =>
    printJson(await call(options, 'press', { ...targetParams(options), key }))
  )

program
  .command('shot')
  .description('Capture a screenshot through the live Tauri bridge.')
  .argument('[path]', 'output path')
  .option('--app <appId>', 'Tauri app identifier for endpoint discovery')
  .option('--from-html <htmlPath>', 'prototype against a static HTML file')
  .option('--host <host>', 'debug daemon host', '127.0.0.1')
  .option('--port <port>', 'debug daemon port', Number)
  .option('--window <label>', 'Tauri window label')
  .action(async (path: string | undefined, options: ConnectionOptions) =>
    printJson(await call(options, 'shot', { ...targetParams(options), path }))
  )

program
  .command('logs')
  .description('Print captured app logs.')
  .option('--app <appId>', 'Tauri app identifier for endpoint discovery')
  .option('--from-html <path>', 'prototype against a static HTML file')
  .option('--host <host>', 'debug daemon host', '127.0.0.1')
  .option('--port <port>', 'debug daemon port', Number)
  .option('--window <label>', 'Tauri window label')
  .option('--follow', 'poll and stream new log entries as newline-delimited JSON')
  .option('--poll-ms <ms>', 'follow polling interval in milliseconds', parseNumber, 250)
  .option('--timeout-ms <ms>', 'stop following after this many milliseconds', parseNumber)
  .action(async (options: FollowOptions) => {
    if (options.follow) {
      await followEntries(options, 'logs')
      return
    }
    printJson(await call(options, 'logs', { ...targetParams(options), follow: options.follow }))
  })

program
  .command('events')
  .description('Print captured app events.')
  .option('--app <appId>', 'Tauri app identifier for endpoint discovery')
  .option('--from-html <path>', 'prototype against a static HTML file')
  .option('--host <host>', 'debug daemon host', '127.0.0.1')
  .option('--port <port>', 'debug daemon port', Number)
  .option('--window <label>', 'Tauri window label')
  .option('--follow', 'poll and stream new event entries as newline-delimited JSON')
  .option('--poll-ms <ms>', 'follow polling interval in milliseconds', parseNumber, 250)
  .option('--timeout-ms <ms>', 'stop following after this many milliseconds', parseNumber)
  .action(async (options: FollowOptions) => {
    if (options.follow) {
      await followEntries(options, 'events')
      return
    }
    printJson(await call(options, 'events', { ...targetParams(options), follow: options.follow }))
  })

program
  .command('network')
  .description('Print captured fetch network entries.')
  .option('--app <appId>', 'Tauri app identifier for endpoint discovery')
  .option('--from-html <path>', 'prototype against a static HTML file')
  .option('--host <host>', 'debug daemon host', '127.0.0.1')
  .option('--port <port>', 'debug daemon port', Number)
  .option('--window <label>', 'Tauri window label')
  .option('--follow', 'poll and stream new network entries as newline-delimited JSON')
  .option('--clear', 'clear captured network entries after reading')
  .option('--poll-ms <ms>', 'follow polling interval in milliseconds', parseNumber, 250)
  .option('--timeout-ms <ms>', 'stop following after this many milliseconds', parseNumber)
  .action(async (options: FollowOptions) => {
    if (options.follow) {
      await followEntries(options, 'network')
      return
    }
    printJson(await call(options, 'network', { ...targetParams(options), follow: options.follow, clear: options.clear }))
  })

program
  .command('storage')
  .description('Inspect or mutate webview localStorage/sessionStorage.')
  .option('--app <appId>', 'Tauri app identifier for endpoint discovery')
  .option('--from-html <path>', 'prototype against a static HTML file')
  .option('--host <host>', 'debug daemon host', '127.0.0.1')
  .option('--port <port>', 'debug daemon port', Number)
  .option('--window <label>', 'Tauri window label')
  .option('--area <area>', 'storage area: local or session', parseStorageArea, 'local')
  .option('--action <action>', 'storage action: get, set, remove, or clear', parseStorageAction, 'get')
  .option('--key <key>', 'storage key')
  .option('--value <value>', 'storage value for set')
  .action(async (options: StorageOptions) => {
    printJson(await call(options, 'storage', storageParams(options)))
  })

program
  .command('location')
  .description('Inspect or update the webview location for SPA-style navigation.')
  .option('--app <appId>', 'Tauri app identifier for endpoint discovery')
  .option('--from-html <path>', 'prototype against a static HTML file')
  .option('--host <host>', 'debug daemon host', '127.0.0.1')
  .option('--port <port>', 'debug daemon port', Number)
  .option('--window <label>', 'Tauri window label')
  .option('--action <action>', 'location action: get, push, or replace', parseLocationAction, 'get')
  .option('--url <url>', 'URL or path for push/replace actions')
  .action(async (options: LocationOptions) => {
    printJson(await call(options, 'location', locationParams(options)))
  })

program
  .command('wait')
  .description('Wait for text to appear.')
  .argument('<text>', 'text to wait for')
  .option('--app <appId>', 'Tauri app identifier for endpoint discovery')
  .option('--from-html <path>', 'prototype against a static HTML file')
  .option('--host <host>', 'debug daemon host', '127.0.0.1')
  .option('--port <port>', 'debug daemon port', Number)
  .option('--window <label>', 'Tauri window label')
  .option('--timeout-ms <ms>', 'timeout in milliseconds', Number)
  .action(async (text: string, options: ConnectionOptions & { timeoutMs?: number }) =>
    printJson(await call(options, 'wait', { ...targetParams(options), text, timeoutMs: options.timeoutMs }))
  )

program
  .command('state')
  .description('Print current app state probe values.')
  .option('--app <appId>', 'Tauri app identifier for endpoint discovery')
  .option('--from-html <path>', 'prototype against a static HTML file')
  .option('--host <host>', 'debug daemon host', '127.0.0.1')
  .option('--port <port>', 'debug daemon port', Number)
  .option('--window <label>', 'Tauri window label')
  .action(async (options: ConnectionOptions) => printJson(await call(options, 'state', targetParams(options))))

program
  .command('record')
  .description('Manage action recording.')
  .option('--app <appId>', 'Tauri app identifier for endpoint discovery')
  .option('--from-html <path>', 'prototype against a static HTML file')
  .option('--host <host>', 'debug daemon host', '127.0.0.1')
  .option('--port <port>', 'debug daemon port', Number)
  .option('--window <label>', 'Tauri window label')
  .option('--action <action>', 'start, stop, get, or clear')
  .action(async (options: ConnectionOptions & { action?: string }) =>
    printJson(await call(options, 'record', { ...targetParams(options), action: options.action }))
  )

await program.parseAsync()

async function call(
  options: ConnectionOptions,
  method: AgentMethod,
  params: Record<string, unknown> = {}
): Promise<unknown> {
  return debuggerClient(options).then((client) => client.call(method, params))
}

async function followEntries(options: FollowOptions, method: 'logs' | 'events' | 'network'): Promise<void> {
  const client = await debuggerClient(options)
  const pollMs = Math.max(1, options.pollMs ?? 250)
  const startedAt = Date.now()
  let emitted = 0

  while (true) {
    const result = await client.call(method, { ...targetParams(options), follow: true })
    if (!Array.isArray(result)) {
      throw new Error(`${method} follow expected an array result`)
    }

    const start = result.length < emitted ? 0 : emitted
    for (const entry of result.slice(start)) {
      process.stdout.write(`${JSON.stringify(entry)}\n`)
    }
    emitted = result.length

    if (options.timeoutMs !== undefined && Date.now() - startedAt >= options.timeoutMs) {
      return
    }
    await sleep(nextPollDelay(startedAt, pollMs, options.timeoutMs))
  }
}

async function watchTree(options: TreeOptions): Promise<void> {
  const client = await debuggerClient(options)
  const pollMs = Math.max(1, options.pollMs ?? 250)
  const startedAt = Date.now()
  let previousText: string | undefined

  while (true) {
    const result = await client.call('tree', treeParams(options))
    if (!isTreeResult(result)) {
      throw new Error('tree interactive expected a { text } result')
    }

    if (result.text !== previousText) {
      process.stdout.write(`${JSON.stringify(result)}\n`)
      previousText = result.text
    }

    if (options.timeoutMs !== undefined && Date.now() - startedAt >= options.timeoutMs) {
      return
    }
    await sleep(nextPollDelay(startedAt, pollMs, options.timeoutMs))
  }
}

function targetParams(options: ConnectionOptions): Record<string, unknown> {
  return { window: options.window }
}

function treeParams(options: ConnectionOptions): Record<string, unknown> {
  return { ...targetParams(options), scope: options.scope, mode: options.mode }
}

function findParams(options: FindOptions): Record<string, unknown> {
  return {
    ...targetParams(options),
    scope: options.scope,
    role: options.role,
    name: options.name,
    text: options.text,
    limit: options.limit
  }
}

function storageParams(options: StorageOptions): Record<string, unknown> {
  return {
    ...targetParams(options),
    area: options.area,
    action: options.action,
    key: options.key,
    value: options.value
  }
}

function locationParams(options: LocationOptions): Record<string, unknown> {
  return {
    ...targetParams(options),
    action: options.action,
    url: options.url
  }
}

function refActionParams(
  options: ConnectionOptions,
  ref: string,
  extra: Record<string, unknown> = {}
): Record<string, unknown> {
  return { ...targetParams(options), ref, ...extra }
}

async function debuggerClient(options: ConnectionOptions): Promise<DebuggerClient> {
  if (options.port) {
    return new DebuggerClient(new SocketTransport({ port: options.port, host: options.host }))
  }
  if (options.app) {
    const endpoint = await readEndpointRegistry(options.app)
    if (!isProcessAlive(endpoint.pid)) {
      throw new Error(`debugger endpoint for app ${options.app} is stale: pid ${endpoint.pid} is not running`)
    }
    return new DebuggerClient(
      new SocketTransport(
        endpoint.transport === 'tcp'
          ? { port: endpoint.port, host: endpoint.host }
          : { path: endpoint.path }
      )
    )
  }
  if (!options.fromHtml) {
    exitBridgePending()
  }

  const html = await readFile(options.fromHtml, 'utf8')
  const session = new DebuggerSession(new StaticHtmlAppAdapter({ html }))
  return new DebuggerClient(new InProcessTransport(createDebuggerRpcHandler(session)))
}

function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`)
}

function parseBoolean(value: string): boolean {
  if (value === 'true') return true
  if (value === 'false') return false
  throw new Error(`expected true or false, got ${value}`)
}

function parseNumber(value: string): number {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) {
    throw new Error(`invalid number: ${value}`)
  }
  return parsed
}

function parseTreeMode(value: string): 'compact' | 'verbose' {
  if (value === 'compact' || value === 'verbose') {
    return value
  }
  throw new Error(`expected compact or verbose, got ${value}`)
}

function parseStorageArea(value: string): 'local' | 'session' {
  if (value === 'local' || value === 'session') {
    return value
  }
  throw new Error(`expected local or session, got ${value}`)
}

function parseStorageAction(value: string): 'get' | 'set' | 'remove' | 'clear' {
  if (value === 'get' || value === 'set' || value === 'remove' || value === 'clear') {
    return value
  }
  throw new Error(`expected get, set, remove, or clear, got ${value}`)
}

function parseLocationAction(value: string): 'get' | 'push' | 'replace' {
  if (value === 'get' || value === 'push' || value === 'replace') {
    return value
  }
  throw new Error(`expected get, push, or replace, got ${value}`)
}

function nextPollDelay(startedAt: number, pollMs: number, timeoutMs: number | undefined): number {
  if (timeoutMs === undefined) {
    return pollMs
  }
  return Math.max(0, Math.min(pollMs, timeoutMs - (Date.now() - startedAt)))
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function isTreeResult(value: unknown): value is { text: string } {
  return typeof value === 'object' && value !== null && 'text' in value && typeof value.text === 'string'
}

function exitBridgePending(): never {
  process.stderr.write(
    'live Tauri attach needs --app for endpoint discovery, --port for a known daemon, or --from-html for deterministic protocol prototyping.\n'
  )
  process.exit(2)
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return typeof error === 'object' && error !== null && 'code' in error && error.code === 'EPERM'
  }
}
