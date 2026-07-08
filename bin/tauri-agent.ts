#!/usr/bin/env node
import { readFile } from 'node:fs/promises'

import { Command } from 'commander'

import { DebuggerClient, SocketTransport } from '../daemon/client'
import { readEndpointRegistry } from '../daemon/endpoint'
import { createDebuggerRpcHandler, createLineJsonRpcServer, InProcessTransport } from '../daemon/server'
import { DebuggerSession } from '../daemon/session'
import { StaticHtmlAppAdapter } from '../daemon/static-app'
import type { AgentMethod, KeyModifier, ScreenshotBackend, StreamResult, WindowAction } from '../protocol/types'

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

interface StreamOptions extends ConnectionOptions {
  since?: number
  waitMs?: number
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

interface CookieOptions extends ConnectionOptions {
  action?: 'get' | 'set' | 'remove' | 'clear'
  name?: string
  value?: string
}

interface LocationOptions extends ConnectionOptions {
  action?: 'get' | 'push' | 'replace' | 'reload' | 'back' | 'forward'
  url?: string
}

interface WindowOptions extends ConnectionOptions {
  action?: WindowAction
  x?: number
  y?: number
  width?: number
  height?: number
}

interface PressOptions extends ConnectionOptions {
  ref?: string
  modifier?: KeyModifier[]
}

interface WaitOptions extends ConnectionOptions {
  role?: string
  name?: string
  timeoutMs?: number
  absent?: boolean
  fn?: string
  networkIdle?: boolean
  idleMs?: number
}

interface ExpectOptions extends ConnectionOptions {
  role?: string
  name?: string
  text?: string
  absent?: boolean
  value?: string
  hasState?: string
}

interface StateOptions extends ConnectionOptions {
  key?: string
}

interface ShotOptions extends ConnectionOptions {
  backend?: ScreenshotBackend
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
  .command('vnc')
  .description('Show the advertised VNC/noVNC visual surface for an app.')
  .option('--app <appId>', 'Tauri app identifier for endpoint discovery')
  .action(async (options: { app?: string }) => {
    if (!options.app) {
      throw new Error('vnc requires --app <appId> to discover the endpoint registry')
    }
    const endpoint = await readEndpointRegistry(options.app)
    if (!endpoint.vnc) {
      throw new Error(`app ${options.app} does not advertise a VNC surface`)
    }
    printJson(endpoint.vnc)
  })

program
  .command('windows')
  .description('List known Tauri windows.')
  .option('--app <appId>', 'Tauri app identifier for endpoint discovery')
  .option('--from-html <path>', 'prototype against a static HTML file')
  .option('--host <host>', 'debug daemon host', '127.0.0.1')
  .option('--port <port>', 'debug daemon port', Number)
  .action(async (options: ConnectionOptions) => printJson(await call(options, 'windows')))

program
  .command('window')
  .description('Inspect or control a Tauri window.')
  .option('--app <appId>', 'Tauri app identifier for endpoint discovery')
  .option('--from-html <path>', 'prototype against a static HTML file')
  .option('--host <host>', 'debug daemon host', '127.0.0.1')
  .option('--port <port>', 'debug daemon port', Number)
  .option('--window <label>', 'Tauri window label')
  .option('--action <action>', 'window action: get, focus, show, hide, minimize, unminimize, maximize, unmaximize, setSize, or setPosition', parseWindowAction, 'get')
  .option('--x <x>', 'x position for setPosition', parseNumber)
  .option('--y <y>', 'y position for setPosition', parseNumber)
  .option('--width <width>', 'width for setSize', parseNumber)
  .option('--height <height>', 'height for setSize', parseNumber)
  .action(async (options: WindowOptions) => printJson(await call(options, 'window', windowParams(options))))

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
  .command('stream')
  .description('Stream mutation-driven semantic-tree diffs as newline-delimited JSON.')
  .option('--app <appId>', 'Tauri app identifier for endpoint discovery')
  .option('--from-html <path>', 'prototype against a static HTML file')
  .option('--host <host>', 'debug daemon host', '127.0.0.1')
  .option('--port <port>', 'debug daemon port', Number)
  .option('--window <label>', 'Tauri window label')
  .option('--since <seq>', 'resume from a previous cursor', parseNumber, 0)
  .option('--wait-ms <ms>', 'long-poll budget per request in milliseconds', parseNumber, 1000)
  .option('--timeout-ms <ms>', 'stop streaming after this many milliseconds', parseNumber)
  .action(async (options: StreamOptions) => {
    await streamDiffs(options)
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
  .command('type')
  .description('Type text into a snapshot-local ref with realistic per-key events.')
  .argument('<ref>', 'snapshot-local ref, for example @4')
  .argument('<text>', 'text to type')
  .option('--app <appId>', 'Tauri app identifier for endpoint discovery')
  .option('--from-html <path>', 'prototype against a static HTML file')
  .option('--host <host>', 'debug daemon host', '127.0.0.1')
  .option('--port <port>', 'debug daemon port', Number)
  .option('--window <label>', 'Tauri window label')
  .option('--scope <selector>', 'limit the snapshot to a CSS selector')
  .action(async (ref: string, text: string, options: ConnectionOptions) => {
    const client = await debuggerClient(options)
    await client.call('tree', treeParams(options))
    printJson(await client.call('type', refActionParams(options, ref, { text })))
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
  .option('--scope <selector>', 'limit the snapshot ref refresh to a CSS selector')
  .option('--ref <ref>', 'snapshot-local ref to focus before dispatching the key')
  .option('--modifier <modifier>', 'keyboard modifier: Alt, Control, Meta, or Shift', collectModifier, [])
  .action(async (key: string, options: PressOptions) => {
    const client = await debuggerClient(options)
    if (options.ref) {
      await client.call('tree', treeParams(options))
    }
    printJson(await client.call('press', pressParams(options, key)))
  })

program
  .command('shot')
  .description('Capture a screenshot through the live Tauri bridge.')
  .argument('[path]', 'output path')
  .option('--app <appId>', 'Tauri app identifier for endpoint discovery')
  .option('--from-html <htmlPath>', 'prototype against a static HTML file')
  .option('--host <host>', 'debug daemon host', '127.0.0.1')
  .option('--port <port>', 'debug daemon port', Number)
  .option('--window <label>', 'Tauri window label')
  .option('--backend <backend>', 'screenshot backend: dom, native, or auto', parseScreenshotBackend)
  .action(async (path: string | undefined, options: ShotOptions) =>
    printJson(await call(options, 'shot', { ...targetParams(options), path, backend: options.backend }))
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
  .option('--clear', 'clear captured log entries after reading')
  .option('--poll-ms <ms>', 'follow polling interval in milliseconds', parseNumber, 250)
  .option('--timeout-ms <ms>', 'stop following after this many milliseconds', parseNumber)
  .action(async (options: FollowOptions) => {
    if (options.follow) {
      await followEntries(options, 'logs')
      return
    }
    printJson(await call(options, 'logs', { ...targetParams(options), follow: options.follow, clear: options.clear }))
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
  .option('--clear', 'clear captured event entries after reading')
  .option('--poll-ms <ms>', 'follow polling interval in milliseconds', parseNumber, 250)
  .option('--timeout-ms <ms>', 'stop following after this many milliseconds', parseNumber)
  .action(async (options: FollowOptions) => {
    if (options.follow) {
      await followEntries(options, 'events')
      return
    }
    printJson(await call(options, 'events', { ...targetParams(options), follow: options.follow, clear: options.clear }))
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
  .command('ipc')
  .description('Print captured Tauri IPC invoke traces.')
  .option('--app <appId>', 'Tauri app identifier for endpoint discovery')
  .option('--from-html <path>', 'prototype against a static HTML file')
  .option('--host <host>', 'debug daemon host', '127.0.0.1')
  .option('--port <port>', 'debug daemon port', Number)
  .option('--window <label>', 'Tauri window label')
  .option('--follow', 'poll and stream new IPC entries as newline-delimited JSON')
  .option('--clear', 'clear captured IPC entries after reading')
  .option('--poll-ms <ms>', 'follow polling interval in milliseconds', parseNumber, 250)
  .option('--timeout-ms <ms>', 'stop following after this many milliseconds', parseNumber)
  .action(async (options: FollowOptions) => {
    if (options.follow) {
      await followEntries(options, 'ipc')
      return
    }
    printJson(await call(options, 'ipc', { ...targetParams(options), follow: options.follow, clear: options.clear }))
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
  .command('cookies')
  .description('Inspect or mutate webview-visible document.cookie entries.')
  .option('--app <appId>', 'Tauri app identifier for endpoint discovery')
  .option('--from-html <path>', 'prototype against a static HTML file')
  .option('--host <host>', 'debug daemon host', '127.0.0.1')
  .option('--port <port>', 'debug daemon port', Number)
  .option('--window <label>', 'Tauri window label')
  .option('--action <action>', 'cookie action: get, set, remove, or clear', parseCookieAction, 'get')
  .option('--name <name>', 'cookie name')
  .option('--value <value>', 'cookie value for set')
  .action(async (options: CookieOptions) => {
    printJson(await call(options, 'cookies', cookieParams(options)))
  })

program
  .command('location')
  .description('Inspect or update the webview location for SPA-style navigation.')
  .option('--app <appId>', 'Tauri app identifier for endpoint discovery')
  .option('--from-html <path>', 'prototype against a static HTML file')
  .option('--host <host>', 'debug daemon host', '127.0.0.1')
  .option('--port <port>', 'debug daemon port', Number)
  .option('--window <label>', 'Tauri window label')
  .option('--action <action>', 'location action: get, push, replace, reload, back, or forward', parseLocationAction, 'get')
  .option('--url <url>', 'URL or path for push/replace actions')
  .action(async (options: LocationOptions) => {
    printJson(await call(options, 'location', locationParams(options)))
  })

program
  .command('wait')
  .description('Wait for text or a semantic element to appear (or disappear with --absent).')
  .argument('[text]', 'text to wait for')
  .option('--app <appId>', 'Tauri app identifier for endpoint discovery')
  .option('--from-html <path>', 'prototype against a static HTML file')
  .option('--host <host>', 'debug daemon host', '127.0.0.1')
  .option('--port <port>', 'debug daemon port', Number)
  .option('--window <label>', 'Tauri window label')
  .option('--scope <selector>', 'limit the semantic wait to a CSS selector')
  .option('--role <role>', 'semantic role to match exactly')
  .option('--name <name>', 'accessible name substring to match')
  .option('--absent', 'wait for the target to disappear instead of appear')
  .option('--fn <expression>', 'wait until this JS expression evaluates truthy')
  .option('--network-idle', 'wait until no fetch/XHR request is in flight')
  .option('--idle-ms <ms>', 'quiet window for --network-idle in milliseconds', Number)
  .option('--timeout-ms <ms>', 'timeout in milliseconds', Number)
  .action(async (text: string | undefined, options: WaitOptions) =>
    printJson(await call(options, 'wait', waitParams(options, text)))
  )

program
  .command('expect')
  .description('Assert a semantic target exists (or is absent) and matches value/state.')
  .option('--app <appId>', 'Tauri app identifier for endpoint discovery')
  .option('--from-html <path>', 'prototype against a static HTML file')
  .option('--host <host>', 'debug daemon host', '127.0.0.1')
  .option('--port <port>', 'debug daemon port', Number)
  .option('--window <label>', 'Tauri window label')
  .option('--scope <selector>', 'limit the match to a CSS selector')
  .option('--role <role>', 'semantic role to match exactly')
  .option('--name <name>', 'accessible name substring to match')
  .option('--text <text>', 'visible text substring to match')
  .option('--absent', 'assert the target is absent instead of present')
  .option('--value <value>', 'assert the matched control value equals this')
  .option('--has-state <state>', 'assert the matched element has this state flag')
  .action(async (options: ExpectOptions) =>
    printJson(
      await call(options, 'expect', {
        ...targetParams(options),
        scope: options.scope,
        role: options.role,
        name: options.name,
        text: options.text,
        present: options.absent ? false : undefined,
        value: options.value,
        hasState: options.hasState
      })
    )
  )

program
  .command('state')
  .description('Print current app state probe values.')
  .option('--app <appId>', 'Tauri app identifier for endpoint discovery')
  .option('--from-html <path>', 'prototype against a static HTML file')
  .option('--host <host>', 'debug daemon host', '127.0.0.1')
  .option('--port <port>', 'debug daemon port', Number)
  .option('--window <label>', 'Tauri window label')
  .option('--key <key>', 'return one top-level state field')
  .action(async (options: StateOptions) => printJson(await call(options, 'state', stateParams(options))))

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

async function followEntries(
  options: FollowOptions,
  method: 'logs' | 'events' | 'network' | 'ipc'
): Promise<void> {
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

async function streamDiffs(options: StreamOptions): Promise<void> {
  const client = await debuggerClient(options)
  const startedAt = Date.now()
  const waitMs = Math.max(1, options.waitMs ?? 1000)
  let cursor = options.since ?? 0

  // Emit the current full snapshot first so a consumer has a baseline to which
  // subsequent diff frames apply.
  const base = asStreamResult(await client.call('stream', { ...targetParams(options), since: cursor }))
  process.stdout.write(`${JSON.stringify({ snapshot: base.snapshot, cursor: base.cursor })}\n`)
  for (const frame of base.frames) {
    process.stdout.write(`${JSON.stringify(frame)}\n`)
  }
  cursor = base.cursor

  while (true) {
    if (options.timeoutMs !== undefined && Date.now() - startedAt >= options.timeoutMs) {
      return
    }
    const budget =
      options.timeoutMs === undefined
        ? waitMs
        : Math.max(1, Math.min(waitMs, options.timeoutMs - (Date.now() - startedAt)))
    const result = asStreamResult(
      await client.call('stream', { ...targetParams(options), since: cursor, timeoutMs: budget })
    )
    if (result.dropped) {
      process.stdout.write(
        `${JSON.stringify({ resync: true, snapshot: result.snapshot, cursor: result.cursor })}\n`
      )
    } else {
      for (const frame of result.frames) {
        process.stdout.write(`${JSON.stringify(frame)}\n`)
      }
    }
    cursor = result.cursor
  }
}

function asStreamResult(value: unknown): StreamResult {
  if (
    typeof value !== 'object' ||
    value === null ||
    !Array.isArray((value as StreamResult).frames) ||
    typeof (value as StreamResult).cursor !== 'number'
  ) {
    throw new Error('stream expected a { frames, cursor, snapshot, dropped } result')
  }
  return value as StreamResult
}

function targetParams(options: ConnectionOptions): Record<string, unknown> {
  return { window: options.window }
}

function windowParams(options: WindowOptions): Record<string, unknown> {
  return {
    ...targetParams(options),
    action: options.action,
    x: options.x,
    y: options.y,
    width: options.width,
    height: options.height
  }
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

function cookieParams(options: CookieOptions): Record<string, unknown> {
  return {
    ...targetParams(options),
    action: options.action,
    name: options.name,
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

function waitParams(options: WaitOptions, text: string | undefined): Record<string, unknown> {
  return {
    ...targetParams(options),
    text,
    scope: options.scope,
    role: options.role,
    name: options.name,
    timeoutMs: options.timeoutMs,
    state: options.absent ? 'absent' : undefined,
    fn: options.fn,
    networkIdle: options.networkIdle ? true : undefined,
    idleMs: options.idleMs
  }
}

function stateParams(options: StateOptions): Record<string, unknown> {
  return {
    ...targetParams(options),
    key: options.key
  }
}

function pressParams(options: PressOptions, key: string): Record<string, unknown> {
  return {
    ...targetParams(options),
    key,
    ref: options.ref,
    modifiers: options.modifier?.length ? options.modifier : undefined
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
      ),
      endpoint.token
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

function parseScreenshotBackend(value: string): ScreenshotBackend {
  if (value === 'dom' || value === 'native' || value === 'auto') {
    return value
  }
  throw new Error(`unknown screenshot backend: ${value}`)
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

function parseCookieAction(value: string): 'get' | 'set' | 'remove' | 'clear' {
  if (value === 'get' || value === 'set' || value === 'remove' || value === 'clear') {
    return value
  }
  throw new Error(`expected get, set, remove, or clear, got ${value}`)
}

function parseLocationAction(
  value: string
): 'get' | 'push' | 'replace' | 'reload' | 'back' | 'forward' {
  if (
    value === 'get' ||
    value === 'push' ||
    value === 'replace' ||
    value === 'reload' ||
    value === 'back' ||
    value === 'forward'
  ) {
    return value
  }
  throw new Error(`expected get, push, replace, reload, back, or forward, got ${value}`)
}

function parseWindowAction(value: string): WindowAction {
  if (
    value === 'get' ||
    value === 'focus' ||
    value === 'show' ||
    value === 'hide' ||
    value === 'minimize' ||
    value === 'unminimize' ||
    value === 'maximize' ||
    value === 'unmaximize' ||
    value === 'setSize' ||
    value === 'setPosition'
  ) {
    return value
  }
  throw new Error(`expected a window action, got ${value}`)
}

function collectModifier(value: string, previous: KeyModifier[]): KeyModifier[] {
  return [...previous, parseKeyModifier(value)]
}

function parseKeyModifier(value: string): KeyModifier {
  if (value === 'Alt' || value === 'Control' || value === 'Meta' || value === 'Shift') {
    return value
  }
  throw new Error(`expected Alt, Control, Meta, or Shift, got ${value}`)
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
